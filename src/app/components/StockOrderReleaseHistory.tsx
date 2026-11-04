import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { batchOrderIdentityKey } from "../utils/batchOrderDialog";
import { statusHistoryTime, type StockStatusHistoryRecord } from "./StockStatusHistoryPanel";
import { Button } from "./ui/button";

export type StockOrderReleaseRecord = StockStatusHistoryRecord & {
  eventType: "order_release";
  previousSold: true;
  sold: false;
  orderId: string;
  orderNo: string;
};

export type StockOrderReleaseEvent = { type: "order_release"; date: string; record: StockOrderReleaseRecord };

export function stockOrderReleaseTimelineEvents(records: StockOrderReleaseRecord[]): StockOrderReleaseEvent[] {
  return records.map(record => ({ type: "order_release", record,
    // Existing biological records use China wall-clock timestamps without an offset.
    date: statusHistoryTime(record.changedAt).replaceAll("/", "-").replace(" ", "T"),
  }));
}

export async function fetchStockOrderReleaseHistory(stockItemId: string, signal: AbortSignal, request: typeof fetch = fetch): Promise<StockOrderReleaseRecord[]> {
  const records = new Map<string, StockOrderReleaseRecord>();
  let offset = 0;
  while (!signal.aborted) {
    const query = new URLSearchParams({ stockItemId, eventType: "order_release", offset: String(offset), limit: "100" });
    const response = await request(`/api/stock/status-history?${query}`, { headers: authJsonHeaders(), signal, cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok !== true) throw new Error(response.status === 401 ? "登录已过期，请重新登录" : body.error || "订单取消记录加载失败，请重试");
    if (body.stockItemId !== stockItemId || body.offset !== offset || !Number.isInteger(body.total) || body.total < 0 || !Array.isArray(body.records)
      || body.records.some((record: StockOrderReleaseRecord) => !record || record.stockItemId !== stockItemId || typeof record.id !== "string" || !record.id
        || record.eventType !== "order_release" || record.previousSold !== true || record.sold !== false
        || typeof record.orderId !== "string" || !record.orderId || typeof record.orderNo !== "string"
        || typeof record.changedAt !== "string" || !Number.isFinite(Date.parse(record.changedAt)) || typeof record.operator !== "string")) {
      throw new Error("订单取消记录不匹配，请刷新后重试");
    }
    for (const record of body.records) records.set(record.id, record);
    offset += body.records.length;
    if (offset >= body.total) return [...records.values()];
    if (body.records.length === 0) throw new Error("订单取消记录未加载完整，请重试");
  }
  throw new DOMException("Aborted", "AbortError");
}

export function useStockOrderReleaseHistory(stockItemId: string | null | undefined, open: boolean) {
  const { state } = useStore();
  const identity = batchOrderIdentityKey(state.user);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([stockItemId, identity, open, revision]);
  const [snapshot, setSnapshot] = useState<{ key: string; loading: boolean; error: string; records: StockOrderReleaseRecord[] }>({ key: "", loading: false, error: "", records: [] });
  const active = Boolean(open && stockItemId && identity);
  const current = snapshot.key === key ? snapshot : { loading: active, error: "", records: [] };
  useEffect(() => {
    if (!active || !stockItemId) return;
    const controller = new AbortController();
    const session = captureNewCustomerSession();
    if (!isNewCustomerSessionCurrent(session, state.user)) {
      setSnapshot({ key, loading: false, error: "登录状态已变化，请重新登录后查看订单取消记录", records: [] });
      return;
    }
    setSnapshot({ key, loading: true, error: "", records: [] });
    void fetchStockOrderReleaseHistory(stockItemId, controller.signal).then(records => {
      if (!controller.signal.aborted && isNewCustomerSessionCurrent(session)) setSnapshot({ key, loading: false, error: "", records });
    }).catch(error => {
      if (!controller.signal.aborted && isNewCustomerSessionCurrent(session)) setSnapshot({ key, loading: false, error: error instanceof TypeError ? "网络连接失败，请重试加载订单取消记录" : error.message || "订单取消记录加载失败", records: [] });
    });
    return () => controller.abort();
  }, [active, stockItemId, key]);
  useEffect(() => {
    if (!active) return;
    const refresh = () => setRevision(value => value + 1);
    window.addEventListener("focus", refresh);
    window.addEventListener("fishroom-stock-transfers-changed", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("fishroom-stock-transfers-changed", refresh);
    };
  }, [active]);
  return { ...current, retry: () => setRevision(value => value + 1) };
}

export function StockOrderReleaseLoadState({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) {
  if (loading) return <p role="status" className="mb-3 text-xs leading-5 text-muted-foreground">正在加载订单取消记录…</p>;
  if (error) return <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-sm"><p>{error}</p><Button type="button" variant="outline" className="min-h-11" onClick={retry}><RefreshCw className="size-4" aria-hidden="true" />重新加载</Button></div>;
  return null;
}

export function StockOrderReleaseDetails({ record }: { record: StockOrderReleaseRecord }) {
  return <div className="space-y-1.5 text-sm [overflow-wrap:anywhere]">
    <p className="font-medium">订单取消：{record.orderNo || record.orderId}</p>
    <p>状态调整：已售 <span aria-label="变更为">→</span> 未售</p>
    <p className="text-xs text-muted-foreground">操作时间：<time dateTime={record.changedAt}>{statusHistoryTime(record.changedAt)}</time>（北京时间）</p>
    <p className="text-xs text-muted-foreground">操作员：{record.operatorName || record.operator || "未记录"}{record.operatorName && record.operator && record.operatorName !== record.operator && `（${record.operator}）`}</p>
    <p className="text-xs text-muted-foreground">该鱼已解除此订单占用；此记录不表示整单取消，也不表示已退款。</p>
  </div>;
}
