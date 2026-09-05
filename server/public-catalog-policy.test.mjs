import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_CATALOG_POLICY_SCHEMA_VERSION,
  describePublicCatalogPolicyChanges,
  inferPublicCatalogMajorCategory,
  isPublicCatalogProductAllowed,
  migrateLegacyPublicCatalogVisibilityState,
  normalizePublicCatalogPolicy,
  prunePublicCatalogPolicyReferences,
  selectPublicCatalogStock,
  validatePublicCatalogPolicyWrite,
} from "./public-catalog-policy.mjs";

const species = [
  { id: "species-fish", category: "刺尾鱼科" },
  { id: "species-coral", category: "LPS 珊瑚" },
];
const products = [
  { id: "gold-tang", speciesId: "species-fish" },
  { id: "purple-tang", speciesId: "species-fish" },
  { id: "torch", speciesId: "species-coral" },
];
const categoryMap = { 刺尾鱼科: "marineFish", "LPS 珊瑚": "coral" };

function select(stock, policy = {}, latestMediaAtByStockId = {}) {
  return selectPublicCatalogStock({
    stock,
    products,
    species,
    speciesCategoryMajorMap: categoryMap,
    publicCatalogPolicy: policy,
    latestMediaAtByStockId,
  }).map((item) => item.id);
}

test("migrates active legacy-hidden products into the policy and removes the legacy field", () => {
  const currentState = {
    products: [
      { id: "legacy-hidden", name: "旧隐藏商品", publicVisible: false },
      { id: "already-public", publicVisible: true },
      { id: "archived-hidden", publicVisible: false, archivedAt: "2026-09-05T12:00:00+08:00" },
      { id: "legacy-hidden", publicVisible: false },
      { id: "missing-flag" },
    ],
    publicCatalogPolicy: {
      hiddenMajorCategoryKeys: ["coral"],
      hiddenProductIds: ["already-hidden"],
      hiddenSpeciesIds: ["species-coral"],
      productDisplayCaps: { "already-public": 8 },
    },
  };

  const migration = migrateLegacyPublicCatalogVisibilityState(currentState);
  assert.equal(migration.changed, true);
  assert.deepEqual(migration.migratedProductIds, ["legacy-hidden"]);
  assert.equal(
    migration.state._publicCatalogPolicySchemaVersion,
    PUBLIC_CATALOG_POLICY_SCHEMA_VERSION,
  );
  assert.deepEqual(migration.state.publicCatalogPolicy, {
    hiddenMajorCategoryKeys: ["coral"],
    hiddenProductIds: ["already-hidden", "legacy-hidden"],
    hiddenSpeciesIds: ["species-coral"],
    productDisplayCaps: { "already-public": 8 },
  });
  assert.equal(
    migration.state.products.some((product) =>
      product && Object.prototype.hasOwnProperty.call(product, "publicVisible")
    ),
    false,
  );
  assert.equal(migration.state.publicCatalogPolicy.hiddenProductIds.includes("archived-hidden"), false);
  assert.equal(currentState.products[0].publicVisible, false, "migration must not mutate its input");
});

test("legacy visibility migration is idempotent and never re-hides an administrator-unhidden product", () => {
  const first = migrateLegacyPublicCatalogVisibilityState({
    products: [{ id: "legacy-hidden", publicVisible: false }],
    publicCatalogPolicy: {},
  });
  const administratorUnhiddenState = {
    ...first.state,
    publicCatalogPolicy: {
      ...first.state.publicCatalogPolicy,
      hiddenProductIds: [],
    },
  };

  const second = migrateLegacyPublicCatalogVisibilityState(administratorUnhiddenState);
  assert.equal(second.changed, false);
  assert.strictEqual(second.state, administratorUnhiddenState);
  assert.deepEqual(second.migratedProductIds, []);
  assert.deepEqual(second.state.publicCatalogPolicy.hiddenProductIds, []);
});

