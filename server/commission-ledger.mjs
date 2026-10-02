import { createHash } from "node:crypto";
import { normalizeExternalOrderNo, normalizeShippingFeeMode } from "./finance-utils.mjs";
import { commissionOrderCreatedAtMs, isCommissionEligibleOrder, resolveNewCustomerOrderOwner, NEW_CUSTOMER_COMMISSION_POLICY_EFFECTIVE_DATE } from "./new-customer-approval.mjs";

export const COMMISSION_POLICY_EFFECTIVE_DATE = NEW_CUSTOMER_COMMISSION_POLICY_EFFECTIVE_DATE;
const START = Date.parse(`${COMMISSION_POLICY_EFFECTIVE_DATE}T00:00:00+08:00`);
const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const VECTOR = ["baseCents", "regularPersonalCents", "newCustomerCents", "teamPoolCents"];
const TARGET_FIELDS = ["orderId", "personnelId", "personnelName", "sourceId", "sourceType", "eventAt", ...VECTOR];
const empty = () => Object.fromEntries(VECTOR.map((key) => [key, 0]));
const money = (cents) => cents / 100;

// Parse decimal money without floating-point multiplication. Every persisted amount is integer cents.
function cents(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  let source = text(value).replace(/[,¥￥\s]/g, "");
  if (typeof value === "number" && Number.isFinite(value) && /e/i.test(source)) source = value.toFixed(8);
  const match = source.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const decimals = (match[3] || "").padEnd(3, "0");
  const absolute = BigInt(match[2]) * 100n + BigInt(decimals.slice(0, 2)) + (Number(decimals[2]) >= 5 ? 1n : 0n);
  if (absolute > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(absolute) * (match[1] === "-" ? -1 : 1);
}
const nonnegative = (value) => Math.max(0, cents(value) ?? 0);
const missing = (value) => value == null || text(value) === "";
function ratio(value, numerator, denominator) {
  if (!denominator || !value || !numerator) return 0;
  const product = BigInt(value) * BigInt(numerator);
  return Number((product + BigInt(denominator) / 2n) / BigInt(denominator));
}
function allocate(total, weights) {
  const denominator = weights.reduce((sum, weight) => sum + weight, 0);
  if (!denominator || !total) return weights.map(() => 0);
  const allocations = weights.map((weight, index) => {
    const product = BigInt(total) * BigInt(weight);
    return { index, amount: Number(product / BigInt(denominator)), remainder: product % BigInt(denominator) };
  });
  let remainder = total - allocations.reduce((sum, item) => sum + item.amount, 0);
  const priority = [...allocations].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const item of priority) { if (remainder-- <= 0) break; item.amount += 1; }
  return allocations.map((item) => item.amount);
}
function timestamp(value) {
  return commissionOrderCreatedAtMs({ createdAt: value instanceof Date ? value.toISOString() : value });
}
export function commissionMonth(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : timestamp(value);
  return Number.isFinite(ms) ? new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 7) : "";
}
function validMonth(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(text(month))) throw new Error("Invalid commission month");
  return month;
}
function diagnose(diagnostics, order, code, sourceId = "") {
  diagnostics.push({ orderId: text(order?.id), code, ...(sourceId ? { sourceId } : {}) });
}

function feeCaps(state, order, diagnostics) {
  const orderMoney = [...list(order.items).map((item) => item?.price), order.discount ?? 0, order.shippingFee ?? 0, order.packagingFee ?? 0];
  if (orderMoney.some((value) => cents(value) == null || cents(value) < 0)) {
    diagnose(diagnostics, order, "INVALID_ORDER_MONEY"); return null;
  }
  const goods = Math.max(0, list(order.items).reduce((sum, item) => sum + nonnegative(item?.price), 0) - nonnegative(order.discount));
  const mode = normalizeShippingFeeMode(order.shippingFeeMode, order.source);
  const shipments = list(state.shipments).filter((item) => text(item?.orderId) === text(order.id) && ["outbound", "shipped", "delivered", "damaged"].includes(item.status));
  if (shipments.some((item) => !missing(item.actualShippingFee) && (cents(item.actualShippingFee) == null || cents(item.actualShippingFee) < 0))) {
    diagnose(diagnostics, order, "INVALID_ORDER_SHIPPING_MONEY"); return null;
  }
  const actualKnown = shipments.length > 0 && shipments.every((item) => item.actualShippingFee != null && item.actualShippingFee !== "" && cents(item.actualShippingFee) != null);
  const shipping = mode === "prepaid" ? actualKnown ? shipments.reduce((sum, item) => sum + nonnegative(item.actualShippingFee), 0) : nonnegative(order.shippingFee) : 0;
  // Damage refunds are cash events below, not a second reduction of merchandise receivable.
  const caps = [goods, shipping, nonnegative(order.packagingFee)];
  if (!Number.isSafeInteger(caps.reduce((sum, value) => sum + value, 0))) {
    diagnose(diagnostics, order, "ORDER_MONEY_EXCEEDS_SAFE_RANGE"); return null;
  }
  return caps;
}

