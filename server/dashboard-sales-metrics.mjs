const ACTUALLY_SHIPPED_STATUSES = new Set(["shipped", "delivered", "damaged"]);
const array = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();

function money(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function recordedAmount(value) {
  if (value == null || text(value) === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? money(amount) : null;
}

export function dashboardDatePart(value) {
  const date = text(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function comparableMoment(value) {
  const raw = text(value);
  if (!raw) return "";
  const normalized = raw.replace(" ", "T");
  return normalized.length === 10 ? `${normalized}T00:00:00` : normalized;
}

/** Statement matching must not move an order operation into another business day. */
export function dashboardPaymentRecordedAt(payment = {}) {
  const original = payment?.statementOriginal && typeof payment.statementOriginal === "object"
    ? payment.statementOriginal : null;
  return comparableMoment(original?.time || payment?.time);
}

export function unshippedRefundRecordedAt(payment = {}) {
  return comparableMoment(payment?.refundOccurredAt) || dashboardPaymentRecordedAt(payment);
}

function shipmentWasActuallyFulfilled(shipment = {}) {
  const status = text(shipment?.status);
  if (shipment?.shipMethod === "pickup" && status !== "preparing") return true;
  return ACTUALLY_SHIPPED_STATUSES.has(status) || Boolean(text(shipment?.shippedAt));
}

export function shipmentFulfilledAt(shipment = {}) {
  if (!shipmentWasActuallyFulfilled(shipment)) return "";
  const candidates = shipment?.shipMethod === "pickup"
    ? [shipment.deliveredAt, shipment.shippedAt, shipment.outboundDate, shipment.createdAt, shipment.shipDate]
    : [shipment.shippedAt, shipment.deliveredAt, shipment.shipDate, shipment.outboundDate, shipment.createdAt];
  return candidates.map(comparableMoment).find(Boolean) ?? "";
}

export function dashboardRefundStage(payment = {}, orderShipments = []) {
  const snapshot = payment?.refundStage ?? payment?.statementOriginal?.refundStage;
  if (["before_shipment", "after_shipment"].includes(snapshot)) return { stage: snapshot, estimated: false };
  const fulfilledAt = array(orderShipments).map(shipmentFulfilledAt).filter(Boolean).sort()[0] ?? "";
  const refundAt = unshippedRefundRecordedAt(payment);
  return {
    stage: !fulfilledAt || (refundAt && refundAt < fulfilledAt) ? "before_shipment" : "after_shipment",
    estimated: true,
  };
}

export function isUnshippedOrderRefund(payment = {}, orderShipments = []) {
  return payment?.type === "refund" && dashboardRefundStage(payment, orderShipments).stage === "before_shipment";
}

/** Original sale totals are independent of later refunds, returns and freight reconciliation. */
export function dashboardOrderSaleAmount(order = {}) {
  const snapshot = order?.salesAmountSnapshot;
  const amount = recordedAmount(snapshot?.amount);
  if (amount != null && ["created", "legacy"].includes(snapshot?.source)) {
    return { amount, legacy: snapshot.source === "legacy" };
  }
  const shippingMode = ["线下", "线下自提"].includes(text(order?.source))
    ? "collect" : ["collect", "free"].includes(order?.shippingFeeMode) ? order.shippingFeeMode : "prepaid";
  return {
    amount: money(Math.max(0,
      array(order?.items).reduce((sum, item) => sum + money(item?.price), 0) +
      (shippingMode === "prepaid" ? Math.max(0, money(order?.shippingFee)) : 0) +
      Math.max(0, money(order?.packagingFee)) - Math.max(0, money(order?.discount))
    )),
    legacy: true,
  };
}

function possibleReceiptMatch(claim, payment) {
  if (text(claim?.channel) && text(payment?.channel) && text(claim.channel) !== text(payment.channel)) return false;
  if (text(claim?.account) && text(payment?.account) && text(claim.account) !== text(payment.account)) return false;
  const claimTransaction = text(claim?.externalTransactionNo);
  const paymentTransaction = text(payment?.externalTransactionNo);
  if (claimTransaction && paymentTransaction) return claimTransaction === paymentTransaction;
  return money(claim?.amount) === money(payment?.amount) && Boolean(dashboardDatePart(claim?.time)) &&
    dashboardDatePart(claim?.time) === dashboardDatePart(dashboardPaymentRecordedAt(payment));
}

/** Only explicit one-to-one references merge receipts. Similar amounts are warnings, never merge keys. */
export function dashboardOrderReceipts(order = {}) {
  const payments = array(order?.payments).filter(payment => payment?.type !== "refund" && recordedAmount(payment?.amount) > 0);
  const claims = array(order?.paymentClaims).filter(claim => claim?.status !== "rejected" && recordedAmount(claim?.amount) > 0);
  const paymentById = new Map(), paymentsByClaimId = new Map();
  for (const [index, payment] of payments.entries()) {
    if (text(payment.id)) paymentById.set(text(payment.id), [...(paymentById.get(text(payment.id)) ?? []), index]);
    if (text(payment.paymentProofClaimId)) paymentsByClaimId.set(text(payment.paymentProofClaimId), [...(paymentsByClaimId.get(text(payment.paymentProofClaimId)) ?? []), index]);
  }
  const claimIdCounts = new Map();
  for (const claim of claims) if (text(claim.id)) claimIdCounts.set(text(claim.id), (claimIdCounts.get(text(claim.id)) ?? 0) + 1);
  const referencedIndexes = claims.map(claim => new Set([
      ...(text(claim.paymentId) ? paymentById.get(text(claim.paymentId)) ?? [] : []),
      ...(text(claim.id) ? paymentsByClaimId.get(text(claim.id)) ?? [] : []),
  ]));
  const candidateLinks = claims.map((claim, claimIndex) => {
    const indexes = referencedIndexes[claimIndex];
    if (indexes.size !== 1 || (text(claim.id) && claimIdCounts.get(text(claim.id)) !== 1)) return null;
    const index = [...indexes][0], payment = payments[index];
    if (text(claim.paymentId) && text(claim.paymentId) !== text(payment.id)) return null;
    if (text(payment.paymentProofClaimId) && text(payment.paymentProofClaimId) !== text(claim.id)) return null;
    return index;
  });
  const linkCounts = new Map();
  for (const index of candidateLinks) if (index != null) linkCounts.set(index, (linkCounts.get(index) ?? 0) + 1);
  const linkedPaymentIndexes = new Set(candidateLinks.filter(index => index != null && linkCounts.get(index) === 1));
  const receipts = [];
  for (const [index, payment] of payments.entries()) {
    if (!linkedPaymentIndexes.has(index)) receipts.push({ amount: money(payment.amount), time: dashboardPaymentRecordedAt(payment), possibleDuplicate: false });
  }
  for (const [index, claim] of claims.entries()) {
    const paymentIndex = candidateLinks[index];
    const linked = paymentIndex != null && linkCounts.get(paymentIndex) === 1;
    const payment = linked ? payments[paymentIndex] : null;
    const possibleIndexes = linked ? [] : payments.flatMap((candidate, candidateIndex) =>
      referencedIndexes[index].has(candidateIndex) ||
      (!linkedPaymentIndexes.has(candidateIndex) && possibleReceiptMatch(claim, candidate)) ? [candidateIndex] : []);
    receipts.push({
      amount: money(payment ? payment.amount : claim.amount),
      time: comparableMoment(claim.time) || (payment ? dashboardPaymentRecordedAt(payment) : ""),
      possibleDuplicate: possibleIndexes.length > 0,
      possibleDuplicateDates: possibleIndexes.map(candidateIndex => dashboardDatePart(dashboardPaymentRecordedAt(payments[candidateIndex]))),
    });
  }
  return receipts;
}

export function shipmentDamagedAt(shipment = {}, order = {}) {
  if (text(shipment?.status) !== "damaged") return "";
  const refundTime = array(order?.payments)
    .filter(payment => payment?.type === "refund" && dashboardRefundStage(payment, [shipment]).stage === "after_shipment")
    .map(unshippedRefundRecordedAt).filter(Boolean).sort()[0];
  return comparableMoment(shipment?.damagedAt) || refundTime || comparableMoment(shipment?.deliveredAt) ||
    comparableMoment(shipment?.shippedAt) || comparableMoment(shipment?.shipDate) || comparableMoment(shipment?.createdAt);
}

function replacementEventAmount(event) {
  const total = recordedAmount(event?.replacementSaleAmount);
  if (total != null) return { amount: total, missingPriceCount: 0 };
  const replacements = array(event?.replacements);
  let amount = 0, missingPriceCount = replacements.length ? 0 : 1;
  for (const replacement of replacements) {
    const price = recordedAmount(replacement?.replacementSalePrice);
    if (price == null) missingPriceCount += 1;
    else amount += price;
  }
  return { amount: money(amount), missingPriceCount };
}

/** A shipment's append-only events replace, rather than add to, its current damage fields. */
export function dashboardReplacementEvents(shipment = {}, order = {}) {
  const events = array(shipment?.damageEvents);
  if (events.length) {
    const seen = new Set();
    return events.filter(event => {
      if (event?.resolution !== "reship") return false;
      const id = text(event?.id);
      if (id && seen.has(id)) return false;
      if (id) seen.add(id);
      return true;
    }).map(event => ({ time: comparableMoment(event?.time), ...replacementEventAmount(event) }));
  }
  if (shipment?.damageResolution !== "reship") return [];
  return [{ time: shipmentDamagedAt(shipment, order), ...replacementEventAmount({ replacements: shipment?.damageReplacements }) }];
}

/** Receivable reductions and original fish prices are not cash refunds or replacement value. */
export function shipmentDamageAmount(shipment = {}, order = {}) {
  return money(dashboardReplacementEvents(shipment, order).reduce((sum, event) => sum + event.amount, 0));
}

function warningCollector() {
  const warnings = {
    legacyOrderAmountCount: 0, possibleDuplicateReceiptCount: 0, estimatedRefundStageCount: 0,
    missingReplacementPriceCount: 0, unmatchedRefundCount: 0, correctedFulfillmentRefundCount: 0,
    details: { legacyOrderAmount: [], possibleDuplicateReceipt: [], estimatedRefundStage: [], missingReplacementPrice: [], unmatchedRefund: [], correctedFulfillmentRefund: [] },
  };
  const seen = new Map();
  return { warnings, add(kind, count, order) {
    if (count <= 0) return;
    warnings[`${kind}Count`] += count;
    const id = text(order?.id), orderNo = text(order?.orderNo), key = id || orderNo;
    if (!key) return;
    const keys = seen.get(kind) ?? new Set();
    if (!keys.has(key) && warnings.details[kind].length < 20) warnings.details[kind].push({ orderId: id, orderNo });
    keys.add(key); seen.set(kind, keys);
  } };
}

/** Business registrations shared by server and browser, independent of finance verification and commissions. */
export function buildDashboardSalesMetrics({
  dates = [], orders = [], shipments = [], shipmentsByOrderId,
  isPlatformOrderSource = () => false, isOfflinePickupOrder = () => false,
} = {}) {
  const buckets = new Map(array(dates).map(date => [date, {
    received: 0, unshippedRefund: 0, shippedDamage: 0, orderAmount: 0,
    platformAmount: 0, offlinePickupAmount: 0, privateDomainAmount: 0,
  }]));
  const { warnings, add } = warningCollector();
  const indexedShipments = shipmentsByOrderId ?? new Map();
  if (!shipmentsByOrderId) for (const shipment of array(shipments)) {
    const key = text(shipment?.orderId);
    indexedShipments.set(key, [...(indexedShipments.get(key) ?? []), shipment]);
  }
  const orderById = new Map();
  for (const order of array(orders)) {
    const orderId = text(order?.id);
    orderById.set(orderId, order);
    const orderShipments = indexedShipments.get(orderId) ?? [];
    const hasCorrectedFulfillment = orderShipments.some(shipment => Boolean(shipment?.fulfillmentCorrection));
    const salesBucket = buckets.get(dashboardDatePart(order?.date));
    if (salesBucket) {
      const sale = dashboardOrderSaleAmount(order);
      salesBucket.orderAmount += sale.amount;
      if (isPlatformOrderSource(order?.source)) salesBucket.platformAmount += sale.amount;
      if (isOfflinePickupOrder(order, orderShipments)) salesBucket.offlinePickupAmount += sale.amount;
      if (text(order?.source) === "私域线上") salesBucket.privateDomainAmount += sale.amount;
      if (sale.legacy) add("legacyOrderAmount", 1, order);
    }
    const receipts = dashboardOrderReceipts(order);
    for (const receipt of receipts) {
      const bucket = buckets.get(dashboardDatePart(receipt.time));
      if (bucket) bucket.received += receipt.amount;
      if (receipt.possibleDuplicate && (bucket || receipt.possibleDuplicateDates.some(date => buckets.has(date)))) {
        add("possibleDuplicateReceipt", 1, order);
      }
    }
    const refunds = array(order?.payments).filter(payment => payment?.type === "refund" && recordedAmount(payment?.amount) > 0)
      .map(payment => ({ time: unshippedRefundRecordedAt(payment), amount: money(payment.amount), ...dashboardRefundStage(payment, orderShipments) }));
    // Missing old receipt history is a warning, never a reason to erase a registered refund.
    let available = 0;
    const cashEvents = [...receipts.map(receipt => ({ ...receipt, refund: false })), ...refunds.map(refund => ({ ...refund, refund: true }))]
      .filter(event => dashboardDatePart(event.time))
      .sort((a, b) => a.time.localeCompare(b.time) || Number(a.refund) - Number(b.refund));
    for (const event of cashEvents) {
      if (!event.refund) { available += event.amount; continue; }
      const bucket = buckets.get(dashboardDatePart(event.time));
      if (bucket) {
        bucket[event.stage === "before_shipment" ? "unshippedRefund" : "shippedDamage"] += event.amount;
        if (event.estimated) add("estimatedRefundStage", 1, order);
        // A later logistics correction must not silently rewrite a registered cash report.
        if (hasCorrectedFulfillment) add("correctedFulfillmentRefund", 1, order);
        if (event.amount - available > 0.005) add("unmatchedRefund", 1, order);
      }
      available -= event.amount;
    }
  }
  for (const shipment of array(shipments)) {
    const order = orderById.get(text(shipment?.orderId)) ?? { id: shipment?.orderId };
    for (const event of dashboardReplacementEvents(shipment, order)) {
      const bucket = buckets.get(dashboardDatePart(event.time));
      if (!bucket) continue;
      bucket.shippedDamage += event.amount;
      add("missingReplacementPrice", event.missingPriceCount, order);
    }
  }
  return {
    dailyFinanceData: array(dates).map(date => {
      const bucket = buckets.get(date);
      return { date, label: date.slice(5).replace("-", "/"),
        ...Object.fromEntries(Object.entries(bucket).map(([key, value]) => [key, money(value)])),
        refunded: money(bucket.unshippedRefund) };
    }),
    salesMetricWarnings: warnings,
  };
}

export function dashboardOrderAdjustmentTotals(orders = [], shipments = [], date = "") {
  const targetDate = dashboardDatePart(date);
  if (!targetDate) return { unshippedRefund: 0, shippedDamage: 0 };
  const point = buildDashboardSalesMetrics({ dates: [targetDate], orders, shipments }).dailyFinanceData[0];
  return { unshippedRefund: point.unshippedRefund, shippedDamage: point.shippedDamage };
}
