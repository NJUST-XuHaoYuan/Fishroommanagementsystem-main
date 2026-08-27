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

export const DEDICATED_STATE_PATCH_KEYS = new Set(["personnel", "bioRecords", "stock"]);

export function assertGenericStatePatchKeyAllowed(key) {
  if (!DEDICATED_STATE_PATCH_KEYS.has(key)) return key;
  const message = key === "bioRecords"
    ? "生物记录必须通过专用接口修改"
    : key === "stock"
    ? "库存记录必须通过库存或日常维护专用接口修改"
    : "人员账号和权限必须通过专用接口修改";
  throw new Error(message);
}

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

export function statePatchEntityDiff(currentValue, nextValue, key = "集合") {
  validateIdCollection(key, currentValue);
  validateIdCollection(key, nextValue);
  const currentById = new Map(currentValue.map((item) => [objectId(item), item]));
  const nextById = new Map(nextValue.map((item) => [objectId(item), item]));
  const created = [];
  const updated = [];
  const deleted = [];

  for (const [id, after] of nextById) {
    const before = currentById.get(id);
    if (!before) created.push(after);
    else if (stable(before) !== stable(after)) updated.push({ before, after });
  }
  for (const [id, before] of currentById) {
    if (!nextById.has(id)) deleted.push(before);
  }
  return { created, updated, deleted };
}

export function assertStatePatchEntityScope(diff, isVisible) {
  if (typeof isVisible !== "function") throw new TypeError("场地权限检查器格式不正确");
  const unauthorized =
    (Array.isArray(diff?.created) ? diff.created : []).some((record) => !isVisible(record)) ||
    (Array.isArray(diff?.deleted) ? diff.deleted : []).some((record) => !isVisible(record)) ||
    (Array.isArray(diff?.updated) ? diff.updated : []).some(({ before, after }) =>
      !isVisible(before) || !isVisible(after)
    );
  if (!unauthorized) return diff;
  const error = new Error("不能修改未授权场地的数据");
  error.statusCode = 403;
  error.code = "STATE_PATCH_SITE_FORBIDDEN";
  throw error;
}

/**
 * Resolve the authoritative site for a site-scoped record. If the record has
 * a relationship field, callers pass every matching parent's site id. Exactly
 * one parent must resolve, and a denormalized direct siteId must agree with it.
 * `undefined` means this record has no relationship field to validate.
 */
export function authoritativeStatePatchSiteId(directSiteId, relationshipSiteIds) {
  const direct = String(directSiteId ?? "").trim();
  if (relationshipSiteIds === undefined) return direct;
  if (!Array.isArray(relationshipSiteIds) || relationshipSiteIds.length !== 1) return "";
  const related = String(relationshipSiteIds[0] ?? "").trim();
  if (!related || (direct && direct !== related)) return "";
  return related;
}

const IMMUTABLE_SITE_BINDING_FIELDS = Object.freeze({
  tankGroups: ["siteId"],
  batches: ["siteId"],
  stock: ["siteId", "subTankId", "batchId"],
  lossRecords: ["siteId", "stockItemId"],
  logs: ["siteId", "tankGroupId", "subTankId"],
  waterQualityRecords: ["siteId", "tankGroupId"],
  checks: ["siteId", "tankGroupId", "subTankId"],
  orders: ["siteId"],
  shipments: ["siteId", "orderId", "shipMethod"],
});

/** Site ownership and relationship fields may only be assigned at creation.
 * Re-parenting persisted data requires a dedicated route that can migrate all
 * dependent records atomically.
 */
export function statePatchSiteBindingChanged(key, before = {}, after = {}) {
  const fields = IMMUTABLE_SITE_BINDING_FIELDS[key] ?? [];
  return fields.some((field) =>
    String(before?.[field] ?? "").trim() !== String(after?.[field] ?? "").trim()
  );
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
