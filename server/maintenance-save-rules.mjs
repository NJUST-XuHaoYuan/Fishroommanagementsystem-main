import { createHash } from "node:crypto";
import { normalizeLocalDateTime } from "./local-datetime-utils.mjs";

const CLIENT_MUTATION_ID_MAX_LENGTH = 160;
const ITEM_ID_MAX_LENGTH = 160;
const TEXT_MAX_LENGTH = 10_000;
const MEDIA_MAX_ITEMS = 30;
const MEDIA_URL_MAX_LENGTH = 2_048;
const STOCK_STATUSES = new Set(["healthy", "feeding", "sick"]);
const EXPECTED_ITEM_MODES = new Set(["move", "status", "loss"]);
const DELTA_ID_KEYS = [
  "stockUpdateIds",
  "batchUpdateIds",
  "bioRecordUpdateIds",
  "lossRecordUpdateIds",
];

export class MaintenanceSaveError extends Error {
  constructor(message, { statusCode = 400, code = "INVALID_MAINTENANCE_SAVE" } = {}) {
    super(message);
    this.name = "MaintenanceSaveError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function fail(message, options) {
  throw new MaintenanceSaveError(message, options);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeRequiredId(value, label = "ID") {
  const id = String(value ?? "").trim();
  if (!id) fail(`缺少${label}`);
  if (id.length > ITEM_ID_MAX_LENGTH) fail(`${label}过长`);
  return id;
}

function normalizeIdList(value, label = "库存鱼 ID") {
  if (!Array.isArray(value) || value.length === 0) fail(`请选择${label}`);
  const ids = value.map((item) => normalizeRequiredId(item, label));
  if (new Set(ids).size !== ids.length) {
    fail(`${label}不能重复`, { code: "MAINTENANCE_DUPLICATE_ITEM_ID" });
  }
  return ids.sort((left, right) => left.localeCompare(right));
}

function normalizeText(value, label) {
  const text = String(value ?? "").trim();
  if (text.length > TEXT_MAX_LENGTH) fail(`${label}不能超过 ${TEXT_MAX_LENGTH} 个字符`);
  return text;
}

function normalizeMedia(value, label, { required = false } = {}) {
  if (!Array.isArray(value)) fail(`${label}格式不正确`);
  if (value.length > MEDIA_MAX_ITEMS) fail(`${label}一次最多 ${MEDIA_MAX_ITEMS} 个`);
  const urls = value.map((item) => {
    const url = String(item ?? "").trim();
    if (!url || url.length > MEDIA_URL_MAX_LENGTH) fail(`${label}地址不正确`);
    return url;
  });
  if (required && urls.length === 0) fail(`请上传${label}`);
  // Media order is user-visible record data, so it is part of the mutation
  // identity. Only set-like arrays (itemIds/expectedItems/delta ids) are sorted.
  return urls;
}

function normalizeDateOnly(value, label, { optional = false } = {}) {
  const date = String(value ?? "").trim();
  if (!date && optional) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`请选择${label}`);
  return date;
}

function normalizeRecordDate(value) {
  const date = normalizeLocalDateTime(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(date)) fail("请选择记录时间");
  return date;
}

function expectedStockSnapshot(item) {
  return {
    id: String(item?.id ?? "").trim(),
    subTankId: String(item?.subTankId ?? "").trim(),
    status: String(item?.status ?? "").trim(),
    lost: Boolean(item?.lost),
  };
}

export function normalizeMaintenanceClientMutationId(value) {
  const id = String(value ?? "").trim();
  if (!id) {
    fail("缺少客户端操作 ID，请重试", {
      code: "MAINTENANCE_MUTATION_ID_REQUIRED",
    });
  }
  if (id.length > CLIENT_MUTATION_ID_MAX_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(id)) {
    fail("客户端操作 ID 格式不正确", {
      code: "INVALID_MAINTENANCE_MUTATION_ID",
    });
  }
  return id;
}

export function normalizeMaintenanceExpectedItems(expectedItems, itemIds, { required = true } = {}) {
  const normalizedIds = normalizeIdList(itemIds);
  if (!Array.isArray(expectedItems)) {
    if (!required && expectedItems == null) return [];
    fail("缺少库存鱼当前值，请刷新后重试", {
      code: "MAINTENANCE_EXPECTED_ITEMS_REQUIRED",
    });
  }

  const normalized = expectedItems.map((item) => {
    if (!isPlainObject(item)) {
      fail("库存鱼当前值格式不正确", {
        code: "INVALID_MAINTENANCE_EXPECTED_ITEMS",
      });
    }
    if (!hasOwn(item, "subTankId") || !hasOwn(item, "status") || !hasOwn(item, "lost")) {
      fail("库存鱼当前值必须包含缸位、状态和损耗标记", {
        code: "INVALID_MAINTENANCE_EXPECTED_ITEMS",
      });
    }
    if (typeof item.lost !== "boolean") {
      fail("库存鱼当前损耗标记格式不正确", {
        code: "INVALID_MAINTENANCE_EXPECTED_ITEMS",
      });
    }
    return {
      id: normalizeRequiredId(item.id, "库存鱼 ID"),
      subTankId: String(item.subTankId ?? "").trim(),
      status: String(item.status ?? "").trim(),
      lost: item.lost,
    };
  });

  const expectedIds = normalized.map((item) => item.id);
  if (new Set(expectedIds).size !== expectedIds.length) {
    fail("库存鱼当前值不能包含重复 ID", {
      code: "MAINTENANCE_DUPLICATE_EXPECTED_ITEM",
    });
  }
  const requestedIdSet = new Set(normalizedIds);
  if (normalized.length !== normalizedIds.length || expectedIds.some((id) => !requestedIdSet.has(id))) {
    fail("库存鱼当前值与本次操作对象不一致，请刷新后重试", {
      code: "INVALID_MAINTENANCE_EXPECTED_ITEMS",
    });
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

export function maintenanceExpectedStockSnapshot(item) {
  const snapshot = expectedStockSnapshot(item);
  snapshot.id = normalizeRequiredId(snapshot.id, "库存鱼 ID");
  return snapshot;
}

export function normalizeMaintenanceSavePayload(change = {}) {
  if (!isPlainObject(change)) fail("维护保存请求格式不正确");
  const mode = String(change.mode ?? "").trim();
  if (!new Set(["record", "move", "status", "loss"]).has(mode)) {
    fail("Unsupported maintenance save mode", { code: "UNSUPPORTED_MAINTENANCE_MODE" });
  }
  const clientMutationId = normalizeMaintenanceClientMutationId(change.clientMutationId);
  const rawItemIds = mode === "loss" && (!Array.isArray(change.itemIds) || change.itemIds.length === 0)
    ? [change.stockItemId].filter((id) => String(id ?? "").trim())
    : change.itemIds;
  const itemIds = normalizeIdList(rawItemIds);

  if (mode === "record") {
    const recordText = normalizeText(change.recordText, "记录内容");
    const recordPhotos = normalizeMedia(change.recordPhotos ?? [], "照片");
    const recordVideos = normalizeMedia(change.recordVideos ?? [], "视频");
    if (!recordText && recordPhotos.length === 0 && recordVideos.length === 0) {
      fail("请填写记录内容或上传照片/视频");
    }
    return {
      mode,
      clientMutationId,
      itemIds,
      recordDate: normalizeRecordDate(change.recordDate),
      recordText,
      recordPhotos,
      recordVideos,
    };
  }

  const expectedItems = normalizeMaintenanceExpectedItems(change.expectedItems, itemIds);
  if (mode === "move") {
    return {
      mode,
      clientMutationId,
      itemIds,
      expectedItems,
      targetSubTankId: normalizeRequiredId(change.targetSubTankId, "目标子缸 ID"),
      moveDate: normalizeDateOnly(change.moveDate, "移缸日期", { optional: true }),
      moveNotes: normalizeText(change.moveNotes, "移缸备注"),
    };
  }
  if (mode === "status") {
    const targetStatus = String(change.targetStatus ?? "").trim();
    if (!STOCK_STATUSES.has(targetStatus)) fail("请选择目标状态");
    return { mode, clientMutationId, itemIds, expectedItems, targetStatus };
  }
  return {
    mode,
    clientMutationId,
    itemIds,
    expectedItems,
    lossDate: normalizeDateOnly(change.lossDate, "损耗日期"),
    lossReason: normalizeText(change.lossReason, "损耗原因"),
    lossProof: normalizeMedia(change.lossProof ?? [], "损耗照片凭证", { required: true }),
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function maintenanceMutationDigest(change) {
  const normalizedChange = normalizeMaintenanceSavePayload(change);
  const { clientMutationId: _clientMutationId, ...payload } = normalizedChange;
  return createHash("sha256").update(stable(payload), "utf8").digest("hex");
}

export function prepareMaintenanceMutation(change) {
  const normalizedChange = normalizeMaintenanceSavePayload(change);
  const { clientMutationId, ...payload } = normalizedChange;
  const digest = createHash("sha256").update(stable(payload), "utf8").digest("hex");
  return { clientMutationId, digest, change: normalizedChange };
}

export function assertMaintenanceExpectedItems({ mode, itemIds, expectedItems, currentItems } = {}) {
  const normalizedMode = String(mode ?? "").trim();
  if (!EXPECTED_ITEM_MODES.has(normalizedMode)) return [];
  const normalizedIds = normalizeIdList(itemIds);
  const expected = normalizeMaintenanceExpectedItems(expectedItems, normalizedIds);
  if (!Array.isArray(currentItems)) {
    fail("当前库存鱼数据格式不正确", {
      statusCode: 409,
      code: "MAINTENANCE_STOCK_STATE_INVALID",
    });
  }
  const requestedIdSet = new Set(normalizedIds);
  const relevantCurrentItems = currentItems.filter((item) => requestedIdSet.has(String(item?.id ?? "").trim()));
  const currentIds = relevantCurrentItems.map((item) => String(item?.id ?? "").trim());
  if (new Set(currentIds).size !== currentIds.length) {
    fail("库存鱼 ID 不唯一，无法安全保存", {
      statusCode: 409,
      code: "MAINTENANCE_STOCK_STATE_INVALID",
    });
  }
  if (relevantCurrentItems.length !== normalizedIds.length) {
    fail("部分库存鱼不存在或已被删除，请刷新后重试", {
      statusCode: 409,
      code: "MAINTENANCE_STALE",
    });
  }
  const currentById = new Map(relevantCurrentItems.map((item) => {
    const snapshot = expectedStockSnapshot(item);
    return [snapshot.id, snapshot];
  }));
  const stale = expected.some((snapshot) => stable(currentById.get(snapshot.id)) !== stable(snapshot));
  if (stale) {
    fail("库存鱼已被其他人修改，请刷新后重试", {
      statusCode: 409,
      code: "MAINTENANCE_STALE",
    });
  }
  return expected;
}

function idsFromDeltaItems(items) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items.map((item) => String(isPlainObject(item) ? item.id : item ?? "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function maintenanceDeltaIds(delta = {}) {
  return {
    stockUpdateIds: idsFromDeltaItems(delta.stockUpdates ?? delta.stockUpdateIds),
    batchUpdateIds: idsFromDeltaItems(delta.batchUpdates ?? delta.batchUpdateIds),
    bioRecordUpdateIds: idsFromDeltaItems(delta.bioRecordUpdates ?? delta.bioRecordUpdateIds),
    lossRecordUpdateIds: idsFromDeltaItems(delta.lossRecordUpdates ?? delta.lossRecordUpdateIds),
  };
}

export function withMaintenanceMutationMetadata(operationLog, {
  clientMutationId,
  digest,
  delta,
} = {}) {
  if (!isPlainObject(operationLog)) fail("操作日志格式不正确");
  const normalizedMutationId = normalizeMaintenanceClientMutationId(clientMutationId);
  const normalizedDigest = String(digest ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedDigest)) fail("维护操作摘要格式不正确");
  return {
    ...operationLog,
    clientMutationId: normalizedMutationId,
    mutationDigest: normalizedDigest,
    maintenanceDeltaIds: maintenanceDeltaIds(delta),
  };
}

export function findMaintenanceMutationLog({
  operationLogs = [],
  operator,
  clientMutationId,
  digest,
} = {}) {
  const normalizedOperator = String(operator ?? "").trim();
  if (!normalizedOperator) fail("缺少操作人");
  const normalizedMutationId = normalizeMaintenanceClientMutationId(clientMutationId);
  const normalizedDigest = String(digest ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedDigest)) fail("维护操作摘要格式不正确");
  const logs = Array.isArray(operationLogs) ? operationLogs : [];
  const match = logs.find((log) =>
    String(log?.operator ?? "").trim() === normalizedOperator &&
    String(log?.clientMutationId ?? "").trim() === normalizedMutationId
  );
  if (!match) return null;
  if (String(match?.mutationDigest ?? "").trim().toLowerCase() !== normalizedDigest) {
    fail("同一客户端操作 ID 已用于其他内容，请重新发起操作", {
      statusCode: 409,
      code: "MAINTENANCE_MUTATION_ID_CONFLICT",
    });
  }
  return {
    idempotent: true,
    operationLog: match,
    deltaIds: maintenanceDeltaIds(match.maintenanceDeltaIds),
  };
}

function selectByIds(items, ids) {
  const byId = new Map((Array.isArray(items) ? items : [])
    .map((item) => [String(item?.id ?? "").trim(), item]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export function resolveMaintenanceDeltaByIds(state = {}, deltaIds = {}) {
  const normalizedIds = maintenanceDeltaIds(deltaIds);
  return {
    stockUpdates: selectByIds(state.stock, normalizedIds.stockUpdateIds),
    batchUpdates: selectByIds(state.batches, normalizedIds.batchUpdateIds),
    bioRecordUpdates: selectByIds(state.bioRecords, normalizedIds.bioRecordUpdateIds),
    lossRecordUpdates: selectByIds(state.lossRecords, normalizedIds.lossRecordUpdateIds),
  };
}

export async function withMaintenanceTransaction(client, work) {
  if (!client || typeof client.query !== "function" || typeof work !== "function") {
    fail("维护事务执行器格式不正确");
  }
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export const MAINTENANCE_DELTA_ID_KEYS = Object.freeze([...DELTA_ID_KEYS]);
