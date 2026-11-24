import { createHash } from "node:crypto";
import { hasShippingSettlement, shippingSettlementSummary, allocateShippingProof, paymentShippingAmount } from "./shipping-settlement.mjs";
import { isPaymentVerified, configuredPaymentMethods, resolvePaymentMethodSnapshot, verifiedPaymentTotals } from "./payment-utils.mjs";
import { creditSaleOrderOwner } from "./credit-sale-approval-rules.mjs";
import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";
import { normalizePaymentEvidenceIds, resolveEvidenceForSubmission, paymentEvidenceMetadata } from "./payment-evidence.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const money = value => Number(Number(value || 0).toFixed(2));
const fail = (message, code = "PAYMENT_PROOF_INVALID", statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const paymentClaims = order => list(order?.paymentClaims);

export function paymentProofSummary(order = {}, amountDue = 0) {
  const totals = verifiedPaymentTotals(order.payments);
  const verifiedAmount = Math.max(0, money(totals.received - totals.refunded));
  const due = Math.max(0, money(amountDue));
  const submitted = paymentClaims(order).filter(claim => claim.status === "pending" && list(claim.evidenceAttachments).length > 0)
    .reduce((sum, claim) => sum + Math.max(0, Number(claim.amount || 0)), 0);
  const pendingProofAmount = money(Math.min(Math.max(0, due - verifiedAmount), submitted));
  const creditAmount = money(Math.max(0, due - verifiedAmount - pendingProofAmount));
  const status = creditAmount > 0.005 ? "credit_sale" : pendingProofAmount > 0.005 ? "proof_pending" : "verified";
  return { amountDue: due, verifiedAmount, pendingProofAmount, creditAmount, status };
}

export function paymentEvidenceShipmentSnapshot(shipment, order, amountDue, stage, now) {
  const snapshot = { ...paymentProofSummary(order, amountDue), stage, capturedAt: now,
    claimIds: paymentClaims(order).filter(claim => ["pending", "approved"].includes(claim.status)).map(claim => claim.id) };
  return { ...shipment, paymentEvidenceSnapshot: snapshot,
    paymentEvidenceSnapshots: [...list(shipment.paymentEvidenceSnapshots), snapshot] };
}

export function canSubmitPaymentProof(state, order, account) {
  return isPersonnelAccountEnabled(account) && order.status !== "cancelled" &&
    (account.accessRole === "admin" || text(creditSaleOrderOwner(state.personnel, order)?.id) === text(account.id));
}

export function assertPaymentClaimsUnchanged(before, after) {
  if (JSON.stringify(before?.paymentClaims ?? []) !== JSON.stringify(after?.paymentClaims ?? [])) fail("付款凭证只能通过专用提交和财务核验入口修改", "PAYMENT_PROOF_SERVER_OWNED");
}

export function eligiblePaymentProofPayments(order) {
  const claimed = new Set(paymentClaims(order).filter(claim => claim.status === "approved").map(claim => text(claim.paymentId)));
  return list(order.payments).filter(payment => payment.type !== "refund" && !claimed.has(text(payment.id)))
    .map(payment => Object.fromEntries(["id", "time", "type", "amount", "channel", "account", "verificationStatus", "recordSource", "externalTransactionNo", "statementId", "shippingAmount"].map(key => [key, payment[key]])));
}

export function linkablePaymentProofPayments(order) {
  const ids = new Set(paymentClaims(order).filter(claim => claim.status === "approved").map(claim => claim.paymentId));
  return list(order.payments).filter(payment => ids.has(payment.id) && payment.type !== "refund" && isPaymentVerified(payment) && !text(payment.statementId))
    .map(payment => Object.fromEntries(["id", "time", "amount", "channel", "account", "externalTransactionNo", "verifiedAt", "verifiedBy"].map(key => [key, payment[key]])));
}

export function paymentProofReviewToken(order) {
  return hash({ orderId: order.id, claims: paymentClaims(order), payments: list(order.payments), owner: order.contactPersonnelId,
    channel: order.paymentChannel, account: order.paymentAccount });
}

export function paymentProofDetail(state, order, account, amountDue, canReview) {
  return { orderId: order.id, claims: paymentClaims(order), canSubmit: canSubmitPaymentProof(state, order, account), canReview,
    paymentMethods: configuredPaymentMethods(state.systemSettings).filter(method => method.channel === order.paymentChannel),
    eligiblePayments: canReview ? eligiblePaymentProofPayments(order) : [],
    receiptCandidates: canSubmitPaymentProof(state, order, account) ? eligiblePaymentProofPayments(order)
      .map(payment => Object.fromEntries(["id", "type", "amount", "shippingAmount", "channel", "account"].map(key => [key, payment[key]]))) : [],
    linkableProofPayments: canReview ? linkablePaymentProofPayments(order) : [],
    summary: paymentProofSummary(order, amountDue), shippingSettlement: shippingSettlementSummary(order, state.shipments), reviewToken: paymentProofReviewToken(order) };
}

export function planPaymentProofSubmission(state, order, account, body, { amountDue, now, createId }) {
  if (!canSubmitPaymentProof(state, order, account)) fail("仅当前订单负责人或管理员可以提交本单付款凭证", "PAYMENT_PROOF_OWNER_REQUIRED", 403);
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7 || amount > 100000000) fail("付款金额必须为正数，最多保留两位小数", "PAYMENT_PROOF_AMOUNT", 400);
  const time = text(body.time);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time) || !Number.isFinite(Date.parse(time))) fail("请填写有效付款时间", "PAYMENT_PROOF_TIME", 400);
  const ids = normalizePaymentEvidenceIds(body.evidenceIds);
  if (!ids.length) fail("请至少上传一张付款凭证图片", "PAYMENT_PROOF_EVIDENCE_REQUIRED", 400);
  const evidence = resolveEvidenceForSubmission(state.paymentEvidenceAttachments, ids, order, account);
  const claims = paymentClaims(order);
  const existing = text(body.claimId) ? claims.find(claim => claim.id === body.claimId) : null;
  if (text(body.claimId) && (!existing || existing.status !== "rejected" || Number(body.expectedVersion) !== existing.version)) fail("凭证申报已变化；只有被驳回的申报可以修改后重提", "PAYMENT_PROOF_STALE");
  const otherClaims = claims.filter(claim => claim.id !== existing?.id && claim.status !== "rejected");
  const allOtherClaims = list(state.orders).flatMap(other => paymentClaims(other)).filter(claim => claim.id !== existing?.id && claim.status !== "rejected");
  const refundEvidenceIds = list(state.orders).flatMap(other => list(other.payments).filter(payment => payment.type === "refund")
    .flatMap(payment => list(payment.evidenceAttachments).map(record => record.id)));
  const boundRefundIds = list(state.paymentEvidenceAttachments).filter(record => list(record.boundClaimIds).some(id => text(id).startsWith("shipping-refund:"))).map(record => record.id);
  const activeIds = new Set([...allOtherClaims.flatMap(claim => list(claim.evidenceAttachments).map(record => record.id)), ...refundEvidenceIds, ...boundRefundIds]);
  const activePrints = new Set(list(state.paymentEvidenceAttachments).filter(record => activeIds.has(record.id)).map(record => record.sha256).filter(Boolean));
  if (evidence.some(record => activeIds.has(record.id) || activePrints.has(record.sha256))) fail("同一张付款凭证已提交，请勿重复登记", "PAYMENT_PROOF_DUPLICATE");
  const usesSettlement = hasShippingSettlement(order);
  if (!usesSettlement) {
    const total = otherClaims.reduce((sum, claim) => sum + Number(claim.amount || 0), amount);
    if (total - amountDue > 0.005) fail("申报付款金额累计不能超过当前订单应收，请核对已有申报", "PAYMENT_PROOF_OVERPAID");
    if (body.purpose === "shipping_fee" || Number(body.shippingAmount || 0) !== 0) fail("历史订单请使用原收款流程", "PAYMENT_PROOF_LEGACY_PURPOSE", 400);
  }
  const method = resolvePaymentMethodSnapshot(state.systemSettings, { paymentMethodId: body.paymentMethodId, channel: order.paymentChannel }, {});
  if (method.channel !== order.paymentChannel || method.account !== order.paymentAccount) fail("付款方式或收款账户与订单不一致，请核对订单", "PAYMENT_PROOF_METHOD");
  const externalTransactionNo = text(body.externalTransactionNo).slice(0, 200);
  if (externalTransactionNo && list(state.orders).some(other => paymentClaims(other).some(claim => claim.status !== "rejected" && claim.id !== existing?.id &&
    text(claim.externalTransactionNo) === externalTransactionNo && claim.channel === method.channel && claim.account === method.account))) fail("该支付流水号已在付款凭证中登记，请核对", "PAYMENT_PROOF_DUPLICATE");
  let allocation = null;
  if (usesSettlement) {
    if (body.purpose != null && !["order", "shipping_fee"].includes(body.purpose)) fail("请选择有效收款用途", "PAYMENT_PROOF_PURPOSE", 400);
    const candidates = eligiblePaymentProofPayments(order).filter(payment => money(payment.amount) === money(amount) && payment.channel === method.channel && text(payment.account) === method.account);
    const matchedPayment = candidates.length === 1 ? candidates[0] : null;
    if (matchedPayment && otherClaims.some(claim => claim.matchingPaymentId === matchedPayment.id || claim.paymentId === matchedPayment.id)) fail("该收款已有凭证待核验，请勿重复提交", "PAYMENT_PROOF_DUPLICATE");
    const context = { ...order, payments: list(order.payments).filter(payment => payment.id !== matchedPayment?.id), paymentClaims: claims.filter(claim => claim.id !== existing?.id) };
    const summary = shippingSettlementSummary(context, state.shipments);
    const split = matchedPayment && (matchedPayment.shippingAmount != null || matchedPayment.type === "shipping_fee")
      ? { purpose: matchedPayment.type === "shipping_fee" ? "shipping_fee" : "order", shippingAmount: paymentShippingAmount(matchedPayment), goodsAmount: money(amount - paymentShippingAmount(matchedPayment)) }
      : allocateShippingProof(context, state.shipments, amount, body.purpose || "order");
    if (body.shippingAmount != null && (!Number.isFinite(Number(body.shippingAmount)) || Math.abs(Number(body.shippingAmount) - split.shippingAmount) > 0.005)) fail("货款与运费分配已变化，请刷新后核对", "PAYMENT_PROOF_ALLOCATION_STALE");
    if (!matchedPayment && split.shippingAmount - summary.toCollect > 0.005) fail("运费申报超过当前待收运费，请核对已登记款项", "PAYMENT_PROOF_SHIPPING_OVERPAID");
    const linkedClaims = new Set(list(context.payments).map(payment => text(payment.paymentProofClaimId)));
    const linkedPayments = new Set(list(context.payments).map(payment => text(payment.id)));
    const committed = list(context.payments).filter(payment => payment.verificationStatus !== "rejected")
      .reduce((sum, payment) => sum + (payment.type === "refund" ? -Number(payment.amount || 0) : Number(payment.amount || 0)), 0) +
      list(context.paymentClaims).filter(claim => claim.status === "pending" && !linkedClaims.has(text(claim.id)) && !linkedPayments.has(text(claim.paymentId)) && !linkedPayments.has(text(claim.matchingPaymentId)))
        .reduce((sum, claim) => sum + Number(claim.amount || 0), 0);
    if (!matchedPayment && committed + amount - amountDue > 0.005) fail("本次申报与已登记收款合计超过当前订单应收", "PAYMENT_PROOF_OVERPAID");
    allocation = { ...split, shippingDueAtSubmission: Math.max(summary.shippingDue, matchedPayment ? split.shippingAmount : 0), ...(matchedPayment ? { matchingPaymentId: matchedPayment.id } : {}) };
  }
  const claim = { id: existing?.id || createId(), version: Number(existing?.version || 0) + 1, status: "pending", amount: money(amount), time,
    ...(allocation || {}), ...method, externalTransactionNo, notes: text(body.notes).slice(0, 1000), evidenceAttachments: evidence.map(paymentEvidenceMetadata),
    submittedBy: account.username, submittedByPersonnelId: account.id, submittedAt: now,
    reviewedBy: "", reviewedAt: "", rejectionReason: "", paymentId: "",
    ...(existing ? { previousReviews: [...list(existing.previousReviews), Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "previousReviews"))] } : {}) };
  return { claim, evidence, order: { ...order, paymentClaims: [...claims.filter(item => item.id !== claim.id), claim] } };
}

