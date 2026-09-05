import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const catalogManagementSource = await readFile(
  new URL("../src/app/components/CatalogManagementView.tsx", import.meta.url),
  "utf8",
);
const productsSource = await readFile(
  new URL("../src/app/components/ProductsView.tsx", import.meta.url),
  "utf8",
);
const appSource = await readFile(
  new URL("../src/app/App.tsx", import.meta.url),
  "utf8",
);
const storeSource = await readFile(
  new URL("../src/app/store.ts", import.meta.url),
  "utf8",
);

test("fish-list rule tabs have an unmistakable selected state", () => {
  assert.match(catalogManagementSource, /value=\{activeRuleTab\}/);
  assert.match(catalogManagementSource, /aria-label="鱼单规则设置方式"/);
  assert.match(catalogManagementSource, /bg-muted\/50/);
  assert.match(catalogManagementSource, /data-\[state=active\]:bg-primary/);
  assert.match(catalogManagementSource, /data-\[state=active\]:text-primary-foreground/);
  assert.match(catalogManagementSource, /data-\[state=active\]:font-semibold/);
  assert.match(catalogManagementSource, /按类型/);
});

test("fish-list management is the only visibility control for active products", () => {
  assert.doesNotMatch(catalogManagementSource, /商品档案未公开/);
  assert.doesNotMatch(catalogManagementSource, /publicVisible|productVisibility|对外展示总开关|先开启对外展示/);
  assert.match(catalogManagementSource, /activeProductSummaries = productSummaries\.filter\(\(summary\) => !summary\.product\.archivedAt\)/);
  assert.match(catalogManagementSource, /onCheckedChange=\{\(visible\) => updateHidden\("hiddenProductIds", summary\.product\.id, !visible\)\}/);
  assert.match(catalogManagementSource, />鱼单展示<\/th>/);
  assert.match(catalogManagementSource, /不在鱼单/);
  assert.match(catalogManagementSource, /在鱼单/);
  assert.match(catalogManagementSource, /disabled=\{!canEdit \|\| saving \|\| productHidden \|\| inheritedHidden\}/);
  assert.match(catalogManagementSource, /xl:grid-cols-4/);
});

test("product management no longer exposes a competing public-visibility control", () => {
  assert.doesNotMatch(productsSource, /key:\s*["']publicVisible["']/);
  assert.doesNotMatch(productsSource, /product-public-visible/);
  assert.doesNotMatch(productsSource, /对外展示（网站和小程序）/);
  assert.doesNotMatch(productsSource, /商品已恢复使用；对外展示仍关闭/);
  assert.doesNotMatch(productsSource, /publicVisible:\s*editing\.publicVisible/);
  assert.match(productsSource, /function withoutLegacyPublicVisible[\s\S]*?publicVisible:\s*legacyPublicVisible[\s\S]*?return currentProduct/);
  assert.match(productsSource, /\.\.\.withoutLegacyPublicVisible\(editing\)/);
  assert.match(productsSource, /nextProducts = draftProducts\.map[\s\S]*?withoutLegacyPublicVisible\(product\)/);
  assert.match(productsSource, /toast\.success\(["']商品已恢复使用["']\)/);
});

test("frontend compatibility strips the legacy field without re-hiding a product after migration", () => {
  assert.doesNotMatch(storeSource, /publicVisible\?:\s*boolean/);
  assert.match(appSource, /const PUBLIC_CATALOG_POLICY_SCHEMA_VERSION = 1/);
  assert.match(appSource, /publicVisible:\s*legacyPublicVisible/);
  assert.match(appSource, /!legacyCatalogMigrationCompleted && legacyPublicVisible === false/);
  assert.match(appSource, /hiddenProductIds:\s*Array\.from\(new Set/);
});
