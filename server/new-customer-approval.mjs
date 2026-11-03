import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";
import { normalizeNewCustomerEvidenceIds, newCustomerEvidenceMetadata } from "./new-customer-evidence.mjs";

export const NEW_CUSTOMER_COMMISSION_POLICY_EFFECTIVE_DATE = "2026-10-01";
const POLICY_START_MS = Date.parse("2026-10-01T00:00:00+08:00");
const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const fail = (statusCode, code, message) => { throw Object.assign(new Error(message), { statusCode, code }); };
export const newCustomerApprovalVersion = (order) => Number.isSafeInteger(order?.newCustomerApproval?.version) ? order.newCustomerApproval.version : 0;

export function commissionOrderCreatedAtMs(order) {
  const value = text(order?.createdAt);
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month) || calendar.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  return Date.parse(value.replace(" ", "T") + (match[8] ? "" : "+08:00"));
}

export function isCommissionEligibleOrder(order, now = new Date()) {
  const created = commissionOrderCreatedAtMs(order);
  const nowMs = new Date(now).getTime();
  return Number.isFinite(created) && created >= POLICY_START_MS && created <= nowMs;
}

export function resolveNewCustomerOrderOwner(personnel, order) {
  const ownerId = text(order?.contactPersonnelId);
  const reference = text(order?.contactPerson);
  const matches = list(personnel).filter((person) => ownerId ? text(person?.id) === ownerId
    : reference && [text(person?.username), text(person?.name)].includes(reference));
  return matches.length === 1 ? matches[0] : null;
}

function customerSnapshot(state, order) {
  const customerId = text(order?.customerId);
  if (!customerId) return null;
  const matches = list(state?.customers).filter((customer) => text(customer?.id) === customerId);
  if (matches.length !== 1) fail(409, "NEW_CUSTOMER_IDENTITY_CONFLICT", "订单客户档案不存在或不唯一，请先核对客户资料");
  return Object.fromEntries(["id", "phone", "wechat", "douyin"].map((key) => [key, text(matches[0][key])]));
}

function requireCustomerProfile(state, order) {
  const snapshot = customerSnapshot(state, order);
  if (!snapshot) fail(409, "NEW_CUSTOMER_CUSTOMER_REQUIRED", "请先在系统中创建并关联真实客户档案，再申请新客提成");
  const customer = list(state.customers).find((item) => text(item.id) === snapshot.id);
  if (!text(customer?.name)) fail(409, "NEW_CUSTOMER_IDENTITY_CONFLICT", "关联的客户档案缺少名称，请先完善客户资料");
  return snapshot;
}

function requireVerifiedEvidence(ids, attachments) {
  if (!ids.length) fail(400, "NEW_CUSTOMER_EVIDENCE_REQUIRED", "请至少上传一张添加客户微信的证明图片");
  if (JSON.stringify(list(attachments).map((item) => item.id)) !== JSON.stringify(ids)) {
    fail(400, "NEW_CUSTOMER_EVIDENCE_UNVERIFIED", "申请凭证未经服务器验证，请重新上传证明图片");
  }
}

export function newCustomerCustomerManagementBlock(state, order, account) {
  const owner = resolveNewCustomerOrderOwner(state.personnel, order);
  if (!isPersonnelAccountEnabled(account) || (account.accessRole !== "admin" &&
      (!owner || text(owner.id) !== text(account.id) || text(owner.username) !== text(account.username)))) return "仅订单负责人或管理员可以关联客户档案";
  if (["pending", "approved"].includes(order?.newCustomerApproval?.status)) return "新客申请待审批或已批准，不能变更客户；待审批申请请先驳回后补全重提";
  return "";
}

export function assertNewCustomerCustomerUnchanged(currentOrder, nextOrder) {
  if (["pending", "approved"].includes(currentOrder?.newCustomerApproval?.status) && text(currentOrder.customerId) !== text(nextOrder.customerId)) {
    fail(409, "NEW_CUSTOMER_CUSTOMER_LOCKED", "新客申请待审批或已批准，不能变更关联客户");
  }
}

