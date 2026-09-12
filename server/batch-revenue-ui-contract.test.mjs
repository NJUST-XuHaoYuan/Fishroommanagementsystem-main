import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSource = await readFile(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const batchesSource = await readFile(new URL("../src/app/components/BatchesView.tsx", import.meta.url), "utf8");
const infoSource = await readFile(new URL("../src/app/components/BatchInfoSection.tsx", import.meta.url), "utf8");
const tableSource = await readFile(new URL("../src/app/components/common.tsx", import.meta.url), "utf8");

test("batch page loads aggregate metrics instead of complete order payment records", () => {
  assert.match(appSource, /batches:\s*\["batches"\]/);
  assert.doesNotMatch(appSource, /batches:\s*\[[^\]]*"orders"/);
  assert.doesNotMatch(appSource, /batches:\s*\[[^\]]*"shipments"/);
  assert.match(
    batchesSource,
    /fetch\(`\/api\/batches\/revenue-metrics\?siteId=\$\{encodeURIComponent\(activeSiteId\)\}`/
  );
  assert.match(batchesSource, /headers:\s*authJsonHeaders\(\)/);
  assert.doesNotMatch(batchesSource, /state\.(orders|shipments)/);
  assert.doesNotMatch(batchesSource, /state\.stock/);
});

test("batch page presents all three named metrics and never falls back to zero while loading fails", () => {
  for (const label of ["销售净额", "待核销回款", "已核销回款"]) {
    assert.match(batchesSource, new RegExp(label));
  }
  assert.match(batchesSource, /if \(!revenueAvailable\) return "—"/);
  assert.match(infoSource, /回款加载失败，金额暂不展示/);
  assert.match(infoSource, /revenue \? batchPrice\(revenue\.salesNet\) : "—"/);
  assert.match(infoSource, /\{revenue && <div/);
  assert.match(batchesSource, /window\.setInterval/);
  assert.match(batchesSource, /visibilitychange/);
  assert.match(batchesSource, /window\.addEventListener\("focus", refresh\)/);
  assert.match(batchesSource, /平台收入计入已核销回款（不扣平台费用）/);
  assert.doesNotMatch(batchesSource, /批次实收金额|实收金额\(¥\)/);
});

test("batch cards use the compact mobile renderer", () => {
  assert.match(tableSource, /mobileRender\?: \(row: T\) => ReactNode/);
  assert.match(tableSource, /mobileRender \? mobileRender\(row\)/);
  assert.match(batchesSource, /mobileRender=\{\(row\) =>/);
  assert.match(batchesSource, /pendingIsRefund \? "待核销退款" : "待核销回款"/);
});
