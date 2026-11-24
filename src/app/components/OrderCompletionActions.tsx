import { useEffect, useId, useRef, useState } from "react";
import { CheckCircle2, ChevronRight, Circle, ListChecks, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "./ui/alert-dialog";

export type OrderCompletionTarget = "cashier" | "logistics";

export interface OrderCompletionCheck {
  id: string;
  label: string;
  complete: boolean;
  detail?: string;
  target?: OrderCompletionTarget;
}

export interface OrderCompletionActionsProps {
  checks: OrderCompletionCheck[];
  orderNo: string;
  amountDue: number;
  verifiedNetReceived: number;
  saving: boolean;
  onNavigate: (target: OrderCompletionTarget) => void;
  onComplete: () => Promise<boolean>;
}

const money = (amount: number) => Number.isFinite(amount)
  ? amount.toLocaleString("zh-CN", { style: "currency", currency: "CNY" })
  : "待核实";

export function OrderCompletionActions({
  checks, orderNo, amountDue, verifiedNetReceived, saving, onNavigate, onComplete,
}: OrderCompletionActionsProps) {
  const checklistTitleId = useId();
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const submitLock = useRef(false);
  const requestSequence = useRef(0);
  const currentOrderNo = useRef(orderNo);
  currentOrderNo.current = orderNo;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    requestSequence.current += 1;
    submitLock.current = false;
    setChecklistOpen(false);
    setConfirmOpen(false);
    setSubmitting(false);
    setError("");
  }, [orderNo]);

  const pending = checks.filter(check => !check.complete);
  const ready = checks.length > 0 && pending.length === 0;
  const busy = saving || submitting;

  const complete = async () => {
    if (!ready || busy || submitLock.current) return;
    const requestedOrderNo = orderNo;
    const sequence = ++requestSequence.current;
    const isCurrent = () => mounted.current && currentOrderNo.current === requestedOrderNo && requestSequence.current === sequence;
    submitLock.current = true;
    setSubmitting(true);
    setError("");
    try {
      const completed = await onComplete();
      if (!isCurrent()) return;
      if (completed) setConfirmOpen(false);
      else setError("订单尚未完成，请检查最新完成条件后重试。");
    } catch (failure) {
      if (isCurrent()) setError(failure instanceof Error ? failure.message : "完成订单失败，请稍后重试。");
    } finally {
      if (isCurrent()) {
        submitLock.current = false;
        setSubmitting(false);
      }
    }
  };

  return <div className="flex min-w-0 flex-wrap items-center justify-end gap-2" role="group" aria-label="订单完成操作">
    <Popover open={checklistOpen} onOpenChange={setChecklistOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="min-h-[44px]" disabled={busy}>
          <ListChecks className="size-4 shrink-0" aria-hidden="true" />
          完成条件 · {checks.length === 0 ? "待检查" : pending.length ? `${pending.length}项待办` : "全部满足"}
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" collisionPadding={12} role="dialog" aria-labelledby={checklistTitleId} className="w-[min(24rem,calc(100vw-1.5rem))] max-h-[min(70dvh,var(--radix-popover-content-available-height))] overflow-y-auto p-4">
        <h3 id={checklistTitleId} className="text-sm font-semibold">完成订单前检查</h3>
        {checks.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">暂未取得完成条件，请刷新订单后重试。</p> : <ul className="mt-2 divide-y">
          {checks.map(check => <li key={check.id} className="flex items-start gap-2.5 py-3">
            {check.complete
              ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-700" aria-hidden="true" />
              : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium"><span className="sr-only">{check.complete ? "已满足：" : "待处理："}</span>{check.label}</p>
              {check.detail && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">{check.detail}</p>}
              {!check.complete && check.target && <Button type="button" variant="ghost" size="sm" className="mt-1 min-h-[44px] px-0 text-sm" onClick={() => { setChecklistOpen(false); onNavigate(check.target!); }}>
                去{check.target === "cashier" ? "收银台" : "物流运输"}<ChevronRight className="size-4" aria-hidden="true" />
              </Button>}
            </div>
          </li>)}
        </ul>}
      </PopoverContent>
    </Popover>

    <AlertDialog open={confirmOpen} onOpenChange={next => {
      if (busy) return;
      setError("");
      if (next) setChecklistOpen(false);
      setConfirmOpen(next && ready);
    }}>
      <AlertDialogTrigger asChild>
        <Button type="button" className="min-h-[44px]" disabled={!ready || busy}>
          {busy ? <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />}
          {busy ? "完成中…" : "完成订单"}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent aria-busy={busy} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}>
        <AlertDialogHeader>
          <AlertDialogTitle>确认完成订单</AlertDialogTitle>
          <AlertDialogDescription>请核对订单及结算金额，确认后将订单标记为已完成。</AlertDialogDescription>
        </AlertDialogHeader>
        <dl className="space-y-3 border-y py-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">订单号</dt><dd className="break-all font-medium">{orderNo}</dd></div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">最终应收</dt><dd className="font-medium tabular-nums">{money(amountDue)}</dd></div>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><dt className="text-muted-foreground">已核验净收款</dt><dd className="font-medium tabular-nums">{money(verifiedNetReceived)}</dd></div>
        </dl>
        {!ready && <p role="alert" className="text-sm text-destructive">订单状态已变化，请返回检查尚未满足的完成条件。</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-[44px]" disabled={busy}>返回检查</AlertDialogCancel>
          <AlertDialogAction className="min-h-[44px]" disabled={!ready || busy} onClick={event => {
            event.preventDefault();
            void complete();
          }}>{busy ? "完成中…" : "确认完成订单"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