export function newCustomerOrderEvidence(state = {}, order = {}) {
  const customerId = text(order.customerId);
  const candidates = customerId ? list(state.orders).filter((item) => text(item?.customerId) === customerId && item?.status !== "cancelled")
    .sort((a, b) => commissionOrderCreatedAtMs(a) - commissionOrderCreatedAtMs(b) || text(a.orderNo).localeCompare(text(b.orderNo)) || text(a.id).localeCompare(text(b.id))) : [];
  const creationTimesKnown = candidates.every((item) => Number.isFinite(commissionOrderCreatedAtMs(item)));
  const others = candidates.filter((item) => text(item.id) !== text(order.id));
  return {
    customerId, identityKnown: Boolean(customerId), creationTimesKnown, firstOrderId: creationTimesKnown ? text(candidates[0]?.id) : "", otherOrderCount: others.length,
    priorOrders: others.slice(0, 20).map(({ id, orderNo, date, status }) => ({ id, orderNo, date, status })),
    warning: customerId ? !creationTimesKnown ? "同客户历史订单缺少可靠创建时间，无法认定首单，请先核对历史记录。" : "仅按现有客户档案核对；请同时确认没有重复客户档案或线下历史交易。"
      : "此订单没有关联客户档案，请先创建并关联真实客户档案；管理员确认不能替代客户档案。",
  };
}

function identityMatches(state, order, approval) {
  const owner = resolveNewCustomerOrderOwner(state.personnel, order);
  const currentCustomer = customerSnapshot(state, order);
  const approvedCustomer = approval?.customerSnapshot ?? null;
  const sameCustomer = currentCustomer === null ? approvedCustomer === null : approvedCustomer &&
    ["id", "phone", "wechat", "douyin"].every((key) => currentCustomer[key] === text(approvedCustomer[key]));
  return Boolean(owner && text(owner.id) === text(approval?.contactPersonnelId) &&
    text(order.customerId) === text(approval?.customerId) &&
    sameCustomer);
}

export function isApprovedNewCustomerOrder(state, order) {
  try {
    const approval = order?.newCustomerApproval;
    if (!isCommissionEligibleOrder(order) || approval?.status !== "approved" || order?.status === "cancelled" || !text(approval?.reviewedBy) || !text(approval?.reviewedAt) || !identityMatches(state, order, approval)) return false;
    const evidence = newCustomerOrderEvidence(state, order);
    return !evidence.identityKnown ? approval.customerIdentityConfirmed === true : evidence.firstOrderId === text(order.id);
  } catch { return false; }
}

function requestBlock(state, order, account) {
  if (!isCommissionEligibleOrder(order)) return "仅 2026 年 10 月 1 日起创建的订单适用；缺少可靠创建时间的历史订单请先核对";
  if (order?.status === "cancelled") return "已取消订单不能申请新客提成";
  const owner = resolveNewCustomerOrderOwner(state.personnel, order);
  if (!owner || !isPersonnelAccountEnabled(owner)) return "订单负责人未关联唯一启用账号，请先核对负责人";
  if (text(owner.id) !== text(account?.id) || text(owner.username) !== text(account?.username)) return "仅该订单负责人本人可以申请新客提成";
  try { requireCustomerProfile(state, order); } catch (error) { return error.message; }
  const evidence = newCustomerOrderEvidence(state, order);
  if (evidence.identityKnown && evidence.firstOrderId !== text(order.id)) return "该客户已有更早的非取消订单，本订单不能申请新客首单提成";
  if (order?.newCustomerApproval?.status === "pending") return "已有待处理申请，请等待管理员审批";
  if (isApprovedNewCustomerOrder(state, order)) return "新客提成申请已批准";
  return "";
}

export function assertCanUploadNewCustomerEvidence(state, order, account) {
  const owner = resolveNewCustomerOrderOwner(state.personnel, order);
  if (!owner || text(owner.id) !== text(account?.id) || text(owner.username) !== text(account?.username)) {
    fail(403, "NEW_CUSTOMER_OWNER_REQUIRED", "仅该订单负责人本人可以上传新客凭证");
  }
  const blocked = requestBlock(state, order, account);
  if (blocked) fail(409, "NEW_CUSTOMER_REQUEST_BLOCKED", blocked);
}

// Site access and fresh session authentication are enforced by each caller.
export function canViewNewCustomerEvidence(state, order, account, record = null) {
  const owner = resolveNewCustomerOrderOwner(state.personnel, order);
  return Boolean(isPersonnelAccountEnabled(account) && (account.accessRole === "admin" ||
    (text(owner?.id) === text(account.id) && text(owner?.username) === text(account.username)) ||
    (record ? record.uploaderPersonnelId === account.id && record.uploaderUsername === account.username
      : text(order.newCustomerApproval?.requestedBy) === text(account.username))));
}