test("a stale legacy field written after migration is removed without changing the administrator policy", () => {
  const state = {
    _publicCatalogPolicySchemaVersion: PUBLIC_CATALOG_POLICY_SCHEMA_VERSION,
    products: [{ id: "administrator-unhidden", publicVisible: false }],
    publicCatalogPolicy: { hiddenProductIds: [] },
  };
  const cleanup = migrateLegacyPublicCatalogVisibilityState(state);
  assert.equal(cleanup.changed, true);
  assert.deepEqual(cleanup.migratedProductIds, []);
  assert.deepEqual(cleanup.state.publicCatalogPolicy, { hiddenProductIds: [] });
  assert.deepEqual(cleanup.state.products, [{ id: "administrator-unhidden" }]);
});

test("migration preserves malformed product state and fails closed when a legacy hidden ID cannot fit policy limits", () => {
  const malformedProducts = { preserve: "do-not-overwrite" };
  const malformed = migrateLegacyPublicCatalogVisibilityState({
    products: malformedProducts,
    publicCatalogPolicy: null,
  });
  assert.strictEqual(malformed.state.products, malformedProducts);
  assert.equal(malformed.state._publicCatalogPolicySchemaVersion, PUBLIC_CATALOG_POLICY_SCHEMA_VERSION);

  assert.throws(() => migrateLegacyPublicCatalogVisibilityState({
    products: [{ id: "x".repeat(241), publicVisible: false }],
    publicCatalogPolicy: {},
  }), /过长商品 ID.*无法安全迁移/);

  const fullHiddenProductIds = Array.from(
    { length: 50_000 },
    (_, index) => `hidden-${String(index).padStart(5, "0")}`,
  );
  assert.throws(() => migrateLegacyPublicCatalogVisibilityState({
    products: [{ id: "one-more-hidden-product", publicVisible: false }],
    publicCatalogPolicy: { hiddenProductIds: fullHiddenProductIds },
  }), /数量超过.*无法安全迁移/);
});

test("normalizes the persisted policy and drops unsupported or unsafe entries", () => {
  assert.deepEqual(normalizePublicCatalogPolicy({
    hiddenMajorCategoryKeys: ["marineFish", "unknown", "marineFish", " coral "],
    hiddenProductIds: [" gold-tang ", "", "gold-tang", null],
    hiddenSpeciesIds: ["species-fish", "species-fish"],
    productDisplayCaps: {
      " gold-tang ": "100",
      zero: 0,
      decimal: 1.5,
      negative: -1,
      boolean: true,
      huge: 1_000_001,
    },
  }), {
    hiddenMajorCategoryKeys: ["marineFish", "coral"],
    hiddenProductIds: ["gold-tang"],
    hiddenSpeciesIds: ["species-fish"],
    productDisplayCaps: { "gold-tang": 100 },
  });
  assert.deepEqual(normalizePublicCatalogPolicy(null), {
    hiddenMajorCategoryKeys: [],
    hiddenProductIds: [],
    hiddenSpeciesIds: [],
    productDisplayCaps: {},
  });
});

test("strict write validation rejects malformed values and stale entity references", () => {
  const valid = {
    hiddenMajorCategoryKeys: ["marineFish"],
    hiddenProductIds: ["gold-tang"],
    hiddenSpeciesIds: ["species-coral"],
    productDisplayCaps: { "purple-tang": 25 },
  };
  assert.deepEqual(validatePublicCatalogPolicyWrite(valid, { products, species }), valid);
  assert.throws(() => validatePublicCatalogPolicyWrite({
    ...valid,
    productDisplayCaps: { "gold-tang": 0 },
  }, { products, species }), /正整数/);
  assert.throws(() => validatePublicCatalogPolicyWrite({
    ...valid,
    productDisplayCaps: { "gold-tang": "100" },
  }, { products, species }), /正整数/);
  assert.throws(() => validatePublicCatalogPolicyWrite({
    ...valid,
    hiddenProductIds: ["deleted-product"],
  }, { products, species }), /不存在或不唯一的商品/);
  assert.throws(() => validatePublicCatalogPolicyWrite({
    ...valid,
    hiddenSpeciesIds: ["deleted-species"],
  }, { products, species }), /不存在或不唯一的物种/);
  assert.throws(() => validatePublicCatalogPolicyWrite({
    ...valid,
    unexpected: true,
  }, { products, species }), /未知字段/);
});

