import { normalizeLocalDateTime } from "./local-datetime-utils.mjs";
import { isDeepStrictEqual } from "node:util";
import { comparableMaintenanceLocation, isSharedWaterAction, maintenanceRecordLocation } from "./maintenance-scope-rules.mjs";

export class DailyLogSaveError extends Error {
  constructor(message, { statusCode = 400, code = "DAILY_LOG_SAVE_INVALID" } = {}) {
    super(message);
    this.name = "DailyLogSaveError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function text(value) {
  return String(value ?? "").trim();
}

function exactlyOne(records, id, { label, notFoundCode, duplicateCode }) {
  const matches = (Array.isArray(records) ? records : [])
    .filter((record) => text(record?.id) === id);
  if (matches.length === 0) {
    throw new DailyLogSaveError(`${label}不存在或已被删除`, {
      statusCode: 404,
      code: notFoundCode,
    });
  }
  if (matches.length !== 1) {
    throw new DailyLogSaveError(`${label} ID 不唯一，无法安全保存`, {
      statusCode: 409,
      code: duplicateCode,
    });
  }
  return matches[0];
}

function groupForLog(tankGroups, log) {
  const explicitId = text(log?.tankGroupId);
  if (explicitId) {
    const matches = (Array.isArray(tankGroups) ? tankGroups : [])
      .filter((group) => text(group?.id) === explicitId);
    if (matches.length > 1) {
      throw new DailyLogSaveError("缸组 ID 不唯一，无法安全保存", {
        statusCode: 409,
        code: "DAILY_LOG_GROUP_ID_CONFLICT",
      });
    }
    return matches[0] ?? null;
  }
  const subTankId = text(log?.subTankId);
  const matches = (Array.isArray(tankGroups) ? tankGroups : []).filter((group) =>
    (Array.isArray(group?.subTanks) ? group.subTanks : [])
      .some((tank) => text(tank?.id) === subTankId)
  );
  if (matches.length > 1) {
    throw new DailyLogSaveError("子缸关联多个缸组，无法安全保存", {
      statusCode: 409,
      code: "DAILY_LOG_SUB_TANK_CONFLICT",
    });
  }
  return matches[0] ?? null;
}

export function normalizeMaintenanceMedia(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 30) throw new DailyLogSaveError(`${label}格式不正确或超过30个`);
  return value.map(item => {
    const url = text(item);
    if (!url || url.length > 2048 || !/^(?:\/uploads\/|https?:\/\/)/i.test(url) || /[\u0000-\u0020\\]/.test(url) ||
        /(?:\.\.|%2e|%2f|%5c|personnel-private|new-customer-evidence|payment-proof|\/api\/)/i.test(url)) {
      throw new DailyLogSaveError(`${label}地址不正确，请重新上传`);
    }
    const parsed = new URL(url, "https://fishroom.invalid");
    if (parsed.username || parsed.password) throw new DailyLogSaveError(`${label}地址不正确，请重新上传`);
    return url;
  });
}

function normalizedLog(log, { id, group, operator, now, current }) {
  const date = normalizeLocalDateTime(log?.date);
  const action = text(log?.action);
  const normalizedOperator = text(operator);
  if (!date || !group?.id || !action || !normalizedOperator) {
    throw new DailyLogSaveError("养护日志时间、缸组、操作内容和操作员均为必填项");
  }
  if (date > normalizeLocalDateTime(now)) {
    throw new DailyLogSaveError("养护日志时间不能晚于当前时间");
  }
  // Old desktop editors omit these fields. Preserve their scope and attachments.
  const location = maintenanceRecordLocation(log, { current, group, forceGroup: isSharedWaterAction(action) });
  return {
    id,
    siteId: text(group.siteId),
    date,
    tankGroupId: text(group.id),
    ...location,
    action,
    operator: normalizedOperator,
    notes: text(log?.notes),
    photos: normalizeMaintenanceMedia(Object.hasOwn(log, "photos") ? log.photos : current?.photos, "照片"),
    videos: normalizeMaintenanceMedia(Object.hasOwn(log, "videos") ? log.videos : current?.videos, "视频"),
    createdBy: text(current?.createdBy || current?.operator) || normalizedOperator,
  };
}