export function newCustomerApprovalDetail(state = {}, order = {}, account = {}, { canUpdateOrder = true, canCreateCustomer = false } = {}) {
  const requestBlockedReason = requestBlock(state, order, account);
  const approval = order.newCustomerApproval ?? null;
  const customerEvidence = newCustomerOrderEvidence(state, order);
  const customerBlockedReason = newCustomerCustomerManagementBlock(state, order, account) || (!canUpdateOrder ? "当前账号没有订单修改权限，请联系管理员关联客户" : "");
  const matches = list(state.customers).filter((customer) => text(customer.id) === text(order.customerId));
  const linkedCustomer = matches.length === 1 && text(matches[0].name) && canViewNewCustomerEvidence(state, order, account)
    ? Object.fromEntries(["id", "name", "phone", "wechat", "douyin"].map((key) => [key, text(matches[0][key])])) : null;
  let approvalBlockedReason = "";
  if (approval?.status === "pending") {
    try {
      requireCustomerProfile(state, order);
      if (!list(approval.evidenceAttachments).length) fail(400, "NEW_CUSTOMER_EVIDENCE_REQUIRED", "此申请缺少添加微信的证明图片，请驳回后补充重提");
    } catch (error) { approvalBlockedReason = error.message; }
  }
  if (account?.accessRole !== "admin") {
    const visibleIds = new Set(list(state.orders).filter((item) => list(account.visibleSiteIds).includes(text(item.siteId))).map((item) => text(item.id)));
    customerEvidence.priorOrders = customerEvidence.priorOrders.filter((item) => visibleIds.has(text(item.id)));
    customerEvidence.otherOrderCount = list(state.orders).filter((item) => visibleIds.has(text(item.id)) &&
      text(item.id) !== text(order.id) && text(item.customerId) === text(order.customerId) && text(order.customerId) && item.status !== "cancelled").length;
    if (!visibleIds.has(customerEvidence.firstOrderId)) customerEvidence.firstOrderId = "";
  }
  return {
    orderId: text(order.id), approval, canRequest: !requestBlockedReason, requestBlockedReason,
    canViewEvidence: canViewNewCustomerEvidence(state, order, account),
    canApprove: approval?.status === "pending" && account?.accessRole === "admin" && isPersonnelAccountEnabled(account),
    linkedCustomer, canManageCustomer: !customerBlockedReason, canCreateCustomer: !customerBlockedReason && canCreateCustomer,
    customerBlockedReason, approvalBlockedReason,
    customerEvidence,
    currentOrder: Object.fromEntries(["id", "orderNo", "date", "createdAt", "customerId", "contactPersonnelId", "contactPerson"].map((key) => [key, order[key] ?? ""])),
    policyEffectiveDate: NEW_CUSTOMER_COMMISSION_POLICY_EFFECTIVE_DATE,
    policyNote: "仅适用于 2026 年 10 月 1 日起创建的订单，按核销商品实收月份计提，退款在核销月份扣回；新客 5% 替代普通个人 0.2% 和团队公共池 0.3%。",
  };
}

function requireVersion(order, body) {
  if (!Number.isSafeInteger(body?.expectedApprovalVersion) || body.expectedApprovalVersion !== newCustomerApprovalVersion(order)) {
    fail(409, "NEW_CUSTOMER_APPROVAL_CONFLICT", "新客申请已发生变化，请刷新后重试");
  }
}

