import test from "node:test";
import assert from "node:assert/strict";
import { ORDER_WHOLESALE_TAG_FIELDS, assertOrderWholesaleTagUnchanged, planOrderWholesaleTag } from "./order-wholesale-tag.mjs";

const account = { username: "editor", name: "订单员工" };
const now = "2026-11-02T09:00:00.000Z";
const request = { isWholesaleOrder: true, expectedIsWholesaleOrder: false, expectedWholesaleOrderUpdatedAt: "" };

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
