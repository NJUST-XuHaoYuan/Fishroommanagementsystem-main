import type {
  PersonnelProfileAttachment,
  PersonnelProfileAttachmentKind,
  PersonnelProfileRequest,
  PersonnelProfileRequestStatus,
  PersonnelSelfProfile,
  PersonnelSelfProfileForm,
} from "../store";

export const PROFILE_ATTACHMENT_KINDS = {
  idCardFrontAttachment: "id_card_front",
  idCardBackAttachment: "id_card_back",
  educationProofAttachment: "education_proof",
} as const satisfies Record<string, PersonnelProfileAttachmentKind>;

export type PersonnelProfileField = keyof PersonnelSelfProfileForm;
export type PersonnelProfileErrors = Partial<Record<PersonnelProfileField, string>>;

export const PERSONNEL_PROFILE_FIELD_LABELS: Record<PersonnelProfileField, string> = {
  name: "姓名",
  gender: "性别",
  nativePlace: "籍贯",
  birthMonth: "出生年月",
  educationLevel: "最高学历",
  idCardNo: "身份证件号码",
  idCardFrontAttachment: "身份证件正面",
  idCardBackAttachment: "身份证件反面",
  educationProofAttachment: "学历证明",
  phone: "联系电话",
  email: "邮箱",
  wechat: "微信号",
  address: "联系地址",
  bankAccountName: "工资账户开户名",
  bankAccountNo: "工资银行卡号",
  bankName: "工资账户开户行",
};

const PROFILE_REQUEST_STATUSES = new Set<PersonnelProfileRequestStatus>([
  "pending",
  "approved",
  "rejected",
  "superseded",
  "cancelled",
]);

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => text(item)).filter((item, index, all) => item && all.indexOf(item) === index)
    : [];
}

export function emptyPersonnelSelfProfile(): PersonnelSelfProfile {
  return {
    name: "",
    gender: "",
    nativePlace: "",
    birthMonth: "",
    educationLevel: "",
    idCardNo: "",
    idCardFrontAttachment: null,
    idCardBackAttachment: null,
    educationProofAttachment: null,
    phone: "",
    email: "",
    wechat: "",
    address: "",
    bankAccountName: "",
    bankAccountNo: "",
    bankName: "",
    personnelNo: "",
    employment: {},
    account: {},
    profileRevision: "",
    missingFields: [],
  };
}

export function normalizePersonnelProfileAttachment(
  value: unknown,
  expectedKind: PersonnelProfileAttachmentKind
): PersonnelProfileAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = text(source.id);
  const receivedKind = text(source.kind);
  if (!id || (receivedKind && receivedKind !== expectedKind)) return null;
  const size = Number(source.size);
  return {
    id,
    kind: expectedKind,
    ...(text(source.originalName) ? { originalName: text(source.originalName) } : {}),
    ...(text(source.mime) ? { mime: text(source.mime) } : {}),
    ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
    ...(text(source.uploadedAt) ? { uploadedAt: text(source.uploadedAt) } : {}),
  };
}

function normalizeRequest(value: unknown): PersonnelProfileRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const id = text(source.id);
  const status = text(source.status) as PersonnelProfileRequestStatus;
  if (!id || !PROFILE_REQUEST_STATUSES.has(status)) return null;
  return {
    id,
    status,
    ...(text(source.createdAt) ? { createdAt: text(source.createdAt) } : {}),
    ...(text(source.resolvedAt) ? { resolvedAt: text(source.resolvedAt) } : {}),
    ...(text(source.resolvedBy) ? { resolvedBy: text(source.resolvedBy) } : {}),
    ...(text(source.resolvedByName) ? { resolvedByName: text(source.resolvedByName) } : {}),
    ...(text(source.resolutionNote) ? { resolutionNote: text(source.resolutionNote) } : {}),
    ...(Array.isArray(source.changedFields) ? { changedFields: stringArray(source.changedFields) } : {}),
  };
}

