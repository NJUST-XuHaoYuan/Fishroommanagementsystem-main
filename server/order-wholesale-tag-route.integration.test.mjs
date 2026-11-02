import test from "node:test";
import assert from "node:assert/strict";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
import { ORDER_WHOLESALE_TAG_FIELDS } from "./order-wholesale-tag.mjs";
import { buildStockMutationExpectation } from "./stock-mutation-relationships.mjs";

const ok = (result) => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const tag = (order) => Object.fromEntries(ORDER_WHOLESALE_TAG_FIELDS.filter((key) => Object.hasOwn(order, key)).map((key) => [key, order[key]]));
const business = (order) => Object.fromEntries(Object.entries(order).filter(([key]) => !ORDER_WHOLESALE_TAG_FIELDS.includes(key)));
const expected = (order) => ({ expectedIsWholesaleOrder: order?.isWholesaleOrder === true,
  expectedWholesaleOrderUpdatedAt: String(order?.wholesaleOrderUpdatedAt ?? "") });

function fixture() {
  const data = structuredClone(stockPricingFixture);
  data.state.commissionLedgerV1 = { immutableSentinel: "COMMISSION_MUST_NOT_CHANGE", months: { "2026-10": { total: 123 } } };
  data.state.customers = [{ id: "wholesale-customer", customerType: "B", name: "批发客户" }];
  const order = data.state.orders.find((item) => item.id === "ORDER-PENDING");
  Object.assign(order, { source: "平台下单", platformOrderNo: "WHOLESALE-PENDING", douyinOrderNo: "WHOLESALE-PENDING",
    paymentChannel: "douyin", paymentAccount: "test-account", plannedShipDate: "2026-11-05", contactPersonnelId: "pricing-editor",
    contactPerson: "价格测试editor", createdAt: "2026-10-05T09:00:00+08:00", customerId: "wholesale-customer",
    newCustomerApproval: { status: "approved", version: 2 }, isAcquisitionOrder: true });
  data.state.orders.push({ ...structuredClone(order), id: "PRIVATE-JY-ORDER", orderNo: "PRIVATE-JY-NUMBER", siteId: "jiangyin", notes: "PRIVATE-JY-NOTE",
    platformOrderNo: "PRIVATE-JY-PLATFORM", douyinOrderNo: "PRIVATE-JY-PLATFORM" });
  return data;
}

async function setup(t, data = fixture()) {
  const server = await startMutableRouteServer(data); t.after(() => server.stop());
  const tokens = {};
  for (const role of ["admin", "editor", "viewer"]) tokens[role] = await server.login(`pricing-${role}`, PRICING_TEST_PASSWORD);
  const readOrder = async (id = "ORDER-PENDING") => (await server.readPersistedState()).orders.find((order) => order.id === id);
  const mark = async (value, { orderId = "ORDER-PENDING", token = tokens.editor, base, extra = {} } = {}) => {
    const current = base ?? await readOrder(orderId);
    return server.request("/api/orders/wholesale-tag", { token, body: { orderId, isWholesaleOrder: value, ...expected(current), ...extra } });
  };
  return { ...server, tokens, readOrder, mark };
}

test("authorized staff marks and unmarks every order status without changing any business field or unrelated state", async (t) => {
  const data = fixture();
  for (const status of ["pending", "confirmed", "shipped", "delivered", "completed", "cancelled", "damaged"]) {
    data.state.orders.push({ ...structuredClone(data.state.orders[0]), id: `status-${status}`, status });
  }
  const s = await setup(t, data);
  const before = await s.readPersistedState();
  assert.equal((await s.readOrder()).isWholesaleOrder, undefined, "a B customer does not auto-tag its orders");
  for (const status of ["pending", "confirmed", "shipped", "delivered", "completed", "cancelled", "damaged"]) {
    const orderId = `status-${status}`;
    const original = await s.readOrder(orderId);
    const marked = await s.mark(true, { orderId, extra: { wholesaleOrderUpdatedBy: "forged", status: "cancelled", discount: 999 } }); ok(marked);
    assert.equal(marked.body.order.isWholesaleOrder, true);
    assert.equal(marked.body.order.wholesaleOrderUpdatedBy, "pricing-editor");
    assert.equal(marked.body.order.wholesaleOrderUpdatedByName, "价格测试editor");
    assert.deepEqual(business(marked.body.order), original);
    assert.equal(marked.body.operationLog.action, "标记批发订单");
    const unmarked = await s.mark(false, { orderId }); ok(unmarked);
    assert.equal(unmarked.body.order.isWholesaleOrder, false);
    assert.deepEqual(business(unmarked.body.order), original);
    assert.equal(unmarked.body.operationLog.action, "取消批发标记");
  }
  const after = await s.readPersistedState();
  for (const key of Object.keys(before).filter((key) => !["orders", "operationLogs"].includes(key))) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.orders.map(business), before.orders);
});

