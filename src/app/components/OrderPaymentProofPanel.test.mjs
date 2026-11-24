import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite, Panel, Feedback;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ OrderPaymentProofPanel: Panel, PaymentProofSubmissionFeedback: Feedback } = await vite.ssrLoadModule("/src/app/components/OrderPaymentProofPanel.tsx"));
});
after(async () => { await vite?.close(); });
const render = props => renderToStaticMarkup(createElement(Feedback, props));

test("submission errors announce failed submission and expose each field correction", () => {
  const markup = render({ issues: [{ field: "paymentMethodId", message: "请选择付款方式与收款账户。" }, { field: "attachments", message: "请上传付款图片。" }], onFocusField() {} });
  assert.match(markup, /role="alert"/); assert.match(markup, /本次付款尚未提交/);
  assert.match(markup, /请选择付款方式与收款账户/); assert.match(markup, /请上传付款图片/);
  assert.equal((markup.match(/<button /g) || []).length, 2);
  assert.doesNotMatch(markup, /role="status"/);
});

test("server rejection is visible in the same submission summary", () => {
  const markup = render({ error: "同一张付款凭证已提交，请勿重复登记" });
  assert.match(markup, /role="alert"/); assert.match(markup, /同一张付款凭证已提交/);
  assert.doesNotMatch(markup, /<button/);
});

test("successful submission announces exact submitted amount as pending verification", () => {
  const markup = render({ submittedAmount: 126.5 });
  assert.match(markup, /role="status" aria-live="polite"/);
  assert.match(markup, /已提交 ¥126\.50，等待财务核验/);
  assert.doesNotMatch(markup, /role="alert"|核验通过|确认到账/);
  assert.equal(render({}), "");
});

test("cashier proof panel imports and renders its safe loading state without private data", () => {
  const markup = renderToStaticMarkup(createElement(Panel, { orderId: "synthetic-order", presentation: "cashier" }));
  assert.match(markup, /收款登记与凭证核验/); assert.match(markup, /正在加载付款凭证/);
  assert.doesNotMatch(markup, /已提交 ¥|<input|付款图片凭证/);
});
