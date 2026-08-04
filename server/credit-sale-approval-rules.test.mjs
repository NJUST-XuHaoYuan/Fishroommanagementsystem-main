import test from "node:test";
import assert from "node:assert/strict";
import {
  canApproveCreditSale,
  creditSaleEligibleApprovers,
  creditSaleOrderOwner,
  isCreditSaleOrderOwner,
} from "./credit-sale-approval-rules.mjs";

const personnel = [
  { username: "admin-a", name: "管理员A", accessRole: "admin", employmentStatus: "active" },
  { username: "sales-a", name: "销售A", accessRole: "staff", employmentStatus: "active" },
  { username: "sales-b", name: "销售B", accessRole: "staff", employmentStatus: "active" },
  { username: "former-admin", name: "离职管理员", accessRole: "admin", employmentStatus: "resigned" },
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