test("wholesale endpoint denies unauthenticated, view-only and unauthorized-site access without leaking orders", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const [options, status] of [[{ token: "" }, 401], [{ token: s.tokens.viewer }, 403], [{ orderId: "PRIVATE-JY-ORDER" }, 403]]) {
    const result = await s.mark(true, options);
    assert.equal(result.response.status, status, JSON.stringify(result.body));
    assert.equal(result.response.headers.get("cache-control"), "no-store, private");
    assert.equal(result.body.order, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE-JY-NOTE|PRIVATE-JY-NUMBER/);
  }
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.mark(true, { orderId: "PRIVATE-JY-ORDER", token: s.tokens.admin }));
});

test("strict boolean/CAS validation, duplicate retry and concurrent repeat clicks never create extra writes", async (t) => {
  const s = await setup(t); const before = await s.readPersistedState();
  for (const value of ["true", "false", 1, 0, null]) assert.equal((await s.mark(value)).response.status, 400);
  for (const value of ["false", 0, null]) {
    const result = await s.mark(true, { extra: { expectedIsWholesaleOrder: value } });
    assert.equal(result.response.status, 409); assert.deepEqual(result.body.order, await s.readOrder());
  }
  assert.deepEqual(await s.readPersistedState(), before);
  const base = await s.readOrder();
  const results = await Promise.all([s.mark(true, { base }), s.mark(true, { base }), s.mark(true, { base })]);
  results.forEach(ok);
  assert.equal(results.filter((result) => !result.body.unchanged).length, 1);
  const after = await s.readPersistedState();
  assert.equal(after.operationLogs.length, before.operationLogs.length + 1);
  const repeat = await s.mark(true, { base }); ok(repeat); assert.equal(repeat.body.unchanged, true);
  assert.deepEqual(await s.readPersistedState(), after);
  ok(await s.mark(false));
  const conflict = await s.mark(true, { base });
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body.code, "ORDER_WHOLESALE_TAG_CONFLICT");
  assert.deepEqual(conflict.body.order, await s.readOrder());
});

test("duplicate or missing order identity fails closed before any tag change or order disclosure", async (t) => {
  const data = fixture();
  data.state.orders.push({ ...structuredClone(data.state.orders.find((order) => order.id === "ORDER-PENDING")), siteId: "jiangyin", notes: "PRIVATE-DUPLICATE" });
  const s = await setup(t, data); const before = await s.readPersistedState();
  for (const [orderId, status] of [["ORDER-PENDING", 409], ["missing", 404], ["", 400]]) {
    const result = await s.mark(true, { orderId, base: {} });
    assert.equal(result.response.status, status);
    assert.equal(result.body.order, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE-DUPLICATE/);
  }
  assert.deepEqual(await s.readPersistedState(), before);
});

test("locked account refresh prevents permission/site revocations and disabled, removed or revoked sessions", async (t) => {
  for (const patch of [{ permissions: {} }, { visibleSiteIds: ["jiangyin"] }, { accountEnabled: false }, { sessionVersion: 1 }, { accessRole: "admin" }, { username: "removed-account" }]) {
    const s = await setup(t);
    ok(await s.mark(false)); // warm the authenticated-account cache
    await s.patchTestPersonnel("pricing-editor", patch);
    const before = await s.readPersistedState();
    const result = await s.mark(true);
    assert.ok([401, 403].includes(result.response.status), JSON.stringify({ patch, body: result.body }));
    assert.equal(result.body.order, undefined);
    assert.deepEqual(await s.readPersistedState(), before);
  }
});

