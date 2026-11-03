import { useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent, type NewCustomerSession } from "../utils/newCustomerEvidence";
import { newCustomerLinkReady, type NewCustomerChoice, type NewCustomerLinkChange } from "../utils/newCustomerLink";
import type { NewCustomerApprovalDetail } from "../utils/notificationCenter";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export type NewCustomerAssociationProps = {
  detail: NewCustomerApprovalDetail;
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  onLinked: (change: NewCustomerLinkChange, session: NewCustomerSession) => Promise<void>;
  onConflict: (change: NewCustomerLinkChange | null, session: NewCustomerSession) => Promise<void>;
};

/** Scoped to one order and session by the parent. This endpoint never edits amounts. */
export function NewCustomerAssociation({ detail, disabled, onBusyChange, onLinked, onConflict }: NewCustomerAssociationProps) {
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [query, setQuery] = useState("");
  const [searchRevision, setSearchRevision] = useState(0);
  const [choices, setChoices] = useState<NewCustomerChoice[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [customerId, setCustomerId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [wechat, setWechat] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const pending = useRef(false);
  const ownerSession = useRef(captureNewCustomerSession());
  const mutation = useRef<AbortController | null>(null);
  const current = (session: NewCustomerSession) => mounted.current && ownerSession.current?.key === session.key && isNewCustomerSessionCurrent(session);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; mutation.current?.abort(); }; }, []);

  useEffect(() => {
    if (!detail.canManageCustomer || mode !== "existing") return;
    const controller = new AbortController();
    const session = captureNewCustomerSession();
    setSearching(true); setSearchError(""); setCustomerId("");
    const timer = setTimeout(async () => {
      try {
        if (!session || !current(session)) throw new Error("登录状态已变化，请重新打开申请。");
        const response = await fetch(`/api/orders/new-customer/customers?orderId=${encodeURIComponent(detail.orderId)}&q=${encodeURIComponent(query.trim())}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (controller.signal.aborted || !current(session)) return;
        if (!response.ok || payload.ok === false) throw new Error(payload.error || "客户列表加载失败，请重试");
        setChoices(Array.isArray(payload.customers) ? payload.customers.filter((item: NewCustomerChoice) => item && typeof item.id === "string" && typeof item.name === "string") : []);
        setHasMore(payload.hasMore === true);
      } catch (cause) {
        if (!controller.signal.aborted && (!session || current(session))) { setChoices([]); setSearchError(cause instanceof Error ? cause.message : "客户列表加载失败"); }
      } finally { if (!controller.signal.aborted && mounted.current) setSearching(false); }
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [detail.orderId, detail.canManageCustomer, mode, query, searchRevision]);

  const ready = newCustomerLinkReady({ canManage: detail.canManageCustomer, canCreate: detail.canCreateCustomer, mode, customerId, name, processing: busy || disabled || (mode === "existing" && searching) });
  const link = async () => {
    if (pending.current || !ready) return;
    const session = captureNewCustomerSession();
    if (!session || !current(session)) { setError("登录状态已变化，请重新打开申请。"); return; }
    pending.current = true; setBusy(true); onBusyChange(true); setError("");
    const controller = new AbortController(); mutation.current = controller;
    const expectedCustomerId = detail.currentOrder.customerId || "";
    const expectedApprovalVersion = detail.approval?.version ?? 0;
    try {
      const response = await fetch("/api/orders/new-customer/customer", {
        method: "POST", headers: authJsonHeaders(), signal: controller.signal,
        body: JSON.stringify({ orderId: detail.orderId, expectedCustomerId, expectedApprovalVersion,
          ...(mode === "existing" ? { customerId } : { customer: { name: name.trim(), phone: phone.trim(), wechat: wechat.trim() } }),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!current(session) || controller.signal.aborted) return;
      if (response.status === 409) {
        await onConflict(payload.order?.id === detail.orderId && typeof payload.order.customerId === "string" ? { order: payload.order, expectedCustomerId, expectedApprovalVersion } : null, session);
        if (current(session)) setError(payload.error || "订单或审批状态已变化，请核对最新资料后重试。");
        return;
      }
      if (!response.ok || payload.ok === false) throw new Error(payload.error || "关联客户失败，请重试");
      if (payload.order?.id !== detail.orderId || !payload.order?.customerId || payload.customer?.id !== payload.order.customerId) throw new Error("关联结果与当前订单不匹配，请刷新核对。");
      await onLinked({ order: payload.order, customer: payload.customer, expectedCustomerId, expectedApprovalVersion }, session);
    } catch (cause) { if (current(session) && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "关联客户失败，请重试"); }
    finally { pending.current = false; if (mounted.current) { setBusy(false); onBusyChange(false); } }
  };

  if (!detail.canManageCustomer) return <p className="text-sm text-muted-foreground">{detail.customerBlockedReason || "请联系订单负责人或管理员创建并关联客户档案。"}</p>;
  return <section aria-label="关联客户档案" className="space-y-3 border-t pt-3" aria-busy={busy}>
    <div><h4 className="text-sm font-medium">先关联客户档案</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">先查找已有客户，避免重复建档。关联仅补充客户信息，不改变订单金额。</p></div>
    <div className="flex flex-wrap gap-2">
      <Button type="button" className="min-h-11" variant={mode === "existing" ? "default" : "outline"} aria-pressed={mode === "existing"} disabled={busy || disabled} onClick={() => setMode("existing")}>选择已有客户</Button>
      {detail.canCreateCustomer && <Button type="button" className="min-h-11" variant={mode === "create" ? "default" : "outline"} aria-pressed={mode === "create"} disabled={busy || disabled} onClick={() => setMode("create")}>新建客户并关联</Button>}
    </div>
    {mode === "existing" ? <div className="space-y-2">
      <label className="grid gap-1.5 text-sm">查找客户<Input className="min-h-11" placeholder="姓名、微信号、手机号或抖音号" value={query} disabled={busy || disabled} onChange={event => { setQuery(event.target.value); setCustomerId(""); }} /></label>
      {searching ? <p role="status" className="text-xs text-muted-foreground">正在查找客户…</p> : searchError ? <div role="alert" className="space-y-2 text-sm text-destructive"><p>{searchError}</p><Button type="button" variant="outline" className="min-h-11" onClick={() => setSearchRevision(value => value + 1)}>重试查找</Button></div> : <>
        <label className="grid gap-1.5 text-sm">选择客户<select className="min-h-11 w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm" value={customerId} disabled={busy || disabled} onChange={event => setCustomerId(event.target.value)}><option value="">{choices.length ? "请选择并核对客户" : "没有找到客户，请更换关键词或新建"}</option>{choices.map(customer => <option key={customer.id} value={customer.id}>{[customer.name, customer.wechat ? `微信 ${customer.wechat}` : "", customer.phone, !customer.wechat && !customer.phone ? `档案 ${customer.id.slice(-8)}` : ""].filter(Boolean).join(" · ")}</option>)}</select></label>
        {hasMore && <p className="text-xs text-muted-foreground">仅显示前 30 位，请输入更具体的关键词。</p>}
      </>}
    </div> : <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1.5 text-sm sm:col-span-2">客户姓名（必填）<Input className="min-h-11" maxLength={100} value={name} disabled={busy || disabled} onChange={event => setName(event.target.value)} /></label>
      <label className="grid gap-1.5 text-sm">微信号（选填）<Input className="min-h-11" maxLength={100} value={wechat} disabled={busy || disabled} onChange={event => setWechat(event.target.value)} /></label>
      <label className="grid gap-1.5 text-sm">手机号（选填）<Input className="min-h-11" type="tel" maxLength={50} value={phone} disabled={busy || disabled} onChange={event => setPhone(event.target.value)} /></label>
    </div>}
    {!detail.canCreateCustomer && <p className="text-xs text-muted-foreground">当前账号可关联已有客户；新增档案请联系有客户创建权限的人员。</p>}
    <Button type="button" className="min-h-11 w-full sm:w-auto" disabled={!ready} onClick={() => void link()}>{busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Search className="size-4" />}{busy ? "关联中…" : mode === "existing" ? "确认关联此客户" : "创建并关联客户"}</Button>
    {error && <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}
  </section>;
}
