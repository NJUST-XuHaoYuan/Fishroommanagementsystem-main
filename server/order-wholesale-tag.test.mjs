import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_WHOLESALE_TAG_FIELDS, assertOrderWholesaleTagUnchanged, initializeCreatedOrderWholesaleTag, planOrderWholesaleTag, synchronizeUpdatedOrderWholesaleTag } from "./order-wholesale-tag.mjs";

const account = { username: "editor", name: "订单员工" };
const now = "2026-11-02T09:00:00.000Z";
const request = { isWholesaleOrder: true, expectedIsWholesaleOrder: false, expectedWholesaleOrderUpdatedAt: "" };

test("creation derives classification from source and always generates audit metadata on the server", () => {
  const order = { id: "new-order", source: "批发", items: [{ price: 100 }], payments: [] };
  const forged = { wholesaleOrderUpdatedAt: "1900-01-01", wholesaleOrderUpdatedBy: "admin", wholesaleOrderUpdatedByName: "forged" };
  const marked = {
    ...order, isWholesaleOrder: true, wholesaleOrderUpdatedAt: now,
    wholesaleOrderUpdatedBy: "editor", wholesaleOrderUpdatedByName: "订单员工",
  };
  assert.deepEqual(initializeCreatedOrderWholesaleTag(order, forged, account, now), marked);
  assert.deepEqual(initializeCreatedOrderWholesaleTag(order, { ...forged, isWholesaleOrder: true }, account, now), marked);
  assert.throws(() => initializeCreatedOrderWholesaleTag(order, { isWholesaleOrder: false }, account, now), {
    code: "ORDER_WHOLESALE_SOURCE_CONFLICT", statusCode: 400,
  });
  for (const source of ["平台下单", "闲鱼平台", "微拍堂平台", "私域线上", "线下"]) {
    const retail = { ...order, source };
    assert.equal(initializeCreatedOrderWholesaleTag(retail, forged, account, now), retail);
    assert.equal(initializeCreatedOrderWholesaleTag(retail, { ...forged, isWholesaleOrder: false }, account, now), retail);
    assert.throws(() => initializeCreatedOrderWholesaleTag(retail, { isWholesaleOrder: true }, account, now), {
      code: "ORDER_WHOLESALE_SOURCE_CONFLICT", statusCode: 400,
    });
  }
  for (const value of ["true", "false", 0, 1, null, undefined, {}, []]) {
    assert.throws(() => initializeCreatedOrderWholesaleTag(order, { isWholesaleOrder: value }, account, now), {
      statusCode: 400, code: "ORDER_WHOLESALE_TAG_INVALID",
    });
  }
  assert.equal(order.isWholesaleOrder, undefined);
});

test("source edits synchronize classification only across wholesale, preserving historical retail-source tags", () => {
  const retail = { id: "legacy", source: "平台下单", notes: "legacy" };
  const marked = planOrderWholesaleTag(retail, request, account, now).order;
  const anotherRetail = { ...marked, source: "闲鱼平台" };
  assert.equal(synchronizeUpdatedOrderWholesaleTag(marked, anotherRetail, account, now), anotherRetail);
  const wholesale = synchronizeUpdatedOrderWholesaleTag(retail, { ...retail, source: "批发" }, account, now);
  assert.equal(wholesale.isWholesaleOrder, true);
  assert.equal(wholesale.wholesaleOrderUpdatedBy, "editor");
  assert.throws(() => planOrderWholesaleTag(wholesale, { ...request, isWholesaleOrder: false }, account, now), {
    statusCode: 409, code: "ORDER_WHOLESALE_SOURCE_PROTECTED",
  });
  const reverted = synchronizeUpdatedOrderWholesaleTag(wholesale, { ...wholesale, source: "私域线上" }, account, now);
  assert.equal(reverted.isWholesaleOrder, false);
  assert.equal(reverted.wholesaleOrderUpdatedAt, "2026-11-02T09:00:00.001Z");
  for (const [current, next] of [[retail, { ...retail, source: "批发" }], [wholesale, { ...wholesale, source: "私域线上" }]]) {
    assert.throws(() => assertOrderWholesaleTagUnchanged(current, next), { code: "ORDER_WHOLESALE_SOURCE_PROTECTED" });
  }
});

test("wholesale is explicit metadata only and uses the authenticated actor, not supplied audit fields", () => {
  const order = { id: "o1", status: "completed", payments: [{ amount: 30 }], items: [{ price: 100 }], newCustomerApproval: { status: "approved" } };
  const result = planOrderWholesaleTag(order, { ...request, wholesaleOrderUpdatedBy: "forged" }, account, now);
  assert.deepEqual(result, { unchanged: false, order: { ...order, isWholesaleOrder: true,
    wholesaleOrderUpdatedAt: now, wholesaleOrderUpdatedBy: "editor", wholesaleOrderUpdatedByName: "订单员工" } });
  assert.equal(order.isWholesaleOrder, undefined);
  assert.deepEqual(planOrderWholesaleTag(result.order, request, account, now), { unchanged: true, order: result.order });
});

test("wholesale payload and expected flags reject non-booleans instead of coercing truthiness", () => {
  for (const value of ["true", "false", 0, 1, null, undefined, {}, []]) {
    assert.throws(() => planOrderWholesaleTag({}, { ...request, isWholesaleOrder: value }, account, now), { statusCode: 400 });
    assert.throws(() => planOrderWholesaleTag({}, { ...request, expectedIsWholesaleOrder: value }, account, now), { statusCode: 409 });
  }
  for (const body of [null, [], "true"]) assert.throws(() => planOrderWholesaleTag({}, body, account, now), { statusCode: 400 });
  for (const value of [null, 0, undefined, "x".repeat(101)]) {
    assert.throws(() => planOrderWholesaleTag({}, { ...request, expectedWholesaleOrderUpdatedAt: value }, account, now), { statusCode: 409 });
  }
});

test("wholesale CAS detects changed flag and ABA timestamps with monotonic writes", () => {
  const marked = planOrderWholesaleTag({}, request, account, now).order;
  const unmark = { isWholesaleOrder: false, expectedIsWholesaleOrder: true, expectedWholesaleOrderUpdatedAt: now };
  const removed = planOrderWholesaleTag(marked, unmark, account, now).order;
  assert.equal(removed.wholesaleOrderUpdatedAt, "2026-11-02T09:00:00.001Z");
  assert.throws(() => planOrderWholesaleTag(removed, request, account, now), { statusCode: 409, code: "ORDER_WHOLESALE_TAG_CONFLICT" });
  assert.throws(() => planOrderWholesaleTag(marked, { ...unmark, expectedIsWholesaleOrder: false }, account, now), { statusCode: 409 });
});

test("ordinary state patches cannot add, remove or forge any wholesale field", () => {
  const marked = planOrderWholesaleTag({ notes: "original" }, request, account, now).order;
  assert.doesNotThrow(() => assertOrderWholesaleTagUnchanged(marked, { ...marked, notes: "changed" }));
  for (const key of ORDER_WHOLESALE_TAG_FIELDS) {
    const removed = { ...marked }; delete removed[key];
    assert.throws(() => assertOrderWholesaleTagUnchanged(marked, removed), { code: "ORDER_WHOLESALE_TAG_PROTECTED" });
    assert.throws(() => assertOrderWholesaleTagUnchanged(marked, { ...marked, [key]: "forged" }), { code: "ORDER_WHOLESALE_TAG_PROTECTED" });
  }
  assert.throws(() => assertOrderWholesaleTagUnchanged({}, { isWholesaleOrder: false }), { code: "ORDER_WHOLESALE_TAG_PROTECTED" });
});