function approvalTime(state, order, owner, nowMs, diagnostics) {
  const approval = order.newCustomerApproval;
  if (approval?.status !== "approved") return null;
  const reviewedAt = timestamp(approval.reviewedAt);
  let valid = owner && text(owner.id) === text(approval.contactPersonnelId) && text(order.customerId) === text(approval.customerId) &&
    text(approval.requestId) && text(approval.reviewedBy) && Number.isFinite(reviewedAt) && reviewedAt >= commissionOrderCreatedAtMs(order) && reviewedAt <= nowMs;
  if (text(order.customerId)) {
    const customers = list(state.customers).filter((item) => text(item.id) === text(order.customerId));
    const snapshot = customers.length === 1 ? Object.fromEntries(["id", "phone", "wechat", "douyin"].map((key) => [key, text(customers[0][key])])) : null;
    valid = valid && snapshot && approval.customerSnapshot && ["id", "phone", "wechat", "douyin"].every((key) => snapshot[key] === text(approval.customerSnapshot[key]));
    const candidates = list(state.orders).filter((item) => text(item?.customerId) === text(order.customerId) && (item.status !== "cancelled" || text(item.id) === text(order.id)));
    const reliable = candidates.every((item) => Number.isFinite(commissionOrderCreatedAtMs(item)));
    candidates.sort((a, b) => commissionOrderCreatedAtMs(a) - commissionOrderCreatedAtMs(b) || text(a.orderNo).localeCompare(text(b.orderNo)) || text(a.id).localeCompare(text(b.id)));
    if (!reliable || text(candidates[0]?.id) !== text(order.id)) {
      diagnose(diagnostics, order, "APPROVAL_NOT_FIRST_CUSTOMER_ORDER"); valid = false;
    }
  } else valid = valid && approval.customerIdentityConfirmed === true;
  // The admin decision is a server-owned historical fact. Cancellation alone must not
  // turn an already-earned 5% receipt into a 0.2% refund. Customer/owner changes do invalidate it.
  if (!valid) { diagnose(diagnostics, order, "APPROVAL_IDENTITY_OR_TIME_INVALID"); return null; }
  return reviewedAt;
}

function paymentEvents(order, nowMs, diagnostics) {
  const events = [];
  const seen = new Set();
  for (const payment of list(order.payments)) {
    if (payment?.verificationStatus != null && payment.verificationStatus !== "" && payment.verificationStatus !== "verified") continue;
    const id = text(payment.id) || text(payment.statementId) || hash([payment.type, payment.time, payment.channel, payment.externalTransactionNo]);
    if (seen.has(id)) { diagnose(diagnostics, order, "DUPLICATE_PAYMENT_SOURCE", id); continue; }
    seen.add(id);
    const amount = cents(payment.amount);
    const at = timestamp(text(payment.verifiedAt) || payment.time);
    if (amount == null || amount <= 0) { diagnose(diagnostics, order, "INVALID_PAYMENT_AMOUNT", id); continue; }
    if (!Number.isFinite(at) || at < commissionOrderCreatedAtMs(order) || at < START || at > nowMs) {
      diagnose(diagnostics, order, "INVALID_PAYMENT_VERIFICATION_TIME", id); continue;
    }
    if (!text(payment.verifiedAt)) diagnose(diagnostics, order, "LEGACY_PAYMENT_TIME_FALLBACK", id);
    events.push({ id: `payment:${id}`, type: payment.type === "refund" ? "refund" : payment.type === "shipping_fee" ? "shipping" : "receipt", amount, at, sourceType: "payment" });
  }
  return events;
}

