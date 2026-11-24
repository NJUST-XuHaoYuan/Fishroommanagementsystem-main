export type PaymentProofDraftField = "amount" | "time" | "paymentMethodId" | "attachments";
export type PaymentProofDraftIssue = { field: PaymentProofDraftField; message: string };

export function validatePaymentProofDraft(draft: {
  amount: string;
  time: string;
  paymentMethodId: string;
  attachments: readonly unknown[];
}, paymentMethodIds: readonly string[], allocationError = ""): PaymentProofDraftIssue[] {
  const issues: PaymentProofDraftIssue[] = [];
  const amount = Number(draft.amount);
  if (!draft.amount.trim() || !Number.isFinite(amount) || amount <= 0 || amount > 100000000 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
    issues.push({ field: "amount", message: "请填写大于 0、不超过 1 亿元、最多两位小数的本次付款金额。" });
  } else if (allocationError) {
    issues.push({ field: "amount", message: allocationError });
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(draft.time) || !Number.isFinite(Date.parse(draft.time))) {
    issues.push({ field: "time", message: "请填写有效的付款时间。" });
  }
  if (!draft.paymentMethodId || !paymentMethodIds.includes(draft.paymentMethodId)) {
    issues.push({ field: "paymentMethodId", message: "请选择本次付款方式与收款账户。" });
  }
  if (!draft.attachments.length) {
    issues.push({ field: "attachments", message: "请至少上传一张对应本次付款的图片凭证。" });
  }
  return issues;
}
