import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { crossSiteFulfillmentFixture, FULFILLMENT_TEST_PASSWORD } from "./test-support/cross-site-fulfillment-fixture.mjs";

const ORDER_ID = "moved-order";
const OWNER_ID = "order-owner";
const proofs = ["/uploads/ownership-packing-1.jpg", "/uploads/ownership-packing-2.jpg"];
const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const ownerDenied = result => {
  assert.equal(result.response.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.code, "ORDER_OWNER_REQUIRED", JSON.stringify(result.body));
};
const denied = result => assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.body));

function fixture() {
  const data = crossSiteFulfillmentFixture({ origin: "nanjing", destination: "nanjing" });
  const staff = data.state.personnel.find(person => person.id === "pricing-editor");
  data.state.personnel.push({ ...structuredClone(staff), id: OWNER_ID, username: OWNER_ID, name: "订单负责人" });
  data.state.personnel.push({ ...structuredClone(staff), id: "boundary-finance", username: "boundary-finance", name: "财务核验", accessRole: "finance", permissions: {} });
  Object.assign(data.state.orders[0], { contactPersonnelId: OWNER_ID, contactPerson: "订单负责人", shippingFeeMode: "prepaid", shippingFee: 20,
    createdAt: "2026-10-20T09:00:00+08:00", createdBy: "pricing-editor" });
  data.state.orders.push({ ...structuredClone(data.state.orders[0]), id: "coworker-order", orderNo: "SO-COWORKER", platformOrderNo: "COWORKER-PLATFORM",
    douyinOrderNo: "COWORKER-PLATFORM", contactPersonnelId: "pricing-editor", contactPerson: staff.name,
    items: [{ ...data.state.orders[0].items[0], stockItemId: "unrelated-fish" }] });
  return data;
}

async function setup(t, customize = () => {}) {
  const data = fixture(); customize(data.state);
  const s = await startMutableRouteServer(data); t.after(s.stop);
  const tokens = {};
  for (const [role, username] of Object.entries({ owner: OWNER_ID, coworker: "pricing-editor", admin: "pricing-admin", finance: "boundary-finance" })) {
    tokens[role] = await s.login(username, FULFILLMENT_TEST_PASSWORD);
  }
  const post = (path, body, role = "coworker") => s.request(path, { token: tokens[role], body });
  const get = (path, role = "coworker") => s.request(path, { token: tokens[role] });
  const order = async (id = ORDER_ID) => (await s.readPersistedState()).orders.find(item => item.id === id);
  const edit = async (changes = {}, role = "coworker", original) => {
    const current = original || await order();
    return post("/api/orders/update", { ...current, orderId: current.id, ...changes }, role);
  };
  const mark = async (value, role = "coworker", id = ORDER_ID) => {
    const current = await order(id);
    return post("/api/orders/wholesale-tag", { orderId: id, isWholesaleOrder: value,
      expectedIsWholesaleOrder: current.isWholesaleOrder === true, expectedWholesaleOrderUpdatedAt: current.wholesaleOrderUpdatedAt || "" }, role);
  };
  const outbound = async (role = "coworker") => {
    const result = await post("/api/shipments/outbound", { orderId: ORDER_ID, selectedItemIds: ["moved-fish"], shipMethod: "express",
      carrier: "顺丰", shipDate: "2026-11-28" }, role);
    ok(result); return result.body.shipment;
  };
  return { ...s, tokens, post, get, order, edit, mark, outbound };
}