function settlementGroups(state, rows, diagnostics) {
  const orders = list(state.orders);
  const lookup = new Map();
  for (const order of orders) {
    if (text(order.source) !== "平台下单") continue;
    const key = normalizeExternalOrderNo(order.douyinOrderNo || order.platformOrderNo);
    if (key) lookup.set(key, [...(lookup.get(key) || []), order]);
  }
  const groups = new Map();
  const seen = new Set();
  for (const row of list(rows)) {
    const data = row?.data && typeof row.data === "object" ? row.data : row;
    if (text(row.platform || data.platform) && text(row.platform || data.platform) !== "douyin") continue;
    const key = normalizeExternalOrderNo(row.external_order_no || data.externalOrderNo);
    const matches = lookup.get(key) || [];
    if (matches.length !== 1) {
      if (matches.length > 1) for (const order of matches) {
        diagnose(diagnostics, order, "AMBIGUOUS_PLATFORM_ORDER");
        // An ambiguous authoritative settlement is not permission to fall back
        // to potentially mirrored order payments.
        if (!groups.has(text(order.id))) groups.set(text(order.id), []);
      }
      else diagnostics.push({ orderId: "", code: "UNMATCHED_PLATFORM_ORDER", externalOrderNo: key, sourceId: text(row.id || row.fingerprint || data.fingerprint) });
      continue;
    }
    const order = matches[0];
    if (text(row.site_id || data.siteId) && text(row.site_id || data.siteId) !== text(order.siteId)) {
      diagnose(diagnostics, order, "PLATFORM_SITE_MISMATCH");
      if (!groups.has(text(order.id))) groups.set(text(order.id), []);
      continue;
    }
    const id = text(row.fingerprint || data.fingerprint || row.id) || hash([key, data.subOrderNo, row.settlement_time || data.settlementTime, data.settlementType, data.userPaid, data.preSettlementRefund, data.incomeTotal]);
    if (seen.has(id)) { diagnose(diagnostics, order, "DUPLICATE_PLATFORM_SOURCE", id); continue; }
    seen.add(id);
    groups.set(text(order.id), [...(groups.get(text(order.id)) || []), { ...data, id, at: row.settlement_time || data.settlementTime }]);
  }
  return groups;
}

function platformEvents(order, rows, nowMs, diagnostics) {
  const events = [];
  for (const row of rows) {
    if (row.verificationStatus === "pending" || row.status === "pending") continue;
    const at = timestamp(row.verifiedAt || row.at);
    if (!Number.isFinite(at) || at < commissionOrderCreatedAtMs(order) || at < START || at > nowMs) {
      diagnose(diagnostics, order, "INVALID_PLATFORM_VERIFICATION_TIME", row.id); continue;
    }
    const paid = cents(row.userPaid);
    if (!missing(row.userPaid) && paid == null) { diagnose(diagnostics, order, "INVALID_PLATFORM_PAID_AMOUNT", row.id); continue; }
    if (!missing(row.preSettlementRefund) && cents(row.preSettlementRefund) == null) { diagnose(diagnostics, order, "INVALID_PLATFORM_REFUND_AMOUNT", row.id); continue; }
    const refund = Math.abs(cents(row.preSettlementRefund) ?? 0);
    const isRefundRow = /退款|refund/i.test(text(row.settlementType));
    if (paid != null) {
      if (paid > 0 && !isRefundRow) events.push({ id: `platform:${row.id}:receipt`, type: "receipt", amount: paid, at, sourceType: "platform_user_paid" });
      // A negative user-paid amount is itself the refund; never count its absolute
      // amount and the same pre-settlement refund twice.
      const refundAmount = Math.max(paid < 0 ? -paid : 0, refund);
      if (refundAmount) events.push({ id: `platform:${row.id}:refund`, type: "refund", amount: refundAmount, at, sourceType: "platform_user_paid" });
      else if (isRefundRow && paid > 0) diagnose(diagnostics, order, "PLATFORM_REFUND_AMOUNT_AMBIGUOUS", row.id);
    } else {
      const income = cents(row.incomeTotal);
      if (income == null) { diagnose(diagnostics, order, "PLATFORM_PAID_AMOUNT_MISSING", row.id); continue; }
      diagnose(diagnostics, order, "PLATFORM_NET_INCOME_FALLBACK", row.id);
      // incomeTotal is already net of preSettlementRefund. Platform expenses and
      // settlementAmount are intentionally not used as customer receipts/refunds.
      if (income) events.push({ id: `platform:${row.id}:net`, type: income > 0 ? "receipt" : "refund", amount: Math.abs(income), at, sourceType: "platform_net_income" });
    }
  }
  return events;
}

