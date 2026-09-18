const array = (value) => Array.isArray(value) ? value : [];
const id = (value) => String(value ?? "").trim();
const MODES = new Set(["product", "manual"]);
const has = (item, key) => Object.prototype.hasOwnProperty.call(item ?? {}, key);

function cents(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  const amount = Math.round((Number(value) + Number.EPSILON) * 100);
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function pricingError(message, statusCode = 400, code = "STOCK_PRICING_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function positivePrice(value, label) {
  const amount = cents(value);
  if (amount == null) throw pricingError(`${label}必须是有效的正数`);
  return amount / 100;
}

/** Old unclassified prices now follow the product unless manual intent is explicit. */
export function resolveStockPriceMode(stock = {}) {
  const mode = id(stock?.priceMode);
  if (MODES.has(mode)) return mode;
  // The explicit old mode takes precedence over a stale override flag.
  if (mode === "legacy") return "product";
  if (mode) throw pricingError("库存定价方式无法识别，请先核对记录");
  if (stock?.priceOverridden === true) return "manual";
  return "product";
}

/** Orders keep inventory unless cancelled or the particular line was removed. */
export function stockPricingProtectedIds(state = {}) {
  const protectedIds = new Set(array(state.stock)
    .filter((stock) => stock?.sold || stock?.lost || stock?.status === "sold")
    .map((stock) => id(stock.id)).filter(Boolean));
  for (const order of array(state.orders)) {
    if (!order || order.status === "cancelled") continue;
    for (const item of array(order.items)) {
      if (!id(item?.inventoryRemovedAt) && id(item?.stockItemId)) protectedIds.add(id(item.stockItemId));
    }
  }
  for (const shipment of array(state.shipments)) {
    if (!shipment || shipment.status === "preparing") continue;
    for (const stockId of array(shipment.itemStockIds)) if (id(stockId)) protectedIds.add(id(stockId));
  }
  return protectedIds;
}

function withMode(item, mode) {
  return { ...item, priceMode: mode,
    ...(mode === "product" ? { priceOverridden: false } : mode === "manual" ? { priceOverridden: true } : {}) };
}

/**
 * One-time, repeatable migration of old pricing modes. Historical amounts and
 * every non-pricing field remain untouched; free candidates use a unique valid
 * product price. Established product/manual records are deliberately not swept.
 */
export function migrateLegacyStockPricingState(state = {}) {
  const protectedIds = stockPricingProtectedIds(state);
  const productsById = new Map();
  for (const product of array(state.products)) {
    const productId = id(product?.id);
    if (!productId) continue;
    const matches = productsById.get(productId) ?? [];
    matches.push(product);
    productsById.set(productId, matches);
  }
  const counts = { total: 0, candidates: 0, legacyConverted: 0, unclassifiedConverted: 0,
    manualPreserved: 0, productPreserved: 0, protected: 0, priceUpdated: 0, modeUpdated: 0, exceptionCount: 0 };
  const exceptions = [];
  let changed = false;
  const stock = array(state.stock).map((item) => {
    counts.total += 1;
    const stockId = id(item?.id);
    const isProtected = protectedIds.has(stockId);
    const report = (reason) => exceptions.push({ stockId, reason, protected: isProtected });
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      report("INVALID_STOCK");
      return item;
    }
    const mode = id(item.priceMode);
    if (mode && !MODES.has(mode) && mode !== "legacy") {
      report("UNKNOWN_PRICE_MODE");
      return item;
    }
    if (mode === "manual" || (!mode && item.priceOverridden === true)) {
      counts.manualPreserved += 1;
      return item;
    }
    if (mode === "product") {
      counts.productPreserved += 1;
      return item;
    }
    counts.candidates += 1;
    counts[mode === "legacy" ? "legacyConverted" : "unclassifiedConverted"] += 1;
    if (isProtected) counts.protected += 1;
    const next = withMode(item, "product");
    const matches = productsById.get(id(item.productId)) ?? [];
    const productPrice = matches.length === 1 ? cents(matches[0].defaultPrice) : null;
    if (matches.length === 0) report("PRODUCT_MISSING");
    else if (matches.length > 1) report("PRODUCT_DUPLICATE");
    else if (productPrice == null) report("PRODUCT_PRICE_INVALID");
    else if (!isProtected && cents(item.basePrice) !== productPrice) {
      next.basePrice = productPrice / 100;
      counts.priceUpdated += 1;
    }
    counts.modeUpdated += 1;
    changed = true;
    return next;
  });
  counts.exceptionCount = exceptions.length;
  return { state: changed ? { ...state, stock } : state, changed, counts, exceptions };
}

/**
 * Normalize a proposed stock write using server-owned product data.
 * Old clients without a mode remain supported: changing an existing price is
 * manual intent, while an unchanged legacy price never becomes manual by accident.
 */
