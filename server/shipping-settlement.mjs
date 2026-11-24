// Browser-safe money and status rules shared by the order screen and API.
const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const positive = value => Math.max(0, money(value));
const verified = payment => payment?.verificationStatus == null || payment.verificationStatus === "" || payment.verificationStatus === "verified";
const validPayment = payment => payment?.verificationStatus !== "rejected";
const timingValues = new Set(["before_shipping", "after_shipping"]);
const activeStatuses = new Set(["outbound", "shipped", "delivered", "damaged"]);
const fail = (message, code = "SHIPPING_SETTLEMENT_INVALID", statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };

export function hasShippingSettlement(order = {}) {
  return timingValues.has(order.shippingSettlementTiming) && order.shippingFeeMode !== "collect" && order.shippingFeeMode !== "free" && !["线下", "线下自提"].includes(text(order.source));
}
export function isShippingRefund(payment = {}) {
  return payment.type === "refund" && (payment.refundCategory === "shipping_fee" || payment.statementOriginal?.refundCategory === "shipping_fee");
}
export function paymentShippingAmount(payment = {}) {
  if (isShippingRefund(payment) || payment.type === "shipping_fee") return positive(payment.amount);
  return Math.min(positive(payment.amount), positive(payment.shippingAmount));
}
function registeredCash(order, excludeClaimId = "") {
  const payments = list(order.payments).filter(validPayment);
  const linkedClaimIds = new Set(payments.map(payment => text(payment.paymentProofClaimId)).filter(Boolean));
  const linkedPaymentIds = new Set(payments.map(payment => text(payment.id)).filter(Boolean));
  const pending = list(order.paymentClaims).filter(claim => claim.status === "pending" && claim.id !== excludeClaimId &&
    !linkedClaimIds.has(text(claim.id)) && !linkedPaymentIds.has(text(claim.paymentId)) && !linkedPaymentIds.has(text(claim.matchingPaymentId)));
  return { payments, pending };
}

// Same damage adjustment as the final order receivable. Legacy damage records
// without an explicit amount use verified non-freight refunds as their value.
function damageReceivableAdjustment(order, shipments) {
  const related = list(shipments).filter(shipment => text(shipment.orderId) === text(order.id) && shipment.status === "damaged" && shipment.damageResolution === "refund");
  const explicit = related.reduce((sum, shipment) => sum + Number(shipment.damageRefundAmount ?? 0), 0);
  if (explicit > 0.005) return money(explicit);
  return related.some(shipment => shipment.damageRefundAmount == null)
    ? money(list(order.payments).filter(payment => payment.type === "refund" && !isShippingRefund(payment) && verified(payment)).reduce((sum, payment) => sum + Number(payment.amount ?? 0), 0)) : 0;
}

