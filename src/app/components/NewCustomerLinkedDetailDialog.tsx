import { useEffect, useRef, useState } from "react";
import { ArrowLeft, FileText, RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { batchOrderIdentityKey } from "../utils/batchOrderDialog";
import { ReadonlyOrderContent, type ReadonlyOrderDetail } from "./BatchOrderDialog";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Skeleton } from "./ui/skeleton";

export type NewCustomerLinkedTarget =
  | { kind: "order"; targetOrderId: string }
  | { kind: "customer"; customerId: string };

type CustomerDetails = {
  id: string; name: string; customerType: string; addedDate: string; phone: string;
  wechat: string; douyin: string; source: string; address: string; notes: string;
};
type CustomerOrder = { id: string; orderNo: string; date: string; statusLabel: string; siteName: string };
type LinkedDetail =
  | { kind: "order"; approvalOrderId: string; order: ReadonlyOrderDetail }
  | { kind: "customer"; approvalOrderId: string; customer: CustomerDetails; orders: CustomerOrder[] };

export function ApprovalCustomerContent({ customer, orders, onOpenOrder }: {
  customer: CustomerDetails; orders: CustomerOrder[]; onOpenOrder: (id: string) => void;
}) {
  const fields = [
    ["客户名称", customer.name], ["客户类型", customer.customerType === "B" ? "B端（批发）" : customer.customerType === "C" ? "C端（零售）" : ""],
    ["添加时间", customer.addedDate], ["来源", customer.source], ["手机号", customer.phone],
    ["微信号", customer.wechat], ["抖音号", customer.douyin], ["常用地址", customer.address],
  ];
  return <div className="space-y-5">
    <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
      {fields.map(([label, value]) => <div key={label} className="min-w-0">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="mt-1 break-words text-sm [overflow-wrap:anywhere]">{value || "未记录"}</dd>
      </div>)}
    </dl>
    <div className="border-t pt-4 text-sm">
      <h3 className="font-semibold">客户备注</h3>
      <p className="mt-2 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{customer.notes || "未记录"}</p>
    </div>
    <section className="border-t pt-4" aria-label="客户历史订单">
      <h3 className="text-sm font-semibold">客户历史订单（{orders.length} 笔）</h3>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">包含本次申请及已取消订单，仅显示当前账号有权查看的记录。</p>
      {orders.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">暂无可查看的订单。</p> : <ul className="mt-2 divide-y">
        {orders.map(order => <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <Button type="button" variant="link" className="min-h-11 max-w-full whitespace-normal px-0 text-left" onClick={() => onOpenOrder(order.id)}>
            <FileText className="size-4 shrink-0" aria-hidden="true" /><span className="break-all">{order.orderNo || order.id}</span>
          </Button>
          <span className="text-xs text-muted-foreground">{[order.date, order.siteName, order.statusLabel].filter(Boolean).join(" · ")}</span>
        </li>)}
      </ul>}
    </section>
  </div>;
}

export function NewCustomerLinkedDetailDialog({ orderId, target, onClose }: {
  orderId: string; target: NewCustomerLinkedTarget; onClose: () => void;
}) {
  const { state } = useStore();
  const identityKey = batchOrderIdentityKey(state.user);
  const openingIdentity = useRef(identityKey);
  const currentIdentity = useRef(identityKey);
  currentIdentity.current = identityKey;
  const contextCurrent = Boolean(identityKey && openingIdentity.current === identityKey);
  const openingFocus = useRef(typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [selected, setSelected] = useState(target);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ loading: boolean; error: string; data: LinkedDetail | null }>({ loading: true, error: "", data: null });
  const selectionKey = JSON.stringify(selected);

  useEffect(() => {
    if (!contextCurrent) { closeRef.current(); return; }
    const controller = new AbortController();
    setResult({ loading: true, error: "", data: null });
    const query = new URLSearchParams({ orderId, kind: selected.kind });
    if (selected.kind === "order") query.set("targetOrderId", selected.targetOrderId);
    void fetch(`/api/orders/new-customer/linked-detail?${query}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) throw new Error(response.status === 401 ? "登录已过期，请重新登录" : body.error || "关联资料加载失败，请重试");
        if (body.approvalOrderId !== orderId || body.kind !== selected.kind ||
          (selected.kind === "order" ? body.order?.id !== selected.targetOrderId : body.customer?.id !== selected.customerId)) {
          throw new Error("关联资料已变化或不匹配，请关闭后重新打开审核");
        }
        if (!controller.signal.aborted) setResult({ loading: false, error: "", data: body });
      })
      .catch(error => {
        if (!controller.signal.aborted) setResult({ loading: false, error: error instanceof TypeError ? "网络连接失败，请检查网络后重试" : error.message || "关联资料加载失败", data: null });
      });
    return () => controller.abort();
  }, [orderId, selectionKey, contextCurrent, attempt]);

  if (!contextCurrent) return null;
  const data = result.data;
  const title = selected.kind === "order" ? `订单详情${data?.kind === "order" ? ` · ${data.order.orderNo || data.order.id}` : ""}`
    : `客户信息${data?.kind === "customer" && data.customer.name ? ` · ${data.customer.name}` : ""}`;
  return <Dialog open onOpenChange={open => { if (!open) closeRef.current(); }}>
    <DialogContent className="flex max-h-[92dvh] flex-col gap-0 overflow-hidden p-0 shadow-none sm:max-w-4xl sm:p-0 [&>button]:size-11"
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (openingFocus.current?.isConnected && openingIdentity.current === currentIdentity.current) openingFocus.current.focus({ preventScroll: true });
      }}>
      <DialogHeader className="shrink-0 border-b p-4 pr-16 text-left sm:p-6 sm:pr-16">
        <DialogTitle className="break-words leading-snug [overflow-wrap:anywhere]">{title}</DialogTitle>
        <DialogDescription>只读核对资料，关闭后继续新客审核，已填写的审批说明会保留。</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
        {target.kind === "customer" && selected.kind === "order" && <Button type="button" variant="outline" className="mb-4 min-h-11" onClick={() => { setResult({ loading: true, error: "", data: null }); setSelected(target); }}>
          <ArrowLeft className="size-4" aria-hidden="true" />返回客户信息
        </Button>}
        {result.loading && <div role="status" className="space-y-4"><span className="sr-only">正在加载关联资料</span><Skeleton className="h-8 motion-reduce:animate-none" /><Skeleton className="h-32 motion-reduce:animate-none" /></div>}
        {result.error && <div role="alert" className="space-y-3 py-3 text-sm"><p>{result.error}</p><Button type="button" variant="outline" className="min-h-11" onClick={() => setAttempt(value => value + 1)}><RefreshCw className="size-4" aria-hidden="true" />重新加载</Button></div>}
        {data?.kind === "order" && <ReadonlyOrderContent order={data.order} />}
        {data?.kind === "customer" && <ApprovalCustomerContent customer={data.customer} orders={data.orders} onOpenOrder={targetOrderId => {
          setResult({ loading: true, error: "", data: null }); setSelected({ kind: "order", targetOrderId });
        }} />}
      </div>
      <DialogFooter className="shrink-0 border-t p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-6">
        <Button type="button" variant="outline" className="min-h-11 w-full sm:w-auto" onClick={() => closeRef.current()}>返回新客审核</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
