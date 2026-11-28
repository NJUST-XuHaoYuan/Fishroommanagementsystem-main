import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { applyMaintenanceWorkbenchAction, createMaintenanceWorkbenchHandler, emptyMaintenanceWorkbench, ensureMaintenanceWorkbenchSchema, materializeMaintenancePlans, maintenanceTargetAvailability } from "./maintenance-workbench.mjs";

const now = "2026-11-26T09:30:00", siteId = "nanjing";
const staff = { id: "staff-id", username: "staff", name: "养护人员", accessRole: "staff", accountEnabled: true,
  visibleSiteIds: [siteId], permissions: { daily: { create: true, update: true, delete: true } } };
const fixture = () => ({ sites: [{ id: siteId }, { id: "jiangyin" }], personnel: [structuredClone(staff),
  { ...structuredClone(staff), id: "other-id", username: "other", visibleSiteIds: ["jiangyin"] }],
  tankGroups: [{ id: "tank-nj", name: "南京主缸", siteId, subTanks: [{ id: "sub-nj", name: "子缸1" }] },
    { id: "tank-jy", siteId: "jiangyin", subTanks: [{ id: "sub-jy" }] }], orders: [{ id: "untouched" }], products: [{ id: "product", name: "黄金吊" }], stock: [{ id: "fish-1", siteId, subTankId: "sub-nj", productId: "product", code: "F1" }],
  waterQualityRecords: [{ id: "water-1", siteId, tankGroupId: "tank-nj", scope: "group", measuredAt: "2026-11-26T01:30:00Z", values: [{ parameterId: "ph", value: 8.1 }], operator: "staff", createdBy: "staff" }],
  logs: [{ id: "drug-1", siteId, tankGroupId: "tank-nj", scope: "group", date: now, action: "下药", notes: "实际药品与用量", operator: "staff", createdBy: "staff" }],
  bioRecords: [{ id: "fish-record", siteId, stockItemId: "fish-1", subTankId: "sub-nj", date: now, text: "实际鱼只治疗", photos: ["/uploads/fish.jpg"], videos: [], operator: "staff", sourceType: "manual" }] });
const task = { title: "记录实际水质", type: "measurement", tankId: "tank-nj", targetType: "group", assignedTo: "staff", dueDate: "2026-11-26", dueTime: "10:00", notes: "按实际测量填写，不预设正常值" };
const create = { action: "create_task", task };
let id = 0;
const apply = (data, body, patch = {}) => applyMaintenanceWorkbenchAction(data, body, { state: fixture(), siteId, account: staff, now, createId: prefix => `${prefix}-${++id}`, ...patch });

test("tasks preserve actual execution, measurements and server-owned actor without changing inventory or orders", () => {
  const state = fixture(), original = structuredClone(state);
  const pending = apply(emptyMaintenanceWorkbench(), create, { state });
  const target = pending.tasks[0];
  assert.equal(target.status, "pending"); assert.equal(target.createdBy, "staff"); assert.equal(target.createdAt, now);
  const started = apply(pending, { action: "start_task", taskId: target.id });
  const completed = apply(started, { action: "complete_task", taskId: target.id, completion: { kind: "waterQualityRecord", recordId: "water-1" } });
  assert.equal(completed.tasks[0].status, "completed"); assert.equal(completed.tasks[0].completedBy, "staff");
  assert.equal(completed.tasks[0].completion.recordId, "water-1");
  assert.deepEqual(completed.tasks[0].completion.record.values, state.waterQualityRecords[0].values);
  assert.deepEqual(completed.history.map(entry => entry.action), ["complete_task", "start_task", "create_task"]);
  assert.deepEqual(state, original); assert.equal(pending.tasks[0].status, "pending");
});