test("hard-deleted products and species are pruned without blocking later policy saves", () => {
  const before = {
    hiddenMajorCategoryKeys: [],
    hiddenProductIds: ["gold-tang", "purple-tang"],
    hiddenSpeciesIds: ["species-fish", "species-coral"],
    productDisplayCaps: { "gold-tang": 100, "purple-tang": 5 },
  };
  const afterDelete = prunePublicCatalogPolicyReferences(before, {
    products: products.filter((product) => product.id !== "gold-tang"),
    species: species.filter((item) => item.id !== "species-coral"),
  });
  assert.deepEqual(afterDelete, {
    hiddenMajorCategoryKeys: [],
    hiddenProductIds: ["purple-tang"],
    hiddenSpeciesIds: ["species-fish"],
    productDisplayCaps: { "purple-tang": 5 },
  });
  assert.doesNotThrow(() => validatePublicCatalogPolicyWrite({
    ...afterDelete,
    productDisplayCaps: { "purple-tang": 8 },
  }, {
    products: products.filter((product) => product.id !== "gold-tang"),
    species: species.filter((item) => item.id !== "species-coral"),
  }));
});

test("policy audit summaries name every kind of hide, restore, cap change and cap clear", () => {
  const detail = describePublicCatalogPolicyChanges({
    hiddenMajorCategoryKeys: ["marineFish"],
    hiddenProductIds: ["gold-tang"],
    hiddenSpeciesIds: ["species-fish"],
    productDisplayCaps: { "gold-tang": 100, "purple-tang": 50 },
  }, {
    hiddenMajorCategoryKeys: ["coral"],
    hiddenProductIds: ["purple-tang"],
    hiddenSpeciesIds: ["species-coral"],
    productDisplayCaps: { "gold-tang": 80, torch: 20 },
  }, { products, species });

  assert.match(detail, /^鱼单规则变更（共9项）：/);
  assert.match(detail, /隐藏类型（1项）：珊瑚/);
  assert.match(detail, /恢复类型（1项）：海水鱼/);
  assert.match(detail, /隐藏物种（1项）：species-coral/);
  assert.match(detail, /恢复物种（1项）：species-fish/);
  assert.match(detail, /隐藏商品（1项）：purple-tang/);
  assert.match(detail, /恢复商品（1项）：gold-tang/);
  assert.match(detail, /设置\/调整商品上限（2项）：gold-tang 100→80、torch 不限→20/);
  assert.match(detail, /清除商品上限（1项）：purple-tang 50→不限/);
});

test("policy audit summaries bound long details while retaining per-group and overall totals", () => {
  const manyProducts = Array.from({ length: 40 }, (_, index) => ({
    id: `product-${String(index).padStart(2, "0")}`,
    name: `名称很长的商品${String(index).padStart(2, "0")}${"鱼".repeat(80)}`,
  }));
  const detail = describePublicCatalogPolicyChanges({}, {
    hiddenProductIds: manyProducts.map((product) => product.id),
    productDisplayCaps: Object.fromEntries(manyProducts.map((product, index) => [product.id, index + 1])),
  }, { products: manyProducts });

  assert.ok(detail.length <= 1_000, detail.length);
  assert.match(detail, /^鱼单规则变更（共80项）：/);
  assert.match(detail, /隐藏商品（40项）：/);
  assert.match(detail, /设置\/调整商品上限（40项）：/);
  assert.match(detail, /、…/);
});

test("hides major types, individual products and whole species independently", () => {
  const stock = [
    { id: "gold-1", productId: "gold-tang" },
    { id: "purple-1", productId: "purple-tang" },
    { id: "torch-1", productId: "torch" },
  ];
  assert.deepEqual(select(stock, { hiddenMajorCategoryKeys: ["coral"] }), ["gold-1", "purple-1"]);
  assert.deepEqual(select(stock, { hiddenProductIds: ["gold-tang"] }), ["purple-1", "torch-1"]);
  assert.deepEqual(select(stock, { hiddenSpeciesIds: ["species-fish"] }), ["torch-1"]);
  assert.equal(inferPublicCatalogMajorCategory("清洁虾"), "invertebrate");
  assert.equal(isPublicCatalogProductAllowed({
    product: products[0],
    species: species[0],
    speciesCategoryMajorMap: categoryMap,
    publicCatalogPolicy: { hiddenMajorCategoryKeys: ["marineFish"] },
  }), false);
});

