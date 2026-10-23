import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, orders;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  orders = await server.ssrLoadModule("/src/app/components/OrdersView.tsx");
});
after(async () => { await server?.close(); });

function renderFeeFields(overrides = {}) {
  return renderToStaticMarkup(createElement(orders.ShipmentActualShippingFeeFields, {
    mode: "free", pending: true, value: 0, error: "", saving: false, disabled: false, saved: false,
    onChange() {}, onSave() {}, ...overrides,
  }));
}

test("pending prepaid and free fees are labeled as unknown, independently saved and not required for delivery", () => {
  for (const mode of ["prepaid", "free"]) {
    const html = renderFeeFields({ mode });
    assert.match(html, new RegExp(`${mode === "free" ? "包邮" : "寄付"}实际运费`));
    assert.match(html, /待补运费/);
    assert.match(html, /保存实际运费/);
    assert.match(html, /完成订单前必须补齐/);
    assert.match(html, /与打包凭证、发货和签收互不影响/);
    assert.match(html, /value=""/);
    assert.doesNotMatch(html, /required=""/);
    assert.match(html, /for="shipment-actual-shipping-fee"/);
    assert.match(html, /id="shipment-actual-shipping-fee"/);
    assert.match(html, /aria-describedby="shipment-actual-shipping-fee-hint"/);
    assert.match(html, /min-h-11/);
    assert.match(html, /flex-col.*sm:flex-row/);
  }
});

test("fee fields announce inline failures, preserve values, and disable duplicate saves while pending", () => {
  const html = renderFeeFields({ value: 58.005, error: "金额最多保留两位小数" });
  assert.match(html, /value="58.005"/);
  assert.match(html, /aria-invalid="true"/);
  assert.match(html, /aria-describedby="shipment-actual-shipping-fee-hint shipment-actual-shipping-fee-error"/);
  assert.match(html, /id="shipment-actual-shipping-fee-error" role="alert"/);
  assert.match(html, /金额最多保留两位小数/);
  const saving = renderFeeFields({ saving: true, disabled: true });
  assert.match(saving, /保存运费中…/);
  assert.equal((saving.match(/disabled=""/g) ?? []).length, 2);
  const saved = renderFeeFields({ value: 58.01, pending: false, saved: true });
  assert.match(saved, /role="status"/);
  assert.match(saved, /实际运费已保存/);
  assert.match(saved, /更新实际运费/);
  assert.doesNotMatch(saved, /待补运费/);
});

test("outbound never pre-fills an estimate or records it as an actual charge", async () => {
  const source = await readFile(new URL("./ShipDialog.tsx", import.meta.url), "utf8");
  assert.match(source, /actualShippingFee: 0/);
  assert.doesNotMatch(source, /setActualShippingFee|normalizedPositiveShippingFee|ship-actual-shipping-fee|order\.shippingFee/);
  assert.match(source, /出库无需填写实际运费/);
});

