export const ORDER_WHOLESALE_TAG_FIELDS = Object.freeze([
  "isWholesaleOrder",
  "wholesaleOrderUpdatedAt",
  "wholesaleOrderUpdatedBy",
  "wholesaleOrderUpdatedByName",
]);

function fail(statusCode, code, message) {
  throw Object.assign(new Error(message), { statusCode, code });
}

// Wholesale is an explicit order classification, independent from customer B
// type, new-customer approval and commission. Absent/false means unmarked only.
export function assertOrderWholesaleTagUnchanged(current = {}, next = {}) {
  const snapshot = (order) => JSON.stringify(Object.fromEntries(ORDER_WHOLESALE_TAG_FIELDS
    .filter((key) => Object.prototype.hasOwnProperty.call(order, key))
    .map((key) => [key, order[key]])));
  if (snapshot(current) !== snapshot(next)) {
    fail(409, "ORDER_WHOLESALE_TAG_PROTECTED", "批发订单标记必须通过专用入口修改，请刷新后重试");
  }
  if ((current.source === "批发") !== (next.source === "批发")) {
    fail(409, "ORDER_WHOLESALE_SOURCE_PROTECTED", "请在订单编辑页面修改批发来源，以同步订单分类");
  }
}

// Creation derives its classification from the chosen source. An optional
// boolean must agree; audit identity and time remain server-owned. Historical
// retail-source tags still use the dedicated CAS-protected route.
export function initializeCreatedOrderWholesaleTag(order, body, account, now = new Date().toISOString()) {
  const supplied = Object.prototype.hasOwnProperty.call(body, "isWholesaleOrder");
  if (supplied && typeof body.isWholesaleOrder !== "boolean") {
    fail(400, "ORDER_WHOLESALE_TAG_INVALID", "请选择是否标记为批发订单");
  }
  const wholesale = order.source === "批发";
  if (supplied && body.isWholesaleOrder !== wholesale) {
    fail(400, "ORDER_WHOLESALE_SOURCE_CONFLICT", "订单来源与批发标记不一致，请重新选择订单来源");
  }
  if (!wholesale) return order;
  return planOrderWholesaleTag(order, {
    isWholesaleOrder: true,
    expectedIsWholesaleOrder: false,
    expectedWholesaleOrderUpdatedAt: "",
  }, account, now).order;
}

// Retail-source historical tags remain editable through their existing route.
// Only crossing the new wholesale source boundary changes classification here.
export function synchronizeUpdatedOrderWholesaleTag(currentOrder, nextOrder, account, now = new Date().toISOString()) {
  if ((currentOrder.source === "批发") === (nextOrder.source === "批发")) return nextOrder;
  return planOrderWholesaleTag(nextOrder, {
    isWholesaleOrder: nextOrder.source === "批发",
    expectedIsWholesaleOrder: currentOrder.isWholesaleOrder === true,
    expectedWholesaleOrderUpdatedAt: String(currentOrder.wholesaleOrderUpdatedAt ?? ""),
  }, account, now).order;
}

export function planOrderWholesaleTag(order, body, account, now = new Date().toISOString()) {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.isWholesaleOrder !== "boolean") {
    fail(400, "ORDER_WHOLESALE_TAG_INVALID", "请选择是否标记为批发订单");
  }
  if (order?.source === "批发" && !body.isWholesaleOrder) {
    fail(409, "ORDER_WHOLESALE_SOURCE_PROTECTED", "批发来源订单不能单独取消批发标记，请在订单编辑页面改为零售来源");
  }
  if (typeof body.expectedIsWholesaleOrder !== "boolean" ||
      typeof body.expectedWholesaleOrderUpdatedAt !== "string" || body.expectedWholesaleOrderUpdatedAt.length > 100) {
    fail(409, "ORDER_WHOLESALE_TAG_CONFLICT", "缺少批发订单标记的原状态，请刷新后重试");
  }
  const current = order?.isWholesaleOrder === true;
  // Network retries and repeated clicks do not create extra audit rows or
  // advance the timestamp when the desired value is already persisted.
  if (current === body.isWholesaleOrder) return { order, unchanged: true };
  if (current !== body.expectedIsWholesaleOrder ||
      String(order?.wholesaleOrderUpdatedAt ?? "") !== body.expectedWholesaleOrderUpdatedAt) {
    fail(409, "ORDER_WHOLESALE_TAG_CONFLICT", "批发订单标记已被其他人修改，请刷新后重试");
  }
  const previousTime = Date.parse(String(order?.wholesaleOrderUpdatedAt ?? ""));
  const nowTime = Date.parse(now);
  const updatedAt = new Date(Number.isFinite(previousTime) ? Math.max(nowTime, previousTime + 1) : nowTime).toISOString();
  return {
    unchanged: false,
    order: {
      ...order,
      isWholesaleOrder: body.isWholesaleOrder,
      wholesaleOrderUpdatedAt: updatedAt,
      wholesaleOrderUpdatedBy: String(account.username),
      wholesaleOrderUpdatedByName: String(account.name || account.username),
    },
  };
}
