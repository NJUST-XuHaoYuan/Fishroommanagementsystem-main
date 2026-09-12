import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const detailsSource = await readFile(new URL("../src/app/components/BatchDetailsView.tsx", import.meta.url), "utf8");
const dialogSource = await readFile(new URL("../src/app/components/BatchOrderDialog.tsx", import.meta.url), "utf8");

test("batch pagination reserves bottom and right space for the floating assistant button", () => {
  // Browser QA verified this reservation at desktop and 390px mobile widths.
  // Guard both axes so the final Next button does not slip under the assistant.
  assert.match(detailsSource, /return <section className="[^"]*\bpb-20\b[^"]*"/);
  assert.match(detailsSource, /<nav aria-label="鱼只明细分页" className="[^"]*\bpr-16\b[^"]*"/);
});

test("batch orders open locally and restore a still-authorized connected opener without scrolling", () => {
  assert.match(detailsSource, /setOrderRequest\(\{ batchId, siteId, orderId \}\)/);
  assert.match(detailsSource, /<BatchOrderDialog request=\{orderRequest\}/);
  assert.doesNotMatch(detailsSource, /requestOpenOrder|setActiveSiteId/);
  assert.match(dialogSource, /onCloseAutoFocus=\{event =>/);
  assert.match(dialogSource, /shouldRestoreBatchOrderFocus\(request, openingContext\.current, currentContext\.current, target\.isConnected\)/);
  assert.match(dialogSource, /target\.focus\(\{ preventScroll: true \}\)/);
});
