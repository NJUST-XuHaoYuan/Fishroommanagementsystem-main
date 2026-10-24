import { useState, useEffect } from "react";
import { configuredShippingCarriers, Order, OrderItem, type StockTankTransfer, useStore } from "../store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Checkbox } from "./ui/checkbox";
import { Textarea } from "./ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { toast } from "sonner";
import { PackageCheck, Truck, MapPin, Info, CheckSquare, Square } from "lucide-react";
import { orderShippingFeeMode, shippingFeeModeLabel } from "../utils/orderFees";
import { outboundTransferConfirmationKey, outboundTransferSnapshotsMatch, selectExpectedStockLocations, type ExpectedStockLocations, type OutboundTransferDispatch, type OutboundTransferSnapshots, type StockLocationSnapshot } from "../utils/orderOutbound";
import { visibleSitesForUser } from "../utils/sites";

function todayDateString(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export type ShipFormData = {
  shipDate: string;
  shipMethod: "express" | "pickup";
  carrier: string;
  trackingNo: string;
  actualShippingFee: number;
  notes: string;
  selectedItemIds: string[]; // stockItemIds included in this shipment
  expectedStockLocations?: ExpectedStockLocations;
  transferDispatch?: OutboundTransferDispatch;
};

type ItemMeta = {
  stockItemId: string;
  productId: string;
  price: number;
  productName: string;
  tankName: string;
  inTransfer: boolean;
};

export function ShipDialog({
  order,
  open,
  onOpenChange,
  onShip,
  unshippedItems,      // items not yet in any shipment
  getProductName,
  getTankName,
  getStockLocation,
  getStockTransfer,
  orderSiteName,
  pickupOnly = false,
}: {
  order: Order | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onShip: (data: ShipFormData) => boolean | Promise<boolean>;
  unshippedItems: OrderItem[];
  getProductName: (productId: string) => string;
  getTankName: (stockItemId: string) => string;
  getStockLocation?: (stockItemId: string) => StockLocationSnapshot | undefined;
  getStockTransfer?: (stockItemId: string) => StockTankTransfer | undefined;
  orderSiteName?: string;
  pickupOnly?: boolean;
}) {
  const { state } = useStore();
  const todayStr = todayDateString();
  const shippingCarriers = configuredShippingCarriers(state.systemSettings);

  const [shipDate, setShipDate] = useState(todayStr);
  const [carrier, setCarrier] = useState("");
  const [trackingNo, setTrackingNo] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [locationSnapshots, setLocationSnapshots] = useState<ExpectedStockLocations>({});
  const [transferSnapshots, setTransferSnapshots] = useState<OutboundTransferSnapshots>({});
  const [dispatchSiteId, setDispatchSiteId] = useState("");
  const [confirmedTransferKey, setConfirmedTransferKey] = useState("");
  const dispatchSites = state.user ? visibleSitesForUser(state.user, state) : [];
  const shipMethod: "express" | "pickup" = pickupOnly ? "pickup" : "express";
  const shippingFeeMode = orderShippingFeeMode(order);

  const itemMetas: ItemMeta[] = unshippedItems.map((i) => ({
    stockItemId: i.stockItemId,
    productId: i.productId,
    price: i.price,
    productName: getProductName(i.productId),
    tankName: getTankName(i.stockItemId),
    inTransfer: getStockTransfer?.(i.stockItemId)?.status === "in_transit",
  }));

  useEffect(() => {
    if (open && order) {
      setShipDate(todayStr);
      setCarrier("");
      setTrackingNo("");
      setNotes("");
      setSelectedIds(new Set(unshippedItems.map((i) => i.stockItemId)));
      setLocationSnapshots(Object.fromEntries(unshippedItems.flatMap((item) => {
        const location = getStockLocation?.(item.stockItemId);
        return location ? [[item.stockItemId, { ...location }]] : [];
      })));
      setTransferSnapshots(Object.fromEntries(unshippedItems.map((item) => {
        const transfer = getStockTransfer?.(item.stockItemId);
        return [item.stockItemId, transfer?.status === "in_transit" ? transfer.id : ""];
      })));
      setDispatchSiteId("");
      setConfirmedTransferKey("");
      setSaving(false);
    }
  }, [open, order?.id, pickupOnly]); // eslint-disable-line

  if (!order) return null;

  const selectedTransferItems = [...selectedIds].filter((id) => transferSnapshots[id])
    .map((stockItemId) => ({ stockItemId, transferId: transferSnapshots[stockItemId] }));
  const transferConfirmationKey = outboundTransferConfirmationKey([...selectedIds], transferSnapshots, dispatchSiteId);
  const transferConfirmed = confirmedTransferKey === transferConfirmationKey;

  const toggleItem = (id: string) => {
    setConfirmedTransferKey("");
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setConfirmedTransferKey("");
    if (selectedIds.size === itemMetas.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(itemMetas.map((i) => i.stockItemId)));
  };

  const confirm = async () => {
    if (saving) return;
    if (!shipDate) return toast.error("请填写出库日期");
    if (shipDate < order.date) return toast.error("出库日期不能早于下单日期");
    if (shipDate > todayStr) return toast.error("出库日期不能晚于今天");
    if (shipMethod === "express" && !carrier.trim()) return toast.error("请选择快递公司");
    if (selectedIds.size === 0) return toast.error("请至少选择一件商品进行出库");
    const currentTransfers = Object.fromEntries(itemMetas.map((item) => {
      const transfer = getStockTransfer?.(item.stockItemId);
      return [item.stockItemId, transfer?.status === "in_transit" ? transfer.id : ""];
    }));
    if (!outboundTransferSnapshotsMatch([...selectedIds], transferSnapshots, currentTransfers)) {
      return toast.error("所选鱼的移缸或出库状态已变化，请关闭窗口并重新选择");
    }
    if (selectedTransferItems.length > 0) {
      if (!dispatchSites.some((site) => site.id === dispatchSiteId)) return toast.error("请选择有权限的实际发货场地");
      if (!transferConfirmed) return toast.error("请明确确认在途直接出库");
    }
    const normalSelectedIds = [...selectedIds].filter((id) => !transferSnapshots[id]);
    const expectedStockLocations = getStockLocation
      ? selectExpectedStockLocations(normalSelectedIds, locationSnapshots)
      : undefined;
    if (expectedStockLocations === null) return toast.error("库存位置暂不可用，请关闭出库窗口并刷新后重试");
    setSaving(true);
    try {
      const ok = await onShip({
        shipDate,
        shipMethod,
        carrier,
        trackingNo,
        // Actual charges are recorded separately after the carrier provides them.
        actualShippingFee: 0,
        notes,
        selectedItemIds: [...selectedIds],
        ...(expectedStockLocations ? { expectedStockLocations } : {}),
        ...(selectedTransferItems.length > 0 ? { transferDispatch: { siteId: dispatchSiteId, items: selectedTransferItems } } : {}),
      });
      if (ok !== false) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen); }}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-none sm:max-w-none w-[min(92vw,680px)] max-h-[90vh] min-h-0 flex flex-col"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="size-4 text-sky-600" />
            {pickupOnly ? "确认自提" : "出库"} — {order.orderNo}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 py-1 pr-1 pb-3">

          {orderSiteName && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              普通鱼按当前场地与缸位{pickupOnly ? "自提" : "出库"}；在途鱼需另选实际发货场地。订单仍归属{orderSiteName}，金额不变。
            </p>
          )}

          {/* Item selection */}
          <div className="rounded-lg border bg-card">
            <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b rounded-t-lg">
              <span className="text-xs font-medium text-muted-foreground">
                本次出库商品（{selectedIds.size}/{itemMetas.length}）
              </span>
              <button
                type="button"
                onClick={toggleAll}
                disabled={saving}
                className="min-h-11 text-xs text-sky-600 hover:text-sky-700 font-medium flex items-center gap-1 disabled:opacity-50"
              >
                {selectedIds.size === itemMetas.length
                  ? <><CheckSquare className="size-3.5" /> 取消全选</>
                  : <><Square className="size-3.5" /> 全选</>}
              </button>
            </div>
            <div
              className="block overflow-y-auto rounded-b-lg"
              style={{ maxHeight: "min(22rem, 42vh)", paddingBottom: "1rem", scrollPaddingBottom: "1rem" }}
            >
              {itemMetas.map((item) => {
                const checked = selectedIds.has(item.stockItemId);
                return (
                  <button
                    key={item.stockItemId}
                    type="button"
                    aria-pressed={checked}
                    disabled={saving}
                    onClick={() => toggleItem(item.stockItemId)}
                    className={`w-full min-h-16 flex items-center gap-3 px-3 py-3 text-left border-b transition-colors ${checked ? "bg-sky-50" : "hover:bg-muted/30"}`}
                  >
                    {checked
                      ? <CheckSquare className="size-4 text-sky-600 shrink-0" />
                      : <Square className="size-4 text-muted-foreground shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{item.productName}</div>
                      <div className="text-xs text-muted-foreground">{item.tankName}</div>
                      {item.inTransfer && <div className="text-xs font-medium text-amber-700">移缸在途 · 需确认直接出库</div>}
                    </div>
                    <div className="text-sm text-right shrink-0">¥{item.price.toFixed(2)}</div>
                  </button>
                );
              })}
              {itemMetas.length === 0 && (
                <div className="px-3 py-4 text-sm text-center text-muted-foreground">无待发货商品</div>
              )}
            </div>
          </div>

          {selectedTransferItems.length > 0 && (
            <section className="grid gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-3" aria-labelledby="transfer-dispatch-title">
              <h3 id="transfer-dispatch-title" className="text-sm font-medium text-amber-900">在途直接出库 · {selectedTransferItems.length} 条</h3>
              <p className="text-xs leading-relaxed text-amber-900">
                仅用于本订单已关联的鱼。本次操作会结束移缸在途，不登记签收入缸，保留原签发场地和缸位记录。
              </p>
              <div className="grid gap-1.5">
                <Label htmlFor="transfer-dispatch-site">实际发货场地<span className="ml-0.5 text-red-600">*</span></Label>
                <Select value={dispatchSiteId} onValueChange={(id) => { setDispatchSiteId(id); setConfirmedTransferKey(""); }} disabled={saving}>
                  <SelectTrigger id="transfer-dispatch-site" className="min-h-11 bg-background"><SelectValue placeholder="请选择鱼当前实际发货的场地" /></SelectTrigger>
                  <SelectContent>{dispatchSites.map((site) => <SelectItem key={site.id} value={site.id}>{site.name}</SelectItem>)}</SelectContent>
                </Select>
                {dispatchSites.length === 0 && <p role="alert" className="text-xs text-red-700">当前账号没有可操作的发货场地，请联系管理员。</p>}
              </div>
              <Label htmlFor="confirm-transfer-dispatch" className="flex min-h-11 cursor-pointer items-start gap-2 py-2 text-sm leading-relaxed text-amber-950">
                <Checkbox id="confirm-transfer-dispatch" className="mt-1 shrink-0" disabled={saving || !dispatchSiteId}
                  checked={transferConfirmed}
                  onCheckedChange={(checked) => setConfirmedTransferKey(checked === true ? transferConfirmationKey : "")} />
                <span>确认这 {selectedTransferItems.length} 条鱼在所选场地直接出库，无需再签收入缸。</span>
              </Label>
            </section>
          )}

          {/* Shipping method */}
          <div className="grid gap-2">
            <Label>履约方式</Label>
            {pickupOnly ? (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2.5 text-sm font-medium text-emerald-800">
                <MapPin className="size-4" />
                上门自取
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2.5 text-sm font-medium text-sky-800">
                <span className="flex items-center gap-2"><Truck className="size-4" />物流发货</span>
                <span>{shippingFeeModeLabel(shippingFeeMode)}</span>
              </div>
            )}
          </div>

          {/* Express fields */}
          {shipMethod === "express" && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label className="text-sm">快递公司<span className="text-red-500 ml-0.5">*</span></Label>
                <Select value={carrier} onValueChange={setCarrier}>
                  <SelectTrigger>
                    <SelectValue placeholder="请选择快递公司" />
                  </SelectTrigger>
                  <SelectContent>
                    {shippingCarriers.map((item) => (
                      <SelectItem key={item.id} value={item.name}>{item.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Outbound date: carrier charges are not known at this stage. */}
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label className="text-sm">{pickupOnly ? "自提日期" : "出库日期"}<span className="text-red-500 ml-0.5">*</span></Label>
              <Input
                type="date"
                value={shipDate}
                min={order.date}
                max={todayStr}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value && value < order.date) {
                    toast.error("出库日期不能早于下单日期");
                    return;
                  }
                  if (value && value > todayStr) {
                    toast.error("出库日期不能晚于今天");
                    return;
                  }
                  setShipDate(value);
                }}
              />
            </div>
          </div>

          {/* Fee recording happens independently from outbound and delivery. */}
          {shipMethod === "express" && shippingFeeMode === "collect" && (
            <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
              <Info className="size-4 mt-0.5 shrink-0" />
              到付运费由客户向承运方支付，不填写金额，也不计入订单应收。
            </div>
          )}
          {shipMethod === "express" && shippingFeeMode !== "collect" && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              <Info className="size-4 mt-0.5 shrink-0" aria-hidden="true" />
              出库无需填写实际运费。费用确定后，可在上传打包凭证时或发货后独立补录；不影响签收，完成订单前需补齐。
            </div>
          )}

          {/* Notes */}
          <div className="grid gap-1.5">
            <Label className="text-sm">备注</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="特殊要求…" />
          </div>
        </div>

        <DialogFooter className="border-t pt-3 shrink-0">
          <Button className="min-h-11" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button className="min-h-11" onClick={confirm} disabled={saving || (selectedTransferItems.length > 0 && (!transferConfirmed || !dispatchSites.some((site) => site.id === dispatchSiteId)))}>
            <PackageCheck className="size-4 mr-1" />
            {saving ? "保存中..." : pickupOnly ? "确认自提" : "确认出库"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
