import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite, choose;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] } });
  ({ paymentProofReviewChoice: choose } = await vite.ssrLoadModule("/src/app/utils/paymentProofReviewChoice.ts"));
});
after(async () => { await vite?.close(); });
const claim = { id: "proof-1300", amount: 1300, channel: "alipay", account: "account-1" };
const receipt = { id: "receipt", type: "balance", amount: 1300, channel: "alipay", account: "account-1", time: "2026-11-27T09:31", verificationStatus: "pending" };

test("a pending 1300 voucher with no receipt is directly approvable as new", () => {
  assert.deepEqual(choose(claim, []), { eligible: [], mode: "new", value: "new" });
});
test("one matching receipt is linked automatically, never duplicated", () => {
  const result = choose(claim, [receipt], "new");
  assert.equal(result.mode, "existing"); assert.equal(result.value, receipt.id);
});
test("ambiguous receipts require an explicit valid match and disallow new", () => {
  const receipts = [receipt, { ...receipt, id: "receipt-2" }];
  for (const selected of [undefined, "new", "removed-id"]) assert.equal(choose(claim, receipts, selected).value, "");
  assert.equal(choose(claim, receipts, "receipt-2").value, "receipt-2");
  assert.equal(choose(claim, receipts).mode, "choose");
});
test("matching uses amount, receiving account, channel and incoming direction", () => {
  for (const patch of [{ amount: 1299.99 }, { channel: "wechat" }, { account: "account-2" }, { type: "refund" }]) {
    assert.equal(choose(claim, [{ ...receipt, ...patch }]).mode, "new");
  }
});
test("a designated matching receipt cannot silently change or duplicate on removal", () => {
  const linked = { ...claim, matchingPaymentId: "receipt-2" };
  assert.equal(choose(linked, [receipt]).mode, "unavailable");
  assert.equal(choose(linked, [receipt], "new").value, "");
  const result = choose(linked, [receipt, { ...receipt, id: "receipt-2" }]);
  assert.equal(result.mode, "existing"); assert.equal(result.value, "receipt-2");
});
