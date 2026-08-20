export const STATE_SLICE_KEYS = Object.freeze([
  "systemSettings",
  "sites",
  "personnel",
  "operationLogs",
  "species",
  "speciesCategories",
  "speciesCategoryMajorMap",
  "products",
  "productOrigins",
  "tankGroups",
  "batches",
  "stock",
  "lossRecords",
  "logs",
  "waterQualityRecords",
  "checks",
  "bioRecords",
  "orders",
  "shipments",
  "customers",
  "customerSources",
]);

const STATE_SLICE_KEY_SET = new Set(STATE_SLICE_KEYS);

// Generic patches must only lock/read the collections needed to validate the
// requested fields. Keeping one global support list made an unrelated customer
// or settings edit deserialize stock, orders, shipments and the entire audit
// history. The audit history is appended in SQL by the route and is therefore
// intentionally absent from every dependency set below.
const GENERIC_STATE_PATCH_DEPENDENCIES = Object.freeze({
  systemSettings: ["systemSettings"],
  sites: ["sites"],
  species: ["species", "products"],
  speciesCategories: ["speciesCategories"],
  speciesCategoryMajorMap: ["speciesCategoryMajorMap"],
  products: ["species", "products", "stock", "orders"],
  productOrigins: ["productOrigins"],
  tankGroups: ["sites", "tankGroups"],
  batches: ["sites", "batches", "stock"],
  lossRecords: ["sites", "tankGroups", "stock", "lossRecords"],
  logs: ["sites", "tankGroups", "logs"],
  waterQualityRecords: ["sites", "tankGroups", "waterQualityRecords"],
  checks: ["sites", "tankGroups", "checks"],
  orders: [
    "systemSettings",
    "sites",
    "personnel",
    "products",
    "tankGroups",
    "stock",
    "orders",
    "shipments",
    "customers",
  ],
  shipments: ["systemSettings", "sites", "stock", "orders", "shipments"],
  customers: ["customers", "orders"],
  customerSources: ["customerSources"],
});

// These collections are filtered by the authenticated account's visible sites.
// `sites` is deliberately kept as a query-only dependency when the caller did
// not request it, so custom/retired site definitions are still interpreted
// consistently without exposing the site list in the response.
const SITE_SCOPED_KEYS = new Set([
  "tankGroups",
  "batches",
  "stock",
  "lossRecords",
  "logs",
  "waterQualityRecords",
  "checks",
  "bioRecords",
  "orders",
  "shipments",
]);

// These records can inherit their site through a tank/sub-tank relationship.
const TANK_LINKED_KEYS = new Set([
  "stock",
  "lossRecords",
  "logs",
  "waterQualityRecords",
  "checks",
  "bioRecords",
]);

// Loss and biological records can inherit their site through stockItemId.
const STOCK_LINKED_KEYS = new Set(["lossRecords", "bioRecords"]);

function normalizedRequestedKeys(requestedKeys) {
  if (!Array.isArray(requestedKeys)) {
    throw new TypeError("State slice requested keys must be an array");
  }
  const normalized = requestedKeys.map((value) => String(value ?? "").trim());
  const invalid = normalized.filter((key) => !key || !STATE_SLICE_KEY_SET.has(key));
  if (invalid.length > 0) {
    throw new Error(`Invalid state slice key(s): ${[...new Set(invalid)].join(", ")}`);
  }
  return [...new Set(normalized)];
}

/**
 * Plan the smallest safe JSONB-key projection for `/api/state/slice`.
 *
 * `requestedKeys` are the only keys that may be returned to the client.
 * `queryKeys` additionally contains server-only relationship data needed for
 * site filtering and inventory projection. In particular, requesting `stock`
 * always reads global orders and shipments before site filtering, so a fish
 * fulfilled by a shipment created at another site is still marked out without
 * leaking that order or shipment to the caller.
 */
export function planStateSliceDependencies(requestedKeys) {
  const requested = normalizedRequestedKeys(requestedKeys);
  const requestedSet = new Set(requested);
  const querySet = new Set(requested);

  if (requested.some((key) => SITE_SCOPED_KEYS.has(key))) querySet.add("sites");
  if (requested.some((key) => TANK_LINKED_KEYS.has(key))) querySet.add("tankGroups");
  if (requested.some((key) => STOCK_LINKED_KEYS.has(key))) querySet.add("stock");

  // Shipment visibility can be inherited from its order.
  if (requestedSet.has("shipments")) querySet.add("orders");

  const needsInventoryProjection = requestedSet.has("stock");
  if (needsInventoryProjection) {
    // These must be queried globally. They are support data only unless the
    // caller explicitly requested them, and must never be pre-filtered by site.
    querySet.add("orders");
    querySet.add("shipments");
  }

  const queryKeys = STATE_SLICE_KEYS.filter((key) => querySet.has(key));
  return {
    requestedKeys: requested,
    queryKeys,
    supportKeys: queryKeys.filter((key) => !requestedSet.has(key)),
    needsInventoryProjection,
    inventoryProjectionSourceKeys: needsInventoryProjection ? ["orders", "shipments"] : [],
  };
}

/**
 * Plan the JSONB top-level fields needed to validate and persist a generic
 * state patch without reading the complete app_state document.
 */
export function planGenericStatePatchReadKeys(patchKeys) {
  const requested = normalizedRequestedKeys(patchKeys);
  const querySet = new Set();
  for (const key of requested) {
    for (const dependency of GENERIC_STATE_PATCH_DEPENDENCIES[key] ?? [key]) {
      querySet.add(dependency);
    }
  }
  return STATE_SLICE_KEYS.filter((key) => querySet.has(key));
}
