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
    };
  });
}
