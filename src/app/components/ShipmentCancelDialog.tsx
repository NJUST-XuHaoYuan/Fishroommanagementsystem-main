import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import type { Store, User } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent, type NewCustomerSession } from "../utils/newCustomerEvidence";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

export type ShipmentCancelCandidate = {
  stockItemId: string;
  fishCode: string;
  subTankId: string;
  tankName: string;
  notes?: string;
  status?: string;
};
export type ShipmentCancelItem = {
  stockItemId: string;
  fishCode: string;
  productName: string;
  batchNo: string;
  siteId: string;
  subTankId: string;
  tankName: string;
  restoreTransfer: boolean;
  candidates: ShipmentCancelCandidate[];
};
export type ShipmentCancelPreview = {
  shipmentId: string;
  orderNo: string;
  reviewToken: string;
  items: ShipmentCancelItem[];
  tanks: { id: string; siteId: string; name: string }[];
  hasStocktakeHints?: boolean;
  warnings?: string[];
};
export type ShipmentCancelChoice = { mode: "" | "restore" | "merge"; subTankId: string; duplicateStockItemId: string };
export type ShipmentCancelResult = Partial<Pick<Store, "orders" | "shipments" | "stock" | "batches" | "bioRecords" | "publicCatalogPolicy" | "inventoryProjection">> & {
  ok: true;
  operationLog?: Store["operationLogs"][number];
};

const fishLabel = (item: Pick<ShipmentCancelItem, "fishCode" | "stockItemId">) => item.fishCode ? `编号 ${item.fishCode}` : `库存 ID ${item.stockItemId}`;

export function shipmentCancellationPayload(
  preview: ShipmentCancelPreview,
  choices: Record<string, ShipmentCancelChoice>,
  confirmed: boolean,
) {
  if (!confirmed) throw new Error("请先确认已逐条核对实物和补录记录。");
  if (!preview.reviewToken || preview.items.length === 0) throw new Error("没有可处理的鱼只，请重新加载核对信息。");
  const usedDuplicates = new Set<string>();
  const returnItems = preview.items.filter(item => !item.restoreTransfer).map(item => {
    const choice = choices[item.stockItemId];
    if (!choice?.mode) throw new Error(`请为${fishLabel(item)}选择处理方式。`);
    if (choice.mode !== "restore" && choice.mode !== "merge") throw new Error("处理方式无效，请重新选择。");
    if (!preview.tanks.some(tank => tank.id === choice.subTankId)) throw new Error(`请为${fishLabel(item)}选择回缸位置。`);
    if (choice.mode === "merge") {
      const duplicate = item.candidates.find(candidate => candidate.stockItemId === choice.duplicateStockItemId);
      if (!duplicate || duplicate.subTankId !== choice.subTankId) throw new Error(`请为${fishLabel(item)}选择已核实的补录记录。`);
      if (usedDuplicates.has(duplicate.stockItemId)) throw new Error("同一条补录记录只能对应一条原鱼，请重新核对。");
      usedDuplicates.add(duplicate.stockItemId);
      return { stockItemId: item.stockItemId, subTankId: choice.subTankId, duplicateStockItemId: duplicate.stockItemId };
    }
    return { stockItemId: item.stockItemId, subTankId: choice.subTankId };
  });
  return { shipmentId: preview.shipmentId, reviewToken: preview.reviewToken, confirmedPhysicalReturn: true, returnItems };
}

export function shipmentCancelPreviewFromPayload(payload: unknown, shipmentId: string): ShipmentCancelPreview | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (data.ok !== true || data.shipmentId !== shipmentId || typeof data.reviewToken !== "string" || !data.reviewToken
    || typeof data.orderNo !== "string" || !Array.isArray(data.items) || data.items.length === 0 || !Array.isArray(data.tanks)) return null;
  const items = data.items as ShipmentCancelItem[];
  if (items.some(item => !item || typeof item.stockItemId !== "string" || !item.stockItemId
    || typeof item.productName !== "string" || typeof item.restoreTransfer !== "boolean"
    || !Array.isArray(item.candidates) || item.candidates.some(candidate => !candidate || typeof candidate.stockItemId !== "string"
      || !candidate.stockItemId || typeof candidate.subTankId !== "string" || !candidate.subTankId))
    || new Set(items.map(item => item.stockItemId)).size !== items.length) return null;
  const tanks = data.tanks as ShipmentCancelPreview["tanks"];
  if (tanks.some(tank => !tank || typeof tank.id !== "string" || !tank.id || typeof tank.siteId !== "string" || typeof tank.name !== "string")) return null;
  return { shipmentId, orderNo: data.orderNo, reviewToken: data.reviewToken, items, tanks,
    hasStocktakeHints: data.hasStocktakeHints === true,
    warnings: Array.isArray(data.warnings) ? data.warnings.filter((warning): warning is string => typeof warning === "string") : [] };
}

