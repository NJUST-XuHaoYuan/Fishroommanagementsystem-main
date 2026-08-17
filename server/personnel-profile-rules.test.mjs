import test from "node:test";
import assert from "node:assert/strict";
import {
  changedPersonnelSelfProfileFields,
  isPersonnelProfileComplete,
  missingPersonnelProfileFields,
  normalizePersonnelEducationLevel,
  normalizePersonnelSelfProfile,
  personnelProfileChangeDetails,
  sanitizePersonnelAttachmentMetadata,
} from "./personnel-profile-rules.mjs";

const attachment = (id, kind) => ({
  id,
  kind,
  originalName: `${id}.jpg`,
  mime: "image/jpeg",
  size: 1024,
  storageKey: "must-not-leak",
  personnelId: "person-1",
});

const completeProfile = {
  name: "张三",
  gender: "male",
  nativePlace: "江苏南京",
  birthMonth: "1949-12",
  educationLevel: "bachelor",
  idCardNo: "11010519491231002X",
  idCardFrontAttachment: attachment("front", "id_card_front"),
  idCardBackAttachment: attachment("back", "id_card_back"),
  educationProofAttachment: attachment("education", "education_proof"),
  phone: "13800000000",
  email: "zhangsan@example.com",
  wechat: "zhangsan",
  address: "南京市示例地址",
  bankAccountName: "张三",
  bankAccountNo: "6222021001116245",
  bankName: "中国工商银行南京支行",
};

test("personnel self profile uses the fixed education enum and YYYY-MM birth month", () => {
  assert.equal(normalizePersonnelEducationLevel("college"), "college");
  assert.equal(normalizePersonnelEducationLevel("unknown"), "");
  assert.equal(normalizePersonnelSelfProfile(completeProfile, { requireComplete: true }).birthMonth, "1949-12");
  assert.throws(() => normalizePersonnelSelfProfile({ ...completeProfile, birthMonth: "1990-13" }), /出生年月格式/);
  assert.throws(() => normalizePersonnelSelfProfile({ ...completeProfile, birthMonth: "1990-01" }), /与身份证号不一致/);
  assert.throws(() => normalizePersonnelSelfProfile({ ...completeProfile, educationLevel: "unknown" }, { requireComplete: true }), /学历学位/);
  assert.equal(normalizePersonnelSelfProfile({
    ...completeProfile,
    birthMonth: "1967-04",
    idCardNo: "130503670401001",
  }, { requireComplete: true }).birthMonth, "1967-04");
  assert.throws(() => normalizePersonnelSelfProfile({
    ...completeProfile,
    birthMonth: "1967-05",
    idCardNo: "130503670401001",
  }), /与身份证号不一致/);
});

test("all self-owned profile fields are required only when strict completeness is requested", () => {
  const incomplete = normalizePersonnelSelfProfile({ name: "旧员工" });
  assert.equal(isPersonnelProfileComplete(incomplete), false);
  assert.ok(missingPersonnelProfileFields(incomplete).includes("idCardFrontAttachment"));
  assert.throws(() => normalizePersonnelSelfProfile({ name: "旧员工" }, { requireComplete: true }), /完整填写人员资料/);
  assert.equal(isPersonnelProfileComplete(normalizePersonnelSelfProfile(completeProfile, { requireComplete: true })), true);
});

test("attachment metadata is allowlisted and kind-bound", () => {
  assert.deepEqual(sanitizePersonnelAttachmentMetadata(
    attachment("front", "id_card_front"),
    "id_card_front"
  ), {
    id: "front",
    kind: "id_card_front",
    originalName: "front.jpg",
    mime: "image/jpeg",
    size: 1024,
  });
  assert.throws(() => sanitizePersonnelAttachmentMetadata(
    attachment("front", "id_card_back"),
    "id_card_front"
  ), /类型不匹配/);
});

test("profile changes are allowlisted and expose attachment metadata separately", () => {
  const after = {
    ...completeProfile,
    name: "李三",
    idCardFrontAttachment: attachment("front-new", "id_card_front"),
    futureSecret: "must-not-appear",
  };
  const fields = changedPersonnelSelfProfileFields(completeProfile, after);
  assert.deepEqual(fields, ["name", "idCardFrontAttachment"]);
  const changes = personnelProfileChangeDetails(completeProfile, after, fields);
  assert.equal(changes[0].afterValue, "李三");
  assert.deepEqual(changes[1].afterAttachment, {
    id: "front-new",
    kind: "id_card_front",
    originalName: "front-new.jpg",
    mime: "image/jpeg",
    size: 1024,
  });
  assert.equal(changes.some((change) => change.field === "futureSecret"), false);
});

test("profile contact formats fail closed", () => {
  assert.throws(() => normalizePersonnelSelfProfile({ ...completeProfile, email: "not-an-email" }), /邮箱格式/);
  assert.throws(() => normalizePersonnelSelfProfile({ ...completeProfile, phone: "abc" }), /电话格式/);
  assert.throws(() => normalizePersonnelSelfProfile({ ...completeProfile, address: "a\nb" }), /不能包含换行/);
});
