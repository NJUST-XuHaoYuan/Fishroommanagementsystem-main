const DEFAULT_GENERATION_ATTEMPTS = 5;

export class RecordIdConflictError extends Error {
  constructor(message, { code = "RECORD_ID_CONFLICT" } = {}) {
    super(message);
    this.name = "RecordIdConflictError";
    this.statusCode = 409;
    this.code = code;
  }
}

function normalizedId(value) {
  return String(value ?? "").trim();
}

function recordIdExists(records, id) {
  return (Array.isArray(records) ? records : [])
    .some((record) => normalizedId(record?.id) === id);
}

export function resolveCreateRecordId({
  records = [],
  requestedId,
  createId,
  label = "记录",
  conflictCode = "RECORD_ID_CONFLICT",
  generationAttempts = DEFAULT_GENERATION_ATTEMPTS,
} = {}) {
  const externalId = normalizedId(requestedId);
  if (externalId) {
    if (recordIdExists(records, externalId)) {
      throw new RecordIdConflictError(`${label} ID 已存在，请刷新后重试`, {
        code: conflictCode,
      });
    }
    return externalId;
  }

  if (typeof createId !== "function") throw new Error(`${label} ID 生成器不可用`);
  const attempts = Math.max(1, Number(generationAttempts) || DEFAULT_GENERATION_ATTEMPTS);
  for (let index = 0; index < attempts; index += 1) {
    const generatedId = normalizedId(createId());
    if (generatedId && !recordIdExists(records, generatedId)) return generatedId;
  }
  throw new RecordIdConflictError(`${label} ID 生成冲突，请重试`, {
    code: conflictCode,
  });
}