test("a product cap prioritizes rows with media and then the latest media record", () => {
  const stock = [
    { id: "no-media", productId: "gold-tang" },
    { id: "old-media", productId: "gold-tang" },
    { id: "newest-media", productId: "gold-tang" },
    { id: "middle-media", productId: "gold-tang" },
  ];
  assert.deepEqual(select(stock, {
    productDisplayCaps: { "gold-tang": 2 },
  }, {
    "old-media": "2026-08-01T10:00:00+08:00",
    "newest-media": "2026-08-04T10:00:00+08:00",
    "middle-media": "2026-08-03T10:00:00+08:00",
  }), ["newest-media", "middle-media"]);
});

test("a public media record with a missing date still ranks ahead of no media", () => {
  const stock = [
    { id: "no-media", productId: "gold-tang" },
    { id: "undated-media", productId: "gold-tang" },
  ];
  assert.deepEqual(select(stock, {
    productDisplayCaps: { "gold-tang": 1 },
  }, {
    "undated-media": "",
  }), ["undated-media"]);
});

test("leaving inventory automatically refills a cap from the next ranked row", () => {
  const stock = [
    { id: "oldest", productId: "gold-tang" },
    { id: "newest", productId: "gold-tang" },
    { id: "next", productId: "gold-tang" },
  ];
  const policy = { productDisplayCaps: { "gold-tang": 2 } };
  const media = {
    oldest: "2026-08-01T10:00:00+08:00",
    newest: "2026-08-03T10:00:00+08:00",
    next: "2026-08-02T10:00:00+08:00",
  };
  assert.deepEqual(select(stock, policy, media), ["newest", "next"]);
  assert.deepEqual(select(stock.filter((item) => item.id !== "newest"), policy, media), ["oldest", "next"]);
});

test("an exact media timestamp tie is pseudo-random but stable across refreshes", () => {
  const stock = Array.from({ length: 12 }, (_, index) => ({
    id: `fish-${String(index + 1).padStart(2, "0")}`,
    productId: "gold-tang",
  }));
  const media = Object.fromEntries(stock.map((item) => [item.id, "2026-08-20T14:49:00+08:00"]));
  const policy = { productDisplayCaps: { "gold-tang": 5 } };
  const first = select(stock, policy, media);
  const second = select(stock, policy, media);
  assert.deepEqual(second, first);
  assert.equal(first.length, 5);
  assert.notDeepEqual(first, stock.slice(0, 5).map((item) => item.id));
});

test("equivalent timestamp formats share one canonical pseudo-random tie group", () => {
  const stock = Array.from({ length: 12 }, (_, index) => ({
    id: `equivalent-${String(index + 1).padStart(2, "0")}`,
    productId: "gold-tang",
  }));
  const equivalentFormats = Object.fromEntries(stock.map((item, index) => [
    item.id,
    index % 2 === 0 ? "2026-09-04T12:00:00+08:00" : "2026-09-04T04:00:00Z",
  ]));
  const canonicalFormat = Object.fromEntries(stock.map((item) => [
    item.id,
    "2026-09-04T04:00:00.000Z",
  ]));
  const policy = { productDisplayCaps: { "gold-tang": 5 } };
  assert.deepEqual(
    select(stock, policy, equivalentFormats),
    select(stock, policy, canonicalFormat),
  );
});

test("uncapped and partially filled products preserve deterministic inventory order", () => {
  const stock = [
    { id: "first", productId: "gold-tang" },
    { id: "second", productId: "gold-tang" },
    { id: "third", productId: "purple-tang" },
  ];
  assert.deepEqual(select(stock), ["first", "second", "third"]);
  assert.deepEqual(select(stock, { productDisplayCaps: { "gold-tang": 9 } }), ["first", "second", "third"]);
  assert.deepEqual(select(stock, { productDisplayCaps: { "gold-tang": 1 } }), ["first", "third"]);
});

