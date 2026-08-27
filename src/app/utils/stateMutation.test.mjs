import test from "node:test";
import assert from "node:assert/strict";
import {
  changedObjectKeys,
  hasStateVersionChanged,
  isCurrentStateRequest,
  isNewerStateVersion,
  latestStateVersion,
  mapArrayCopyOnWrite,
} from "./stateMutation.ts";

test("unchanged state branches are not serialized while finding changed keys", () => {
  let serialized = 0;
  const largeUnchangedCollection = {
    toJSON() {
      serialized += 1;
      return ["large"];
    },
  };
  const before = { stock: largeUnchangedCollection, bioRecords: [{ id: "record-1" }] };
  const after = { ...before, bioRecords: [...before.bioRecords, { id: "record-2" }] };

  assert.deepEqual(changedObjectKeys(before, after, ["stock", "bioRecords"]), ["bioRecords"]);
  assert.equal(serialized, 0);
});

test("new references with equal content are ignored after a deep comparison", () => {
  const before = { stock: [{ id: "fish-1", siteId: "nanjing" }] };
  const after = { stock: [{ id: "fish-1", siteId: "nanjing" }] };
  assert.deepEqual(changedObjectKeys(before, after, ["stock"]), []);
});

test("copy-on-write mapping preserves the array when every item is unchanged", () => {
  const items = [{ id: "fish-1" }, { id: "fish-2" }];
  assert.equal(mapArrayCopyOnWrite(items, (item) => item), items);
});

test("copy-on-write mapping returns a new array when one item changes", () => {
  const items = [{ id: "fish-1" }, { id: "fish-2" }];
  const mapped = mapArrayCopyOnWrite(items, (item) =>
    item.id === "fish-2" ? { ...item, siteId: "nanjing" } : item
  );
  assert.notEqual(mapped, items);
  assert.equal(mapped[0], items[0]);
  assert.deepEqual(mapped[1], { id: "fish-2", siteId: "nanjing" });
});

test("state responses are accepted only for the same user and request epoch", () => {
  assert.equal(isCurrentStateRequest("admin|admin", "admin|admin", 4, 4), true);
  assert.equal(isCurrentStateRequest("admin|admin", "staff|staff", 4, 4), false);
  assert.equal(isCurrentStateRequest("admin|admin", "admin|admin", 3, 4), false);
  assert.equal(isCurrentStateRequest("", "", 4, 4), false);
});

test("state revisions use numeric ordering instead of unsafe string ordering", () => {
  assert.equal(isNewerStateVersion("9", "10"), true);
  assert.equal(isNewerStateVersion("10", "9"), false);
  assert.equal(latestStateVersion("9", "10"), "10");
  assert.equal(latestStateVersion("10", "9"), "9");
  assert.equal(latestStateVersion("10", ""), "10");
  assert.equal(hasStateVersionChanged("10", "9"), true);
  assert.equal(hasStateVersionChanged("10", "10"), false);
  assert.equal(hasStateVersionChanged("", "10"), true);
});

test("legacy opaque versions refresh whenever the value changes", () => {
  const first = "2026-08-19 10:00:00.123456+00";
  const second = "2026-08-19 10:00:00.123999+00";
  assert.equal(isNewerStateVersion(first, second), true);
  assert.equal(isNewerStateVersion(first, first), false);
});
