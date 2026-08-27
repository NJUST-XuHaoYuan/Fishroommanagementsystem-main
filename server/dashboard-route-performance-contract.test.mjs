import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboardSource = readFileSync(new URL("../src/app/components/Dashboard.tsx", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("./local-server.mjs", import.meta.url), "utf8");

test("dashboard mount uses compact summary and focus endpoints, not a raw state slice", () => {
  const beforeExport = dashboardSource.slice(0, dashboardSource.indexOf("const exportAvailableFishList"));
  assert.match(beforeExport, /\/api\/dashboard-summary/);
  assert.match(beforeExport, /\/api\/dashboard-focus/);
  assert.doesNotMatch(beforeExport, /\/api\/state\/slice\?keys=/);
});

test("dashboard summary and focus routes project top-level keys instead of SELECT data", () => {
  const summaryStart = serverSource.indexOf('if (url.pathname === "/api/dashboard-summary"');
  const summaryEnd = serverSource.indexOf('if (url.pathname === "/api/dashboard-focus"', summaryStart);
  const focusEnd = serverSource.indexOf('if (url.pathname === "/api/state"', summaryEnd);
  const summaryRoute = serverSource.slice(summaryStart, summaryEnd);
  const focusRoute = serverSource.slice(summaryEnd, focusEnd);
  assert.ok(summaryStart >= 0 && summaryEnd > summaryStart && focusEnd > summaryEnd);
  assert.doesNotMatch(summaryRoute, /SELECT\s+data\s+FROM app_state/i);
  assert.doesNotMatch(focusRoute, /SELECT\s+data\s+FROM app_state/i);
  assert.match(summaryRoute, /buildDashboardSummary/);
  assert.match(focusRoute, /buildDashboardFocusDetail/);
});

test("salesperson summary retains damaged orders for adjusted attribution", () => {
  assert.match(serverSource, /buildDashboardSalespersonSeries\([\s\S]*?isValidSalesOrder:\s*isValidDashboardSalespersonOrder/);
});
