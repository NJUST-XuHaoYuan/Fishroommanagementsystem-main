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

const { permissionStateForUser } = await import("./permissions.ts");

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
      permissions: permissionsWith("finance", "update"),
    },
  });

  assert.equal(result.isAdmin, false);
  assert.equal(result.permissions.finance.update, true);
  assert.equal(result.permissions.finance.create, false);
  assert.equal(result.permissions.orders.update, false);
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