export function normalizeStockPricing(item = {}, product = {}, { existing, previousProduct = product, protected: isProtected = false } = {}) {
  const requested = id(item.priceMode);
  if (requested && !MODES.has(requested) && requested !== "legacy") throw pricingError("请选择有效的定价方式");
  const existingMode = existing ? resolveStockPriceMode(existing, previousProduct) : "";
  const priceChanged = existing && has(item, "basePrice") && cents(item.basePrice) !== cents(existing.basePrice);
  const productChanged = existing && id(item.productId) !== id(existing.productId);
  let mode;
  if (!existing) {
    if (requested === "legacy") throw pricingError("新增库存不能选择历史保留价");
    mode = requested || (item.priceOverridden === true ? "manual"
      : cents(item.basePrice) != null && cents(item.basePrice) === cents(product.defaultPrice) ? "product"
      : !has(item, "basePrice") ? "product" : "manual");
  } else if (requested === "legacy") {
    if (existingMode !== "product" || priceChanged || productChanged) {
      throw pricingError("历史价格已改为跟随商品价，请刷新后重新确认", 409, "STOCK_PRICING_STALE");
    }
    mode = "product";
  } else {
    mode = requested || (priceChanged ? "manual" : existingMode);
  }
  if (existing && isProtected) {
    if (mode !== existingMode || priceChanged || productChanged) {
      throw pricingError("已售、损耗、出库或订单占用的鱼不能修改定价，请先解除占用", 409, "STOCK_PRICING_PROTECTED");
    }
    return withMode({ ...item, basePrice: existing.basePrice }, existingMode);
  }
  const basePrice = mode === "product" ? positivePrice(product.defaultPrice, "商品默认价")
    : positivePrice(has(item, "basePrice") ? item.basePrice : existing?.basePrice, "单条售价");
  return withMode({ ...item, basePrice }, mode);
}

/** Product edit: preserve explicit manual prices and update only free followers. */
export function syncProductStockPrices(state = {}, oldProduct = {}, newProduct = {}) {
  const productId = id(newProduct.id);
  if (!productId || (oldProduct?.id && id(oldProduct.id) !== productId)) throw pricingError("商品编号不匹配");
  const nextPrice = positivePrice(newProduct.defaultPrice, "商品默认价");
  const protectedIds = stockPricingProtectedIds(state);
  const counts = { total: 0, product: 0, manual: 0, legacy: 0, protected: 0, priceUpdated: 0, modeFrozen: 0 };
  const updatedStock = [];
  const stock = array(state.stock).map((item) => {
    if (id(item?.productId) !== productId) return item;
    const mode = resolveStockPriceMode(item, oldProduct);
    const isProtected = protectedIds.has(id(item.id));
    counts.total += 1;
    counts[mode] += 1;
    if (isProtected) counts.protected += 1;
    if (!MODES.has(item.priceMode)) counts.modeFrozen += 1;
    const next = withMode(item, mode);
    if (mode === "product" && !isProtected && cents(item.basePrice) !== cents(nextPrice)) {
      next.basePrice = nextPrice;
      counts.priceUpdated += 1;
    }
    if (next.priceMode === item.priceMode && next.priceOverridden === item.priceOverridden && next.basePrice === item.basePrice) return item;
    updatedStock.push(next);
    return next;
  });
  return { stock, updatedStock, counts };
}

/** On genuine release from a reservation, resume the frozen product mode. */
export function reconcileReleasedStockPricing(previousState = {}, nextState = {}) {
  const previouslyProtected = stockPricingProtectedIds(previousState);
  const stillProtected = stockPricingProtectedIds(nextState);
  const previousStock = new Map(array(previousState.stock).map((item) => [id(item?.id), item]));
  const currentProducts = new Map();
  for (const product of array(nextState.products)) {
    const productId = id(product?.id);
    currentProducts.set(productId, currentProducts.has(productId) ? null : product);
  }
  let changed = false;
  const stock = array(nextState.stock).map((item) => {
    const stockId = id(item?.id);
    if (!previouslyProtected.has(stockId) || stillProtected.has(stockId)) return item;
    const previous = previousStock.get(stockId);
    if (!previous || id(previous.productId) !== id(item.productId)) return item;
    const mode = resolveStockPriceMode(id(item.priceMode) || item.priceOverridden === true ? item : previous);
    const next = withMode(item, mode);
    const defaultCents = cents(currentProducts.get(id(item.productId))?.defaultPrice);
    if (mode === "product" && defaultCents != null) next.basePrice = defaultCents / 100;
    if (next.priceMode === item.priceMode && next.priceOverridden === item.priceOverridden && next.basePrice === item.basePrice) return item;
    changed = true;
    return next;
  });
  return changed ? { ...nextState, stock } : nextState;
}
