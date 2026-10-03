import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, LossPriceEditor, parseLossPriceInput, applyLossPricingUpdate;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ LossPriceEditor } = await server.ssrLoadModule("/src/app/components/LossPriceEditor.tsx"));
  ({ parseLossPriceInput, applyLossPricingUpdate } = await server.ssrLoadModule("/src/app/utils/lossPricing.ts"));
});
after(async () => { await server?.close(); });

const update = { id: "fish-a", basePrice: 125.65, priceMode: "manual", priceOverridden: true };
const snapshot = { basePrice: 100, priceMode: "product", priceOverridden: false };
const render = (overrides = {}) => renderToStaticMarkup(createElement(LossPriceEditor, {
  stockItemId: "fish-a", label: "黄金吊（189）", value: 100, pricingSnapshot: snapshot, canEdit: true,
  onSaved() {}, async onRefresh() {}, ...overrides,
}));

test("lost fish offers a specific accessible inline price action without adding a new value field", () => {
  const markup = render();
  assert.match(markup, /¥100\.00/);
  assert.match(markup, /修改黄金吊（189）的售价/);
  assert.match(markup, /修改售价/);
  assert.doesNotMatch(markup, /<input|role="dialog"/);
  assert.doesNotMatch(render({ canEdit: false }), /<button/);
  assert.doesNotMatch(render({ pricingSnapshot: undefined }), /<button/);
  assert.match(render({ isPriceMissing: true, value: 0 }), /未定价/);
  assert.doesNotMatch(render({ isPriceMissing: true, value: 0 }), /¥0\.00/);
});

test("price entry preserves exact cents and rejects empty, zero, negative, overprecision and exponential forms", () => {
  for (const [input, expected] of [["0.01",0.01],[" 300 ",300],["125.65",125.65],["0001.2",1.2]]) assert.equal(parseLossPriceInput(input), expected);
  for (const input of [""," ","0","0.00","-1","1.234","1e3","NaN","Infinity","1,000","1.","9007199254740992","90071992547409.91"]) assert.throws(() => parseLossPriceInput(input), undefined, input);
});

test("saving a price updates matching detail and daily total but no quantities, dates, site or order amounts", () => {
  const point = { date:"2026-10-03", lostCount:2, stockBase:40, lossRate:5, estimatedValue:150, orderAmount:999,
    lossDetails:[{ stockItemId:"fish-a", estimatedValue:100, pricingSnapshot:snapshot, siteName:"南京", canEditPrice:true },
      { stockItemId:"fish-b", estimatedValue:50, siteName:"江阴" }], batchArrivals:[{id:"batch"}] };
  const original = structuredClone(point);
  const result = applyLossPricingUpdate(point,update);
  assert.equal(result.estimatedValue,175.65);
  assert.equal(result.lossDetails[0].estimatedValue,125.65);
  assert.equal(result.lossDetails[0].isPriceMissing,false);
  assert.deepEqual(result.lossDetails[0].pricingSnapshot,{basePrice:125.65,priceMode:"manual",priceOverridden:true});
  for (const key of ["date","lostCount","stockBase","lossRate","orderAmount","batchArrivals"]) assert.deepEqual(result[key],point[key]);
  assert.equal(result.lossDetails[0].siteName,"南京");
  assert.equal(result.lossDetails[1],point.lossDetails[1]);
  assert.deepEqual(point,original);
  assert.equal(applyLossPricingUpdate(point,{...update,id:"missing"}),point);
});

test("editor freezes the original snapshot, avoids double submission and keeps conflicts explicit", async () => {
  const source = await readFile(new URL("./LossPriceEditor.tsx",import.meta.url),"utf8");
  assert.match(source,/baseline\.current = \{ \.\.\.pricingSnapshot \}/);
  assert.match(source,/expectedPricing: baseline\.current/);
  assert.match(source,/if \(inFlight\.current \|\| !baseline\.current\) return/);
  assert.match(source,/setConflict\(response\.status === 409\)/);
  assert.match(source,/disabled=\{busy \|\| conflict\}/);
  assert.match(source,/刷新当前明细/);
  assert.match(source,/role="alert"/);
  assert.match(source,/\/api\/stock\/loss-price/);
  assert.doesNotMatch(source,/\/api\/state|\/api\/orders/);
});

test("dashboard merges both chart and open details after success and leaves the dialog open", async () => {
  const source = await readFile(new URL("./Dashboard.tsx",import.meta.url),"utf8");
  const handler = source.slice(source.indexOf("const applySavedLossPrice"),source.indexOf("const refreshLossDetails"));
  assert.match(handler,/setSummary/); assert.match(handler,/setSelectedLossPoint/); assert.match(handler,/applyLossPricingUpdate/);
  assert.doesNotMatch(handler,/setSelectedLossPoint\(null\)|saveStateTransform|summaryRetry/);
  assert.match(source,/requestedScope !== lossScope\.current/);
  assert.match(source,/不修改商品默认价、历史订单金额或提成/);
});
