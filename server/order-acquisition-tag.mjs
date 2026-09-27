import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";

export const ORDER_ACQUISITION_TAG_FIELDS = [
  "isAcquisitionOrder",
  "acquisitionOrderUpdatedAt",
  "acquisitionOrderUpdatedBy",
  "acquisitionOrderUpdatedByName",
];

function error(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

const sessionVersion = (account) => {
  const value = Number(account?.sessionVersion ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
};

// Re-check the locked, persisted account, not merely the earlier auth lookup.
// This closes the interval in which an administrator can be disabled/demoted.
export function requireLockedAcquisitionTagAdmin(state, auth) {
  const username = String(auth?.user?.username ?? "").trim();
  const matches = (Array.isArray(state?.personnel) ? state.personnel : [])
    .filter((person) => String(person?.username ?? "").trim() === username);
  const account = matches.length === 1 ? matches[0] : null;
  if (!username || !account || !isPersonnelAccountEnabled(account) ||
      account.accessRole !== "admin" || auth?.user?.role !== "admin" ||
      String(account.id ?? "") !== String(auth?.account?.id ?? "") ||
      sessionVersion(account) !== sessionVersion(auth?.account)) {
    throw error(403, "ORDER_ACQUISITION_ADMIN_REQUIRED", "仅管理员可以设置获新订单标记");
  }
  return account;
}

export function assertOrderAcquisitionTagUnchanged(current = {}, next = {}) {
  const snapshot = (order) => JSON.stringify(Object.fromEntries(ORDER_ACQUISITION_TAG_FIELDS
    .filter((key) => Object.prototype.hasOwnProperty.call(order, key))
    .map((key) => [key, order[key]])));
  if (snapshot(current) !== snapshot(next)) {
    throw error(409, "ORDER_ACQUISITION_TAG_PROTECTED", "获新订单标记必须由管理员通过专用入口修改，请刷新后重试");
  }
}

export function planOrderAcquisitionTag(order, body, account, now = new Date().toISOString()) {
  if (typeof body?.isAcquisitionOrder !== "boolean") {
    throw error(400, "ORDER_ACQUISITION_TAG_INVALID", "请选择是否标记为获新订单");
  }
  if (typeof body.expectedIsAcquisitionOrder !== "boolean" ||
      typeof body.expectedAcquisitionOrderUpdatedAt !== "string") {
    throw error(409, "ORDER_ACQUISITION_TAG_CONFLICT", "缺少获新订单标记的原状态，请刷新后重试");
  }
  const current = order?.isAcquisitionOrder === true;
  // Setting a value already persisted is an idempotent no-op: no audit, price,
  // stock, status or updated timestamp is changed by repeat taps/retries.
  if (current === body.isAcquisitionOrder) return { order, unchanged: true };
  if (current !== body.expectedIsAcquisitionOrder ||
      String(order?.acquisitionOrderUpdatedAt ?? "") !== body.expectedAcquisitionOrderUpdatedAt) {
    throw error(409, "ORDER_ACQUISITION_TAG_CONFLICT", "获新订单标记已被其他管理员修改，请刷新后重试");
  }
  // Monotonic timestamp also detects false -> true -> false changes within one
  // millisecond instead of silently accepting a stale view of the same flag.
  const previousTime = Date.parse(String(order?.acquisitionOrderUpdatedAt ?? ""));
  const nowTime = Date.parse(now);
  const updatedAt = new Date(Number.isFinite(previousTime) ? Math.max(nowTime, previousTime + 1) : nowTime).toISOString();
  return {
    unchanged: false,
    order: {
      ...order,
      isAcquisitionOrder: body.isAcquisitionOrder,
      acquisitionOrderUpdatedAt: updatedAt,
      acquisitionOrderUpdatedBy: String(account.username),
      acquisitionOrderUpdatedByName: String(account.name || account.username),
    },
  };
}
