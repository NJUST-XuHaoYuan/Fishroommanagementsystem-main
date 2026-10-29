import { useEffect, useId, useState } from "react";
import { ChevronDown, History, RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { batchOrderIdentityKey } from "../utils/batchOrderDialog";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

export type StockStatusHistoryRecord = {
  id: string;
  stockItemId: string;
  previousStatus: string | null;
  status: string;
  changedAt: string;
  operator: string;
  operatorName?: string;
  source?: string;
  requestedBy?: string;
  requestedByName?: string;
};

const statusLabels: Record<string, string> = { healthy: "正常", feeding: "开口", sick: "疾病" };
const sourceLabels: Record<string, string> = {
  bio_details: "单只修改", batch_status: "批量修改", stock_mutation: "库存修改", stock_approval: "审批生效",
};

export function statusHistoryTime(value: string) {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未记录";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date);
}

export function StockStatusHistoryList({ records }: { records: StockStatusHistoryRecord[] }) {
  if (records.length === 0) return <p className="py-3 text-sm leading-6 text-muted-foreground">暂无状态变更记录。记录从功能上线后开始保存，之前的操作人和时间不作推测。</p>;
  return <ol className="divide-y" aria-label="鱼只状态变更记录">
    {records.map(record => <li key={record.id} className="flex flex-col gap-1.5 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="font-medium">{record.previousStatus == null ? "初始状态" : statusLabels[record.previousStatus] || "未知状态"}<span className="mx-2" aria-label="变更为">→</span>{statusLabels[record.status] || "未知状态"}</span>
        <time dateTime={record.changedAt} className="text-xs tabular-nums text-muted-foreground">{statusHistoryTime(record.changedAt)}</time>
      </div>
      <div className="break-words text-muted-foreground [overflow-wrap:anywhere]">
        操作人：{record.operatorName || record.operator || "未记录"}
        {record.operatorName && record.operator && record.operatorName !== record.operator && <span>（{record.operator}）</span>}
        {record.source && sourceLabels[record.source] && <span className="ml-2">· {sourceLabels[record.source]}</span>}
      </div>
      {record.requestedBy && <div className="break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">申请人：{record.requestedByName || record.requestedBy}{record.requestedByName && record.requestedByName !== record.requestedBy && <span>（{record.requestedBy}）</span>}</div>}
    </li>)}
  </ol>;
}

type HistoryPage = { stockItemId: string; records: StockStatusHistoryRecord[]; total: number; offset: number; limit: number };

export function StockStatusHistoryPanel({ stockItemId }: { stockItemId: string }) {
  const { state } = useStore();
  const identity = batchOrderIdentityKey(state.user);
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; loading: boolean; error: string; data: HistoryPage | null }>({ key: "", loading: false, error: "", data: null });
  const requestKey = JSON.stringify([stockItemId, identity, offset, attempt]);
  const current = result.key === requestKey ? result : { loading: expanded, error: "", data: null };

  useEffect(() => {
    if (!expanded || !identity || !stockItemId) return;
    const controller = new AbortController();
    setResult({ key: requestKey, loading: true, error: "", data: null });
    const query = new URLSearchParams({ stockItemId, offset: String(offset), limit: "20" });
    void fetch(`/api/stock/status-history?${query}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.ok !== true) throw new Error(response.status === 401 ? "登录已过期，请重新登录" : body.error || "状态记录加载失败，请重试");
        if (body.stockItemId !== stockItemId || !Array.isArray(body.records) || body.records.some((r: StockStatusHistoryRecord) => r.stockItemId !== stockItemId)) throw new Error("鱼只记录不匹配，请重新打开详情");
        if (!controller.signal.aborted) setResult({ key: requestKey, loading: false, error: "", data: body });
      })
      .catch(error => {
        if (!controller.signal.aborted) setResult({ key: requestKey, loading: false, error: error instanceof TypeError ? "网络连接失败，请检查网络后重试" : error.message || "状态记录加载失败", data: null });
      });
    return () => controller.abort();
  }, [expanded, identity, stockItemId, requestKey, offset]);

  if (!identity) return null;
  return <section className="border-t pt-3" aria-label="状态变更记录">
    <Button type="button" variant="ghost" className="min-h-11 w-full justify-between px-0 hover:bg-transparent" aria-expanded={expanded} aria-controls={panelId} onClick={() => { setOffset(0); setExpanded(value => !value); }}>
      <span className="flex items-center gap-2"><History className="size-4" aria-hidden="true" />状态变更记录</span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">{expanded ? "收起" : "查看操作人和时间"}<ChevronDown className={`size-4 transition-transform motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} aria-hidden="true" /></span>
    </Button>
    {expanded && <div id={panelId}>
      <p className="mb-1 text-xs leading-5 text-muted-foreground">自动记录正常、开口、疾病之间的变更；单只和批量操作均保留，记录不可手工修改。</p>
      {current.loading && <div role="status" className="space-y-2 py-3"><span className="sr-only">正在加载状态记录</span><Skeleton className="h-5 motion-reduce:animate-none" /><Skeleton className="h-5 w-2/3 motion-reduce:animate-none" /></div>}
      {current.error && <div role="alert" className="flex flex-wrap items-center gap-3 py-3 text-sm"><p>{current.error}</p><Button type="button" variant="outline" className="min-h-11" onClick={() => setAttempt(value => value + 1)}><RefreshCw className="size-4" aria-hidden="true" />重试</Button></div>}
      {current.data && <>
        <StockStatusHistoryList records={current.data.records} />
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-muted-foreground">
          <span>共 {current.data.total} 条 · 时间为北京时间</span>
          {current.data.total > 20 && <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>上一页</Button>
            <Button type="button" variant="outline" size="sm" className="min-h-11" disabled={offset + current.data.records.length >= current.data.total} onClick={() => setOffset(value => value + 20)}>下一页</Button>
          </div>}
        </div>
      </>}
    </div>}
  </section>;
}
