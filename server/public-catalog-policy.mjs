export const PUBLIC_CATALOG_MAJOR_CATEGORIES = Object.freeze([
  Object.freeze({ key: "marineFish", label: "海水鱼" }),
  Object.freeze({ key: "coral", label: "珊瑚" }),
  Object.freeze({ key: "invertebrate", label: "无脊椎" }),
  Object.freeze({ key: "consumable", label: "耗材" }),
]);

const PUBLIC_CATALOG_MAJOR_CATEGORY_KEYS = new Set(
  PUBLIC_CATALOG_MAJOR_CATEGORIES.map((category) => category.key)
);
const PUBLIC_CATALOG_MAJOR_CATEGORY_LABELS = new Map(
  PUBLIC_CATALOG_MAJOR_CATEGORIES.map((category) => [category.key, category.label])
);
const MAX_POLICY_ENTITY_IDS = 50_000;
const MAX_POLICY_ENTITY_ID_LENGTH = 240;
const MAX_PRODUCT_DISPLAY_CAP = 1_000_000;
const MAX_POLICY_AUDIT_ITEMS_PER_GROUP = 4;
const MAX_POLICY_AUDIT_LABEL_LENGTH = 44;
const MAX_POLICY_AUDIT_DETAIL_LENGTH = 1_000;

function normalizedId(value) {
  return String(value ?? "").trim();
}

function uniqueNormalizedIds(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const id = normalizedId(item);
    if (!id || id.length > MAX_POLICY_ENTITY_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= MAX_POLICY_ENTITY_IDS) break;
  }
  return result;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedPositiveInteger(value) {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return 0;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_PRODUCT_DISPLAY_CAP) return 0;
  return number;
}

export function normalizePublicCatalogPolicy(value = {}) {
  const source = isPlainObject(value) ? value : {};
  const hiddenMajorCategoryKeys = uniqueNormalizedIds(source.hiddenMajorCategoryKeys)
    .filter((key) => PUBLIC_CATALOG_MAJOR_CATEGORY_KEYS.has(key));
  const hiddenProductIds = uniqueNormalizedIds(source.hiddenProductIds);
  const hiddenSpeciesIds = uniqueNormalizedIds(source.hiddenSpeciesIds);
  const sourceCaps = isPlainObject(source.productDisplayCaps) ? source.productDisplayCaps : {};
  const productDisplayCapEntries = [];
  let capCount = 0;
  for (const [rawProductId, rawCap] of Object.entries(sourceCaps)) {
    const productId = normalizedId(rawProductId);
    const cap = normalizedPositiveInteger(rawCap);
    if (!productId || productId.length > MAX_POLICY_ENTITY_ID_LENGTH || !cap) continue;
    productDisplayCapEntries.push([productId, cap]);
    capCount += 1;
    if (capCount >= MAX_POLICY_ENTITY_IDS) break;
  }
  return {
    hiddenMajorCategoryKeys,
    hiddenProductIds,
    hiddenSpeciesIds,
    productDisplayCaps: Object.fromEntries(productDisplayCapEntries),
  };
}

function uniqueEntityIdSet(items = []) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = normalizedId(item?.id);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id));
}

function assertUniqueStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}必须是字符串数组`);
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || item.trim().length > MAX_POLICY_ENTITY_ID_LENGTH) {
      throw new Error(`${label}包含无效 ID`);
    }
    const id = item.trim();
    if (seen.has(id)) throw new Error(`${label}不能包含重复 ID`);
    seen.add(id);
  }
  if (seen.size > MAX_POLICY_ENTITY_IDS) throw new Error(`${label}数量过多`);
  return [...seen];
}

/** Validate policy writes strictly before canonicalizing and persisting them. */
export function validatePublicCatalogPolicyWrite(value, { products = [], species = [] } = {}) {
  if (!isPlainObject(value)) throw new Error("鱼单展示设置必须是普通对象");
  const allowedKeys = new Set([
    "hiddenMajorCategoryKeys",
    "hiddenProductIds",
    "hiddenSpeciesIds",
    "productDisplayCaps",
  ]);
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpectedKey) throw new Error(`鱼单展示设置包含未知字段：${unexpectedKey}`);

  const hiddenMajorCategoryKeys = assertUniqueStringArray(value.hiddenMajorCategoryKeys ?? [], "隐藏类型");
  if (hiddenMajorCategoryKeys.some((key) => !PUBLIC_CATALOG_MAJOR_CATEGORY_KEYS.has(key))) {
    throw new Error("隐藏类型包含不支持的值");
  }
  const hiddenProductIds = assertUniqueStringArray(value.hiddenProductIds ?? [], "隐藏商品");
  const hiddenSpeciesIds = assertUniqueStringArray(value.hiddenSpeciesIds ?? [], "隐藏物种");
  if (!isPlainObject(value.productDisplayCaps ?? {})) throw new Error("商品展示数量设置必须是普通对象");
  const capEntries = Object.entries(value.productDisplayCaps ?? {});
  if (capEntries.length > MAX_POLICY_ENTITY_IDS) throw new Error("商品展示数量设置过多");
  for (const [productId, cap] of capEntries) {
    if (!productId.trim() || productId.trim().length > MAX_POLICY_ENTITY_ID_LENGTH ||
        productId !== productId.trim() || typeof cap !== "number" || !normalizedPositiveInteger(cap)) {
      throw new Error("商品展示数量必须使用有效商品 ID 和正整数");
    }
  }

  const validProductIds = uniqueEntityIdSet(products);
  const validSpeciesIds = uniqueEntityIdSet(species);
  const referencedProductIds = new Set([...hiddenProductIds, ...capEntries.map(([productId]) => productId)]);
  if ([...referencedProductIds].some((id) => !validProductIds.has(id))) {
    throw new Error("鱼单展示设置引用了不存在或不唯一的商品");
  }
  if (hiddenSpeciesIds.some((id) => !validSpeciesIds.has(id))) {
    throw new Error("鱼单展示设置引用了不存在或不唯一的物种");
  }
  return normalizePublicCatalogPolicy(value);
}

export function prunePublicCatalogPolicyReferences(value, { products = [], species = [] } = {}) {
  const policy = normalizePublicCatalogPolicy(value);
  const validProductIds = uniqueEntityIdSet(products);
  const validSpeciesIds = uniqueEntityIdSet(species);
  return {
    ...policy,
    hiddenProductIds: policy.hiddenProductIds.filter((id) => validProductIds.has(id)),
    hiddenSpeciesIds: policy.hiddenSpeciesIds.filter((id) => validSpeciesIds.has(id)),
    productDisplayCaps: Object.fromEntries(
      Object.entries(policy.productDisplayCaps).filter(([id]) => validProductIds.has(id))
    ),
  };
}

function clippedAuditText(value, maxLength = MAX_POLICY_AUDIT_LABEL_LENGTH) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function uniqueEntityAuditLabels(items = []) {
  const counts = new Map();
  const entities = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = normalizedId(item?.id);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!entities.has(id)) entities.set(id, item);
  }
  return new Map([...entities].map(([id, item]) => {
    const name = String(item?.name ?? "").trim();
    const identity = name && counts.get(id) === 1 ? `${name}（${id}）` : id;
    return [id, clippedAuditText(identity)];
  }));
}

function orderedDifference(values = [], excluded = new Set()) {
  return values.filter((value) => !excluded.has(value));
}

function auditGroup(label, items = []) {
  if (items.length === 0) return "";
  const shown = items.slice(0, MAX_POLICY_AUDIT_ITEMS_PER_GROUP);
  const suffix = items.length > shown.length ? "、…" : "";
  return `${label}（${items.length}项）：${shown.join("、")}${suffix}`;
}

/** Build a bounded, human-auditable summary for the global fish-list policy log. */
export function describePublicCatalogPolicyChanges(
  previousValue,
  nextValue,
  { products = [], species = [] } = {}
) {
  const previous = normalizePublicCatalogPolicy(previousValue);
  const next = normalizePublicCatalogPolicy(nextValue);
  const previousMajor = new Set(previous.hiddenMajorCategoryKeys);
  const nextMajor = new Set(next.hiddenMajorCategoryKeys);
  const previousProducts = new Set(previous.hiddenProductIds);
  const nextProducts = new Set(next.hiddenProductIds);
  const previousSpecies = new Set(previous.hiddenSpeciesIds);
  const nextSpecies = new Set(next.hiddenSpeciesIds);
  const productLabels = uniqueEntityAuditLabels(products);
  const speciesLabels = uniqueEntityAuditLabels(species);
  const majorLabel = (key) => PUBLIC_CATALOG_MAJOR_CATEGORY_LABELS.get(key) ?? key;
  const productLabel = (id) => productLabels.get(id) ?? clippedAuditText(id);
  const speciesLabel = (id) => speciesLabels.get(id) ?? clippedAuditText(id);

  const hiddenMajor = orderedDifference(next.hiddenMajorCategoryKeys, previousMajor).map(majorLabel);
  const restoredMajor = orderedDifference(previous.hiddenMajorCategoryKeys, nextMajor).map(majorLabel);
  const hiddenProducts = orderedDifference(next.hiddenProductIds, previousProducts).map(productLabel);
  const restoredProducts = orderedDifference(previous.hiddenProductIds, nextProducts).map(productLabel);
  const hiddenSpecies = orderedDifference(next.hiddenSpeciesIds, previousSpecies).map(speciesLabel);
  const restoredSpecies = orderedDifference(previous.hiddenSpeciesIds, nextSpecies).map(speciesLabel);

  const changedCaps = [];
  const clearedCaps = [];
  const capProductIds = new Set([
    ...Object.keys(previous.productDisplayCaps),
    ...Object.keys(next.productDisplayCaps),
  ]);
  for (const productId of [...capProductIds].sort((left, right) => left.localeCompare(right))) {
    const previousCap = Object.prototype.hasOwnProperty.call(previous.productDisplayCaps, productId)
      ? previous.productDisplayCaps[productId]
      : undefined;
    const nextCap = Object.prototype.hasOwnProperty.call(next.productDisplayCaps, productId)
      ? next.productDisplayCaps[productId]
      : undefined;
    if (previousCap === nextCap) continue;
    const label = productLabel(productId);
    if (nextCap === undefined) {
      clearedCaps.push(`${label} ${previousCap}→不限`);
    } else {
      changedCaps.push(`${label} ${previousCap === undefined ? "不限" : previousCap}→${nextCap}`);
    }
  }

  const groups = [
    auditGroup("隐藏类型", hiddenMajor),
    auditGroup("恢复类型", restoredMajor),
    auditGroup("隐藏物种", hiddenSpecies),
    auditGroup("恢复物种", restoredSpecies),
    auditGroup("隐藏商品", hiddenProducts),
    auditGroup("恢复商品", restoredProducts),
    auditGroup("设置/调整商品上限", changedCaps),
    auditGroup("清除商品上限", clearedCaps),
  ].filter(Boolean);
  const totalChanges = hiddenMajor.length + restoredMajor.length +
    hiddenSpecies.length + restoredSpecies.length +
    hiddenProducts.length + restoredProducts.length +
    changedCaps.length + clearedCaps.length;
  const prefix = `鱼单规则变更（共${totalChanges}项）`;
  const detail = `${prefix}：${groups.join("；") || "无实际差异"}`;
  if (detail.length <= MAX_POLICY_AUDIT_DETAIL_LENGTH) return detail;
  const suffix = `；…（明细已截断，共${totalChanges}项）`;
  return `${detail.slice(0, Math.max(0, MAX_POLICY_AUDIT_DETAIL_LENGTH - suffix.length))}${suffix}`;
}

export function inferPublicCatalogMajorCategory(categoryName) {
  const name = String(categoryName ?? "").trim();
  if (/鱼科$|海马科$|虾虎/u.test(name)) return "marineFish";
  if (/耗材|器材|用品|药剂|海盐|饲料|滤材|测试|设备|工具|添加剂|包装/u.test(name)) return "consumable";
  if (/珊瑚|硬骨|脑珊瑚|榔头|火柴头|纽扣|菇珊瑚|飞盘|SPS|LPS/iu.test(name)) return "coral";
  if (/无脊椎|虾|蟹|螺|海星|海胆|海参|贝|管虫|海葵/u.test(name)) return "invertebrate";
  return "marineFish";
}

export function normalizePublicCatalogCategoryMajorMap(categories = [], value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries((Array.isArray(categories) ? categories : []).map((category) => [
    category,
    PUBLIC_CATALOG_MAJOR_CATEGORY_KEYS.has(source[category])
      ? source[category]
      : inferPublicCatalogMajorCategory(category),
  ]));
}

function productAllowedByNormalizedPolicy({
  product = null,
  species = null,
  speciesCategoryMajorMap = {},
  hiddenProductIds,
  hiddenSpeciesIds,
  hiddenMajorCategoryKeys,
} = {}) {
  const productId = normalizedId(product?.id);
  const speciesId = normalizedId(product?.speciesId ?? species?.id);
  if (!productId || product?.publicVisible === false || !speciesId || normalizedId(species?.id) !== speciesId) {
    return false;
  }
  if (hiddenProductIds.has(productId)) return false;
  if (hiddenSpeciesIds.has(speciesId)) return false;
  const category = String(species?.category ?? "").trim();
  const mappedMajorCategory = speciesCategoryMajorMap && typeof speciesCategoryMajorMap === "object"
    ? speciesCategoryMajorMap[category]
    : "";
  const majorCategoryKey = PUBLIC_CATALOG_MAJOR_CATEGORY_KEYS.has(mappedMajorCategory)
    ? mappedMajorCategory
    : inferPublicCatalogMajorCategory(category);
  return !hiddenMajorCategoryKeys.has(majorCategoryKey);
}

export function isPublicCatalogProductAllowed({
  product = null,
  species = null,
  speciesCategoryMajorMap = {},
  publicCatalogPolicy = {},
} = {}) {
  const policy = normalizePublicCatalogPolicy(publicCatalogPolicy);
  return productAllowedByNormalizedPolicy({
    product,
    species,
    speciesCategoryMajorMap,
    hiddenProductIds: new Set(policy.hiddenProductIds),
    hiddenSpeciesIds: new Set(policy.hiddenSpeciesIds),
    hiddenMajorCategoryKeys: new Set(policy.hiddenMajorCategoryKeys),
  });
}

function mediaSortValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const milliseconds = Date.parse(text);
  if (Number.isFinite(milliseconds)) return { milliseconds, text };
  return { milliseconds: null, text };
}

function compareMediaDatesDescending(left, right) {
  if (left.milliseconds !== null && right.milliseconds !== null) {
    return left.milliseconds === right.milliseconds ? 0 : right.milliseconds - left.milliseconds;
  }
  if (left.milliseconds !== null && right.milliseconds === null) return -1;
  if (left.milliseconds === null && right.milliseconds !== null) return 1;
  return right.text.localeCompare(left.text);
}

// FNV-1a gives a stable pseudo-random order without making the public list jump
// between refreshes. It is used only when two media records represent the same
// latest instant; original inventory order remains the final collision fallback.
function deterministicTieRank(productId, mediaDate, stockId) {
  const input = `${productId}\u0000${mediaDate}\u0000${stockId}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function latestMediaValue(latestMediaAtByStockId, stockId) {
  if (latestMediaAtByStockId instanceof Map) {
    return { present: latestMediaAtByStockId.has(stockId), value: latestMediaAtByStockId.get(stockId) };
  }
  if (latestMediaAtByStockId && typeof latestMediaAtByStockId === "object") {
    return {
      present: Object.prototype.hasOwnProperty.call(latestMediaAtByStockId, stockId),
      value: latestMediaAtByStockId[stockId],
    };
  }
  return { present: false, value: undefined };
}

