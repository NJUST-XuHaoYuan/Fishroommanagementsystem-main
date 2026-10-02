import assert from "node:assert/strict";
import test from "node:test";
import { canAccessAdminDashboard, canAccessDashboard, resolveDashboardView } from "./dashboardAccess.ts";

const admin = { username: "admin", role: "admin" };
const staff = { username: "keeper", role: "staff" };

test("home is available to authenticated users but business dashboard stays admin-only", () => {
  assert.equal(canAccessDashboard(admin), true);
  assert.equal(canAccessDashboard(staff), true);
  assert.equal(canAccessDashboard(null), false);
  assert.equal(canAccessAdminDashboard(admin), true);
  assert.equal(canAccessAdminDashboard(staff), false);
  assert.equal(canAccessAdminDashboard(null), false);
  assert.equal(canAccessAdminDashboard({ ...staff, permissions: { dashboard: true } }), false);
});

test("restored dashboard routes and direct navigation use the current account role", () => {
  assert.equal(resolveDashboardView("dashboard", null), "daily");
  assert.equal(resolveDashboardView("dashboard", admin), "dashboard");
  // Role changes retain home navigation, but never grant business dashboard access.
  assert.equal(resolveDashboardView("dashboard", staff), "dashboard");
  assert.equal(resolveDashboardView("dashboard", { ...admin, role: "staff" }), "dashboard");
  assert.equal(canAccessAdminDashboard({ ...admin, role: "staff" }), false);
});

test("the dashboard restriction preserves all existing non-dashboard navigation", () => {
  const otherViews = [
    "notifications", "species", "products", "tankGroups", "batches", "stockIn",
    "daily", "lossRecords", "customers", "orders", "catalogManagement", "finance",
    "categorySettings", "paymentMethods", "shippingCarriers", "waterQualitySettings",
    "permissions", "profile", "operationLogs",
  ];
  for (const view of otherViews) {
    assert.equal(resolveDashboardView(view, staff), view);
    assert.equal(resolveDashboardView(view, admin), view);
  }
});
