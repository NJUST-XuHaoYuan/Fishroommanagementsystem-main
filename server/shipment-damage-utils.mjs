import { resolveStockPriceMode } from "./stock-pricing.mjs";

function cleanText(value) {
  return String(value ?? "").trim();
}

function tankNameById(tankGroups, subTankId) {
  const targetId = cleanText(subTankId);
  if (!targetId) return "";
  for (const group of Array.isArray(tankGroups) ? tankGroups : []) {
    const tank = (Array.isArray(group?.subTanks) ? group.subTanks : [])
      .find((item) => cleanText(item?.id) === targetId);
    if (tank) return [cleanText(group?.name), cleanText(tank?.name)].filter(Boolean).join(" / ");
  }
  return "";
}

export function normalizeDamageReplacementSelection(replacements = [], shippedItemIds = []) {
  const shippedItemIdSet = new Set(
    (Array.isArray(shippedItemIds) ? shippedItemIds : []).map(cleanText).filter(Boolean)
  );
  const normalized = [];
  const originalIds = new Set();
  const replacementIds = new Set();

  for (const replacement of Array.isArray(replacements) ? replacements : []) {
    const originalStockItemId = cleanText(replacement?.originalStockItemId);
    const replacementStockItemId = cleanText(replacement?.replacementStockItemId);
    if (!originalStockItemId || !replacementStockItemId) throw new Error("请选择补发库存鱼");
    if (!shippedItemIdSet.has(originalStockItemId)) {
      throw new Error("补发原商品不属于当前发货单，请刷新后重试");
    }
    if (originalIds.has(originalStockItemId)) throw new Error("同一条商品不能重复报损");
    if (replacementIds.has(replacementStockItemId)) throw new Error("同一条库存鱼不能重复补发");
    originalIds.add(originalStockItemId);
    replacementIds.add(replacementStockItemId);
    normalized.push({ originalStockItemId, replacementStockItemId });
  }

  if (normalized.length === 0) throw new Error("请选择补发库存鱼");
  return normalized;
}

export function snapshotDamageReplacements({ replacements, stock, products, tankGroups } = {}) {
  const stockById = new Map(
    (Array.isArray(stock) ? stock : []).map((item) => [cleanText(item?.id), item])
  );
  const productById = new Map(
    (Array.isArray(products) ? products : []).map((item) => [cleanText(item?.id), item])
  );

  return (Array.isArray(replacements) ? replacements : []).map((replacement) => {
    const originalStockItemId = cleanText(replacement?.originalStockItemId);
    const replacementStockItemId = cleanText(replacement?.replacementStockItemId);
    const originalStock = stockById.get(originalStockItemId);
    const replacementStock = stockById.get(replacementStockItemId);
    const originalProductId = cleanText(originalStock?.productId);
    const replacementProductId = cleanText(replacementStock?.productId);
    // A product-following fish may still carry a historical basePrice cache.
    const replacementProduct = productById.get(replacementProductId);
    const rawPrice = resolveStockPriceMode(replacementStock) === "manual"
      ? replacementStock?.basePrice : replacementProduct?.defaultPrice;
    const replacementSalePrice = Number(rawPrice);

    return {
      originalStockItemId,
      replacementStockItemId,
      originalFishCode: cleanText(originalStock?.code),
      replacementFishCode: cleanText(replacementStock?.code),
      originalProductId,
      replacementProductId,
      originalProductName: cleanText(productById.get(originalProductId)?.name),
      replacementProductName: cleanText(productById.get(replacementProductId)?.name),
      originalTankName: tankNameById(tankGroups, originalStock?.subTankId),
      replacementTankName: tankNameById(tankGroups, replacementStock?.subTankId),
      ...(rawPrice != null && cleanText(rawPrice) !== "" && Number.isFinite(replacementSalePrice) && replacementSalePrice >= 0
        ? { replacementSalePrice: Number(replacementSalePrice.toFixed(2)) } : {}),
    };
  });
}

/** Preserve old business facts without pretending an old replacement price is known. */
export function appendShipmentDamageEvent(shipment = {}, event = {}) {
  const previous = Array.isArray(shipment.damageEvents) ? shipment.damageEvents : [];
  const legacy = previous.length === 0 && shipment.status === "damaged"
    ? [{ id: `damage-legacy-${cleanText(shipment.id)}`, time: cleanText(shipment.damagedAt || shipment.deliveredAt || shipment.shippedAt || shipment.shipDate || shipment.createdAt),
        resolution: shipment.damageResolution, legacy: true,
        replacements: (Array.isArray(shipment.damageReplacements) ? shipment.damageReplacements : []).map(item => ({ ...item })),
      }]
    : [];
  return [...previous, ...legacy, event];
}
