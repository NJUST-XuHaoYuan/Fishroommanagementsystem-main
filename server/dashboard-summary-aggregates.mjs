import {
  dashboardDatePart,
  isUnshippedOrderRefund,
  shipmentDamageAmount,
  shipmentDamagedAt,
  unshippedRefundRecordedAt,
} from "./dashboard-sales-metrics.mjs";

function array(value) {
  return Array.isArray(value) ? value : [];
}

function money(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function compactDate(value) {
  return dashboardDatePart(value);
}

function addDaysToDateString(date, days) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function daysBetween(from, to) {
  const start = Date.parse(`${compactDate(from)}T00:00:00Z`);
  const end = Date.parse(`${compactDate(to)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

export function indexShipmentsByOrder(shipments = []) {
  const byOrderId = new Map();
  for (const shipment of array(shipments)) {
    const orderId = String(shipment?.orderId ?? "");
    if (!orderId) continue;
    const rows = byOrderId.get(orderId);
    if (rows) rows.push(shipment);
    else byOrderId.set(orderId, [shipment]);
  }
  return byOrderId;
}

/**
 * Builds every daily finance bucket in one pass over orders/payments and one
 * pass over shipments. The date count therefore does not multiply full-array
 * scans when a user selects a longer chart range.
 */
export function buildDashboardFinanceSeries({
  dates = [],
  orders = [],
  shipments = [],
  shipmentsByOrderId = indexShipmentsByOrder(shipments),
  isPaymentVerified = () => false,
  amountForOrder = () => 0,
  isPlatformOrderSource = () => false,
  isValidSalesOrder = () => true,
  isOfflinePickupOrder = () => false,
} = {}) {
  const dateSet = new Set(array(dates));
  const buckets = new Map(array(dates).map((date) => [date, {
    received: 0,
    unshippedRefund: 0,
    shippedDamage: 0,
    orderAmount: 0,
    platformAmount: 0,
    offlinePickupAmount: 0,
    privateDomainAmount: 0,
  }]));
  const orderById = new Map();

  for (const order of array(orders)) {
    const orderId = String(order?.id ?? "");
    if (orderId) orderById.set(orderId, order);
    const orderShipments = shipmentsByOrderId.get(orderId) ?? [];
    const salesDate = compactDate(order?.date);
    if (dateSet.has(salesDate) && isValidSalesOrder(order)) {
      const bucket = buckets.get(salesDate);
      const amount = Math.max(0, Number(amountForOrder(order, orderShipments) || 0));
      bucket.orderAmount += amount;
      if (isPlatformOrderSource(order?.source)) bucket.platformAmount += amount;
      if (isOfflinePickupOrder(order, orderShipments)) bucket.offlinePickupAmount += amount;
      if (String(order?.source ?? "").trim() === "私域线上") bucket.privateDomainAmount += amount;
    }

    for (const payment of array(order?.payments)) {
      const paymentDate = compactDate(payment?.time);
      if (dateSet.has(paymentDate) && isPaymentVerified(payment) && payment?.type !== "refund") {
        buckets.get(paymentDate).received += Number(payment?.amount || 0);
      }
      const refundDate = compactDate(unshippedRefundRecordedAt(payment));
      if (dateSet.has(refundDate) && isUnshippedOrderRefund(payment, orderShipments)) {
        buckets.get(refundDate).unshippedRefund += Number(payment?.amount || 0);
      }
    }
  }

  for (const shipment of array(shipments)) {
    const order = orderById.get(String(shipment?.orderId ?? "")) ?? {};
    const damagedDate = compactDate(shipmentDamagedAt(shipment, order));
    if (!dateSet.has(damagedDate)) continue;
    buckets.get(damagedDate).shippedDamage += shipmentDamageAmount(shipment, order);
  }

  return array(dates).map((date) => {
    const bucket = buckets.get(date);
    return {
      date,
      label: date.slice(5).replace("-", "/"),
      received: money(bucket.received),
      refunded: money(bucket.unshippedRefund),
      unshippedRefund: money(bucket.unshippedRefund),
      shippedDamage: money(bucket.shippedDamage),
      orderAmount: money(bucket.orderAmount),
      platformAmount: money(bucket.platformAmount),
      offlinePickupAmount: money(bucket.offlinePickupAmount),
      privateDomainAmount: money(bucket.privateDomainAmount),
    };
  });
}

function normalizeSalespersonName(value) {
  return String(value ?? "").trim() || "未指定";
}

const ORDER_STATUS_TEXT = {
  pending: "未完成",
  confirmed: "已确认",
  shipped: "发货中",
  completed: "已完成",
  cancelled: "已取消",
  damaged: "已报损",
};

/** Builds all salesperson options and daily drill-downs without D x orders. */
export function buildDashboardSalespersonSeries({
  dates = [],
  orders = [],
  shipmentsByOrderId = new Map(),
  personnel = [],
  customers = [],
  amountForOrder = () => 0,
  isPlatformOrderSource = () => false,
  isPersonnelResigned = () => false,
  isValidSalesOrder = () => true,
  platformOrderDisplayName = () => "",
} = {}) {
  const dateSet = new Set(array(dates));
  const customerById = new Map(array(customers).map((customer) => [String(customer?.id ?? ""), customer]));
  const resignedNames = new Set(array(personnel)
    .filter(isPersonnelResigned)
    .map((person) => normalizeSalespersonName(person?.name || person?.username)));
  const knownNames = new Set(array(personnel)
    .filter((person) => String(person?.name ?? "").trim() && !isPersonnelResigned(person))
    .map((person) => normalizeSalespersonName(person?.name)));
  const optionByName = new Map([...knownNames].map((name) => [name, { name, orderCount: 0, amount: 0 }]));
  const dailyRows = new Map(array(dates).map((date) => [date, new Map()]));

  for (const order of array(orders)) {
    if (!isValidSalesOrder(order)) continue;
    const date = compactDate(order?.date);
    if (!dateSet.has(date)) continue;
    const salesperson = normalizeSalespersonName(order?.contactPerson);
    if (resignedNames.has(salesperson)) continue;
    const orderShipments = shipmentsByOrderId.get(String(order?.id ?? "")) ?? [];
    const amount = money(amountForOrder(order, orderShipments));
    const option = optionByName.get(salesperson) ?? { name: salesperson, orderCount: 0, amount: 0 };
    option.orderCount += 1;
    option.amount = money(option.amount + amount);
    optionByName.set(salesperson, option);

    const rowsByPerson = dailyRows.get(date);
    const row = rowsByPerson.get(salesperson) ?? {
      salesperson,
      amount: 0,
      orderCount: 0,
      itemCount: 0,
      orders: [],
    };
    const customer = customerById.get(String(order?.customerId ?? ""));
    const itemCount = array(order?.items).length;
    row.amount = money(row.amount + amount);
    row.orderCount += 1;
    row.itemCount += itemCount;
    row.orders.push({
      orderId: String(order?.id ?? ""),
      orderNo: String(order?.orderNo ?? ""),
      customerName: String(customer?.name ?? (
        isPlatformOrderSource(order?.source)
          ? platformOrderDisplayName(order)
          : order?.customerId || "未关联客户"
      )),
      contactPerson: salesperson,
      amount,
      itemCount,
      status: ORDER_STATUS_TEXT[order?.status] ?? String(order?.status ?? ""),
      notes: String(order?.notes ?? ""),
    });
    rowsByPerson.set(salesperson, row);
  }

  const salespersonOptions = [...optionByName.values()].sort((a, b) =>
    b.amount - a.amount || b.orderCount - a.orderCount || a.name.localeCompare(b.name, "zh-Hans-CN")
  );
  const dailySalespersonData = array(dates).map((date) => {
    const breakdowns = [...dailyRows.get(date).values()]
      .map((row) => ({
        ...row,
        orders: row.orders.sort((a, b) => b.amount - a.amount || a.orderNo.localeCompare(b.orderNo, "zh-Hans-CN")),
      }))
      .sort((a, b) => b.amount - a.amount || a.salesperson.localeCompare(b.salesperson, "zh-Hans-CN"));
    return {
      date,
      label: date.slice(5).replace("-", "/"),
      total: money(breakdowns.reduce((sum, row) => sum + row.amount, 0)),
      orderCount: breakdowns.reduce((sum, row) => sum + row.orderCount, 0),
      itemCount: breakdowns.reduce((sum, row) => sum + row.itemCount, 0),
      breakdowns,
    };
  });
  return { salespersonOptions, dailySalespersonData };
}

function firstEventDate(...values) {
  return values.map(compactDate).filter(Boolean).sort()[0] ?? "";
}

/**
 * Builds loss points with indexed loss/batch rows and an inventory interval
 * sweep. Stock is not filtered again for every chart date.
 */
export function buildDashboardLossSeries({
  dates = [],
  stock = [],
  lossRecords = [],
  shipments = [],
  batches = [],
  products = [],
  species = [],
  tankGroups = [],
  sites = [],
  siteId = "all",
  defaultSiteId = "nanjing",
  inventoryProjection = {},
  isFishInventoryItem = () => true,
  normalizeInventoryId = (value) => String(value ?? "").trim(),
} = {}) {
  const orderedDates = array(dates);
  if (orderedDates.length === 0) return [];
  const firstDate = orderedDates[0];
  const lastDate = orderedDates[orderedDates.length - 1];
  const dateSet = new Set(orderedDates);
  const dateIndex = new Map(orderedDates.map((date, index) => [date, index]));
  const productById = new Map(array(products).map((product) => [String(product?.id ?? ""), product]));
  const speciesById = new Map(array(species).map((item) => [String(item?.id ?? ""), item]));
  const stockById = new Map(array(stock).map((item) => [String(item?.id ?? ""), item]));
  const batchById = new Map(array(batches).map((batch) => [String(batch?.id ?? ""), batch]));
  const siteNameById = new Map(array(sites).map((site) => [String(site?.id ?? ""), String(site?.name ?? "").trim()]));
  const tankNameById = new Map();
  const tankSiteById = new Map();
  const groupSiteById = new Map();
  for (const group of array(tankGroups)) {
    const groupSiteId = String(group?.siteId ?? "").trim();
    groupSiteById.set(String(group?.id ?? ""), groupSiteId);
    for (const tank of array(group?.subTanks)) {
      tankNameById.set(String(tank?.id ?? ""), `${String(group?.name ?? "")} / ${String(tank?.name ?? "")}`);
      tankSiteById.set(String(tank?.id ?? ""), groupSiteId);
    }
  }
  const stockSiteId = (item = {}) => tankSiteById.get(String(item?.subTankId ?? "")) || String(item?.siteId ?? "").trim() || defaultSiteId;
  const lossSiteId = (record = {}, item = {}) => String(record?.siteId ?? "").trim()
    || tankSiteById.get(String(record?.subTankId ?? ""))
    || groupSiteById.get(String(record?.tankGroupId ?? ""))
    || stockSiteId(item);
  const matchesScope = (value) => siteId === "all" || value === siteId;

  const explicitIds = new Set(array(lossRecords).map((record) => String(record?.stockItemId ?? "")).filter(Boolean));
  const allLossRecords = [...array(lossRecords)];
  for (const item of array(stock)) {
    if (!item?.lost || explicitIds.has(String(item?.id ?? ""))) continue;
    allLossRecords.push({
      id: `loss-${item.id}`,
      stockItemId: item.id,
      date: item.lossDate ?? item.inDate,
      reason: item.lossReason ?? "",
    });
  }

  const lossRowsByDate = new Map();
  const earliestLossDateByStockId = new Map();
  const lossSiteByStockId = new Map();
  const lossStockIdsByBatchId = new Map();
  for (const record of allLossRecords) {
    const stockId = String(record?.stockItemId ?? "");
    const stockItem = stockById.get(stockId);
    if (!stockItem) continue;
    const recordSiteId = lossSiteId(record, stockItem);
    const product = productById.get(String(stockItem?.productId ?? ""));
    const itemSpecies = product ? speciesById.get(String(product?.speciesId ?? "")) : undefined;
    if (!isFishInventoryItem(product, itemSpecies)) continue;
    const date = compactDate(record?.date ?? stockItem?.lossDate);
    if (!date) continue;
    const currentLossDate = earliestLossDateByStockId.get(stockId);
    if (!currentLossDate || date < currentLossDate) {
      earliestLossDateByStockId.set(stockId, date);
      lossSiteByStockId.set(stockId, recordSiteId);
    }
    if (!matchesScope(recordSiteId)) continue;
    const row = {
      record,
      stockItem,
      product,
      species: itemSpecies,
      date,
      siteId: recordSiteId,
      estimatedValue: Number(stockItem?.basePrice ?? product?.defaultPrice ?? 0),
    };
    const rows = lossRowsByDate.get(date);
    if (rows) rows.push(row);
    else lossRowsByDate.set(date, [row]);
    const batchId = String(stockItem?.batchId ?? "");
    if (batchId) {
      const ids = lossStockIdsByBatchId.get(batchId) ?? new Set();
      ids.add(stockId);
      lossStockIdsByBatchId.set(batchId, ids);
    }
  }
  for (const item of array(stock)) {
    const stockId = String(item?.id ?? "");
    const date = compactDate(item?.lossDate);
    if (!stockId || !date) continue;
    const current = earliestLossDateByStockId.get(stockId);
    if (!current || date < current) earliestLossDateByStockId.set(stockId, date);
  }

  const shippedDateByStockId = new Map(Object.entries(
    inventoryProjection?.outDateByStockId && typeof inventoryProjection.outDateByStockId === "object"
      ? inventoryProjection.outDateByStockId
      : {}
  ).map(([id, date]) => [normalizeInventoryId(id), compactDate(date)]).filter(([id, date]) => id && date));
  for (const shipment of array(shipments)) {
    if (!shipment || shipment?.status === "preparing") continue;
    // Preserve the fulfillment timestamp priority used by the inventory
    // projection. A shipment may be created days before it actually leaves.
    const date = compactDate(shipment?.outboundDate ?? shipment?.shipDate ?? shipment?.createdAt);
    if (!date) continue;
    for (const rawId of array(shipment?.itemStockIds)) {
      const stockId = normalizeInventoryId(rawId);
      if (!stockId) continue;
      const current = shippedDateByStockId.get(stockId);
      if (!current || date < current) shippedDateByStockId.set(stockId, date);
    }
  }

  const fishStock = [];
  const fishStockCountByBatchId = new Map();
  for (const item of array(stock)) {
    if (!matchesScope(lossSiteByStockId.get(String(item?.id ?? "")) || stockSiteId(item))) continue;
    const product = productById.get(String(item?.productId ?? ""));
    const itemSpecies = product ? speciesById.get(String(product?.speciesId ?? "")) : undefined;
    if (!isFishInventoryItem(product, itemSpecies)) continue;
    fishStock.push(item);
    const batchId = String(item?.batchId ?? "");
    if (batchId) fishStockCountByBatchId.set(batchId, (fishStockCountByBatchId.get(batchId) ?? 0) + 1);
  }

  const inventoryDelta = Array(orderedDates.length + 1).fill(0);
  for (const item of fishStock) {
    const stockId = String(item?.id ?? "");
    const start = compactDate(item?.inDate);
    const end = firstEventDate(earliestLossDateByStockId.get(stockId), shippedDateByStockId.get(normalizeInventoryId(stockId)));
    if (!start || start > lastDate || (end && end < firstDate) || (end && end < start)) continue;
    const startIndex = start <= firstDate ? 0 : dateIndex.get(start);
    if (startIndex == null) continue;
    inventoryDelta[startIndex] += 1;
    if (end && end < lastDate) {
      const removeIndex = dateIndex.get(addDaysToDateString(end, 1));
      if (removeIndex != null) inventoryDelta[removeIndex] -= 1;
    }
  }
  const inventoryCountByDate = new Map();
  let runningInventory = 0;
  for (let index = 0; index < orderedDates.length; index += 1) {
    runningInventory += inventoryDelta[index];
    inventoryCountByDate.set(orderedDates[index], runningInventory);
  }

  const batchesByDate = new Map();
  for (const batch of array(batches)) {
    if (!matchesScope(String(batch?.siteId ?? "").trim() || defaultSiteId)) continue;
    const date = compactDate(batch?.arrivalDate);
    if (!dateSet.has(date)) continue;
    const batchId = String(batch?.id ?? "");
    const reportedStockedCount = Number(batch?.stockedCount);
    const reportedLossCount = Number(batch?.lossCount);
    const summary = {
      id: batchId,
      batchNo: String(batch?.batchNo ?? ""),
      supplier: String(batch?.supplier ?? ""),
      arrivalDate: date,
      stockedCount: Number.isFinite(reportedStockedCount) && reportedStockedCount > 0
        ? reportedStockedCount
        : (fishStockCountByBatchId.get(batchId) ?? 0),
      lossCount: Number.isFinite(reportedLossCount) && reportedLossCount > 0
        ? reportedLossCount
        : (lossStockIdsByBatchId.get(batchId)?.size ?? 0),
      bioFee: Number(batch?.bioFee || 0),
      shippingFee: Number(batch?.shippingFee || 0),
    };
    const rows = batchesByDate.get(date);
    if (rows) rows.push(summary);
    else batchesByDate.set(date, [summary]);
  }

  return orderedDates.map((date) => {
    const seen = new Set();
    const rowsForDate = array(lossRowsByDate.get(date)).filter((row) => {
      const stockId = String(row?.stockItem?.id ?? "");
      if (!stockId || seen.has(stockId)) return false;
      seen.add(stockId);
      return true;
    });
    const stockBase = inventoryCountByDate.get(date) ?? 0;
    const lossDetails = rowsForDate.map((row) => {
      const stockItem = row.stockItem ?? {};
      const product = row.product ?? {};
      const itemSpecies = row.species ?? {};
      const batch = batchById.get(String(stockItem?.batchId ?? "")) ?? {};
      const record = row.record ?? {};
      const snapshotTankName = [record?.tankGroupName, record?.subTankName]
        .map((part) => String(part ?? "").trim()).filter(Boolean).join(" / ");
      const eventTankId = String(record?.subTankId ?? "");
      const eventTankName = tankSiteById.get(eventTankId) === row.siteId ? tankNameById.get(eventTankId) : "";
      const currentTankName = stockSiteId(stockItem) === row.siteId
        ? tankNameById.get(String(stockItem?.subTankId ?? ""))
        : "";
      return {
        id: String(record?.id ?? stockItem?.id ?? ""),
        stockItemId: String(stockItem?.id ?? ""),
        productName: String(product?.name ?? "未命名商品"),
        speciesName: String(itemSpecies?.name ?? ""),
        size: String(product?.size ?? ""),
        origin: String(product?.origin ?? ""),
        siteId: row.siteId,
        siteName: String(record?.siteName ?? "").trim() || siteNameById.get(row.siteId) || ({ nanjing: "南京", jiangyin: "江阴" })[row.siteId] || row.siteId || "未知场地",
        tankName: String(record?.tankName ?? "").trim() || snapshotTankName || eventTankName || currentTankName || "未知缸位",
        batchNo: String(batch?.batchNo ?? ""),
        supplier: String(batch?.supplier ?? ""),
        arrivalDate: String(batch?.arrivalDate ?? ""),
        reason: String(record?.reason ?? stockItem?.lossReason ?? ""),
        estimatedValue: Number(row.estimatedValue || 0),
        code: String(stockItem?.code ?? ""),
      };
    });
    const lostCount = lossDetails.length;
    const estimatedValue = money(lossDetails.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0));
    return {
      date,
      label: date.slice(5).replace("-", "/"),
      lostCount,
      stockBase,
      lossRate: stockBase > 0 ? lostCount / stockBase * 100 : 0,
      estimatedValue,
      lossDetails,
      batchArrivals: batchesByDate.get(date) ?? [],
    };
  });
}

function compactProduct(product = {}) {
  return {
    id: String(product?.id ?? ""),
    speciesId: String(product?.speciesId ?? ""),
    name: String(product?.name ?? ""),
    size: String(product?.size ?? ""),
    origin: String(product?.origin ?? ""),
  };
}

function compactSpecies(species = {}) {
  return { id: String(species?.id ?? ""), name: String(species?.name ?? "") };
}

export function buildDashboardFocusOptions({ species = [], products = [], stock = [], outStockIds = new Set() } = {}) {
  const productById = new Map(array(products).map((product) => [String(product?.id ?? ""), product]));
  const speciesById = new Map(array(species).map((item) => [String(item?.id ?? ""), item]));
  const physicalCountByProduct = new Map();
  const physicalCountBySpecies = new Map();
  for (const item of array(stock)) {
    const stockId = String(item?.id ?? "");
    if (item?.lost || outStockIds.has(stockId)) continue;
    const productId = String(item?.productId ?? "");
    const product = productById.get(productId);
    physicalCountByProduct.set(productId, (physicalCountByProduct.get(productId) ?? 0) + 1);
    const speciesId = String(product?.speciesId ?? "");
    if (speciesId) physicalCountBySpecies.set(speciesId, (physicalCountBySpecies.get(speciesId) ?? 0) + 1);
  }
  const speciesOptions = array(species).map((item) => ({
    id: String(item?.id ?? ""),
    label: String(item?.name ?? ""),
    subLabel: [item?.category, array(item?.commonNames).join("、")].filter(Boolean).join(" · "),
    searchText: [item?.name, item?.scientificName, item?.category, ...array(item?.commonNames)].filter(Boolean).join(" ").toLowerCase(),
    inTankCount: physicalCountBySpecies.get(String(item?.id ?? "")) ?? 0,
  })).sort((a, b) => b.inTankCount - a.inTankCount || a.label.localeCompare(b.label, "zh-Hans-CN"));
  const productOptions = array(products).map((product) => {
    const itemSpecies = speciesById.get(String(product?.speciesId ?? ""));
    return {
      id: String(product?.id ?? ""),
      label: String(product?.name ?? ""),
      subLabel: [itemSpecies?.name, product?.size, product?.origin].filter(Boolean).join(" · "),
      searchText: [product?.name, product?.size, product?.origin, product?.notes, itemSpecies?.name, ...array(itemSpecies?.commonNames)].filter(Boolean).join(" ").toLowerCase(),
      inTankCount: physicalCountByProduct.get(String(product?.id ?? "")) ?? 0,
    };
  }).sort((a, b) => b.inTankCount - a.inTankCount || a.label.localeCompare(b.label, "zh-Hans-CN"));
  return { species: speciesOptions, product: productOptions };
}

export function buildDashboardFocusDetail({
  mode = "species",
  id = "",
  today = "",
  species = [],
  products = [],
  stock = [],
  orders = [],
  outStockIds = new Set(),
} = {}) {
  const normalizedMode = mode === "product" ? "product" : "species";
  const targetId = String(id ?? "");
  if (!targetId) return null;
  const speciesById = new Map(array(species).map((item) => [String(item?.id ?? ""), item]));
  const stockById = new Map(array(stock).map((item) => [String(item?.id ?? ""), item]));
  const targetProducts = array(products).filter((product) => normalizedMode === "product"
    ? String(product?.id ?? "") === targetId
    : String(product?.speciesId ?? "") === targetId);
  if (targetProducts.length === 0 && normalizedMode === "product") return null;
  const targetProductIds = new Set(targetProducts.map((product) => String(product?.id ?? "")));
  const productStats = new Map(targetProducts.map((product) => [String(product?.id ?? ""), {
    product,
    inTank: 0,
    sellable: 0,
    soldInTank: 0,
    sick: 0,
    lost: 0,
    salesCount: 0,
    salesAmount: 0,
  }]));
  const targetStock = [];
  const sellableAges = [];
  for (const item of array(stock)) {
    const productId = String(item?.productId ?? "");
    if (!targetProductIds.has(productId)) continue;
    targetStock.push(item);
    const stats = productStats.get(productId);
    if (item?.lost) stats.lost += 1;
    if (item?.lost || outStockIds.has(String(item?.id ?? ""))) continue;
    stats.inTank += 1;
    if (item?.sold) stats.soldInTank += 1;
    else if (item?.status === "sick") stats.sick += 1;
    else {
      stats.sellable += 1;
      const age = daysBetween(item?.inDate, today);
      if (age !== null) sellableAges.push(age);
    }
  }

  const thirtyDaysAgo = addDaysToDateString(today, -29);
  let salesCount = 0;
  let salesAmount = 0;
  let salesCount30 = 0;
  let salesAmount30 = 0;
  const turnoverDays = [];
  for (const order of array(orders)) {
    if (order?.status === "cancelled") continue;
    const orderDate = compactDate(order?.date);
    const inThirtyDays = orderDate && orderDate >= thirtyDaysAgo && orderDate <= today;
    for (const item of array(order?.items)) {
      const productId = String(item?.productId ?? "");
      if (!targetProductIds.has(productId)) continue;
      const amount = Number(item?.price || 0);
      salesCount += 1;
      salesAmount += amount;
      const stats = productStats.get(productId);
      stats.salesCount += 1;
      stats.salesAmount += amount;
      if (inThirtyDays) {
        salesCount30 += 1;
        salesAmount30 += amount;
      }
      const turnover = daysBetween(stockById.get(String(item?.stockItemId ?? ""))?.inDate, orderDate);
      if (turnover !== null) turnoverDays.push(turnover);
    }
  }
  const sellable = [...productStats.values()].reduce((sum, row) => sum + row.sellable, 0);
  const dailySales30 = salesCount30 / 30;
  const productRows = [...productStats.values()].map((row) => ({
    product: compactProduct(row.product),
    species: compactSpecies(speciesById.get(String(row.product?.speciesId ?? ""))),
    inTank: row.inTank,
    sellable: row.sellable,
    soldInTank: row.soldInTank,
    sick: row.sick,
    lost: row.lost,
    salesCount: row.salesCount,
    salesAmount: money(row.salesAmount),
  })).sort((a, b) => b.inTank - a.inTank || b.salesAmount - a.salesAmount || a.product.name.localeCompare(b.product.name, "zh-Hans-CN"));
  const totalStock = targetStock.length;
  return {
    mode: normalizedMode,
    id: targetId,
    metrics: {
      salesCount,
      salesAmount: money(salesAmount),
      salesCount30,
      salesAmount30: money(salesAmount30),
      averageTurnoverDays: average(turnoverDays),
      turnoverSampleCount: turnoverDays.length,
      currentAverageAgeDays: average(sellableAges),
      estimatedClearDays: dailySales30 > 0 ? sellable / dailySales30 : null,
      inTank: [...productStats.values()].reduce((sum, row) => sum + row.inTank, 0),
      sellable,
      soldInTank: [...productStats.values()].reduce((sum, row) => sum + row.soldInTank, 0),
      sick: [...productStats.values()].reduce((sum, row) => sum + row.sick, 0),
      lost: [...productStats.values()].reduce((sum, row) => sum + row.lost, 0),
      totalStock,
      lossRate: totalStock > 0 ? [...productStats.values()].reduce((sum, row) => sum + row.lost, 0) / totalStock * 100 : 0,
    },
    productRows,
  };
}
