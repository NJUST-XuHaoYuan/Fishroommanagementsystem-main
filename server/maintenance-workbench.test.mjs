import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { applyMaintenanceWorkbenchAction, createMaintenanceWorkbenchHandler, emptyMaintenanceWorkbench, ensureMaintenanceWorkbenchSchema, materializeMaintenancePlans } from "./maintenance-workbench.mjs";

const now = "2026-11-26T09:30:00", siteId = "nanjing";
const staff = { id: "staff-id", username: "staff", name: "养护人员", accessRole: "staff", accountEnabled: true,
  visibleSiteIds: [siteId], permissions: { daily: { create: true, update: true, delete: true } } };
const fixture = () => ({ sites: [{ id: siteId }, { id: "jiangyin" }], personnel: [structuredClone(staff),
  { ...structuredClone(staff), id: "other-id", username: "other", visibleSiteIds: ["jiangyin"] }],
  tankGroups: [{ id: "tank-nj", name: "南京主缸", siteId, subTanks: [{ id: "sub-nj", name: "子缸1" }] },
    { id: "tank-jy", siteId: "jiangyin", subTanks: [{ id: "sub-jy" }] }], orders: [{ id: "untouched" }], stock: [{ id: "untouched-fish" }] });
const task = { title: "记录实际水质", type: "measurement", tankId: "tank-nj", subTankId: "sub-nj", assignedTo: "staff", dueDate: "2026-11-26", dueTime: "10:00", notes: "按实际测量填写，不预设正常值" };
const create = { action: "create_task", task };
let id = 0;
const apply = (data, body, patch = {}) => applyMaintenanceWorkbenchAction(data, body, { state: fixture(), siteId, account: staff, now, createId: prefix => `${prefix}-${++id}`, ...patch });

test("tasks preserve actual execution, measurements and server-owned actor without changing inventory or orders", () => {
  const state = fixture(), original = structuredClone(state);
  const pending = apply(emptyMaintenanceWorkbench(), create, { state });
  const target = pending.tasks[0];
  assert.equal(target.status, "pending"); assert.equal(target.createdBy, "staff"); assert.equal(target.createdAt, now);
  const started = apply(pending, { action: "start_task", taskId: target.id });
  const completed = apply(started, { action: "complete_task", taskId: target.id, result: "已记录实测，继续观察", measurements: { "温度 ℃": 25.3, pH: 8.1 }, medicineDescription: "未用药" });
  assert.equal(completed.tasks[0].status, "completed"); assert.equal(completed.tasks[0].completedBy, "staff");
  assert.deepEqual(completed.tasks[0].measurements, { "温度 ℃": 25.3, pH: 8.1 });
  assert.deepEqual(completed.history.map(entry => entry.action), ["complete_task", "start_task", "create_task"]);
  assert.deepEqual(state, original); assert.equal(pending.tasks[0].status, "pending");
});

test("completed or cancelled tasks cannot be executed again and cancellation requires an actual reason", () => {
  const data = apply(emptyMaintenanceWorkbench(), create), taskId = data.tasks[0].id;
  assert.throws(() => apply(data, { action: "cancel_task", taskId, reason: " " }), /取消原因/);
  const cancelled = apply(data, { action: "cancel_task", taskId, reason: "改由其他缸组统一测量" });
  assert.equal(cancelled.tasks[0].cancelledBy, "staff");
  for (const closed of [cancelled, apply(data, { action: "complete_task", taskId, result: "测量完成" })]) {
    for (const action of ["start_task", "complete_task", "cancel_task"]) assert.throws(() => apply(closed, { action, taskId, result: "重复", reason: "重复" }), /已完成或取消/);
  }
});

