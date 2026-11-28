import { useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Check, ChevronRight, Package, Plus, Search, Trash2 } from "lucide-react";
import type { Product, PurchaseBatch } from "../store";
import { uid } from "../store";
import type { PurchaseBox, PurchaseProcurement, PurchaseBatchSaveMode } from "../utils/purchaseBatchTypes";
import { calculatePurchaseBatchCosting, normalizePurchaseProcurement } from "../../../server/purchase-batch-costing.mjs";
import { batchPurchaseTotal, emptyPurchaseProcurement, PURCHASE_FEE_LABELS, purchaseBasicError, purchaseLineFromProduct, purchaseLineLabel, purchaseLineStepError, purchasePackingProgress, removePurchaseLine } from "../utils/purchaseBatchDisplay";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { PurchaseCostAllocationSection } from "./PurchaseCostAllocationSection";
import { readAndCompressImage } from "../utils/imageUtils";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";

export type PurchaseBatchEditorSave = {
  batch: PurchaseBatch; procurement: PurchaseProcurement; mode: PurchaseBatchSaveMode; clientMutationId: string;
};

const money = (amount: number) => Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : "—";
const numericValue = (value: number) => Number.isFinite(value) ? value : "";
const readNumber = (value: string) => value.trim() ? Number(value) : NaN;