function outstanding(lots) { return lots.reduce((sums, lot) => sums.map((sum, index) => sum + lot.parts[index]), [0, 0, 0, 0]); }
const allocationHash = (lots) => hash(lots.map((lot) => [lot.sourceId, lot.type, lot.parts]));
function position(lots, hasOwner) {
  const regular = lots.filter((lot) => !lot.newCustomer).reduce((sum, lot) => sum + lot.parts[0], 0);
  const acquisition = lots.filter((lot) => lot.newCustomer).reduce((sum, lot) => sum + lot.parts[0], 0);
  return { baseCents: regular + acquisition, regularPersonalCents: hasOwner ? ratio(regular, 2, 1000) : 0, newCustomerCents: hasOwner ? ratio(acquisition, 50, 1000) : 0, teamPoolCents: ratio(regular, 3, 1000) };
}

function desiredOrderTargets(state, order, platformRows, nowMs, diagnostics, receiptSnapshots, refundSnapshots) {
  const targets = {};
  if (!isCommissionEligibleOrder(order, nowMs)) { diagnose(diagnostics, order, "ORDER_CREATED_BEFORE_POLICY_OR_UNRELIABLE"); return targets; }
  const caps = feeCaps(state, order, diagnostics);
  if (!caps) return targets;
  const owner = resolveNewCustomerOrderOwner(state.personnel, order);
  if (!owner) diagnose(diagnostics, order, "ORDER_OWNER_UNRESOLVED");
  const approvedAt = approvalTime(state, order, owner, nowMs, diagnostics);
  const events = platformRows ? platformEvents(order, platformRows, nowMs, diagnostics) : paymentEvents(order, nowMs, diagnostics);
  if (platformRows && list(order.payments).length) diagnose(diagnostics, order, "PLATFORM_REPLACES_ORDER_PAYMENTS");
  if (approvedAt != null) events.push({ id: `approval:${order.newCustomerApproval.requestId}`, type: "approval", at: approvedAt, sourceType: "new_customer_approval" });
  const priority = { shipping: 0, receipt: 1, approval: 2, refund: 3 };
  const sequence = (event) => receiptSnapshots[hash([text(order.id), event.id])]?.sequence ?? Number.MAX_SAFE_INTEGER;
  events.sort((a, b) => a.at - b.at || sequence(a) - sequence(b) || priority[a.type] - priority[b.type] || a.id.localeCompare(b.id));
  const lots = [];
  let approved = false;
  let unallocatedRefundCents = 0;
  for (const event of events) {
    const before = position(lots, Boolean(owner));
    if (event.type === "approval") {
      approved = true;
      for (const lot of lots) lot.newCustomer = true;
    } else if (event.type === "receipt" || event.type === "shipping") {
      const current = outstanding(lots);
      if (!Number.isSafeInteger(current.reduce((sum, value) => sum + value, 0) + event.amount)) {
        diagnose(diagnostics, order, "PAYMENT_SUM_EXCEEDS_SAFE_RANGE", event.id); continue;
      }
      const receiptKey = hash([text(order.id), event.id]);
      const snapshot = receiptSnapshots[receiptKey];
      // Cash allocation is fixed when that source is first verified. A return
      // removes order items before its refund is verified; recomputing against
      // those smaller items would fabricate an early cash refund. A genuine
      // correction to the verified source amount can still produce a current-
      // month adjustment using the original receivable allocation context.
      const receiptCaps = snapshot?.type === event.type ? snapshot.caps : caps;
      const beforeHash = allocationHash(lots);
      const remaining = receiptCaps.map((cap, index) => Math.max(0, cap - current[index]));
      let reallocations = [];
      let parts;
      if (snapshot?.type === event.type && snapshot.amountCents === event.amount && snapshot.allocationBeforeHash === beforeHash) {
        parts = [...snapshot.parts];
        reallocations = snapshot.reallocations || [];
        for (const reallocation of reallocations) {
          const lot = lots.find((item) => item.sourceId === reallocation.sourceId);
          if (!lot) throw new Error("Commission receipt reallocation is invalid; manual audit is required");
          lot.parts = [...reallocation.parts];
        }
      } else if (event.type === "shipping") {
        const previousDedicated = lots.filter((lot) => lot.type === "shipping").reduce((sum, lot) => sum + lot.parts[1], 0);
        const assigned = Math.min(event.amount, Math.max(0, receiptCaps[1] - previousDedicated));
        let toReplace = Math.max(0, assigned - remaining[1]);
        // A later dedicated freight payment takes over freight previously funded
        // by an ordinary receipt. Reclassify that ordinary cash to the remaining
        // goods/packaging balance; freight itself still has zero goods value.
        // This gets its own event delta, and the saved transformation survives
        // later pending returns without retroactively resizing historical lots.
        for (const lot of lots) {
          if (lot.type !== "receipt" || !toReplace) continue;
          const freed = Math.min(toReplace, lot.parts[1]);
          if (!freed) continue;
          const balances = outstanding(lots);
          const weights = [Math.max(0, receiptCaps[0] - balances[0]), Math.max(0, receiptCaps[2] - balances[2])];
          const applied = Math.min(freed, weights[0] + weights[1]);
          const [goods, packaging] = allocate(applied, weights);
          lot.parts = [lot.parts[0] + goods, lot.parts[1] - freed, lot.parts[2] + packaging, lot.parts[3] + freed - applied];
          reallocations.push({ sourceId: lot.sourceId, parts: [...lot.parts] });
          toReplace -= freed;
        }
        parts = [0, assigned, 0, event.amount - assigned];
      } else {
        const assigned = Math.min(event.amount, remaining.reduce((sum, value) => sum + value, 0));
        parts = [...allocate(assigned, remaining), event.amount - assigned];
      }
      receiptSnapshots[receiptKey] = {
        orderId: text(order.id), sourceId: event.id, type: event.type, amountCents: event.amount, caps: [...receiptCaps], parts: [...parts],
        allocationBeforeHash: beforeHash, reallocations,
        sequence: snapshot?.sequence ?? Object.keys(receiptSnapshots).length + 1,
      };
      const lot = { parts, newCustomer: approved, sourceId: event.id, type: event.type };
      lots.push(lot);
      if (unallocatedRefundCents > 0) {
        // Finance can verify a refund before the corresponding receipt is
        // reconciled. Keep that cash debt instead of dropping it and granting
        // commission on the later receipt as though the refund never happened.
        let toOffset = Math.min(unallocatedRefundCents, event.amount);
        const extra = Math.min(toOffset, lot.parts[3]);
        lot.parts[3] -= extra; toOffset -= extra; unallocatedRefundCents -= extra;
        const takes = allocate(toOffset, lot.parts.slice(0, 3));
        lot.parts = lot.parts.map((part, index) => part - (takes[index] || 0));
        unallocatedRefundCents -= toOffset;
      }
    } else {
      let remainingRefund = event.amount;
      const refundKey = hash([text(order.id), event.id]);
      const refundSnapshot = refundSnapshots[refundKey] || { orderId: text(order.id), sourceId: event.id, goodsCapCents: caps[0] };
      refundSnapshots[refundKey] = refundSnapshot;
      // Returned goods can already be absent from order.items while their old
      // verified receipt is frozen pending the refund. Settle that earned-goods
      // liability before a later overpayment; otherwise the actual return could
      // be disguised as returning the unrelated extra cash and never claw back
      // the returned fish's commission. No such adjustment occurs while pending.
      const goodsWeights = lots.map((lot) => lot.parts[0]);
      const frozenExcess = Math.max(0, goodsWeights.reduce((sum, value) => sum + value, 0) - refundSnapshot.goodsCapCents);
      const returnedGoods = Math.min(remainingRefund, frozenExcess);
      const goodsTakes = allocate(returnedGoods, goodsWeights);
      lots.forEach((lot, index) => { lot.parts[0] -= goodsTakes[index]; });
      remainingRefund -= returnedGoods;
      // Overpayments were never commissionable. Return them before reducing an
      // earned merchandise commission (e.g. 200 paid for 100 goods, 100 returned).
      for (const lot of lots) {
        const take = Math.min(remainingRefund, lot.parts[3]);
        lot.parts[3] -= take; remainingRefund -= take;
      }
      const weights = lots.map((lot) => lot.parts.slice(0, 3).reduce((sum, value) => sum + value, 0));
      const available = weights.reduce((sum, value) => sum + value, 0);
      const assigned = Math.min(remainingRefund, available);
      const takes = allocate(assigned, weights);
      lots.forEach((lot, index) => {
        const partTakes = allocate(takes[index], lot.parts.slice(0, 3));
        lot.parts = lot.parts.map((part, partIndex) => part - (partTakes[partIndex] || 0));
      });
      if (remainingRefund > available) {
        unallocatedRefundCents += remainingRefund - available;
        diagnose(diagnostics, order, "REFUND_EXCEEDS_VERIFIED_RECEIPTS", event.id);
      }
    }
    const after = position(lots, Boolean(owner));
    const delta = Object.fromEntries(VECTOR.map((key) => [key, after[key] - before[key]]));
    if (!VECTOR.some((key) => delta[key])) continue;
    const personnelId = text(owner?.id);
    const target = { orderId: text(order.id), personnelId, personnelName: text(owner?.name || owner?.username), sourceId: event.id, sourceType: event.sourceType, eventAt: new Date(event.at).toISOString(), ...delta };
    targets[hash([target.orderId, target.sourceId, personnelId])] = target;
  }
  return targets;
}

