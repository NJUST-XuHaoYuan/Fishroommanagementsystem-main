import type { Order, PaymentRecord, Shipment } from "../store";
import { allocateShippingProof, registeredOrderCashSummary, shippingSettlementSummary } from "../../../server/shipping-settlement.mjs";

export type RegisteredOrderCashSummary = {
  recordedReceived: number; recordedRefunded: number; netRecorded: number; availableRefund: number;
  verifiedReceived: number; verifiedRefunded: number; pendingReceiptAmount: number; pendingProofAmount: number;
  pendingRefundAmount: number; pendingReceiptCount: number; pendingProofCount: number; pendingRefundCount: number;
  invalidRecordCount: number;
};
export function getRegisteredOrderCashSummary(order: Pick<Order, "payments" | "paymentClaims">): RegisteredOrderCashSummary {
  return registeredOrderCashSummary(order) as RegisteredOrderCashSummary;
}

export type ShippingSettlementStatus = "not_applicable" | "legacy" | "pending_fee" | "to_collect" | "to_refund" | "proof_pending" | "settled";
export type ShippingSettlementSummary = {
  enabled: boolean; timing: "before_shipping" | "after_shipping" | null; customerPaysShipping: boolean;
  estimatedFee: number; actualFee: number; pendingShipmentCount: number; finalized: boolean;
  shippingDue: number; goodsDue: number; paymentShippingReceived: number; recordedShippingReceived: number;
  verifiedShippingReceived: number; pendingProofShipping: number; pendingShipping: number;
  shippingRefunded: number; verifiedShippingRefunded: number; pendingRefundAmount: number;
  finalAmountDue: number; verifiedOrderReceived: number; registeredOrderReceived: number; registeredOrderRefunded: number; orderRefundableAmount: number;
  toCollect: number; toRefund: number; status: ShippingSettlementStatus; version?: string;
};

export function getShippingSettlementSummary(order: Order, shipments: Shipment[] = [], finalAmountDue?: number): ShippingSettlementSummary {
  return shippingSettlementSummary(order, shipments, finalAmountDue) as ShippingSettlementSummary;
}
export function allocatePaymentProofShipping(order: Order, shipments: Shipment[], amount: number, purpose: "order" | "shipping_fee" = "order", excludeClaimId = "") {
  return allocateShippingProof(order, shipments, amount, purpose, excludeClaimId) as { purpose: "order" | "shipping_fee"; shippingAmount: number; goodsAmount: number };
}
export function shippingSettlementFilterStatus(order: Order, shipments: Shipment[] = []): Exclude<ShippingSettlementStatus, "not_applicable" | "legacy"> | null {
  if (order.status === "cancelled") return null;
  const summary = getShippingSettlementSummary(order, shipments);
  return summary.enabled ? summary.status as Exclude<ShippingSettlementStatus, "not_applicable" | "legacy"> : null;
}
export function shippingSettlementStatusLabel(status: ShippingSettlementStatus | null): string {
  return ({ not_applicable: "无需向客户收运费", legacy: "原运费规则", pending_fee: "运费待确定", to_collect: "运费待收", to_refund: "运费待退", proof_pending: "运费凭证待核验", settled: "运费已结清" } as const)[status || "not_applicable"];
}

/** Refund only the difference; actual carrier cost is not the refund amount. */
export function shippingRefundDraftAmount(summary: Pick<ShippingSettlementSummary, "toRefund">): string {
  return Number.isFinite(summary.toRefund) && summary.toRefund > 0 ? String(Math.round(summary.toRefund * 100) / 100) : "";
}

/** Preview the exact split of an already recorded receipt without allocating it twice. */
export function paymentProofDraftAllocation(order: Order, shipments: Shipment[], amount: number, purpose: "order" | "shipping_fee", excludeClaimId: string, matchingReceipt?: Pick<PaymentRecord, "id" | "type" | "amount" | "shippingAmount"> | null) {
  if (matchingReceipt && (matchingReceipt.shippingAmount != null || matchingReceipt.type === "shipping_fee")) {
    const shippingAmount = matchingReceipt.type === "shipping_fee" ? Number(matchingReceipt.amount) : Number(matchingReceipt.shippingAmount || 0);
    return { purpose: matchingReceipt.type === "shipping_fee" ? "shipping_fee" as const : "order" as const, shippingAmount, goodsAmount: Math.round((amount - shippingAmount) * 100) / 100 };
  }
  const context = matchingReceipt ? { ...order, payments: (order.payments || []).filter(payment => payment.id !== matchingReceipt.id) } : order;
  return allocatePaymentProofShipping(context, shipments, amount, purpose, excludeClaimId);
}
