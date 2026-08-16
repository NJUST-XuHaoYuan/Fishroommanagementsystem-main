import test from "node:test";
import assert from "node:assert/strict";
import {
  canApproveCreditSale,
  creditSaleEligibleApprovers,
  creditSaleOrderOwner,
  isCreditSaleOrderOwner,
} from "./credit-sale-approval-rules.mjs";

const personnel = [
  { id: "p-admin-a", username: "admin-a", name: "管理员A", accessRole: "admin", employmentStatus: "active" },
  { id: "p-sales-a", username: "sales-a", name: "销售A", accessRole: "staff", employmentStatus: "active" },
  { id: "p-sales-b", username: "sales-b", name: "销售B", accessRole: "staff", employmentStatus: "active" },
  { id: "p-former-admin", username: "former-admin", name: "离职管理员", accessRole: "admin", employmentStatus: "resigned" },
];

test("active administrators and the order owner are eligible credit-sale approvers", () => {
  assert.deepEqual(
    creditSaleEligibleApprovers(personnel, { contactPerson: "销售A" }),
    [
      { username: "admin-a", name: "管理员A", isAdmin: true, isOrderOwner: false },
      { username: "sales-a", name: "销售A", isAdmin: false, isOrderOwner: true },
    ]
  );
});

test("an administrator who owns the order is returned once with both roles", () => {
  assert.deepEqual(
    creditSaleEligibleApprovers(personnel, { contactPerson: "admin-a" }),
    [{ username: "admin-a", name: "管理员A", isAdmin: true, isOrderOwner: true }]
  );
});

test("only the assigned active owner gains staff approval access", () => {
  const order = { contactPerson: "销售A" };
  assert.equal(canApproveCreditSale(personnel, order, "sales-a"), true);
  assert.equal(isCreditSaleOrderOwner(personnel, order, "sales-a"), true);
  assert.equal(canApproveCreditSale(personnel, order, "sales-b"), false);
  assert.equal(isCreditSaleOrderOwner(personnel, order, "admin-a"), false);
});

test("resigned personnel cannot remain the order owner approver", () => {
  const order = { contactPerson: "离职管理员" };
  assert.equal(creditSaleOrderOwner(personnel, order), null);
  assert.equal(canApproveCreditSale(personnel, order, "former-admin"), false);
});

test("stable personnel id wins over a stale display-name snapshot", () => {
  const order = { contactPersonnelId: "p-sales-b", contactPerson: "销售A" };
  assert.equal(creditSaleOrderOwner(personnel, order), personnel[2]);
  assert.equal(canApproveCreditSale(personnel, order, "sales-b"), true);
  assert.equal(canApproveCreditSale(personnel, order, "sales-a"), false);
});

test("legacy duplicate names are ambiguous and grant no owner approval", () => {
  const duplicatePersonnel = [
    ...personnel,
    { id: "p-sales-a-2", username: "sales-a-2", name: "销售A", accessRole: "staff", employmentStatus: "active" },
  ];
  const order = { contactPerson: "销售A" };
  assert.equal(creditSaleOrderOwner(duplicatePersonnel, order), null);
  assert.equal(canApproveCreditSale(duplicatePersonnel, order, "sales-a"), false);
  assert.equal(canApproveCreditSale(duplicatePersonnel, order, "sales-a-2"), false);
});

test("a resigned duplicate keeps a legacy owner name ambiguous", () => {
  const duplicatePersonnel = [
    ...personnel,
    { id: "p-former-sales-a", username: "former-sales-a", name: "销售A", accessRole: "staff", employmentStatus: "resigned" },
  ];
  const order = { contactPerson: "销售A" };
  assert.equal(creditSaleOrderOwner(duplicatePersonnel, order), null);
  assert.equal(canApproveCreditSale(duplicatePersonnel, order, "sales-a"), false);
});

test("an invalid stable personnel id never falls back to a matching name", () => {
  const order = { contactPersonnelId: "missing-person", contactPerson: "销售A" };
  assert.equal(creditSaleOrderOwner(personnel, order), null);
  assert.equal(canApproveCreditSale(personnel, order, "sales-a"), false);
});

test("disabled accounts cannot approve credit sales", () => {
  const disabledPersonnel = [
    ...personnel,
    { username: "admin-disabled", name: "停用管理员", accessRole: "admin", accountEnabled: false },
    { username: "sales-disabled", name: "停用销售", accessRole: "staff", accountEnabled: false },
  ];
  assert.equal(canApproveCreditSale(disabledPersonnel, { contactPerson: "停用销售" }, "sales-disabled"), false);
  assert.equal(canApproveCreditSale(disabledPersonnel, { contactPerson: "销售A" }, "admin-disabled"), false);
});
