import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PUBLIC_CATALOG_POLICY,
  copyPublicCatalogPolicy,
  getPublicCatalogProductDisplayCap,
  isPublicCatalogMediaUrl,
  normalizePublicCatalogPolicy,
  publicCatalogPolicyFingerprint,
} from "./publicCatalogPolicy.ts";

test("normalizes catalog policy and discards unsafe cap values", () => {
  assert.deepEqual(normalizePublicCatalogPolicy({
    hiddenMajorCategoryKeys: ["marineFish", "unknown", "marineFish"],
    hiddenProductIds: [" product-1 ", "", "product-1", 22],
    hiddenSpeciesIds: ["species-1", null],
    productDisplayCaps: {
      " product-1 ": 100,
      "product-2": 0,
      "product-3": -2,
      "product-4": "12",
      "product-5": "not-a-number",
      "product-6": 1.5,
      "product-7": 1_000_001,
    },
  }), {
    hiddenMajorCategoryKeys: ["marineFish"],
    hiddenProductIds: ["product-1", "22"],
    hiddenSpeciesIds: ["species-1"],
    productDisplayCaps: { "product-1": 100, "product-4": 12 },
  });
});

test("missing policy starts with independent empty collections", () => {
  const first = copyPublicCatalogPolicy(undefined);
  first.hiddenProductIds.push("product-1");
  first.productDisplayCaps["product-1"] = 10;

  const second = copyPublicCatalogPolicy(undefined);
  assert.deepEqual(second, DEFAULT_PUBLIC_CATALOG_POLICY);
});

test("prototype-like product ids do not appear capped unless explicitly configured", () => {
  const policy = normalizePublicCatalogPolicy({
    productDisplayCaps: JSON.parse('{"constructor":7,"__proto__":5}'),
  });
  assert.equal(getPublicCatalogProductDisplayCap(policy, "toString"), undefined);
  assert.equal(getPublicCatalogProductDisplayCap(policy, "constructor"), 7);
  assert.equal(getPublicCatalogProductDisplayCap(policy, "__proto__"), 5);
});

test("policy fingerprints treat set and cap insertion order as equivalent", () => {
  const left = {
    hiddenMajorCategoryKeys: ["marineFish", "coral"],
    hiddenProductIds: ["product-2", "product-1"],
    hiddenSpeciesIds: ["species-2", "species-1"],
    productDisplayCaps: { "product-2": 20, "product-1": 10 },
  };
  const right = {
    hiddenMajorCategoryKeys: ["coral", "marineFish"],
    hiddenProductIds: ["product-1", "product-2"],
    hiddenSpeciesIds: ["species-1", "species-2"],
    productDisplayCaps: { "product-1": 10, "product-2": 20 },
  };

  assert.equal(publicCatalogPolicyFingerprint(left), publicCatalogPolicyFingerprint(right));
});

test("media preview accepts only the URL formats published by the server", () => {
  assert.equal(isPublicCatalogMediaUrl(" /uploads/fish/photo.jpg "), true);
  assert.equal(isPublicCatalogMediaUrl("https://cdn.example.com/fish.mp4"), true);
  assert.equal(isPublicCatalogMediaUrl("http://cdn.example.com/fish.jpg"), true);
  assert.equal(isPublicCatalogMediaUrl("   "), false);
  assert.equal(isPublicCatalogMediaUrl("not-a-url"), false);
  assert.equal(isPublicCatalogMediaUrl("javascript:alert(1)"), false);
  assert.equal(isPublicCatalogMediaUrl("data:image/png;base64,abc"), false);
});