test("another order editor cannot change business data, refund, return fish, complete, delete or classify a foreign order", async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  const current = await s.order();
  const cases = [
    ["/api/orders/update", { ...current, orderId: ORDER_ID, notes: "not my order" }],
    ["/api/orders/wholesale-tag", { orderId: ORDER_ID, isWholesaleOrder: true, expectedIsWholesaleOrder: false, expectedWholesaleOrderUpdatedAt: "" }],
    ["/api/orders/refund", { orderId: ORDER_ID, amount: 1, time: "2026-11-28T09:00:00" }],
    ["/api/orders/return-item", { orderId: ORDER_ID, stockItemId: "moved-fish" }],
    ["/api/orders/complete", { orderId: ORDER_ID }],
    ["/api/orders/delete", { orderId: ORDER_ID }],
  ];
  for (const [path, body] of cases) {
    ownerDenied(await s.post(path, body));
    assert.deepEqual(await s.readPersistedState(), before, path);
  }
  ok(await s.edit({ notes: "owner may edit" }, "owner"));
  ok(await s.edit({ notes: "admin may edit any order" }, "admin"));
  ok(await s.mark(true, "admin"));
});

test("generic mixed-order patch rejects atomically while a self-owned edit can carry unchanged foreign rows", async t => {
  const s = await setup(t);
  // The shared fulfillment fixture intentionally contains a legacy platform
  // source. Normalize the edited row through its real save route first.
  ok(await s.edit({}, "coworker", await s.order("coworker-order")));
  const before = await s.readPersistedState();
  ownerDenied(await s.post("/api/state/patch", { basePatch: { orders: before.orders }, patch: {
    orders: before.orders.map(order => ({ ...order, notes: "mixed unauthorized batch" })),
  } }));
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.post("/api/state/patch", { basePatch: { orders: before.orders }, patch: {
    orders: before.orders.map(order => order.id === "coworker-order" ? { ...order, notes: "my own change" } : order),
  } }));
  assert.equal((await s.order("coworker-order")).notes, "my own change");
  assert.deepEqual(await s.order(), before.orders.find(order => order.id === ORDER_ID));
});

test("non-owner may dispatch, save packing and tracking details, record actual freight and confirm receipt without changing commercial terms", async t => {
  const s = await setup(t); const before = await s.order();
  const shipment = await s.outbound();
  let state = await s.readPersistedState();
  ok(await s.post("/api/state/patch", { basePatch: { shipments: state.shipments }, patch: {
    shipments: state.shipments.map(item => item.id === shipment.id ? { ...item, trackingNo: "SF-OWNERSHIP-QA", packingProof: proofs } : item),
  } }));
  ok(await s.post("/api/shipments/confirm", { shipmentId: shipment.id, packingProof: proofs }));
  ok(await s.post("/api/shipments/actual-shipping-fee", { shipmentId: shipment.id, actualShippingFee: 18,
    expectedActualShippingFee: 0, expectedActualShippingFeeRecordedAt: "" }));
  ok(await s.post("/api/shipments/deliver", { shipmentId: shipment.id }));
  state = await s.readPersistedState(); const after = await s.order();
  assert.equal(state.shipments.find(item => item.id === shipment.id).status, "delivered");
  assert.equal(state.shipments.find(item => item.id === shipment.id).trackingNo, "SF-OWNERSHIP-QA");
  assert.deepEqual(after.items, before.items); assert.deepEqual(after.payments, before.payments);
  assert.equal(after.contactPersonnelId, OWNER_ID); assert.equal(after.discount, before.discount);
  ownerDenied(await s.post("/api/orders/complete", { orderId: ORDER_ID }));
});

test("generic shipment logistics exception cannot carry damage metadata or order business changes", async t => {
  const s = await setup(t); const shipment = await s.outbound();
  const before = await s.readPersistedState();
  for (const changes of [
    { damageResolution: "refund" }, { damageProof: ["/uploads/forged-damage.jpg"] },
    { status: "damaged", damageResolution: "refund" },
  ]) {
    ownerDenied(await s.post("/api/state/patch", { basePatch: { shipments: before.shipments }, patch: {
      shipments: before.shipments.map(item => item.id === shipment.id ? { ...item, trackingNo: "logistics-plus-business", ...changes } : item),
    } }));
    assert.deepEqual(await s.readPersistedState(), before);
  }
  ownerDenied(await s.post("/api/state/patch", { basePatch: { orders: before.orders, shipments: before.shipments }, patch: {
    shipments: before.shipments.map(item => ({ ...item, trackingNo: "would-be-valid-alone" })),
    orders: before.orders.map(item => item.id === ORDER_ID ? { ...item, discount: 10 } : item),
  } }));
  assert.deepEqual(await s.readPersistedState(), before);
});

