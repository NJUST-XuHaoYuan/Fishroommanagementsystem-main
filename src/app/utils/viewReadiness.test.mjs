import assert from "node:assert/strict";
import test from "node:test";
import { isViewStateReady } from "./viewReadiness.ts";

test("first batch-to-order navigation waits for the orders response before mounting", () => {
  let loaded = { view: "batches", userKey: "admin|admin" };
  assert.equal(isViewStateReady(loaded, "batches", "admin|admin"), true);
  // The view changes synchronously, before a loading effect can run. An order
  // component must not receive the previous page's empty orders in this frame.
  assert.equal(isViewStateReady(loaded, "orders", "admin|admin"), false);
  loaded = { view: "orders", userKey: "admin|admin" };
  assert.equal(isViewStateReady(loaded, "orders", "admin|admin"), true);
  assert.equal(isViewStateReady(loaded, "batches", "admin|admin"), false);
});

test("zero-data pages become ready only after their own completion is recorded", () => {
  assert.equal(isViewStateReady({ view: "orders", userKey: "u" }, "profile", "u"), false);
  assert.equal(isViewStateReady({ view: "profile", userKey: "u" }, "profile", "u"), true);
  assert.equal(isViewStateReady({ view: "notifications", userKey: "u" }, "notifications", "u"), true);
});

test("switching identities or logging out cannot reuse a completed page", () => {
  const loaded = { view: "orders", userKey: "admin|admin" };
  assert.equal(isViewStateReady(loaded, "orders", "staff|staff|nanjing"), false);
  assert.equal(isViewStateReady(loaded, "orders", ""), false);
  assert.equal(isViewStateReady(null, "orders", "admin|admin"), false);
});