function validLedger(value) {
  if (value == null) return false;
  if (value.version !== 1 || !value.targets || typeof value.targets !== "object" || Array.isArray(value.targets) || !Array.isArray(value.entries)) throw new Error("Commission ledger is invalid; manual audit is required");
  for (const record of [...Object.values(value.targets), ...value.entries]) {
    if (!record || !VECTOR.every((key) => Number.isSafeInteger(record[key]))) throw new Error("Commission ledger contains invalid amounts; manual audit is required");
  }
  if (value.receiptSnapshots != null && (typeof value.receiptSnapshots !== "object" || Array.isArray(value.receiptSnapshots))) throw new Error("Commission receipt snapshots are invalid; manual audit is required");
  for (const snapshot of Object.values(value.receiptSnapshots || {})) {
    if (!snapshot || !["receipt", "shipping"].includes(snapshot.type) || !Number.isSafeInteger(snapshot.amountCents) || snapshot.amountCents <= 0 ||
        !Array.isArray(snapshot.parts) || snapshot.parts.length !== 4 || !Array.isArray(snapshot.caps) || snapshot.caps.length !== 3 ||
        ![...snapshot.parts, ...snapshot.caps].every((value) => Number.isSafeInteger(value) && value >= 0) || snapshot.parts.reduce((sum, value) => sum + value, 0) !== snapshot.amountCents) {
      throw new Error("Commission receipt snapshots contain invalid amounts; manual audit is required");
    }
    if (snapshot.reallocations != null && (!Array.isArray(snapshot.reallocations) || snapshot.reallocations.some((item) => !text(item.sourceId) || !Array.isArray(item.parts) || item.parts.length !== 4 || !item.parts.every((amount) => Number.isSafeInteger(amount) && amount >= 0)))) throw new Error("Commission receipt reallocations are invalid; manual audit is required");
  }
  if (value.refundSnapshots != null && (typeof value.refundSnapshots !== "object" || Array.isArray(value.refundSnapshots))) throw new Error("Commission refund snapshots are invalid; manual audit is required");
  for (const snapshot of Object.values(value.refundSnapshots || {})) {
    if (!snapshot || !text(snapshot.orderId) || !text(snapshot.sourceId) || !Number.isSafeInteger(snapshot.goodsCapCents) || snapshot.goodsCapCents < 0) throw new Error("Commission refund snapshots contain invalid amounts; manual audit is required");
  }
  return true;
}