export function normalizePersonnelSelfProfileResult(value: unknown): {
  profile: PersonnelSelfProfile;
  request: PersonnelProfileRequest | null;
} {
  const result = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const profileSource = result.profile && typeof result.profile === "object" && !Array.isArray(result.profile)
    ? result.profile as Record<string, unknown>
    : {};
  const request = normalizeRequest(result.request ?? result.pendingRequest ?? result.latestRequest);
  const draftSource = result.draftProfile && typeof result.draftProfile === "object" && !Array.isArray(result.draftProfile)
    ? result.draftProfile as Record<string, unknown>
    : null;
  const editableSource = draftSource && (request?.status === "pending" || request?.status === "rejected")
    ? draftSource
    : profileSource;
  const employmentSource = profileSource.employment && typeof profileSource.employment === "object" && !Array.isArray(profileSource.employment)
    ? profileSource.employment as Record<string, unknown>
    : {};
  const accountSource = profileSource.account && typeof profileSource.account === "object" && !Array.isArray(profileSource.account)
    ? profileSource.account as Record<string, unknown>
    : {};
  const gender = ["male", "female", "other"].includes(text(editableSource.gender))
    ? text(editableSource.gender) as PersonnelSelfProfile["gender"]
    : "";
  const educationLevel = ["high_school_or_below", "college", "bachelor", "master", "doctorate"]
    .includes(text(editableSource.educationLevel))
    ? text(editableSource.educationLevel) as PersonnelSelfProfile["educationLevel"]
    : "";

  const profile: PersonnelSelfProfile = {
    ...emptyPersonnelSelfProfile(),
    name: text(editableSource.name),
    gender,
    nativePlace: text(editableSource.nativePlace),
    birthMonth: text(editableSource.birthMonth),
    educationLevel,
    idCardNo: text(editableSource.idCardNo),
    idCardFrontAttachment: normalizePersonnelProfileAttachment(
      editableSource.idCardFrontAttachment,
      PROFILE_ATTACHMENT_KINDS.idCardFrontAttachment
    ),
    idCardBackAttachment: normalizePersonnelProfileAttachment(
      editableSource.idCardBackAttachment,
      PROFILE_ATTACHMENT_KINDS.idCardBackAttachment
    ),
    educationProofAttachment: normalizePersonnelProfileAttachment(
      editableSource.educationProofAttachment,
      PROFILE_ATTACHMENT_KINDS.educationProofAttachment
    ),
    phone: text(editableSource.phone),
    email: text(editableSource.email),
    wechat: text(editableSource.wechat),
    address: text(editableSource.address),
    bankAccountName: text(editableSource.bankAccountName),
    bankAccountNo: text(editableSource.bankAccountNo),
    bankName: text(editableSource.bankName),
    personnelNo: text(profileSource.personnelNo || employmentSource.personnelNo),
    employment: {
      personnelNo: text(employmentSource.personnelNo || profileSource.personnelNo),
      department: text(employmentSource.department),
      role: text(employmentSource.role),
      hireDate: text(employmentSource.hireDate),
      siteIds: stringArray(employmentSource.siteIds),
      employmentStatus: employmentSource.employmentStatus === "resigned" ? "resigned" : "active",
    },
    account: {
      personnelId: text(accountSource.personnelId),
      username: text(accountSource.username),
      accountEnabled: accountSource.accountEnabled !== false,
      accessRole: accountSource.accessRole === "admin" ? "admin" : "staff",
    },
    profileRevision: text(profileSource.profileRevision || result.profileRevision),
    missingFields: stringArray(editableSource.missingFields ?? profileSource.missingFields),
  };

  return {
    profile,
    request,
  };
}

function requiredText(
  profile: PersonnelSelfProfileForm,
  field: Exclude<PersonnelProfileField,
    "idCardFrontAttachment" | "idCardBackAttachment" | "educationProofAttachment">
): string {
  return text(profile[field]);
}

