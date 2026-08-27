import { useState, useMemo, useEffect } from "react";
import { configuredShippingCarriers, useStore, Order, Shipment, ShipmentDamageReplacement, Store } from "../store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { toast } from "sonner";
import {
  Truck, CheckCircle2, Package, PackageCheck, CalendarClock, MapPin, ArrowUpDown,
  ChevronDown, ChevronUp, Pencil, XCircle, ArrowRightLeft, Camera,
} from "lucide-react";
import { ShipDialog, ShipFormData } from "./ShipDialog";
import React from "react";
import { confirmWrite } from "../utils/writeConfirm";
import { authJsonHeaders } from "../utils/authSession";
import { isPlatformOrderSource, platformOrderDisplayName } from "../utils/orderSources";
import {
  orderShippingFeeMode,
  shipmentHasPendingActualShippingFee,
  shippingFeeModeLabel,
} from "../utils/orderFees";
import {
  actualShippingFeePayload,
  canUseActualShippingFeeApi,
  MAX_ACTUAL_SHIPPING_FEE,
  normalizedPositiveShippingFee,
  roundShippingFee,
} from "../utils/shipmentFee";
import { ShipmentProofDialog, shipmentPackingProofs } from "./ShipmentProofDialog";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const today = todayDateString();

function plannedShipPriority(d?: string): number {
  if (!d) return 3;
  if (d === today) return 0;
  if (d < today) return 1;
  return 2;
}

