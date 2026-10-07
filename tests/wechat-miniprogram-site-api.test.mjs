import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../wechat-miniprogram/utils/api.js", import.meta.url), "utf8");
const errorText = "所在地加载失败，请重试";
const plain = (value) => JSON.parse(JSON.stringify(value));
const stock = (...items) => ({ stock: items.map((item) => typeof item === "string" ? { id: item } : item) });

function harness(responses, siteId = "all") {
  const requests = [];
  const context = {
    module: { exports: {} },
    require(id) {
      assert.equal(id, "./config");
      return { apiBaseUrl: "https://fish.example", siteId: "all" };
    },
    getApp: () => ({ globalData: { siteId, privateToken: "must-not-be-sent" } }),
    wx: {
      request(options) {
        const scope = new URL(options.url).searchParams.get("siteId");
        requests.push({ scope, options });
        const value = typeof responses[scope] === "function" ? responses[scope](options) : responses[scope];
        if (value === undefined) return;
        if (value instanceof Error) {
          options.fail({ errMsg: value.message });
        } else if (value.__httpStatus) {
          options.success({ statusCode: value.__httpStatus, data: { error: "upstream error" } });
        } else {
          options.success({ statusCode: 200, data: { ok: true, catalog: value } });
        }
      }
    }
  };
  vm.runInNewContext(source, context);
  return { api: context.module.exports, requests };
}

function sites(result) {
  return plain(result.stock.map(({ id, siteId, siteName }) => ({ id, siteId, siteName })));
}

test("legacy all-site catalog receives cities only for already-visible stock without changing its other public data", async () => {
  const initial = {
    ...stock({ id: "n1", productId: "product", notes: "公开备注" }, "j1"),
    products: [{ id: "product", name: "公开商品" }],
    species: [{ id: "species" }],
    bioRecords: [{ stockItemId: "n1", videos: ["/media?expires=1800000000000&signature=keep-exact"] }]
  };
  const initialSnapshot = plain(initial);
  const { api, requests } = harness({
    all: initial,
    nanjing: { ...stock("n1", "extra-hidden-from-initial"), products: [{ id: "extra-product" }], privateOnly: true },
    jiangyin: stock("j1")
  });
  const result = await api.fetchCatalog();
  assert.deepEqual(sites(result), [
    { id: "n1", siteId: "nanjing", siteName: "南京" },
    { id: "j1", siteId: "jiangyin", siteName: "江阴" }
  ]);
  assert.deepEqual(plain(initial), initialSnapshot, "the source response must not be mutated");
  for (const field of ["products", "species", "bioRecords"]) {
    assert.deepEqual(plain(result[field]), initialSnapshot[field]);
  }
  assert.equal(result.privateOnly, undefined);
  assert.equal(result.stock.length, initialSnapshot.stock.length);
  assert.equal(result.stock[0].notes, "公开备注");
  assert.deepEqual(requests.map((request) => request.scope), ["all", "nanjing", "jiangyin"]);
  for (const { options } of requests) {
    assert.equal(options.method, "GET");
    assert.equal(new URL(options.url).pathname, "/api/public/catalog");
    assert.deepEqual(plain(options.header), { Accept: "application/json" });
    assert.doesNotMatch(JSON.stringify(options), /must-not-be-sent/);
  }
});

test("both supplemental cities are requested in parallel and resolution order cannot reverse city labels", async () => {
  const { api, requests } = harness({ all: stock("n1", "j1") });
  const pending = api.fetchCatalog();
  await Promise.resolve();
  assert.deepEqual(requests.map((request) => request.scope), ["all", "nanjing", "jiangyin"]);
  requests[2].options.success({ statusCode: 200, data: { catalog: stock("j1") } });
  requests[1].options.success({ statusCode: 200, data: { catalog: stock("n1") } });
  assert.deepEqual(sites(await pending), [
    { id: "n1", siteId: "nanjing", siteName: "南京" },
    { id: "j1", siteId: "jiangyin", siteName: "江阴" }
  ]);
});

test("a complete new API response and an empty public catalog never request supplemental scopes", async () => {
  for (const initial of [stock({ id: "n1", siteId: "nanjing", siteName: "南京" }), stock()]) {
    const { api, requests } = harness({ all: initial });
    assert.deepEqual(plain(await api.fetchCatalog()), initial);
    assert.equal(requests.length, 1);
  }
});

