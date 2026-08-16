import test from "node:test";
import assert from "node:assert/strict";
import {
  ID_COLLECTION_STATE_KEYS,
  PLAIN_OBJECT_STATE_KEYS,
  VALUE_LIST_STATE_KEYS,
  statePatchActionsForKey,
  statePatchActionsForValue,
  validateStatePatchShapes,
  validateStatePatchValueShape,
} from "./state-patch-permission-rules.mjs";

test("declares the state shapes used by the generic patch endpoint", () => {
  assert.equal(ID_COLLECTION_STATE_KEYS.has("species"), true);
  assert.equal(ID_COLLECTION_STATE_KEYS.has("personnel"), true);
  assert.equal(VALUE_LIST_STATE_KEYS.has("speciesCategories"), true);
  assert.equal(PLAIN_OBJECT_STATE_KEYS.has("systemSettings"), true);
  assert.equal(PLAIN_OBJECT_STATE_KEYS.has("speciesCategoryMajorMap"), true);
});

test("classifies ID collection additions, changes and removals separately", () => {
  const current = [{ id: "1", name: "A" }, { id: "2", name: "B" }];
  assert.deepEqual(statePatchActionsForKey("species", current, [...current, { id: "3", name: "C" }]), ["create"]);
  assert.deepEqual(statePatchActionsForKey("species", current, [{ id: "1", name: "A2" }, current[1]]), ["update"]);
  assert.deepEqual(statePatchActionsForKey("species", current, [current[0]]), ["delete"]);
  assert.deepEqual(statePatchActionsForKey("species", current, [current[1], current[0]]), ["update"]);
});

test("requires every action present in a mixed collection change", () => {
  const current = [{ id: "1", name: "A" }, { id: "2", name: "B" }];
  const next = [{ id: "1", name: "A2" }, { id: "3", name: "C" }];
  assert.deepEqual(statePatchActionsForKey("products", current, next), ["create", "update", "delete"]);
});

test("scalar and value-list changes receive the expected actions", () => {
  assert.deepEqual(statePatchActionsForValue("old", "new"), ["update"]);
  assert.deepEqual(statePatchActionsForKey("customerSources", ["A"], ["A", "B"]), ["create"]);
  assert.deepEqual(statePatchActionsForKey("customerSources", ["A", "B"], ["B"]), ["delete"]);
  assert.deepEqual(statePatchActionsForKey("customerSources", ["A", "B"], ["B", "A"]), ["update"]);
  assert.deepEqual(statePatchActionsForKey("systemSettings", { a: 1, b: 2 }, { b: 2, a: 1 }), []);
});

test("requires ID collections to be arrays of objects with unique non-empty IDs", () => {
  assert.doesNotThrow(() => validateStatePatchValueShape("species", [{ id: "1" }, { id: 2 }]));
  assert.throws(() => validateStatePatchValueShape("species", {}), /必须是对象数组/);
  assert.throws(() => validateStatePatchValueShape("species", [{ id: "1" }, "mixed"]), /不能混合其他类型/);
  assert.throws(() => validateStatePatchValueShape("species", [{ name: "missing" }]), /非空 ID/);
  assert.throws(() => validateStatePatchValueShape("species", [{ id: "   " }]), /非空 ID/);
  assert.throws(() => validateStatePatchValueShape("species", [{ id: "1" }, { id: 1 }]), /不能重复/);
  assert.throws(() => statePatchActionsForKey("species", [{ id: "1" }], { id: "2" }), /必须是对象数组/);
});

test("requires value lists to contain unique non-empty strings", () => {
  assert.doesNotThrow(() => validateStatePatchValueShape("productOrigins", []));
  assert.doesNotThrow(() => validateStatePatchValueShape("productOrigins", ["印尼", "菲律宾"]));
  assert.throws(() => validateStatePatchValueShape("productOrigins", "印尼"), /必须是字符串数组/);
  assert.throws(() => validateStatePatchValueShape("productOrigins", ["印尼", 1]), /必须是非空字符串/);
  assert.throws(() => validateStatePatchValueShape("productOrigins", ["   "]), /必须是非空字符串/);
  assert.throws(() => validateStatePatchValueShape("productOrigins", ["印尼", " 印尼 "]), /不能包含重复值/);
});

test("requires object state fields and the patch envelope to be plain objects", () => {
  assert.doesNotThrow(() => validateStatePatchShapes({
    systemSettings: { orderPackagingFee: 10 },
    speciesCategoryMajorMap: { 刺尾鱼科: "marineFish" },
    species: [{ id: "s1" }],
    speciesCategories: ["刺尾鱼科"],
  }));
  assert.throws(() => validateStatePatchValueShape("systemSettings", []), /必须是普通对象/);
  assert.throws(() => validateStatePatchValueShape("speciesCategoryMajorMap", null), /必须是普通对象/);
  assert.throws(() => validateStatePatchValueShape("systemSettings", new Date()), /必须是普通对象/);
  assert.throws(() => validateStatePatchShapes([]), /状态补丁必须是普通对象/);
});

test("generic collection fallback rejects shape changes and mixed types", () => {
  assert.throws(() => statePatchActionsForValue([{ id: "1" }], { id: "1" }), /不能用非数组整体替换/);
  assert.throws(() => statePatchActionsForValue([{ id: "1" }], [{ id: "1" }, "mixed"]), /不能混合/);
});
