import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildStockPriceDetailsPatch } from "./stockPricing.ts";

const [app, products, daily] = await Promise.all([
  readFile(new URL("../App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../components/ProductsView.tsx", import.meta.url), "utf8"),
  readFile(new URL("../components/DailyView.tsx", import.meta.url), "utf8"),
]);
const saveProduct = app.slice(app.indexOf("const saveProduct ="), app.indexOf("const deleteProduct ="));
const saveBio = daily.slice(daily.indexOf("// Save bio status/notes"), daily.indexOf("// Add bio record"));

test("product edit explains that the default price is shared across all sites in both field and confirmation copy", () => {
  assert.equal(products.match(/商品默认价所有场地共用/g)?.length, 2);
  assert.match(products, /confirmWrite\([\s\S]*?商品默认价所有场地共用/);
  assert.match(products, /商品默认价所有场地共用[\s\S]*?订单成交价不变/);
});

test("product edit sends the opening default-price snapshot through App to the dedicated API", () => {
  assert.match(products, /saveProduct\(finalEditing, editing\.id \? editing\.defaultPrice : undefined\)/);
  assert.match(saveProduct, /expectedDefaultPrice\?: number/);
  assert.match(saveProduct, /fetch\(`\$\{API\}\/products\/upsert`/);
  assert.match(saveProduct, /previousProduct \? \{ expectedDefaultPrice: expectedDefaultPrice \?\? previousProduct\.defaultPrice \} : \{\}/);
});

test("product-save response updates only price fields on matching existing stock and preserves unrelated inventory state", () => {
  const projection = saveProduct.match(/\[item\.id,\s*\{([^}]+)\}\]/);
  assert.ok(projection, "the stock-pricing update must use an explicit per-row allowlist");
  assert.deepEqual(projection[1].split(",").map(field => field.trim().split(":")[0]), ["basePrice", "priceMode", "priceOverridden"]);
  assert.match(saveProduct, /stock: current\.stock\.map\(\(item\) => priceUpdates\.has\(item\.id\) \? \{ \.\.\.item, \.\.\.priceUpdates\.get\(item\.id\) \} : item\)/);
  assert.doesNotMatch(saveProduct, /stock:\s*(?:result\.stock|result\.stockPricingUpdates)/);
  assert.match(saveProduct, /setStateForMutation\(mutationSession/);
});

test("Daily maintenance delegates price fields only to the dirty-aware patch builder", () => {
  assert.match(daily, /setBioPriceChanged\(false\)/);
  assert.match(saveBio, /buildStockPriceDetailsPatch\(bioPricingOriginalRef\.current \?\? currentItem/);
  assert.match(saveBio, /changed: bioPriceChanged/);
  assert.match(saveBio, /details:\s*\{\s*status: bioStatus,\s*\.\.\.pricingPatch\.details/);
  assert.match(saveBio, /expectedDetails:\s*\{\s*status: currentItem\.status,\s*\.\.\.pricingPatch\.expectedDetails/);
  assert.doesNotMatch(saveBio, /basePrice:\s*(?:normalizedPrice|currentItem\.basePrice)/);
  const untouched = buildStockPriceDetailsPatch({ basePrice: 100, priceMode: "product" }, { changed: false, mode: "product", price: 80 });
  const request = JSON.parse(JSON.stringify({ details: { status: "healthy", ...untouched.details }, expectedDetails: { status: "sick", ...untouched.expectedDetails } }));
  assert.deepEqual(request, { details: { status: "healthy" }, expectedDetails: { status: "sick" } });
});