test("completed or cancelled tasks cannot be executed again and cancellation requires an actual reason", () => {
  const data = apply(emptyMaintenanceWorkbench(), create), taskId = data.tasks[0].id;
  assert.throws(() => apply(data, { action: "cancel_task", taskId, reason: " " }), /取消原因/);
  const cancelled = apply(data, { action: "cancel_task", taskId, reason: "改由其他缸组统一测量" });
  assert.equal(cancelled.tasks[0].cancelledBy, "staff");
  for (const closed of [cancelled, apply(data, { action: "complete_task", taskId, completion: { kind: "waterQualityRecord", recordId: "water-1" } })]) {
    for (const action of ["start_task", "complete_task", "cancel_task"]) assert.throws(() => apply(closed, { action, taskId, completion: { kind: "waterQualityRecord", recordId: "water-1" }, reason: "重复" }), /已完成或取消/);
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
  for (const completion of [undefined, {}, { kind: "unknown", recordId: "water-1" }, { kind: "waterQualityRecord", recordId: "missing" }]) {
    assert.throws(() => apply(data, { action: "complete_task", taskId, completion }));
  }
  assert.throws(() => apply(data, { action: "complete_task", taskId, result: "已完成" }), /无效字段/);
});

test("daily and weekly occurrences are deterministic and never recreate a completed or cancelled task", () => {
  let data = apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { tankId: "tank-nj", targetType: "group", title: "每日观察", type: "inspection", frequency: "daily", startDate: "2026-11-26" } });
  data = apply(data, { action: "create_plan", plan: { tankId: "tank-nj", targetType: "group", title: "每周跟进", type: "treatment", frequency: "weekly", weekdays: [4, 7], startDate: "2026-11-26" } });
  const generated = materializeMaintenancePlans(data, siteId, now);
  assert.equal(generated.data.tasks.length, 2);
  assert.deepEqual(materializeMaintenancePlans(data, siteId, now).data.tasks.map(row => row.id), generated.data.tasks.map(row => row.id));
  const repeated = materializeMaintenancePlans(generated.data, siteId, now);
  assert.equal(repeated.changed, false); assert.equal(repeated.data.tasks.length, 2);
  const target = generated.data.tasks.find(row => row.type === "treatment");
  const completed = apply(generated.data, { action: "complete_task", taskId: target.id, completion: { kind: "dailyLog", recordId: "drug-1" } });
  assert.equal(completed.plans.find(row => row.id === target.planId).enabled, true, "one execution must not end a treatment followup plan");
  const future = materializeMaintenancePlans(completed, siteId, "2026-11-29T12:00:00").data;
  assert.equal(future.tasks.length, 6); assert.equal(new Set(future.tasks.map(row => row.id)).size, 6);
});

test("plan disable preserves tasks, reenable skips disabled dates and prevents duplicate same-day occurrence", () => {
  let data = apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { tankId: "tank-nj", targetType: "group", title: "观察", type: "inspection", frequency: "daily", startDate: "2026-11-26" } });
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
  assert.throws(() => apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { tankId: "tank-nj", targetType: "group", title: "计划", type: "inspection", frequency: "daily", startDate: "2026-11-25" } }), /不能追溯/);
  for (const weekdays of [[], [0], [8], ["4"]]) assert.throws(() => apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { tankId: "tank-nj", targetType: "group", title: "计划", type: "inspection", frequency: "weekly", weekdays } }), /有效星期/);
  const data = apply(emptyMaintenanceWorkbench(), create), taskId = data.tasks[0].id;
  const handoff = { content: "晚班复测并记录实际情况", assignedTo: "staff", taskId, followUpAt: "2026-11-26T17:30" };
  const next = apply(data, { action: "add_handoff", handoff });
  assert.equal(next.handoffs[0].createdBy, "staff"); assert.equal(next.history[0].detail, handoff.content);
  for (const patch of [{ taskId: "foreign-task" }, { assignedTo: "other" }, { followUpAt: "2026-02-30T17:00" }, { content: "" }]) assert.throws(() => apply(data, { action: "add_handoff", handoff: { ...handoff, ...patch } }));
});

