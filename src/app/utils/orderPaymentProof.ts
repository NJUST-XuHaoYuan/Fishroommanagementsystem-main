import type { Order, PaymentChannel, PaymentRecord } from "../store";
import { isPaymentVerified } from "../store";
import { authHeaders } from "./authSession";
import { normalizeNewCustomerEvidence, type NewCustomerEvidenceAttachment } from "./newCustomerEvidence";

export type PaymentProofClaim = {
  id: string; version: number; status: "pending" | "approved" | "rejected";
  amount: number; time: string; paymentMethodId: string; paymentMethodName?: string;
  purpose?: "order" | "shipping_fee"; shippingAmount?: number; matchingPaymentId?: string;
  channel: PaymentChannel; account: string; externalTransactionNo?: string; notes?: string;
  evidenceAttachments: NewCustomerEvidenceAttachment[]; submittedBy: string; submittedAt: string;
  reviewedBy?: string; reviewedAt?: string; rejectionReason?: string; paymentId?: string;
};
export type PaymentProofSummary = { amountDue: number; verifiedAmount: number; pendingProofAmount: number; creditAmount: number; status?: string };
export type PaymentProofDetail = {
  ok: true; orderId: string; claims: PaymentProofClaim[]; canSubmit: boolean; canReview: boolean;
  paymentMethods: { id: string; name: string; channel: PaymentChannel; account: string }[];
  eligiblePayments: PaymentRecord[]; summary: PaymentProofSummary; reviewToken: string;
  linkableProofPayments?: PaymentRecord[];
  receiptCandidates?: Pick<PaymentRecord, "id" | "type" | "amount" | "shippingAmount" | "channel" | "account">[];
  shippingSettlement?: import("./shippingSettlement").ShippingSettlementSummary;
};

export function orderPaymentProofSummary(order: Pick<Order, "payments" | "paymentClaims">, amountDue: number): PaymentProofSummary {
  const money = (value: number) => Math.round(Math.max(0, value) * 100) / 100;
  const verifiedAmount = money((order.payments ?? []).filter(isPaymentVerified).reduce((sum, payment) => sum + (payment.type === "refund" ? -1 : 1) * Number(payment.amount || 0), 0));
  const due = money(amountDue);
  const pendingProofAmount = money(Math.min(Math.max(0, due - verifiedAmount), (order.paymentClaims ?? []).filter(claim => claim.status === "pending" && claim.evidenceAttachments?.length > 0).reduce((sum, claim) => sum + Number(claim.amount || 0), 0)));
  return { amountDue: due, verifiedAmount, pendingProofAmount, creditAmount: money(due - verifiedAmount - pendingProofAmount) };
}

const endpoint = (id: string) => `/api/orders/payment-proof/evidence/${encodeURIComponent(id)}`;
async function checked(response: Response, fallback: string) {
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) throw new Error(result.error || fallback);
  return result;
}
export async function uploadPaymentEvidence(orderId: string, file: File, signal: AbortSignal, onProgress: (percent: number) => void): Promise<NewCustomerEvidenceAttachment> {
  onProgress(0);
  const response = await fetch(`/api/orders/payment-proof/evidence?orderId=${encodeURIComponent(orderId)}`, { method: "POST", headers: { ...authHeaders(), "Content-Type": file.type, "x-file-name": encodeURIComponent(file.name) }, body: file, signal });
  const result = await checked(response, "付款凭证上传失败，请重试。");
  const attachment = normalizeNewCustomerEvidence([result.attachment])[0];
  if (!attachment) throw new Error("服务器未返回有效的凭证，请重新上传。");
  onProgress(100); return attachment;
}
export async function fetchPaymentEvidence(id: string, signal: AbortSignal) {
  const response = await fetch(endpoint(id), { headers: authHeaders(), signal, cache: "no-store" });
  if (!response.ok) { const result = await response.json().catch(() => ({})); throw new Error(result.error || "付款凭证读取失败。"); }
  const blob = await response.blob();
  if (!["image/jpeg", "image/png", "image/webp"].includes(blob.type) || blob.size <= 0) throw new Error("付款凭证格式异常，请联系财务核对。");
  return blob;
}
export async function deletePaymentEvidence(id: string, signal: AbortSignal) {
  await checked(await fetch(endpoint(id), { method: "DELETE", headers: authHeaders(), signal }), "付款凭证删除失败。");
}
