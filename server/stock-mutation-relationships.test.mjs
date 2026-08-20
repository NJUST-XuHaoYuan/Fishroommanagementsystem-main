import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertStockMutationExpectation,
  authoritativeStockMutationSiteId,
  buildStockMutationExpectation,
  validateStockMutationRelationships,
} from "./stock-mutation-relationships.mjs";

const localServerSource = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");

const baseState = {
  sites: [{ id: "nanjing" }, { id: "beijing" }, { id: "jiangyin" }],
  products: [{ id: "product-a" }],
  batches: [{ id: "batch-a", siteId: "nanjing" }],
  tankGroups: [{ id: "group-a", siteId: "nanjing", subTanks: [{ id: "tank-a" }] }],
  stock: [{
    id: "stock-a",
    productId: "product-a",
    batchId: "batch-a",
    subTankId: "tank-a",
    siteId: "nanjing",
  }],
};

test("stock mutations require one product, batch, sub-tank and explicit current site", () => {
  assert.equal(authoritativeStockMutationSiteId(baseState, baseState.stock[0]), "nanjing");
  assert.throws(
    () => authoritativeStockMutationSiteId(baseState, { ...baseState.stock[0], siteId: "beijing" }),
    /场地和当前缸位不一致/,
  );
  assert.throws(
    () => authoritativeStockMutationSiteId(baseState, { ...baseState.stock[0], batchId: "missing" }),
    /采购批次不存在或不唯一/,
  );
});

test("ordinary stock save checks both the old and new authoritative sites", () => {
  assert.equal(validateStockMutationRelationships(baseState, {
    upsert: [{ ...baseState.stock[0], notes: "updated" }],
  }, { visibleSiteIds: ["nanjing"] }), true);
  assert.throws(() => validateStockMutationRelationships(baseState, {
    deleteIds: ["stock-a"],
  }, { visibleSiteIds: ["beijing"] }), (error) =>
    error?.statusCode === 403 && error?.code === "STOCK_SITE_FORBIDDEN"
  );
});

test("duplicate stock, product, batch and sub-tank identifiers fail closed", () => {
  assert.throws(() => validateStockMutationRelationships({
    ...baseState,
    stock: [...baseState.stock, { ...baseState.stock[0] }],
  }, { deleteIds: ["stock-a"] }), (error) => error?.code === "STOCK_ID_NOT_UNIQUE");
  assert.throws(() => authoritativeStockMutationSiteId({
    ...baseState,
    tankGroups: [...baseState.tankGroups, { id: "group-b", siteId: "nanjing", subTanks: [{ id: "tank-a" }] }],
  }, baseState.stock[0]), /缸位不存在或不唯一/);
  assert.throws(() => authoritativeStockMutationSiteId({
    ...baseState,
    sites: [...baseState.sites, { id: "nanjing" }],
  }, baseState.stock[0]), /场地不存在或不唯一/);
});

test("stock mutation identifiers are normalized, unique and disjoint", () => {
  assert.throws(() => validateStockMutationRelationships(baseState, {
    upsert: [{ ...baseState.stock[0], id: " " }],
  }), (error) => error?.code === "STOCK_ID_REQUIRED");
  assert.throws(() => validateStockMutationRelationships(baseState, {
    upsert: [
      { ...baseState.stock[0], id: "new-stock" },
      { ...baseState.stock[0], id: " new-stock " },
    ],
  }), (error) => error?.code === "STOCK_UPSERT_ID_DUPLICATE");
  assert.throws(() => validateStockMutationRelationships(baseState, {
    upsert: [{ ...baseState.stock[0] }],
    deleteIds: [" stock-a "],
  }), (error) => error?.code === "STOCK_UPSERT_DELETE_CONFLICT");
});

test("ordinary stock save cannot move an existing item between sites", () => {
  const state = {
    ...baseState,
    batches: [...baseState.batches, { id: "batch-b", siteId: "beijing" }],
    tankGroups: [...baseState.tankGroups, {
      id: "group-b",
      siteId: "beijing",
      subTanks: [{ id: "tank-b" }],
    }],
  };
  assert.throws(() => validateStockMutationRelationships(state, {
    upsert: [{
      ...baseState.stock[0],
      siteId: "beijing",
      batchId: "batch-b",
      subTankId: "tank-b",
    }],
  }), (error) => error?.code === "STOCK_SITE_CHANGE_FORBIDDEN");
});

