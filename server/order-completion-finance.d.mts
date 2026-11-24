export type OrderCompletionFinancialReason = {
  code: "INVALID_FINANCIAL_AMOUNT" | "PAYMENT_PROOF_PENDING" | "RECEIPT_PENDING" | "REFUND_PENDING" | "PAYMENT_SHORTFALL" | "PAYMENT_OVERPAID";
  message: string;
  amount?: number;
  count?: number;
};
export type OrderCompletionFinancialCheck = {
  canComplete: boolean;
  amountDue: number;
  verifiedReceived: number;
  verifiedRefunded: number;
  verifiedNetReceived: number;
  pendingProofCount: number;
  pendingReceiptCount: number;
  pendingRefundCount: number;
  outstandingAmount: number;
  refundDueAmount: number;
  reasons: OrderCompletionFinancialReason[];
};
export function orderCompletionFinancialCheck(order?: {
  payments?: Array<{ amount?: number; type?: string; verificationStatus?: string }>;
  paymentClaims?: Array<{ status?: string }>;
}, amountDue?: number): OrderCompletionFinancialCheck;