/**
 * Apply only the configurable public fish-list policy. Callers remain
 * responsible for the existing sold/lost/sick/out-of-tank eligibility checks.
 *
 * Returned rows keep their inventory order. The priority ranking chooses which
 * rows fill a product cap; it intentionally does not reshuffle the customer UI.
 */
export function selectPublicCatalogStock({
  stock = [],
  products = [],
  species = [],
  speciesCategoryMajorMap = {},
  publicCatalogPolicy = {},
  latestMediaAtByStockId = new Map(),
} = {}) {
  const policy = normalizePublicCatalogPolicy(publicCatalogPolicy);
  const uniqueProductIds = uniqueEntityIdSet(products);
  const uniqueSpeciesIds = uniqueEntityIdSet(species);
  const productById = new Map((Array.isArray(products) ? products : [])
    .map((product) => [normalizedId(product?.id), product])
    .filter(([id]) => uniqueProductIds.has(id)));
  const speciesById = new Map((Array.isArray(species) ? species : [])
    .map((item) => [normalizedId(item?.id), item])
    .filter(([id]) => uniqueSpeciesIds.has(id)));
  const hiddenProductIds = new Set(policy.hiddenProductIds);
  const hiddenSpeciesIds = new Set(policy.hiddenSpeciesIds);
  const hiddenMajorCategoryKeys = new Set(policy.hiddenMajorCategoryKeys);
  const allowedProductIds = new Set(
    [...productById.entries()]
      .filter(([, product]) => productAllowedByNormalizedPolicy({
        product,
        species: speciesById.get(normalizedId(product?.speciesId)),
        speciesCategoryMajorMap,
        hiddenProductIds,
        hiddenSpeciesIds,
        hiddenMajorCategoryKeys,
      }))
      .map(([productId]) => productId)
  );
  const uniqueStockIds = uniqueEntityIdSet(stock);
  const indexedCandidates = (Array.isArray(stock) ? stock : [])
    .map((item, inventoryIndex) => ({ item, inventoryIndex }))
    .filter(({ item }) =>
      uniqueStockIds.has(normalizedId(item?.id)) &&
      allowedProductIds.has(normalizedId(item?.productId))
    );
  const candidatesByProductId = new Map();
  for (const candidate of indexedCandidates) {
    const productId = normalizedId(candidate.item?.productId);
    const group = candidatesByProductId.get(productId) ?? [];
    group.push(candidate);
    candidatesByProductId.set(productId, group);
  }

  const selectedStockIds = new Set();
  for (const [productId, candidates] of candidatesByProductId) {
    const cap = Object.prototype.hasOwnProperty.call(policy.productDisplayCaps, productId)
      ? policy.productDisplayCaps[productId]
      : undefined;
    if (!cap || candidates.length <= cap) {
      candidates.forEach(({ item }) => selectedStockIds.add(normalizedId(item?.id)));
      continue;
    }
    const ranked = candidates.map((candidate) => {
      const stockId = normalizedId(candidate.item?.id);
      const latestMedia = latestMediaValue(latestMediaAtByStockId, stockId);
      const mediaDate = latestMedia.present
        ? (mediaSortValue(latestMedia.value) ?? { milliseconds: null, text: "" })
        : null;
      return {
        ...candidate,
        stockId,
        mediaDate,
        tieRank: mediaDate
          ? deterministicTieRank(
            productId,
            mediaDate.milliseconds === null ? mediaDate.text : String(mediaDate.milliseconds),
            stockId
          )
          : 0,
      };
    }).sort((left, right) => {
      if (Boolean(left.mediaDate) !== Boolean(right.mediaDate)) return left.mediaDate ? -1 : 1;
      if (left.mediaDate && right.mediaDate) {
        const dateOrder = compareMediaDatesDescending(left.mediaDate, right.mediaDate);
        if (dateOrder) return dateOrder;
        if (left.tieRank !== right.tieRank) return left.tieRank - right.tieRank;
      }
      return left.inventoryIndex - right.inventoryIndex || left.stockId.localeCompare(right.stockId);
    });
    ranked.slice(0, cap).forEach(({ stockId }) => selectedStockIds.add(stockId));
  }

  return indexedCandidates
    .filter(({ item }) => selectedStockIds.has(normalizedId(item?.id)))
    .map(({ item }) => item);
}
