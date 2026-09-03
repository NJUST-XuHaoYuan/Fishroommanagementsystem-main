import {
  normalizeExternalOrderNo,
  normalizeShippingFeeMode,
} from "./finance-utils.mjs";
import { isPaymentVerified } from "./payment-utils.mjs";
import { shipmentsHavePendingActualShippingFee } from "./shipment-rules.mjs";

function finiteNumber(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function moneyToCents(value) {
  return Math.round(finiteNumber(value) * 100);
}

function nonNegativeCents(value) {
  return Math.max(0, moneyToCents(value));
}

function centsToMoney(value) {
  return Number((finiteNumber(value) / 100).toFixed(2));
}

/**
 * Distribute an integer amount using largest remainders. The returned integers
 * always add up to `total`, including when `total` is negative.
 */
export function allocateCents(total, weights = []) {
  const normalizedTotal = Math.trunc(finiteNumber(total));
  const normalizedWeights = (Array.isArray(weights) ? weights : [])
    .map((weight) => Math.max(0, Math.trunc(finiteNumber(weight))));
  const weightTotal = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
  if (normalizedWeights.length === 0) return [];
  if (normalizedTotal === 0 || weightTotal <= 0) return normalizedWeights.map(() => 0);

  const sign = normalizedTotal < 0 ? -1 : 1;
  const magnitude = Math.abs(normalizedTotal);
  const parts = normalizedWeights.map((weight, index) => {
    const numerator = magnitude * weight;
    return {
      index,
      cents: Math.floor(numerator / weightTotal),
      remainder: numerator % weightTotal,
    };
  });
  let remaining = magnitude - parts.reduce((sum, part) => sum + part.cents, 0);
  const remainderOrder = [...parts].sort((left, right) =>
    right.remainder - left.remainder || left.index - right.index
  );
  for (let index = 0; index < remainderOrder.length && remaining > 0; index += 1) {
    remainderOrder[index].cents += 1;
    remaining -= 1;
  }
  return parts
    .sort((left, right) => left.index - right.index)
    .map((part) => part.cents === 0 ? 0 : sign * part.cents);
}

function paymentNetCents(payments = [], verified) {
  return (Array.isArray(payments) ? payments : []).reduce((sum, payment) => {
    if (isPaymentVerified(payment) !== verified) return sum;
    const amount = nonNegativeCents(payment?.amount);
    return payment?.type === "refund" ? sum - amount : sum + amount;
  }, 0);
}

function customerShippingChargeCents(order = {}, shipments = []) {
  const mode = normalizeShippingFeeMode(order?.shippingFeeMode, order?.source);
  if (mode !== "prepaid") return 0;
  const activeShipments = (Array.isArray(shipments) ? shipments : []).filter((shipment) =>
    String(shipment?.orderId ?? "") === String(order?.id ?? "") &&
    String(shipment?.status ?? "") !== "preparing"
  );
  if (activeShipments.length === 0 || shipmentsHavePendingActualShippingFee(mode, activeShipments)) {
    return nonNegativeCents(order?.shippingFee);
  }
  return activeShipments.reduce(
    (sum, shipment) => sum + nonNegativeCents(shipment?.actualShippingFee),
    0
  );
}

function platformIncomeByExternalOrderNo(rows = []) {
  const incomeByOrderNo = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const record = row?.data && typeof row.data === "object" ? row.data : row;
    const externalOrderNo = normalizeExternalOrderNo(
      record?.externalOrderNo ?? row?.external_order_no
    );
    if (!externalOrderNo) continue;
    const current = incomeByOrderNo.get(externalOrderNo) ?? { incomeCents: 0, rowCount: 0 };
    current.incomeCents += moneyToCents(record?.incomeTotal ?? row?.income_total);
    current.rowCount += Math.max(1, Math.trunc(finiteNumber(row?.row_count ?? 1)));
    incomeByOrderNo.set(externalOrderNo, current);
  }
  return incomeByOrderNo;
}

function allocatableProductPoolCents(productDue, orderDue, netPayment) {
  if (!(productDue > 0) || !(orderDue > 0)) return 0;
  const distributable = Math.min(orderDue, Math.max(0, Math.trunc(finiteNumber(netPayment))));
  const otherDue = Math.max(0, orderDue - productDue);
  return allocateCents(distributable, [productDue, otherDue])[0] ?? 0;
}

