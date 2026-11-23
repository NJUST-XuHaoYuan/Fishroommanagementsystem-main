import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
const component = source.split("function StockPickerBioDialog(")[1].split("// ─── StockPickerDialog")[0];
// Execute the real opening effect: SSR alone does not run effects and missed this crash.
const openingEffect = component.match(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[open, item\?\.id, item\?\.status, item\?\.notes, today\]\);/)?.[1];
assert.ok(openingEffect, "stock picker opening effect must be covered");

function openDetail(open, item) {
  const values = {};
  const context = {
    open, item, today: "2026-11-23", nowDatetimeLocal: () => "2026-11-23T22:00:00",
    uid: () => "new-record-id", newRecordIdRef: { current: "previous-record" },
    maintenanceTicketRef: { current: "previous-request" },
  };
  for (const name of ["BioStatus", "BioCode", "BioNotes", "NewRecord", "EditingRecordId", "EditingRecordTime", "ActionMode", "MoveNotes", "LossDate", "LossReason", "LossProof"]) {
    context[`set${name}`] = value => { values[name] = value; };
  }
  vm.runInNewContext(`(() => { ${openingEffect} })()`, context);
  return { values: JSON.parse(JSON.stringify(values)), context };
}

test("opening an order fish detail initializes all drafts without crashing", () => {
  const { values, context } = openDetail(true, { id: "fish-a", status: "feeding", code: "189", notes: "已开口" });
  assert.equal(values.BioStatus, "feeding");
  assert.equal(values.BioCode, "189");
  assert.equal(values.BioNotes, "已开口");
  assert.equal(values.ActionMode, "detail");
  assert.deepEqual(values.NewRecord, { date: "2026-11-23T22:00:00", text: "", photos: [], videos: [] });
  assert.equal(values.MoveNotes, "");
  assert.deepEqual(values.LossProof, []);
  assert.equal(context.newRecordIdRef.current, "new-record-id");
  assert.equal(context.maintenanceTicketRef.current, null);
});

test("reopening another fish clears optional fields and pending action state", () => {
  const { values } = openDetail(true, { id: "fish-b", status: "healthy" });
  assert.equal(values.BioCode, "");
  assert.equal(values.BioNotes, "");
  assert.equal(values.EditingRecordId, null);
  assert.equal(values.EditingRecordTime, "");
  assert.equal(values.LossReason, "");
  assert.equal(values.LossDate, "2026-11-23");
});

test("closed or missing fish does not reset the dialog", () => {
  assert.deepEqual(openDetail(false, { id: "fish-a" }).values, {});
  assert.deepEqual(openDetail(true, null).values, {});
});
