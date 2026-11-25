import assert from "node:assert/strict";
import { test } from "node:test";
import { maintenanceToday, parseMaintenanceMeasurements, maintenanceTaskList, maintenancePlanSchedule, maintenanceDateTime, readMaintenanceSnapshot } from "./maintenanceWorkbench.ts";

const task = (id, dueDate, status = "pending", patch = {}) => ({ id, dueDate, status, dueTime: "10:00", createdAt: `2026-11-25T09:0${id}:00`, type: "inspection", assignedTo: "worker", ...patch });

test("workday follows Beijing date across UTC midnight boundaries", () => {
  assert.equal(maintenanceToday(new Date("2026-11-25T15:59:59Z")), "2026-11-25");
  assert.equal(maintenanceToday(new Date("2026-11-25T16:00:00Z")), "2026-11-26");
  assert.equal(maintenanceDateTime("2026-11-26T08:30:09"), "2026-11-26 08:30:09");
});

test("empty measured values remain absent while an actual zero is preserved", () => {
  assert.deepEqual({ ...parseMaintenanceMeasurements([{ name: "", value: "" }]) }, {});
  assert.deepEqual({ ...parseMaintenanceMeasurements([{ name: " 氨氮 mg/L ", value: " 0 " }, { name: "温度 °C", value: "25.6" }]) }, { "氨氮 mg/L": 0, "温度 °C": 25.6 });
});

test("incomplete, repeated, overlong and non-finite measurements cannot become saved data", () => {
  for (const rows of [
    [{ name: "pH", value: "" }], [{ name: "", value: "8" }], [{ name: "pH", value: "Infinity" }],
    [{ name: "pH", value: "NaN" }], [{ name: "pH", value: "8" }, { name: " pH ", value: "9" }],
    [{ name: "x".repeat(61), value: "1" }],
  ]) assert.throws(() => parseMaintenanceMeasurements(rows), /[\u3400-\u9fff]/);
});

test("today work includes overdue and in-progress tasks, excludes closed and future tasks", () => {
  const tasks = [task("1", "2026-11-27"), task("2", "2026-11-26", "completed"), task("3", "2026-11-26", "in_progress"), task("4", "2026-11-25"), task("5", "2026-11-25", "cancelled")];
  assert.deepEqual(maintenanceTaskList(tasks, { date: "2026-11-26", scope: "due" }).map(item => item.id), ["4", "3"]);
  assert.deepEqual(maintenanceTaskList(tasks, { date: "2026-11-26", scope: "upcoming" }).map(item => item.id), ["1"]);
});

test("treatment and assignee filters never pull unrelated or completed tasks", () => {
  const tasks = [task("1", "2026-12-01", "pending", { type: "treatment", assignedTo: "" }), task("2", "2026-11-26", "completed", { type: "treatment" }), task("3", "2026-11-26")];
  assert.deepEqual(maintenanceTaskList(tasks, { date: "2026-11-26", scope: "all", treatmentOnly: true, owner: "__unassigned" }).map(item => item.id), ["1"]);
  assert.deepEqual(maintenanceTaskList(tasks, { date: "2026-11-26", scope: "all", owner: "worker" }).map(item => item.id), ["3"]);
});

test("weekly plan label sorts unique real weekdays and retains its planned time", () => {
  assert.equal(maintenancePlanSchedule({ frequency: "weekly", weekdays: [7, 1, 1, 3], dueTime: "09:30" }), "每周一、三、日 09:30");
  assert.equal(maintenancePlanSchedule({ frequency: "daily", weekdays: [], dueTime: "08:00" }), "每天 08:00");
});

test("cross-site or incomplete snapshots are rejected instead of replacing current records", () => {
  const snapshot = { ok: true, siteId: "nanjing", revision: 0, tasks: [], plans: [], handoffs: [], history: [], permissions: { canCreate: false, canUpdate: false, canDelete: false } };
  assert.equal(readMaintenanceSnapshot(snapshot, "nanjing"), snapshot);
  assert.throws(() => readMaintenanceSnapshot(snapshot, "jiangyin"));
  assert.throws(() => readMaintenanceSnapshot({ ...snapshot, revision: "1" }, "nanjing"));
  assert.throws(() => readMaintenanceSnapshot({ ...snapshot, history: null }, "nanjing"));
});