function emptyMetric(batchId) {
  return {
    batchId,
    earliestStockInDate: "",
    salesNetCents: 0,
    pendingReceivedCents: 0,
    verifiedReceivedCents: 0,
    platformReceivedCents: 0,
    grossCents: 0,
    discountCents: 0,
    refundAdjustmentCents: 0,
    itemCount: 0,
    orderIds: new Set(),
    platformOrderIds: new Set(),
  };
}

function allocateOrderDiscount(items, discountCents) {
  const grossTotal = items.reduce((sum, item) => sum + item.grossCents, 0);
  const allocatableDiscount = Math.min(grossTotal, Math.max(0, discountCents));
  const allocations = allocateCents(
    allocatableDiscount,
    items.map((item) => item.grossCents)
  );
  items.forEach((item, index) => {
    item.discountCents = allocations[index] ?? 0;
    item.salesNetCents = Math.max(0, item.grossCents - item.discountCents);
  });
}

function allocateDamageRefunds(order, items, shipments) {
  const itemIndexesByStockId = new Map();
  items.forEach((item, index) => {
    const indexes = itemIndexesByStockId.get(item.stockItemId) ?? [];
    indexes.push(index);
    itemIndexesByStockId.set(item.stockItemId, indexes);
  });

  for (const shipment of Array.isArray(shipments) ? shipments : []) {
    if (String(shipment?.orderId ?? "") !== String(order?.id ?? "")) continue;
    if (shipment?.status !== "damaged" || shipment?.damageResolution !== "refund") continue;
    const stockIds = Array.isArray(shipment?.damageItemStockIds) && shipment.damageItemStockIds.length > 0
      ? shipment.damageItemStockIds
      : Array.isArray(shipment?.itemStockIds)
        ? shipment.itemStockIds
        : [];
    const targetIndexes = [...new Set(stockIds.flatMap((stockId) =>
      itemIndexesByStockId.get(String(stockId ?? "")) ?? []
    ))];
    if (targetIndexes.length === 0) continue;
    const remainingSales = targetIndexes.reduce((sum, index) => sum + items[index].salesNetCents, 0);
    const refundCents = Math.min(remainingSales, nonNegativeCents(shipment?.damageRefundAmount));
    const allocations = allocateCents(
      refundCents,
      targetIndexes.map((index) => items[index].salesNetCents)
    );
    targetIndexes.forEach((itemIndex, allocationIndex) => {
      const amount = allocations[allocationIndex] ?? 0;
      items[itemIndex].refundAdjustmentCents += amount;
      items[itemIndex].salesNetCents = Math.max(0, items[itemIndex].salesNetCents - amount);
    });
  }
}

/**
 * Build procurement-batch sales and collection metrics without exposing
 * order-level or settlement-level finance records to the browser.
 *
 * Matched Douyin settlements intentionally follow the finance order ledger's
 * existing recognition basis: summed `incomeTotal` replaces order payments as
 * verified collection. Platform fees remain outside these sales metrics.
 */