export function validatePersonnelSelfProfile(profile: PersonnelSelfProfileForm): PersonnelProfileErrors {
  const errors: PersonnelProfileErrors = {};
  const textFields: Array<Exclude<PersonnelProfileField,
    "idCardFrontAttachment" | "idCardBackAttachment" | "educationProofAttachment">> = [
      "name", "gender", "nativePlace", "birthMonth", "educationLevel", "idCardNo",
      "phone", "email", "wechat", "address",
      "bankAccountName", "bankAccountNo", "bankName",
    ];
  for (const field of textFields) {
    if (!requiredText(profile, field)) errors[field] = `请填写${PERSONNEL_PROFILE_FIELD_LABELS[field]}`;
  }
  if (!profile.idCardFrontAttachment) errors.idCardFrontAttachment = "请上传身份证件正面";
  if (!profile.idCardBackAttachment) errors.idCardBackAttachment = "请上传身份证件反面";
  if (!profile.educationProofAttachment) errors.educationProofAttachment = "请上传学历证明";

  if (profile.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email.trim())) {
    errors.email = "请输入正确的邮箱地址";
  }
  if (profile.birthMonth && !/^\d{4}-(0[1-9]|1[0-2])$/.test(profile.birthMonth)) {
    errors.birthMonth = "请选择正确的出生年月";
  } else if (profile.birthMonth) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (profile.birthMonth > currentMonth) errors.birthMonth = "出生年月不能晚于当前月份";
  }
  if (profile.idCardNo && !/^(?:[1-9]\d{14}|[1-9]\d{16}[\dXx])$/.test(profile.idCardNo.trim())) {
    errors.idCardNo = "请输入 15 位或 18 位身份证件号码";
  } else if (profile.idCardNo && profile.birthMonth) {
    const normalizedId = profile.idCardNo.trim().toUpperCase();
    const idBirthMonth = normalizedId.length === 15
      ? `19${normalizedId.slice(6, 8)}-${normalizedId.slice(8, 10)}`
      : `${normalizedId.slice(6, 10)}-${normalizedId.slice(10, 12)}`;
    if (idBirthMonth !== profile.birthMonth) {
      errors.idCardNo = "身份证件号码中的出生年月与所填出生年月不一致";
    }
  }
  if (profile.phone && !/^[+\d][\d\s()+-]{5,19}$/.test(profile.phone.trim())) {
    errors.phone = "请输入正确的联系电话";
  }
  if (profile.bankAccountNo && !/^\d{12,24}$/.test(profile.bankAccountNo.trim())) {
    errors.bankAccountNo = "银行卡号必须为 12 至 24 位数字";
  }
  return errors;
}

export function personnelSelfProfileSubmission(profile: PersonnelSelfProfile): {
  profile: PersonnelSelfProfileForm;
  baseProfileRevision: string;
} {
  const normalizedAttachment = (
    attachment: PersonnelProfileAttachment | null,
    kind: PersonnelProfileAttachmentKind
  ) => normalizePersonnelProfileAttachment(attachment, kind);
  return {
    profile: {
      name: text(profile.name),
      gender: profile.gender,
      nativePlace: text(profile.nativePlace),
      birthMonth: text(profile.birthMonth),
      educationLevel: profile.educationLevel,
      idCardNo: text(profile.idCardNo).toUpperCase(),
      idCardFrontAttachment: normalizedAttachment(profile.idCardFrontAttachment, "id_card_front"),
      idCardBackAttachment: normalizedAttachment(profile.idCardBackAttachment, "id_card_back"),
      educationProofAttachment: normalizedAttachment(profile.educationProofAttachment, "education_proof"),
      phone: text(profile.phone),
      email: text(profile.email),
      wechat: text(profile.wechat),
      address: text(profile.address),
      bankAccountName: text(profile.bankAccountName),
      bankAccountNo: text(profile.bankAccountNo),
      bankName: text(profile.bankName),
    },
    baseProfileRevision: text(profile.profileRevision),
  };
}

export function isPersonnelProfilePending(request: PersonnelProfileRequest | null): boolean {
  return request?.status === "pending";
}

export function maskedSensitiveValue(value: string, visibleTail = 4): string {
  const normalized = text(value);
  if (!normalized) return "";
  const tail = normalized.slice(-Math.max(0, visibleTail));
  return `${"•".repeat(Math.max(4, normalized.length - tail.length))}${tail}`;
}