test("task input rejects forged identity, invalid measurements, wrong sites and inactive assignees", () => {
  for (const patch of [{ createdBy: "admin" }, { status: "completed" }, { tankId: "tank-jy" }, { subTankId: "sub-jy" }, { assignedTo: "other" }, { dueDate: "2026-02-30" }, { dueTime: "25:00" }]) {
    assert.throws(() => apply(emptyMaintenanceWorkbench(), { ...create, task: { ...task, ...patch } }));
  }
  assert.throws(() => apply(emptyMaintenanceWorkbench(), { ...create, operator: "admin" }), /无效字段/);
  const inactive = fixture(); inactive.personnel[0].accountEnabled = false;
  assert.throws(() => apply(emptyMaintenanceWorkbench(), create, { state: inactive }), /已停用/);
  const data = apply(emptyMaintenanceWorkbench(), create), taskId = data.tasks[0].id;
  for (const measurements of [{ pH: "8.1" }, { pH: NaN }, { pH: Infinity }, []]) {
    assert.throws(() => apply(data, { action: "complete_task", taskId, result: "实测", measurements }), /实测/);
  }
  assert.throws(() => apply(data, { action: "complete_task", taskId, result: " " }), /执行结果/);
});

test("daily and weekly occurrences are deterministic and never recreate a completed or cancelled task", () => {
  let data = apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { title: "每日观察", type: "inspection", frequency: "daily", startDate: "2026-11-26" } });
  data = apply(data, { action: "create_plan", plan: { title: "每周跟进", type: "treatment", frequency: "weekly", weekdays: [4, 7], startDate: "2026-11-26" } });
  const generated = materializeMaintenancePlans(data, siteId, now);
  assert.equal(generated.data.tasks.length, 2);
  assert.deepEqual(materializeMaintenancePlans(data, siteId, now).data.tasks.map(row => row.id), generated.data.tasks.map(row => row.id));
  const repeated = materializeMaintenancePlans(generated.data, siteId, now);
  assert.equal(repeated.changed, false); assert.equal(repeated.data.tasks.length, 2);
  const target = generated.data.tasks.find(row => row.type === "treatment");
  const completed = apply(generated.data, { action: "complete_task", taskId: target.id, result: "已执行本次治疗，仍需后续观察", medicineDescription: "按现场已确认方案执行，详见记录" });
  assert.equal(completed.plans.find(row => row.id === target.planId).enabled, true, "one execution must not end a treatment followup plan");
  const future = materializeMaintenancePlans(completed, siteId, "2026-11-29T12:00:00").data;
  assert.equal(future.tasks.length, 6); assert.equal(new Set(future.tasks.map(row => row.id)).size, 6);
});

test("plan disable preserves tasks, reenable skips disabled dates and prevents duplicate same-day occurrence", () => {
  let data = apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { title: "观察", type: "inspection", frequency: "daily", startDate: "2026-11-26" } });
  data = materializeMaintenancePlans(data, siteId, now).data;
  const planId = data.plans[0].id;
  data = apply(data, { action: "set_plan_enabled", planId, enabled: false });
  assert.equal(materializeMaintenancePlans(data, siteId, "2026-11-28T09:00:00").data.tasks.length, 1);
  data = apply(data, { action: "set_plan_enabled", planId, enabled: true }, { now: "2026-11-29T09:00:00" });
  data = materializeMaintenancePlans(data, siteId, "2026-11-29T09:00:00").data;
  assert.deepEqual(data.tasks.map(row => row.dueDate).sort(), ["2026-11-26", "2026-11-29"]);
  const cancelled = apply(data, { action: "cancel_task", taskId: data.tasks[0].id, reason: "无需重复" });
  assert.equal(materializeMaintenancePlans(cancelled, siteId, "2026-11-29T20:00:00").data.tasks.length, 2);
});

test("plans never backfill before creation and handoff records enforce task, person and date scope", () => {
  assert.throws(() => apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { title: "计划", type: "inspection", frequency: "daily", startDate: "2026-11-25" } }), /不能追溯/);
  for (const weekdays of [[], [0], [8], ["4"]]) assert.throws(() => apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { title: "计划", type: "inspection", frequency: "weekly", weekdays } }), /有效星期/);
  const data = apply(emptyMaintenanceWorkbench(), create), taskId = data.tasks[0].id;
  const handoff = { content: "晚班复测并记录实际情况", assignedTo: "staff", taskId, followUpAt: "2026-11-26T17:30" };
  const next = apply(data, { action: "add_handoff", handoff });
  assert.equal(next.handoffs[0].createdBy, "staff"); assert.equal(next.history[0].detail, handoff.content);
  for (const patch of [{ taskId: "foreign-task" }, { assignedTo: "other" }, { followUpAt: "2026-02-30T17:00" }, { content: "" }]) assert.throws(() => apply(data, { action: "add_handoff", handoff: { ...handoff, ...patch } }));
});

