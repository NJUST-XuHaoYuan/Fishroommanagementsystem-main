import { useId, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { authJsonHeaders } from "../utils/authSession";
import { parseLossPriceInput, type LossPricingSnapshot, type LossPricingUpdate } from "../utils/lossPricing";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function LossPriceEditor({ stockItemId, label, value, pricingSnapshot, canEdit, isPriceMissing, onSaved, onRefresh }: {
  stockItemId: string;
  label: string;
  value: number;
  pricingSnapshot?: LossPricingSnapshot;
  canEdit: boolean;
  isPriceMissing?: boolean;
  onSaved: (update: LossPricingUpdate) => void;
  onRefresh: () => Promise<void>;
}) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const baseline = useRef<LossPricingSnapshot | null>(null);
  const begin = () => {
    if (!pricingSnapshot) return;
    baseline.current = { ...pricingSnapshot };
    setDraft(isPriceMissing ? "" : value.toFixed(2)); setError(""); setConflict(false); setEditing(true);
  };
  const save = async () => {
    if (inFlight.current || !baseline.current) return;
    let basePrice: number;
    try { basePrice = parseLossPriceInput(draft); }
    catch (cause) { setError((cause as Error).message); return; }
    inFlight.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/stock/loss-price", {
        method: "POST", headers: authJsonHeaders(),
        body: JSON.stringify({ stockItemId, basePrice, expectedPricing: baseline.current }),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        setConflict(response.status === 409);
        throw new Error(result.error || "售价保存失败，请重试");
      }
      const update = result.stockPricingUpdate as LossPricingUpdate;
      if (update?.id !== stockItemId || typeof update.basePrice !== "number" || !Number.isFinite(update.basePrice)
        || update.basePrice <= 0 || update.priceMode !== "manual" || update.priceOverridden !== true) {
        setConflict(true);
        throw new Error("保存结果需要重新核对，请刷新当前明细");
      }
      onSaved(update); setEditing(false); setConflict(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络异常，请重试");
    } finally { inFlight.current = false; setBusy(false); }
  };
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    try { await onRefresh(); setEditing(false); setConflict(false); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "刷新失败，请重试"); }
    finally { inFlight.current = false; setBusy(false); }
  };
  if (!editing) return (
    <div className="flex flex-wrap items-center justify-between gap-2 md:justify-end">
      <span className="font-semibold tabular-nums">{isPriceMissing ? "未定价" : `¥${value.toFixed(2)}`}</span>
      {canEdit && pricingSnapshot && <Button type="button" variant="ghost" size="sm" className="min-h-10 px-2"
        aria-label={`修改${label}的售价`} onClick={begin}><Pencil className="size-3.5" aria-hidden="true" />修改售价</Button>}
    </div>
  );
  return (
    <form className="space-y-2 text-left" aria-label={`修改${label}的售价`} aria-busy={busy}
      onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor={inputId} className="text-xs font-medium">单鱼售价（元）</label>
      <Input id={inputId} type="text" inputMode="decimal" autoFocus className="h-10 min-w-0 tabular-nums"
        value={draft} disabled={busy} maxLength={18} aria-invalid={Boolean(error)} aria-describedby={error ? `${inputId}-error` : undefined}
        onChange={(event) => setDraft(event.target.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="min-h-10" disabled={busy || conflict}>{busy ? "处理中…" : "保存"}</Button>
        <Button type="button" variant="outline" size="sm" className="min-h-10" disabled={busy} onClick={() => setEditing(false)}>取消</Button>
      </div>
      {error && <p id={`${inputId}-error`} className="text-xs leading-5 text-destructive" role="alert">{error}</p>}
      {conflict && <Button type="button" variant="outline" size="sm" className="min-h-10" disabled={busy} onClick={() => void refresh()}>刷新当前明细</Button>}
    </form>
  );
}