export function PurchaseBatchEditor({ batch, products, arrivalDateMax, arrivalDateUnavailable, onClose, onSave }: {
  batch: PurchaseBatch; products: Product[]; arrivalDateMax: string; arrivalDateUnavailable: boolean;
  onClose: () => void; onSave: (change: PurchaseBatchEditorSave) => Promise<void>;
}) {
  const [basic, setBasic] = useState(() => ({ ...batch, lossProof: [...(batch.lossProof || [])] }));
  const [procurement, setProcurement] = useState<PurchaseProcurement>(() => structuredClone(batch.procurement || emptyPurchaseProcurement()));
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState("");
  const [addingProduct, setAddingProduct] = useState(!batch.procurement?.lines.length);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [checked, setChecked] = useState(false);
  const [stale, setStale] = useState(false);
  const submitting = useRef(false);
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const initial = useRef(JSON.stringify([basic, procurement]));
  const confirmed = batch.procurement?.status === "confirmed";
  const legacy = Boolean(batch.id && !batch.procurement);
  const today = new Date().toLocaleDateString("en-CA");
  const dirty = JSON.stringify([basic, procurement]) !== initial.current;
  const packing = purchasePackingProgress(procurement.lines, procurement.boxes);
  const preview = useMemo(() => {
    try { return { allocation: calculatePurchaseBatchCosting(procurement), error: "" }; }
    catch (cause) { return { allocation: null, error: cause instanceof Error ? cause.message : "请核对采购与装箱资料。" }; }
  }, [procurement]);
  const filteredProducts = useMemo(() => products.filter(product => !product.archivedAt && [product.name, product.size, product.origin].join(" ").toLowerCase().includes(search.trim().toLowerCase())).slice(0, 40), [products, search]);

  const updateProcurement = (next: PurchaseProcurement) => { setProcurement(next); setChecked(false); setError(""); };
  const updateBox = (boxId: string, patch: Partial<PurchaseBox>) => updateProcurement({ ...procurement, boxes: procurement.boxes.map(box => box.id === boxId ? { ...box, ...patch } : box) });
  const close = () => {
    if (submitting.current || uploading) return;
    if (!dirty || window.confirm("当前修改尚未保存，确定关闭吗？")) onClose();
  };
  const next = () => {
    const basicError = purchaseBasicError(basic, today, arrivalDateMax);
    const lineError = purchaseLineStepError(procurement.lines);
    if (basicError || lineError) { setError(basicError || lineError); return; }
    if (step === 1) {
      // Fees are not entered until the next page; packing itself must already balance.
      try { calculatePurchaseBatchCosting({ ...procurement, fees: { internationalFreight: 0, documentFee: 0, domesticFreight: 0, miscFee: 0, importTax: 0 } }); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "请核对装箱数量与占比。"); return; }
    }
    setError(""); setStep(value => value + 1);
  };
  const save = async (mode: "draft" | "confirm") => {
    if (submitting.current || stale) return;
    const basicError = purchaseBasicError(basic, today, arrivalDateMax);
    if (basicError) { setError(basicError); return; }
    let normalized: PurchaseProcurement;
    try { normalized = normalizePurchaseProcurement(procurement, { confirmed: mode === "confirm" }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "请核对资料后重试。"); return; }
    if (mode === "confirm" && !checked) { setError("请先核对本次分摊结果。"); return; }
    const key = JSON.stringify([basic, normalized, mode]);
    if (attempt.current?.key !== key) attempt.current = { key, id: `batch-${uid()}-${uid()}` };
    submitting.current = true; setBusy(true); setError("");
    try { await onSave({ batch: basic, procurement: normalized, mode, clientMutationId: attempt.current.id }); }
    catch (cause) {
      const failure = cause as Error & { status?: number; code?: string };
      if (failure.status === 409 || /STALE|REVISION/.test(failure.code || "")) setStale(true);
      setError(failure.message || "保存失败，填写内容已保留，请重试。");
    } finally { submitting.current = false; setBusy(false); }
  };

  return <Dialog open onOpenChange={open => !open && close()}><DialogContent aria-describedby={undefined}
    className="flex max-h-[94dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-6xl sm:p-0"
    onOpenAutoFocus={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
    <DialogHeader className="shrink-0 border-b px-4 pb-4 pt-5 text-left sm:px-6">
      <DialogTitle className="pr-8">{confirmed ? "修改采购与分摊" : legacy ? "补齐采购与装箱资料" : batch.id ? "继续填写采购批次" : "新建采购批次"}</DialogTitle>
      <p className="text-sm text-muted-foreground">{batch.batchNo}</p>
      <ol className="mt-2 flex items-center gap-2 text-xs sm:gap-3 sm:text-sm" aria-label="填写进度">{["采购清单", "装箱", "费用分摊"].map((label, index) => <li key={label} className="flex items-center gap-2 sm:gap-3" aria-current={step === index ? "step" : undefined}>
        {index > 0 && <ChevronRight className="size-3 text-muted-foreground" aria-hidden="true" />}<span className={step === index ? "font-semibold text-foreground" : "text-muted-foreground"}>{index + 1} {label}</span>
      </li>)}</ol>
    </DialogHeader>
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6" key={step}>
      <fieldset disabled={busy || stale || uploading} className="min-w-0 space-y-5">
        {step === 0 && <>
          {(legacy || (batch.procurement?.status === "draft" && batchPurchaseTotal(batch) !== null)) && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-relaxed text-amber-900">原采购成本 {money(batchPurchaseTotal(batch) ?? 0)} 继续保留。填写并确认分摊后，才启用新的采购成本。</p>}
          <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label htmlFor="purchase-supplier">供应商 <span aria-hidden="true">*</span></Label><Input id="purchase-supplier" value={basic.supplier} placeholder="填写本批供应商" onChange={event => setBasic({ ...basic, supplier: event.target.value })} /></div>
            <div className="space-y-2"><Label htmlFor="purchase-date">到货日期 <span aria-hidden="true">*</span></Label><Input id="purchase-date" type="date" value={basic.arrivalDate} max={arrivalDateMax} disabled={arrivalDateUnavailable} onChange={event => setBasic({ ...basic, arrivalDate: event.target.value })} />{arrivalDateUnavailable && <p className="text-xs text-muted-foreground">最早入库日期加载后可修改日期。</p>}</div></div>
          <div><div className="mb-3 flex items-center justify-between gap-3"><h3 className="font-semibold">本批采购商品</h3><span className="text-sm text-muted-foreground">{procurement.lines.length} 行 · {procurement.lines.reduce((sum, line) => sum + (Number.isFinite(line.quantity) ? line.quantity : 0), 0)} 条</span></div>
            <div className="divide-y border-y">{procurement.lines.map((line, index) => <div key={line.id} className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_110px_140px_110px_36px] sm:items-end">
              <div className="min-w-0"><div className="flex items-center justify-between"><span className="text-sm font-medium">{index + 1}. {line.productName}</span><Button variant="ghost" size="sm" className="sm:hidden" aria-label={`删除采购行 ${index + 1}`} onClick={() => { if (!procurement.boxes.some(box => box.items.some(item => item.lineId === line.id)) || window.confirm("该采购行已装箱，删除会同时移除各箱中的这一行。确定删除吗？")) updateProcurement(removePurchaseLine(procurement, line.id)); }}><Trash2 className="size-4" /></Button></div><div className="mt-1 text-xs text-muted-foreground">{[line.size, line.origin].filter(Boolean).join(" · ") || "无规格信息"}</div></div>
              <div className="grid grid-cols-2 gap-3 sm:contents"><div className="space-y-1.5"><Label htmlFor={`qty-${line.id}`} className="text-xs">采购数量</Label><Input id={`qty-${line.id}`} type="number" inputMode="numeric" min="0" step="1" value={numericValue(line.quantity)} onChange={event => updateProcurement({ ...procurement, lines: procurement.lines.map(row => row.id === line.id ? { ...row, quantity: readNumber(event.target.value) } : row) })} /></div>
                <div className="space-y-1.5"><Label htmlFor={`price-${line.id}`} className="text-xs">采购单价（元）</Label><Input id={`price-${line.id}`} type="number" inputMode="decimal" min="0" step="0.01" value={numericValue(line.unitPrice)} onChange={event => updateProcurement({ ...procurement, lines: procurement.lines.map(row => row.id === line.id ? { ...row, unitPrice: readNumber(event.target.value) } : row) })} /></div></div>
              <div className="text-sm tabular-nums sm:pb-2"><span className="mr-2 text-xs text-muted-foreground sm:hidden">采购金额</span>{money(line.quantity * line.unitPrice)}</div>
              <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={`删除采购行 ${index + 1}`} onClick={() => { if (!procurement.boxes.some(box => box.items.some(item => item.lineId === line.id)) || window.confirm("该采购行已装箱，删除会同时移除各箱中的这一行。确定删除吗？")) updateProcurement(removePurchaseLine(procurement, line.id)); }}><Trash2 className="size-4" /></Button>
            </div>)}</div>
            {!procurement.lines.length && <p className="py-4 text-sm text-muted-foreground">先添加实际采购的商品，再填写数量和采购单价。</p>}
            {addingProduct ? <div className="mt-4 rounded-lg border"><div className="flex gap-2 border-b p-2"><div className="relative flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="查找采购商品" className="pl-9" placeholder="搜索商品、规格、产地" value={search} onChange={event => setSearch(event.target.value)} /></div><Button variant="ghost" onClick={() => setAddingProduct(false)}>收起</Button></div><div className="max-h-52 overflow-y-auto">{filteredProducts.map(product => <button type="button" key={product.id} className="flex min-h-11 w-full items-center justify-between gap-3 border-b px-3 py-2 text-left last:border-0 hover:bg-muted" onClick={() => { updateProcurement({ ...procurement, lines: [...procurement.lines, purchaseLineFromProduct(product, uid())] }); setAddingProduct(false); setSearch(""); }}><span className="min-w-0"><span className="text-sm font-medium">{product.name}</span><span className="ml-2 text-xs text-muted-foreground">{[product.size, product.origin].filter(Boolean).join(" · ")}</span></span><Plus className="size-4 shrink-0" /></button>)}{!filteredProducts.length && <p className="p-4 text-sm text-muted-foreground">没有匹配商品，请换个关键词。</p>}</div></div> : <Button variant="outline" className="mt-3" onClick={() => setAddingProduct(true)}><Plus className="size-4" />添加采购商品</Button>}
            <p className="mt-3 text-xs text-muted-foreground">同一商品采购单价不同时，请分行添加。采购单价与商品销售价分别记录。</p>
          </div>
          <details className="border-t pt-3"><summary className="cursor-pointer text-sm">备注与原批次资料</summary><div className="mt-3 space-y-4"><div className="space-y-2"><Label htmlFor="purchase-notes">备注</Label><Textarea id="purchase-notes" value={basic.notes} onChange={event => setBasic({ ...basic, notes: event.target.value })} rows={2} /></div>
            {batch.id && <div className="grid grid-cols-2 gap-3"><div className="space-y-2"><Label>入库数量</Label><Input value={basic.stockedCount} disabled /></div><div className="space-y-2"><Label htmlFor="purchase-loss-count">批次报损数量</Label><Input id="purchase-loss-count" type="number" min="0" step="1" value={numericValue(basic.lossCount)} onChange={event => setBasic({ ...basic, lossCount: readNumber(event.target.value) })} /></div></div>}
            {batch.id && <div className="space-y-2"><Label>原报损凭证</Label><div className="flex flex-wrap gap-2">{basic.lossProof.map((url, index) => <div key={`${url}:${index}`} className="flex flex-col gap-1"><MediaPreviewTrigger src={url} mediaType="image" title={`报损凭证 ${index + 1}`} className="size-16 overflow-hidden rounded border"><img src={url} alt={`报损凭证 ${index + 1}`} className="size-full object-cover" /></MediaPreviewTrigger><Button variant="ghost" size="sm" onClick={() => setBasic({ ...basic, lossProof: basic.lossProof.filter((_, i) => i !== index) })}>移除</Button></div>)}</div><label className="inline-flex cursor-pointer items-center gap-2 rounded border px-3 py-2 text-sm"><Plus className="size-4" />添加图片<input className="sr-only" type="file" accept="image/*" multiple onChange={async event => { const files = Array.from(event.target.files || []); event.target.value = ""; setUploading(true); try { const urls = await Promise.all(files.map(file => readAndCompressImage(file))); setBasic(current => ({ ...current, lossProof: [...current.lossProof, ...urls] })); } catch { setError("图片上传失败，请重试。"); } finally { setUploading(false); } }} /></label></div>}
          </div></details>
        </>}
        {step === 1 && <>
          <div><h3 className="font-semibold">这些鱼分别装在哪些箱？</h3><p className="mt-1 text-sm text-muted-foreground">总运费由各箱等额承担。每行填写该采购项在这一箱的合计重量占比。同一箱内同一采购项按数量平分。</p></div>
          <div className="divide-y border-y">{packing.map(row => { const line = procurement.lines.find(item => item.id === row.lineId)!; return <div key={row.lineId} className="flex flex-wrap justify-between gap-2 py-2 text-sm"><span>{purchaseLineLabel(line)}<span className="ml-2 text-xs text-muted-foreground">采购单价 {money(line.unitPrice)}</span></span><span className={row.remaining === 0 ? "text-teal-800" : row.remaining < 0 ? "text-red-700" : "text-muted-foreground"}>采购 {row.purchased} · 已装 {row.packed} · {row.remaining < 0 ? `多装 ${-row.remaining}` : `待装 ${row.remaining}`}</span></div>; })}</div>
          <div className="space-y-4">{procurement.boxes.map((box, boxIndex) => {
            const weight = box.items.reduce((sum, item) => sum + (Number.isFinite(item.weightPercent) ? item.weightPercent : 0), 0);
            const unused = procurement.lines.filter(line => !box.items.some(item => item.lineId === line.id));
            return <section key={box.id} className="rounded-lg border" aria-label={`装箱 ${boxIndex + 1}`}><div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 p-3"><Package className="size-4" /><Input aria-label={`第 ${boxIndex + 1} 箱箱号`} value={box.boxNo} className="w-28" onChange={event => updateBox(box.id, { boxNo: event.target.value })} /><span className={`ml-auto text-xs ${Math.abs(weight - 100) < .00001 ? "text-teal-800" : "text-amber-800"}`}>合计 {Number(weight.toFixed(2))}% / 100%</span><Button variant="ghost" size="icon" aria-label={`删除 ${box.boxNo}`} onClick={() => { if (!box.items.length || window.confirm(`确定删除${box.boxNo}的装箱记录吗？采购数量会保留。`)) updateProcurement({ ...procurement, boxes: procurement.boxes.filter(item => item.id !== box.id) }); }}><Trash2 className="size-4" /></Button></div>
              <div className="divide-y px-3">{box.items.map((item, itemIndex) => {
                const line = procurement.lines.find(row => row.id === item.lineId)!;
                const update = (patch: Partial<typeof item>) => updateBox(box.id, { items: box.items.map(row => row.id === item.id ? { ...row, ...patch } : row) });
                return <div key={item.id} className="grid gap-3 py-3 sm:grid-cols-[minmax(0,1fr)_110px_150px_150px_36px] sm:items-end"><div className="flex items-center justify-between gap-2 text-sm"><span>{purchaseLineLabel(line)}<span className="mt-1 block text-xs text-muted-foreground">采购单价 {money(line.unitPrice)}</span></span><Button variant="ghost" size="icon" className="sm:hidden" aria-label={`移出 ${box.boxNo} ${line.productName}`} onClick={() => updateBox(box.id, { items: box.items.filter(row => row.id !== item.id) })}><Trash2 className="size-4" /></Button></div>
                  <div className="grid grid-cols-2 gap-3 sm:contents"><div className="space-y-1.5"><Label htmlFor={`boxqty-${item.id}`} className="text-xs">本箱数量</Label><Input id={`boxqty-${item.id}`} aria-label={`${box.boxNo} 第 ${itemIndex + 1} 行数量`} type="number" inputMode="numeric" min="0" step="1" value={numericValue(item.quantity)} onChange={event => update({ quantity: readNumber(event.target.value) })} /></div><div className="space-y-1.5"><Label htmlFor={`boxweight-${item.id}`} className="text-xs">合计重量占比（%）</Label><Input id={`boxweight-${item.id}`} type="number" inputMode="decimal" min="0" max="100" step="0.01" value={numericValue(item.weightPercent)} onChange={event => update({ weightPercent: readNumber(event.target.value) })} /></div></div>
                  <span className="text-xs text-muted-foreground sm:pb-3">单条占比 {item.quantity > 0 && Number.isFinite(item.weightPercent) ? `${Number((item.weightPercent / item.quantity).toFixed(6))}%` : "—"}</span><Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label={`移出 ${box.boxNo} ${line.productName}`} onClick={() => updateBox(box.id, { items: box.items.filter(row => row.id !== item.id) })}><Trash2 className="size-4" /></Button>
                </div>;
              })}</div>
              {unused.length > 0 && <div className="p-3"><select aria-label={`向 ${box.boxNo} 添加采购商品`} className="h-10 w-full rounded-md border bg-background px-3 text-sm sm:max-w-lg" value="" onChange={event => { const lineId = event.target.value; if (!lineId) return; updateBox(box.id, { items: [...box.items, { id: uid(), lineId, quantity: 0, weightPercent: 0 }] }); }}><option value="">添加本箱商品…</option>{unused.map(line => <option key={line.id} value={line.id}>{purchaseLineLabel(line)} · 单价 {money(line.unitPrice)} · 待装 {packing.find(row => row.lineId === line.id)?.remaining ?? 0}</option>)}</select></div>}
            </section>;
          })}</div>
          <Button variant="outline" disabled={procurement.boxes.length >= 1000} onClick={() => { const used = new Set(procurement.boxes.map(box => box.boxNo)); let no = procurement.boxes.length + 1; while (used.has(`第 ${no} 箱`)) no++; updateProcurement({ ...procurement, boxes: [...procurement.boxes, { id: uid(), boxNo: `第 ${no} 箱`, items: [] }] }); }}><Plus className="size-4" />添加一箱</Button>
        </>}
        {step === 2 && <>
          <div><h3 className="font-semibold">录入费用，核对每种鱼的成本</h3><p className="mt-1 text-sm text-muted-foreground">费用全部以人民币登记。空缺的费用请填写 0。</p></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{PURCHASE_FEE_LABELS.map(([key, label, hint]) => <div key={key} className="space-y-1.5"><Label htmlFor={`fee-${key}`}>{label}（元）</Label><Input id={`fee-${key}`} type="number" inputMode="decimal" min="0" step="0.01" value={numericValue(procurement.fees[key])} onChange={event => updateProcurement({ ...procurement, fees: { ...procurement.fees, [key]: readNumber(event.target.value) } })} /><p className="text-xs text-muted-foreground">{hint}</p></div>)}</div>
          <div className="border-y py-4"><h4 className="text-sm font-medium">各采购行的税金权重</h4><p className="mt-1 text-xs text-muted-foreground">100% 按采购金额正常分摊；0% 不分摊进口税。这里是分摊权重，不是税率。</p><div className="mt-3 divide-y">{procurement.lines.map((line, index) => <div key={line.id} className="flex items-center justify-between gap-3 py-2"><Label htmlFor={`tax-${line.id}`} className="min-w-0 text-sm font-normal">{index + 1}. {purchaseLineLabel(line)}<span className="mt-1 block text-xs text-muted-foreground">采购金额 {money(line.quantity * line.unitPrice)}</span></Label><div className="flex shrink-0 items-center gap-2"><Input id={`tax-${line.id}`} className="w-24" type="number" inputMode="decimal" min="0" step="0.01" value={numericValue(line.taxWeightPercent)} onChange={event => updateProcurement({ ...procurement, lines: procurement.lines.map(row => row.id === line.id ? { ...row, taxWeightPercent: readNumber(event.target.value) } : row) })} /><span className="text-sm">%</span></div></div>)}</div></div>
          {preview.allocation ? <PurchaseCostAllocationSection procurement={procurement} allocation={preview.allocation} preview /> : <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">暂不能分摊：{preview.error}</p>}
          {confirmed && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">原已确认成本 {money(batchPurchaseTotal(batch) ?? 0)}。保存后将按本次资料重新分摊，替换正式采购成本。</p>}
          <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-current" checked={checked} onChange={event => setChecked(event.target.checked)} disabled={!preview.allocation} /><span>已核对采购数量、装箱和费用，确认启用本次成本分摊。</span></label>
        </>}
      </fieldset>
    </div>
    <div className="shrink-0 border-t bg-background px-4 py-3 pb-[calc(.75rem+env(safe-area-inset-bottom))] sm:px-6">
      {error && <div role="alert" className="mb-3 flex items-start gap-2 text-sm text-red-700"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{error}{stale && " 请关闭后重新打开，核对最新资料再修改。"}</span></div>}
      <div className="flex flex-wrap items-center justify-between gap-2"><div>{step > 0 && <Button variant="ghost" disabled={busy || uploading} onClick={() => { setStep(value => value - 1); setError(""); }}><ArrowLeft className="size-4" />上一步</Button>}</div><div className="flex gap-2">
        {!confirmed && <Button variant="outline" disabled={busy || stale || uploading} onClick={() => save("draft")}>{busy ? "保存中…" : "暂存草稿"}</Button>}
        {step < 2 ? <Button disabled={busy || stale || uploading} onClick={next}>下一步：{step === 0 ? "装箱" : "费用分摊"}<ChevronRight className="size-4" /></Button> : <Button disabled={busy || stale || uploading || !checked || !preview.allocation} onClick={() => save("confirm")}><Check className="size-4" />{busy ? "保存中…" : confirmed ? "保存并重新分摊" : "确认分摊并保存"}</Button>}
      </div></div>
    </div>
  </DialogContent></Dialog>;
}
