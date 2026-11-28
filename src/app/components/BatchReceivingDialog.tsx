import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronRight, ImagePlus, PackageCheck, RefreshCw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { createMaintenanceClientMutationId } from "../utils/maintenanceMutation";
import { nowDatetimeLocal } from "../utils/localDateTime";
import { matchesSite } from "../utils/sites";
import { sortBatchesNewestFirst } from "../utils/batchSorting";
import { useRecordMediaUpload } from "../utils/useRecordMediaUpload";
import { receiptEntries, receiptInteger, receiptSourceKey, validateReceiptDraft, type BatchReceivingResult, type BatchReceivingSnapshot, type BatchReceivingSource, type ReceiptDraftEntry } from "../utils/batchReceiving";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";
import "./batch-receiving.css";

export type BatchReceivingDialogProps = { initialBatchId?: string; initialSubTankId?: string; onClose: () => void; onSaved?: () => void; onEditBatch?: (batchId: string) => void };
type Stage = "batch" | "fish" | "details" | "confirm" | "result";
const initialMedia = () => ({ photos: [] as string[], videos: [] as string[] });
export function BatchReceivingDialog({ initialBatchId = "", initialSubTankId = "", onClose, onSaved, onEditBatch }: BatchReceivingDialogProps) {
  const { state, activeSiteId, setState } = useStore();
  const context = `${activeSiteId}:${state.user?.username}:${captureNewCustomerSession()?.key}`;
  const initialContext = useRef(context);
  const currentContext = useRef(context); currentContext.current = context;
  const alive = useRef(true), lock = useRef(false), readSeq = useRef(0);
  const [batchId, setBatchId] = useState(initialBatchId), [stage, setStage] = useState<Stage>(initialBatchId ? "fish" : "batch");
  const [snapshot, setSnapshot] = useState<BatchReceivingSnapshot | null>(null), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [search, setSearch] = useState(""), [selected, setSelected] = useState<string[]>([]), [drafts, setDrafts] = useState<Record<string, ReceiptDraftEntry>>({});
  const [date, setDate] = useState(nowDatetimeLocal().slice(0, 10)), [reason, setReason] = useState(""), [notes, setNotes] = useState("");
  const [media, setMedia] = useState(initialMedia), [tab, setTab] = useState<"pending" | "history">("pending"), [discard, setDiscard] = useState(false), [resultText, setResultText] = useState("");
  const ticket = useRef<{ fingerprint: string; body: object } | null>(null);
  const upload = useRecordMediaUpload(setMedia, snapshot?.permissions.canLoss === true);
  const busy = saving || upload.isUploading;
  const batches = useMemo(() => sortBatchesNewestFirst(state.batches.filter(batch => matchesSite(batch, activeSiteId))), [state.batches, activeSiteId]);
  const groups = useMemo(() => state.tankGroups.filter(group => matchesSite(group, activeSiteId)), [state.tankGroups, activeSiteId]);
  const batch = snapshot?.batch || batches.find(batch => batch.id === batchId);
  const sources = snapshot?.sources || [];
  const chosen = sources.filter(row => selected.includes(receiptSourceKey(row)));
  const entries = receiptEntries(chosen, drafts);
  const liveTotal = entries.reduce((sum, item) => sum + item.stockedQuantity, 0), lostTotal = entries.reduce((sum, item) => sum + item.lostQuantity, 0);
  const dirty = selected.length > 0 || media.photos.length > 0 || Boolean(reason.trim() || notes.trim());
  const freshEntry = (): ReceiptDraftEntry => ({ stocked: "", lost: "", groupId: groups.find(group => group.subTanks.some(sub => sub.id === initialSubTankId))?.id || "", subTankId: initialSubTankId });
  useEffect(() => { alive.current = true; return () => { alive.current = false; readSeq.current++; }; }, []);
  useEffect(() => { if (context !== initialContext.current) onClose(); }, [context]);
  const applyResult = (result: BatchReceivingResult, session: NonNullable<ReturnType<typeof captureNewCustomerSession>>) => {
    setState(current => {
      if (!isNewCustomerSessionCurrent(session, current.user)) return current;
      const nextBatch = result.batch, previous = nextBatch && current.batches.find(item => item.id === nextBatch.id);
      const incomingStock = result.stockItems || result.stock || [];
      const existingStockIds = new Set(current.stock.map(item => item.id));
      const existingLossIds = new Set(current.lossRecords.map(item => item.id));
      const existingBioIds = new Set(current.bioRecords.map(item => item.id));
      return { ...current,
        batches: nextBatch && (previous?.costingRevision || 0) <= (nextBatch.costingRevision || 0) && (previous?.receiving?.revision || 0) <= (nextBatch.receiving?.revision || 0)
          ? previous ? current.batches.map(item => item.id === nextBatch.id ? nextBatch : item) : [nextBatch, ...current.batches] : current.batches,
        stock: [...current.stock, ...incomingStock.filter(item => !existingStockIds.has(item.id))],
        lossRecords: [...current.lossRecords, ...(result.lossRecords || []).filter(item => !existingLossIds.has(item.id))],
        bioRecords: [...current.bioRecords, ...(result.bioRecords || []).filter(item => !existingBioIds.has(item.id))],
        operationLogs: result.operationLog && !current.operationLogs.some(log => log.id === result.operationLog!.id) ? [result.operationLog, ...current.operationLogs].slice(0, 1000) : current.operationLogs,
      };
    });
  };
  const refresh = async (id = batchId) => {
    if (!id) return null;
    if (activeSiteId === "all") { setError("请先选择具体场地，再办理接收入库。"); return null; }
    const session = captureNewCustomerSession(), captured = context, seq = ++readSeq.current;
    if (!session) { setError("登录已过期，请重新登录。"); return null; }
    const current = () => alive.current && captured === currentContext.current && seq === readSeq.current && isNewCustomerSessionCurrent(session);
    setLoading(true); setError("");
    try {
      const response = await fetch(`/api/batches/receiving?siteId=${encodeURIComponent(activeSiteId)}&batchId=${encodeURIComponent(id)}`, { headers: authJsonHeaders(), cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "采购清单加载失败，请重试。");
      if (!Array.isArray(payload.sources) || !Array.isArray(payload.receipts) || !payload.summary || !payload.permissions || !Number.isSafeInteger(payload.revision)) throw new Error("批次接收信息不完整，请刷新后重试。");
      if (current()) { setSnapshot(payload); applyResult(payload, session); return payload as BatchReceivingSnapshot; }
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "采购清单加载失败。"); }
    finally { if (current()) setLoading(false); }
    return null;
  };
  useEffect(() => { setSnapshot(null); if (batchId) void refresh(batchId); }, [batchId]);
  const chooseBatch = (id: string) => { if (busy) return; setBatchId(id); setStage("fish"); setSelected([]); setDrafts({}); setMedia(initialMedia()); setReason(""); setNotes(""); ticket.current = null; };
  const close = () => { if (busy) return; if (dirty && stage !== "result") setDiscard(true); else onClose(); };
  const location = (subId?: string) => { const group = groups.find(group => group.subTanks.some(sub => sub.id === subId)); return group ? `${group.name} / ${group.subTanks.find(sub => sub.id === subId)?.name}` : "未选择缸位"; };
  const selectRow = (row: BatchReceivingSource) => { const key = receiptSourceKey(row); setSelected(current => current.includes(key) ? current.filter(id => id !== key) : [...current, key]); setDrafts(current => ({ ...current, [key]: current[key] || freshEntry() })); };
  const updateDraft = (key: string, change: Partial<ReceiptDraftEntry>) => { setDrafts(current => ({ ...current, [key]: { ...(current[key] || freshEntry()), ...change } })); setError(""); };
  const goConfirm = () => {
    if (!snapshot) return;
    if (!date || date > nowDatetimeLocal().slice(0, 10) || batch && date < batch.arrivalDate) { setError("接收日期须在批次到货日期至今天之间。"); return; }
    const problem = validateReceiptDraft(chosen, drafts, media.photos, snapshot.permissions);
    if (problem) { setError(problem); return; }
    setError(""); setStage("confirm");
  };
  const save = async () => {
    if (busy || lock.current || !snapshot) return;
    const problem = validateReceiptDraft(chosen, drafts, media.photos, snapshot.permissions); if (problem) { setError(problem); setStage("details"); return; }
    const session = captureNewCustomerSession(), captured = context;
    if (!session) { setError("登录已过期，请重新登录。"); return; }
    const fields = { siteId: activeSiteId, batchId, date, entries, proofPhotos: media.photos, reason: reason.trim(), notes: notes.trim() };
    const fingerprint = JSON.stringify(fields);
    if (ticket.current?.fingerprint !== fingerprint) ticket.current = { fingerprint, body: { ...fields, expectedRevision: snapshot.revision, expectedCostingRevision: snapshot.costingRevision, clientMutationId: createMaintenanceClientMutationId() } };
    lock.current = true; setSaving(true); setError("");
    try {
      const response = await fetch("/api/batches/receive", { method: "POST", headers: authJsonHeaders(), body: JSON.stringify(ticket.current.body) });
      const payload: BatchReceivingResult = await response.json();
      if (!alive.current || currentContext.current !== captured || !isNewCustomerSessionCurrent(session)) return;
      if (!response.ok || !payload.ok) { if (response.status === 409) { ticket.current = null; await refresh(); setStage("details"); } throw new Error(payload.error || "保存失败，填写内容已保留。"); }
      applyResult(payload, session); ticket.current = null;
      setResultText(payload.pendingApproval ? payload.message || "接收申请已提交，审批通过后登记入库与到货死亡。" : `已入缸 ${liveTotal} 条${lostTotal ? `，已登记到货死亡 ${lostTotal} 条` : ""}。`);
      setSelected([]); setDrafts({}); setMedia(initialMedia()); setReason(""); setNotes(""); setStage("result"); await refresh(); onSaved?.(); toast.success(payload.pendingApproval ? "已提交接收申请" : "本次到货处理已保存");
    } catch (cause) { if (alive.current && currentContext.current === captured) setError(cause instanceof Error ? cause.message : "网络中断，请重试确认结果。重试不会重复入库。"); }
    finally { if (alive.current && currentContext.current === captured) { lock.current = false; setSaving(false); } }
  };
  const stepLabel = stage === "batch" ? "先选择已创建采购清单的批次" : stage === "fish" ? tab === "history" ? "查看接收记录" : "1 选择鱼只" : stage === "details" ? "2 入缸或到货死亡" : stage === "confirm" ? "3 确认接收" : "接收结果";
  return <><Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="batch-receiving-dialog" onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}><DialogHeader><DialogTitle>{batch ? `接收入库 · ${batch.batchNo}` : "从采购批次接收入库"}</DialogTitle><DialogDescription>{stepLabel}</DialogDescription></DialogHeader>
    <div className="br-body">{error && <p role="alert" className="br-error">{error}</p>}
      {stage === "batch" ? <><label className="br-search"><Search /><Input aria-label="搜索采购批次" placeholder="搜索批次号或供应商" value={search} onChange={event => setSearch(event.target.value)} /></label><p className="br-help">先在采购批次登记鱼的种类和数量，再从该批次接收入缸或登记到货死亡。</p><div className="br-choice-list">{batches.filter(item => `${item.batchNo} ${item.supplier}`.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item.id} onClick={() => chooseBatch(item.id)}><span><strong>{item.batchNo}</strong><small>{item.supplier || "未填写供应商"} · {item.arrivalDate}</small><small>{item.procurement?.status === "confirmed" ? `采购 ${item.procurement.lines.reduce((sum, line) => sum + line.quantity, 0)} 条` : item.procurement ? "采购清单待确认" : "需补齐采购清单"}</small></span><ChevronRight /></button>)}</div>{!batches.length && <p className="br-empty">还没有采购批次。请先到“库存管理 → 采购批次”创建采购清单。</p>}</> : stage === "result" ? <div className="br-success"><PackageCheck /><h3>本次接收已保存</h3><p>{resultText}</p>{snapshot && <p>该批次还有 <strong>{snapshot.summary.pendingQuantity ?? "—"}</strong> 条待处理。</p>}</div> : loading && !snapshot ? <p className="br-empty">正在读取批次清单和待处理数量…</p> : !snapshot ? <Button variant="outline" disabled={loading} onClick={() => void refresh()}><RefreshCw />重新读取采购清单</Button> : <>
        {stage === "fish" && <><div className="br-summary"><span>采购 <strong>{snapshot.summary.orderedQuantity}</strong></span><span>已入缸 <strong>{snapshot.summary.stockedQuantity}</strong></span><span>到货死亡 <strong>{snapshot.summary.lostQuantity}</strong></span><span>待处理 <strong>{snapshot.blockedReason ? "待核对" : snapshot.summary.pendingQuantity}</strong></span></div><div className="br-tabs"><button aria-pressed={tab === "pending"} onClick={() => setTab("pending")}>选择待处理鱼只</button><button aria-pressed={tab === "history"} onClick={() => setTab("history")}>接收记录 {snapshot.receipts.length}</button><Button variant="ghost" size="sm" aria-label="刷新待处理数量" disabled={loading || busy} onClick={() => void refresh()}><RefreshCw /></Button></div>{snapshot.blockedReason && <div className="br-warning"><p>{snapshot.blockedReason}</p>{onEditBatch && batch?.procurement?.status !== "confirmed" && <Button variant="outline" onClick={() => { onClose(); onEditBatch(batchId); }}>完善采购清单</Button>}</div>}{tab === "pending" ? <><p className="br-help">{snapshot.blockedReason ? "采购清单仅供查看；请先处理上方提示。" : "选择这次到货的鱼。未处理的数量留在批次中，可以下次继续接收。"}</p><div className="br-choice-list">{sources.map(row => <button key={receiptSourceKey(row)} disabled={row.pendingQuantity <= 0 || !!snapshot.blockedReason || (!snapshot.permissions.canStock && !snapshot.permissions.canLoss)} aria-pressed={selected.includes(receiptSourceKey(row))} onClick={() => selectRow(row)}><span><strong>{row.productName}</strong><small>{[row.size, row.origin, `箱 ${row.boxNo}`].filter(Boolean).join(" · ")}</small><small>采购 {row.orderedQuantity} · 已入缸 {row.stockedQuantity} · 到货死亡 {row.lostQuantity}</small></span><span className="br-choice-end"><strong>{snapshot.blockedReason ? "暂不可接收" : `待处理 ${row.pendingQuantity}`}</strong><span className="br-check">{selected.includes(receiptSourceKey(row)) && <Check />}</span></span></button>)}</div>{!sources.length && <p className="br-empty">这个批次尚没有可接收的采购明细，请先完善并确认采购清单。</p>}</> : <div className="br-history">{snapshot.receipts.length ? snapshot.receipts.slice().reverse().map(receipt => <article key={receipt.id}><div><strong>{receipt.date}</strong><span>{receipt.operator || receipt.createdBy || "—"}</span></div><p>入缸 {receipt.entries.reduce((sum, entry) => sum + entry.stockedQuantity, 0)} 条 · 到货死亡 {receipt.entries.reduce((sum, entry) => sum + entry.lostQuantity, 0)} 条</p>{receipt.entries.map((entry, i) => <p className="br-help" key={i}>{sources.find(row => row.boxId === entry.boxId && row.itemId === entry.itemId)?.productName || entry.productName || "采购鱼只"}：入缸 {entry.stockedQuantity}，到货死亡 {entry.lostQuantity}{entry.subTankId ? ` · ${location(entry.subTankId)}` : ""}</p>)}{receipt.reason && <p>原因：{receipt.reason}</p>}{receipt.notes && <p>{receipt.notes}</p>}<div className="br-photos">{(receipt.proofPhotos || []).map((url, i) => <MediaPreviewTrigger key={`${url}-${i}`} src={url} mediaType="image" title="到货死亡照片" ariaLabel={`预览到货死亡照片 ${i + 1}`}><img src={url} alt="到货死亡凭证" /></MediaPreviewTrigger>)}</div></article>) : <p className="br-empty">还没有接收记录，处理到货后会在这里留下记录。</p>}</div>}</>}
        {stage === "details" && <><label className="br-field"><span>接收日期</span><Input type="date" min={batch?.arrivalDate} max={nowDatetimeLocal().slice(0, 10)} value={date} onChange={event => setDate(event.target.value)} /></label><div className="br-entry-list">{chosen.map(row => { const key = receiptSourceKey(row), draft = drafts[key] || freshEntry(); return <section key={key}><header><strong>{row.productName}</strong><small>箱 {row.boxNo} · 待处理 {row.pendingQuantity} 条</small></header><div className="br-two"><label className="br-field"><span>本次入缸数量</span><Input type="number" min="0" max={row.pendingQuantity} inputMode="numeric" disabled={!snapshot.permissions.canStock} aria-label={`${row.productName}箱${row.boxNo}入缸数量`} value={draft.stocked} placeholder="0" onChange={event => updateDraft(key, { stocked: event.target.value })} /></label><label className="br-field"><span>到货死亡数量</span><Input type="number" min="0" max={row.pendingQuantity} inputMode="numeric" disabled={!snapshot.permissions.canLoss} aria-label={`${row.productName}箱${row.boxNo}到货死亡数量`} value={draft.lost} placeholder="0" onChange={event => updateDraft(key, { lost: event.target.value })} /></label></div>{(receiptInteger(draft.stocked) || 0) > 0 && <div className="br-two"><label className="br-field"><span>接收缸组</span><select aria-label={`${row.productName}接收缸组`} value={draft.groupId} onChange={event => { const next = groups.find(group => group.id === event.target.value); updateDraft(key, { groupId: event.target.value, subTankId: next?.subTanks.length === 1 ? next.subTanks[0].id : "" }); }}><option value="">请选择缸组</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label><label className="br-field"><span>接收子缸</span><select aria-label={`${row.productName}接收子缸`} disabled={!draft.groupId} value={draft.subTankId} onChange={event => updateDraft(key, { subTankId: event.target.value })}><option value="">请选择子缸</option>{groups.find(group => group.id === draft.groupId)?.subTanks.map(sub => <option key={sub.id} value={sub.id}>{sub.name}</option>)}</select></label></div>}<p className="br-help">本次未处理 {Math.max(0, row.pendingQuantity - (receiptInteger(draft.stocked) || 0) - (receiptInteger(draft.lost) || 0))} 条，仍留在待处理清单。</p></section>; })}</div>{lostTotal > 0 && <section className="br-loss-proof"><h3>到货死亡照片 <span className="text-destructive">必填</span></h3><p className="br-help">拍清楚本次死亡鱼只。原因可以后补，照片会随本次报损保存。</p><div className="br-photos">{media.photos.map((url, i) => <div key={`${url}-${i}`}><MediaPreviewTrigger src={url} mediaType="image" title="到货死亡照片" ariaLabel={`预览到货死亡照片 ${i + 1}`}><img src={url} alt={`凭证 ${i + 1}`} /></MediaPreviewTrigger><Button variant="ghost" size="icon" aria-label={`删除凭证 ${i + 1}`} disabled={busy} onClick={() => setMedia(current => ({ ...current, photos: current.photos.filter((_, index) => index !== i) }))}><Trash2 /></Button></div>)}</div><label className="br-upload"><ImagePlus />{upload.isUploading ? upload.uploadStatus || "正在上传…" : "上传死亡照片"}<input type="file" multiple accept="image/*" disabled={busy} onChange={event => { void upload.uploadImages(event.target.files); event.target.value = ""; }} /></label><label className="br-field"><span>死亡原因 <small>可之后补充</small></span><Textarea maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：到货时已死亡" /></label></section>}<label className="br-field"><span>本次接收备注 <small>选填</small></span><Textarea maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} placeholder="本次到货和入缸的补充说明" /></label></>}
        {stage === "confirm" && <><h3>确认本次接收</h3><p className="br-confirm-total">入缸 <strong>{liveTotal}</strong> 条 · 到货死亡 <strong>{lostTotal}</strong> 条</p><p className="br-help">接收日期：{date}</p><div className="br-confirm-list">{entries.map((entry, index) => { const row = chosen.find(row => row.boxId === entry.boxId && row.itemId === entry.itemId)!; return <div key={index}><strong>{row.productName} · 箱 {row.boxNo}</strong>{entry.stockedQuantity > 0 && <p>入缸 {entry.stockedQuantity} 条 → {location(entry.subTankId)}</p>}{entry.lostQuantity > 0 && <p>到货死亡 {entry.lostQuantity} 条</p>}</div>; })}</div>{lostTotal > 0 && <p className="br-help">已上传 {media.photos.length} 张死亡照片 · {reason || "死亡原因待补充"}</p>}<p className="br-help">保存后会扣减批次待处理数量。到货死亡的鱼不会进入可售库存。</p></>}
      </>}
    </div>
    <DialogFooter className="br-footer">{stage === "batch" ? <Button variant="outline" onClick={close}>取消</Button> : stage === "result" ? <><Button variant="outline" onClick={onClose}>完成</Button>{(snapshot?.summary.pendingQuantity || 0) > 0 && <Button onClick={() => { setStage("fish"); setTab("pending"); }}>继续处理本批次</Button>}</> : <><Button variant="outline" disabled={busy} onClick={() => { setError(""); if (stage === "confirm") setStage("details"); else if (stage === "details") setStage("fish"); else if (!initialBatchId) { setStage("batch"); setSearch(""); } else close(); }}><ArrowLeft />{stage === "fish" && initialBatchId ? "关闭" : "上一步"}</Button>{stage === "fish" && tab === "pending" && <Button disabled={loading || !snapshot || !!snapshot.blockedReason || !chosen.length || busy} onClick={() => { setError(""); setStage("details"); }}>下一步：填写数量<ChevronRight /></Button>}{stage === "details" && <Button disabled={busy} onClick={goConfirm}>下一步：确认接收<ChevronRight /></Button>}{stage === "confirm" && <Button disabled={busy} onClick={() => void save()}><Check />{saving ? "正在保存…" : (lostTotal ? liveTotal ? "确认入库及报损" : "确认到货死亡" : "确认入库")}</Button>}</>}</DialogFooter>
  </DialogContent></Dialog><Dialog open={discard} onOpenChange={setDiscard}><DialogContent><DialogHeader><DialogTitle>放弃本次填写？</DialogTitle><DialogDescription>本次还没有提交，关闭后需要重新填写。</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDiscard(false)}>继续填写</Button><Button onClick={onClose}>放弃并关闭</Button></DialogFooter></DialogContent></Dialog></>;
}
