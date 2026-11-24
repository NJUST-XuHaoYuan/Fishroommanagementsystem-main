import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite, validate;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ validatePaymentProofDraft: validate } = await vite.ssrLoadModule("/src/app/utils/paymentProofDraftValidation.ts"));
});
after(async () => { await vite?.close(); });

const methods = ["wechat-a", "bank-b"];
const valid = { amount: "126.50", time: "2026-11-25T12:30", paymentMethodId: "wechat-a", attachments: [{ id: "image" }] };

test("empty submission identifies every required field in focus order", () => {
  const issues = validate({ amount: "", time: "", paymentMethodId: "", attachments: [] }, methods);
  assert.deepEqual(issues.map(issue => issue.field), ["amount", "time", "paymentMethodId", "attachments"]);
  assert.ok(issues.every(issue => issue.message));
});

test("uploaded picture cannot hide a missing receipt account", () => {
  const issues = validate({ ...valid, paymentMethodId: "" }, methods);
  assert.equal(issues.length, 1); assert.equal(issues[0].field, "paymentMethodId");
  assert.match(issues[0].message, /付款方式与收款账户/);
  assert.equal(validate({ ...valid, paymentMethodId: "removed-account" }, methods)[0].field, "paymentMethodId");
});

test("receipt amount validation matches server cent precision and limits", () => {
  for (const amount of ["", " ", "0", "-1", "NaN", "Infinity", "12.345", "100000000.01"]) {
    assert.equal(validate({ ...valid, amount }, methods)[0].field, "amount", amount);
  }
  for (const amount of ["0.01", "12.30", "100000000"]) assert.deepEqual(validate({ ...valid, amount }, methods), []);
});

test("invalid time and missing picture remain independently actionable", () => {
  for (const time of ["", "2026-11-25", "not a date", "2026-13-25T12:30"]) {
    assert.equal(validate({ ...valid, time }, methods)[0].field, "time");
  }
  assert.deepEqual(validate({ ...valid, attachments: [] }, methods).map(issue => issue.field), ["attachments"]);
});

test("existing allocation rejection points to amount without changing its accounting", () => {
  const message = "本次申报超过当前待收金额";
  assert.deepEqual(validate(valid, methods, message), [{ field: "amount", message }]);
  assert.deepEqual(validate(valid, methods), []);
  assert.deepEqual(valid, { amount: "126.50", time: "2026-11-25T12:30", paymentMethodId: "wechat-a", attachments: [{ id: "image" }] });
});
