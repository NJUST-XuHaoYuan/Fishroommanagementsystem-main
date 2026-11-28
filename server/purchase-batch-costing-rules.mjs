import { calculatePurchaseBatchCosting, normalizePurchaseProcurement } from "./purchase-batch-costing.mjs";

const text = value => String(value ?? "").trim();
const fail = (message, code, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode, code }); };
const snapshot = source => ({
  productName: source.productName,
  size: source.size,
  origin: source.origin,
  ...(source.speciesId !== undefined ? { speciesId: source.speciesId } : {}),
});

// This planner does not write inventory, sales prices, costs of existing stock,
// accounting entries or legacy batch fields. Its caller owns permission, CAS,
// explicit legacy conversion confirmation and the transaction boundary.
export function preparePurchaseProcurement(input, {
  current, products = [], confirmed = false, operator, now = new Date().toISOString(),
} = {}) {
  const username = text(typeof operator === "object" ? operator?.username : operator);
  if (!username || username.length > 200) fail("缺少有效操作员", "PURCHASE_COST_OPERATOR_REQUIRED");
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) fail("操作时间无效", "PURCHASE_COST_TIME_INVALID");
  const timestamp = date.toISOString();
  const normalized = normalizePurchaseProcurement(input, { confirmed });
  const currentLines = Array.isArray(current?.lines) ? current.lines : [];
  const catalog = Array.isArray(products) ? products : [];
  const lines = normalized.lines.map(line => {
    const originals = currentLines.filter(previous => text(previous?.id) === line.id);
    if (originals.length > 1) fail("已有采购明细编号重复，请先核对", "PURCHASE_COST_CURRENT_LINE_AMBIGUOUS", 409);
    const previous = originals[0];
    if (previous && text(previous.productId) === line.productId) {
      // Existing snapshots remain valid after product rename, archival or
      // deletion. Never silently rewrite what was actually purchased.
      const result = { ...line };
      delete result.speciesId;
      return { ...result, ...snapshot(previous) };
    }
    const matches = catalog.filter(product => text(product?.id) === line.productId);
    if (matches.length !== 1 || matches[0]?.archivedAt || !text(matches[0]?.name)) {
      fail("新增或更换的采购商品不存在、已停用或编号不唯一，请重新选择", "PURCHASE_COST_PRODUCT_INVALID", 409);
    }
    const product = matches[0];
    const result = { ...line };
    delete result.speciesId;
    return { ...result, productName: text(product.name), size: text(product.size), origin: text(product.origin),
      ...(text(product.speciesId) ? { speciesId: text(product.speciesId) } : {}) };
  });
  // Enforce the same bounded snapshot format on authoritative catalog data.
  const procurement = normalizePurchaseProcurement({ ...normalized, lines }, { confirmed });
  return {
    ...procurement,
    ...(confirmed ? { allocation: calculatePurchaseBatchCosting(procurement),
      confirmedAt: current?.status === "confirmed" && text(current.confirmedAt) ? current.confirmedAt : timestamp,
      confirmedBy: current?.status === "confirmed" && text(current.confirmedBy) ? current.confirmedBy : username } : {}),
    updatedAt: timestamp, updatedBy: username,
  };
}