test("an explicit city scope fills legacy stock directly and rejects contradictory declared sites", async () => {
  for (const [siteId, siteName] of [["nanjing", "南京"], ["jiangyin", "江阴"]]) {
    const { api, requests } = harness({ [siteId]: stock("fish") }, siteId);
    assert.deepEqual(sites(await api.fetchCatalog()), [{ id: "fish", siteId, siteName }]);
    assert.equal(requests.length, 1);
    const wrongSite = siteId === "nanjing" ? "jiangyin" : "nanjing";
    const inconsistent = harness({ [siteId]: stock({ id: "fish", siteId: wrongSite }) }, siteId);
    await assert.rejects(inconsistent.api.fetchCatalog(), { message: errorText });
    assert.equal(inconsistent.requests.length, 1);
  }
});

test("mixed new and legacy fields remain consistent without guessing locations for other city scopes", async () => {
  const responses = {
    all: stock({ id: "known", siteId: "nanjing", siteName: "南京" }, "legacy", { id: "other", siteId: "beijing", siteName: "北京" }),
    nanjing: stock({ id: "known", siteId: "nanjing" }),
    jiangyin: stock("legacy")
  };
  const { api } = harness(responses);
  assert.deepEqual(sites(await api.fetchCatalog()), [
    { id: "known", siteId: "nanjing", siteName: "南京" },
    { id: "legacy", siteId: "jiangyin", siteName: "江阴" },
    { id: "other", siteId: "beijing", siteName: "北京" }
  ]);
  const unknownScope = harness({ beijing: stock("legacy") }, "beijing");
  await assert.rejects(unknownScope.api.fetchCatalog(), { message: errorText });
  assert.equal(unknownScope.requests.length, 1);
});

test("duplicate, overlapping, incomplete or contradictory city responses fail closed", async (t) => {
  const cases = [
    ["duplicate IDs in original", { all: stock("n1", "n1"), nanjing: stock("n1"), jiangyin: stock() }],
    ["duplicate IDs in complete original", { all: stock({ id: "n1", siteId: "nanjing" }, { id: "n1", siteId: "nanjing" }) }],
    ["missing original ID", { all: stock({ siteId: "nanjing" }) }],
    ["duplicate city IDs", { all: stock("n1"), nanjing: stock("n1", "n1"), jiangyin: stock() }],
    ["overlap between cities", { all: stock("n1"), nanjing: stock("n1"), jiangyin: stock("n1") }],
    ["no city claims the original", { all: stock("missing"), nanjing: stock(), jiangyin: stock() }],
    ["malformed city stock", { all: stock("n1"), nanjing: { stock: null }, jiangyin: stock() }],
    ["city declared against scope", { all: stock("n1"), nanjing: stock({ id: "n1", siteId: "jiangyin" }), jiangyin: stock() }],
    ["original differs from scoped membership", { all: stock({ id: "n1", siteId: "nanjing" }, "j1"), nanjing: stock("j1"), jiangyin: stock("n1") }],
    ["known initial city absent from both scopes", { all: stock({ id: "n1", siteId: "nanjing" }, "j1"), nanjing: stock(), jiangyin: stock("j1") }]
  ];
  for (const [name, responses] of cases) {
    await t.test(name, async () => {
      const { api } = harness(responses);
      await assert.rejects(api.fetchCatalog(), { message: errorText });
    });
  }
});

test("transport and HTTP errors in either city fail the full result and a fresh retry can recover", async () => {
  for (const failingSite of ["nanjing", "jiangyin"]) {
    for (const failure of [new Error("request:fail timeout"), { __httpStatus: 503 }]) {
      const responses = { all: stock("n1", "j1"), nanjing: stock("n1"), jiangyin: stock("j1") };
      responses[failingSite] = failure;
      const { api, requests } = harness(responses);
      await assert.rejects(api.fetchCatalog(), { message: errorText });
      responses[failingSite] = stock(failingSite === "nanjing" ? "n1" : "j1");
      const recovered = await api.fetchCatalog();
      assert.deepEqual(recovered.stock.map((item) => item.siteId).join(","), "nanjing,jiangyin");
      assert.equal(requests.length, 6, "retry re-fetches the original and both current scopes");
    }
  }
});

test("a subsequent refresh observes a move between cities without reusing any location mapping", async () => {
  const responses = { all: stock("fish"), nanjing: stock("fish"), jiangyin: stock() };
  const { api, requests } = harness(responses);
  assert.equal((await api.fetchCatalog()).stock[0].siteId, "nanjing");
  responses.nanjing = stock();
  responses.jiangyin = stock("fish");
  assert.equal((await api.fetchCatalog()).stock[0].siteId, "jiangyin");
  assert.equal(requests.length, 6);
});

test("failure of the authoritative catalog never falls back to a city result or triggers supplemental reads", async () => {
  const { api, requests } = harness({ all: new Error("request:fail unavailable"), nanjing: stock("n1"), jiangyin: stock("j1") });
  await assert.rejects(api.fetchCatalog(), /unavailable/);
  assert.equal(requests.length, 1);
});
