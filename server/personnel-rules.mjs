import {
  PERSONNEL_PROFILE_SENSITIVE_VALUE_FIELDS,
  PERSONNEL_SELF_PROFILE_FIELDS,
  missingPersonnelProfileFields,
  normalizePersonnelBankAccountNo,
  normalizePersonnelIdCardNo,
} from "./personnel-profile-rules.mjs";

export { normalizePersonnelBankAccountNo, normalizePersonnelIdCardNo };

const DIRECTORY_FIELDS = [
  "id",
  "personnelNo",
  "name",
  "department",
  "role",
  "siteIds",
  "employmentStatus",
];

const PRIVATE_PROFILE_FIELDS = [
  "gender",
  "nativePlace",
  "birthMonth",
  "educationLevel",
  "hireDate",
  "phone",
  "email",
  "wechat",
  "address",
  "emergencyContact",
  "emergencyPhone",
  "notes",
  "resignedAt",
];

const SENSITIVE_PROFILE_FIELDS = [
  "idCardNo",
  "idCardFrontAttachment",
  "idCardBackAttachment",
  "educationProofAttachment",
  "bankAccountName",
  "bankAccountNo",
  "bankName",
];

const ACCOUNT_SECURITY_FIELDS = [
  "username",
  "accessRole",
  "visibleSiteIds",
  "permissions",
  "accountEnabled",
];

const PROFILE_COMPLETENESS_FIELDS = [
  "profileComplete",
  "missingProfileFields",
];

export function hasPersonnelAccount(person = {}) {
  return Boolean(String(person?.username ?? "").trim());
}

export function isPersonnelAccountEnabled(person = {}) {
  return hasPersonnelAccount(person) &&
    person?.accountEnabled !== false &&
    person?.employmentStatus !== "resigned" &&
    !person?.resignedAt;
}

export function canViewPersonnelOperationLogs(person = {}) {
  return person?.accessRole === "admin" && isPersonnelAccountEnabled(person);
}

export function isPersonnelActiveProfile(person = {}) {
  return Boolean(person && typeof person === "object") &&
    person?.employmentStatus !== "resigned" &&
    !person?.resignedAt;
}

function normalizedReference(value) {
  return String(value ?? "").trim();
}

function personnelReferenceMatches(personnel = [], reference = "") {
  const requestedReference = normalizedReference(reference);
  if (!requestedReference) return [];
  return (Array.isArray(personnel) ? personnel : []).filter((person) =>
    normalizedReference(person?.name) === requestedReference ||
    normalizedReference(person?.username) === requestedReference
  );
}

export function resolveActivePersonnelReference(
  personnel = [],
  { personnelId = "", reference = "" } = {}
) {
  const people = Array.isArray(personnel) ? personnel : [];
  const requestedId = normalizedReference(personnelId);
  if (requestedId) {
    const person = people.find((item) =>
      normalizedReference(item?.id) === requestedId && isPersonnelActiveProfile(item)
    ) ?? null;
    return { status: person ? "matched" : "invalid-id", person };
  }

  const requestedReference = normalizedReference(reference);
  if (!requestedReference) return { status: "missing", person: null };
  const matches = personnelReferenceMatches(people, requestedReference);
  if (matches.length === 1 && isPersonnelActiveProfile(matches[0])) {
    return { status: "matched", person: matches[0] };
  }
  return { status: matches.length > 1 ? "ambiguous" : "not-found", person: null };
}

export function backfillOrderContactPersonnelIds(personnel = [], orders = []) {
  return (Array.isArray(orders) ? orders : []).map((order) => {
    if (!order || typeof order !== "object" || normalizedReference(order.contactPersonnelId)) return order;
    const matches = personnelReferenceMatches(personnel, order.contactPerson);
    if (matches.length !== 1) return order;
    const person = matches[0];
    return {
      ...order,
      contactPersonnelId: normalizedReference(person.id),
      contactPerson: normalizedReference(person.name),
    };
  });
}

export function normalizePersonnelGender(value) {
  return ["male", "female", "other"].includes(value) ? value : "";
}

function normalizedSensitiveText(value, label, maxLength) {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error(`${label}格式不正确`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  if (/[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label}不能包含换行或控制字符`);
  return normalized;
}

export function normalizePersonnelSensitiveFields(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    idCardNo: normalizePersonnelIdCardNo(source.idCardNo),
    bankAccountName: normalizedSensitiveText(source.bankAccountName, "银行账户名", 80),
    bankAccountNo: normalizePersonnelBankAccountNo(source.bankAccountNo),
    bankName: normalizedSensitiveText(source.bankName, "开户行", 120),
  };
}

export function applyApprovedPersonnelSelfProfile(
  person = {},
  normalizedProfile = {},
  encryptedSensitiveFields = {}
) {
  const nextPerson = { ...person };
  for (const field of PERSONNEL_SELF_PROFILE_FIELDS) {
    if (PERSONNEL_PROFILE_SENSITIVE_VALUE_FIELDS.includes(field)) {
      if (!Object.prototype.hasOwnProperty.call(encryptedSensitiveFields, field)) {
        throw new Error(`批准人员资料缺少已加密字段：${field}`);
      }
      nextPerson[field] = encryptedSensitiveFields[field];
      continue;
    }
    nextPerson[field] = normalizedProfile[field];
  }
  const currentRevision = Number(person?.profileRevision ?? 0);
  nextPerson.profileRevision = (Number.isSafeInteger(currentRevision) && currentRevision >= 0 ? currentRevision : 0) + 1;
  return nextPerson;
}

export function missingPersonnelRecordFields(person = {}) {
  const missing = [...missingPersonnelProfileFields(person)];
  if (!String(person?.department ?? "").trim()) missing.push("department");
  if (!String(person?.role ?? "").trim()) missing.push("role");
  if (!String(person?.hireDate ?? "").trim()) missing.push("hireDate");
  if (!Array.isArray(person?.siteIds) || person.siteIds.length === 0) missing.push("siteIds");
  if (!String(person?.username ?? "").trim() || person?.accountEnabled === false || !String(person?.password ?? "").trim()) {
    missing.push("systemAccount");
  }
  return [...new Set(missing)];
}

export function redactPersonnelForViewer(
  person = {},
  { canViewPrivate = false, canViewAccount = false, canViewSensitive = false } = {}
) {
  if (!person || typeof person !== "object") return person;
  const projectedPerson = { ...person };
  if (canViewPrivate) {
    projectedPerson.missingProfileFields = Array.isArray(person?.missingProfileFields)
      ? [...person.missingProfileFields]
      : missingPersonnelRecordFields(person);
    projectedPerson.profileComplete = projectedPerson.missingProfileFields.length === 0;
  }
  const allowedFields = [
    ...DIRECTORY_FIELDS,
    ...(canViewPrivate ? PRIVATE_PROFILE_FIELDS : []),
    ...(canViewPrivate ? PROFILE_COMPLETENESS_FIELDS : []),
    ...(canViewAccount ? ACCOUNT_SECURITY_FIELDS : []),
    ...(canViewSensitive ? SENSITIVE_PROFILE_FIELDS : []),
  ];
  return Object.fromEntries(allowedFields
    .filter((field) => Object.prototype.hasOwnProperty.call(projectedPerson, field))
    .map((field) => [field, projectedPerson[field]]));
}
