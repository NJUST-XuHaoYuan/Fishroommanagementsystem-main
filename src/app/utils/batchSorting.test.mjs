import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sortBatchesNewestFirst } from "./batchSorting.ts";

const ids = batches => batches.map(batch => batch.id);
test("batch list follows arrival date, not insertion order or batch number", () => {
  const batches = [
    { id: "old", batchNo: "PO-999", arrivalDate: "2025-12-31", createdAt: "2026-09-21T10:00:00Z" },
    { id: "new", batchNo: "PO-001", arrivalDate: "2026-09-21", createdAt: "2026-09-20T10:00:00Z" },
    { id: "middle", arrivalDate: "2026-01-01" },
  ];
  const before = structuredClone(batches);
  assert.deepEqual(ids(sortBatchesNewestFirst(batches)), ["new", "middle", "old"]);
  assert.deepEqual(batches, before);
  assert.equal(sortBatchesNewestFirst(batches)[0], batches[1]);
});
test("same-day batches use newest creation instant, with stable ties and missing timestamps last", () => {
  const batches = [
    { id: "missing", arrivalDate: "2026-09-21" },
    { id: "older", arrivalDate: "2026-09-21", createdAt: "2026-09-21T09:00:00+08:00" },
    { id: "newer", arrivalDate: "2026-09-21", createdAt: "2026-09-21T02:00:00Z" },
    { id: "tie", arrivalDate: "2026-09-21", createdAt: "2026-09-21T10:00:00+08:00" },
  ];
  assert.deepEqual(ids(sortBatchesNewestFirst(batches)), ["newer", "tie", "older", "missing"]);
});
test("invalid and absent arrival dates sort after valid dates without rolling over invalid days", () => {
  const batches = [
    { id: "invalid", arrivalDate: "2026-02-30" }, { id: "blank", arrivalDate: "" },
    { id: "valid", arrivalDate: "2024-02-29" }, { id: "absent" },
  ];
  assert.deepEqual(ids(sortBatchesNewestFirst(batches)), ["valid", "invalid", "blank", "absent"]);
  assert.deepEqual(sortBatchesNewestFirst([]), []);
});
test("sorting all batches before search and pagination places new arrivals on the first page", () => {
  const batches = Array.from({ length: 12 }, (_, index) => ({ id: String(index + 1), arrivalDate: `2026-09-${String(index + 1).padStart(2, "0")}`, supplier: index % 2 ? "A" : "B" }));
  const sorted = sortBatchesNewestFirst(batches);
  assert.deepEqual(ids(sorted.slice(0, 3)), ["12", "11", "10"]);
  assert.deepEqual(ids(sorted.filter(batch => batch.supplier === "A").slice(0, 3)), ["12", "10", "8"]);
});
test("desktop and mobile batch views share the sorted DataTable input", () => {
  const source = readFileSync(new URL("../components/BatchesView.tsx", import.meta.url), "utf8");
  assert.match(source, /sortBatchesNewestFirst\(state\.batches\)/);
  assert.match(source, /<DataTable\s+data=\{sortedBatches\}/);
  assert.match(source, /mobileRender=/);
});