export function planDailyLogSave({
  change = {},
  matchingLogs = [],
  tankGroups = [],
  operator,
  now,
  generatedId,
} = {}) {
  const hasLog = Boolean(change?.log && typeof change.log === "object" && !Array.isArray(change.log));
  const deleteId = text(change?.deleteId);
  if (change.createOnly !== undefined && typeof change.createOnly !== "boolean") throw new DailyLogSaveError("新增记录标记格式不正确");
  if (Number(hasLog) + Number(Boolean(deleteId)) !== 1) {
    throw new DailyLogSaveError("请只提交一项养护日志新增、修改或删除操作");
  }

  if (deleteId) {
    const current = exactlyOne(matchingLogs, deleteId, {
      label: "养护日志",
      notFoundCode: "DAILY_LOG_NOT_FOUND",
      duplicateCode: "DAILY_LOG_ID_CONFLICT",
    });
    const group = groupForLog(tankGroups, current);
    const groupId = text(group?.id ?? current?.tankGroupId);
    const groupName = text(group?.name) || "未知缸组";
    return {
      mode: "delete",
      current,
      deletedLogId: deleteId,
      currentSiteId: text(group?.siteId ?? current?.siteId),
      siteId: text(group?.siteId ?? current?.siteId),
      operationDetail: `删除养护日志「${text(current.action)}」（${text(current.date)}，缸组：${groupName}/${groupId || "未知"}）`,
    };
  }

  const id = text(change.log.id) || text(generatedId);
  if (!id) throw new DailyLogSaveError("缺少养护日志编号");
  if (matchingLogs.length > 1) {
    throw new DailyLogSaveError("养护日志 ID 不唯一，无法安全保存", {
      statusCode: 409,
      code: "DAILY_LOG_ID_CONFLICT",
    });
  }
  const current = matchingLogs[0] ?? null;
  const groupId = text(change.log.tankGroupId);
  const group = exactlyOne(tankGroups, groupId, {
    label: "缸组",
    notFoundCode: "DAILY_LOG_GROUP_NOT_FOUND",
    duplicateCode: "DAILY_LOG_GROUP_ID_CONFLICT",
  });
  const log = normalizedLog(change.log, { id, group, operator, now, current });
  if (change.createOnly && current) {
    const keys = ["date", "tankGroupId", "action", "notes", "photos", "videos"];
    const equal = isDeepStrictEqual(comparableMaintenanceLocation(current), comparableMaintenanceLocation(log)) &&
      keys.every(key => isDeepStrictEqual(current[key] ?? (["photos", "videos"].includes(key) ? [] : ""), log[key] ?? (["photos", "videos"].includes(key) ? [] : "")));
    if (text(current.createdBy || current.operator) !== text(operator) || !equal) {
      throw new DailyLogSaveError("这条记录已存在且内容不同，请刷新后核对，不能覆盖", { statusCode: 409, code: "DAILY_LOG_CREATE_CONFLICT" });
    }
    return { mode: "create", idempotent: true, current, log: current, currentSiteId: text(group.siteId), siteId: text(group.siteId) };
  }
  const mode = current ? "update" : "create";
  const currentGroup = current ? groupForLog(tankGroups, current) : null;
  return {
    mode,
    current,
    log,
    currentSiteId: current ? text(currentGroup?.siteId ?? current?.siteId) : "",
    siteId: text(group.siteId),
    operationDetail: `${mode === "update" ? "修改" : "新增"}养护日志「${log.action}」（${log.date}，缸组：${text(group.name)}/${text(group.id)}，操作员：${log.operator}）`,
  };
}

function assertUniqueNonEmpty(records, field, label) {
  const values = (Array.isArray(records) ? records : []).map((record) => text(record?.[field]));
  if (values.some((value) => !value) || new Set(values).size !== values.length) {
    throw new DailyLogSaveError(`${label} ID 缺失或不唯一，无法安全同步`, {
      statusCode: 409,
      code: "DAILY_LOG_SYNC_ID_CONFLICT",
    });
  }
  return values;
}

export function assertDailyLogSyncIdentity({
  targetStock = [],
  existingBioRecords = [],
  bioRecordUpdates = [],
  globalStockIdCounts = {},
  globalBioRecords = [],
} = {}) {
  const targetStockIds = assertUniqueNonEmpty(targetStock, "id", "库存鱼");
  const existingBioIds = assertUniqueNonEmpty(existingBioRecords, "id", "既有养殖记录");
  assertUniqueNonEmpty(existingBioRecords, "stockItemId", "既有养殖记录关联库存");
  const updateBioIds = assertUniqueNonEmpty(bioRecordUpdates, "id", "待同步养殖记录");
  assertUniqueNonEmpty(bioRecordUpdates, "stockItemId", "待同步养殖记录关联库存");

  if (targetStockIds.some((id) => Number(globalStockIdCounts?.[id] ?? 0) !== 1)) {
    throw new DailyLogSaveError("库存鱼 ID 不唯一，无法安全同步养护日志", {
      statusCode: 409,
      code: "DAILY_LOG_SYNC_ID_CONFLICT",
    });
  }

  const existingBioIdSet = new Set(existingBioIds);
  const checkedBioIds = new Set([...existingBioIds, ...updateBioIds]);
  const globalCounts = new Map();
  for (const record of Array.isArray(globalBioRecords) ? globalBioRecords : []) {
    const id = text(record?.id);
    if (id) globalCounts.set(id, (globalCounts.get(id) ?? 0) + 1);
  }
  for (const id of checkedBioIds) {
    const expected = existingBioIdSet.has(id) ? 1 : 0;
    if ((globalCounts.get(id) ?? 0) !== expected) {
      throw new DailyLogSaveError("养殖记录 ID 已被占用或不唯一，无法安全同步", {
        statusCode: 409,
        code: "DAILY_LOG_SYNC_ID_CONFLICT",
      });
    }
  }
}
