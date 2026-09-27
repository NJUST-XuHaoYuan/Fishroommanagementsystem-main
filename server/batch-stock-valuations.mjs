import { resolveStockPriceMode, stockPricingProtectedIds } from "./stock-pricing.mjs";

const array = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? "").trim();
const DEFAULT_SITE = "nanjing";

/** Old pickup records are already out of inventory even before normalization. */
export function batchStockUnavailableIds(state = {}) {
  const unavailable = stockPricingProtectedIds(state);
  for (const shipment of array(state.shipments)) {
    if (shipment?.shipMethod !== "pickup") continue;
    for (const stockId of array(shipment.itemStockIds)) if (text(stockId)) unavailable.add(text(stockId));
  }
  return unavailable;
}

// Ambiguous catalog/location identities must not silently pick an arbitrary row.
function unambiguousIndex(records) {
  const result = new Map();
  for (const record of array(records)) {
    const key = text(record?.id);
    if (key) result.set(key, result.has(key) ? null : record);
  }
  return result;
}

function priceCents(value) {
  if (!["number", "string"].includes(typeof value) || !text(value)) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round((amount + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

const bucket = () => ({ count: 0, unpricedCount: 0, cents: 0n });
function add(bucket, cents) {
  bucket.count += 1;
  if (cents == null) bucket.unpricedCount += 1;
  else bucket.cents += BigInt(cents);
}
function publicBucket(value) {
  if (value.cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    const error = new Error("批次预计售价超出可安全统计范围，请核对单条售价");
    error.statusCode = 409;
    error.code = "BATCH_VALUATION_OUT_OF_RANGE";
    throw error;
  }
  return { count: value.count, estimatedSaleValue: Number(value.cents) / 100, unpricedCount: value.unpricedCount };
}

/**
 * Read-only, retained-stock valuation. It never infers fish from batch counts,
 * loss evidence, removed snapshots, order prices or matching product names.
 * Current inventory loss flags win over order/shipment occupancy. Loss history
 * alone cannot make a restored fish dead again; shipping damage is not proof of
 * inventory death. Visible transfers remain attributed to their original batch.
 */
export function buildBatchStockValuations(input = {}) {
  const visible = new Set(array(input.visibleSiteIds).map(text).filter(Boolean));
  const products = unambiguousIndex(input.products);
  const species = unambiguousIndex(input.species);
  const batches = unambiguousIndex(input.batches);
  const tanks = new Map();
  for (const group of array(input.tankGroups)) {
    for (const tank of array(group?.subTanks)) {
      const key = text(tank?.id);
      if (key) tanks.set(key, tanks.has(key) ? null : text(group?.siteId) || DEFAULT_SITE);
    }
  }
  const unavailable = batchStockUnavailableIds(input);
  const metrics = new Map();
  for (const [batchId, batch] of batches) {
    if (!batch || !visible.has(text(batch.siteId) || DEFAULT_SITE)) continue;
    metrics.set(batchId, { batchId, unsold: bucket(), lost: bucket(), groups: new Map(), restrictedCount: 0, excludedCount: 0, invalidStockCount: 0 });
  }

  const stockById = new Map();
  for (const item of array(input.stock)) {
    const key = text(item?.id);
    if (!key) {
      const metric = metrics.get(text(item?.batchId));
      if (metric) metric.invalidStockCount += 1;
      continue;
    }
    const records = stockById.get(key) ?? [];
    records.push(item);
    stockById.set(key, records);
  }
  for (const [stockId, records] of stockById) {
    // Duplicate identities cannot establish a unique price, batch or site. Exclude
    // the identity once per affected authorized batch, never double-count it.
    if (records.length !== 1) {
      for (const batchId of new Set(records.map((item) => text(item?.batchId)))) {
        const metric = metrics.get(batchId);
        if (metric) metric.invalidStockCount += 1;
      }
      continue;
    }
    const item = records[0];
    const metric = metrics.get(text(item?.batchId));
    if (!metric) continue;
    const tankId = text(item?.subTankId);
    const currentSite = tanks.has(tankId) ? tanks.get(tankId) : text(item?.siteId) || DEFAULT_SITE;
    if (!currentSite || !visible.has(currentSite)) {
      metric.restrictedCount += 1;
      continue;
    }
    if (item._removed || (!item.lost && unavailable.has(stockId))) {
      metric.excludedCount += 1;
      continue;
    }
    const kind = item.lost ? "lost" : "unsold";
    const productId = text(item.productId);
    const product = products.get(productId);
    const speciesId = text(product?.speciesId);
    const speciesRecord = species.get(speciesId);
    const groupKey = speciesId ? `species:${speciesId}` : productId ? `product:${productId}` : `stock:${stockId}`;
    let group = metric.groups.get(groupKey);
    if (!group) {
      group = { speciesId: speciesId || groupKey, speciesName: text(speciesRecord?.name)
        || (speciesId ? `未识别品种（${speciesId}）` : product ? `${text(product.name) || productId}（未关联品种）`
          : productId ? `商品档案缺失（${productId}）` : `未关联商品（${stockId}）`), unsold: bucket(), lost: bucket() };
      metric.groups.set(groupKey, group);
    }
    let cents = null;
    if (kind === "lost") cents = priceCents(item.basePrice);
    else {
      try {
        cents = priceCents(resolveStockPriceMode(item) === "manual" ? item.basePrice : product?.defaultPrice);
      } catch {
        // An unknown pricing mode is a data exception, never a silent fallback.
      }
    }
    add(metric[kind], cents);
    add(group[kind], cents);
  }
  return { metrics: [...metrics.values()].map((metric) => ({
    batchId: metric.batchId,
    unsold: publicBucket(metric.unsold), lost: publicBucket(metric.lost),
    bySpecies: [...metric.groups.values()].map((group) => ({
      speciesId: group.speciesId, speciesName: group.speciesName,
      unsold: publicBucket(group.unsold), lost: publicBucket(group.lost),
    })).sort((a, b) => a.speciesName.localeCompare(b.speciesName, "zh-CN") || a.speciesId.localeCompare(b.speciesId)),
    restrictedCount: metric.restrictedCount, excludedCount: metric.excludedCount, invalidStockCount: metric.invalidStockCount,
  })) };
}