test("order workflow independently saves during outbound and after receipt, only completion checks pending fees", async () => {
  const source = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  const dialog = source.slice(source.indexOf("function ShipmentActionDialog("), source.indexOf("function ReportDamageDialog("));
  assert.equal((dialog.match(/\{actualShippingFeeFields\}/g) ?? []).length, 2);
  assert.match(dialog, /canEditShipmentActualShippingFee\(shipment, shippingFeeMode, order\?\.status\)/);
  assert.match(dialog, /shippingFeeSaveLock\.current/);
  assert.doesNotMatch(dialog, /disabled=\{actionLocked \|\| shippingFeePending\}/);
  assert.match(dialog, /shipment\.status === "shipped" && editableOrder/);
  const deliver = source.slice(source.indexOf("const markShipmentDelivered ="), source.indexOf("const saveShipmentActualShippingFee ="));
  assert.doesNotMatch(deliver, /shipmentHasPendingActualShippingFee/);
  assert.match(deliver, /permission\.requirePermission\("update"\)/);
  const complete = source.slice(source.indexOf("const completeOrder ="), source.indexOf("const markShipmentDelivered ="));
  assert.match(complete, /if \(pendingActualShippingFee\)/);
  assert.match(complete, /不能完成订单/);
  assert.match(source, /onShipmentAction=\{permission\.canUpdate && !\["completed", "cancelled"\]\.includes\(order\.status\)/);
  assert.match(source, /onShipmentAction && canEditShipmentActualShippingFee\(sh, orderShippingFeeMode\(order\), order\.status\)/);
  assert.match(source, /postOrderApi\("shipments\/actual-shipping-fee", payload\)/);
  assert.match(source, /请关闭窗口并刷新后核对再保存/);
  assert.doesNotMatch(source, /确认收货前必须先补录实际运费|笔寄付实际运费未补录/);
});

test("legacy shipment information and actual charges are independently saved, and zero fee no longer blocks receipt", async () => {
  const source = await readFile(new URL("./ShipmentsView.tsx", import.meta.url), "utf8");
  assert.match(source, /const updated: Partial<Shipment> = feeOnly \? \{ actualShippingFee: normalizedActualFee! \} :/);
  assert.match(source, /单独保存实际运费/);
  assert.match(source, /保存物流信息/);
  assert.match(source, /actualShippingFee: 0/);
  const deliver = source.slice(source.indexOf("const doMarkDelivered ="), source.indexOf("const doEditShipment ="));
  assert.doesNotMatch(deliver, /shipmentHasPendingActualShippingFee/);
  assert.match(source, /postShipmentApi\("shipments\/actual-shipping-fee", feePayload\)/);
  assert.match(source, /canEditShipmentActualShippingFee\(shipment, shippingFeeMode, order\?\.status\)/);
});

test("exported shipment actual-fee cells distinguish pending from recorded amounts for every active stage", async () => {
  const orderRows = [];
  const shipments = [];
  for (const mode of ["prepaid", "free", "collect"]) {
    for (const status of ["outbound", "shipped", "delivered", "damaged"]) {
      for (const actualShippingFee of [undefined, 0, 23.45]) {
        const id = `${mode}-${status}-${actualShippingFee}`;
        orderRows.push({ id, orderNo: id, source: "私域线上", date: "2026-10-23", status: "confirmed", customerId: "", items: [], payments: [], shippingFeeMode: mode, shippingFee: 50 });
        shipments.push({ id: `shipment-${id}`, orderId: id, shipMethod: "express", shipDate: "2026-10-23", status, actualShippingFee, itemStockIds: [] });
      }
    }
  }
  const pickup = { id: "pickup", orderNo: "pickup", source: "线下自提", date: "2026-10-23", status: "confirmed", customerId: "", items: [], payments: [], shippingFeeMode: "prepaid", shippingFee: 0 };
  orderRows.push(pickup);
  shipments.push({ id: "shipment-pickup", orderId: pickup.id, shipMethod: "pickup", shipDate: "2026-10-23", status: "delivered", actualShippingFee: 0, itemStockIds: [] });
  const savedDocument = globalThis.document;
  const savedCreateObjectURL = URL.createObjectURL;
  const savedRevokeObjectURL = URL.revokeObjectURL;
  let exportedBlob;
  try {
    globalThis.document = { body: { appendChild() {} }, createElement() { return { click() {}, remove() {} }; } };
    URL.createObjectURL = (blob) => { exportedBlob = blob; return "blob:test-export"; };
    URL.revokeObjectURL = () => {};
    orders.exportOrdersExcel(orderRows, { customers: [], products: [], stock: [], batches: [], tankGroups: [], shipments });
    assert.ok(exportedBlob instanceof Blob);
    const html = await exportedBlob.text();
    const shippingTable = html.match(/<table>\s*<tr><td class="section" colspan="13">发货信息<\/td><\/tr>[\s\S]*?<\/table>/)?.[0];
    assert.ok(shippingTable, "inspect the real 发货信息 table, not the order totals table");
    const cellsByOrder = new Map([...shippingTable.matchAll(/<tr>((?:<td class="text">[\s\S]*?<\/td>)+)<\/tr>/g)].map((match) => {
      const cells = [...match[1].matchAll(/<td class="text">([\s\S]*?)<\/td>/g)].map((cell) => cell[1]);
      return [cells[0], cells];
    }));
    assert.equal(cellsByOrder.size, orderRows.length);
    for (const order of orderRows) {
      const shipment = shipments.find((item) => item.orderId === order.id);
      const expectedPending = order.shippingFeeMode !== "collect" && shipment.shipMethod !== "pickup" && !(shipment.actualShippingFee > 0);
      const actualFeeCell = cellsByOrder.get(order.orderNo)[9];
      if (expectedPending) assert.equal(actualFeeCell, "待补运费", order.orderNo);
      else {
        assert.notEqual(actualFeeCell, "待补运费", order.orderNo);
        assert.match(actualFeeCell, shipment.actualShippingFee > 0 ? /23\.45/ : /0\.00/, order.orderNo);
      }
    }
  } finally {
    if (savedDocument === undefined) delete globalThis.document;
    else globalThis.document = savedDocument;
    URL.createObjectURL = savedCreateObjectURL;
    URL.revokeObjectURL = savedRevokeObjectURL;
  }
});