// Opt-in real PostgreSQL integration. The URL is restricted to a disposable local
// database, so these tests cannot target a production or shared app database.
const databaseUrl = process.env.MAINTENANCE_TEST_DATABASE_URL;
let pool, requestCount = 0;
before(async () => {
  if (!databaseUrl) return;
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && /^\/maintenance_workbench_test_[a-z0-9_]+$/.test(url.pathname), "only an explicitly named disposable local test database is allowed");
  pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query("CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
  await ensureMaintenanceWorkbenchSchema(pool); await ensureMaintenanceWorkbenchSchema(pool);
});
after(async () => { await pool?.end(); });

async function harness(t) {
  const stateId = `maintenance-test-${++requestCount}`, state = fixture();
  await pool.query("INSERT INTO app_state VALUES ($1, $2::jsonb)", [stateId, JSON.stringify(state)]);
  t.after(async () => {
    await pool.query("DELETE FROM maintenance_workbench_sites WHERE state_id = $1", [stateId]);
    await pool.query("DELETE FROM app_state WHERE id = $1", [stateId]);
  });
  let currentTime = now;
  const hasPermission = (person, module, action) => person.accountEnabled !== false && person.permissions?.[module]?.[action] === true;
  const handler = createMaintenanceWorkbenchHandler({ pool, stateId, readBody: async req => JSON.stringify(req.body),
    sendJson: (req, res, status, payload) => { res.status = status; res.body = payload; },
    nowInChina: () => currentTime, hasPermission,
    refreshAuth(req, latest) {
      const live = latest.personnel.find(person => person.username === req.auth.user.username);
      if (!live || live.id !== req.auth.account.id || live.accountEnabled === false || (live.sessionVersion || 0) !== (req.auth.account.sessionVersion || 0)) throw Object.assign(new Error("账号已变化"), { statusCode: 403 });
      req.auth.account = live;
    },
    requireSite(req, latest, selected) {
      if (!latest.sites.some(site => site.id === selected) || !req.auth.account.visibleSiteIds.includes(selected)) throw Object.assign(new Error("场地无权访问"), { statusCode: 403 });
    },
  });
  const request = async (body, selected = siteId, method = body ? "POST" : "GET") => {
    const req = { method, body, auth: { user: { username: "staff" }, account: structuredClone(staff) } }, res = { setHeader() {} };
    await handler(req, res, new URL(`http://localhost/api/maintenance-workbench?siteId=${selected}`));
    return res;
  };
  const read = async () => (await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId])).rows[0].data;
  const revoke = async patch => { const next = await read(); Object.assign(next.personnel[0], patch); await pool.query("UPDATE app_state SET data = $2::jsonb WHERE id = $1", [stateId, JSON.stringify(next)]); };
  return { request, read, revoke, state, stateId, setTime: value => { currentTime = value; } };
}

test("PostgreSQL: save/requery execution and handoff are durable in separate storage without modifying app_state", { skip: !databaseUrl }, async t => {
  const s = await harness(t);
  const empty = await s.request(); assert.equal(empty.status, 200); assert.equal(empty.body.revision, 0); assert.deepEqual(empty.body.tasks, []);
  const created = await s.request({ ...create, siteId, expectedRevision: 0 }); assert.equal(created.status, 200); assert.equal(created.body.revision, 1);
  const taskId = created.body.tasks[0].id;
  const complete = await s.request({ siteId, expectedRevision: 1, action: "complete_task", taskId, result: "已测量", measurements: { pH: 8.15 } });
  assert.equal(complete.status, 200); assert.equal(complete.body.tasks[0].completedBy, "staff");
  const handoff = await s.request({ siteId, expectedRevision: 2, action: "add_handoff", handoff: { content: "下一班复查", taskId, assignedTo: "staff" } });
  assert.equal(handoff.status, 200);
  const reread = await s.request(); assert.deepEqual(reread.body.tasks, complete.body.tasks); assert.equal(reread.body.handoffs.length, 1);
  assert.deepEqual(await s.read(), s.state);
});

