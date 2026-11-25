import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Check, Loader2, RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { getValidAuthSession } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { fetchOrderFollowups, ORDER_FOLLOWUP_MAX_LENGTH, OrderFollowupRequestError, orderFollowupMutation, saveOrderFollowup,
  type OrderFollowupDetail, type OrderFollowupMutation } from "../utils/orderFollowups";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

type LoadedState = { context: string; status: "loading" | "ready" | "error"; detail: OrderFollowupDetail | null; error: string };
type Feedback = { context: string; error: string; success: string };

export function OrderFollowupPanel({ orderId, siteId, onSaved, allowCreate = true }: { orderId: string; siteId: string; onSaved?: () => void; allowCreate?: boolean }) {
  const { state, activeSiteId } = useStore();
  const [, updateSession] = useState(0);
  const session = captureNewCustomerSession();
  const context = JSON.stringify([orderId, siteId, activeSiteId, state.user?.username, state.user?.role, state.user?.visibleSiteIds, state.user?.account, session?.key, allowCreate]);
  const validScope = Boolean(orderId && siteId && siteId !== "all" && (activeSiteId === "all" || activeSiteId === siteId));
  const authenticated = isNewCustomerSessionCurrent(session, state.user);
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  const [draft, setDraft] = useState({ context, content: "" });
  const [feedback, setFeedback] = useState<Feedback>({ context, error: "", success: "" });
  const [savingContext, setSavingContext] = useState<string | null>(null);
  const current = useRef({ context, user: state.user, validScope, authenticated }); current.current = { context, user: state.user, validScope, authenticated };
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  const mounted = useRef(false), sequence = useRef(0);
  const readController = useRef<AbortController | null>(null), writeController = useRef<AbortController | null>(null);
  const mutation = useRef<OrderFollowupMutation | null>(null);
  const inputId = useId(), hintId = useId();
  const shown = loaded?.context === context ? loaded : null;
  const detail = authenticated && validScope ? shown?.detail : null;
  const canCreate = Boolean(detail?.canCreate && allowCreate);
  const content = draft.context === context && authenticated && validScope ? draft.content : "";
  const saving = savingContext === context;
  const localFeedback = feedback.context === context ? feedback : { error: "", success: "" };

  useEffect(() => {
    const changed = () => updateSession(value => value + 1);
    const stored = getValidAuthSession();
    const timeout = stored ? window.setTimeout(changed, Math.max(1, Math.min(2147483647, stored.expiresAt - Date.now() + 10))) : undefined;
    window.addEventListener("storage", changed); window.addEventListener("focus", changed);
    return () => { if (timeout !== undefined) window.clearTimeout(timeout); window.removeEventListener("storage", changed); window.removeEventListener("focus", changed); };
  }, [session?.key]);

  const load = useCallback(async () => {
    if (!current.current.validScope || !current.current.authenticated || writeController.current) return;
    const expectedSession = captureNewCustomerSession();
    if (!isNewCustomerSessionCurrent(expectedSession, current.current.user)) return;
    const requestId = ++sequence.current, controller = new AbortController();
    readController.current?.abort(); readController.current = controller;
    const valid = () => mounted.current && !controller.signal.aborted && requestId === sequence.current
      && current.current.context === context && isNewCustomerSessionCurrent(expectedSession, current.current.user);
    setLoaded(previous => ({ context, status: "loading", detail: previous?.context === context ? previous.detail : null, error: "" }));
    try {
      const next = await fetchOrderFollowups(siteId, orderId, controller.signal);
      if (!valid()) return;
      setLoaded({ context, status: "ready", detail: next, error: "" });
      if (!next.canCreate || !allowCreate) { mutation.current = null; setDraft({ context, content: "" }); }
    } catch (cause) {
      if (!valid()) return;
      if (cause instanceof OrderFollowupRequestError && [401, 403].includes(cause.status)) { mutation.current = null; setDraft({ context, content: "" }); }
      setLoaded({ context, status: "error", detail: null, error: cause instanceof Error ? cause.message : "回访记录加载失败，请重试。" });
    } finally { if (readController.current === controller) readController.current = null; }
  }, [context, orderId, siteId, allowCreate]);

  useEffect(() => {
    mounted.current = true; mutation.current = null; writeController.current = null;
    setDraft({ context, content: "" }); setFeedback({ context, error: "", success: "" }); setSavingContext(null); setLoaded(null);
    void load();
    return () => { mounted.current = false; sequence.current += 1; readController.current?.abort(); writeController.current?.abort(); };
  }, [context, load]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (writeController.current || shown?.status !== "ready" || !canCreate || !validScope || !authenticated) return;
    const expectedSession = captureNewCustomerSession();
    if (!isNewCustomerSessionCurrent(expectedSession, current.current.user)) { updateSession(value => value + 1); return; }
    let pending: OrderFollowupMutation;
    try { pending = orderFollowupMutation(mutation.current, context, content); }
    catch (cause) { setFeedback({ context, error: cause instanceof Error ? cause.message : "请检查回访内容。", success: "" }); return; }
    mutation.current = pending;
    const controller = new AbortController(); writeController.current = controller;
    readController.current?.abort(); sequence.current += 1;
    setSavingContext(context); setFeedback({ context, error: "", success: "" });
    const valid = () => mounted.current && !controller.signal.aborted && current.current.context === context
      && isNewCustomerSessionCurrent(expectedSession, current.current.user);
    let saved = false;
    try {
      const next = await saveOrderFollowup({ siteId, orderId, content: pending.content, clientMutationId: pending.clientMutationId }, controller.signal);
      if (!valid()) return;
      saved = true; mutation.current = null; setDraft({ context, content: "" });
      setLoaded({ context, status: "ready", detail: next, error: "" });
      setFeedback({ context, error: "", success: next.replayed ? "本次回访已保存，无需重复登记。" : "回访记录已保存。" });
      await onSavedRef.current?.();
    } catch (cause) {
      if (!valid()) return;
      if (saved) { setFeedback({ context, error: "", success: "回访已保存，待办列表稍后刷新；无需重复登记。" }); return; }
      if (cause instanceof OrderFollowupRequestError && [401, 403].includes(cause.status)) {
        mutation.current = null; setDraft({ context, content: "" });
        setLoaded({ context, status: "error", detail: null, error: cause.message });
      } else {
        const message = cause instanceof Error ? cause.message : "暂时无法确认保存结果。";
        setFeedback({ context, error: `${message} 内容已保留，可重试；同一内容不会重复登记。`, success: "" });
      }
    } finally { if (writeController.current === controller) { writeController.current = null; if (mounted.current && current.current.context === context) setSavingContext(null); } }
  };

  if (!authenticated) return <p role="status" className="py-4 text-sm text-muted-foreground">登录状态已变化，请重新登录后查看回访记录。</p>;
  if (!validScope) return <p role="status" className="py-4 text-sm text-muted-foreground">请选择订单所在的具体场地后查看回访记录。</p>;
  return <section aria-label="订单回访记录" className="min-w-0 space-y-4 border-t pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">回访记录{detail ? <span className="ml-2 text-sm font-normal text-muted-foreground">{detail.total} 条</span> : null}</h3><Button type="button" variant="outline" className="min-h-11" disabled={saving || shown?.status === "loading"} onClick={() => void load()}><RefreshCw className="size-4" aria-hidden="true" />{shown?.status === "error" ? "重新加载" : "刷新"}</Button></div>
    {(!shown || shown.status === "loading") && <div role="status" aria-label="正在加载回访记录" className="space-y-2"><p className="text-sm text-muted-foreground">正在加载回访记录…</p><div className="h-14 rounded-md bg-muted motion-safe:animate-pulse" /></div>}
    {shown?.status === "error" && <p role="alert" className="text-sm text-destructive">{shown.error}</p>}
    {detail && <>
      {detail.records.length ? <ol className="divide-y">{detail.records.map(record => <li key={record.id} className="py-3 first:pt-0"><p className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{record.content}</p><p className="mt-2 text-xs text-muted-foreground">{record.operatorName || record.operator} · <time dateTime={`${record.createdAt}+08:00`}>{record.createdAt.replace("T", " ")}</time></p></li>)}</ol> : <p className="py-3 text-sm text-muted-foreground">尚无回访记录。{canCreate ? "联系客户后，可在下方记录反馈与后续事项。" : ""}</p>}
      {canCreate ? <form onSubmit={event => void submit(event)} className="space-y-2 border-t pt-4">
        <label htmlFor={inputId} className="text-sm font-medium">新增回访记录</label>
        <Textarea id={inputId} aria-describedby={hintId} rows={3} maxLength={ORDER_FOLLOWUP_MAX_LENGTH} disabled={saving || shown?.status !== "ready"} value={content} placeholder="记录联系客户的结果、客户反馈，以及后续需要处理的事项" onChange={event => { setDraft({ context, content: event.target.value }); setFeedback({ context, error: "", success: "" }); }} />
        <div className="flex flex-wrap items-center justify-between gap-2"><p id={hintId} className="text-xs text-muted-foreground">{content.length}/{ORDER_FOLLOWUP_MAX_LENGTH} 字 · 保存后保留记录人和时间</p><Button type="submit" className="min-h-11" disabled={saving || shown?.status !== "ready" || !content.trim()}>{saving && <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{saving ? "保存中…" : "保存回访记录"}</Button></div>
      </form> : <p className="text-xs text-muted-foreground">当前订单仅可查看回访记录。</p>}
    </>}
    {localFeedback.error && <p role="alert" className="text-sm text-destructive">{localFeedback.error}</p>}
    {localFeedback.success && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" aria-hidden="true" />{localFeedback.success}</p>}
  </section>;
}