// Only explicit, authorized price/fee correction routes may invalidate receipt
// allocation context. Returns/stock removal and pending refunds must not call
// this helper: they are not cash corrections. The next reconciliation appends
// any changed target amounts in its current month and keeps all old entries.
export function invalidateCommissionAllocations(ledger, orderIds = []) {
  if (!validLedger(ledger)) return ledger;
  const ids = new Set((Array.isArray(orderIds) ? orderIds : [orderIds]).map(text).filter(Boolean));
  if (!ids.size) return ledger;
  const previous = ledger.receiptSnapshots || {};
  const receiptSnapshots = Object.fromEntries(Object.entries(previous).filter(([, snapshot]) => !ids.has(text(snapshot.orderId))));
  const previousRefunds = ledger.refundSnapshots || {};
  const refundSnapshots = Object.fromEntries(Object.entries(previousRefunds).filter(([, snapshot]) => !ids.has(text(snapshot.orderId))));
  return Object.keys(previous).length === Object.keys(receiptSnapshots).length && Object.keys(previousRefunds).length === Object.keys(refundSnapshots).length ? ledger : { ...ledger, receiptSnapshots, refundSnapshots };
}

export function reconcileCommissionLedger(state = {}, platformSettlementRows = [], now = new Date()) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid commission reconciliation time");
  const currentMonth = commissionMonth(nowMs);
  const recordedAt = new Date(nowMs).toISOString();
  const initialized = validLedger(state.commissionLedgerV1);
  const previous = initialized ? state.commissionLedgerV1 : { version: 1, initializedAt: recordedAt, targets: {}, entries: [] };
  const receiptSnapshots = { ...(previous.receiptSnapshots || {}) };
  const refundSnapshots = { ...(previous.refundSnapshots || {}) };
  const diagnostics = [];
  const platformByOrder = settlementGroups(state, platformSettlementRows, diagnostics);
  const targets = {};
  const orders = list(state.orders);
  const idCounts = new Map();
  orders.forEach((order) => idCounts.set(text(order?.id), (idCounts.get(text(order?.id)) || 0) + 1));
  for (const order of orders) {
    if (!text(order?.id) || idCounts.get(text(order.id)) !== 1) { diagnose(diagnostics, order, "ORDER_ID_MISSING_OR_DUPLICATED"); continue; }
    Object.assign(targets, desiredOrderTargets(state, order, platformByOrder.get(text(order.id)), nowMs, diagnostics, receiptSnapshots, refundSnapshots));
  }
  const entries = [...previous.entries];
  let changed = !initialized;
  for (const key of [...new Set([...Object.keys(previous.targets), ...Object.keys(targets)])].sort()) {
    const before = previous.targets[key];
    const after = targets[key];
    const delta = Object.fromEntries(VECTOR.map((field) => [field, (after?.[field] || 0) - (before?.[field] || 0)]));
    if (!VECTOR.some((field) => delta[field])) continue;
    const target = after || before;
    entries.push({ ...target, ...delta, id: `commission-${entries.length + 1}-${hash([key, recordedAt, delta]).slice(0, 16)}`, month: initialized ? currentMonth : commissionMonth(target.eventAt), recordedAt, reason: initialized ? "source_adjustment" : "initial" });
    changed = true;
  }
  // PostgreSQL JSONB reorders object keys; equality must not cause a write on
  // every read merely because the database normalized serialization order.
  if (Object.keys(targets).length !== Object.keys(previous.targets).length || Object.entries(targets).some(([key, target]) =>
    !previous.targets[key] || TARGET_FIELDS.some((field) => target[field] !== previous.targets[key][field]))) changed = true;
  if (Object.keys(receiptSnapshots).length !== Object.keys(previous.receiptSnapshots || {}).length || Object.entries(receiptSnapshots).some(([key, snapshot]) => {
    const old = previous.receiptSnapshots?.[key];
    return !old || ["orderId", "sourceId", "type", "amountCents", "allocationBeforeHash", "sequence"].some((field) => snapshot[field] !== old[field]) || snapshot.caps.some((value, index) => value !== old.caps[index]) || snapshot.parts.some((value, index) => value !== old.parts[index]) ||
      (snapshot.reallocations || []).length !== (old.reallocations || []).length || (snapshot.reallocations || []).some((item, index) => item.sourceId !== old.reallocations[index].sourceId || item.parts.some((value, partIndex) => value !== old.reallocations[index].parts[partIndex]));
  })) changed = true;
  if (Object.keys(refundSnapshots).length !== Object.keys(previous.refundSnapshots || {}).length) changed = true;
  const ledger = changed ? { version: 1, initializedAt: previous.initializedAt, targets, entries, receiptSnapshots, refundSnapshots } : previous;
  const totals = new Map();
  for (const entry of ledger.entries) {
    const total = totals.get(entry.orderId) || empty();
    for (const key of VECTOR) total[key] += entry[key];
    totals.set(entry.orderId, total);
  }
  const acquisitionOrders = new Set(Object.values(targets).filter((target) => target.newCustomerCents !== 0).map((target) => target.orderId));
  const byOrder = new Map(orders.map((order) => {
    const total = totals.get(text(order.id)) || empty();
    const eligible = isCommissionEligibleOrder(order, nowMs);
    const hasNewCustomer = acquisitionOrders.has(text(order.id));
    return [text(order.id), { commissionBase: money(total.baseCents), personalCommissionAmount: money(total.regularPersonalCents + total.newCustomerCents), teamCommissionAmount: money(total.teamPoolCents), newCustomerCommissionAmount: money(total.newCustomerCents), commissionAmount: money(total.regularPersonalCents + total.newCustomerCents), commissionPolicyLabel: !eligible ? "政策生效前或创建时间待核对，不计提" : hasNewCustomer ? "新客个人 5%（替代普通提成）" : "普通个人 0.2% + 团队公共池 0.3%", commissionEligible: eligible }];
  }));
  return { ledger, changed, byOrder, diagnostics };
}

