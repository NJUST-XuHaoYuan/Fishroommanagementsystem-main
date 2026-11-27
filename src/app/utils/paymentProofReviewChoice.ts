import type { PaymentRecord } from "../store";
import type { PaymentProofClaim } from "./orderPaymentProof";

export function paymentProofReviewChoice(claim: PaymentProofClaim, payments: PaymentRecord[], selected = "") {
  const eligible = payments.filter(payment =>
    (!claim.matchingPaymentId || payment.id === claim.matchingPaymentId)
    && payment.type !== "refund"
    && Math.abs(Number(payment.amount) - Number(claim.amount)) < 0.005
    && payment.channel === claim.channel
    && payment.account === claim.account);
  // A previously linked receipt disappearing is a conflict, not permission to
  // create another receipt. Reload before deciding how this money is recorded.
  if (claim.matchingPaymentId && eligible.length === 0) return { eligible, mode: "unavailable" as const, value: "" };
  if (eligible.length === 0) return { eligible, mode: "new" as const, value: "new" };
  if (eligible.length === 1) return { eligible, mode: "existing" as const, value: eligible[0].id };
  return { eligible, mode: "choose" as const, value: eligible.some(payment => payment.id === selected) ? selected : "" };
}