test("batch targets are fixed, atomic and restricted to whole groups or physical fish", () => {
  const state = fixture(), initial = emptyMaintenanceWorkbench();
  const common = { title: "观察", type: "inspection", dueDate: "2026-11-26" };
  const data = apply(initial, { action: "create_task", task: common, targets: [{ targetType: "group", tankId: "tank-nj" }, { targetType: "fish", stockItemId: "fish-1" }] }, { state });
  assert.equal(data.tasks.length, 2); assert.equal(data.tasks.find(row => row.targetType === "fish").fishCode, "F1");
  assert.deepEqual(initial, emptyMaintenanceWorkbench());
  for (const targets of [[], Array(101).fill({ targetType: "group", tankId: "tank-nj" }), [{ targetType: "group", tankId: "tank-nj" }, { targetType: "group", tankId: "tank-nj" }], [{ targetType: "group", tankId: "tank-nj" }, { targetType: "group", tankId: "tank-jy" }]]) {
    assert.throws(() => apply(initial, { action: "create_task", task: common, targets }, { state })); assert.deepEqual(initial, emptyMaintenanceWorkbench());
  }
  for (const type of ["feeding", "measurement", "water_change"]) assert.throws(() => apply(initial, { action: "create_task", task: { ...common, type, targetType: "fish", stockItemId: "fish-1" } }), /只能选择缸组/);
  assert.throws(() => apply(initial, { action: "create_task", task: { ...common, tankId: "tank-nj", subTankId: "sub-nj" } }));
  assert.throws(() => apply(initial, { action: "create_task", task: { ...common, tankId: "tank-nj", type: "media" } }), /单条鱼/);
});

test("fish tasks follow same-site moves and block transit, loss, outbound and cross-site movement", () => {
  const state = fixture(); state.tankGroups.push({ id: "tank-nj-2", name: "新缸", siteId, subTanks: [{ id: "sub-nj-2", name: "主缸" }] });
  const data = apply(emptyMaintenanceWorkbench(), { action: "create_task", task: { title: "拍摄", type: "media", targetType: "fish", stockItemId: "fish-1" } }, { state });
  const row = data.tasks[0]; state.stock[0].subTankId = "sub-nj-2";
  assert.equal(maintenanceTargetAvailability(row, state, siteId).currentTankId, "tank-nj-2");
  assert.equal(row.tankId, "tank-nj");
  const completed = apply(data, { action: "complete_task", taskId: row.id, completion: { kind: "bioRecord", recordId: "fish-record" } }, { state });
  assert.equal(completed.tasks[0].completion.record.stockItemId, "fish-1");
  for (const change of [{ lost: true }, { tankTransfer: { status: "in_transit" } }, { siteId: "jiangyin" }, { subTankId: "deleted" }]) {
    const changed = structuredClone(state); Object.assign(changed.stock[0], change);
    assert.equal(maintenanceTargetAvailability(row, changed, siteId).targetUnavailable, true);
    assert.throws(() => apply(data, { action: "start_task", taskId: row.id }, { state: changed }), error => error.code === "MAINTENANCE_TARGET_UNAVAILABLE");
  }
  state.stock[0].sold = true; assert.equal(maintenanceTargetAvailability(row, state, siteId).targetUnavailable, false);
  state.shipments = [{ status: "outbound", itemStockIds: ["fish-1"] }]; assert.equal(maintenanceTargetAvailability(row, state, siteId).targetUnavailable, true);
});

