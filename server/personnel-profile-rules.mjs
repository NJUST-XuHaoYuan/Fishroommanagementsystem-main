export const PERSONNEL_EDUCATION_LEVELS = Object.freeze([
  "high_school_or_below",
  "college",
  "bachelor",
  "master",
  "doctorate",
]);

export const PERSONNEL_SELF_PROFILE_FIELDS = Object.freeze([
  "name",
  "gender",
  "nativePlace",
  "birthMonth",
  "educationLevel",
  "idCardNo",
  "idCardFrontAttachment",
  "idCardBackAttachment",
  "educationProofAttachment",
  "phone",
  "email",
  "wechat",
  "address",
  "bankAccountName",
  "bankAccountNo",
  "bankName",
]);

export const PERSONNEL_PROFILE_ATTACHMENT_FIELDS = Object.freeze([
  "idCardFrontAttachment",
  "idCardBackAttachment",
  "educationProofAttachment",
]);

export const PERSONNEL_PROFILE_SENSITIVE_VALUE_FIELDS = Object.freeze([
  "idCardNo",
  "bankAccountName",
  "bankAccountNo",
  "bankName",
]);

export const PERSONNEL_PROFILE_FIELD_DEFINITIONS = Object.freeze({
  name: { label: "姓名", section: "基本信息" },
  gender: { label: "性别", section: "基本信息" },
  nativePlace: { label: "籍贯", section: "基本信息" },
  birthMonth: { label: "出生年月", section: "基本信息" },
  educationLevel: { label: "学历学位", section: "基本信息" },
  idCardNo: { label: "身份证号", section: "基本信息", sensitive: true },
  idCardFrontAttachment: { label: "身份证正面", section: "基本信息", sensitive: true, attachment: true },
  idCardBackAttachment: { label: "身份证反面", section: "基本信息", sensitive: true, attachment: true },
  educationProofAttachment: { label: "毕业证明 / 学信网截图", section: "基本信息", sensitive: true, attachment: true },
  phone: { label: "电话", section: "联系信息" },
  email: { label: "邮箱", section: "联系信息" },
  wechat: { label: "微信", section: "联系信息" },
  address: { label: "住址", section: "联系信息" },
  bankAccountName: { label: "工资账户户名", section: "工资账户", sensitive: true },
  bankAccountNo: { label: "工资账户户号", section: "工资账户", sensitive: true },
  bankName: { label: "开户行", section: "工资账户", sensitive: true },
});

const ATTACHMENT_KIND_BY_FIELD = Object.freeze({
  idCardFrontAttachment: "id_card_front",
  idCardBackAttachment: "id_card_back",
  educationProofAttachment: "education_proof",
});

const EDUCATION_LABELS = Object.freeze({
  high_school_or_below: "高中及以下",
  college: "大专",
  bachelor: "本科",
  master: "硕士",
  doctorate: "博士",
});

const GENDER_LABELS = Object.freeze({ male: "男", female: "女", other: "其他" });

