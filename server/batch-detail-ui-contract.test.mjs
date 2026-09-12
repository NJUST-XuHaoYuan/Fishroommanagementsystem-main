import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const batches = await readFile(new URL("../src/app/components/BatchesView.tsx", import.meta.url), "utf8");
const details = await readFile(new URL("../src/app/components/BatchDetailsView.tsx", import.meta.url), "utf8");
const info = await readFile(new URL("../src/app/components/BatchInfoSection.tsx", import.meta.url), "utf8");

test("the batch list has one detail entry and non-wrapping overflow actions", () => {
  assert.match(batches, /inline-flex min-w-30 flex-nowrap/);
  assert.match(batches, />查看详情<\/Button>/);
  assert.match(batches, /aria-label=\{`更多批次操作/);
  assert.match(batches, /DropdownMenuItem[^\n]*编辑批次/);
  assert.match(batches, /DropdownMenuItem[^\n]*删除批次/);
  assert.doesNotMatch(batches, /setDetail\(|>批次资料<\/Button>|>批次明细<\/Button>/);
});

test("batch facts and fish records live in the same page without suppressing the edit dialog", () => {
  assert.match(batches, /batchInfo=\{selectedBatch && <BatchInfoSection/);
  assert.match(details, /\{batchInfo\}/);
  assert.match(info, /费用、数量、凭证与备注/);
  assert.match(info, /报损凭证/);
  assert.match(batches, /<Dialog open=\{open\}/);
  assert.doesNotMatch(batches, /return <BatchDetailsView/);
});

test("both fish and timeline order links open a local dialog without a module navigation prop", () => {
  assert.match(details, /const onOpenOrder: OpenOrder = orderId => setOrderRequest\(\{ batchId, siteId, orderId \}\)/);
  assert.match(details, /<BatchOrderDialog request=\{orderRequest\}/);
  assert.doesNotMatch(batches, /onOpenOrder/);
  assert.doesNotMatch(details, /requestOpenOrder|setActiveSiteId|<OrdersView/);
});

test("tank drilldown uses server-wide groups with independent tank-filtered fish pagination", () => {
  assert.match(details, /data\?\.tanks \?\? \[\]/);
  assert.match(details, /new URLSearchParams\(\{ batchId, siteId, search, status, tankKey, page:/);
  assert.match(details, /aria-label="明细查看方式"/);
  assert.match(details, /aria-pressed=\{viewMode === "tanks"\}/);
  assert.match(details, /setTankKey\(tank\.key\); setPage\(1\)/);
  assert.match(details, /不代表出库或死亡发生地/);
  assert.doesNotMatch(details, /data\.items\.(reduce|sort)\(/);
});