test("execution cannot use foreign, stale, inherited, empty or reused records", () => {
  const data = apply(emptyMaintenanceWorkbench(), create), taskId = data.tasks[0].id;
  const completion = { kind: "waterQualityRecord", recordId: "water-1" };
  for (const change of [{ siteId: "jiangyin" }, { createdBy: "other" }, { measuredAt: "2026-11-25T01:00:00Z" }, { tankGroupId: "tank-jy" }, { subTankId: "sub-nj" }, { values: [] }, { inheritedTankGroupIds: ["tank-nj"] }]) {
    const state = fixture(); Object.assign(state.waterQualityRecords[0], change);
    assert.throws(() => apply(data, { action: "complete_task", taskId, completion }, { state }));
  }
  const completed = apply(data, { action: "complete_task", taskId, completion });
  const second = apply(completed, create); assert.throws(() => apply(second, { action: "complete_task", taskId: second.tasks[0].id, completion }), error => error.code === "MAINTENANCE_COMPLETION_RECORD_USED");
  const fish = apply(emptyMaintenanceWorkbench(), { action: "create_task", task: { title: "拍摄", type: "media", targetType: "fish", stockItemId: "fish-1" } });
  for (const patch of [{ sourceType: "dailyLog" }, { photos: [], videos: [] }, { stockItemId: "wrong" }]) {
    const state = fixture(); Object.assign(state.bioRecords[0], patch);
    assert.throws(() => apply(fish, { action: "complete_task", taskId: fish.tasks[0].id, completion: { kind: "bioRecord", recordId: "fish-record" } }, { state }));
  }
});

test("plan edits preserve materialized occurrences and single-task edits leave repeat definitions intact", () => {
  let data = apply(emptyMaintenanceWorkbench(), { action: "create_plan", plan: { title: "原观察", type: "inspection", tankId: "tank-nj", frequency: "daily", startDate: "2026-11-26", dueTime: "10:00" } });
  data = materializeMaintenancePlans(data, siteId, now).data;
  const occurrence = structuredClone(data.tasks[0]), planId = data.plans[0].id;
  const edited = apply(data, { action: "update_plan", planId, plan: { title: "改后观察", type: "inspection", tankId: "tank-nj", frequency: "weekly", weekdays: [5], startDate: "2026-11-26", dueTime: "15:00" } });
  assert.deepEqual(edited.tasks[0], occurrence); assert.equal(edited.history[0].before.title, "原观察");
  const future = materializeMaintenancePlans(edited, siteId, "2026-11-27T12:00:00").data;
  assert.equal(future.tasks[0].title, "改后观察"); assert.equal(future.tasks[0].dueTime, "15:00");
  const planBefore = structuredClone(future.plans[0]);
  const single = apply(future, { action: "update_task", taskId: occurrence.id, task: { ...task, title: "仅当次调整" } });
  assert.deepEqual(single.plans[0], planBefore); assert.equal(single.tasks.find(row => row.id === occurrence.id).title, "仅当次调整");
});

