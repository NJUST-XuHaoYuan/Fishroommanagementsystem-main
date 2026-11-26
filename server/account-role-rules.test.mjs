import test from "node:test";
import assert from "node:assert/strict";
import { isAccountRole, normalizeAccountRole, permissionsForAccountRole } from "./account-role-rules.mjs";

test("only explicit system roles are recognized; job titles cannot authorize finance", () => {
  assert.equal(isAccountRole("finance"), true);
  for (const value of ["财务", "FINANCE", "superadmin", undefined, {}]) {
    assert.equal(isAccountRole(value), false);
    assert.equal(normalizeAccountRole(value), "staff");
  }
});

test("staff finance bits are ignored; finance gets verification without unrelated mutation or deletion", () => {
  const oldPermissions = { orders: { update: true }, finance: { create: true, update: true, delete: true } };
  assert.deepEqual(permissionsForAccountRole("staff", oldPermissions).finance, { create: false, update: false, delete: false });
  const finance = permissionsForAccountRole("finance", {});
  assert.deepEqual(finance.finance, { create: true, update: true, delete: false });
  assert.deepEqual(finance.accounts, { create: false, update: false, delete: false });
  assert.equal(finance.orders, undefined);
  assert.equal(permissionsForAccountRole("finance", oldPermissions).finance.delete, true);
  assert.deepEqual(oldPermissions.finance, { create: true, update: true, delete: true }, "normalization cannot mutate persisted input");
});
