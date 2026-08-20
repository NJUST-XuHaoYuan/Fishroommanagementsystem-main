import { normalizeLocalDateTime } from "./local-datetime-utils.mjs";

const BIO_RECORD_ID_MAX_LENGTH = 160;
const BIO_RECORD_TEXT_MAX_LENGTH = 10_000;
const BIO_RECORD_MEDIA_MAX_ITEMS = 30;
const BIO_RECORD_MEDIA_URL_MAX_LENGTH = 2_048;
const STOCK_CODE_MAX_LENGTH = 120;
const STOCK_NOTES_MAX_LENGTH = 10_000;
const STOCK_PRICE_MAX = 10_000_000;
const STOCK_STATUSES = new Set(["healthy", "feeding", "sick"]);

export class BioRecordConflictError extends Error {
  constructor(message, { code = "BIO_RECORD_CONFLICT" } = {}) {
    super(message);
    this.name = "BioRecordConflictError";
    this.statusCode = 409;
    this.code = code;
  }
}

export function canAccessBioStockSite({ account, visibleSiteIds = [], stockSiteId } = {}) {
  if (account?.accessRole === "admin") return true;
  const siteId = String(stockSiteId ?? "").trim();
  if (!siteId) return false;
  return (Array.isArray(visibleSiteIds) ? visibleSiteIds : [])
    .some((visibleSiteId) => String(visibleSiteId ?? "").trim() === siteId);
}

export function bioRecordRequiredActions(action, { includesRecord = false } = {}) {
  const normalizedAction = String(action ?? "").trim();
  if (normalizedAction === "create") return ["create"];
  if (normalizedAction === "updateTime") return ["update"];
  if (normalizedAction === "delete") return ["delete"];
  if (normalizedAction === "saveDetails") return includesRecord ? ["update", "create"] : ["update"];
  throw new Error("不支持的生物记录操作");
}

export function maintenanceRequiredPermissions(mode) {
  const normalizedMode = String(mode ?? "").trim();
  if (normalizedMode === "record") return [{ module: "daily", action: "create" }];
  if (normalizedMode === "move" || normalizedMode === "status") {
    return [{ module: "daily", action: "update" }];
  }
  if (normalizedMode === "loss") {
    return [
      { module: "daily", action: "delete" },
      { module: "lossRecords", action: "create" },
    ];
  }
  throw new Error("Unsupported maintenance save mode");
}