test("generic state patch cannot forge or erase wholesale metadata but stale unrelated note edits preserve it", async (t) => {
  const data = fixture(); delete data.state.commissionLedgerV1;
  const s = await setup(t, data);
  let original = await s.readOrder();
  ok(await s.request("/api/orders/update", { token: s.tokens.editor, body: { ...original, orderId: original.id } }));
  original = await s.readOrder();
  ok(await s.mark(true));
  const marked = await s.readOrder();
  for (const token of [s.tokens.admin, s.tokens.editor]) {
    for (const key of ORDER_WHOLESALE_TAG_FIELDS) {
      const removed = { ...marked }; delete removed[key];
      for (const changed of [removed, { ...marked, [key]: "forged" }]) {
        for (const withBase of [false, true]) {
          const result = await s.request("/api/state/patch", { token, body: {
            patch: { orders: [changed] }, ...(withBase ? { basePatch: { orders: [marked] } } : {}),
          } });
          assert.equal(result.response.status, 409, JSON.stringify(result.body));
          assert.match(result.body.error, /批发订单标记|版本|刷新/, JSON.stringify(result.body));
          assert.deepEqual(tag(await s.readOrder()), tag(marked));
        }
      }
    }
  }
  const stale = await s.request("/api/state/patch", { token: s.tokens.editor, body: {
    patch: { orders: [{ ...original, notes: "stale client ordinary note" }] }, basePatch: { orders: [original] },
  } }); ok(stale);
  assert.equal((await s.readOrder()).notes, "stale client ordinary note");
  assert.deepEqual(tag(await s.readOrder()), tag(marked));
});

test("ordinary create discards injected wholesale tags and ordinary edits preserve live metadata", async (t) => {
  const data = fixture(); delete data.state.commissionLedgerV1;
  const s = await setup(t, data);
  const original = await s.readOrder(); ok(await s.mark(true));
  const marked = await s.readOrder();
  const forged = Object.fromEntries(ORDER_WHOLESALE_TAG_FIELDS.map((key) => [key, "forged"]));
  const edit = await s.request("/api/orders/update", { token: s.tokens.editor, body: {
    ...original, ...forged, isWholesaleOrder: false, orderId: original.id, notes: "normal business edit",
  } }); ok(edit);
  assert.deepEqual(tag(edit.body.order), tag(marked));
  const created = await s.request("/api/orders/create", { token: s.tokens.editor, body: {
    siteId: "nanjing", source: "平台下单", platformOrderNo: "WHOLESALE-INJECTED-CREATE", date: "2026-11-02",
    paymentChannel: "douyin", plannedShipDate: "2026-11-05", contactPersonnelId: "pricing-editor",
    items: [{ stockItemId: "follower", price: 150 }], shippingFeeMode: "collect", ...forged, isWholesaleOrder: true,
  } }); ok(created);
  assert.deepEqual(tag(created.body.order), {});
  assert.deepEqual(tag(await s.readOrder()), tag(marked));
});

test("a pending inventory approval preserves a tag added after the request, and retired full-state writes remain blocked", async (t) => {
  const data = fixture(); delete data.state.commissionLedgerV1;
  data.state.orders = data.state.orders.filter((order) => order.id !== "PRIVATE-JY-ORDER");
  const s = await setup(t, data);
  const before = await s.readPersistedState();
  const fullWrite = await s.request("/api/state", { token: s.tokens.admin, body: { ...before, orders: before.orders.map((order) => ({ ...order, isWholesaleOrder: true })) } });
  assert.equal(fullWrite.response.status, 410);
  assert.deepEqual(await s.readPersistedState(), before);
  const change = { upsert: [], deleteIds: ["ordered-pending"] };
  const pending = await s.request("/api/stock/save", { token: s.tokens.editor, body: { ...change, ...buildStockMutationExpectation(before, change) } }); ok(pending);
  assert.equal(pending.body.pendingApproval, true);
  ok(await s.mark(true));
  const marked = await s.readOrder();
  const approved = await s.request("/api/approvals/stock", { token: s.tokens.admin, body: {
    requestId: pending.body.approvalRequestId, decision: "approve",
  } }); ok(approved);
  const after = await s.readOrder();
  assert.ok(after.items[0].inventoryRemovedAt);
  assert.deepEqual(tag(after), tag(marked));
});
