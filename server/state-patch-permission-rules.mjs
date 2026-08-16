export const ID_COLLECTION_STATE_KEYS = new Set([
  "sites",
  "personnel",
  "operationLogs",
  "species",
  "products",
  "tankGroups",
  "batches",
  "stock",
  "lossRecords",
  "logs",
  "waterQualityRecords",
  "checks",
  "bioRecords",
  "orders",
  "shipments",
  "customers",
]);

export const VALUE_LIST_STATE_KEYS = new Set([
  "speciesCategories",
  "productOrigins",
  "customerSources",
]);

export const PLAIN_OBJECT_STATE_KEYS = new Set([
  "systemSettings",
  "speciesCategoryMajorMap",
]);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectId(item) {
  const id = item?.id;
  if (typeof id === "number" && !Number.isFinite(id)) return "";
  if (typeof id !== "string" && typeof id !== "number") return "";
  return String(id).trim();
}

function validateIdCollection(key, value) {
  if (!Array.isArray(value)) throw new Error(`状态字段「${key}」必须是对象数组`);
  const seenIds = new Set();
  for (const [index, item] of value.entries()) {
    if (!isPlainObject(item)) {
      throw new Error(`状态字段「${key}」第 ${index + 1} 项必须是对象，不能混合其他类型`);
    }
    const id = objectId(item);
    if (!id) throw new Error(`状态字段「${key}」第 ${index + 1} 项必须包含非空 ID`);
    if (seenIds.has(id)) throw new Error(`状态字段「${key}」的记录 ID 不能重复`);
    seenIds.add(id);
  }
}

function validateValueList(key, value) {
  if (!Array.isArray(value)) throw new Error(`状态字段「${key}」必须是字符串数组`);
  const seenValues = new Set();
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`状态字段「${key}」第 ${index + 1} 项必须是非空字符串`);
    }
    const normalized = item.trim();
    if (seenValues.has(normalized)) throw new Error(`状态字段「${key}」不能包含重复值`);
    seenValues.add(normalized);
  }
}

export function validateStatePatchValueShape(key, value) {
  if (ID_COLLECTION_STATE_KEYS.has(key)) {
    validateIdCollection(key, value);
  } else if (VALUE_LIST_STATE_KEYS.has(key)) {
    validateValueList(key, value);
  } else if (PLAIN_OBJECT_STATE_KEYS.has(key) && !isPlainObject(value)) {
    throw new Error(`状态字段「${key}」必须是普通对象`);
  }
  return value;
}

export function validateStatePatchShapes(patch = {}) {
  if (!isPlainObject(patch)) throw new Error("状态补丁必须是普通对象");
  for (const [key, value] of Object.entries(patch)) {
    validateStatePatchValueShape(key, value);
  }
  return patch;
}

function idCollectionActions(current, next) {
  if (stable(current) === stable(next)) return [];
  const currentById = new Map(current.map((item) => [objectId(item), item]));
  const nextById = new Map(next.map((item) => [objectId(item), item]));
  const actions = new Set();

  for (const [id, item] of nextById) {
    if (!currentById.has(id)) actions.add("create");
    else if (stable(currentById.get(id)) !== stable(item)) actions.add("update");
  }
  for (const id of currentById.keys()) {
    if (!nextById.has(id)) actions.add("delete");
  }
  if (actions.size === 0) actions.add("update");
  return ["create", "update", "delete"].filter((action) => actions.has(action));
}

function valueListActions(current, next) {
  if (stable(current) === stable(next)) return [];
  const currentValues = new Set(current);
  const nextValues = new Set(next);
  const actions = new Set();
  if (next.some((value) => !currentValues.has(value))) actions.add("create");
  if (current.some((value) => !nextValues.has(value))) actions.add("delete");
  if (actions.size === 0) actions.add("update");
  return ["create", "update", "delete"].filter((action) => actions.has(action));
}

export function statePatchActionsForKey(key, currentValue, nextValue) {
  validateStatePatchValueShape(key, currentValue);
  validateStatePatchValueShape(key, nextValue);
  if (ID_COLLECTION_STATE_KEYS.has(key)) return idCollectionActions(currentValue, nextValue);
  if (VALUE_LIST_STATE_KEYS.has(key)) return valueListActions(currentValue, nextValue);
  return stable(currentValue) === stable(nextValue) ? [] : ["update"];
}

export function statePatchActionsForValue(currentValue, nextValue) {
  if (stable(currentValue) === stable(nextValue)) return [];
  if (Array.isArray(currentValue) !== Array.isArray(nextValue)) {
    throw new Error("集合字段不能用非数组整体替换");
  }
  if (!Array.isArray(currentValue)) return ["update"];

  const values = [...currentValue, ...nextValue];
  if (values.every(isPlainObject)) {
    validateIdCollection("集合", currentValue);
    validateIdCollection("集合", nextValue);
    return idCollectionActions(currentValue, nextValue);
  }
  if (values.every((item) => typeof item === "string")) {
    validateValueList("集合", currentValue);
    validateValueList("集合", nextValue);
    return valueListActions(currentValue, nextValue);
  }
  throw new Error("集合字段不能混合对象、字符串或其他类型");
}