test("a shipping coworker cannot cancel outbound inventory even with a valid review payload; the owner can", async t => {
  const s = await setup(t); const shipment = await s.outbound();
  const preview = await s.get(`/api/shipments/cancel-preview?shipmentId=${shipment.id}`, "owner"); ok(preview);
  const body = { shipmentId: shipment.id, reviewToken: preview.body.reviewToken, confirmedPhysicalReturn: true,
    returnItems: [{ stockItemId: "moved-fish", subTankId: "tank-n" }] };
  const before = await s.readPersistedState();
  ownerDenied(await s.post("/api/shipments/cancel", body));
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.post("/api/shipments/cancel", body, "owner"));
  const after = await s.readPersistedState();
  assert.equal(after.shipments.length, 0);
  assert.equal(after.shipmentCancellationAudits.at(-1).cancelledBy, OWNER_ID);
});

test("a shipping coworker cannot record logistics damage and reduce receivable; the owner can", async t => {
  const s = await setup(t); const shipment = await s.outbound();
  ok(await s.post("/api/shipments/confirm", { shipmentId: shipment.id, packingProof: proofs }));
  const body = { shipmentId: shipment.id, resolution: "refund", damagedItemStockIds: ["moved-fish"], refundAmount: 20,
    proof: ["/uploads/actual-damage.jpg"], notes: "actual damage" };
  const before = await s.readPersistedState();
  ownerDenied(await s.post("/api/shipments/damage", body));
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.post("/api/shipments/damage", body, "owner"));
  assert.equal((await s.order()).status, "damaged");
});

test("pending transfer retains the effective owner; after acceptance stale business writes by the former owner fail", async t => {
  const s = await setup(t); const original = await s.order();
  const assignment = await s.edit({ contactPersonnelId: "pricing-editor", contactPerson: "价格测试editor",
    expectedContactPersonnelId: OWNER_ID, expectedOwnerAssignmentRequestId: "" }, "owner"); ok(assignment);
  assert.equal(assignment.body.order.contactPersonnelId, OWNER_ID);
  ownerDenied(await s.edit({ notes: "recipient cannot edit before accepting" }));
  ownerDenied(await s.mark(true));
  ok(await s.edit({ notes: "effective owner can still edit" }, "owner"));
  ok(await s.post("/api/orders/owner-assignment/decision", { orderId: ORDER_ID,
    requestId: assignment.body.order.ownerAssignment.requestId, decision: "accept" }));
  assert.equal((await s.order()).contactPersonnelId, "pricing-editor");
  const before = await s.readPersistedState();
  ownerDenied(await s.edit({ notes: "stale old owner" }, "owner", original));
  ownerDenied(await s.post("/api/state/patch", { basePatch: { orders: [original] }, patch: {
    orders: [{ ...original, notes: "stale generic old owner" }],
  } }, "owner"));
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.edit({ notes: "new effective owner" }));
});

test("legacy unique owner name works; missing owner and obsolete owner ID never fall back to the registrant", async t => {
  for (const [name, ownerFields, actor, expected] of [
    ["unique legacy name", { contactPersonnelId: "", contactPerson: "订单负责人" }, "owner", 200],
    ["missing owner", { contactPersonnelId: "", contactPerson: "", createdBy: "pricing-editor" }, "coworker", 403],
    ["obsolete explicit ID", { contactPersonnelId: "removed-person", contactPerson: "价格测试editor", createdBy: "pricing-editor" }, "coworker", 403],
  ]) await t.test(name, async sub => {
    const s = await setup(sub, state => Object.assign(state.orders[0], ownerFields));
    const before = await s.readPersistedState(); const result = await s.mark(true, actor);
    if (expected === 200) ok(result);
    else { ownerDenied(result); assert.deepEqual(await s.readPersistedState(), before); ok(await s.mark(true, "admin")); }
  });
});

