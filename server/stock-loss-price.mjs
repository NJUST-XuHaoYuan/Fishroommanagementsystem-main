const PRICING_KEYS = ["basePrice", "priceMode", "priceOverridden"];
const has = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

function lossPriceError(message, statusCode = 400, code = "LOSS_PRICE_INVALID") {
  const error = new Error(message);
  Object.assign(error, { statusCode, code });
  return error;
}

/** Preserve raw stored values for compare-and-swap, including legacy omissions. */
export function lossPricingSnapshot(stockItem = {}) {
  return Object.fromEntries(PRICING_KEYS.map((key) => [key, stockItem?.[key] ?? null]));
}

export function lossStockPricingUpdate(stockItem = {}) {
  return { id: stockItem.id, ...lossPricingSnapshot(stockItem) };
}

export function normalizeLossPrice(value) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "number" && !Number.isFinite(value))) {
    throw lossPriceError("预计价值必须是正数，最多保留两位小数");
  }
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw lossPriceError("预计价值必须是正数，最多保留两位小数");
  }
  const [whole, fraction = ""] = text.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw lossPriceError("预计价值超出有效正数范围");
  }
  const amount = Number(cents) / 100;
  const [storedWhole, storedFraction = ""] = String(amount).split(".");
  if (BigInt(storedWhole) * 100n + BigInt(storedFraction.padEnd(2, "0")) !== cents) {
    throw lossPriceError("预计价值过大，无法精确保留到分");
  }
  return amount;
}

/** Called only after the route has locked state and rechecked the administrator. */
export function planLossPriceUpdate(stock = [], input = {}) {
  const stockItemId = typeof input?.stockItemId === "string" ? input.stockItemId.trim() : "";
  if (!stockItemId) throw lossPriceError("请选择需要修改预计价值的死亡鱼", 400, "LOSS_STOCK_ID_REQUIRED");
  const matches = (Array.isArray(stock) ? stock : []).filter((item) => String(item?.id ?? "") === stockItemId);
  if (!matches.length) throw lossPriceError("该库存记录已不存在，请刷新后重试", 404, "LOSS_STOCK_NOT_FOUND");
  if (matches.length !== 1) throw lossPriceError("库存编号重复，请先核对记录", 409, "LOSS_STOCK_AMBIGUOUS");
  const current = matches[0];
  if (current.lost !== true) throw lossPriceError("仅已标记损耗的死亡鱼可以更正预计价值", 409, "LOSS_STOCK_NOT_LOST");
  const basePrice = normalizeLossPrice(input.basePrice);
  const expected = input.expectedPricing;
  const snapshot = lossPricingSnapshot(current);
  if (!expected || typeof expected !== "object" || Array.isArray(expected) ||
      PRICING_KEYS.some((key) => !has(expected, key) || expected[key] !== snapshot[key])) {
    const error = lossPriceError("该鱼的预计价值或定价方式已变化，请刷新后重新确认", 409, "LOSS_PRICE_STALE");
    error.stockPricingUpdate = lossStockPricingUpdate(current);
    error.currentPricingSnapshot = snapshot;
    throw error;
  }
  const updated = { ...current, basePrice, priceMode: "manual", priceOverridden: true };
  return { current, updated, unchanged: PRICING_KEYS.every((key) => current[key] === updated[key]) };
}
