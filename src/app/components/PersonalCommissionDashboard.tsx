import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { Button } from "./ui/button";

export type PersonalCommissionSummary = {
  ok: true;
  month: string;
  policyEffectiveDate: "2026-10-01";
  personalAmount: number;
  newCustomerAmount: number;
  regularPersonalAmount: number;
};

export function currentCommissionMonth(now = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

/** Keep an explicit, self-only projection even if a future server adds fields. */
export function parsePersonalCommissionSummary(value: unknown): PersonalCommissionSummary {
  const data = value as Partial<PersonalCommissionSummary> | null;
  if (!data || data.ok !== true || !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month ?? "")
    || data.policyEffectiveDate !== "2026-10-01"
    || ![data.personalAmount, data.newCustomerAmount, data.regularPersonalAmount]
      .every((amount) => typeof amount === "number" && Number.isFinite(amount))) {
    throw new Error("提成数据不完整，请刷新重试");
  }
  return {
    ok: true,
    month: data.month!,
    policyEffectiveDate: data.policyEffectiveDate,
    personalAmount: data.personalAmount!,
    newCustomerAmount: data.newCustomerAmount!,
    regularPersonalAmount: data.regularPersonalAmount!,
  };
}

export function PersonalCommissionContent({
  data, loading, error, onRefresh,
}: {
  data: PersonalCommissionSummary | null;
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const month = data?.month ?? currentCommissionMonth();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h2>我的提成</h2>
          <p className="mt-1 text-sm text-muted-foreground">仅展示你本人本月的提成，按北京时间统计。</p>
        </div>
        <Button variant="outline" className="min-h-10 shrink-0" disabled={loading} onClick={onRefresh}>
          <RefreshCw aria-hidden="true" className="size-4" />刷新
        </Button>
      </header>
      <section className="rounded-lg border bg-card p-5 sm:p-6" aria-busy={loading} aria-label="本月个人提成">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
          <h3 className="text-base font-semibold">本月个人提成</h3>
          <span className="text-sm text-muted-foreground">{month.replace("-", " 年 ")} 月</span>
        </div>
        {loading ? (
          <div className="py-6" role="status">
            <div className="h-9 w-40 rounded bg-muted motion-safe:animate-pulse" />
            <p className="mt-3 text-sm text-muted-foreground">正在核对本月提成…</p>
          </div>
        ) : error ? (
          <div className="flex flex-wrap items-center justify-between gap-3 py-5" role="alert">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" className="min-h-10" onClick={onRefresh}>重试</Button>
          </div>
        ) : data ? (
          <div className="py-6" aria-live="polite">
            <p className="break-all text-3xl font-semibold tabular-nums">¥{data.personalAmount.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
            <p className="mt-3 text-sm text-muted-foreground">
              {data.personalAmount === 0 ? "本月个人提成合计为 0 元。" : "已计入本月核销的商品实收，以及本月核销退款的提成扣回。"}
            </p>
          </div>
        ) : null}
        <div className="border-t pt-4 text-sm leading-6 text-muted-foreground">
          <p>普通订单按商品实收的 0.2% 计个人提成；新客首单经管理员批准后按 5%，两者不叠加。</p>
          <p className="mt-2">仅计入 2026 年 10 月 1 日起新建的订单，旧订单不参与；按收退款的核销月份计入或扣回。</p>
        </div>
      </section>
    </div>
  );
}

export function PersonalCommissionDashboard() {
  const { state } = useStore();
  const [data, setData] = useState<PersonalCommissionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [month, setMonth] = useState(currentCommissionMonth);
  const username = state.user?.username;
  const role = state.user?.role;

  useEffect(() => {
    const checkMonth = () => setMonth(currentCommissionMonth());
    const timer = window.setInterval(checkMonth, 60_000);
    window.addEventListener("focus", checkMonth);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", checkMonth);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    setLoading(true);
    if (!username || role !== "staff") return () => controller.abort();
    void (async () => {
      try {
        // The server resolves identity and the current month. Never send a user or month selector.
        const response = await fetch("/api/commissions/me", { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
        const result = await response.json();
        if (!response.ok || result.ok !== true) throw new Error(result.error || "本月提成加载失败，请重试");
        const summary = parsePersonalCommissionSummary(result);
        if (summary.month !== currentCommissionMonth()) throw new Error("提成月份已更新，请刷新重试");
        if (!controller.signal.aborted) setData(summary);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "本月提成加载失败，请重试");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [username, role, month, refreshVersion]);

  if (!username || role !== "staff") return null;
  return <PersonalCommissionContent data={data} loading={loading} error={error} onRefresh={() => setRefreshVersion((value) => value + 1)} />;
}