export function planNewCustomerRequest(state, order, account, body, { requestId, now = new Date().toISOString(), evidenceAttachments = [] }) {
  const reason = text(body.reason);
  const evidenceIds = normalizeNewCustomerEvidenceIds(body.evidenceIds);
  if (reason.length < 5 || reason.length > 1000) fail(400, "NEW_CUSTOMER_REASON_REQUIRED", "请填写新客身份识别依据和申请说明（5 至 1000 字）");
  const owner = resolveNewCustomerOrderOwner(state.personnel, order);
  if (!owner || !isPersonnelAccountEnabled(owner) || text(owner.id) !== text(account?.id) || text(owner.username) !== text(account?.username)) {
    fail(403, "NEW_CUSTOMER_OWNER_REQUIRED", "仅该订单负责人本人可以申请新客提成");
  }
  const previous = order.newCustomerApproval;
  // Validate before pending retry idempotency: legacy incomplete requests are not valid new submissions.
  requireCustomerProfile(state, order);
  const blocked = requestBlock(state, order, account);
  if (blocked && previous?.status !== "pending") fail(409, "NEW_CUSTOMER_REQUEST_BLOCKED", blocked);
  requireVerifiedEvidence(evidenceIds, evidenceAttachments);
  if (previous?.status === "pending" && identityMatches(state, order, previous) && previous.reason === reason &&
      JSON.stringify(list(previous.evidenceAttachments).map((item) => item.id)) === JSON.stringify(evidenceIds)) return { order, unchanged: true };
  requireVersion(order, body);
  if (blocked) fail(409, "NEW_CUSTOMER_REQUEST_BLOCKED", blocked);
  const approval = {
    status: "pending", requestId, requestedAt: now, requestedBy: text(account.username), requestedByName: text(account.name || account.username),
    reason, customerId: text(order.customerId), customerSnapshot: customerSnapshot(state, order), contactPersonnelId: text(owner.id),
    evidenceAttachments: evidenceAttachments.map(newCustomerEvidenceMetadata),
    version: newCustomerApprovalVersion(order) + 1,
  };
  return { order: { ...order, newCustomerApproval: approval }, unchanged: false };
}

export function planNewCustomerReview(state, order, account, body, now = new Date().toISOString(), { evidenceAttachments = [] } = {}) {
  if (account?.accessRole !== "admin" || !isPersonnelAccountEnabled(account)) fail(403, "NEW_CUSTOMER_ADMIN_REQUIRED", "仅启用中的管理员可以审批新客提成");
  if (!["approve", "reject"].includes(body.decision)) fail(400, "NEW_CUSTOMER_DECISION_INVALID", "请选择批准或驳回");
  const previous = order.newCustomerApproval;
  if (!previous || text(previous.requestId) !== text(body.requestId)) fail(409, "NEW_CUSTOMER_APPROVAL_CONFLICT", "申请不存在或已被更新，请刷新后重试");
  const status = body.decision === "approve" ? "approved" : "rejected";
  if (previous.status === status) return { order, unchanged: true };
  requireVersion(order, body);
  if (previous.status !== "pending") fail(409, "NEW_CUSTOMER_APPROVAL_CONFLICT", "申请已由其他管理员处理，请勿重复审批");
  const note = text(body.note);
  if (note.length > 1000 || (status === "rejected" && !note)) fail(400, "NEW_CUSTOMER_REVIEW_NOTE_REQUIRED", "驳回时请填写处理说明，最多 1000 字");
  if (status === "approved") {
    if (!isCommissionEligibleOrder(order)) fail(409, "NEW_CUSTOMER_ORDER_INELIGIBLE", "订单创建于政策生效前或缺少可靠创建时间，不能批准新客提成");
    if (order.status === "cancelled") fail(409, "NEW_CUSTOMER_REQUEST_BLOCKED", "已取消订单不能批准新客提成");
    requireCustomerProfile(state, order);
    requireVerifiedEvidence(normalizeNewCustomerEvidenceIds(list(previous.evidenceAttachments).map((item) => item.id)), evidenceAttachments);
    if (!identityMatches(state, order, previous)) fail(409, "NEW_CUSTOMER_IDENTITY_CONFLICT", "订单客户或负责人已变化，请驳回原申请后重新提交");
    const evidence = newCustomerOrderEvidence(state, order);
    if (evidence.identityKnown && evidence.firstOrderId !== text(order.id)) fail(409, "NEW_CUSTOMER_NOT_FIRST_ORDER", "客户已有更早的非取消订单，不能批准本订单为新客首单");
    if (evidence.identityKnown && list(state.orders).some((other) => text(other.id) !== text(order.id) && other.status !== "cancelled" &&
        text(other.customerId) === evidence.customerId && other.newCustomerApproval?.status === "approved")) {
      fail(409, "NEW_CUSTOMER_ALREADY_APPROVED", "该客户已有其他获批的新客订单，不能重复批准");
    }
  }
  return { unchanged: false, order: { ...order, newCustomerApproval: {
    ...previous, status, reviewedAt: now, reviewedBy: text(account.username), reviewedByName: text(account.name || account.username), reviewNote: note,
    version: previous.version + 1,
  } } };
}
