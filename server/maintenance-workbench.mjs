import { createHash, randomUUID } from "node:crypto";
import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value.trim() : "";
const fail = (message, statusCode = 400, code = "MAINTENANCE_WORKBENCH_INVALID") => { throw Object.assign(new Error(message), { statusCode, code }); };
const types = new Set(["inspection", "feeding", "water_change", "measurement", "treatment", "other"]);
const actionPermission = { create_task: "create", create_plan: "create", add_handoff: "create", start_task: "update", complete_task: "update", set_plan_enabled: "update", cancel_task: "delete" };
const clone = value => structuredClone(value);
export const emptyMaintenanceWorkbench = () => ({ tasks: [], plans: [], handoffs: [], history: [] });

function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("请求包含无效字段，请刷新后重试");
}
function string(value, label, max = 1000, required = false) {
  if (value != null && typeof value !== "string") fail(`${label}格式不正确`);
  const normalized = text(value);
  if ((required && !normalized) || normalized.length > max) fail(`${label}${required ? "不能为空，且" : ""}最多 ${max} 字`);
  return normalized;
}
function date(value, label) {
  const result = string(value, label, 10, true);
  const parsed = new Date(`${result}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) fail(`${label}不是有效日期`);
  return result;
}
const nextDay = value => new Date(Date.parse(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const previousDay = value => new Date(Date.parse(`${value}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
function dueTime(value) {
  const result = text(value) || "23:59";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(result)) fail("计划时间请填写时:分");
  return result;
}
function actor(account, now) {
  return { createdAt: now, createdBy: account.username, createdByName: account.name || account.username };
}
function assignee(state, username, siteId) {
  const result = string(username, "负责人", 120);
  if (!result) return "";
  const matches = list(state.personnel).filter(person => person.username === result);
  const person = matches.length === 1 ? matches[0] : null;
  if (!person || !isPersonnelAccountEnabled(person) || (person.accessRole !== "admin" && !list(person.visibleSiteIds).includes(siteId))) fail("负责人不存在、已停用或没有该场地权限");
  return result;
}
function location(state, input, siteId) {
  const tankId = string(input.tankId, "主缸", 120), subTankId = string(input.subTankId, "子缸", 120);
  if (subTankId && !tankId) fail("选择子缸前请先选择主缸");
  if (!tankId) return { tankId: "", subTankId: "", tankName: "", subTankName: "" };
  const matches = list(state.tankGroups).filter(group => group.id === tankId);
  const tank = matches.length === 1 ? matches[0] : null;
  if (!tank || String(tank.siteId || "nanjing") !== siteId) fail("所选缸位不属于当前场地");
  const children = list(tank.subTanks).filter(item => item.id === subTankId);
  if (subTankId && children.length !== 1) fail("所选子缸不属于该主缸");
  return { tankId, subTankId, tankName: tank.name || tankId, subTankName: children[0]?.name || "" };
}
const taskFields = ["title", "type", "tankId", "subTankId", "assignedTo", "dueDate", "dueTime", "notes"];
function taskDefinition(state, input, siteId, today) {
  if (!types.has(input.type)) fail("请选择有效任务类型");
  return { title: string(input.title, "任务名称", 150, true), type: input.type, ...location(state, input, siteId),
    assignedTo: assignee(state, input.assignedTo, siteId), dueDate: date(input.dueDate || today, "执行日期"),
    dueTime: dueTime(input.dueTime), notes: string(input.notes, "工作要求", 2000) };
}
function history(data, action, title, account, now, extra = {}) {
  data.history.unshift({ id: `mwh-${randomUUID()}`, action, title, operator: account.username,
    operatorName: account.name || account.username, at: now, ...extra });
}

/** Materialize due occurrences only, preserving each occurrence even after cancellation. */
export function materializeMaintenancePlans(stored, siteId, now) {
  const data = clone(stored), today = now.slice(0, 10);
  let changed = false, materializationPending = false;
  const ids = new Set(data.tasks.map(task => task.id));
  for (const plan of data.plans) {
    if (!plan.enabled || plan.startDate > today) continue;
    let day = plan.lastMaterializedDate ? nextDay(plan.lastMaterializedDate) : plan.startDate;
    if (day < plan.startDate) day = plan.startDate;
    let count = 0;
    for (; day <= today && count < 366; day = nextDay(day), count += 1) {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
      if (plan.frequency === "daily" || plan.weekdays.includes(weekday)) {
        const id = `mwt-${createHash("sha256").update(`${siteId}:${plan.id}:${day}`).digest("hex").slice(0, 32)}`;
        if (!ids.has(id)) {
          const { title, type, tankId, subTankId, tankName, subTankName, assignedTo, dueTime, notes } = plan;
          data.tasks.unshift({ id, siteId, planId: plan.id, title, type, tankId, subTankId, tankName, subTankName,
            assignedTo, dueTime, notes, dueDate: day, status: "pending", createdAt: now, createdBy: "system", createdByName: "重复计划" });
          ids.add(id);
          history(data, "materialize_task", title, { username: "system", name: "重复计划" }, now, { taskId: id, planId: plan.id, detail: `${day} ${dueTime}` });
        }
      }
      plan.lastMaterializedDate = day; changed = true;
    }
    if (day <= today) materializationPending = true;
  }
  return { data, changed, materializationPending };
}

export function applyMaintenanceWorkbenchAction(stored, body, { state, siteId, account, now, createId = prefix => `${prefix}-${randomUUID()}` }) {
  fields(body, ["siteId", "expectedRevision", "action", "task", "plan", "handoff", "taskId", "planId", "enabled", "result", "measurements", "medicineDescription", "reason"]);
  if (!actionPermission[body.action]) fail("不支持的工作台操作");
  const data = clone(stored), today = now.slice(0, 10), action = body.action;
  if (action === "create_task") {
    fields(body.task, taskFields);
    const task = { ...taskDefinition(state, body.task, siteId, today), id: createId("mwt"), siteId, status: "pending", ...actor(account, now) };
    data.tasks.unshift(task); history(data, action, task.title, account, now, { taskId: task.id });
  } else if (action === "create_plan") {
    fields(body.plan, [...taskFields.filter(key => key !== "dueDate"), "frequency", "weekdays", "startDate", "enabled"]);
    const input = body.plan;
    if (!["daily", "weekly"].includes(input.frequency)) fail("请选择每日或每周重复");
    const startDate = date(input.startDate || today, "计划开始日期");
    if (startDate < today) fail("重复计划不能追溯生成创建之前的任务");
    if (input.enabled != null && typeof input.enabled !== "boolean") fail("计划启用状态不正确");
    const weekdays = input.frequency === "weekly" ? input.weekdays : [];
    if (!Array.isArray(weekdays) || (input.frequency === "weekly" && !weekdays.length) || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) fail("每周计划请选择有效星期");
    const { dueDate: ignored, ...definition } = taskDefinition(state, input, siteId, today);
    const plan = { ...definition, id: createId("mwp"), siteId, frequency: input.frequency, weekdays: [...new Set(weekdays)].sort(),
      startDate, enabled: input.enabled !== false, ...actor(account, now) };
    data.plans.unshift(plan); history(data, action, plan.title, account, now, { planId: plan.id });
  } else if (action === "set_plan_enabled") {
    const matches = data.plans.filter(plan => plan.id === body.planId);
    if (matches.length !== 1) fail("重复计划不存在，请刷新后重试", 404);
    if (typeof body.enabled !== "boolean") fail("计划启用状态不正确");
    const plan = matches[0];
    if (plan.enabled === body.enabled) fail("计划状态已变化，请刷新后重试", 409);
    plan.enabled = body.enabled; plan.updatedAt = now; plan.updatedBy = account.username;
    if (body.enabled) plan.lastMaterializedDate = previousDay(today);
    history(data, action, plan.title, account, now, { planId: plan.id, detail: body.enabled ? "启用计划" : "停用计划，保留已生成任务" });
  } else if (action === "add_handoff") {
    fields(body.handoff, ["content", "assignedTo", "followUpAt", "taskId"]);
    const input = body.handoff, taskId = string(input.taskId, "关联任务", 120), followUpAt = string(input.followUpAt, "跟进时间", 19);
    if (taskId && data.tasks.filter(task => task.id === taskId).length !== 1) fail("关联任务不存在或不属于当前场地");
    if (followUpAt) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(followUpAt)) fail("跟进时间请填写有效北京时间");
      date(followUpAt.slice(0, 10), "跟进日期"); dueTime(followUpAt.slice(11, 16));
      if (followUpAt.length === 19 && !/^[0-5]\d$/.test(followUpAt.slice(17))) fail("跟进时间秒数无效");
    }
    const handoff = { id: createId("mwhandoff"), siteId, content: string(input.content, "交接内容", 3000, true),
      assignedTo: assignee(state, input.assignedTo, siteId), followUpAt, taskId, ...actor(account, now) };
    data.handoffs.unshift(handoff); history(data, action, "交接记录", account, now, { taskId, detail: handoff.content });
  } else {
    const matches = data.tasks.filter(task => task.id === body.taskId);
    if (matches.length !== 1) fail("任务不存在或不属于当前场地", 404);
    const task = matches[0];
    if (!["pending", "in_progress"].includes(task.status)) fail("任务已完成或取消，请刷新后查看记录", 409, "MAINTENANCE_TASK_CLOSED");
    if (action === "start_task") {
      if (task.status !== "pending") fail("任务已开始，请刷新后继续记录", 409);
      task.status = "in_progress"; task.startedAt = now; task.startedBy = account.username; task.startedByName = account.name || account.username;
    } else if (action === "complete_task") {
      const result = string(body.result, "实际执行结果", 3000, true);
      const medicineDescription = string(body.medicineDescription, "实际药品与用量说明", 2000);
      const measurements = body.measurements ?? {};
      if (!measurements || typeof measurements !== "object" || Array.isArray(measurements) || Object.keys(measurements).length > 30) fail("实测数据格式不正确");
      for (const [key, value] of Object.entries(measurements)) {
        if (!text(key) || key.length > 60 || typeof value !== "number" || !Number.isFinite(value)) fail("实测项目请填写名称和有效数值，不预设正常范围");
      }
      if (!task.startedAt) { task.startedAt = now; task.startedBy = account.username; task.startedByName = account.name || account.username; }
      Object.assign(task, { status: "completed", result, measurements: clone(measurements), medicineDescription,
        completedAt: now, completedBy: account.username, completedByName: account.name || account.username });
    } else {
      task.reason = string(body.reason, "取消原因", 2000, true); task.status = "cancelled";
      task.cancelledAt = now; task.cancelledBy = account.username; task.cancelledByName = account.name || account.username;
    }
    history(data, action, task.title, account, now, { taskId: task.id, ...(task.planId ? { planId: task.planId } : {}), detail: task.result || task.reason || "开始执行" });
  }
  return data;
}

export async function ensureMaintenanceWorkbenchSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS maintenance_workbench_sites (
    state_id TEXT NOT NULL, site_id TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 0,
    data JSONB NOT NULL DEFAULT '{"tasks":[],"plans":[],"handoffs":[],"history":[]}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (state_id, site_id))`);
}

/** Separate storage avoids rewriting business inventory and order state on every task. */
export function createMaintenanceWorkbenchHandler({ pool, stateId, readBody, sendJson, refreshAuth, requireSite, hasPermission, nowInChina }) {
  let schemaReady;
  return async (req, res, url) => {
    if (url.pathname !== "/api/maintenance-workbench") return false;
    res.setHeader("Cache-Control", "no-store, private");
    let client;
    try {
      if (!["GET", "POST"].includes(req.method)) fail("不支持的请求方式", 405);
      const raw = req.method === "POST" ? await readBody(req) : "";
      if (Buffer.byteLength(raw) > 32 * 1024) fail("工作台记录过大，请缩短内容", 413);
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { fail("请求内容不是有效 JSON"); }
      const siteId = string(req.method === "GET" ? url.searchParams.get("siteId") : body?.siteId, "场地", 120, true);
      const querySite = url.searchParams.get("siteId");
      if (querySite && querySite !== siteId) fail("场地不一致，请重新选择");
      schemaReady ??= ensureMaintenanceWorkbenchSchema(pool).catch(error => { schemaReady = undefined; throw error; });
      await schemaReady;
      client = await pool.connect();
      await client.query("BEGIN");
      const state = (await client.query("SELECT data FROM app_state WHERE id = $1 FOR SHARE", [stateId])).rows[0]?.data ?? {};
      refreshAuth(req, state); requireSite(req, state, siteId);
      const permissions = { canCreate: hasPermission(req.auth.account, "daily", "create"), canUpdate: hasPermission(req.auth.account, "daily", "update"), canDelete: hasPermission(req.auth.account, "daily", "delete") };
      if (!Object.values(permissions).some(Boolean)) fail("当前账号没有维护管理权限", 403, "MAINTENANCE_WORKBENCH_FORBIDDEN");
      if (req.method === "POST") {
        const needed = actionPermission[body.action];
        if (!needed) fail("不支持的工作台操作");
        if (!hasPermission(req.auth.account, "daily", needed)) fail("当前账号没有执行该养护操作的权限", 403, "MAINTENANCE_WORKBENCH_FORBIDDEN");
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) fail("缺少有效工作台版本，请刷新后重试", 409, "MAINTENANCE_WORKBENCH_CONFLICT");
      }
      await client.query("INSERT INTO maintenance_workbench_sites (state_id, site_id) VALUES ($1, $2) ON CONFLICT (state_id, site_id) DO NOTHING", [stateId, siteId]);
      const row = (await client.query("SELECT revision, data FROM maintenance_workbench_sites WHERE state_id = $1 AND site_id = $2 FOR UPDATE", [stateId, siteId])).rows[0];
      if (!row || !Number.isSafeInteger(Number(row.revision))) fail("工作台数据暂不可用", 503);
      let revision = Number(row.revision), data = row.data;
      if (req.method === "POST" && body.expectedRevision !== revision) fail("工作台已被更新，请刷新后核对再保存", 409, "MAINTENANCE_WORKBENCH_CONFLICT");
      const now = nowInChina(), materialized = materializeMaintenancePlans(data, siteId, now);
      data = materialized.data;
      let changed = materialized.changed, materializationPending = materialized.materializationPending;
      if (req.method === "POST") {
        data = applyMaintenanceWorkbenchAction(data, body, { state, siteId, account: req.auth.account, now });
        const afterAction = materializeMaintenancePlans(data, siteId, now);
        data = afterAction.data; materializationPending = afterAction.materializationPending;
        changed = true;
      }
      if (changed) {
        if (revision === Number.MAX_SAFE_INTEGER) fail("工作台版本超出范围，请联系管理员", 503);
        revision += 1;
        await client.query("UPDATE maintenance_workbench_sites SET data = $3::jsonb, revision = $4, updated_at = now() WHERE state_id = $1 AND site_id = $2", [stateId, siteId, JSON.stringify(data), revision]);
      }
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, siteId, revision, ...data, permissions, materializationPending });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error.statusCode || 500, { ok: false, code: error.code || "MAINTENANCE_WORKBENCH_UNAVAILABLE",
        error: error.statusCode ? error.message : "养护工作台暂不可用，请稍后重试" });
    } finally { client?.release(); }
    return true;
  };
}