type Props = {
  shipmentId: string;
  viewer: User;
  canUpdate: boolean;
  onClose: () => void;
  onApplied: (result: ShipmentCancelResult, session: NewCustomerSession) => void;
};

export function ShipmentCancelDialog({ shipmentId, viewer, canUpdate, onClose, onApplied }: Props) {
  const [preview, setPreview] = useState<ShipmentCancelPreview | null>(null);
  const [choices, setChoices] = useState<Record<string, ShipmentCancelChoice>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const previewSessionRef = useRef<NewCustomerSession | null>(null);
  const propsRef = useRef({ viewer, canUpdate, onApplied, onClose });
  propsRef.current = { viewer, canUpdate, onApplied, onClose };
  const errorRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async (message = "") => {
    const sequence = ++sequenceRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    previewSessionRef.current = null;
    setPreview(null); setChoices({}); setConfirmed(false); setAttempted(false); setLoading(true); setError(message);
    const session = captureNewCustomerSession();
    const current = () => mountedRef.current && sequence === sequenceRef.current && isNewCustomerSessionCurrent(session, propsRef.current.viewer);
    if (!isNewCustomerSessionCurrent(session, propsRef.current.viewer) || !propsRef.current.canUpdate) {
      setLoading(false); setError("登录状态或权限已变化，请重新进入订单后操作。"); return;
    }
    try {
      const response = await fetch(`/api/shipments/cancel-preview?shipmentId=${encodeURIComponent(shipmentId)}`, {
        headers: authJsonHeaders(), signal: controller.signal, cache: "no-store",
      });
      const result = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || result.ok !== true) throw new Error(result.error || "回缸核对信息加载失败，请重试。");
      const data = shipmentCancelPreviewFromPayload(result, shipmentId);
      if (!data) throw new Error("服务器返回的鱼只核对信息不完整，请重新加载。");
      previewSessionRef.current = session;
      setPreview(data);
      setChoices(Object.fromEntries(data.items.filter(item => !item.restoreTransfer).map(item => [item.stockItemId, {
        mode: "" as const, subTankId: data.tanks.some(tank => tank.id === item.subTankId) ? item.subTankId : "", duplicateStockItemId: "",
      }])));
    } catch (cause) {
      if (current() && !controller.signal.aborted) setError(cause instanceof TypeError ? "网络连接失败，请重新加载核对信息。" : cause instanceof Error ? cause.message : "加载失败，请重试。");
    } finally { if (current()) setLoading(false); }
  }, [shipmentId]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    return () => { mountedRef.current = false; sequenceRef.current += 1; controllerRef.current?.abort(); };
  }, [reload, canUpdate]);

  const choose = (stockItemId: string, patch: Partial<ShipmentCancelChoice>) => {
    setChoices(previous => ({ ...previous, [stockItemId]: { ...previous[stockItemId], ...patch } }));
    setConfirmed(false);
    setError("");
  };
  const normalItems = preview?.items.filter(item => !item.restoreTransfer) ?? [];
  const mergeCount = normalItems.filter(item => choices[item.stockItemId]?.mode === "merge").length;
  const restoreCount = normalItems.filter(item => choices[item.stockItemId]?.mode === "restore").length;
  const validationError = (() => { if (!preview) return ""; try { shipmentCancellationPayload(preview, choices, confirmed); return ""; } catch (cause) { return cause instanceof Error ? cause.message : "请完成核对。"; } })();

  const submit = async () => {
    if (busyRef.current || loading || !preview || !propsRef.current.canUpdate) return;
    setAttempted(true);
    if (validationError) { setError(validationError); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    const session = captureNewCustomerSession();
    if (!isNewCustomerSessionCurrent(session, propsRef.current.viewer)) { setError("登录状态已变化，请重新登录后操作。"); return; }
    if (session?.key !== previewSessionRef.current?.key) { await reload("登录状态已变化，已重新加载，请重新核对后再提交。"); return; }
    busyRef.current = true; setSaving(true); setError("");
    const current = () => mountedRef.current && isNewCustomerSessionCurrent(session, propsRef.current.viewer);
    try {
      const response = await fetch("/api/shipments/cancel", {
        method: "POST", headers: authJsonHeaders(), cache: "no-store",
        body: JSON.stringify(shipmentCancellationPayload(preview, choices, confirmed)),
      });
      const result = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok || result.ok !== true) {
        const message = result.error || "取消出库未成功，请刷新核对后重试。";
        if (response.status === 409) { await reload(`${message} 已重新加载，请逐条重新核对。`); return; }
        throw new Error(message);
      }
      if (!Array.isArray(result.stock) || !Array.isArray(result.shipments) || !Array.isArray(result.orders)
        || result.shipments.some((shipment: { id?: string }) => shipment.id === shipmentId)) {
        throw new Error("服务器未返回完整的库存处理结果，请刷新核对，勿重复提交。");
      }
      propsRef.current.onApplied(result, session!);
      propsRef.current.onClose();
    } catch (cause) {
      if (current()) { setError(cause instanceof TypeError ? "网络连接失败，请刷新核对处理结果后再操作。" : cause instanceof Error ? cause.message : "操作失败，请重试。"); requestAnimationFrame(() => errorRef.current?.focus()); }
    } finally { busyRef.current = false; if (mountedRef.current) setSaving(false); }
  };

  return <Dialog open onOpenChange={open => { if (!open && !busyRef.current) onClose(); }}>
    <DialogContent aria-describedby="shipment-cancel-description" aria-busy={loading || saving}
      onEscapeKeyDown={event => { if (busyRef.current) event.preventDefault(); }}
      onPointerDownOutside={event => { if (busyRef.current) event.preventDefault(); }}
      className={`max-h-[90dvh] max-w-3xl overflow-y-auto ${saving ? "[&_[data-slot=dialog-close]]:pointer-events-none [&_[data-slot=dialog-close]]:opacity-30" : ""}`}>
      <DialogHeader><DialogTitle>取消出库 · 回缸核对</DialogTitle></DialogHeader>
      <p id="shipment-cancel-description" className="text-sm leading-6 text-muted-foreground">请按实物逐条核对。已被盘库补录的鱼，选择对应记录合并，避免原鱼再次计入后数量变多。</p>
      {preview && <p className="break-words text-sm">订单：<strong>{preview.orderNo}</strong> · 共 {preview.items.length} 条</p>}
      {error && <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-sm leading-6 text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring">{error}</div>}
      {loading ? <div role="status" className="space-y-2 py-3"><p className="text-sm text-muted-foreground">正在核对鱼只、缸位和可关联的库存记录…</p><div className="h-20 rounded-md bg-muted" /><div className="h-20 rounded-md bg-muted" /></div> : !preview ? <div className="space-y-3"><p className="text-sm text-muted-foreground">核对信息未加载完成，库存尚未处理。</p><Button type="button" variant="outline" className="min-h-11" onClick={() => void reload()}><RefreshCw className="size-4" aria-hidden="true" />重新加载</Button></div> : <>
        {(preview.hasStocktakeHints || preview.items.some(item => item.candidates.length > 0)) && <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-3 text-sm leading-6"><AlertTriangle className="mt-1 size-4 shrink-0" aria-hidden="true" /><p>存在同商品、同批次的在缸记录。请先核对是否为盘库补录的同一条鱼；商品和批次相同并不能证明是同一条。</p></div>}
        {preview.warnings?.map((warning, index) => <p key={index} className="text-sm leading-6 text-muted-foreground">{warning}</p>)}
        <div className="space-y-3">
          {preview.items.map((item, index) => {
            const choice = choices[item.stockItemId];
            const id = `shipment-cancel-${index}`;
            return <fieldset key={item.stockItemId} className="min-w-0 space-y-3 rounded-md border p-3 sm:p-4">
              <legend className="max-w-full px-1 text-sm font-semibold [overflow-wrap:anywhere]">{item.productName} · {fishLabel(item)}</legend>
              <p className="break-words text-xs leading-5 text-muted-foreground">批次：{item.batchNo || "未记录"} · 原缸位：{item.tankName || "未记录"}</p>
              {item.restoreTransfer ? <p className="text-sm leading-6">此鱼从移缸在途中直接出库，取消后恢复“移缸在途”。到达目的缸后，再通过“签收入缸”处理。</p> : <>
                <label htmlFor={`${id}-mode`} className="grid gap-1.5 text-sm"><span>这条鱼现在如何处理<span aria-hidden="true"> *</span></span>
                  <select id={`${id}-mode`} value={choice?.mode || ""} disabled={saving} aria-required="true" aria-invalid={attempted && !choice?.mode}
                    className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                    onChange={event => choose(item.stockItemId, { mode: event.target.value as ShipmentCancelChoice["mode"], duplicateStockItemId: "" })}>
                    <option value="">请选择处理方式</option><option value="restore">实物在缸内或已回缸，恢复原鱼记录</option><option value="merge" disabled={item.candidates.length === 0}>已经盘库补录，关联补录记录合并</option>
                  </select>
                </label>
                {choice?.mode === "merge" && <div className="space-y-2">
                  <label htmlFor={`${id}-duplicate`} className="grid gap-1.5 text-sm"><span>选择已核实为同一条鱼的补录记录<span aria-hidden="true"> *</span></span>
                    <select id={`${id}-duplicate`} value={choice.duplicateStockItemId} disabled={saving} aria-required="true" aria-invalid={attempted && !choice.duplicateStockItemId}
                      className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                      onChange={event => { const candidate = item.candidates.find(entry => entry.stockItemId === event.target.value); choose(item.stockItemId, { duplicateStockItemId: event.target.value, subTankId: candidate?.subTankId || "" }); }}>
                      <option value="">请选择对应的补录记录</option>
                      {item.candidates.map(candidate => <option key={candidate.stockItemId} value={candidate.stockItemId}
                        disabled={normalItems.some(other => other.stockItemId !== item.stockItemId && choices[other.stockItemId]?.duplicateStockItemId === candidate.stockItemId)}>
                        {fishLabel(candidate)} · {candidate.tankName}
                      </option>)}
                    </select>
                  </label>
                  {choice.duplicateStockItemId && <p className="break-words text-xs leading-5 text-muted-foreground">{item.candidates.find(candidate => candidate.stockItemId === choice.duplicateStockItemId)?.notes || "此记录没有备注，请结合编号和实物核对。"}</p>}
                  <p className="text-xs leading-5 text-muted-foreground">确认后保留原鱼及订单关联，将所选重复档案合并为一条，保留维护记录和本次处理记录。</p>
                </div>}
                {choice?.mode && <label htmlFor={`${id}-tank`} className="grid gap-1.5 text-sm"><span>{choice.mode === "merge" ? "补录记录当前缸位" : "实物回缸位置"}<span aria-hidden="true"> *</span></span>
                  <select id={`${id}-tank`} value={choice.subTankId} disabled={saving || choice.mode === "merge"} aria-required="true" aria-invalid={attempted && !choice.subTankId}
                    className="fishroom-control min-h-11 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                    onChange={event => choose(item.stockItemId, { subTankId: event.target.value })}>
                    <option value="">请选择缸位</option>{preview.tanks.map(tank => <option key={tank.id} value={tank.id}>{tank.name}</option>)}
                  </select>
                </label>}
                {attempted && (!choice?.mode || !choice.subTankId || (choice.mode === "merge" && !choice.duplicateStockItemId)) && <p role="alert" className="text-xs text-destructive">请完成这条鱼的处理方式、缸位及对应补录记录核对。</p>}
              </>}
            </fieldset>;
          })}
        </div>
        <div className="space-y-3 border-t pt-3">
          <p className="text-sm leading-6">本次处理：恢复原鱼 {restoreCount} 条，合并重复记录 {mergeCount} 条，恢复移缸在途 {preview.items.length - normalItems.length} 条。{normalItems.length > restoreCount + mergeCount && ` 还有 ${normalItems.length - restoreCount - mergeCount} 条待选择处理方式。`}</p>
          <label htmlFor="shipment-cancel-confirmed" className="flex min-h-11 cursor-pointer items-start gap-2.5 py-2 text-sm leading-6"><Checkbox id="shipment-cancel-confirmed" checked={confirmed} disabled={saving} onCheckedChange={checked => { setConfirmed(checked === true); setError(""); }} className="mt-1" /><span>{normalItems.length ? "我已逐条核对实物已在所选缸位；关联的补录记录确实为同一条鱼。" : "我已核对这些鱼取消后应恢复移缸在途，后续需在目的缸签收。"}</span></label>
        </div>
      </>}
      <DialogFooter className="gap-2"><Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={() => { if (!busyRef.current) onClose(); }}>返回</Button>
        <Button type="button" className="min-h-11" disabled={loading || saving || !preview || !canUpdate} onClick={() => void submit()}>
          {saving ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RotateCcw className="size-4" aria-hidden="true" />}{saving ? "正在处理…" : "确认取消出库"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
