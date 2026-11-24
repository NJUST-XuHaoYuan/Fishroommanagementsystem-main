import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite, shared, cashier, orders;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  shared = await vite.ssrLoadModule("/src/app/utils/shippingSettlement.ts");
  cashier = await vite.ssrLoadModule("/src/app/components/OrderCashierPanel.tsx");
  orders = await vite.ssrLoadModule("/src/app/components/OrdersView.tsx");
});
after(async () => { await vite?.close(); });

const order = { id: "synthetic-order", status: "shipped", source: "私域线上", shippingFeeMode: "prepaid", shippingSettlementTiming: "before_shipping", shippingFee: 50,
  items: [{ stockItemId: "synthetic-fish", price: 70 }], packagingFee: 6, discount: 0, payments: [],
  paymentClaims: [{ id: "pending-claim", amount: 126, status: "pending", shippingAmount: 50, purpose: "order" }] };
const shipments = [{ id: "synthetic-shipment", orderId: order.id, itemStockIds: ["synthetic-fish"], status: "delivered", shipMethod: "express", actualShippingFee: 34 }];

test("pending proof permits ordinary refund registration without claiming finance confirmation", () => {
  const cash = shared.getRegisteredOrderCashSummary(order);
  assert.equal(cash.availableRefund, 126); assert.equal(cash.verifiedReceived, 0);
  const html = renderToStaticMarkup(createElement(orders.OrderRefundBalanceNotice, { cash }));
  assert.match(html, /¥126\.00/); assert.match(html, /包含待核验款项/); assert.match(html, /不影响退款登记/);
  assert.doesNotMatch(html, /未核验收款暂不计入|需先由财务确认/);
  assert.equal(orders.canRegisterOrderRefund(order, true, true), true);
});

test("126 pending receipt minus 110 final due exposes and prefills exactly 16 freight refund", () => {
  const cash = shared.getRegisteredOrderCashSummary(order);
  const freight = shared.getShippingSettlementSummary(order, shipments, 110);
  assert.equal(freight.toRefund, 16); assert.equal(freight.actualFee, 34);
  assert.equal(shared.shippingRefundDraftAmount(freight), "16");
  const html = renderToStaticMarkup(createElement(cashier.OrderCashierBalanceSummary, { order, shipments, amountDue: 110, netRecorded: cash.netRecorded }));
  assert.match(html, /应付金额（退款）/); assert.match(html, /¥16\.00/);
  assert.match(html, /财务核验进度见下方记录/);
});

test("pending refund consumes the difference and cannot be offered twice", () => {
  const refunded = { ...order, payments: [{ id: "shipping-refund", type: "refund", amount: 16, shippingAmount: 16, refundCategory: "shipping_fee", verificationStatus: "pending" }] };
  const cash = shared.getRegisteredOrderCashSummary(refunded);
  const freight = shared.getShippingSettlementSummary(refunded, shipments, 110);
  assert.equal(cash.availableRefund, 110); assert.equal(cash.verifiedRefunded, 0);
  assert.equal(freight.toRefund, 0); assert.equal(shared.shippingRefundDraftAmount(freight), "");
  const html = renderToStaticMarkup(createElement(cashier.OrderCashierBalanceSummary, { order: refunded, shipments, amountDue: 110, netRecorded: cash.netRecorded }));
  assert.match(html, /无应收应付/); assert.doesNotMatch(html, /应付金额（退款）/);
});

test("rejected and orphan approved claims cannot create a refundable balance", () => {
  for (const status of ["rejected", "approved"]) {
    const cash = shared.getRegisteredOrderCashSummary({ ...order, paymentClaims: [{ ...order.paymentClaims[0], status }] });
    assert.equal(cash.availableRefund, 0); assert.equal(cash.recordedReceived, 0);
  }
});

test("refund controls retain difference selection and preserve any already open user draft", async () => {
  const shipping = await readFile(new URL("./OrderShippingSettlementPanel.tsx", import.meta.url), "utf8");
  const choice = await readFile(new URL("./OrderCashierPanel.tsx", import.meta.url), "utf8");
  assert.match(choice, /选择退款类型/); assert.match(choice, /退运费差额 · \{currency\(freight\.toRefund\)\}/);
  assert.match(shipping, /if \(refundOpen\) \{[^]*?return; \}\s*setDraft\(\{ \.\.\.blankRefund\(\), amount: shippingRefundDraftAmount\(summary\)/);
  assert.doesNotMatch(shipping, /setDraft\([^;]*amount: (?:String\()?summary\.actualFee/);
});