test("finance may verify another owner's money, but legacy staff finance flags grant no financial authority", async t => {
  const s = await setup(t, state => {
    state.personnel.find(person => person.id === "pricing-editor").permissions.finance = { create: true, update: true, delete: true };
    state.orders[0].payments = [{ id: "pending-money", type: "balance", amount: 50, time: "2026-11-28T09:00:00+08:00",
      channel: "cash", account: "synthetic-account", verificationStatus: "pending", recordSource: "finance" }];
  });
  const before = await s.readPersistedState();
  denied(await s.post("/api/orders/payment", { orderId: ORDER_ID, action: "verify", paymentId: "pending-money" }));
  assert.deepEqual(await s.readPersistedState(), before);
  denied(await s.edit({ notes: "finance cannot edit order terms" }, "finance"));
  ok(await s.post("/api/orders/payment", { orderId: ORDER_ID, action: "verify", paymentId: "pending-money" }, "finance"));
  const after = await s.order(); assert.equal(after.payments[0].verifiedBy, "boundary-finance");
  assert.deepEqual(after.items, before.orders[0].items); assert.equal(after.contactPersonnelId, OWNER_ID);
});

test("generic saves cannot forge payment verification or bypass dedicated order completion and cancellation", async t => {
  const s = await setup(t);
  // Normalize the legacy source so the assertions exercise the intended guards.
  ok(await s.edit({}, "owner"));
  const before = await s.readPersistedState();
  const patch = changes => ({ basePatch: { orders: before.orders }, patch: {
    orders: before.orders.map(order => order.id === ORDER_ID ? { ...order, ...changes } : order),
  } });
  const payment = { id: "forged-verified-payment", type: "balance", amount: 50, time: "2026-11-28T09:00:00+08:00",
    channel: "cash", account: "synthetic-account", verificationStatus: "verified", verifiedBy: "boundary-finance" };
  for (const role of ["owner", "admin"]) {
    const result = await s.post("/api/state/patch", patch({ payments: [payment] }), role);
    assert.equal(result.response.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, "PAYMENT_CORRECTION_DEDICATED_REQUIRED");
    assert.deepEqual(await s.readPersistedState(), before);
  }
  for (const status of ["completed", "cancelled"]) {
    ownerDenied(await s.post("/api/state/patch", patch({ status })));
    const result = await s.post("/api/state/patch", patch({ status }), "owner");
    denied(result);
    if (status === "completed") assert.equal(result.body.code, "ORDER_COMPLETION_DEDICATED_REQUIRED");
    assert.deepEqual(await s.readPersistedState(), before);
  }
});

test("generic order and logistics writes recheck current account permissions rather than a warm authentication cache", async t => {
  for (const kind of ["orders", "shipments"]) await t.test(kind, async sub => {
    const s = await setup(sub); if (kind === "shipments") await s.outbound();
    // Warm the signed-in account cache before its module permission is revoked.
    ok(await s.get("/api/state"));
    await s.patchTestPersonnel("pricing-editor", { permissions: {} });
    const before = await s.readPersistedState();
    const next = kind === "orders" ? before.orders.map(item => item.id === "coworker-order" ? { ...item, notes: "after revoke" } : item)
      : before.shipments.map(item => ({ ...item, trackingNo: "after-revoke" }));
    denied(await s.post("/api/state/patch", { basePatch: { [kind]: before[kind] }, patch: { [kind]: next } }));
    assert.deepEqual(await s.readPersistedState(), before);
  });
});
