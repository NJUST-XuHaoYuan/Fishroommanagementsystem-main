import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite, action, replacement, History;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ paymentCorrectionAction: action, paymentCorrectionNeedsReplacement: replacement } = await vite.ssrLoadModule("/src/app/utils/paymentCorrection.ts"));
  ({ PaymentCorrectionHistory: History } = await vite.ssrLoadModule("/src/app/components/PaymentCorrectionDialog.tsx"));
});
after(async () => { await vite?.close(); });

test("server capabilities are required before offering a money correction", () => {
  for (const record of [{}, { correctionMode: "void" }, { correctionMode: "replace" }, { canCorrect: true, correctionMode: "blocked" }, { canVoid: true, correctionMode: "replace" }]) assert.equal(action(record), null);
  assert.equal(action({ canVoid: true, correctionMode: "void" }), "void");
  assert.equal(action({ canCorrect: true, correctionMode: "proof_resubmit" }), "correct");
});
test("proof-backed corrections and pending voids cannot become manual replacement receipts", () => {
  for (const record of [{ canCorrect: true, correctionMode: "proof_resubmit" }, { canVoid: true, correctionMode: "void" }]) {
    assert.equal(replacement(record, "replace"), false);
    assert.equal(replacement(record, "retract"), false);
  }
});
test("verified manual receipts can be corrected or fully retracted", () => {
  const record = { canCorrect: true, correctionMode: "replace" };
  assert.equal(replacement(record, "replace"), true);
  assert.equal(replacement(record, "retract"), false);
});
test("audit history keeps original details, reason, operator and order reopen visible", () => {
  const html = renderToStaticMarkup(createElement(History, { corrections: [{ id: "correction", action: "correct", reason: "金额录入错误", operator: "财务甲", operatedAt: "2026-11-27T10:00", originalPayment: { id: "original", type: "balance", amount: 1300, time: "2026-11-26T22:47", channel: "alipay", account: "账户一", verificationStatus: "verified", notes: "原备注", externalTransactionNo: "流水号一", proof: [] }, affectedClaimIds: ["proof"], reopenedFromStatus: "completed" }] }));
  for (const expected of [/更正记录/, /¥1300.00/, /金额录入错误/, /财务甲/, /账户一/, /原备注/, /流水号一/, /已退回负责人补正/, /恢复为未完成/]) assert.match(html, expected);
  assert.equal(renderToStaticMarkup(createElement(History, { corrections: [] })), "");
});