export function shippingSettlementSummary(order = {}, shipments = [], finalAmountDue) {
  const enabled = hasShippingSettlement(order);
  const customerPaysShipping = !["collect", "free"].includes(order.shippingFeeMode) && !["线下", "线下自提"].includes(text(order.source));
  const active = list(shipments).filter(shipment => text(shipment.orderId) === text(order.id) && activeStatuses.has(shipment.status));
  const express = active.filter(shipment => shipment.shipMethod !== "pickup");
  const known = shipment => Number.isFinite(Number(shipment.actualShippingFee)) && Number(shipment.actualShippingFee) >= 0 &&
    (Number(shipment.actualShippingFee) > 0 || Boolean(text(shipment.actualShippingFeeRecordedAt)));
  const pendingShipmentCount = express.filter(shipment => !known(shipment)).length;
  const actualFee = money(express.filter(known).reduce((sum, shipment) => sum + Number(shipment.actualShippingFee), 0));
  const shippedIds = new Set(active.flatMap(shipment => list(shipment.itemStockIds)).map(text));
  const remainingItems = list(order.items).filter(item => !item.inventoryRemovedAt && !shippedIds.has(text(item.stockItemId)));
  const finalized = active.length > 0 && remainingItems.length === 0 && pendingShipmentCount === 0;
  const estimatedFee = positive(order.shippingFee);
  const shippingDue = !customerPaysShipping || order.status === "cancelled" ? 0 : enabled && order.shippingSettlementTiming === "after_shipping" ? actualFee :
    enabled ? finalized ? actualFee : estimatedFee : active.length > 0 && pendingShipmentCount === 0 ? actualFee : estimatedFee;
  const goodsDue = positive(list(order.items).reduce((sum, item) => sum + Number(item.price || 0), 0) - Number(order.discount || 0) + Number(order.packagingFee || 0));
  const { payments, pending } = registeredCash(order);
  const receipts = payments.filter(payment => payment.type !== "refund");
  const refunds = payments.filter(payment => payment.type === "refund");
  const pendingProofShipping = money(pending.reduce((sum, claim) => sum + (claim.purpose === "shipping_fee" ? positive(claim.amount) : positive(claim.shippingAmount)), 0));
  const paymentShippingReceived = money(receipts.reduce((sum, payment) => sum + paymentShippingAmount(payment), 0));
  const verifiedShippingReceived = money(receipts.filter(verified).reduce((sum, payment) => sum + paymentShippingAmount(payment), 0));
  const recordedShippingReceived = money(paymentShippingReceived + pendingProofShipping);
  const shippingRefunded = money(refunds.reduce((sum, payment) => sum + paymentShippingAmount(payment), 0));
  const verifiedShippingRefunded = money(refunds.filter(verified).reduce((sum, payment) => sum + paymentShippingAmount(payment), 0));
  const pendingRefundAmount = positive(shippingRefunded - verifiedShippingRefunded);
  const pendingShipping = money(pendingProofShipping + paymentShippingReceived - verifiedShippingReceived);
  const toCollect = order.status === "cancelled" ? 0 : positive(shippingDue - recordedShippingReceived + shippingRefunded);
  const calculatedFinalAmountDue = money(list(order.items).reduce((sum, item) => sum + Number(item.price || 0), 0) - positive(order.discount) + positive(order.packagingFee) + shippingDue - damageReceivableAdjustment(order, shipments));
  const finalReceivable = finalAmountDue === undefined ? calculatedFinalAmountDue : Number(finalAmountDue);
  const verifiedOrderReceived = money(receipts.filter(verified).reduce((sum, payment) => sum + positive(payment.amount), 0));
  const registeredOrderRefunded = money(refunds.reduce((sum, payment) => sum + positive(payment.amount), 0));
  // Every registered refund reserves cash immediately, including ordinary
  // merchandise refunds which intentionally retain their original category.
  const orderRefundableAmount = [finalReceivable, verifiedOrderReceived, registeredOrderRefunded].every(Number.isFinite) && finalReceivable >= 0
    ? positive(verifiedOrderReceived - registeredOrderRefunded - finalReceivable) : 0;
  const toRefund = finalized && order.status !== "cancelled"
    ? Math.min(positive(verifiedShippingReceived - shippingRefunded - shippingDue), orderRefundableAmount) : 0;
  const status = !customerPaysShipping || order.status === "cancelled" ? "not_applicable" : !enabled ? "legacy" : toRefund > 0 ? "to_refund" :
    toCollect > 0 ? "to_collect" : pendingShipping > 0 || pendingRefundAmount > 0 ? "proof_pending" : !finalized ? "pending_fee" : "settled";
  return { enabled, timing: enabled ? order.shippingSettlementTiming : null, customerPaysShipping, estimatedFee, actualFee, pendingShipmentCount,
    finalized, shippingDue, goodsDue, paymentShippingReceived, recordedShippingReceived, verifiedShippingReceived, pendingProofShipping,
    pendingShipping, shippingRefunded, verifiedShippingRefunded, pendingRefundAmount, finalAmountDue: finalReceivable,
    verifiedOrderReceived, registeredOrderRefunded, orderRefundableAmount, toCollect, toRefund, status };
}

export function allocateShippingProof(order = {}, shipments = [], amount = 0, purpose = "order", excludeClaimId = "") {
  const summary = shippingSettlementSummary(order, shipments);
  const paid = positive(amount);
  if (!summary.enabled) return { purpose: "order", shippingAmount: 0, goodsAmount: paid };
  if (purpose === "shipping_fee") return { purpose, shippingAmount: paid, goodsAmount: 0 };
  const { payments, pending } = registeredCash(order, excludeClaimId);
  const paidGoods = payments.reduce((sum, payment) => sum + (payment.type === "refund"
    ? -(positive(payment.amount) - paymentShippingAmount(payment))
    : positive(payment.amount) - paymentShippingAmount(payment)), 0) +
    pending.reduce((sum, claim) => sum + (claim.purpose === "shipping_fee" ? 0 : positive(claim.amount) - positive(claim.shippingAmount)), 0);
  const goodsAmount = Math.min(paid, positive(summary.goodsDue - paidGoods));
  return { purpose: "order", shippingAmount: money(paid - goodsAmount), goodsAmount };
}

