import test from "node:test";
import assert from "node:assert/strict";
import {
  backfillOrderContactPersonnelIds,
  canViewPersonnelOperationLogs,
  hasPersonnelAccount,
  isPersonnelActiveProfile,
  isPersonnelAccountEnabled,
  normalizePersonnelBankAccountNo,
  normalizePersonnelGender,
  normalizePersonnelIdCardNo,
  normalizePersonnelSensitiveFields,
  missingPersonnelRecordFields,
  redactPersonnelForViewer,
  resolveActivePersonnelReference,
} from "./personnel-rules.mjs";

test("operation logs are server-projected only to enabled administrators", () => {
  assert.equal(canViewPersonnelOperationLogs({ username: "admin", accessRole: "admin", accountEnabled: true }), true);
  assert.equal(canViewPersonnelOperationLogs({ username: "staff", accessRole: "staff", accountEnabled: true }), false);
  assert.equal(canViewPersonnelOperationLogs({ username: "admin", accessRole: "admin", accountEnabled: false }), false);
});

test("a personnel profile can exist without a system account", () => {
  const person = { name: "新员工", username: "", accountEnabled: false };
  assert.equal(hasPersonnelAccount(person), false);
  assert.equal(isPersonnelAccountEnabled(person), false);
});

test("disabled and resigned accounts are not active login accounts", () => {
  assert.equal(isPersonnelAccountEnabled({ username: "staff", accountEnabled: true }), true);
  assert.equal(isPersonnelAccountEnabled({ username: "staff", accountEnabled: false }), false);
  assert.equal(isPersonnelAccountEnabled({ username: "staff", employmentStatus: "resigned" }), false);
});

test("active personnel profiles do not require a login account", () => {
  assert.equal(isPersonnelActiveProfile({ id: "p-1", username: "" }), true);
  assert.equal(isPersonnelActiveProfile({ id: "p-2", employmentStatus: "resigned" }), false);
});

test("order personnel references prefer stable IDs and reject ambiguous legacy names", () => {
  const people = [
    { id: "p-1", name: "王芳", username: "wangfang" },
    { id: "p-2", name: "王芳", username: "wangfang-2" },
    { id: "p-3", name: "李雷", username: "" },
  ];
  assert.equal(resolveActivePersonnelReference(people, {
    personnelId: "p-2",
    reference: "王芳",
  }).person?.id, "p-2");
  assert.equal(resolveActivePersonnelReference(people, { reference: "王芳" }).status, "ambiguous");
  assert.equal(resolveActivePersonnelReference(people, { reference: "李雷" }).person?.id, "p-3");
  assert.equal(resolveActivePersonnelReference(people, {
    personnelId: "missing",
    reference: "李雷",
  }).status, "invalid-id");
});

test("legacy orders only receive a personnel ID when the reference is unique", () => {
  const people = [
    { id: "p-1", name: "王芳", username: "wangfang" },
    { id: "p-2", name: "王芳", username: "wangfang-2" },
    { id: "p-3", name: "李雷", username: "" },
  ];
  const orders = backfillOrderContactPersonnelIds(people, [
    { id: "o-1", contactPerson: "王芳" },
    { id: "o-2", contactPerson: "李雷" },
    { id: "o-3", contactPersonnelId: "p-1", contactPerson: "旧快照" },
  ]);
  assert.equal(orders[0].contactPersonnelId, undefined);
  assert.equal(orders[1].contactPersonnelId, "p-3");
  assert.equal(orders[1].contactPerson, "李雷");
  assert.equal(orders[2].contactPerson, "旧快照");
});

test("legacy order backfill considers resigned personnel before deciding uniqueness", () => {
  const people = [
    { id: "p-former", name: "张三", username: "former-zhang", employmentStatus: "resigned" },
    { id: "p-current", name: "张三", username: "current-zhang", employmentStatus: "active" },
    { id: "p-former-only", name: "李四", username: "former-li", employmentStatus: "resigned" },
  ];
  const orders = backfillOrderContactPersonnelIds(people, [
    { id: "o-ambiguous", contactPerson: "张三" },
    { id: "o-former", contactPerson: "李四" },
  ]);
  assert.equal(orders[0].contactPersonnelId, undefined);
  assert.equal(orders[1].contactPersonnelId, "p-former-only");
});

test("personnel gender only accepts supported values", () => {
  assert.equal(normalizePersonnelGender("female"), "female");
  assert.equal(normalizePersonnelGender("unknown"), "");
});

test("personnel identity card numbers validate date and checksum", () => {
  assert.equal(normalizePersonnelIdCardNo("11010519491231002x"), "11010519491231002X");
  assert.equal(normalizePersonnelIdCardNo("130503670401001"), "130503670401001");
  assert.equal(normalizePersonnelIdCardNo(""), "");
  assert.throws(() => normalizePersonnelIdCardNo("11010519491331002X"), /身份证号格式不正确/);
  assert.throws(() => normalizePersonnelIdCardNo("110105194912310021"), /校验码不正确/);
  assert.throws(() => normalizePersonnelIdCardNo("11010519491231ABCD"), /身份证号格式不正确/);
});

test("bank account numbers only accept a reasonable number of digits", () => {
  assert.equal(normalizePersonnelBankAccountNo("6222021001116245"), "6222021001116245");
  assert.equal(normalizePersonnelBankAccountNo(""), "");
  assert.throws(() => normalizePersonnelBankAccountNo("6222 0210 0111 6245"), /12 至 24 位数字/);
  assert.throws(() => normalizePersonnelBankAccountNo("12345678901"), /12 至 24 位数字/);
  assert.throws(() => normalizePersonnelBankAccountNo("1234567890123456789012345"), /不能超过 24/);
});

