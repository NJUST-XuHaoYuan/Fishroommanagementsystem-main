export function normalizeShipmentInventoryId(value) {
  return String(value ?? "").trim();
}

const normalizedId = normalizeShipmentInventoryId;

export function projectedShippedOutStockIds({
  shipments = [],
  orders = [],
  inventoryProjection = {},
} = {}) {
  const ids = new Set(
    (Array.isArray(shipments) ? shipments : [])
      .filter((shipment) => String(shipment?.status ?? "") !== "preparing")
      .flatMap((shipment) => Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds : [])
      .map(normalizedId)
      .filter(Boolean)
  );
  for (const id of Array.isArray(inventoryProjection?.outStockIds) ? inventoryProjection.outStockIds : []) {
    const stockId = normalizedId(id);
    if (stockId) ids.add(stockId);
  }
  for (const order of Array.isArray(orders) ? orders : []) {
    if (String(order?.status ?? "") !== "completed") continue;
    for (const item of Array.isArray(order?.items) ? order.items : []) {
      if (normalizedId(item?.inventoryRemovedAt)) continue;
      const stockId = normalizedId(item?.stockItemId);
      if (stockId) ids.add(stockId);
    }
  }
  return ids;
}

export function projectedInventoryOutDateByStockId({
  shipments = [],
  inventoryProjection = {},
} = {}) {
  const dates = new Map();
  for (const [rawId, rawDate] of Object.entries(
    inventoryProjection?.outDateByStockId && typeof inventoryProjection.outDateByStockId === "object"
      ? inventoryProjection.outDateByStockId
      : {}
  )) {
    const stockId = normalizedId(rawId);
    const date = String(rawDate ?? "").slice(0, 10);
    if (stockId && /^\d{4}-\d{2}-\d{2}$/.test(date)) dates.set(stockId, date);
  }
  for (const shipment of Array.isArray(shipments) ? shipments : []) {
    if (!shipment || String(shipment.status ?? "") === "preparing") continue;
    const date = String(
      shipment.outboundDate ?? shipment.shipDate ?? shipment.createdAt ?? ""
    ).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (const rawId of Array.isArray(shipment.itemStockIds) ? shipment.itemStockIds : []) {
      const stockId = normalizedId(rawId);
      if (!stockId) continue;
      const current = dates.get(stockId);
      if (!current || date < current) dates.set(stockId, date);
    }
  }
  return dates;
}

export function inventoryProjectionForStock(
  state = {},
  stock = state?.stock,
  { inheritProjection = false } = {},
) {
  const outStockIds = projectedShippedOutStockIds({
    shipments: state?.shipments,
    orders: state?.orders,
    inventoryProjection: inheritProjection ? state?.inventoryProjection : {},
  });
  const visibleStockIds = new Set((Array.isArray(stock) ? stock : [])
    .map((item) => normalizedId(item?.id))
    .filter(Boolean));
  const outDates = projectedInventoryOutDateByStockId({
    shipments: state?.shipments,
    inventoryProjection: inheritProjection ? state?.inventoryProjection : {},
  });
  return {
    outStockIds: [...outStockIds].filter((id) => visibleStockIds.has(id)),
    outDateByStockId: Object.fromEntries(
      [...outDates].filter(([id]) => visibleStockIds.has(id))
    ),
  };
}

function sameImmutableValue(field, left, right) {
  if (field === "itemStockIds") {
    return JSON.stringify(Array.isArray(left) ? left : []) === JSON.stringify(Array.isArray(right) ? right : []);
  }
  return normalizedId(left) === normalizedId(right);
}

const IMMUTABLE_SHIPMENT_FIELDS = Object.freeze([
  "id",
  "orderId",
  "shipMethod",
  "itemStockIds",
  "createdAt",
]);

export function assertShipmentInventoryIdentityUnchanged(
  currentShipment = {},
  nextShipment = {},
  { expectedSiteId = "" } = {},
) {
  const changedField = IMMUTABLE_SHIPMENT_FIELDS.find((field) =>
    !sameImmutableValue(field, currentShipment?.[field], nextShipment?.[field])
  );
  if (changedField) {
    throw new Error("发货单的订单、场地、方式和商品明细建立后不能通过普通编辑修改");
  }
  const currentSiteId = normalizedId(currentShipment?.siteId);
  const nextSiteId = normalizedId(nextShipment?.siteId);
  if (currentSiteId !== nextSiteId) {
    const isSafeLegacyBackfill = !currentSiteId && nextSiteId && nextSiteId === normalizedId(expectedSiteId);
    if (!isSafeLegacyBackfill) {
      throw new Error("发货单的订单、场地、方式和商品明细建立后不能通过普通编辑修改");
    }
  }
}

export function assertActiveShipmentInventoryAssignment(
  shipment = {},
  { orders = [], stock = [] } = {},
) {
  if (String(shipment?.status ?? "") === "preparing") return;

  const itemStockIds = (Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds : [])
    .map(normalizedId)
    .filter(Boolean);
  if (itemStockIds.length === 0) {
    throw new Error("已出库或已签收的发货单必须保留商品明细");
  }
  if (new Set(itemStockIds).size !== itemStockIds.length) {
    throw new Error("同一条库存鱼不能在一张发货单中重复出现");
  }

  const orderId = normalizedId(shipment?.orderId);
  const order = (Array.isArray(orders) ? orders : [])
    .find((item) => normalizedId(item?.id) === orderId);
  if (!order) throw new Error("发货单关联订单不存在，请刷新后重试");
  const shipmentSiteId = normalizedId(shipment?.siteId);
  const orderSiteId = normalizedId(order?.siteId);
  if (shipmentSiteId && orderSiteId && shipmentSiteId !== orderSiteId) {
    throw new Error("发货单场地与关联订单不一致，不能保存");
  }

  const orderItemIds = new Set((Array.isArray(order?.items) ? order.items : [])
    .filter((item) => !normalizedId(item?.inventoryRemovedAt))
    .map((item) => normalizedId(item?.stockItemId))
    .filter(Boolean));
  if (itemStockIds.some((id) => !orderItemIds.has(id))) {
    throw new Error("发货单商品明细与关联订单不一致，不能保存");
  }

  const stockIds = new Set((Array.isArray(stock) ? stock : [])
    .map((item) => normalizedId(item?.id))
    .filter(Boolean));
  if (itemStockIds.some((id) => !stockIds.has(id))) {
    throw new Error("发货单包含已不存在的库存记录，不能保存");
  }
}

export function activeShipmentInventoryAssignmentIsValid(shipment = {}, state = {}) {
  try {
    assertActiveShipmentInventoryAssignment(shipment, state);
    return true;
  } catch {
    return false;
  }
}

export function shipmentPatchRequiresAssignmentValidation(
  currentShipment = {},
  nextShipment = {},
  currentState = {},
) {
  return String(currentShipment?.status ?? "") !== String(nextShipment?.status ?? "") ||
    activeShipmentInventoryAssignmentIsValid(currentShipment, currentState);
}

export { IMMUTABLE_SHIPMENT_FIELDS };
