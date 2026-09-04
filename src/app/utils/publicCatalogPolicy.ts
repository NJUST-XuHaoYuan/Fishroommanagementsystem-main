export const PUBLIC_CATALOG_MAJOR_CATEGORY_KEYS = [
  "marineFish",
  "coral",
  "invertebrate",
  "consumable",
] as const;

export const MAX_PUBLIC_CATALOG_DISPLAY_CAP = 1_000_000;
const MAX_PUBLIC_CATALOG_ENTITY_IDS = 50_000;
const MAX_PUBLIC_CATALOG_ENTITY_ID_LENGTH = 240;

export type PublicCatalogMajorCategoryKey = typeof PUBLIC_CATALOG_MAJOR_CATEGORY_KEYS[number];

export type PublicCatalogPolicy = {
  hiddenMajorCategoryKeys: PublicCatalogMajorCategoryKey[];
  hiddenProductIds: string[];
  hiddenSpeciesIds: string[];
  productDisplayCaps: Record<string, number>;
};

export const DEFAULT_PUBLIC_CATALOG_POLICY: PublicCatalogPolicy = {
  hiddenMajorCategoryKeys: [],
  hiddenProductIds: [],
  hiddenSpeciesIds: [],
  productDisplayCaps: {},
};

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    const id = String(item ?? "").trim();
    if (!id || id.length > MAX_PUBLIC_CATALOG_ENTITY_ID_LENGTH || result.includes(id)) continue;
    result.push(id);
    if (result.length >= MAX_PUBLIC_CATALOG_ENTITY_IDS) break;
  }
  return result;
}

function positiveDisplayCap(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return null;
  const cap = Number(value);
  return Number.isSafeInteger(cap) && cap > 0 && cap <= MAX_PUBLIC_CATALOG_DISPLAY_CAP
    ? cap
    : null;
}

export function isPublicCatalogMediaUrl(value: unknown): boolean {
  const src = String(value ?? "").trim();
  if (!src) return false;
  if (src.startsWith("/uploads/")) return true;
  try {
    const url = new URL(src);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizePublicCatalogPolicy(value: unknown): PublicCatalogPolicy {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const majorKeys = new Set<PublicCatalogMajorCategoryKey>(PUBLIC_CATALOG_MAJOR_CATEGORY_KEYS);
  const hiddenMajorCategoryKeys = uniqueStrings(source.hiddenMajorCategoryKeys)
    .filter((key): key is PublicCatalogMajorCategoryKey => majorKeys.has(key as PublicCatalogMajorCategoryKey));
  const rawCaps = source.productDisplayCaps && typeof source.productDisplayCaps === "object" && !Array.isArray(source.productDisplayCaps)
    ? source.productDisplayCaps as Record<string, unknown>
    : {};
  const productDisplayCaps = Object.fromEntries(
    Object.entries(rawCaps).slice(0, MAX_PUBLIC_CATALOG_ENTITY_IDS).flatMap(([rawProductId, rawCap]) => {
      const productId = String(rawProductId ?? "").trim();
      const cap = positiveDisplayCap(rawCap);
      return productId && productId.length <= MAX_PUBLIC_CATALOG_ENTITY_ID_LENGTH && cap !== null
        ? [[productId, cap]]
        : [];
    })
  );

  return {
    hiddenMajorCategoryKeys,
    hiddenProductIds: uniqueStrings(source.hiddenProductIds),
    hiddenSpeciesIds: uniqueStrings(source.hiddenSpeciesIds),
    productDisplayCaps,
  };
}

export function copyPublicCatalogPolicy(value: unknown): PublicCatalogPolicy {
  const normalized = normalizePublicCatalogPolicy(value);
  return {
    hiddenMajorCategoryKeys: [...normalized.hiddenMajorCategoryKeys],
    hiddenProductIds: [...normalized.hiddenProductIds],
    hiddenSpeciesIds: [...normalized.hiddenSpeciesIds],
    productDisplayCaps: { ...normalized.productDisplayCaps },
  };
}

/** Stable, order-insensitive identity for a policy whose ID arrays are sets. */
export function publicCatalogPolicyFingerprint(value: unknown): string {
  const normalized = normalizePublicCatalogPolicy(value);
  return JSON.stringify({
    hiddenMajorCategoryKeys: [...normalized.hiddenMajorCategoryKeys].sort(),
    hiddenProductIds: [...normalized.hiddenProductIds].sort(),
    hiddenSpeciesIds: [...normalized.hiddenSpeciesIds].sort(),
    productDisplayCaps: Object.fromEntries(
      Object.entries(normalized.productDisplayCaps).sort(([left], [right]) => left.localeCompare(right))
    ),
  });
}

export function getPublicCatalogProductDisplayCap(
  policy: PublicCatalogPolicy,
  productId: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(policy.productDisplayCaps, productId)) return undefined;
  return positiveDisplayCap(policy.productDisplayCaps[productId]) ?? undefined;
}
