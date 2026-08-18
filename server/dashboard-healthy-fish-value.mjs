const HEALTHY_STOCK_STATUSES = new Set(["healthy", "feeding"]);
const MAX_SAFE_CENTS = BigInt(Number.MAX_SAFE_INTEGER);

export class HealthyFishInventoryValueError extends RangeError {
  constructor(message = "Healthy fish inventory value exceeds the supported safe range") {
    super(message);
    this.name = "HealthyFishInventoryValueError";
    this.code = "HEALTHY_FISH_VALUE_OVERFLOW";
  }
}

function normalizedId(value) {
  return String(value ?? "").trim();
}

function positiveMoneyCents(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  const normalized = typeof value === "string" ? value.trim() : value;
  if (typeof normalized === "string" && !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return 0;
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const cents = Math.round((amount + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : 0;
}

export function isFishCategory(category = "") {
  const text = String(category ?? "");
  if (/(活石|活性炭|吸附|滤材|耗材|器材|设备|材料|药|盐|饲料|鱼粮|试剂)/.test(text)) return false;
  if (text.includes("虾虎") || text.includes("鰕虎")) return true;
  return !/(虾|蟹|螺|贝|海胆|珊瑚|海星|海葵)/.test(text);
}

export function isFishInventoryItem(product = null, species = null) {
  const commonNames = Array.isArray(species?.commonNames) ? species.commonNames : [];
  const text = [
    species?.category,
    species?.name,
    species?.scientificName,
    ...commonNames,
    product?.name,
    product?.size,
    product?.origin,
    product?.notes,
  ].filter(Boolean).join(" ");
  if (/(耗材|活石|活石头|珊瑚|活性炭|吸附|滤材|器材|设备|材料|药|盐|饲料|鱼粮|试剂)/.test(text)) return false;
  return isFishCategory(String(species?.category ?? text));
}

export function stockEstimatedSalePriceCents(stock = {}, product = null) {
  const stockPrice = positiveMoneyCents(stock?.basePrice);
  if (stockPrice > 0) return stockPrice;
  return positiveMoneyCents(product?.defaultPrice);
}

/**
 * Calculates the estimated selling value of healthy, unsold fish physically in stock.
 * The caller must pass stock/products/species after account and site scoping, together
 * with the trusted global inventory projection's out-of-stock identifiers.
 */
export function healthyFishInventoryMetrics({
  stock = [],
  products = [],
  species = [],
  outStockIds = [],
} = {}) {
  const productById = new Map(
    (Array.isArray(products) ? products : [])
      .map((product) => [normalizedId(product?.id), product])
      .filter(([id]) => Boolean(id))
  );
  const speciesById = new Map(
    (Array.isArray(species) ? species : [])
      .map((item) => [normalizedId(item?.id), item])
      .filter(([id]) => Boolean(id))
  );
  const projectedOutIds = new Set(
    [...(outStockIds && typeof outStockIds[Symbol.iterator] === "function" ? outStockIds : [])]
      .map(normalizedId)
      .filter(Boolean)
  );
  const seenStockIds = new Set();
  let valueCents = 0n;
  let count = 0;
  let unpricedCount = 0;

  for (const item of Array.isArray(stock) ? stock : []) {
    const stockId = normalizedId(item?.id);
    if (!stockId || seenStockIds.has(stockId)) continue;
    seenStockIds.add(stockId);
    if (item?.lost || item?.sold || projectedOutIds.has(stockId)) continue;
    if (!HEALTHY_STOCK_STATUSES.has(String(item?.status ?? ""))) continue;

    const product = productById.get(normalizedId(item?.productId));
    if (!product) continue;
    const itemSpecies = speciesById.get(normalizedId(product?.speciesId));
    if (!isFishInventoryItem(product, itemSpecies)) continue;

    count += 1;
    const priceCents = stockEstimatedSalePriceCents(item, product);
    if (priceCents > 0) {
      valueCents += BigInt(priceCents);
      if (valueCents > MAX_SAFE_CENTS) throw new HealthyFishInventoryValueError();
    }
    else unpricedCount += 1;
  }

  return {
    value: Number(valueCents) / 100,
    count,
    unpricedCount,
  };
}