function normalizedText(value, label, maxLength) {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error(`${label}格式不正确`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label}不能包含换行或控制字符`);
  return normalized;
}

function isValidCompactDate(value) {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

export function normalizePersonnelIdCardNo(value) {
  const normalized = normalizedText(value, "身份证号", 18).toUpperCase();
  if (!normalized) return "";
  if (/^[1-9]\d{14}$/.test(normalized)) {
    const birthDate = `19${normalized.slice(6, 12)}`;
    if (!isValidCompactDate(birthDate) || normalized.slice(12) === "000") {
      throw new Error("身份证号格式不正确");
    }
    return normalized;
  }
  if (!/^[1-9]\d{16}[\dX]$/.test(normalized) ||
      !isValidCompactDate(normalized.slice(6, 14)) ||
      normalized.slice(14, 17) === "000") {
    throw new Error("身份证号格式不正确");
  }
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checksumCharacters = "10X98765432";
  const checksum = normalized.slice(0, 17)
    .split("")
    .reduce((sum, digit, index) => sum + Number(digit) * weights[index], 0);
  if (normalized[17] !== checksumCharacters[checksum % 11]) {
    throw new Error("身份证号校验码不正确");
  }
  return normalized;
}

export function normalizePersonnelBankAccountNo(value) {
  const normalized = normalizedText(value, "银行卡号", 24);
  if (!normalized) return "";
  if (!/^\d{12,24}$/.test(normalized)) {
    throw new Error("银行卡号必须是 12 至 24 位数字");
  }
  return normalized;
}

function normalizedBirthMonth(value) {
  const normalized = normalizedText(value, "出生年月", 7);
  if (!normalized) return "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(normalized)) throw new Error("出生年月格式不正确");
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (normalized < "1900-01" || normalized > currentMonth) throw new Error("出生年月不在有效范围内");
  return normalized;
}

function normalizedEmail(value) {
  const normalized = normalizedText(value, "邮箱", 120);
  if (normalized && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) throw new Error("邮箱格式不正确");
  return normalized;
}

function normalizedPhone(value) {
  const normalized = normalizedText(value, "电话", 32);
  if (normalized && !/^\+?[0-9][0-9 ()-]{5,31}$/.test(normalized)) throw new Error("电话格式不正确");
  return normalized;
}

export function attachmentKindForPersonnelProfileField(field) {
  return ATTACHMENT_KIND_BY_FIELD[String(field ?? "")] ?? "";
}

export function sanitizePersonnelAttachmentMetadata(value, expectedKind = "") {
  if (value == null || value === "") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("人员资料附件格式不正确");
  const id = normalizedText(value.id, "附件 ID", 128);
  const kind = normalizedText(value.kind, "附件类型", 40);
  const originalName = normalizedText(value.originalName, "附件名称", 120);
  const mime = normalizedText(value.mime, "附件格式", 120).toLowerCase();
  const size = Number(value.size ?? 0);
  if (!id) throw new Error("人员资料附件缺少 ID");
  if (!kind || (expectedKind && kind !== expectedKind)) throw new Error("人员资料附件类型不匹配");
  if (!originalName) throw new Error("人员资料附件缺少文件名");
  if (!mime.startsWith("image/")) throw new Error("人员资料附件必须是图片");
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("人员资料附件大小不正确");
  return { id, kind, originalName, mime, size };
}

export function normalizePersonnelEducationLevel(value) {
  const normalized = String(value ?? "").trim();
  return PERSONNEL_EDUCATION_LEVELS.includes(normalized) ? normalized : "";
}

export function normalizePersonnelSelfProfile(input = {}, options = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const gender = ["male", "female", "other"].includes(source.gender) ? source.gender : "";
  const educationLevel = normalizePersonnelEducationLevel(source.educationLevel);
  const birthMonth = normalizedBirthMonth(source.birthMonth ?? String(source.birthDate ?? "").slice(0, 7));
  const idCardNo = normalizePersonnelIdCardNo(source.idCardNo);
  if (idCardNo && birthMonth) {
    const compactBirthMonth = idCardNo.length === 15
      ? `19${idCardNo.slice(6, 8)}-${idCardNo.slice(8, 10)}`
      : `${idCardNo.slice(6, 10)}-${idCardNo.slice(10, 12)}`;
    if (compactBirthMonth !== birthMonth) throw new Error("出生年月与身份证号不一致");
  }
  const profile = {
    name: normalizedText(source.name, "姓名", 80),
    gender,
    nativePlace: normalizedText(source.nativePlace, "籍贯", 120),
    birthMonth,
    educationLevel,
    idCardNo,
    idCardFrontAttachment: sanitizePersonnelAttachmentMetadata(source.idCardFrontAttachment, "id_card_front"),
    idCardBackAttachment: sanitizePersonnelAttachmentMetadata(source.idCardBackAttachment, "id_card_back"),
    educationProofAttachment: sanitizePersonnelAttachmentMetadata(source.educationProofAttachment, "education_proof"),
    phone: normalizedPhone(source.phone),
    email: normalizedEmail(source.email),
    wechat: normalizedText(source.wechat, "微信", 80),
    address: normalizedText(source.address, "住址", 240),
    bankAccountName: normalizedText(source.bankAccountName, "工资账户户名", 80),
    bankAccountNo: normalizePersonnelBankAccountNo(source.bankAccountNo),
    bankName: normalizedText(source.bankName, "开户行", 120),
  };
  if (options.requireComplete === true) assertPersonnelSelfProfileComplete(profile);
  return profile;
}

export function missingPersonnelProfileFields(profile = {}) {
  const source = profile && typeof profile === "object" ? profile : {};
  return PERSONNEL_SELF_PROFILE_FIELDS.filter((field) => {
    if (PERSONNEL_PROFILE_ATTACHMENT_FIELDS.includes(field)) return !source[field]?.id;
    return !String(source[field] ?? "").trim();
  });
}

export function isPersonnelProfileComplete(profile = {}) {
  return missingPersonnelProfileFields(profile).length === 0;
}

export function assertPersonnelSelfProfileComplete(profile = {}) {
  const missing = missingPersonnelProfileFields(profile);
  if (missing.length === 0) return profile;
  const labels = missing.map((field) => PERSONNEL_PROFILE_FIELD_DEFINITIONS[field]?.label ?? field);
  throw new Error(`请完整填写人员资料：${labels.join("、")}`);
}

export function personnelSelfProfileSnapshot(profile = {}) {
  return Object.fromEntries(PERSONNEL_SELF_PROFILE_FIELDS.map((field) => [
    field,
    PERSONNEL_PROFILE_ATTACHMENT_FIELDS.includes(field)
      ? sanitizePersonnelAttachmentMetadata(profile?.[field], attachmentKindForPersonnelProfileField(field))
      : String(profile?.[field] ?? ""),
  ]));
}

function comparableValue(value) {
  if (!value || typeof value !== "object") return String(value ?? "");
  return JSON.stringify(sanitizePersonnelAttachmentMetadata(value, value.kind));
}

export function changedPersonnelSelfProfileFields(before = {}, after = {}) {
  return PERSONNEL_SELF_PROFILE_FIELDS.filter((field) => comparableValue(before?.[field]) !== comparableValue(after?.[field]));
}

function displayValue(field, value) {
  if (field === "gender") return GENDER_LABELS[value] ?? String(value ?? "");
  if (field === "educationLevel") return EDUCATION_LABELS[value] ?? String(value ?? "");
  return String(value ?? "");
}

export function personnelProfileChangeDetails(before = {}, after = {}, fields = null) {
  const selected = Array.isArray(fields) ? fields : changedPersonnelSelfProfileFields(before, after);
  return selected.flatMap((field) => {
    const definition = PERSONNEL_PROFILE_FIELD_DEFINITIONS[field];
    if (!definition) return [];
    const base = {
      field,
      label: definition.label,
      section: definition.section,
      sensitive: definition.sensitive === true,
    };
    if (definition.attachment) {
      return [{
        ...base,
        beforeAttachment: sanitizePersonnelAttachmentMetadata(before?.[field], attachmentKindForPersonnelProfileField(field)),
        afterAttachment: sanitizePersonnelAttachmentMetadata(after?.[field], attachmentKindForPersonnelProfileField(field)),
      }];
    }
    return [{
      ...base,
      beforeValue: displayValue(field, before?.[field]),
      afterValue: displayValue(field, after?.[field]),
    }];
  });
}