test("sensitive personnel fields are optional for legacy records and length-limited", () => {
  assert.deepEqual(normalizePersonnelSensitiveFields({}), {
    idCardNo: "",
    bankAccountName: "",
    bankAccountNo: "",
    bankName: "",
  });
  assert.deepEqual(normalizePersonnelSensitiveFields({
    idCardNo: "11010519491231002X",
    bankAccountName: "张三",
    bankAccountNo: "6222021001116245",
    bankName: "中国工商银行南京支行",
  }), {
    idCardNo: "11010519491231002X",
    bankAccountName: "张三",
    bankAccountNo: "6222021001116245",
    bankName: "中国工商银行南京支行",
  });
  assert.throws(() => normalizePersonnelSensitiveFields({ bankAccountName: "a".repeat(81) }), /银行账户名不能超过 80/);
  assert.throws(() => normalizePersonnelSensitiveFields({ bankName: "开户行\n分行" }), /不能包含换行/);
  assert.throws(() => normalizePersonnelSensitiveFields({ bankAccountName: 123 }), /银行账户名格式不正确/);
});

test("ordinary staff only receive operational personnel fields", () => {
  const source = {
    id: "p-1",
    personnelNo: "RY-0001",
    name: "张三",
    department: "养护部",
    role: "养护员",
    siteIds: ["nanjing"],
    gender: "male",
    birthDate: "1990-01-01",
    phone: "13800000000",
    address: "示例地址",
    username: "zhangsan",
    accessRole: "staff",
    accountEnabled: true,
    visibleSiteIds: ["nanjing"],
    permissions: { orders: { create: true } },
    idCardNo: "should-never-leak",
    bankAccountName: "张三",
    bankAccountNo: "6222021001116245",
    bankName: "某银行",
  };
  assert.deepEqual(redactPersonnelForViewer(source), {
    id: "p-1",
    personnelNo: "RY-0001",
    name: "张三",
    department: "养护部",
    role: "养护员",
    siteIds: ["nanjing"],
  });
  assert.equal(source.phone, "13800000000");
});

test("unknown future profile fields fail closed for staff and self projections", () => {
  const source = {
    id: "p-1",
    name: "张三",
    phone: "13800000000",
    idCardNo: "11010519491231002X",
    bankAccountName: "张三",
    bankAccountNo: "6222021001116245",
    bankName: "某银行",
    futurePayrollSecret: "secret",
  };
  assert.equal(redactPersonnelForViewer(source).idCardNo, undefined);
  assert.equal(redactPersonnelForViewer(source, { canViewPrivate: true, canViewAccount: true }).idCardNo, undefined);
  assert.equal(redactPersonnelForViewer(source, { canViewPrivate: true }).phone, "13800000000");
  assert.equal(redactPersonnelForViewer(source, { canViewSensitive: true }).idCardNo, "11010519491231002X");
  assert.equal(redactPersonnelForViewer(source, { canViewSensitive: true }).bankAccountNo, "6222021001116245");
  assert.equal(redactPersonnelForViewer(source, { canViewSensitive: true }).futurePayrollSecret, undefined);
});

test("profile completeness covers self, employment and enabled account fields but remains private", () => {
  const complete = {
    id: "p-1",
    personnelNo: "RY-0001",
    name: "张三",
    gender: "male",
    nativePlace: "江苏南京",
    birthMonth: "1949-12",
    educationLevel: "bachelor",
    idCardNo: "encrypted-id-card",
    idCardFrontAttachment: { id: "front" },
    idCardBackAttachment: { id: "back" },
    educationProofAttachment: { id: "education" },
    phone: "13800000000",
    email: "zhang@example.com",
    wechat: "zhang",
    address: "南京市示例地址",
    bankAccountName: "encrypted-name",
    bankAccountNo: "encrypted-account",
    bankName: "encrypted-bank",
    department: "销售部",
    role: "销售",
    hireDate: "2026-01-01",
    siteIds: ["nanjing"],
    username: "zhang",
    password: "scrypt$1$salt$hash",
    accountEnabled: true,
    accessRole: "staff",
  };
  assert.deepEqual(missingPersonnelRecordFields(complete), []);
  assert.equal(redactPersonnelForViewer(complete).profileComplete, undefined);
  const ownProjection = redactPersonnelForViewer(complete, { canViewPrivate: true, canViewAccount: true });
  assert.equal(ownProjection.profileComplete, true);
  assert.deepEqual(ownProjection.missingProfileFields, []);

  const incomplete = { ...complete, department: "", siteIds: [], accountEnabled: false };
  assert.deepEqual(missingPersonnelRecordFields(incomplete), ["department", "siteIds", "systemAccount"]);
  const incompleteProjection = redactPersonnelForViewer(incomplete, { canViewPrivate: true });
  assert.equal(incompleteProjection.profileComplete, false);
  assert.deepEqual(incompleteProjection.missingProfileFields, ["department", "siteIds", "systemAccount"]);
});

test("sensitive projection includes only canonical identity, payroll and attachment metadata fields", () => {
  const source = {
    id: "p-1",
    idCardNo: "encrypted-id",
    idCardFrontAttachment: { id: "front", kind: "id_card_front" },
    idCardBackAttachment: { id: "back", kind: "id_card_back" },
    educationProofAttachment: { id: "education", kind: "education_proof" },
    bankAccountName: "encrypted-name",
    bankAccountNo: "encrypted-account",
    bankName: "encrypted-bank",
    privateAttachmentStoragePath: "/must/not/leak",
  };
  const projected = redactPersonnelForViewer(source, { canViewSensitive: true });
  assert.equal(projected.idCardFrontAttachment.id, "front");
  assert.equal(projected.educationProofAttachment.id, "education");
  assert.equal(projected.privateAttachmentStoragePath, undefined);
});
