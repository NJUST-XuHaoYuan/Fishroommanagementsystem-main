import assert from "node:assert/strict";
import test from "node:test";
import { paymentClaimsForOrderScope } from "./personalOrderWorkspace.ts";

function claims() {
  return {
    candidates: [
      {
        id: "statement-shared",
        amount: 200,
        externalTransactionNo: "server-transaction-1",
        candidates: [
          { orderId: "mine", orderNo: "SO-1", outstanding: 200 },
          { orderId: "other", orderNo: "SO-2", outstanding: 200 },
        ],
      },
      { id: "statement-other", amount: 300, candidates: [{ orderId: "other", outstanding: 300 }] },
      { id: "statement-unavailable", amount: 50, candidates: [{ orderId: "unavailable", outstanding: 50 }] },
    ],
    cashOrders: [
      { orderId: "mine", outstanding: 100 },
      { orderId: "other", outstanding: 200 },
      { orderId: "unavailable", outstanding: 50 },
    ],
  };
}

test("personal workspace limits admin payment candidates and cash orders to owned orders", () => {
  const result = paymentClaimsForOrderScope(claims(), new Set(["mine"]));
  assert.deepEqual(result.candidates.map(candidate => candidate.id), ["statement-shared"]);
  assert.deepEqual(result.candidates[0].candidates.map(order => order.orderId), ["mine"]);
  assert.deepEqual(result.cashOrders.map(order => order.orderId), ["mine"]);
  assert.equal(result.candidates.length + result.cashOrders.length, 2);
});

test("scoping preserves server statement identifiers, amounts and candidate metadata without mutating responses", () => {
  const source = claims();
  const before = structuredClone(source);
  const result = paymentClaimsForOrderScope(source, new Set(["mine"]));
  assert.equal(result.candidates[0].externalTransactionNo, "server-transaction-1");
  assert.equal(result.candidates[0].amount, 200);
  assert.equal(result.candidates[0].candidates[0], source.candidates[0].candidates[0]);
  assert.equal(result.cashOrders[0], source.cashOrders[0]);
  assert.deepEqual(source, before);
});

test("ordinary order management retains all original payment choices and response identity", () => {
  const source = claims();
  const result = paymentClaimsForOrderScope(source, null);
  assert.equal(result, source);
  assert.equal(result.candidates[0].candidates.length, 2);
  assert.equal(result.cashOrders.length, 3);
});

test("unresolved or changed owner identity cannot retain previous payment choices", () => {
  const source = claims();
  assert.deepEqual(paymentClaimsForOrderScope(source, new Set()), { candidates: [], cashOrders: [] });
  const changed = paymentClaimsForOrderScope(source, new Set(["other"]));
  assert.deepEqual(changed.candidates.map(candidate => candidate.id), ["statement-shared", "statement-other"]);
  assert.equal(changed.candidates.flatMap(candidate => candidate.candidates).some(order => order.orderId === "mine"), false);
});

test("unknown order references and empty candidate lists are never offered", () => {
  const source = { candidates: [{ id: "empty", candidates: [] }], cashOrders: [] };
  assert.deepEqual(paymentClaimsForOrderScope(source, new Set(["mine"])), { candidates: [], cashOrders: [] });
});
