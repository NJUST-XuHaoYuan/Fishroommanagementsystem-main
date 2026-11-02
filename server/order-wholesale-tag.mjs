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
}

export function planOrderWholesaleTag(order, body, account, now = new Date().toISOString()) {
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.isWholesaleOrder !== "boolean") {
    fail(400, "ORDER_WHOLESALE_TAG_INVALID", "请选择是否标记为批发订单");
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
