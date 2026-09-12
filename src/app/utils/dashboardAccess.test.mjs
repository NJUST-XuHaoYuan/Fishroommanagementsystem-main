import assert from "node:assert/strict";
import test from "node:test";
import { canAccessDashboard, resolveDashboardView } from "./dashboardAccess.ts";

const admin = { username: "admin", role: "admin" };
const staff = { username: "keeper", role: "staff" };

test("dashboard access is reserved for authenticated administrators", () => {
  assert.equal(canAccessDashboard(admin), true);
  assert.equal(canAccessDashboard(staff), false);
  assert.equal(canAccessDashboard(null), false);
  assert.equal(canAccessDashboard({ ...staff, permissions: { dashboard: true } }), false);
});

test("restored dashboard routes and direct navigation use the current account role", () => {
  assert.equal(resolveDashboardView("dashboard", null), "daily");
  assert.equal(resolveDashboardView("dashboard", admin), "dashboard");
  // The previous account's selected route must not survive an admin-to-staff switch.
  assert.equal(resolveDashboardView("dashboard", staff), "daily");
  assert.equal(resolveDashboardView("dashboard", { ...admin, role: "staff" }), "daily");
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