test("PostgreSQL: same revision permits only one concurrent write and replay never duplicates a task", { skip: !databaseUrl }, async t => {
  const s = await harness(t); await s.request();
  const payload = { ...create, siteId, expectedRevision: 0 };
  const responses = await Promise.all([s.request(payload), s.request(payload)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal((await s.request()).body.tasks.length, 1);
  assert.equal((await s.request(payload)).status, 409);
  assert.deepEqual(await s.read(), s.state);
});

test("PostgreSQL: concurrent materialization is idempotent and does not delete cancelled occurrences", { skip: !databaseUrl }, async t => {
  const s = await harness(t);
  const created = await s.request({ siteId, expectedRevision: 0, action: "create_plan", plan: { title: "日常观察", type: "inspection", frequency: "daily" } });
  assert.equal(created.status, 200); assert.equal(created.body.tasks.length, 1);
  s.setTime("2026-11-27T09:30:00");
  const results = await Promise.all([s.request(), s.request()]);
  assert.ok(results.every(result => result.status === 200 && result.body.tasks.length === 2));
  assert.equal(results[0].body.revision, results[1].body.revision);
  const taskId = results[0].body.tasks[0].id;
  const cancelled = await s.request({ siteId, expectedRevision: results[0].body.revision, action: "cancel_task", taskId, reason: "已合并测量" });
  assert.equal(cancelled.status, 200); assert.equal((await s.request()).body.tasks.filter(row => row.status === "cancelled").length, 1);
});

test("PostgreSQL: live daily permission, site and session changes deny writes without persisting them", { skip: !databaseUrl }, async t => {
  const s = await harness(t); await s.request();
  assert.equal((await s.request(undefined, "jiangyin")).status, 403);
  await s.revoke({ permissions: { daily: { create: true, update: false, delete: false } } });
  const created = await s.request({ ...create, siteId, expectedRevision: 0 }); assert.equal(created.status, 200);
  const taskId = created.body.tasks[0].id;
  for (const action of ["start_task", "complete_task", "cancel_task"]) assert.equal((await s.request({ siteId, expectedRevision: 1, action, taskId, result: "实际完成", reason: "取消" })).status, 403);
  await s.revoke({ permissions: { daily: { create: false, update: false, delete: false } } });
  assert.equal((await s.request()).status, 403);
  assert.equal((await s.request({ ...create, siteId, expectedRevision: 1 })).status, 403);
  await s.revoke({ permissions: { daily: { create: true, update: true, delete: true } } });
  await s.revoke({ visibleSiteIds: [] }); assert.equal((await s.request()).status, 403);
  await s.revoke({ visibleSiteIds: [siteId], sessionVersion: 1 }); assert.equal((await s.request()).status, 403);
  await s.revoke({ sessionVersion: 0, accountEnabled: false }); assert.equal((await s.request()).status, 403);
  const stored = (await pool.query("SELECT revision, data FROM maintenance_workbench_sites WHERE state_id = $1 AND site_id = $2", [s.stateId, siteId])).rows[0];
  assert.equal(Number(stored.revision), 1); assert.equal(stored.data.tasks[0].status, "pending");
});

test("PostgreSQL: malformed or forged requests roll back and remain scoped to their site", { skip: !databaseUrl }, async t => {
  const s = await harness(t); await s.request();
  for (const body of [{ ...create, siteId, expectedRevision: 0, actor: "admin" }, { ...create, siteId, expectedRevision: -1 }, { ...create, siteId, expectedRevision: "0" }, { ...create, siteId, expectedRevision: 0, task: { ...task, tankId: "tank-jy" } }]) {
    assert.ok([400, 409].includes((await s.request(body)).status));
  }
  assert.equal((await s.request({ ...create, siteId: "jiangyin", expectedRevision: 0 })).status, 400);
  assert.equal((await s.request()).body.revision, 0); assert.equal((await s.request()).body.tasks.length, 0);
});
