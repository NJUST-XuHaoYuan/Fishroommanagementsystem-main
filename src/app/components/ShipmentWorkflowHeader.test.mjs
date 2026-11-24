import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, Header;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ ShipmentWorkflowHeader: Header } = await server.ssrLoadModule("/src/app/components/ShipmentWorkflowHeader.tsx"));
});
after(async () => { await server?.close(); });
const order = { id: "order", status: "shipped", source: "私域线上", shippingFeeMode: "prepaid", shippingSettlementTiming: "before_shipping" };
const shipment = { id: "shipment", orderId: "order", status: "shipped", shipMethod: "express", carrier: "顺丰", trackingNo: "SF123", shipDate: "2026-11-25", shippedAt: "2026-11-25T01:02:00Z", actualShippingFee: 36, packingProof: ["photo-a", "", "photo-b"] };
const correction = { version: 1, shippingTimeStatus: "known", actualShippedAt: "2026-11-25T09:02:00", receiptStatus: "received", actualDeliveredAt: "2026-11-25T11:00:00", reason: "核对记录", updatedAt: "2026-11-25", operator: "admin" };
const noop = () => {};
const render = (shipmentPatch = {}, props = {}) => renderToStaticMarkup(createElement(Header, { order, shipment: { ...shipment, ...shipmentPatch }, number: 1, itemCount: 2, statusBadge: createElement("span", null, "状态展示"), onProgress: noop, onEditFee: noop, onViewProof: noop, onCorrect: noop, onCancel: noop, ...props }));
const button = (html, name) => (html.match(/<button\b[\s\S]*?<\/button>/g) || []).find(value => value.includes(name));

test("transport facts and the normal next action are separate from optional records", () => {
  const html = render();
  for (const text of ["登记收货结果", "运单号 SF123", "登记发货：2026-11-25 09:02", "实际运费", "¥36.00", "打包照片", "2 张", "查看照片"]) assert.ok(html.includes(text), text);
  assert.match(html, /<details[^>]*>/); assert.doesNotMatch(html, /<details[^>]*\bopen/);
  assert.ok(html.indexOf("更正发货与签收时间") > html.indexOf("<details"));
  assert.ok(html.indexOf("取消发货") > html.indexOf("<details"));
  assert.ok(button(html, "登记收货结果"));
});

test("outbound asks for packing photos and dispatch while delivered has no progress action", () => {
  const outbound = render({ status: "outbound", createdAt: "2026-11-24T18:20:00", packingProof: [] });
  assert.ok(button(outbound, "上传照片并发货")); assert.ok(button(outbound, "取消出库"));
  assert.match(outbound, /登记出库：2026-11-24 18:20/); assert.match(outbound, /至少 2 张/);
  assert.doesNotMatch(render({ status: "delivered" }), /登记收货结果|上传照片并发货|取消发货/);
});

test("unknown freight and explicitly recorded zero remain different", () => {
  const unknown = render({ actualShippingFee: 0, actualShippingFeeRecordedAt: undefined });
  assert.match(unknown, /待补录/); assert.ok(button(unknown, "补录运费")); assert.doesNotMatch(unknown, /¥0\.00/);
  const zero = render({ actualShippingFee: 0, actualShippingFeeRecordedAt: "2026-11-25T11:00:00" });
  assert.match(zero, /¥0\.00/); assert.ok(button(zero, "修改运费")); assert.doesNotMatch(zero, /待补录/);
});

test("pickup and collect never offer freight editing despite a supplied callback", () => {
  const pickup = render({ shipMethod: "pickup", status: "delivered", packingProof: [] });
  assert.match(pickup, /自提无需运费/); assert.match(pickup, /未上传/); assert.doesNotMatch(pickup, /修改运费|补录运费|登记收货结果|运单号|无需上传/);
  const legacyPickup = render({ shipMethod: "pickup", status: "outbound", packingProof: [] });
  assert.ok(button(legacyPickup, "上传照片并确认自提")); assert.match(legacyPickup, /至少 2 张/);
  const collect = render({}, { order: { ...order, shippingFeeMode: "collect" } });
  assert.match(collect, /到付，客户付给承运方/); assert.doesNotMatch(collect, /修改运费|补录运费/);
});

test("unknown fulfillment exposes correction without hiding shipment exceptions", () => {
  const pending = render({ fulfillmentCorrection: { ...correction, shippingTimeStatus: "unknown", actualShippedAt: undefined, receiptStatus: "unknown", actualDeliveredAt: undefined } });
  assert.match(pending, /实际发货时间、收货情况待核实/);
  assert.ok(pending.indexOf("核对发货与签收时间") < pending.indexOf("<details"));
  assert.doesNotMatch(button(pending, "登记收货结果"), /disabled=""/);
  assert.match(pending, /原登记发货/);
  const outbound = render({ status: "outbound", fulfillmentCorrection: { ...correction, shippingTimeStatus: "unknown", actualShippedAt: undefined } });
  assert.match(button(outbound, "上传照片并发货"), /disabled=""/);
  assert.match(outbound, /后再确认发货/);
});

test("known nonreceipt is not called an unknown fact, and ordinary staff are directed to an admin", () => {
  const notReceived = render({ fulfillmentCorrection: { ...correction, receiptStatus: "not_received", actualDeliveredAt: undefined } }, { onCorrect: undefined, onCancel: undefined });
  assert.match(notReceived, /已核对：客户尚未收到/); assert.match(notReceived, /客户收到后，请联系管理员更新核对记录/);
  assert.doesNotMatch(notReceived, /待核实|核对发货与签收时间|更多操作/);
});

test("closed orders and absent capabilities do not gain mutation controls", () => {
  for (const status of ["completed", "cancelled"]) {
    const html = render({}, { order: { ...order, status } });
    assert.doesNotMatch(html, /登记收货结果|修改运费|补录运费|取消发货/);
    assert.ok(button(html, "更正发货与签收时间")); assert.ok(button(html, "查看照片"));
  }
  const readOnly = render({}, { onProgress: undefined, onEditFee: undefined, onViewProof: undefined, onCorrect: undefined, onCancel: undefined });
  assert.doesNotMatch(readOnly, /<button|<details/); assert.match(readOnly, /¥36\.00/);
});
