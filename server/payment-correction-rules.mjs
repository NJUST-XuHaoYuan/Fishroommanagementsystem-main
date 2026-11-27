import { createHash } from 'node:crypto';
import { isPaymentVerified, resolvePaymentMethodSnapshot } from './payment-utils.mjs';
import { cashierMethodAllowedForOrder, usesOrderCashier } from './order-cashier-rules.mjs';
import { registeredOrderCashSummary, paymentShippingAmount, hasShippingSettlement, validateOrderRefundAllocation, validateShippingReceipt } from './shipping-settlement.mjs';
import { orderCompletionFinancialCheck } from './order-completion-finance.mjs';
const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? '').trim();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, code = 'PAYMENT_CORRECTION_INVALID', statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };
const linkedClaims = (order, payment) => list(order.paymentClaims).filter(claim => claim.status !== 'rejected' &&
  (text(claim.paymentId) === text(payment.id) || text(claim.matchingPaymentId) === text(payment.id) || text(payment.paymentProofClaimId) && text(claim.id) === text(payment.paymentProofClaimId)));
export function paymentCorrectionToken(order, amountDue) {
  return hash({ order, amountDue });
}
export function paymentCorrectionCapabilities(order, payment, amountDue) {
  const blocked = payment.statementId || payment.recordSource === 'statement' || payment.recordSource === 'platform';
  const verified = isPaymentVerified(payment);
  return { canVoid: !blocked && !verified, canCorrect: !blocked && verified,
    correctionMode: blocked ? 'blocked' : verified ? linkedClaims(order, payment).length ? 'proof_resubmit' : 'replace' : 'void',
    correctionBlockReason: blocked ? '账单或平台流水请先通过对账入口解除关联，不能在此改写' : '',
    correctionToken: paymentCorrectionToken(order, amountDue) };
}
export function assertPaymentCorrectionsUnchanged(before, after) {
  if (JSON.stringify(before?.paymentCorrections ?? []) !== JSON.stringify(after?.paymentCorrections ?? []))
    fail('资金更正记录由系统留存，只能通过撤销或更正入口追加', 'PAYMENT_CORRECTION_SERVER_OWNED');
}
/** All snapshots and identity fields originate from the locked order, never the request. */
export function planPaymentCorrection(state, order, body, { amountDue, operator, now, createId, normalizePayment }) {
  const mutationId = text(body.clientMutationId);
  const reason = text(body.reason);
  if (!mutationId || mutationId.length > 160) fail('请刷新后重试资金更正', 'PAYMENT_CORRECTION_MUTATION_ID', 400);
  if (!reason || reason.length > 1000) fail('请填写更正或撤销原因（最多1000字）', 'PAYMENT_CORRECTION_REASON', 400);
  const requestHash = hash({ operator, paymentId: text(body.paymentId), action: body.action, mode: body.mode, reason, payment: body.payment ?? null });
  const previous = list(order.paymentCorrections).find(item => item.clientMutationId === mutationId);
  if (previous) {
    if (previous.requestHash !== requestHash || previous.operator !== operator) fail('此操作编号已使用，请刷新后重试', 'PAYMENT_CORRECTION_DUPLICATE');
    return { order, correction: previous, reopened: Boolean(previous.reopenedFromStatus), proofResubmissionRequired: previous.affectedClaimIds.length > 0, repeated: true };
  }
  if (body.expectedToken !== paymentCorrectionToken(order, amountDue)) fail('订单或资金记录已变化，请刷新后重新核对', 'PAYMENT_CORRECTION_STALE');
  const original = list(order.payments).find(item => text(item.id) === text(body.paymentId));
  if (!original) fail('资金记录不存在或已撤销，请刷新', 'PAYMENT_CORRECTION_NOT_FOUND');
  if (list(order.payments).filter(item => text(item.id) === text(body.paymentId)).length !== 1) fail('资金记录编号不唯一，请先核对数据', 'PAYMENT_CORRECTION_AMBIGUOUS');
  const capability = paymentCorrectionCapabilities(order, original, amountDue);
  if (body.action === 'void' ? !capability.canVoid : body.action === 'correct' ? !capability.canCorrect : true)
    fail(capability.correctionBlockReason || '当前记录状态不支持此操作，请刷新后选择撤销或更正', 'PAYMENT_CORRECTION_ACTION');
  const claims = linkedClaims(order, original);
  const mode = body.action === 'void' || claims.length ? 'retract' : body.mode;
  if (!['replace', 'retract'].includes(mode)) fail('请选择更正信息或撤销错误登记', 'PAYMENT_CORRECTION_MODE', 400);
  if (claims.length && body.payment) fail('关联付款凭证的收款需退回负责人补正凭证，不能替换为手工流水', 'PAYMENT_CORRECTION_PROOF_REQUIRED');
  const nextClaims = list(order.paymentClaims).map(claim => {
    if (!claims.some(item => item.id === claim.id)) return claim;
    const { previousReviews, ...snapshot } = claim;
    return { ...claim, status: 'rejected', version: Number(claim.version || 1) + 1, paymentId: '', matchingPaymentId: '',
      reviewedBy: operator, reviewedAt: now, rejectionReason: `资金更正：${reason}`, previousReviews: [...list(previousReviews), snapshot] };
  });
  const context = { ...order, payments: list(order.payments).filter(item => item.id !== original.id), paymentClaims: nextClaims };
  let replacement;
  if (mode === 'replace') {
    const incoming = body.payment || {};
    if (incoming.type && incoming.type !== original.type) fail('更正不能改变收款或退款类型', 'PAYMENT_CORRECTION_TYPE', 400);
    const amount = Number(incoming.amount);
    if (incoming.amount == null || typeof incoming.amount === 'boolean' || !Number.isFinite(amount) || amount <= 0 || amount > 100000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6)
      fail('金额必须为正数，最多两位小数', 'PAYMENT_CORRECTION_AMOUNT', 400);
    const time = text(incoming.time);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time) || !Number.isFinite(Date.parse(time))) fail('请填写有效资金发生时间', 'PAYMENT_CORRECTION_TIME', 400);
    const method = resolvePaymentMethodSnapshot(state.systemSettings, { paymentMethodId: text(incoming.paymentMethodId), channel: incoming.channel ?? original.channel }, original);
    if (usesOrderCashier(order) && !cashierMethodAllowedForOrder(method, order)) fail('该订单类型不支持此收退款方式', 'PAYMENT_CORRECTION_METHOD', 400);
    replacement = normalizePayment({ ...original, ...method, id: createId('pay'), type: original.type, amount, time,
      externalTransactionNo: text(incoming.externalTransactionNo), notes: text(incoming.notes),
      verificationStatus: 'pending', verifiedAt: '', verifiedBy: '', recordedBy: operator, recordSource: 'finance', statementId: '', matchMethod: '' });
    // Preserve historical allocation for equal/lower corrections (including freight overpayments); increases must use current available allocation.
    if (amount <= Number(original.amount)) {
      if (original.shippingAmount != null) replacement.shippingAmount = Math.min(amount, paymentShippingAmount(original));
    } else if (hasShippingSettlement(order)) {
      const allocation = original.type === 'refund' ? validateOrderRefundAllocation(context, amount)
        : validateShippingReceipt(context, state.shipments, amount, original.type === 'shipping_fee' ? 'shipping_fee' : 'order');
      if (allocation) replacement.shippingAmount = allocation.shippingAmount;
    }
    if (original.type !== 'refund' && amount > Number(original.amount) && registeredOrderCashSummary(context).netRecorded + amount - amountDue > 0.005)
      fail('更正后的收款超过本单应收，请核对已有收款和凭证', 'PAYMENT_CORRECTION_OVERPAID');
    const external = text(replacement.externalTransactionNo);
    if (external && list(state.orders).some(other => list(other.payments).some(payment => payment.id !== original.id &&
      text(payment.externalTransactionNo) === external && payment.channel === replacement.channel && payment.account === replacement.account)))
      fail('此外部流水号已关联其他收款，请勿重复登记', 'PAYMENT_CORRECTION_DUPLICATE_RECEIPT');
    if (external && list(state.orders).some(other => list(other.paymentClaims).some(claim => !claims.some(item => item.id === claim.id) && claim.status === 'pending' &&
      text(claim.externalTransactionNo) === external && claim.channel === replacement.channel && claim.account === replacement.account && claim.matchingPaymentId !== original.id)))
      fail('此外部流水号已有待核验凭证，请勿重复登记', 'PAYMENT_CORRECTION_DUPLICATE_RECEIPT');
    context.payments.push(replacement);
  }
  const cash = registeredOrderCashSummary(context);
  if (cash.invalidRecordCount || cash.recordedRefunded - cash.recordedReceived > 0.005)
    fail('更正后已登记退款会超过收款，请先核对相关退款记录', 'PAYMENT_CORRECTION_REFUND_BALANCE');
  const reopened = order.status === 'completed' && !orderCompletionFinancialCheck(context, amountDue).canComplete;
  if (reopened) context.status = list(state.shipments).some(shipment => shipment.orderId === order.id && ['outbound', 'shipped', 'delivered', 'damaged'].includes(shipment.status)) ? 'shipped' : 'pending';
  const correction = { id: createId('paycorr'), action: body.action, mode, paymentId: original.id, reason, operator, operatedAt: now,
    clientMutationId: mutationId, requestHash, originalPayment: structuredClone(original),
    ...(replacement ? { replacementPayment: structuredClone(replacement) } : {}), affectedClaimIds: claims.map(claim => claim.id),
    ...(reopened ? { reopenedFromStatus: 'completed' } : {}) };
  context.paymentCorrections = [...list(order.paymentCorrections), correction];
  return { order: context, correction, reopened, proofResubmissionRequired: claims.length > 0, repeated: false };
}