test("assigned tasks require assignee or admin and unassigned start claims only this occurrence", () => {
  const data = apply(emptyMaintenanceWorkbench(), create), other = { ...staff, username: "other" };
  assert.throws(() => apply(data, { action: "start_task", taskId: data.tasks[0].id }, { account: other }), error => error.statusCode === 403);
  const admin = apply(data, { action: "start_task", taskId: data.tasks[0].id }, { account: { ...other, accessRole: "admin" } });
  assert.equal(admin.tasks[0].startedBy, "other");
  const unassigned = apply(emptyMaintenanceWorkbench(), { ...create, task: { ...task, assignedTo: "" } });
  const started = apply(unassigned, { action: "start_task", taskId: unassigned.tasks[0].id });
  assert.equal(started.tasks[0].assignedTo, "staff");
  for (const permissions of [{ create: true, update: false }, { create: false, update: true }]) {
    const state = fixture(); state.personnel[0].permissions.daily = permissions;
    assert.throws(() => apply(emptyMaintenanceWorkbench(), create, { state }), /同时具备/);
  }
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
    if (body && !body.clientMutationId) body = { ...body, clientMutationId: `test-mutation-${++requestCount}` };
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
  const complete = await s.request({ siteId, expectedRevision: 1, action: "complete_task", taskId, completion: { kind: "waterQualityRecord", recordId: "water-1" } });
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

test("PostgreSQL: mutation IDs replay identical writes, reject changed payloads and complete one real record once", { skip: !databaseUrl }, async t => {
  const s = await harness(t); await s.request();
  const payload = { ...create, siteId, expectedRevision: 0, clientMutationId: "same-create-request" };
  const responses = await Promise.all([s.request(payload), s.request(structuredClone(payload))]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.deepEqual(responses.map(response => Boolean(response.body.replayed)).sort(), [false, true]);
  const changed = await s.request({ ...payload, task: { ...task, title: "changed" } });
  assert.equal(changed.status, 409); assert.equal(changed.body.code, "MAINTENANCE_IDEMPOTENCY_CONFLICT");
  const snapshot = await s.request(), taskId = snapshot.body.tasks[0].id;
  const empty = await s.request({ siteId, expectedRevision: snapshot.body.revision, action: "complete_task", taskId });
  assert.equal(empty.status, 400); assert.equal((await s.request()).body.tasks[0].status, "pending");
  const completion = { siteId, expectedRevision: snapshot.body.revision, clientMutationId: "real-record-completion", action: "complete_task", taskId,
    completion: { kind: "waterQualityRecord", recordId: "water-1" } };
  const completed = await s.request(completion); assert.equal(completed.status, 200); assert.equal(completed.body.tasks[0].completion.record.values[0].value, 8.1);
  const replay = await s.request(completion); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.history.filter(row => row.action === "complete_task").length, 1);
  const second = await s.request({ ...create, siteId, expectedRevision: replay.body.revision }); assert.equal(second.status, 200);
  const reused = await s.request({ ...completion, clientMutationId: "reuse-record-attempt", expectedRevision: second.body.revision, taskId: second.body.tasks[0].id });
  assert.equal(reused.status, 409); assert.equal(reused.body.code, "MAINTENANCE_COMPLETION_RECORD_USED");
  assert.deepEqual(await s.read(), s.state);
});

test("PostgreSQL: batch creation is atomic and response only contains scoped enabled assignees", { skip: !databaseUrl }, async t => {
  const s = await harness(t); const empty = await s.request();
  assert.deepEqual(empty.body.assignees, [{ id: "staff-id", username: "staff", name: "养护人员" }]);
  const body = { siteId, expectedRevision: 0, action: "create_task", task: { title: "目标观察", type: "inspection" },
    targets: [{ targetType: "group", tankId: "tank-nj" }, { targetType: "fish", stockItemId: "fish-1" }] };
  const bad = structuredClone(body); bad.targets[1].stockItemId = "missing";
  assert.equal((await s.request(bad)).status, 409); assert.equal((await s.request()).body.tasks.length, 0);
  const created = await s.request(body); assert.equal(created.status, 200); assert.equal(created.body.tasks.length, 2);
  const fish = created.body.tasks.find(row => row.targetType === "fish"); assert.equal(fish.currentSubTankId, "sub-nj");
  assert.equal(fish.targetUnavailable, false); assert.deepEqual(await s.read(), s.state);
});

test("PostgreSQL: concurrent materialization is idempotent and does not delete cancelled occurrences", { skip: !databaseUrl }, async t => {
  const s = await harness(t);
  const created = await s.request({ siteId, expectedRevision: 0, action: "create_plan", plan: { tankId: "tank-nj", targetType: "group", title: "日常观察", type: "inspection", frequency: "daily" } });
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
  const unavailable = await s.request(); assert.deepEqual(unavailable.body.assignees, []);
  assert.equal((await s.request({ ...create, siteId, expectedRevision: 0 })).status, 400, "a create-only staff member cannot be assigned an unfinishable task");
  const created = await s.request({ ...create, task: { ...task, assignedTo: "" }, siteId, expectedRevision: 0 }); assert.equal(created.status, 200);
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