export function buildBatchRevenueMetrics({
  batches = [],
  stock = [],
  orders = [],
  shipments = [],
  platformSettlements = [],
} = {}) {
  const metrics = new Map(
    (Array.isArray(batches) ? batches : [])
      .map((batch) => String(batch?.id ?? "").trim())
      .filter(Boolean)
      .map((batchId) => [batchId, emptyMetric(batchId)])
  );
  const stockById = new Map(
    (Array.isArray(stock) ? stock : [])
      .map((item) => [String(item?.id ?? ""), item])
      .filter(([id]) => Boolean(id))
  );
  for (const stockItem of stockById.values()) {
    const metric = metrics.get(String(stockItem?.batchId ?? "").trim());
    const inDate = String(stockItem?.inDate ?? "").trim().slice(0, 10);
    if (!metric || !/^\d{4}-\d{2}-\d{2}$/.test(inDate)) continue;
    if (!metric.earliestStockInDate || inDate < metric.earliestStockInDate) {
      metric.earliestStockInDate = inDate;
    }
  }
  const platformIncome = platformIncomeByExternalOrderNo(platformSettlements);
  const diagnostics = {
    unassignedItemCount: 0,
    unassignedSalesNetCents: 0,
  };

  for (const order of Array.isArray(orders) ? orders : []) {
    if (order?.status === "cancelled") continue;
    const sourceItems = Array.isArray(order?.items) ? order.items : [];
    if (sourceItems.length === 0) continue;

    const items = sourceItems.map((item) => {
      const stockItemId = String(item?.stockItemId ?? "");
      const stockItem = stockById.get(stockItemId);
      return {
        stockItemId,
        batchId: String(stockItem?.batchId ?? item?.batchId ?? "").trim(),
        grossCents: nonNegativeCents(item?.price),
        discountCents: 0,
        refundAdjustmentCents: 0,
        salesNetCents: 0,
      };
    });
    allocateOrderDiscount(items, nonNegativeCents(order?.discount));
    allocateDamageRefunds(order, items, shipments);

    const productDue = items.reduce((sum, item) => sum + item.salesNetCents, 0);
    if (!(productDue > 0)) continue;
    const orderDue = productDue +
      customerShippingChargeCents(order, shipments) +
      nonNegativeCents(order?.packagingFee);
    const platformOrderNo = String(order?.source ?? "").trim() === "平台下单"
      ? normalizeExternalOrderNo(order?.platformOrderNo) ||
        normalizeExternalOrderNo(order?.douyinOrderNo)
      : "";
    const matchedPlatformIncome = platformOrderNo ? platformIncome.get(platformOrderNo) : undefined;
    const usesPlatformSettlement = Boolean(matchedPlatformIncome?.rowCount);
    const verifiedNetPayment = usesPlatformSettlement
      ? matchedPlatformIncome.incomeCents
      : paymentNetCents(order?.payments, true);
    const pendingNetPayment = usesPlatformSettlement
      ? 0
      : paymentNetCents(order?.payments, false);
    const verifiedProductPool = allocatableProductPoolCents(productDue, orderDue, verifiedNetPayment);
    const recordedProductPool = allocatableProductPoolCents(
      productDue,
      orderDue,
      verifiedNetPayment + pendingNetPayment
    );
    const pendingProductPool = recordedProductPool - verifiedProductPool;
    const verifiedAllocations = allocateCents(
      verifiedProductPool,
      items.map((item) => item.salesNetCents)
    );
    const pendingAllocations = allocateCents(
      pendingProductPool,
      items.map((item) => item.salesNetCents)
    );

    items.forEach((item, index) => {
      const metric = metrics.get(item.batchId);
      if (!metric) {
        diagnostics.unassignedItemCount += 1;
        diagnostics.unassignedSalesNetCents += item.salesNetCents;
        return;
      }
      metric.grossCents += item.grossCents;
      metric.discountCents += item.discountCents;
      metric.refundAdjustmentCents += item.refundAdjustmentCents;
      metric.salesNetCents += item.salesNetCents;
      metric.verifiedReceivedCents += verifiedAllocations[index] ?? 0;
      metric.pendingReceivedCents += pendingAllocations[index] ?? 0;
      if (usesPlatformSettlement) metric.platformReceivedCents += verifiedAllocations[index] ?? 0;
      metric.itemCount += 1;
      metric.orderIds.add(String(order?.id ?? ""));
      if (usesPlatformSettlement) metric.platformOrderIds.add(String(order?.id ?? ""));
    });
  }

  return {
    metrics: [...metrics.values()].map((metric) => ({
      batchId: metric.batchId,
      ...(metric.earliestStockInDate ? { earliestStockInDate: metric.earliestStockInDate } : {}),
      salesNet: centsToMoney(metric.salesNetCents),
      pendingReceived: centsToMoney(metric.pendingReceivedCents),
      verifiedReceived: centsToMoney(metric.verifiedReceivedCents),
      platformReceived: centsToMoney(metric.platformReceivedCents),
      gross: centsToMoney(metric.grossCents),
      discount: centsToMoney(metric.discountCents),
      refundAdjustment: centsToMoney(metric.refundAdjustmentCents),
      itemCount: metric.itemCount,
      orderCount: metric.orderIds.size,
      platformOrderCount: metric.platformOrderIds.size,
    })),
    diagnostics: {
      unassignedItemCount: diagnostics.unassignedItemCount,
      unassignedSalesNet: centsToMoney(diagnostics.unassignedSalesNetCents),
    },
  };
}
