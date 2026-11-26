import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The application uses extensionless TypeScript imports; resolve them for the
// repository's native node:test runner without introducing another test stack.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  canRegisterMaintenanceLoss,
  permissionStateForUser,
  permissionsForRole,
  requireMaintenanceLossPermissions,
} = await import("./permissions.ts");

const permissionModules = [
  "species", "products", "tankGroups", "batches", "stockIn", "daily",
  "lossRecords", "customers", "orders", "finance", "accounts",
];

function permissionsWith(module, action) {
  return Object.fromEntries(permissionModules.map((key) => [key, {
    create: key === module && action === "create",
    update: key === module && action === "update",
    delete: key === module && action === "delete",
  }]));
}

test("staff permissions come from the auth account summary without personnel state", () => {
  const result = permissionStateForUser({
    username: "staff-a",
    role: "staff",
    visibleSiteIds: ["nanjing"],
    account: {
      username: "staff-a",
      accessRole: "staff",
      accountEnabled: true,
      permissions: permissionsWith("orders", "update"),
    },
  });

  assert.equal(result.isAdmin, false);
  assert.equal(result.permissions.finance.update, false);
  assert.equal(result.permissions.finance.create, false);
  assert.equal(result.permissions.orders.update, true);
});

test("staff permissions fail closed when the summary is missing, disabled, or mismatched", () => {
  const missing = permissionStateForUser({ username: "staff-a", role: "staff", visibleSiteIds: ["nanjing"] });
  const disabled = permissionStateForUser({
    username: "staff-a",
    role: "staff",
    visibleSiteIds: ["nanjing"],
    account: {
      username: "staff-a",
      accessRole: "staff",
      accountEnabled: false,
      permissions: permissionsWith("orders", "delete"),
    },
  });
  const mismatched = permissionStateForUser({
    username: "staff-a",
    role: "staff",
    visibleSiteIds: ["nanjing"],
    account: {
      username: "someone-else",
      accessRole: "staff",
      accountEnabled: true,
      permissions: permissionsWith("orders", "delete"),
    },
  });

  assert.equal(missing.permissions.orders.delete, false);
  assert.equal(disabled.permissions.orders.delete, false);
  assert.equal(mismatched.permissions.orders.delete, false);
});

test("administrators keep the global permission bypass without a summary", () => {
  const result = permissionStateForUser({ username: "admin", role: "admin" });

  assert.equal(result.isAdmin, true);
  assert.equal(result.permissions.finance.delete, true);
  assert.equal(result.permissions.accounts.update, true);
});

test("staff account administration stays denied even for a legacy permission bit", () => {
  const result = permissionStateForUser({
    username: "staff-a",
    role: "staff",
    visibleSiteIds: ["nanjing"],
    account: {
      username: "staff-a",
      accessRole: "staff",
      accountEnabled: true,
      permissions: permissionsWith("accounts", "update"),
    },
  });

  assert.equal(result.permissions.accounts.update, false);
});

test("maintenance loss UI requires both daily delete and loss-record create", () => {
  assert.equal(canRegisterMaintenanceLoss(true, true), true);
  assert.equal(canRegisterMaintenanceLoss(true, false), false);
  assert.equal(canRegisterMaintenanceLoss(false, true), false);
  assert.equal(canRegisterMaintenanceLoss(false, false), false);
});

test("maintenance loss submit gate checks both permission modules", () => {
  const checked = [];
  const allowed = requireMaintenanceLossPermissions(
    () => { checked.push("daily.delete"); return true; },
    () => { checked.push("lossRecords.create"); return true; },
  );
  assert.equal(allowed, true);
  assert.deepEqual(checked, ["daily.delete", "lossRecords.create"]);

  let lossCreateChecked = false;
  const denied = requireMaintenanceLossPermissions(
    () => false,
    () => { lossCreateChecked = true; return true; },
  );
  assert.equal(denied, false);
  assert.equal(lossCreateChecked, false);
});


test("finance is a scoped non-admin role with registration and verification but no deletion by default", () => {
  const result = permissionStateForUser({
    username: "finance-a", role: "finance", visibleSiteIds: ["nanjing"],
    account: { username: "finance-a", accessRole: "finance", accountEnabled: true, permissions: {} },
  });
  assert.equal(result.isAdmin, false);
  assert.deepEqual(result.permissions.finance, { create: true, update: true, delete: false });
  assert.equal(result.permissions.accounts.update, false);
  assert.equal(result.permissions.orders.update, false);
  assert.equal(result.permissions.daily.update, false);
  assert.equal(permissionsForRole("finance", permissionsWith("finance", "delete")).finance.delete, true);
});

test("legacy staff finance permissions cannot grant verification or finance module access", () => {
  for (const action of ["create", "update", "delete"]) {
    const result = permissionStateForUser({
      username: "staff-a", role: "staff",
      account: { username: "staff-a", accessRole: "staff", accountEnabled: true, permissions: permissionsWith("finance", action) },
    });
    assert.deepEqual(result.permissions.finance, { create: false, update: false, delete: false });
  }
});

test("finance role never grants capabilities with a missing, disabled, or stale account summary", () => {
  for (const account of [undefined,
    { username: "finance-a", accessRole: "finance", accountEnabled: false, permissions: {} },
    { username: "finance-a", accessRole: "staff", accountEnabled: true, permissions: {} },
    { username: "other-user", accessRole: "finance", accountEnabled: true, permissions: {} },
  ]) {
    assert.deepEqual(permissionStateForUser({ username: "finance-a", role: "finance", account }).permissions.finance,
      { create: false, update: false, delete: false });
  }
});
