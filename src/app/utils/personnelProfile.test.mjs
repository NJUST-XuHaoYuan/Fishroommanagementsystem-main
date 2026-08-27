import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyPersonnelSelfProfile,
  maskedSensitiveValue,
  normalizePersonnelProfileAttachment,
  normalizePersonnelSelfProfileResult,
  personnelSelfProfileSubmission,
  validatePersonnelSelfProfile,
} from "./personnelProfile.ts";

const attachments = {
  idCardFrontAttachment: {
    id: "attachment-front",
    kind: "id_card_front",
    originalName: "身份证正面.jpg",
    mime: "image/jpeg",
    size: 128,
  },
  idCardBackAttachment: {
    id: "attachment-back",
    kind: "id_card_back",
    originalName: "身份证反面.jpg",
    mime: "image/jpeg",
    size: 256,
  },
  educationProofAttachment: {
    id: "attachment-education",
    kind: "education_proof",
    originalName: "学历证明.jpg",
    mime: "image/jpeg",
    size: 512,
  },
};

function completeProfile() {
  return {
    ...emptyPersonnelSelfProfile(),
    name: "张三",
    gender: "male",
    nativePlace: "江苏南京",
    birthMonth: "1949-12",
    educationLevel: "college",
    idCardNo: "11010519491231002X",
    ...attachments,
    phone: "13800000000",
    email: "zhangsan@example.com",
    wechat: "zhangsan_wechat",
    address: "南京市示例地址",
    bankAccountName: "张三",
    bankAccountNo: "6222021001116245",
    bankName: "中国工商银行南京支行",
    profileRevision: "revision-1",
  };
}

test("requires every editable profile field and all three attachments", () => {
  const errors = validatePersonnelSelfProfile(emptyPersonnelSelfProfile());
  assert.equal(errors.name, "请填写姓名");
  assert.equal(errors.phone, "请填写联系电话");
  assert.equal(errors.bankAccountNo, "请填写工资银行卡号");
  assert.equal(errors.idCardFrontAttachment, "请上传身份证件正面");
  assert.equal(errors.idCardBackAttachment, "请上传身份证件反面");
  assert.equal(errors.educationProofAttachment, "请上传学历证明");
  assert.equal("emergencyContact" in errors, false);
});

test("accepts a complete valid profile", () => {
  assert.deepEqual(validatePersonnelSelfProfile(completeProfile()), {});
});

test("administrator-managed employment and account gaps do not block self-profile validation", () => {
  assert.deepEqual(validatePersonnelSelfProfile({
    ...completeProfile(),
    personnelNo: "",
    employment: { department: "", role: "", hireDate: "", siteIds: [] },
    account: {},
  }), {});
});

test("validates key identity, contact, month and bank formats", () => {
  const profile = {
    ...completeProfile(),
    birthMonth: "2999-01",
    idCardNo: "123",
    phone: "abc",
    email: "invalid",
    bankAccountNo: "123",
  };
  const errors = validatePersonnelSelfProfile(profile);
  assert.match(errors.birthMonth, /不能晚于/);
  assert.match(errors.idCardNo, /15 位或 18 位/);
  assert.match(errors.phone, /联系电话/);
  assert.match(errors.email, /邮箱/);
  assert.match(errors.bankAccountNo, /12 至 24 位/);
});

test("rejects a birth month before the server-supported lower bound", () => {
  const errors = validatePersonnelSelfProfile({ ...completeProfile(), birthMonth: "1899-12" });
  assert.match(errors.birthMonth, /不能早于 1900/);
});

test("normalizes the canonical self-profile response", () => {
  const normalized = normalizePersonnelSelfProfileResult({
    ok: true,
    profile: {
      ...completeProfile(),
      personnelNo: "RY-0001",
      profileRevision: "revision-2",
      employment: { department: "销售组", role: "销售", siteIds: ["nanjing"] },
      account: { personnelId: "person-1", username: "zhangsan", accountEnabled: true, accessRole: "staff" },
    },
    request: { id: "request-1", status: "rejected", resolutionNote: "银行卡信息不清晰" },
  });
  assert.equal(normalized.profile.birthMonth, "1949-12");
  assert.equal(normalized.profile.educationLevel, "college");
  assert.equal(normalized.profile.idCardFrontAttachment.id, "attachment-front");
  assert.equal(normalized.profile.employment.department, "销售组");
  assert.equal(normalized.profile.account.username, "zhangsan");
  assert.equal(normalized.request.status, "rejected");
});

test("rejects an attachment whose metadata kind does not match its slot", () => {
  assert.equal(normalizePersonnelProfileAttachment({
    id: "attachment-1",
    kind: "education_proof",
    originalName: "wrong.jpg",
  }, "id_card_front"), null);
});

test("builds a minimal submit body and keeps only canonical attachment metadata", () => {
  const body = personnelSelfProfileSubmission({
    ...completeProfile(),
    idCardFrontAttachment: {
      ...attachments.idCardFrontAttachment,
      ignoredUrl: "https://example.invalid/private",
    },
    personnelNo: "RY-0001",
    employment: { department: "销售组" },
    account: { username: "zhangsan" },
  });
  assert.equal(body.baseProfileRevision, "revision-1");
  assert.equal(body.profile.idCardFrontAttachment.originalName, "身份证正面.jpg");
  assert.equal("ignoredUrl" in body.profile.idCardFrontAttachment, false);
  assert.equal("employment" in body.profile, false);
  assert.equal("account" in body.profile, false);
  assert.equal("personnelNo" in body.profile, false);
});

test("uses the rejected or pending draft for editable fields but keeps formal read-only data", () => {
  const normalized = normalizePersonnelSelfProfileResult({
    profile: {
      ...completeProfile(),
      name: "正式姓名",
      profileRevision: "formal-revision",
      employment: { department: "正式部门" },
      account: { username: "formal-account", accountEnabled: true, accessRole: "staff" },
    },
    draftProfile: {
      ...completeProfile(),
      name: "待修改姓名",
      employment: { department: "不应采用的部门" },
      account: { username: "should-not-win" },
      profileRevision: "draft-revision",
    },
    request: { id: "request-rejected", status: "rejected", resolutionNote: "请修改" },
  });
  assert.equal(normalized.profile.name, "待修改姓名");
  assert.equal(normalized.profile.employment.department, "正式部门");
  assert.equal(normalized.profile.account.username, "formal-account");
  assert.equal(normalized.profile.profileRevision, "formal-revision");
});

test("rejects an ID number whose embedded birth month differs from the form", () => {
  const errors = validatePersonnelSelfProfile({ ...completeProfile(), birthMonth: "1990-03" });
  assert.match(errors.idCardNo, /出生年月与所填出生年月不一致/);
});

test("masks sensitive values while retaining the final four characters", () => {
  assert.equal(maskedSensitiveValue("6222021001116245"), "••••••••••••6245");
  assert.equal(maskedSensitiveValue(""), "");
});
