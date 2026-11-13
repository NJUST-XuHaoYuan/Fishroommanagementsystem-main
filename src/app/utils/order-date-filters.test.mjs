import test from "node:test";
import assert from "node:assert/strict";
import { beijingOrderCalendar, matchesPlannedShipmentRange } from "./order-date-filters.ts";

test("shipment shortcuts roll over at Beijing midnight, including year and leap-day boundaries", () => {
  for (const [instant, today, tomorrow] of [
    ["2026-11-13T15:59:59Z", "2026-11-13", "2026-11-14"],
    ["2026-11-13T16:00:00Z", "2026-11-14", "2026-11-15"],
    ["2026-12-31T08:00:00Z", "2026-12-31", "2027-01-01"],
    ["2028-02-28T08:00:00Z", "2028-02-28", "2028-02-29"],
    ["2028-02-29T08:00:00Z", "2028-02-29", "2028-03-01"],
  ]) assert.deepEqual(beijingOrderCalendar(new Date(instant)), { today, tomorrow });
});

test("expected shipment range includes both endpoints and ignores the order creation date", () => {
  const range = { from: "2026-11-14", to: "2026-11-16" };
  const orders = ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17", ""].map((date) => ({
    plannedShipDate: date, date: "2026-09-01", status: "confirmed",
  }));
  assert.deepEqual(orders.filter((order) => matchesPlannedShipmentRange(order, range)).map((order) => order.plannedShipDate),
    ["2026-11-14", "2026-11-15", "2026-11-16"]);
  assert.equal(matchesPlannedShipmentRange(orders[1], { from: range.from, to: range.from }), true);
});

test("open-ended ranges filter unscheduled orders, clearing the range restores them and cancelled orders", () => {
  assert.equal(matchesPlannedShipmentRange({ plannedShipDate: "2026-11-17" }, { from: "2026-11-14" }), true);
  assert.equal(matchesPlannedShipmentRange({ plannedShipDate: "2026-11-13" }, { to: "2026-11-14" }), true);
  assert.equal(matchesPlannedShipmentRange({}, { to: "2026-11-14" }), false);
  assert.equal(matchesPlannedShipmentRange({ status: "cancelled", plannedShipDate: "2026-11-14" }, { from: "2026-11-14" }), false);
  assert.equal(matchesPlannedShipmentRange({ status: "cancelled" }, {}), true);
  assert.equal(matchesPlannedShipmentRange({}, {}), true);
  assert.equal(matchesPlannedShipmentRange({ plannedShipDate: "2026-11-14" }, { from: "2026-11-16", to: "2026-11-14" }), false);
});

test("an updated order plan takes precedence over stale legacy item plans", () => {
  const order = { plannedShipDate: "2026-11-17", items: [{ plannedShipDate: "2026-11-14" }] };
  assert.equal(matchesPlannedShipmentRange(order, { from: "2026-11-14", to: "2026-11-14" }), false);
  assert.equal(matchesPlannedShipmentRange(order, { from: "2026-11-17", to: "2026-11-17" }), true);
});

test("legacy item plans must individually fall inside the range and exclude returned fish", () => {
  const order = { items: [
    { plannedShipDate: "2026-11-13" },
    { plannedShipDate: "2026-11-17" },
    { plannedShipDate: "2026-11-15", inventoryRemovedAt: "2026-11-12T09:00:00+08:00" },
  ] };
  assert.equal(matchesPlannedShipmentRange(order, { from: "2026-11-14", to: "2026-11-16" }), false);
  order.items.push({ plannedShipDate: "2026-11-16" });
  assert.equal(matchesPlannedShipmentRange(order, { from: "2026-11-14", to: "2026-11-16" }), true);
});