export function planPaymentProofReview(order, account, body, { now, createPaymentId, amountDue, state = {} }) {
  const claims = paymentClaims(order);
  const claim = claims.find(item => item.id === text(body.claimId));
  if (!claim) fail("付款申报不存在", "PAYMENT_PROOF_NOT_FOUND", 404);
  if (!["approve", "reject"].includes(body.decision)) fail("请选择核验通过或驳回", "PAYMENT_PROOF_DECISION", 400);
  const expected = Number(body.expectedVersion);
  if (expected === claim.version && ((body.decision === "approve" && claim.status === "approved") || (body.decision === "reject" && claim.status === "rejected"))) return { order, claim, unchanged: true };
  if (claim.status !== "pending" || expected !== claim.version || text(body.reviewToken) !== paymentProofReviewToken(order)) fail("凭证或收款记录已变化，请重新查看图片和金额后核验", "PAYMENT_PROOF_STALE");
  let payments = list(order.payments), paymentId = "";
  const reason = text(body.reason);
  if (body.decision === "reject" && (!reason || reason.length > 1000)) fail("驳回时请填写原因（最多1000字）", "PAYMENT_PROOF_REASON", 400);
  if (body.decision === "approve") {
    const eligible = eligiblePaymentProofPayments(order);
    const same = eligible.filter(payment => money(payment.amount) === claim.amount && payment.channel === claim.channel && text(payment.account) === claim.account);
    const selected = text(body.existingPaymentId) ? same.find(payment => payment.id === body.existingPaymentId) : null;
    if (claim.matchingPaymentId && text(body.existingPaymentId) !== claim.matchingPaymentId) fail("此凭证对应已有收款，请选择对应流水，不能重复新记收款", "PAYMENT_PROOF_EXISTING_PAYMENT_REQUIRED");
    const settlementClaim = hasShippingSettlement(order) && ["order", "shipping_fee"].includes(claim.purpose) && Number.isFinite(Number(claim.shippingAmount));
    const allocationFields = settlementClaim ? { shippingAmount: claim.shippingAmount, ...(claim.purpose === "shipping_fee" ? { type: "shipping_fee" } : {}) } : {};
    if (text(body.existingPaymentId) && !selected) fail("所选收款记录的金额、渠道或账户不一致，或已被其他凭证核验，请重新选择", "PAYMENT_PROOF_PAYMENT_MISMATCH");
    if (!selected && same.length) fail("订单已有同金额收款记录，请选择对应记录核验，避免重复入账", "PAYMENT_PROOF_EXISTING_PAYMENT_REQUIRED");
    if (selected) {
      if (settlementClaim && (selected.shippingAmount != null || selected.type === "shipping_fee") && Math.abs(paymentShippingAmount(selected) - Number(claim.shippingAmount)) > 0.005) fail("所选流水的货款与运费分配不同，请重新核对凭证对应的收款", "PAYMENT_PROOF_ALLOCATION_STALE");
      if (payments.filter(payment => payment.id === selected.id).length !== 1) fail("收款记录编号不唯一，请先核对财务数据", "PAYMENT_PROOF_PAYMENT_AMBIGUOUS");
      paymentId = selected.id;
      payments = payments.map(payment => payment.id === paymentId ? { ...payment, ...allocationFields, verificationStatus: "verified",
        verifiedBy: isPaymentVerified(payment) ? payment.verifiedBy : account.username,
        verifiedAt: isPaymentVerified(payment) ? payment.verifiedAt : now, paymentProofClaimId: claim.id } : payment);
    } else {
      const committed = payments.reduce((sum, payment) => sum + (payment.type === "refund"
        ? isPaymentVerified(payment) ? -Number(payment.amount || 0) : 0 : Number(payment.amount || 0)), 0);
      // A proof submitted against a valid prepayment quote remains reviewable
      // when carrier cost later falls. The saved quote is server-owned and only
      // extends the freight portion, never the merchandise receivable.
      const summary = shippingSettlementSummary(order, state.shipments);
      const prepaymentAllowance = settlementClaim && order.shippingSettlementTiming === "before_shipping"
        ? Math.max(0, Number(claim.shippingDueAtSubmission || 0) - summary.shippingDue) : 0;
      if (Number.isFinite(amountDue) && committed + claim.amount - amountDue - prepaymentAllowance > 0.005) {
        fail("订单已有其他金额的收款记录，本次新记收款会超过应收；请先核对或关联既有流水，避免重复入账", "PAYMENT_PROOF_PAYMENT_OVERLAP");
      }
      if (text(claim.externalTransactionNo) && list(state.orders).some(other => list(other.payments).some(payment =>
        payment.type !== "refund" && text(payment.externalTransactionNo) === text(claim.externalTransactionNo) && payment.channel === claim.channel && text(payment.account) === claim.account))) {
        fail("该支付流水号已登记收款，请关联原记录核验，不能重复入账", "PAYMENT_PROOF_DUPLICATE_PAYMENT");
      }
      paymentId = createPaymentId();
      payments = [...payments, { id: paymentId, time: claim.time, type: "balance", ...allocationFields, amount: claim.amount,
        paymentMethodId: claim.paymentMethodId, paymentMethodName: claim.paymentMethodName, channel: claim.channel, account: claim.account,
        externalTransactionNo: claim.externalTransactionNo, proof: [], verificationStatus: "verified", recordSource: "order",
        recordedBy: claim.submittedBy, verifiedBy: account.username, verifiedAt: now, paymentProofClaimId: claim.id,
        notes: `付款凭证核验通过${claim.notes ? `；${claim.notes}` : ""}` }];
    }
  }
  const nextClaim = { ...claim, status: body.decision === "approve" ? "approved" : "rejected", reviewedBy: account.username,
    reviewedAt: now, rejectionReason: body.decision === "reject" ? reason : "", paymentId };
  return { claim: nextClaim, order: { ...order, payments, paymentClaims: claims.map(item => item.id === claim.id ? nextClaim : item) } };
}
