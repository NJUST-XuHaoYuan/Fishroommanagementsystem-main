export class OrderShipmentMutationTargetError extends Error {
  constructor(message, { statusCode = 400, code = "ORDER_SHIPMENT_TARGET_INVALID" } = {}) {
    super(message);
    this.name = "OrderShipmentMutationTargetError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizedId(value) {
  return String(value ?? "").trim();
}

function resolveExactlyOne(records, requestedId, {
  missingIdMessage,
  missingIdCode,
  notFoundMessage,
  notFoundCode,
  duplicateMessage,
  duplicateCode,
}) {
  const id = normalizedId(requestedId);
  if (!id) {
    throw new OrderShipmentMutationTargetError(missingIdMessage, {
      statusCode: 400,
      code: missingIdCode,
    });
  }
  const matches = (Array.isArray(records) ? records : [])
    .filter((record) => normalizedId(record?.id) === id);
  if (matches.length === 0) {
    throw new OrderShipmentMutationTargetError(notFoundMessage, {
      statusCode: 404,
      code: notFoundCode,
    });
  }
  if (matches.length !== 1) {
    throw new OrderShipmentMutationTargetError(duplicateMessage, {
      statusCode: 409,
      code: duplicateCode,
    });
  }
  return matches[0];
}

export function resolveUniqueOrderMutationTarget(state = {}, orderId) {
  const order = resolveExactlyOne(state.orders, orderId, {
    missingIdMessage: "缺少订单信息，请刷新后重试",
    missingIdCode: "ORDER_ID_REQUIRED",
    notFoundMessage: "订单不存在，请刷新后重试",
    notFoundCode: "ORDER_NOT_FOUND",
    duplicateMessage: "订单 ID 不唯一，无法安全操作，请联系管理员处理",
    duplicateCode: "ORDER_ID_NOT_UNIQUE",
  });
  return {
    order,
    orders: Array.isArray(state.orders) ? state.orders : [],
    siteId: normalizedId(order.siteId),
  };
}

export function resolveUniqueShipmentMutationTarget(state = {}, shipmentId) {
  const shipment = resolveExactlyOne(state.shipments, shipmentId, {
    missingIdMessage: "缺少发货单信息，请刷新后重试",
    missingIdCode: "SHIPMENT_ID_REQUIRED",
    notFoundMessage: "发货单不存在，请刷新后重试",
    notFoundCode: "SHIPMENT_NOT_FOUND",
    duplicateMessage: "发货单 ID 不唯一，无法安全操作，请联系管理员处理",
    duplicateCode: "SHIPMENT_ID_NOT_UNIQUE",
  });
  const orderId = normalizedId(shipment.orderId);
  const { order, orders, siteId } = resolveUniqueOrderMutationTarget(state, orderId);
  return {
    shipment,
    shipments: Array.isArray(state.shipments) ? state.shipments : [],
    order,
    orders,
    // The stored order owns the site scope. Never authorize from request data or
    // from the denormalized shipment.siteId value.
    siteId,
  };
}