test("ambiguous identities, missing species and archived products fail closed while legacy visibility is ignored", () => {
  const stock = [
    { id: "duplicate-stock", productId: "gold-tang" },
    { id: "duplicate-stock", productId: "gold-tang" },
    { id: "legacy-visibility-stock", productId: "legacy-visibility-false" },
    { id: "archived-product-stock", productId: "archived-product" },
    { id: "orphan-stock", productId: "orphan" },
    { id: "ambiguous-product-stock", productId: "ambiguous-product" },
  ];
  const extendedProducts = [
    ...products,
    { id: "legacy-visibility-false", speciesId: "species-fish", publicVisible: false },
    {
      id: "archived-product",
      speciesId: "species-fish",
      publicVisible: true,
      archivedAt: "2026-09-05T12:00:00+08:00",
    },
    { id: "orphan", speciesId: "missing-species" },
    { id: "ambiguous-product", speciesId: "species-fish" },
    { id: "ambiguous-product", speciesId: "species-fish" },
  ];
  assert.deepEqual(selectPublicCatalogStock({
    stock,
    products: extendedProducts,
    species,
    speciesCategoryMajorMap: categoryMap,
  }).map((item) => item.id), ["legacy-visibility-stock"]);
  assert.equal(isPublicCatalogProductAllowed({
    product: extendedProducts.find((product) => product.id === "legacy-visibility-false"),
    species: species[0],
    speciesCategoryMajorMap: categoryMap,
  }), true);
  assert.equal(isPublicCatalogProductAllowed({
    product: extendedProducts.find((product) => product.id === "archived-product"),
    species: species[0],
    speciesCategoryMajorMap: categoryMap,
  }), false);
});

test("JavaScript prototype property names remain valid product IDs and cap keys", () => {
  const reservedProducts = ["toString", "constructor", "__proto__"].map((id) => ({
    id,
    speciesId: "species-fish",
  }));
  const reservedStock = reservedProducts.flatMap((product) => [
    { id: `${product.id}-1`, productId: product.id },
    { id: `${product.id}-2`, productId: product.id },
  ]);
  const uncapped = selectPublicCatalogStock({
    stock: reservedStock,
    products: reservedProducts,
    species,
    speciesCategoryMajorMap: categoryMap,
  });
  assert.deepEqual(uncapped.map((item) => item.id), reservedStock.map((item) => item.id));

  const productDisplayCaps = Object.fromEntries(
    reservedProducts.map((product) => [product.id, 1])
  );
  const normalized = normalizePublicCatalogPolicy({ productDisplayCaps });
  assert.deepEqual(Object.keys(normalized.productDisplayCaps), ["toString", "constructor", "__proto__"]);
  const capped = selectPublicCatalogStock({
    stock: reservedStock,
    products: reservedProducts,
    species,
    speciesCategoryMajorMap: categoryMap,
    publicCatalogPolicy: { productDisplayCaps },
  });
  assert.deepEqual(capped.map((item) => item.id), ["toString-1", "constructor-1", "__proto__-1"]);

  const setAudit = describePublicCatalogPolicyChanges({}, { productDisplayCaps }, {
    products: reservedProducts,
  });
  assert.match(setAudit, /constructor 不限→1/);
  assert.match(setAudit, /toString 不限→1/);
  assert.match(setAudit, /__proto__ 不限→1/);
  const clearAudit = describePublicCatalogPolicyChanges({ productDisplayCaps }, {}, {
    products: reservedProducts,
  });
  assert.match(clearAudit, /清除商品上限（3项）/);
  assert.match(clearAudit, /constructor 1→不限/);
  assert.match(clearAudit, /toString 1→不限/);
  assert.match(clearAudit, /__proto__ 1→不限/);
  assert.doesNotMatch(`${setAudit}${clearAudit}`, /function|native code/);
});
