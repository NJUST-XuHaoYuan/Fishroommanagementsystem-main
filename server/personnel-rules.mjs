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
  "birthDate",
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

export function hasPersonnelAccount(person = {}) {
  return Boolean(String(person?.username ?? "").trim());
}

export function isPersonnelAccountEnabled(person = {}) {
  return hasPersonnelAccount(person) &&
    person?.accountEnabled !== false &&
    person?.employmentStatus !== "resigned" &&
    !person?.resignedAt;
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
  const normalized = normalizedSensitiveText(value, "身份证号", 18).toUpperCase();
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
  const normalized = normalizedSensitiveText(value, "银行卡号", 24);
  if (!normalized) return "";
  if (!/^\d{12,24}$/.test(normalized)) {
    throw new Error("银行卡号必须是 12 至 24 位数字");
  }
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

export function redactPersonnelForViewer(
  person = {},
  { canViewPrivate = false, canViewAccount = false, canViewSensitive = false } = {}
) {
  if (!person || typeof person !== "object") return person;
  const allowedFields = [
    ...DIRECTORY_FIELDS,
    ...(canViewPrivate ? PRIVATE_PROFILE_FIELDS : []),
    ...(canViewAccount ? ACCOUNT_SECURITY_FIELDS : []),
    ...(canViewSensitive ? SENSITIVE_PROFILE_FIELDS : []),
  ];
  return Object.fromEntries(allowedFields
    .filter((field) => Object.prototype.hasOwnProperty.call(person, field))
    .map((field) => [field, person[field]]));
}
