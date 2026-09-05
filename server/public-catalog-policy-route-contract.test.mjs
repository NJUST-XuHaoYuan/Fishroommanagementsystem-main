import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
const policySource = await readFile(new URL("./public-catalog-policy.mjs", import.meta.url), "utf8");

function routeBlock(path, method = "GET") {
  const marker = `if (url.pathname === "${path}" && req.method === "${method}") {`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing route ${path}`);
  const remaining = source.slice(start + marker.length);
  const nextMatch = /\n  if \(url\.pathname === /.exec(remaining);
  const end = nextMatch ? start + marker.length + nextMatch.index : source.length;
  return source.slice(start, end);
}

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `missing function ${nextName}`);
  return source.slice(start, end);
}

const catalogRoute = routeBlock("/api/public/catalog");
const bioRecordsRoute = routeBlock("/api/public/bio-records");
const statePatchRoute = routeBlock("/api/state/patch", "POST");
const productDeleteRoute = routeBlock("/api/products/delete", "POST");
const productUpsertRoute = routeBlock("/api/products/upsert", "POST");
const globalSelectionBuilder = functionBlock("buildGlobalPublicCatalogSelection", "buildPublicCatalog");
const catalogBuilder = functionBlock("buildPublicCatalog", "buildPublicBioRecordsForStock");
const bioRecordsBuilder = functionBlock("buildPublicBioRecordsForStock", "normalizePickupShipmentRecord");
const legacyVisibilityMigration = functionBlock(
  "migrateLegacyPublicCatalogVisibility",
  "backfillDefaultSites",
);
const productAllowedStart = policySource.indexOf("function productAllowedByNormalizedPolicy(");
const productAllowedEnd = policySource.indexOf("export function isPublicCatalogProductAllowed(", productAllowedStart);
assert.notEqual(productAllowedStart, -1);
assert.notEqual(productAllowedEnd, -1);
const productAllowedBuilder = policySource.slice(productAllowedStart, productAllowedEnd);

test("the public catalog route projects the persisted policy and applies it server-side", () => {
  assert.match(catalogRoute, /res\.setHeader\("Cache-Control",\s*"no-store"\)/);
  assert.match(catalogRoute, /data\s*->\s*'publicCatalogPolicy'\s+AS\s+public_catalog_policy/);
  assert.match(catalogRoute, /buildPublicCatalog\(\s*publicCatalogProjectionFromRow\(row\)/);
  assert.match(globalSelectionBuilder, /selectPublicCatalogStock\(\{/);
  assert.match(globalSelectionBuilder, /publicCatalogPolicy:\s*globalState\.publicCatalogPolicy/);
  assert.match(globalSelectionBuilder, /latestMediaAtByStockId/);
  assert.match(globalSelectionBuilder, /!item\?\.sold/);
  assert.match(globalSelectionBuilder, /item\?\.status\s*!==\s*"sick"/);
  assert.match(globalSelectionBuilder, /orderActiveStockIds\(globalState\)/);
  assert.match(globalSelectionBuilder, /!activeOrderStockIds\.has\(String\(item\?\.id/);
  assert.match(globalSelectionBuilder, /isPhysicallyInTank\(item, shippedIds\)/);
  assert.match(catalogBuilder, /const selection = buildGlobalPublicCatalogSelection\(state\)/);
  assert.match(catalogBuilder, /stock:\s*selection\.selectedStock[\s\S]*?\},\s*siteId\)/);
  assert.doesNotMatch(globalSelectionBuilder, /publicVisible/);
  assert.doesNotMatch(catalogBuilder, /publicVisible/);
  assert.doesNotMatch(productAllowedBuilder, /publicVisible/);
  assert.match(productAllowedBuilder, /product\?\.archivedAt/);
});

test("legacy product visibility migrates once under a row lock and future writes strip the old field", () => {
  assert.match(legacyVisibilityMigration, /SELECT data FROM app_state WHERE id = \$1 FOR UPDATE/);
  assert.match(legacyVisibilityMigration, /migrateLegacyPublicCatalogVisibilityState\(currentState\)/);
  assert.match(legacyVisibilityMigration, /UPDATE app_state SET data = \$2::jsonb/);
  assert.match(legacyVisibilityMigration, /await client\.query\("COMMIT"\)/);
  assert.match(source, /await importLegacyStateIfPresent\(\);\s*await migrateLegacyPublicCatalogVisibility\(\);/);
  assert.match(statePatchRoute, /rawPatch\.products = rawPatch\.products\.map\(withoutLegacyProductVisibility\)/);
  assert.match(statePatchRoute, /basePatch\.products = basePatch\.products\.map\(withoutLegacyProductVisibility\)/);
  assert.match(statePatchRoute, /current\.products = current\.products\.map\(withoutLegacyProductVisibility\)/);
  assert.match(statePatchRoute, /stateWithoutLogs\.products = stateWithoutLogs\.products\.map\(withoutLegacyProductVisibility\)/);
  assert.match(productDeleteRoute, /\.\.\.withoutLegacyProductVisibility\(item\), archivedAt/);
  assert.match(productUpsertRoute, /\.\.\.withoutLegacyProductVisibility\(product\)/);
  assert.doesNotMatch(productUpsertRoute, /publicVisible:\s*product\.publicVisible/);
});

test("the public detail route ranks every same-product sibling so capped-out IDs cannot bypass the catalog", () => {
  assert.match(bioRecordsRoute, /res\.setHeader\("Cache-Control",\s*"no-store"\)/);
  assert.match(bioRecordsRoute, /candidate_stock\s+AS\s+MATERIALIZED/i);
  assert.match(bioRecordsRoute, /candidate_item\s*->>\s*'productId'\s*=\s*\(/);
  assert.match(bioRecordsRoute, /candidate_stock_ids\s+AS\s+MATERIALIZED/i);
  assert.match(bioRecordsRoute, /data\s*->\s*'publicCatalogPolicy'\s+AS\s+public_catalog_policy/);
  assert.match(bioRecordsRoute, /AS\s+species_category_major_map/i);
  assert.match(bioRecordsRoute, /AS\s+species/i);
  assert.match(bioRecordsRoute, /WITH\s+ORDINALITY\s+AS\s+stock_rows\(candidate_item,\s*candidate_ordinality\)/i);
  assert.match(bioRecordsRoute, /jsonb_agg\(stock_item\s+ORDER\s+BY\s+inventory_ordinality\)[\s\S]*?FROM\s+candidate_stock/i);
  assert.match(bioRecordsRoute, /SELECT\s+stock_item_id\s+FROM\s+candidate_stock_ids/i);
  assert.match(bioRecordsRoute, /buildPublicBioRecordsForStock\(projectedState, requestedSiteId, stockItemId\)/);
  assert.match(bioRecordsBuilder, /const selection = buildGlobalPublicCatalogSelection\(state\)/);
  assert.match(bioRecordsBuilder, /stock:\s*selection\.selectedStock[\s\S]*?\},\s*siteId\)/);
  assert.match(bioRecordsBuilder, /if\s*\(!selectedStockIds\.has\(targetId\)\)\s*return null/);
});

test("public routes remain read-only and unauthenticated while policy writes remain authenticated", () => {
  const publicRouteGuard = functionBlock("isPublicApiRoute", "aiReady");
  assert.match(publicRouteGuard, /"\/api\/public\/catalog"\s*&&\s*req\.method\s*===\s*"GET"/);
  assert.match(publicRouteGuard, /"\/api\/public\/bio-records"\s*&&\s*req\.method\s*===\s*"GET"/);
  assert.doesNotMatch(publicRouteGuard, /publicCatalogPolicy/);
  assert.match(source, /const ADMIN_ONLY_STATE_PATCH_KEYS = new Set\(\[[\s\S]*?"publicCatalogPolicy"/);
});

test("policy writes are strict, conflict-safe, and deletion cannot leave stale references", () => {
  assert.match(statePatchRoute, /validatePublicCatalogPolicyWrite\(rawPatch\.publicCatalogPolicy/);
  assert.match(statePatchRoute, /basePatch\.publicCatalogPolicy/);
  assert.match(statePatchRoute, /PUBLIC_CATALOG_POLICY_CONFLICT/);
  assert.match(
    statePatchRoute,
    /key === "products" \|\| key === "species"[\s\S]*?prunePublicCatalogPolicyReferences\(/,
  );
  assert.match(
    productDeleteRoute,
    /disposition\.mode === "hard"[\s\S]*?prunePublicCatalogPolicyReferences\(/,
  );
  assert.match(productDeleteRoute, /publicCatalogPolicy:\s*nextPublicCatalogPolicy/);
  assert.match(source, /key === "publicCatalogPolicy"[\s\S]*?describePublicCatalogPolicyChanges\(current\[key\], next\[key\]/);
});

test("public responses do not expose the policy rule lists", () => {
  const returnStart = catalogBuilder.indexOf("return {");
  assert.notEqual(returnStart, -1);
  const payload = catalogBuilder.slice(returnStart);
  assert.doesNotMatch(payload, /hiddenMajorCategoryKeys|hiddenProductIds|hiddenSpeciesIds|productDisplayCaps/);
  assert.doesNotMatch(bioRecordsBuilder, /hiddenMajorCategoryKeys|hiddenProductIds|hiddenSpeciesIds|productDisplayCaps/);
});
