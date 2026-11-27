import type { PaymentRecord } from "../store";

export type CorrectablePayment = PaymentRecord & {
  canVoid?: boolean;
  canCorrect?: boolean;
  correctionMode?: "proof_resubmit" | "replace" | "void" | "blocked";
  correctionBlockReason?: string;
  correctionToken?: string;
};

export type PaymentCorrection = {
  id: string;
  action: "void" | "correct";
  mode?: "replace" | "retract";
  paymentId: string;
  reason: string;
  operator: string;
  operatedAt: string;
  originalPayment: PaymentRecord;
  replacementPayment?: PaymentRecord;
  affectedClaimIds: string[];
  reopenedFromStatus?: "completed";
};

export function paymentCorrectionAction(payment: CorrectablePayment) {
  if (payment.canVoid && payment.correctionMode === "void") return "void";
  if (payment.canCorrect && ["proof_resubmit", "replace"].includes(payment.correctionMode || "")) return "correct";
  return null;
}

export function paymentCorrectionNeedsReplacement(payment: CorrectablePayment, mode: "replace" | "retract") {
  return paymentCorrectionAction(payment) === "correct" && payment.correctionMode === "replace" && mode === "replace";
}
