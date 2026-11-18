import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { Button } from "./ui/button";

type QueueItem = { orderId: string; orderNo: string; siteId: string; date: string; contactPerson: string; customerName: string; pendingCount: number; pendingAmount: number };
export function PaymentProofQueue({ siteId, onOpenOrder, refreshKey }: { siteId: string; onOpenOrder: (orderId: string) => void; refreshKey?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<{ items: QueueItem[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => { setOffset(0); setExpanded(false); }, [siteId]);
  useEffect(() => {
    const sequence = ++request.current; const controller = new AbortController(); const session = captureNewCustomerSession();
    setLoading(true); setError(""); setData(null);
    const current = () => !controller.signal.aborted && sequence === request.current && isNewCustomerSessionCurrent(session);
    void (async () => { try {
      const response = await fetch(`/api/orders/payment-proof/queue?siteId=${encodeURIComponent(siteId)}&offset=${offset}&limit=20`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
      const result = await response.json().catch(() => ({})); if (!current()) return;
      if (!response.ok || !result.ok || !Array.isArray(result.items) || !Number.isFinite(result.total)) throw new Error(result.error || "待核验付款加载失败。");
      setData(result);
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "加载失败，请重试。"); } finally { if (current()) setLoading(false); } })();
    return () => controller.abort();
  }, [siteId, offset, attempt, refreshKey]);
  return <section className="order-2 rounded-lg border bg-card" aria-label="待核验付款队列">
    <div className="flex flex-wrap items-center justify-between gap-2 p-3 sm:px-4"><Button type="button" variant="ghost" className="min-h-11 px-0" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><ChevronDown className={`size-4 ${expanded ? "rotate-180" : ""}`} />待核验付款 {data ? `· ${data.total} 单` : ""}</Button><Button type="button" variant="outline" className="min-h-11" disabled={loading} onClick={() => setAttempt(value => value + 1)} aria-label="刷新待核验付款"><RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} /></Button></div>
    {error && <p role="alert" className="px-4 pb-3 text-sm text-destructive">{error}</p>}
    {expanded && <div className="border-t p-3 sm:p-4">{loading ? <p role="status" className="text-sm text-muted-foreground">正在加载待核验付款…</p> : !data?.items.length ? <p className="text-sm text-muted-foreground">当前场地暂无待核验付款。</p> : <>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">包含已部分核销订单中的新凭证。打开订单财务详情查看图片并核验，勿将同一笔到账重复登记。</p>
      <ul className="divide-y rounded-md border">{data.items.map(item => <li key={item.orderId} className="flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><p className="break-words font-medium">{item.orderNo} · {item.customerName || "客户未关联"}</p><p className="mt-1 text-xs text-muted-foreground">负责人：{item.contactPerson || "未记录"} · {item.pendingCount} 笔 · 待核验 ¥{Number(item.pendingAmount).toFixed(2)}</p></div><Button type="button" className="min-h-11 shrink-0" onClick={() => onOpenOrder(item.orderId)}>查看并核验付款</Button></li>)}</ul>
      {data.total > 20 && <div className="mt-3 flex flex-wrap items-center justify-end gap-2 text-sm"><span>第 {Math.floor(offset / 20) + 1}/{Math.ceil(data.total / 20)} 页</span><Button type="button" variant="outline" className="min-h-11" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}><ChevronLeft className="size-4" />上一页</Button><Button type="button" variant="outline" className="min-h-11" disabled={offset + 20 >= data.total} onClick={() => setOffset(value => value + 20)}>下一页<ChevronRight className="size-4" /></Button></div>}
    </>}</div>}
  </section>;
}
