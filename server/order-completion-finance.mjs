import { isPaymentVerified } from "./payment-utils.mjs";

const list = value => Array.isArray(value) ? value : [];
const cents = value => {
  const amount = Number(value);
  return value !== null && value !== "" && typeof value !== "boolean" && Number.isFinite(amount) && amount >= 0 &&
    Number.isSafeInteger(Math.round(amount * 100)) && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6
    ? Math.round(amount * 100) : null;
};

/**
 * Financial completion is separate from shipping permission. amountDue is the
 * final receivable from the shared fee calculation, already including any
 * merchandise/claim adjustment. Refunds are subtracted from receipts only.
 */
export function orderCompletionFinancialCheck(order = {}, amountDue = 0) {
  const reasons = [];
  const due = cents(amountDue);
  let received = 0, refunded = 0, pendingReceiptCount = 0, pendingRefundCount = 0;
  let invalid = due === null;
  for (const payment of list(order.payments)) {
    const amount = cents(payment?.amount);
    if (amount === null) invalid = true;
    if (!isPaymentVerified(payment)) {
      if (payment?.type === "refund") pendingRefundCount += 1;
      else pendingReceiptCount += 1;
    } else if (amount !== null) {
      if (payment?.type === "refund") refunded += amount;
      else received += amount;
    }
  }
  const pendingProofCount = list(order.paymentClaims).filter(claim => claim?.status === "pending").length;
  const net = received - refunded;
  const difference = (due ?? 0) - net;
  const outstandingAmount = Math.max(0, difference) / 100;
  const refundDueAmount = Math.max(0, -difference) / 100;
  if (invalid) reasons.push({ code: "INVALID_FINANCIAL_AMOUNT", message: "订单或收退款金额异常，请财务核对后再完成订单" });
  if (pendingProofCount) reasons.push({ code: "PAYMENT_PROOF_PENDING", count: pendingProofCount, message: `还有 ${pendingProofCount} 笔付款凭证待财务核验` });
  if (pendingReceiptCount) reasons.push({ code: "RECEIPT_PENDING", count: pendingReceiptCount, message: `还有 ${pendingReceiptCount} 笔收款待财务核验` });
  if (pendingRefundCount) reasons.push({ code: "REFUND_PENDING", count: pendingRefundCount, message: `还有 ${pendingRefundCount} 笔退款待财务核验` });
  if (!invalid && difference > 0) reasons.push({ code: "PAYMENT_SHORTFALL", amount: outstandingAmount, message: `已核验净收款还差 ¥${outstandingAmount.toFixed(2)}，请收齐并核验后完成订单` });
  if (!invalid && difference < 0) reasons.push({ code: "PAYMENT_OVERPAID", amount: refundDueAmount, message: `尚有 ¥${refundDueAmount.toFixed(2)} 应退差额，请登记实际退款并核验后完成订单` });
  return {
    canComplete: reasons.length === 0,
    amountDue: due === null ? 0 : due / 100,
    verifiedReceived: received / 100,
    verifiedRefunded: refunded / 100,
    verifiedNetReceived: net / 100,
    pendingProofCount, pendingReceiptCount, pendingRefundCount,
    outstandingAmount, refundDueAmount, reasons,
  };
}