function todayDateString(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatLocalDateTimeMinute(value?: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "历史发货未记录";
  const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (localMatch && !/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) return `${localMatch[1]} ${localMatch[2]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.replace("T", " ").slice(0, 16);
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16).replace("T", " ");
}

class ShipmentApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 0, code = "") {
    super(message);
    this.name = "ShipmentApiError";
    this.status = status;
    this.code = code;
  }
}

async function postShipmentApi(path: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: authJsonHeaders(),
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new ShipmentApiError(result.error || `HTTP ${response.status}`, response.status, String(result.code ?? ""));
  }
  return result;
}

async function fetchCurrentShipment(shipmentId: string): Promise<Shipment | null> {
  const response = await fetch("/api/state/slice?keys=shipments", { headers: authJsonHeaders() });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ShipmentApiError(result.error || `HTTP ${response.status}`, response.status, String(result.code ?? ""));
  }
  const shipments = Array.isArray(result.data?.shipments) ? result.data.shipments as Shipment[] : [];
  return shipments.find((shipment) => shipment.id === shipmentId) ?? null;
}

function shipmentApiErrorMessage(error: unknown): string {
  if (error instanceof ShipmentApiError && error.status === 401) {
    return "登录状态已失效，请重新登录后再保存";
  }
  return error instanceof Error && error.message
    ? error.message
    : "保存失败，请重试";
}

function mergeOperationLog(current: Store, operationLog: Store["operationLogs"][number] | undefined) {
  if (!operationLog) return current.operationLogs;
  return [operationLog, ...(current.operationLogs ?? [])]
    .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
    .slice(0, 10000);
}

function mergeShipmentRecord(shipments: Store["shipments"], shipment?: Store["shipments"][number]) {
  if (!shipment) return shipments;
  return shipments.some((item) => item.id === shipment.id)
    ? shipments.map((item) => item.id === shipment.id ? shipment : item)
    : [shipment, ...shipments];
}

function applyShipmentApiResult(
  setState: (value: Store | ((current: Store) => Store)) => void,
  result: {
    orders?: Store["orders"];
    shipments?: Store["shipments"];
    shipment?: Store["shipments"][number];
    stock?: Store["stock"];
    inventoryProjection?: Store["inventoryProjection"];
    operationLog?: Store["operationLogs"][number];
  }
) {
  setState((current) => {
    const shipments = Array.isArray(result.shipments) ? result.shipments : current.shipments;
    return {
      ...current,
      orders: Array.isArray(result.orders) ? result.orders : current.orders,
      shipments: mergeShipmentRecord(shipments, result.shipment),
      stock: Array.isArray(result.stock) ? result.stock : current.stock,
      inventoryProjection: result.inventoryProjection ?? current.inventoryProjection,
      operationLogs: mergeOperationLog(current, result.operationLog),
    };
  });
}

function countsAsActiveShipment(shipment: Shipment): boolean {
  return shipment.status !== "preparing";
}

function isPickupOrderSource(source?: string): boolean {
  return ["线下", "线下自提"].includes(String(source ?? "").trim());
}

function PlannedShipBadge({ date }: { date?: string }) {
  if (!date) return <span className="text-muted-foreground text-xs">未设置</span>;
  if (date === today)
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-700">
        <CalendarClock className="size-3" /> 今日发货
      </span>
    );
  if (date < today)
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">
        <CalendarClock className="size-3" /> {date} 已逾期
      </span>
    );
  return <span className="text-xs text-muted-foreground">{date}</span>;
}

// ─── Edit Shipment Dialog ─────────────────────────────────────────────────────

type EditShipmentSaveResult = {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  errorField?: "actualShippingFee" | "form";
};

function EditShipmentDialog({
  shipment,
  order,
  minShipDate,
  open,
  onOpenChange,
  onSave,
}: {
  shipment: Shipment | null;
  order?: Order;
  minShipDate?: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSave: (updated: Partial<Shipment>) => Promise<EditShipmentSaveResult>;
}) {
  const { state } = useStore();
  const [carrier, setCarrier] = useState("");
  const [trackingNo, setTrackingNo] = useState("");
  const [actualFee, setActualFee] = useState(0);
  const [shipDate, setShipDate] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [actualFeeError, setActualFeeError] = useState("");
  const today = todayDateString();

  // populate when dialog opens
  useEffect(() => {
    if (open && shipment) {
      setCarrier(shipment.carrier ?? "");
      setTrackingNo(shipment.trackingNo ?? "");
      setActualFee(shipment.actualShippingFee ?? 0);
      setShipDate(shipment.shipDate ?? "");
      setNotes(shipment.notes ?? "");
      setSaving(false);
      setSaveError("");
      setActualFeeError("");
    }
  }, [open, shipment?.id]); // eslint-disable-line

  if (!shipment) return null;

  const isExpress = (shipment.shipMethod ?? "express") === "express";
  const shippingFeeMode = orderShippingFeeMode(order);
  const actualFeeApiEnabled = canUseActualShippingFeeApi(shipment, shippingFeeMode);
  const configuredCarriers = configuredShippingCarriers(state.systemSettings);
  const carrierOptions = carrier && !configuredCarriers.some((item) => item.name === carrier)
    ? [{ id: "legacy-carrier", name: carrier, enabled: false }, ...configuredCarriers]
    : configuredCarriers;

  const handleSave = async () => {
    if (saving) return;
    setSaveError("");
    setActualFeeError("");
    if (isExpress && !carrier.trim()) {
      setSaveError("请选择快递公司");
      return toast.error("请选择快递公司");
    }
    const normalizedActualFee = normalizedPositiveShippingFee(actualFee);
    if (actualFeeApiEnabled) {
      const zeroPendingFeeAllowed = shippingFeeMode === "prepaid" && actualFee === 0;
      if (!zeroPendingFeeAllowed && normalizedActualFee === null) {
        const message = "实际运费必须在 0.01 至 100000 元之间，且最多保留两位小数";
        setActualFeeError(message);
        return toast.error(message);
      }
      setActualFee(normalizedActualFee ?? 0);
    }
    if (!shipDate) {
      setSaveError("请填写发货日期");
      return toast.error("请填写发货日期");
    }
    if (minShipDate && shipDate < minShipDate) {
      setSaveError("发货日期不能早于下单日期");
      return toast.error("发货日期不能早于下单日期");
    }
    if (shipDate > today) {
      setSaveError("发货日期不能晚于今天");
      return toast.error("发货日期不能晚于今天");
    }

    setSaving(true);
    try {
      const updated: Partial<Shipment> = {
        carrier,
        trackingNo,
        shipDate,
        notes,
      };
      if (actualFeeApiEnabled) {
        updated.actualShippingFee = normalizedActualFee ?? 0;
      }
      const result = await onSave(updated);
      if (result.ok) {
        onOpenChange(false);
        return;
      }
      if (result.cancelled) return;
      const message = result.error || "保存失败，请重试";
      if (result.errorField === "actualShippingFee") {
        setActualFeeError(message);
      } else {
        setSaveError(message);
      }
    } catch (error) {
      const message = shipmentApiErrorMessage(error);
      setSaveError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen); }}>
      <DialogContent aria-describedby={undefined} className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="size-4 text-sky-600" />
            编辑发货信息
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-1">
          {/* Method tag (read-only) */}
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {isExpress
              ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-blue-100 text-blue-700"><Truck className="size-3" /> 快递寄送</span>
              : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700"><MapPin className="size-3" /> 上门自取</span>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-sm">发货日期<span className="text-red-500 ml-0.5">*</span></Label>
              <Input
                type="date"
                value={shipDate}
                min={minShipDate}
                max={today}
                onChange={(e) => {
                  const value = e.target.value;
                  if (minShipDate && value && value < minShipDate) {
                    toast.error("发货日期不能早于下单日期");
                    return;
                  }
                  if (value && value > today) {
                    toast.error("发货日期不能晚于今天");
                    return;
                  }
                  setShipDate(value);
                }}
              />
            </div>
            {actualFeeApiEnabled && (
              <div className="grid gap-1.5">
                <Label htmlFor="edit-shipment-actual-fee" className="text-sm">
                  实际运费（¥）
                  {shippingFeeMode === "free" && <span className="text-red-500 ml-0.5">*</span>}
                </Label>
                <Input
                  id="edit-shipment-actual-fee"
                  type="number" min={0} max={MAX_ACTUAL_SHIPPING_FEE} step={0.01}
                  value={actualFee || ""}
                  placeholder={shippingFeeMode === "prepaid" ? "发货后补录" : "0"}
                  aria-invalid={Boolean(actualFeeError)}
                  aria-describedby={actualFeeError ? "edit-shipment-actual-fee-error" : undefined}
                  onChange={(e) => {
                    setActualFee(Number(e.target.value));
                    if (actualFeeError) setActualFeeError("");
                  }}
                />
                {actualFeeError && (
                  <p id="edit-shipment-actual-fee-error" role="alert" className="text-xs text-red-600">
                    {actualFeeError}
                  </p>
                )}
              </div>
            )}
          </div>

          {isExpress && (
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-sm">快递公司<span className="text-red-500 ml-0.5">*</span></Label>
                <Select value={carrier} onValueChange={setCarrier}>
                  <SelectTrigger>
                    <SelectValue placeholder="请选择快递公司" />
                  </SelectTrigger>
                  <SelectContent>
                    {carrierOptions.map((item) => (
                      <SelectItem key={item.id} value={item.name}>
                        {item.name}{item.enabled ? "" : "（历史记录）"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-sm">运单号</Label>
                <Input value={trackingNo} onChange={(e) => setTrackingNo(e.target.value)} placeholder="选填" />
              </div>
            </div>
          )}
          {isExpress && shippingFeeMode === "prepaid" && actualFee <= 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              该发货单仍为待补运费；可先保存其他物流信息，但确认签收前必须补录实际运费。
            </div>
          )}

          <div className="grid gap-1.5">
            <Label className="text-sm">备注</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="选填…" />
          </div>
          {saveError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {saveError}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "保存中..." : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────

export function ShipmentsView() {
  const { state, setState, saveStateTransform, saveShipmentOutbound } = useStore();

  const [shipOrder, setShipOrder] = useState<Order | null>(null);
  const [deliverShipment, setDeliverShipment] = useState<Shipment | null>(null);
  const [editShipment, setEditShipment] = useState<Shipment | null>(null);
  const [proofShipment, setProofShipment] = useState<Shipment | null>(null);
  const [expandedShipIds, setExpandedShipIds] = useState<Set<string>>(new Set());

  const toggleExpand = (id: string) =>
    setExpandedShipIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const getCustomer = (id: string) => (state.customers ?? []).find((c) => c.id === id);
  const getOrder = (id: string) => state.orders.find((o) => o.id === id);

  const getUnshippedItems = (order: Order) => {
    const shippedIds = new Set(state.shipments.filter(s => s.orderId === order.id && countsAsActiveShipment(s)).flatMap(s => s.itemStockIds ?? []));
    return order.items.filter(i => !shippedIds.has(i.stockItemId));
  };

  const getProductName = (productId: string) => state.products.find(p => p.id === productId)?.name ?? "—";
  const getTankName = (stockItemId: string) => {
    const s = state.stock.find(x => x.id === stockItemId);
    if (!s) return "—";
    for (const g of state.tankGroups) {
      const t = g.subTanks.find(x => x.id === s.subTankId);
      if (t) return `${g.name} / ${t.name}`;
    }
    return "—";
  };

  const replacementSide = (replacement: ShipmentDamageReplacement, side: "original" | "replacement") => {
    const stockItemId = side === "original" ? replacement.originalStockItemId : replacement.replacementStockItemId;
    const stock = state.stock.find((item) => item.id === stockItemId);
    const snapshotProductId = side === "original" ? replacement.originalProductId : replacement.replacementProductId;
    const product = state.products.find((item) => item.id === (stock?.productId || snapshotProductId));
    const productName = side === "original" ? replacement.originalProductName : replacement.replacementProductName;
    const fishCode = side === "original" ? replacement.originalFishCode : replacement.replacementFishCode;
    const tankName = side === "original" ? replacement.originalTankName : replacement.replacementTankName;
    return {
      productName: productName || product?.name || "未知商品",
      fishCode: fishCode || stock?.code || "无编号",
      tankName: tankName || getTankName(stockItemId),
    };
  };

  // 根据 itemStockIds 查出商品名列表
  const getShipmentItemNames = (sh: Shipment): string[] => {
    if (!sh.itemStockIds?.length) return [];
    const order = getOrder(sh.orderId);
    if (!order) return [];
    return sh.itemStockIds.map((sid) => {
      const oi = order.items.find(i => i.stockItemId === sid);
      if (oi) return getProductName(oi.productId);
      const replacement = (sh.damageReplacements ?? []).find((item) => item.originalStockItemId === sid);
      return replacement ? replacementSide(replacement, "original").productName : "—";
    });
  };

  const pendingOrders = useMemo(() => {
    return state.orders
      .filter((o) => {
        if (o.status === "cancelled" || o.status === "completed" || o.status === "damaged") return false;
        const shippedIds = new Set(state.shipments.filter(s => s.orderId === o.id && countsAsActiveShipment(s)).flatMap(s => s.itemStockIds ?? []));
        return o.items.some(i => !shippedIds.has(i.stockItemId));
      })
      .slice()
      .sort((a, b) => {
        const pa = plannedShipPriority(a.plannedShipDate);
        const pb = plannedShipPriority(b.plannedShipDate);
        if (pa !== pb) return pa - pb;
        if (a.plannedShipDate && b.plannedShipDate)
          return a.plannedShipDate.localeCompare(b.plannedShipDate);
        return a.orderNo.localeCompare(b.orderNo);
      });
  }, [state.orders, state.shipments]);

  const shipmentRecords = useMemo(
    () => state.shipments.slice().sort((a, b) => b.shipDate.localeCompare(a.shipDate)),
    [state.shipments]
  );

  const doShip = async (order: Order, data: ShipFormData) => {
    const confirmation = data.shipMethod === "pickup"
      ? `将确认订单 ${order.orderNo} 的所选商品已由客户自提。`
      : `将记录订单 ${order.orderNo} 出库，后续需在订单详情上传打包凭证后确认发货。`;
    if (!confirmWrite(data.shipMethod === "pickup" ? "确认自提" : "出库", confirmation)) return false;
    const ok = await saveShipmentOutbound({
      orderId: order.id,
      selectedItemIds: data.selectedItemIds,
      shipMethod: data.shipMethod,
      carrier: data.carrier,
      shipDate: data.shipDate,
      actualShippingFee: data.shipMethod === "pickup" ? 0 : data.actualShippingFee,
      notes: data.notes,
    });
    if (!ok) { toast.error("保存失败，请重试"); return false; }

    const actualShippingFee = data.shipMethod === "pickup" ? 0 : data.actualShippingFee;
    const feeDiff = actualShippingFee - (order.shippingFee ?? 0);
    const shippingFeeMode = orderShippingFeeMode(order);
    if (data.shipMethod === "pickup") {
      toast.success(`订单 ${order.orderNo} 已确认上门自取签收`);
    } else if (shippingFeeMode === "collect") {
      toast.success(`订单 ${order.orderNo} 已出库 — 运费到付，不计订单应收`);
    } else if (shippingFeeMode === "prepaid" && actualShippingFee <= 0) {
      toast.success(`订单 ${order.orderNo} 已出库 — 实际运费待补录，确认签收前必须填写`);
    } else if (shippingFeeMode === "free") {
      toast.success(`订单 ${order.orderNo} 已出库 — 实际运费 ¥${actualShippingFee.toFixed(2)} 已计入包邮折扣`);
    } else if (Math.abs(feeDiff) > 0.005) {
      if (feeDiff > 0)
        toast.success(`订单 ${order.orderNo} 已出库 — 实际运费多 ¥${feeDiff.toFixed(2)}，已计入应收账款`);
      else
        toast.success(`订单 ${order.orderNo} 已出库 — 实际运费少 ¥${Math.abs(feeDiff).toFixed(2)}，已计入应收账款`);
    } else {
      toast.success(`订单 ${order.orderNo} 已出库，请到订单详情上传打包凭证并确认发货`);
    }

    setShipOrder(null);
    return true;
  };

  const doMarkDelivered = async (sh: Shipment) => {
    const order = getOrder(sh.orderId);
    if (order && shipmentHasPendingActualShippingFee(order, sh)) {
      toast.error("寄付订单确认签收前必须先补录实际运费");
      setDeliverShipment(null);
      setEditShipment(sh);
      return;
    }
    if (!confirmWrite("修改", "将该发货单状态改为已签收。")) return;
    try {
      const result = await postShipmentApi("shipments/deliver", { shipmentId: sh.id });
      applyShipmentApiResult(setState, result);
      setDeliverShipment(null);
      toast.success("已确认签收");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
    }
  };

  const doEditShipment = async (sh: Shipment, patch: Partial<Shipment>): Promise<EditShipmentSaveResult> => {
    const { actualShippingFee: requestedActualShippingFee, ...nonFeePatch } = patch;
    const order = getOrder(sh.orderId);
    const feeCanBeEdited = canUseActualShippingFeeApi(sh, orderShippingFeeMode(order));
    const currentActualShippingFee = roundShippingFee(sh.actualShippingFee ?? 0) ?? 0;
    const hasRequestedFee = requestedActualShippingFee !== undefined;
    const normalizedRequestedFee = hasRequestedFee
      ? normalizedPositiveShippingFee(requestedActualShippingFee)
      : null;
    const zeroPendingFeeAllowed = orderShippingFeeMode(order) === "prepaid"
      && Number(requestedActualShippingFee) === 0
      && currentActualShippingFee === 0;
    const roundedRequestedFee = hasRequestedFee
      ? (zeroPendingFeeAllowed ? 0 : normalizedRequestedFee)
      : currentActualShippingFee;
    const hasNonFeeChanges = Object.entries(nonFeePatch).some(
      ([key, value]) => sh[key as keyof Shipment] !== value
    );
    const feeChanged = feeCanBeEdited && roundedRequestedFee !== null && roundedRequestedFee !== currentActualShippingFee;

    if (feeCanBeEdited && hasRequestedFee && normalizedRequestedFee === null && !zeroPendingFeeAllowed) {
      const error = "实际运费必须在 0.01 至 100000 元之间，且最多保留两位小数";
      toast.error(error);
      return { ok: false, error, errorField: "actualShippingFee" };
    }

    const feePayload = feeChanged
      ? actualShippingFeePayload(sh, roundedRequestedFee)
      : null;
    if (feeChanged && !feePayload) {
      const error = "实际运费必须在 0.01 至 100000 元之间，且最多保留两位小数";
      toast.error(error);
      return { ok: false, error, errorField: "actualShippingFee" };
    }

    if (!hasNonFeeChanges && !feeChanged) {
      toast.info("未检测到需要保存的修改");
      return { ok: true };
    }

    const confirmation = hasNonFeeChanges && feeChanged
      ? "将先保存快递、日期和备注，再通过专用接口保存实际运费；如果运费保存失败，已保存的物流信息不会回退。"
      : feeChanged
      ? "将通过专用接口保存实际运费。"
      : "将保存发货信息的修改。";
    if (!confirmWrite("修改", confirmation)) return { ok: false, cancelled: true };

    let nonFeeSaved = false;
    if (hasNonFeeChanges) {
      const ok = await saveStateTransform((latest) => ({
        ...latest,
        shipments: latest.shipments.map((item) => item.id === sh.id ? { ...item, ...nonFeePatch } : item),
      }));
      if (!ok) {
        const error = "物流信息保存失败，实际运费尚未提交，请重试";
        toast.error(error);
        return { ok: false, error, errorField: "form" };
      }
      nonFeeSaved = true;
      setEditShipment((current) => current?.id === sh.id ? { ...current, ...nonFeePatch } : current);
    }

    if (feePayload) {
      try {
        const result = await postShipmentApi("shipments/actual-shipping-fee", feePayload);
        if (!result.shipment) throw new Error("服务端未返回更新后的发货记录，请刷新后重试");
        applyShipmentApiResult(setState, result);
        setEditShipment(result.shipment);
      } catch (error) {
        const detail = shipmentApiErrorMessage(error);
        if (error instanceof ShipmentApiError && error.code === "ACTUAL_SHIPPING_FEE_CONFLICT") {
          try {
            const latestShipment = await fetchCurrentShipment(sh.id);
            if (latestShipment) {
              applyShipmentApiResult(setState, { shipment: latestShipment });
              setEditShipment(null);
              const latestFee = roundShippingFee(latestShipment.actualShippingFee ?? 0) ?? 0;
              const message = nonFeeSaved
                ? `其他物流信息已保存；实际运费已被他人更新为 ¥${latestFee.toFixed(2)}。已刷新记录并关闭编辑，请重新打开核对后再保存`
                : `实际运费已被他人更新为 ¥${latestFee.toFixed(2)}。已刷新记录并关闭编辑，请重新打开核对后再保存`;
              toast.error(message);
              return { ok: false, error: message, errorField: "actualShippingFee" };
            }
          } catch (refreshError) {
            if (refreshError instanceof ShipmentApiError && refreshError.status === 401) {
              setEditShipment(null);
              const message = nonFeeSaved
                ? "其他物流信息已保存，但实际运费未保存；登录状态已失效，请重新登录后查看最新金额"
                : "登录状态已失效，请重新登录后查看最新运费";
              toast.error(message);
              return { ok: false, error: message, errorField: "actualShippingFee" };
            }
            // Fall through to an explicit manual refresh instruction below.
          }
          setEditShipment(null);
          const message = nonFeeSaved
            ? "其他物流信息已保存；实际运费已被他人更新。编辑已关闭，请刷新页面后再试"
            : "实际运费已被他人更新。编辑已关闭，请刷新页面后再试";
          toast.error(message);
          return { ok: false, error: message, errorField: "actualShippingFee" };
        }
        const message = nonFeeSaved
          ? `其他物流信息已保存，但实际运费未保存：${detail}`
          : `实际运费未保存：${detail}`;
        toast.error(message);
        return { ok: false, error: message, errorField: "actualShippingFee" };
      }
    }

    if (nonFeeSaved && feePayload) toast.success("物流信息和实际运费已更新");
    else if (feePayload) toast.success("实际运费已更新");
    else toast.success("发货信息已更新");
    return { ok: true };
  };

  const todayPending = pendingOrders.filter((o) => o.plannedShipDate === today);
  const otherPending = pendingOrders.filter((o) => o.plannedShipDate !== today);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2>发货管理</h2>
        <p className="text-sm text-muted-foreground">
          管理订单发货，预计今日发货排列靠前；填写物流信息后确认发货，支持多退少补结算提示
        </p>
      </div>

      {/* ── 待发货 ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Package className="size-4 text-sky-600" />
          <h3 className="text-base font-semibold">待发货订单</h3>
          {pendingOrders.length > 0 && (
            <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-sky-100 text-sky-700 font-medium">
              {pendingOrders.length}
            </span>
          )}
        </div>

        {pendingOrders.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            暂无待发货订单
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {todayPending.length > 0 && (
              <div className="rounded-lg border border-orange-200 overflow-hidden">
                <div className="px-4 py-2 bg-orange-50 flex items-center gap-2 text-sm font-medium text-orange-700">
                  <CalendarClock className="size-4" />
                  今日待发货（{todayPending.length}）
                </div>
                <table className="w-full">
                  <thead className="bg-orange-50/50 border-t border-orange-100">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">订单号</th>
                      <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">客户</th>
                      <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">商品</th>
                      <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">运费方式 / 预计</th>
                      <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">状态</th>
                      <th className="w-24 px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {todayPending.map((o) => {
                      const customer = getCustomer(o.customerId);
                      return (
                        <tr key={o.id} className="border-t hover:bg-orange-50/30 transition-colors">
                          <td className="px-4 py-3 text-sm font-mono text-sky-700">{o.orderNo}</td>
                          <td className="px-4 py-3 text-sm font-medium">
                            {customer?.name ?? (isPlatformOrderSource(o.source) ? platformOrderDisplayName(o) : "—")}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">{o.items.length} 条</td>
                          <td className="px-4 py-3 text-sm text-right">
                            {shippingFeeModeLabel(orderShippingFeeMode(o))}{orderShippingFeeMode(o) !== "collect" && o.shippingFee > 0 ? ` / ¥${o.shippingFee.toFixed(2)}` : ""}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${o.status === "confirmed" ? "bg-blue-100 text-blue-700" : "bg-orange-100 text-orange-700"}`}>
                              {o.status === "confirmed" ? "已确认" : "待确认"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button size="sm" onClick={() => setShipOrder(o)}>
                              {o.source === "线下"
                                ? <MapPin className="size-3.5 mr-1" />
                                : <Truck className="size-3.5 mr-1" />}
                              {o.source === "线下" ? "自提" : "发货"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {otherPending.length > 0 && (
              <div className="rounded-lg border overflow-hidden">
                {todayPending.length > 0 && (
                  <div className="px-4 py-2 bg-muted/40 text-xs font-medium text-muted-foreground flex items-center gap-2">
                    <ArrowUpDown className="size-3.5" />
                    其他待发货（{otherPending.length}）
                  </div>
                )}
                <table className="w-full">
                  <thead className="bg-muted/30 border-t">
                    <tr>
                      <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">订单号</th>
                      <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">客户</th>
                      <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">预计发货</th>
                      <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">商品</th>
                      <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">运费方式 / 预计</th>
                      <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">状态</th>
                      <th className="w-24 px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {otherPending.map((o) => {
                      const customer = getCustomer(o.customerId);
                      return (
                        <tr key={o.id} className="border-t hover:bg-muted/20 transition-colors">
                          <td className="px-4 py-3 text-sm font-mono text-sky-700">{o.orderNo}</td>
                          <td className="px-4 py-3 text-sm font-medium">
                            {customer?.name ?? (isPlatformOrderSource(o.source) ? platformOrderDisplayName(o) : "—")}
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {o.source === "线下"
                              ? <span className="text-emerald-700">无需发货</span>
                              : <PlannedShipBadge date={o.plannedShipDate} />}
                          </td>
                          <td className="px-4 py-3 text-sm text-muted-foreground">{o.items.length} 条</td>
                          <td className="px-4 py-3 text-sm text-right">
                            {shippingFeeModeLabel(orderShippingFeeMode(o))}{orderShippingFeeMode(o) !== "collect" && o.shippingFee > 0 ? ` / ¥${o.shippingFee.toFixed(2)}` : ""}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs ${o.status === "confirmed" ? "bg-blue-100 text-blue-700" : "bg-orange-100 text-orange-700"}`}>
                              {o.status === "confirmed" ? "已确认" : "待确认"}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button size="sm" variant="outline" onClick={() => setShipOrder(o)}>
                              {o.source === "线下"
                                ? <MapPin className="size-3.5 mr-1" />
                                : <Truck className="size-3.5 mr-1" />}
                              {o.source === "线下" ? "自提" : "发货"}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── 已发货记录 ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Truck className="size-4 text-muted-foreground" />
          <h3 className="text-base font-semibold">发货记录</h3>
          {shipmentRecords.length > 0 && (
            <span className="ml-1 px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground font-medium">
              {shipmentRecords.length}
            </span>
          )}
        </div>

        {shipmentRecords.length === 0 ? (
          <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
            暂无发货记录
          </div>
        ) : (
          <div className="rounded-lg border overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="bg-muted/30">
                <tr>
                  <th className="w-8 px-2 py-2.5" />
                  <th className="text-left px-4 py-2.5 text-xs text-muted-foreground font-medium">订单号</th>
                  <th className="text-left px-4 py-2.5 text-xs text-muted-foreground font-medium">客户</th>
                  <th className="text-left px-4 py-2.5 text-xs text-muted-foreground font-medium">发货日期</th>
                  <th className="text-left px-4 py-2.5 text-xs text-muted-foreground font-medium">物流方式</th>
                  <th className="text-left px-4 py-2.5 text-xs text-muted-foreground font-medium">快递 / 运单号</th>
                  <th className="text-right px-4 py-2.5 text-xs text-muted-foreground font-medium">预收</th>
                  <th className="text-right px-4 py-2.5 text-xs text-muted-foreground font-medium">实际运费</th>
                  <th className="text-left px-4 py-2.5 text-xs text-muted-foreground font-medium">状态</th>
                  <th className="w-36 px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {shipmentRecords.map((sh) => {
                  const order = getOrder(sh.orderId);
                  const customer = order ? getCustomer(order.customerId) : undefined;
                  const mode = orderShippingFeeMode(order);
                  const preCollected = mode === "prepaid" ? order?.shippingFee ?? 0 : 0;
                  const actual = sh.actualShippingFee ?? 0;
                  const feePending = !!order && shipmentHasPendingActualShippingFee(order, sh);
                  const feeDiff = actual - preCollected;
                  const isExpanded = expandedShipIds.has(sh.id);
                  const itemNames = getShipmentItemNames(sh);
                  const damageReplacements = sh.damageResolution === "reship" ? (sh.damageReplacements ?? []) : [];
                  const canExpand = itemNames.length > 0 || damageReplacements.length > 0;
                  const packingProofs = shipmentPackingProofs(sh);

                  return (
                    <React.Fragment key={sh.id}>
                      <tr className="border-t hover:bg-muted/20 transition-colors">
                        {/* 展开按钮 */}
                        <td className="px-2 py-3 text-center">
                          {canExpand && (
                            <button
                              onClick={() => toggleExpand(sh.id)}
                              className="text-muted-foreground hover:text-foreground transition-colors"
                              title={isExpanded ? "收起商品" : "展开商品"}
                            >
                              {isExpanded
                                ? <ChevronUp className="size-4" />
                                : <ChevronDown className="size-4" />}
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm font-mono text-sky-700">{order?.orderNo ?? "—"}</td>
                        <td className="px-4 py-3 text-sm font-medium">
                          {customer?.name ?? (isPlatformOrderSource(order?.source) ? platformOrderDisplayName(order) : "—")}
                        </td>
                        <td className="px-4 py-3 text-sm">{sh.shipDate}</td>
                        <td className="px-4 py-3 text-sm">
                          {sh.shipMethod === "pickup" ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-emerald-100 text-emerald-700">
                              <MapPin className="size-3" /> 上门自取
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-blue-100 text-blue-700">
                              <Truck className="size-3" /> 快递
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {sh.shipMethod === "pickup" ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div>
                              <div className="font-medium">{sh.carrier || <span className="text-muted-foreground">未填</span>}</div>
                              {sh.trackingNo && (
                                <div className="font-mono text-xs text-muted-foreground">{sh.trackingNo}</div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-right text-muted-foreground">
                          {sh.shipMethod === "pickup" ? "—" : `${shippingFeeModeLabel(mode)}${preCollected > 0 ? ` ¥${preCollected.toFixed(2)}` : ""}`}
                        </td>
                        <td className="px-4 py-3 text-sm text-right">
                          <div className="flex flex-col items-end">
                            {feePending ? (
                              <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">待补运费</span>
                            ) : (
                              <span>¥{actual.toFixed(2)}</span>
                            )}
                            {!feePending && mode === "prepaid" && Math.abs(feeDiff) > 0.005 && (
                              <span className={`text-xs ${feeDiff > 0 ? "text-amber-600" : "text-sky-600"}`}>
                                {feeDiff > 0 ? `+¥${feeDiff.toFixed(2)}` : `-¥${Math.abs(feeDiff).toFixed(2)}`} 待补
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {sh.status === "delivered" ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700">
                              <CheckCircle2 className="size-3" /> 已签收
                            </span>
                          ) : sh.status === "damaged" ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">
                              <XCircle className="size-3" />
                              {sh.damageResolution === "reship" ? "已报损 · 补发" : "已报损 · 退款"}
                            </span>
                          ) : sh.status === "outbound" ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-sky-100 text-sky-700">
                              <PackageCheck className="size-3" /> 已出库/待发货
                            </span>
                          ) : (
                            <button
                              onClick={() => setDeliverShipment(sh)}
                              title="点击确认签收"
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 hover:bg-emerald-100 hover:text-emerald-700 transition-colors cursor-pointer"
                            >
                              <Truck className="size-3" /> 运输中
                            </button>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {packingProofs.length > 0 && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="whitespace-nowrap"
                                onClick={() => setProofShipment(sh)}
                              >
                                <Camera className="size-3.5" />
                                凭证 {packingProofs.length}
                              </Button>
                            )}
                            {sh.status === "shipped" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-sky-600 hover:text-sky-700 hover:bg-sky-50 whitespace-nowrap"
                                onClick={() => setEditShipment(sh)}
                              >
                                <Pencil className="size-3.5 mr-1" /> 编辑
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* 展开行：已发货商品列表 */}
                      {isExpanded && canExpand && (
                        <tr className="border-t bg-muted/10">
                          <td />
                          <td colSpan={9} className="px-4 py-2">
                            {damageReplacements.length > 0 && (
                              <div className="mb-3">
                                <div className="mb-1.5 text-xs font-semibold text-sky-800">补发对应关系（{damageReplacements.length} 条）</div>
                                <div className="grid gap-1.5">
                                  {damageReplacements.map((replacement) => {
                                    const original = replacementSide(replacement, "original");
                                    const reship = replacementSide(replacement, "replacement");
                                    return (
                                      <div key={`${replacement.originalStockItemId}-${replacement.replacementStockItemId}`} className="grid items-center gap-2 rounded border border-sky-100 bg-sky-50/50 px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                                        <div className="min-w-0">
                                          <div className="truncate font-medium text-red-700">原报损：{original.productName} · {original.fishCode}</div>
                                          <div className="truncate text-xs text-muted-foreground">{original.tankName}</div>
                                        </div>
                                        <ArrowRightLeft className="size-4 text-sky-600" />
                                        <div className="min-w-0">
                                          <div className="truncate font-medium text-emerald-700">补发：{reship.productName} · {reship.fishCode}</div>
                                          <div className="truncate text-xs text-muted-foreground">{reship.tankName}</div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                            {itemNames.length > 0 && (
                              <>
                                <div className="text-xs text-muted-foreground mb-1.5 font-medium">
                                  本次发货商品（{itemNames.length} 条）
                                </div>
                                <div className="flex flex-col gap-1 max-h-40 overflow-y-auto pr-1">
                                  {(sh.itemStockIds ?? []).map((sid, idx) => {
                                    const order2 = getOrder(sh.orderId);
                                    const oi = order2?.items.find(i => i.stockItemId === sid);
                                    return (
                                      <div
                                        key={sid}
                                        className="flex items-center justify-between text-sm px-2 py-1.5 rounded bg-white border"
                                      >
                                        <span className="font-medium">{itemNames[idx] ?? "—"}</span>
                                        <span className="text-muted-foreground text-xs">{getTankName(sid)}</span>
                                        {oi && (
                                          <span className="text-xs text-sky-700 font-mono">¥{oi.price.toFixed(2)}</span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Ship Dialog ── */}
      <ShipDialog
        order={shipOrder}
        open={!!shipOrder}
        onOpenChange={(o) => { if (!o) setShipOrder(null); }}
        onShip={(data) => shipOrder ? doShip(shipOrder, data) : false}
        unshippedItems={shipOrder ? getUnshippedItems(shipOrder) : []}
        getProductName={getProductName}
        getTankName={getTankName}
        pickupOnly={isPickupOrderSource(shipOrder?.source)}
      />

      {/* ── Edit Shipment Dialog ── */}
      <EditShipmentDialog
        shipment={editShipment}
        order={editShipment ? getOrder(editShipment.orderId) : undefined}
        minShipDate={editShipment ? getOrder(editShipment.orderId)?.date : undefined}
        open={!!editShipment}
        onOpenChange={(o) => { if (!o) setEditShipment(null); }}
        onSave={(patch) => editShipment
          ? doEditShipment(editShipment, patch)
          : Promise.resolve({ ok: false, error: "发货单不存在，请刷新后重试", errorField: "form" })}
      />

      <ShipmentProofDialog
        shipment={proofShipment}
        orderNo={proofShipment ? getOrder(proofShipment.orderId)?.orderNo : undefined}
        open={!!proofShipment}
        onOpenChange={(nextOpen) => { if (!nextOpen) setProofShipment(null); }}
      />

      {/* ── Confirm Delivered ── */}
      <AlertDialog open={!!deliverShipment} onOpenChange={(o) => !o && setDeliverShipment(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认签收</AlertDialogTitle>
            <AlertDialogDescription>
              确认订单「{getOrder(deliverShipment?.orderId ?? "")?.orderNo}」已签收？
              发货操作时间：{formatLocalDateTimeMinute(deliverShipment?.createdAt)}。
              若该订单所有发货单都已签收，订单状态将更新为「已完成」。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deliverShipment && doMarkDelivered(deliverShipment)}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              <CheckCircle2 className="size-4 mr-1" /> 确认签收
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
