import { paymentProofSummary } from "./payment-proof-rules.mjs";
import { verifiedPaymentTotals } from "./payment-utils.mjs";

export function verifiedNetPaymentAmount(payments = []) {
  const totals = verifiedPaymentTotals(payments);
  return Number((totals.received - totals.refunded).toFixed(2));
}

/** All sources may ship. Uncovered value is credit, not a fabricated receipt. */
export function shipmentPaymentGate(order = {}, amountDue = 0) {
  const summary = paymentProofSummary(order, amountDue);
  return { ...summary, outstandingAmount: summary.creditAmount, approvedAmount: 0, canShip: true };
}