export function planShippingRefund(order, shipments, body, { now, account, createId, methodSnapshot = {}, finalAmountDue }) {
  const summary = shippingSettlementSummary(order, shipments, finalAmountDue);
  if (!summary.enabled || order.status === "cancelled") fail("当前订单不支持运费差额退款", "SHIPPING_REFUND_UNAVAILABLE");
  if (!summary.finalized) fail("请先完成全部商品出库并确认各发货单实际运费，再退还运费差额", "SHIPPING_REFUND_NOT_FINAL");
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) fail("退款金额必须为正数且最多两位小数", "SHIPPING_REFUND_AMOUNT", 400);
  if (amount - summary.toRefund > 0.005) fail(`当前可退运费差额为 ¥${summary.toRefund.toFixed(2)}，请核对收款核验及已有退款记录`, "SHIPPING_REFUND_EXCEEDS_AVAILABLE");
  const time = text(body.time || now);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time) || !Number.isFinite(Date.parse(time))) fail("请填写有效退款时间", "SHIPPING_REFUND_TIME", 400);
  const payment = { id: createId(), type: "refund", refundCategory: "shipping_fee", shippingAmount: money(amount), amount: money(amount), time,
    ...methodSnapshot, verificationStatus: "pending", recordSource: "order", recordedBy: account.username,
    notes: text(body.reason || body.notes).slice(0, 1000), proof: list(body.proof), refundOccurredAt: time,
    refundStage: "after_shipment", refundItems: [], refundShipmentId: "" };
  return { payment, summary, order: { ...order, payments: [...list(order.payments), payment] } };
}

export function validateShippingReceipt(order, shipments, amount, purpose = "order", excludeClaimId = "") {
  if (!hasShippingSettlement(order)) return null;
  if (!["order", "shipping_fee"].includes(purpose)) fail("请选择有效收款用途", "PAYMENT_PROOF_PURPOSE", 400);
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 100000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) fail("收款金额必须为正数且最多两位小数", "PAYMENT_PROOF_AMOUNT", 400);
  const context = excludeClaimId ? { ...order, paymentClaims: list(order.paymentClaims).filter(claim => claim.id !== excludeClaimId) } : order;
  const summary = shippingSettlementSummary(context, shipments);
  const allocation = allocateShippingProof(context, shipments, amount, purpose);
  if (allocation.shippingAmount - summary.toCollect > 0.005) fail("本次金额超过当前货款及运费待收，请核对已有收款和待核验凭证", "PAYMENT_PROOF_SHIPPING_OVERPAID");
  return { ...allocation, shippingDueAtSubmission: summary.shippingDue };
}


export function validateOrderRefundAllocation(order, amount) {
  if (!hasShippingSettlement(order)) return null;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || amount > 100000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) fail("退款金额必须为正数且最多两位小数", "ORDER_REFUND_AMOUNT", 400);
  const payments = list(order.payments).filter(validPayment);
  const receipts = payments.filter(payment => payment.type !== "refund" && verified(payment));
  const refunds = payments.filter(payment => payment.type === "refund");
  const shippingAvailable = positive(receipts.reduce((sum, payment) => sum + paymentShippingAmount(payment), 0) - refunds.reduce((sum, payment) => sum + paymentShippingAmount(payment), 0));
  const goodsAvailable = positive(receipts.reduce((sum, payment) => sum + positive(payment.amount) - paymentShippingAmount(payment), 0) - refunds.reduce((sum, payment) => sum + positive(payment.amount) - paymentShippingAmount(payment), 0));
  if (amount - goodsAvailable - shippingAvailable > 0.005) fail("退款金额超过已核验收款扣除已登记退款后的余额", "ORDER_REFUND_EXCEEDS_VERIFIED");
  const goodsAmount = Math.min(amount, goodsAvailable);
  return { shippingAmount: money(amount - goodsAmount), goodsAmount: money(goodsAmount) };
}
