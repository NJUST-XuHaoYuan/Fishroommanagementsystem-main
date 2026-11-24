import type { Order, PaymentRecord } from "../store";
import type { PaymentProofClaim } from "./orderPaymentProof";
import { getRegisteredOrderCashSummary } from "./shippingSettlement";

export type CashierEntry = {
  id: string;
  direction: "in" | "out";
  amount: number;
  time: string;
  label: string;
  method: string;
  account: string;
  status: "verified" | "pending" | "rejected" | "unmatched";
  statusLabel: string;
  recordedAmount: number;
  payment?: PaymentRecord;
  claim?: PaymentProofClaim;
};

const CHANNELS: Record<string, string> = { wechat: "微信", alipay: "支付宝", bank: "银行卡", cash: "现金", douyin: "抖音", xianyu: "闲鱼", weipaitang: "微拍堂" };
const money = (value: unknown) => Number.isFinite(Number(value)) ? Math.round(Math.max(0, Number(value)) * 100) / 100 : 0;

/** Link only by persisted IDs. Identical amounts are not evidence of one payment. */
export function orderCashierEntries(order: Pick<Order, "payments" | "paymentClaims">, privateClaims?: PaymentProofClaim[]): CashierEntry[] {
  const payments = order.payments ?? [];
  const claims = privateClaims ?? order.paymentClaims ?? [];
  const linkedClaims = new Set<string>();
  const entries: CashierEntry[] = payments.map(payment => {
    const linked = payment.type === "refund" ? [] : claims.filter(item =>
      item.paymentId === payment.id || item.matchingPaymentId === payment.id || payment.paymentProofClaimId === item.id);
    linked.forEach(claim => linkedClaims.add(claim.id));
    const claim = linked.find(item => item.status === "pending") || linked.find(item => item.status === "approved") || linked[0];
    const verified = payment.verificationStatus !== "pending";
    const out = payment.type === "refund";
    const statusLabel = out ? verified ? "出账已核验" : "出账待核验" : verified
      ? claim?.status === "pending" ? "已确认到账 · 凭证待核验" : claim?.status === "rejected" ? "已确认到账 · 凭证已驳回" : "已确认到账"
      : "到账待核验";
    return {
      id: `payment:${payment.id}`, direction: out ? "out" : "in", amount: money(payment.amount), time: payment.time,
      label: out ? payment.refundCategory === "shipping_fee" ? "运费退差额" : "订单退款" : payment.type === "shipping_fee" ? "运费收款" : payment.type === "deposit" ? "订金收款" : "订单收款",
      method: payment.paymentMethodName || CHANNELS[payment.channel || ""] || payment.channel || "未登记方式",
      account: payment.account || "", status: verified ? "verified" : "pending", statusLabel,
      recordedAmount: money(payment.amount), payment, claim,
    };
  });
  for (const claim of claims) {
    if (linkedClaims.has(claim.id)) continue;
    const rejected = claim.status === "rejected";
    const missingPayment = claim.status === "approved";
    entries.push({
      id: `claim:${claim.id}`, direction: "in", amount: money(claim.amount), time: claim.time,
      label: claim.purpose === "shipping_fee" ? "运费收款" : "订单收款",
      method: claim.paymentMethodName || CHANNELS[claim.channel] || claim.channel || "未登记方式", account: claim.account || "",
      status: rejected ? "rejected" : missingPayment ? "unmatched" : "pending",
      statusLabel: rejected ? "凭证已驳回 · 不计入收款" : missingPayment ? "核验记录待核对" : "凭证待核验",
      // Approved metadata alone never substitutes for its missing receipt.
      recordedAmount: rejected || missingPayment ? 0 : money(claim.amount), claim,
    });
  }
  return entries.sort((a, b) => {
    const timeA = Date.parse(a.time) || 0, timeB = Date.parse(b.time) || 0;
    return timeB - timeA || b.time.localeCompare(a.time) || a.id.localeCompare(b.id);
  });
}

export function orderCashierTotals(entries: CashierEntry[]) {
  const cash = getRegisteredOrderCashSummary({
    payments: entries.flatMap(entry => entry.payment ? [entry.payment] : []),
    paymentClaims: entries.flatMap(entry => entry.claim ? [entry.claim] : []),
  });
  return { received: cash.recordedReceived, refunded: cash.recordedRefunded, netRecorded: cash.netRecorded,
    confirmedReceived: cash.verifiedReceived, confirmedRefunded: cash.verifiedRefunded };
}