export function personalCommissionSummary(ledger, personnelId, month) {
  validMonth(month);
  const totals = list(ledger?.entries).filter((entry) => entry.month === month && text(entry.personnelId) === text(personnelId) && text(personnelId)).reduce((sum, entry) => ({ regular: sum.regular + entry.regularPersonalCents, acquisition: sum.acquisition + entry.newCustomerCents }), { regular: 0, acquisition: 0 });
  return { month, policyEffectiveDate: COMMISSION_POLICY_EFFECTIVE_DATE, personalAmount: money(totals.regular + totals.acquisition), newCustomerAmount: money(totals.acquisition), regularPersonalAmount: money(totals.regular) };
}

export function monthlyCommissionSummary(ledger, personnel = [], month) {
  validMonth(month);
  const entries = list(ledger?.entries).filter((entry) => entry.month === month);
  const people = new Map(list(personnel).map((person) => [text(person.id), text(person.name || person.username)]));
  const sums = new Map();
  for (const entry of entries) {
    if (!entry.personnelId) continue;
    const sum = sums.get(entry.personnelId) || { regular: 0, acquisition: 0, name: people.get(entry.personnelId) || entry.personnelName || "人员已删除" };
    sum.regular += entry.regularPersonalCents; sum.acquisition += entry.newCustomerCents;
    sums.set(entry.personnelId, sum);
  }
  const rows = [...sums.entries()].map(([personnelId, sum]) => ({ personnelId, name: sum.name, personalAmount: money(sum.regular + sum.acquisition), newCustomerAmount: money(sum.acquisition), regularPersonalAmount: money(sum.regular) })).sort((a, b) => b.personalAmount - a.personalAmount || a.personnelId.localeCompare(b.personnelId));
  const regular = entries.reduce((sum, entry) => sum + entry.regularPersonalCents, 0);
  const acquisition = entries.reduce((sum, entry) => sum + entry.newCustomerCents, 0);
  return { month, policyEffectiveDate: COMMISSION_POLICY_EFFECTIVE_DATE, personalTotal: money(regular + acquisition), newCustomerTotal: money(acquisition), regularPersonalTotal: money(regular), teamPoolTotal: money(entries.reduce((sum, entry) => sum + entry.teamPoolCents, 0)), rows, orderCount: new Set(entries.map((entry) => entry.orderId)).size };
}