function normalizedText(value, label, maxLength) {
  const text = String(value ?? "");
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function normalizedId(value, label) {
  const id = String(value ?? "").trim();
  if (!id) throw new Error(`缺少${label}`);
  if (id.length > BIO_RECORD_ID_MAX_LENGTH) throw new Error(`${label}过长`);
  return id;
}

export function findUniqueBioStockItem(stock = [], stockItemId) {
  const targetId = normalizedId(stockItemId, "库存鱼编号");
  const matches = (Array.isArray(stock) ? stock : [])
    .filter((item) => String(item?.id ?? "").trim() === targetId);
  if (matches.length > 1) {
    throw new BioRecordConflictError("库存鱼 ID 不唯一，无法安全处理", {
      code: "BIO_STOCK_ID_CONFLICT",
    });
  }
  return matches[0] ?? null;
}

export function assertUniqueBioRecordIds(records = []) {
  const seen = new Set();
  for (const record of Array.isArray(records) ? records : []) {
    const id = String(record?.id ?? "").trim();
    if (!id || seen.has(id)) {
      throw new BioRecordConflictError("观察/治疗记录 ID 缺失或重复，无法安全处理", {
        code: "BIO_RECORD_STATE_INVALID",
      });
    }
    seen.add(id);
  }
  return records;
}

function findUniqueBioRecord(records, recordId) {
  const targetId = normalizedId(recordId, "记录 ID");
  const matches = (Array.isArray(records) ? records : [])
    .filter((item) => String(item?.id ?? "").trim() === targetId);
  if (matches.length > 1) {
    throw new BioRecordConflictError("观察/治疗记录 ID 不唯一，无法安全保存", {
      code: "BIO_RECORD_STATE_INVALID",
    });
  }
  return { targetId, record: matches[0] ?? null };
}

function normalizedMedia(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label}格式不正确`);
  if (value.length > BIO_RECORD_MEDIA_MAX_ITEMS) {
    throw new Error(`${label}一次最多 ${BIO_RECORD_MEDIA_MAX_ITEMS} 个`);
  }
  return value.map((item) => {
    const url = String(item ?? "").trim();
    if (!url || url.length > BIO_RECORD_MEDIA_URL_MAX_LENGTH) throw new Error(`${label}地址不正确`);
    return url;
  });
}

function normalizedDate(value, stockItem, now) {
  const date = normalizeLocalDateTime(value);
  if (!date) throw new Error("请选择记录时间");
  if (date > normalizeLocalDateTime(now)) throw new Error("记录时间不能晚于当前时间");
  const inDate = String(stockItem?.inDate ?? "").trim();
  if (inDate && date < `${inDate}T00:00:00`) throw new Error("记录时间不能早于入库日期");
  return date;
}

function recordSnapshot(record = {}) {
  return {
    id: String(record?.id ?? "").trim(),
    stockItemId: String(record?.stockItemId ?? "").trim(),
    date: normalizeLocalDateTime(record?.date),
    text: String(record?.text ?? ""),
    photos: Array.isArray(record?.photos) ? record.photos.map(String) : [],
    videos: Array.isArray(record?.videos) ? record.videos.map(String) : [],
  };
}

function stable(value) {
  return JSON.stringify(value ?? null);
}

function recordsMatch(left, right) {
  return stable(recordSnapshot(left)) === stable(recordSnapshot(right));
}

function assertExpectedRecord(current, expected) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("缺少记录当前值，请刷新后重试");
  }
  if (!recordsMatch(current, expected)) {
    throw new BioRecordConflictError("这条记录已被其他人修改，请刷新后重试", {
      code: "BIO_RECORD_STALE",
    });
  }
}

function createRecord(input, { stockItem, operator, now }) {
  const id = normalizedId(input?.id, "记录 ID");
  const stockItemId = normalizedId(stockItem?.id, "库存鱼编号");
  const date = normalizedDate(input?.date, stockItem, now);
  const text = normalizedText(input?.text, "记录内容", BIO_RECORD_TEXT_MAX_LENGTH);
  const photos = normalizedMedia(input?.photos ?? [], "照片");
  const videos = normalizedMedia(input?.videos ?? [], "视频");
  if (!text.trim() && photos.length === 0 && videos.length === 0) {
    throw new Error("请填写记录内容或上传照片/视频");
  }
  return {
    id,
    siteId: String(stockItem?.siteId ?? "").trim(),
    stockItemId,
    date,
    text,
    photos,
    videos,
    sourceType: "manual",
    operator: String(operator ?? "").trim(),
  };
}

function normalizedDetails(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("鱼的信息格式不正确");
  }
  const allowedKeys = new Set(["status", "basePrice", "code", "notes"]);
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.some((key) => !allowedKeys.has(key))) {
    throw new Error("鱼的信息包含不支持的字段");
  }
  const details = {};
  if (Object.prototype.hasOwnProperty.call(input, "status")) {
    const status = String(input.status ?? "").trim();
    if (!STOCK_STATUSES.has(status)) throw new Error("请选择有效的鱼状态");
    details.status = status;
  }
  if (Object.prototype.hasOwnProperty.call(input, "basePrice")) {
    const basePrice = Number(input.basePrice);
    if (!Number.isFinite(basePrice) || basePrice <= 0 || basePrice > STOCK_PRICE_MAX) {
      throw new Error("请填写有效的销售默认价");
    }
    details.basePrice = Number(basePrice.toFixed(2));
  }
  if (Object.prototype.hasOwnProperty.call(input, "code")) {
    details.code = normalizedText(input.code, "鱼编号", STOCK_CODE_MAX_LENGTH).trim();
  }
  if (Object.prototype.hasOwnProperty.call(input, "notes")) {
    details.notes = normalizedText(input.notes, "备注", STOCK_NOTES_MAX_LENGTH);
  }
  return details;
}

function detailSnapshot(stockItem = {}, keys = []) {
  return Object.fromEntries(keys.map((key) => [key, key === "basePrice"
    ? Number(Number(stockItem?.[key] ?? 0).toFixed(2))
    : String(stockItem?.[key] ?? "")
  ]));
}

function assertExpectedDetails(stockItem, expected, details) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("缺少鱼的信息当前值，请刷新后重试");
  }
  const keys = Object.keys(details);
  if (stable(detailSnapshot(stockItem, keys)) !== stable(detailSnapshot(expected, keys))) {
    throw new BioRecordConflictError("鱼的信息已被其他人修改，请刷新后重试", {
      code: "BIO_DETAILS_STALE",
    });
  }
}

function applyDetails(stockItem, details) {
  const next = { ...stockItem, ...details };
  if (Object.prototype.hasOwnProperty.call(details, "basePrice")) {
    const previousPrice = Number(stockItem?.basePrice ?? 0);
    next.priceOverridden = Math.abs(details.basePrice - previousPrice) > 0.005
      ? true
      : stockItem?.priceOverridden;
  }
  return next;
}

export function planBioRecordSave({
  action,
  stockItem,
  records = [],
  record,
  recordId,
  expectedRecord,
  details,
  expectedDetails,
  operator,
  now,
} = {}) {
  const normalizedAction = String(action ?? "").trim();
  const stockItemId = normalizedId(stockItem?.id, "库存鱼编号");
  const currentRecords = Array.isArray(records) ? records : [];

  if (normalizedAction === "create") {
    const created = createRecord(record, { stockItem, operator, now });
    const { record: duplicate } = findUniqueBioRecord(currentRecords, created.id);
    if (duplicate) {
      if (recordsMatch(duplicate, created) &&
          String(duplicate?.siteId ?? "") === created.siteId &&
          String(duplicate?.sourceType ?? "manual") === "manual" &&
          String(duplicate?.operator ?? "") === created.operator) {
        return { records: currentRecords, stockItem, record: duplicate, idempotent: true, changedKeys: [] };
      }
      throw new BioRecordConflictError("记录 ID 已被占用，请重试", {
        code: "BIO_RECORD_ID_CONFLICT",
      });
    }
    return {
      records: [...currentRecords, created],
      stockItem,
      record: created,
      idempotent: false,
      changedKeys: ["bioRecords"],
    };
  }

  if (normalizedAction === "updateTime") {
    const { targetId, record: current } = findUniqueBioRecord(currentRecords, recordId);
    if (!current || String(current?.stockItemId ?? "") !== stockItemId) throw new Error("观察/治疗记录不存在或已被删除");
    if (current?.sourceType === "dailyLog") throw new Error("缸组养护记录不能在鱼详情中单独修改");
    assertExpectedRecord(current, expectedRecord);
    const date = normalizedDate(record?.date, stockItem, now);
    const updated = { ...current, date };
    return {
      records: currentRecords.map((item) => String(item?.id ?? "").trim() === targetId ? updated : item),
      stockItem,
      record: updated,
      idempotent: false,
      changedKeys: ["bioRecords"],
    };
  }

  if (normalizedAction === "delete") {
    const { targetId, record: current } = findUniqueBioRecord(currentRecords, recordId);
    if (!current || String(current?.stockItemId ?? "") !== stockItemId) throw new Error("观察/治疗记录不存在或已被删除");
    if (current?.sourceType === "dailyLog") throw new Error("缸组养护记录不能在鱼详情中单独删除");
    assertExpectedRecord(current, expectedRecord);
    return {
      records: currentRecords.filter((item) => String(item?.id ?? "").trim() !== targetId),
      stockItem,
      record: null,
      deletedRecordId: targetId,
      idempotent: false,
      changedKeys: ["bioRecords"],
    };
  }

  if (normalizedAction === "saveDetails") {
    const nextDetails = normalizedDetails(details);
    let nextStockItem = stockItem;
    const desiredSnapshot = detailSnapshot(nextDetails, Object.keys(nextDetails));
    const currentSnapshot = detailSnapshot(stockItem, Object.keys(nextDetails));
    const detailsAlreadyApplied = stable(currentSnapshot) === stable(desiredSnapshot);
    if (!detailsAlreadyApplied) {
      assertExpectedDetails(stockItem, expectedDetails, nextDetails);
      nextStockItem = applyDetails(stockItem, nextDetails);
    }

    let recordPlan = null;
    if (record) {
      recordPlan = planBioRecordSave({
        action: "create",
        stockItem,
        records: currentRecords,
        record,
        operator,
        now,
      });
    }
    const recordAlreadyApplied = !recordPlan || recordPlan.idempotent;
    if (detailsAlreadyApplied && recordAlreadyApplied) {
      return {
        records: recordPlan?.records ?? currentRecords,
        stockItem,
        record: recordPlan?.record ?? null,
        idempotent: true,
        changedKeys: [],
      };
    }
    return {
      records: recordPlan?.records ?? currentRecords,
      stockItem: nextStockItem,
      record: recordPlan?.record ?? null,
      idempotent: false,
      changedKeys: [
        ...(!detailsAlreadyApplied ? ["stock"] : []),
        ...(!recordAlreadyApplied ? ["bioRecords"] : []),
      ],
    };
  }

  throw new Error("不支持的生物记录操作");
}

export function bioRecordExpectedSnapshot(record = {}) {
  return recordSnapshot(record);
}
