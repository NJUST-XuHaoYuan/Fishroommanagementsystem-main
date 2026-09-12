import assert from "node:assert/strict";
import test from "node:test";
import { resolveDashboardDateRange } from "./dashboard-date-range.mjs";

test("explicit historical ranges include both endpoints and allow a single day", () => {
  assert.deepEqual(resolveDashboardDateRange({ startDate: "2024-02-28", endDate: "2024-03-01" }, "2026-09-12"), {
    dates: ["2024-02-28", "2024-02-29", "2024-03-01"],
    startDate: "2024-02-28",
    endDate: "2024-03-01",
    financeDays: 3,
  });
  assert.equal(resolveDashboardDateRange({ startDate: "2026-09-01", endDate: "2026-09-01" }).financeDays, 1);
});

test("legacy financeDays defaults, clamps and ends on China today", () => {
  const range = resolveDashboardDateRange({}, "2026-09-12");
  assert.equal(range.financeDays, 30);
  assert.equal(range.startDate, "2026-08-14");
  assert.equal(range.endDate, "2026-09-12");
  assert.equal(resolveDashboardDateRange({ financeDays: "1" }, "2026-09-12").financeDays, 7);
  assert.equal(resolveDashboardDateRange({ financeDays: "1000" }, "2026-09-12").financeDays, 730);
  assert.equal(resolveDashboardDateRange({ financeDays: "90" }, "2026-09-12").financeDays, 90);
  assert.equal(resolveDashboardDateRange({ startDate: "2026-09-01", endDate: "2026-09-02", financeDays: "90" }).financeDays, 2);
});

test("date ranges reject partial, impossible, malformed, reversed, and oversized requests", () => {
  for (const options of [
    { startDate: "2026-09-01" },
    { endDate: "2026-09-01" },
    { startDate: "", endDate: "" },
    { startDate: "2026-02-29", endDate: "2026-03-01" },
    { startDate: "2026-04-31", endDate: "2026-05-01" },
    { startDate: "2026-9-01", endDate: "2026-09-02" },
    { startDate: "2026-09-01T00:00:00Z", endDate: "2026-09-02" },
    { startDate: "2026-09-02", endDate: "2026-09-01" },
    { startDate: "2024-01-01", endDate: "2025-12-31" },
  ]) {
    assert.throws(() => resolveDashboardDateRange(options), (error) => error.statusCode === 400);
  }
  assert.equal(resolveDashboardDateRange({ startDate: "2024-01-01", endDate: "2025-12-30" }).financeDays, 730);
});
