import { normalizeShippingFeeMode } from "./finance-utils.mjs";
import { actualShippingFeeRequiredAtOutbound } from "./shipment-rules.mjs";

const MAX_ACTUAL_SHIPPING_FEE = 100000;
const ALLOWED_REQUEST_KEYS = new Set([
  "shipmentId",
  "actualShippingFee",
  "expectedActualShippingFee",
]);
const ACTUAL_SHIPPING_FEE_MODES = new Set(["prepaid", "free"]);
const EDITABLE_SHIPMENT_STATUSES = new Set(["outbound", "shipped", "delivered", "damaged"]);

export class ShipmentActualShippingFeeError extends Error {
  constructor(message, { statusCode = 400, code = "INVALID_ACTUAL_SHIPPING_FEE" } = {}) {
    super(message);
    this.name = "ShipmentActualShippingFeeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function fail(message, options) {
  throw new ShipmentActualShippingFeeError(message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requestMoneyToCents(value, label, { allowZero = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${label}必须是有效数字`);
  }
  if (value < 0 || (!allowZero && value === 0)) {
    fail(allowZero ? `${label}不能为负数` : `${label}必须大于 0`);
  }
  if (value > MAX_ACTUAL_SHIPPING_FEE) {
    fail(`${label}不能超过 ${MAX_ACTUAL_SHIPPING_FEE}`);
  }
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-7) {
    fail(`${label}最多保留两位小数`);
  }
  if (!allowZero && cents <= 0) fail(`${label}必须大于 0`);
  return cents;
}

function revisionMoneyToCents(value, label, { stored = false } = {}) {
  const amount = stored ? Number(value ?? 0) : value;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    fail(stored ? "当前实际运费数据无效，请联系管理员处理" : `${label}必须是有效的非负数字`, {
      statusCode: stored ? 409 : 400,
      code: stored ? "INVALID_STORED_ACTUAL_SHIPPING_FEE" : "INVALID_ACTUAL_SHIPPING_FEE",
    });
  }
  const cents = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(cents)) {
    fail(stored ? "当前实际运费数值过大，请联系管理员处理" : `${label}数值过大`, {
      statusCode: stored ? 409 : 400,
      code: stored ? "INVALID_STORED_ACTUAL_SHIPPING_FEE" : "INVALID_ACTUAL_SHIPPING_FEE",
    });
  }
  return cents;
}

function storedMoneyToCents(value) {
  return revisionMoneyToCents(value, "当前实际运费", { stored: true });
}

export function normalizeActualShippingFee(value, { allowZero = true, label = "实际运费" } = {}) {
  return requestMoneyToCents(value, label, { allowZero }) / 100;
}

export function normalizeOutboundActualShippingFee(value, shippingFeeMode) {
  const amount = normalizeActualShippingFee(value ?? 0, { allowZero: true });
  if (actualShippingFeeRequiredAtOutbound(shippingFeeMode) && amount <= 0) {
    fail("包邮订单发货时必须填写实际运费");
  }
  return amount;
}

export function actualShippingFeeValuesDiffer(currentValue, nextValue) {
  const current = Number(currentValue ?? 0);
  const next = Number(nextValue ?? 0);
  if (!Number.isFinite(current) || !Number.isFinite(next)) return true;
  return Math.round(current * 100) !== Math.round(next * 100);
}

function normalizedSiteId(value) {
  return String(value ?? "").trim() || "nanjing";
}

export function parseActualShippingFeeRequest(value) {
  if (!isPlainObject(value)) fail("请求格式不正确");
  const unexpectedKey = Object.keys(value).find((key) => !ALLOWED_REQUEST_KEYS.has(key));
  if (unexpectedKey) fail(`不支持的请求字段：${unexpectedKey}`);
  const shipmentId = String(value.shipmentId ?? "").trim();
  if (!shipmentId) fail("缺少发货单 ID");
  if (!Object.prototype.hasOwnProperty.call(value, "actualShippingFee")) fail("缺少实际运费");
  if (!Object.prototype.hasOwnProperty.call(value, "expectedActualShippingFee")) {
    fail("缺少当前运费版本，请刷新后重试", {
      statusCode: 409,
      code: "ACTUAL_SHIPPING_FEE_REVISION_REQUIRED",
    });
  }
  const actualShippingFee = normalizeActualShippingFee(value.actualShippingFee, { allowZero: false });
  // The expected value is a concurrency token, not a new value. Legacy releases
  // could persist amounts above the current cap or with sub-cent precision, so
  // accept their cent-rounded representation to let an administrator repair them.
  const expectedActualShippingFeeCents = revisionMoneyToCents(
    value.expectedActualShippingFee,
    "预期当前实际运费"
  );
  return {
    shipmentId,
    actualShippingFee,
    expectedActualShippingFee: expectedActualShippingFeeCents / 100,
  };
}

export function planActualShippingFeeUpdate({
  state = {},
  request = {},
  hasOrderUpdatePermission = false,
  visibleSiteIds = [],
} = {}) {
  const parsed = parseActualShippingFeeRequest(request);
  if (!hasOrderUpdatePermission) {
    fail("当前账号没有订单模块的操作权限", {
      statusCode: 403,
      code: "ORDER_UPDATE_FORBIDDEN",
    });
  }

  const shipments = Array.isArray(state.shipments) ? state.shipments : [];
  const matchingShipments = shipments.filter((item) => String(item?.id ?? "") === parsed.shipmentId);
  if (matchingShipments.length === 0) {
    fail("发货单不存在，请刷新后重试", {
      statusCode: 404,
      code: "SHIPMENT_NOT_FOUND",
    });
  }
  if (matchingShipments.length !== 1) {
    fail("发货单 ID 不唯一，无法安全修改，请联系管理员处理", {
      statusCode: 409,
      code: "SHIPMENT_ID_NOT_UNIQUE",
    });
  }
  const [shipment] = matchingShipments;
  const orders = Array.isArray(state.orders) ? state.orders : [];
  const matchingOrders = orders.filter((item) =>
    String(item?.id ?? "") === String(shipment.orderId ?? "")
  );
  if (matchingOrders.length === 0) {
    fail("订单不存在，请刷新后重试", {
      statusCode: 404,
      code: "ORDER_NOT_FOUND",
    });
  }
  if (matchingOrders.length !== 1) {
    fail("关联订单 ID 不唯一，无法安全修改，请联系管理员处理", {
      statusCode: 409,
      code: "ORDER_ID_NOT_UNIQUE",
    });
  }
  const [order] = matchingOrders;

  const visible = new Set((Array.isArray(visibleSiteIds) ? visibleSiteIds : []).map(normalizedSiteId));
  if (!visible.has(normalizedSiteId(order.siteId))) {
    fail("当前账户无权操作该订单场地", {
      statusCode: 403,
      code: "ORDER_SITE_FORBIDDEN",
    });
  }
  if (order.status === "completed" || order.status === "cancelled") {
    fail("已完成或已取消订单不能补录实际运费", {
      statusCode: 409,
      code: "ORDER_NOT_EDITABLE",
    });
  }
  if (String(shipment.shipMethod ?? "express") !== "express") {
    fail("仅快递发货单可以补录实际运费");
  }
  const shippingFeeMode = normalizeShippingFeeMode(order.shippingFeeMode, order.source);
  if (!ACTUAL_SHIPPING_FEE_MODES.has(shippingFeeMode)) {
    fail("仅寄付或包邮订单可以通过此接口补录实际运费");
  }
  if (!EDITABLE_SHIPMENT_STATUSES.has(String(shipment.status ?? ""))) {
    fail("只有已出库、运输中、已签收或已报损的发货单可以修正实际运费", {
      statusCode: 409,
      code: "SHIPMENT_NOT_EDITABLE",
    });
  }

  const currentCents = storedMoneyToCents(shipment.actualShippingFee);
  const expectedCents = Math.round(parsed.expectedActualShippingFee * 100);
  if (currentCents !== expectedCents) {
    fail("运费已被他人更新，请刷新后重试", {
      statusCode: 409,
      code: "ACTUAL_SHIPPING_FEE_CONFLICT",
    });
  }

  const updatedShipment = {
    ...shipment,
    actualShippingFee: parsed.actualShippingFee,
  };
  return {
    order,
    shipment,
    updatedShipment,
    shipments: shipments.map((item) => item === shipment ? updatedShipment : item),
  };
}

export async function updateLockedAppState(client, stateId, planner) {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const planned = await planner(rows[0]?.data ?? {});
    await client.query(
      "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
      [stateId, JSON.stringify(planned.nextState)]
    );
    await client.query("COMMIT");
    return planned;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export { MAX_ACTUAL_SHIPPING_FEE };