test("a moved fish may keep its procurement batch but new stock may not cross sites", () => {
  const state = {
    ...baseState,
    batches: [{ id: "batch-a", siteId: "jiangyin" }],
    stock: [{ ...baseState.stock[0], notes: "moved from jiangyin" }],
  };
  assert.equal(validateStockMutationRelationships(state, {
    upsert: [{ ...state.stock[0], notes: "edited after move" }],
  }, { visibleSiteIds: ["nanjing"] }), true);
  assert.throws(() => validateStockMutationRelationships(state, {
    upsert: [{ ...state.stock[0], id: "stock-new" }],
  }, { visibleSiteIds: ["nanjing"] }), (error) => error?.code === "STOCK_BATCH_SITE_INVALID");
});

test("stock approval expectation keeps create update and delete semantics stable", () => {
  const update = { ...baseState.stock[0], notes: "updated" };
  const create = { ...baseState.stock[0], id: "stock-b" };
  const payload = {
    upsert: [update, create],
    deleteIds: [],
    ...buildStockMutationExpectation(baseState, { upsert: [update, create], deleteIds: [] }),
  };
  assert.equal(assertStockMutationExpectation(baseState, payload), true);
  assert.throws(() => assertStockMutationExpectation({
    ...baseState,
    stock: [{ ...baseState.stock[0], notes: "changed elsewhere" }],
  }, payload), (error) => error?.code === "STOCK_APPROVAL_STALE");
  assert.throws(() => assertStockMutationExpectation({
    ...baseState,
    stock: [...baseState.stock, create],
  }, payload), (error) => error?.code === "STOCK_APPROVAL_STALE");
  assert.throws(() => assertStockMutationExpectation(baseState, {
    upsert: [update],
    deleteIds: [],
  }), (error) => error?.code === "STOCK_APPROVAL_STALE");
});

test("a stale same-site form cannot move stock back or overwrite a newer value", () => {
  const proposed = { ...baseState.stock[0], notes: "price form save" };
  const payload = {
    upsert: [proposed],
    deleteIds: [],
    ...buildStockMutationExpectation(baseState, { upsert: [proposed] }),
  };
  const movedState = {
    ...baseState,
    tankGroups: [{
      ...baseState.tankGroups[0],
      subTanks: [{ id: "tank-a" }, { id: "tank-a-2" }],
    }],
    stock: [{ ...baseState.stock[0], subTankId: "tank-a-2", notes: "moved by maintenance" }],
  };
  assert.throws(
    () => assertStockMutationExpectation(movedState, payload),
    (error) => error?.statusCode === 409 && error?.code === "STOCK_APPROVAL_STALE",
  );
});

test("legacy stock display normalization does not create a false CAS conflict", () => {
  const legacy = {
    ...baseState.stock[0],
    status: "sold",
    cost: 88,
    notes: "",
  };
  delete legacy.basePrice;
  delete legacy.code;
  delete legacy.lossProof;
  const state = { ...baseState, stock: [legacy] };
  const displayed = {
    ...legacy,
    status: "healthy",
    sold: true,
    basePrice: 88,
    code: "",
    lossProof: [],
  };
  delete displayed.cost;
  const payload = {
    upsert: [{ ...displayed, notes: "edited" }],
    deleteIds: [],
    expectedOperations: { "stock-a": "update" },
    expectedBefore: { "stock-a": displayed },
  };
  assert.equal(assertStockMutationExpectation(state, payload), true);
});

test("the stock save route enforces client CAS before applying and filters its response", () => {
  const start = localServerSource.indexOf('if (url.pathname === "/api/stock/save"');
  const end = localServerSource.indexOf('\n\t\t  if (url.pathname === "/api/maintenance/save"', start);
  assert.ok(start >= 0 && end > start);
  const route = localServerSource.slice(start, end);
  assert.match(route, /CLIENT_REFRESH_REQUIRED/);
  const expectationIndex = route.indexOf("assertStockMutationExpectation(state, externalizedChange)");
  const applyIndex = route.indexOf("applyStockMutationToState(state, externalizedChange");
  assert.ok(expectationIndex >= 0 && applyIndex > expectationIndex);
  assert.match(route, /siteVisibilityFilteredState\(nextState, req\.auth\?\.account\)/);
  assert.doesNotMatch(route, /stock:\s*mutation\.stock/);
});
