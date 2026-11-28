import { createHash, randomUUID } from "node:crypto";
import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";
import { projectedShippedOutStockIds } from "./shipment-inventory-integrity.mjs";
import { isStockInTransfer } from "./stock-transfer-rules.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value.trim() : "";
const fail = (message, statusCode = 400, code = "MAINTENANCE_WORKBENCH_INVALID") => { throw Object.assign(new Error(message), { statusCode, code }); };
const types = new Set(["inspection", "feeding", "water_change", "measurement", "treatment", "other", "media"]);
const actionPermission = { create_task: "create", create_plan: "create", update_task: "update", update_plan: "update", add_handoff: "create", start_task: "update", complete_task: "update", set_plan_enabled: "update", cancel_task: "delete" };
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
const canExecute = person => isPersonnelAccountEnabled(person) && (person.accessRole === "admin"
  || person.permissions?.daily?.create === true && person.permissions?.daily?.update === true);
function assignee(state, username, siteId) {
  const result = string(username, "负责人", 120);
  if (!result) return "";
  const matches = list(state.personnel).filter(person => person.username === result);
  const person = matches.length === 1 ? matches[0] : null;
  if (!person || !isPersonnelAccountEnabled(person) || (person.accessRole !== "admin" && !list(person.visibleSiteIds).includes(siteId))) fail("负责人不存在、已停用或没有该场地权限");
  if (!canExecute(person)) fail("负责人需要同时具备维护记录新增和任务执行权限");
  return result;
}
const targetFields = ["targetType", "tankId", "stockItemId"];
function location(state, input, siteId) {
  const targetType = input.targetType || (input.stockItemId ? "fish" : "group");
  if (!["group", "fish"].includes(targetType) || input.subTankId) fail("维护计划只能选择缸组或单条鱼，不能选择子缸");
  let tankId = string(input.tankId, "缸组", 120), stockItemId = string(input.stockItemId, "鱼只编号", 120);
  let fish;
  if (targetType === "fish") {
    const matches = list(state.stock).filter(item => item.id === stockItemId);
    fish = matches.length === 1 ? matches[0] : null;
    if (!fish || String(fish.siteId || "nanjing") !== siteId) fail("鱼只不存在或已移到其他场地", 409, "MAINTENANCE_TARGET_UNAVAILABLE");
    if (fish.lost) fail("该鱼已损耗，不能执行计划", 409, "MAINTENANCE_TARGET_UNAVAILABLE");
    if (isStockInTransfer(fish)) fail("该鱼正在移缸在途，签收入缸后才能执行", 409, "MAINTENANCE_TARGET_UNAVAILABLE");
    if ((state.maintenanceShippedIds || projectedShippedOutStockIds(state)).has(stockItemId)) fail("该鱼已出库，不能执行计划", 409, "MAINTENANCE_TARGET_UNAVAILABLE");
    const groups = list(state.tankGroups).filter(group => list(group.subTanks).some(sub => sub.id === fish.subTankId));
    if (groups.length !== 1) fail("鱼只当前缸位不存在或不唯一", 409, "MAINTENANCE_TARGET_UNAVAILABLE");
    tankId = groups[0].id;
  } else if (stockItemId) fail("缸组计划不能关联单条鱼");
  const matches = list(state.tankGroups).filter(group => group.id === tankId);
  const tank = matches.length === 1 ? matches[0] : null;
  if (!tank || String(tank.siteId || "nanjing") !== siteId) fail("所选缸组不存在或不属于当前场地", 409, "MAINTENANCE_TARGET_UNAVAILABLE");
  const product = fish && list(state.products).find(item => item.id === fish.productId);
  return { targetType, tankId, tankName: tank.name || tankId,
    ...(fish ? { stockItemId, fishCode: fish.code || fish.id, productName: product?.name || fish.productName || "鱼只" } : {}) };
}
const taskFields = ["title", "type", ...targetFields, "assignedTo", "dueDate", "dueTime", "notes"];
function taskDefinition(state, input, siteId, today) {
  if (!types.has(input.type)) fail("请选择有效任务类型");
  const target = location(state, input, siteId);
  if (target.targetType === "fish" && !["inspection", "treatment", "media", "other"].includes(input.type)) fail("喂食、换水和水质测量只能选择缸组");
  if (target.targetType === "group" && input.type === "media") fail("鱼只照片视频计划请选择单条鱼");
  return { title: string(input.title, "任务名称", 150, true), type: input.type, ...target,
    assignedTo: assignee(state, input.assignedTo, siteId), dueDate: date(input.dueDate || today, "执行日期"),
    dueTime: dueTime(input.dueTime), notes: string(input.notes, "工作要求", 2000) };
}
function planDefinition(state, input, siteId, today, existing) {
  fields(input, [...taskFields.filter(key => key !== "dueDate"), "frequency", "weekdays", "startDate", "enabled"]);
  if (!["daily", "weekly"].includes(input.frequency)) fail("请选择每日或每周重复");
  const startDate = date(input.startDate || today, "计划开始日期");
  if (startDate < today && startDate !== existing?.startDate) fail("重复计划不能追溯生成创建之前的任务");
  if (input.enabled != null && typeof input.enabled !== "boolean") fail("计划启用状态不正确");
  const weekdays = input.frequency === "weekly" ? input.weekdays : [];
  if (!Array.isArray(weekdays) || (input.frequency === "weekly" && !weekdays.length) || weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) fail("每周计划请选择有效星期");
  const { dueDate: ignored, ...definition } = taskDefinition(state, input, siteId, today);
  return { ...definition, frequency: input.frequency, weekdays: [...new Set(weekdays)].sort(), startDate, enabled: input.enabled !== false };
}
function targetsFor(body, definition) {
  if (body.targets === undefined) return [definition];
  if (!Array.isArray(body.targets) || !body.targets.length || body.targets.length > 100) fail("一次请选择 1 至 100 个维护目标");
  if (targetFields.some(key => text(definition[key]))) fail("批量创建时请仅在目标列表中选择目标");
  const seen = new Set();
  return body.targets.map(target => {
    fields(target, targetFields);
    const key = `${target.targetType || (target.stockItemId ? "fish" : "group")}:${text(target.stockItemId || target.tankId)}`;
    if (seen.has(key)) fail("维护目标重复，请只选择一次"); seen.add(key);
    return { ...definition, ...target };
  });
}
function history(data, action, title, account, now, extra = {}) {
  data.history.unshift({ id: `mwh-${randomUUID()}`, action, title, operator: account.username,
    operatorName: account.name || account.username, at: now, ...extra });
}

const recordCollections = { dailyLog: "logs", waterQualityRecord: "waterQualityRecords", bioRecord: "bioRecords" };
const dailyActions = { inspection: ["观察", "巡检", "观察巡检"], feeding: ["喂食"], water_change: ["换水", "换水清洁", "清洁"], treatment: ["下药", "水体下药", "治疗"], other: ["其他", "其他记录"] };
function completionDay(value) {
  const raw = text(value);
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/.test(raw)) return raw.slice(0, 10);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed + 8 * 3600000).toISOString().slice(0, 10) : "";
}
function verifyCompletion(data, task, body, state, siteId, account, completionRecord, now) {
  fields(body.completion, ["kind", "recordId"]);
  const { kind } = body.completion, recordId = string(body.completion.recordId, "执行记录", 120, true);
  if (!recordCollections[kind]) fail("请选择有效的维护记录类型");
  const records = completionRecord ? [completionRecord] : list(state[recordCollections[kind]]).filter(record => record.id === recordId);
  const record = records.length === 1 && records[0]?.id === recordId ? records[0] : null;
  if (!record || text(record.siteId) !== siteId) fail("执行记录不存在或不属于当前场地", 409, "MAINTENANCE_COMPLETION_RECORD_INVALID");
  if (text(record.createdBy || record.operator) !== account.username) fail("请关联本人实际提交的维护记录", 403, "MAINTENANCE_COMPLETION_RECORD_FORBIDDEN");
  const occurredDay = completionDay(kind === "waterQualityRecord" ? record.measuredAt : record.date);
  if (!occurredDay || occurredDay < task.dueDate || occurredDay > now.slice(0, 10)) fail("执行记录日期须在任务日期至今天之间", 409, "MAINTENANCE_COMPLETION_RECORD_INVALID");
  if (data.tasks.some(other => other.id !== task.id && other.completion?.kind === kind && other.completion?.recordId === recordId)) fail("这条记录已用于完成其他任务，不能重复完成", 409, "MAINTENANCE_COMPLETION_RECORD_USED");
  const isFish = task.targetType === "fish";
  if (isFish) {
    if (kind !== "bioRecord" || record.stockItemId !== task.stockItemId || record.sourceType && record.sourceType !== "manual") fail("请关联这条鱼的实际观察、治疗或拍摄记录", 409, "MAINTENANCE_COMPLETION_RECORD_INVALID");
    if (task.type === "media" ? !list(record.photos).length && !list(record.videos).length : !text(record.text)) fail(task.type === "media" ? "拍摄任务需要实际上传照片或视频" : "请填写这条鱼的实际维护内容");
  } else {
    if (list(record.inheritedTankGroupIds).length) fail("原房间继承的历史记录不能用于完成当前维护计划", 409, "MAINTENANCE_COMPLETION_RECORD_INVALID");
    if (record.tankGroupId !== task.tankId || text(record.subTankId)) fail("请关联当前缸组的整缸记录，不能使用子缸记录", 409, "MAINTENANCE_COMPLETION_RECORD_INVALID");
    if (task.type === "measurement") {
      if (kind !== "waterQualityRecord" || !list(record.values).length || record.values.some(value => typeof value.value !== "number" || !Number.isFinite(value.value))) fail("测水质任务需要实际水质测量值");
    } else {
      if (kind !== "dailyLog" || !dailyActions[task.type]?.includes(text(record.action))) fail("执行记录的操作与计划不一致", 409, "MAINTENANCE_COMPLETION_RECORD_INVALID");
      if (["treatment", "other"].includes(task.type) && !text(record.notes) && !list(record.photos).length && !list(record.videos).length) fail("请先记录实际用药或维护内容");
    }
  }
  const keys = ["id", "siteId", "date", "measuredAt", "tankGroupId", "scope", "recordedFromSubTankId", "stockItemId", "subTankId", "action", "text", "notes", "values", "photos", "videos", "operator", "createdBy"];
  const snapshot = Object.fromEntries(keys.filter(key => Object.hasOwn(record, key)).map(key => [key, clone(record[key])]));
  return { kind, recordId, record: snapshot };
}

export function maintenanceTargetAvailability(target, state, siteId) {
  try {
    if (target.subTankId) throw new Error("旧任务按子缸安排，请编辑并重新选择缸组或鱼只");
    const current = location(state, target, siteId);
    const group = list(state.tankGroups).find(item => item.id === current.tankId);
    const fish = current.stockItemId && list(state.stock).find(item => item.id === current.stockItemId);
    const sub = fish && list(group?.subTanks).find(item => item.id === fish.subTankId);
    return { targetUnavailable: false, targetUnavailableReason: "", currentTankId: current.tankId, currentTankName: current.tankName,
      ...(sub ? { currentSubTankId: sub.id, currentSubTankName: sub.name || sub.id } : {}) };
  } catch (error) { return { targetUnavailable: true, targetUnavailableReason: error.message }; }
}

/** Materialize due occurrences only, preserving each occurrence even after cancellation. */
export function materializeMaintenancePlans(stored, siteId, now) {
  const data = clone(stored), today = now.slice(0, 10);
  let changed = false, materializationPending = false, generated = 0;
  const ids = new Set(data.tasks.map(task => task.id));
  for (const plan of data.plans) {
    if (!plan.enabled || plan.startDate > today || plan.subTankId) continue;
    let day = plan.lastMaterializedDate ? nextDay(plan.lastMaterializedDate) : plan.startDate;
    if (day < plan.startDate) day = plan.startDate;
    let count = 0;
    for (; day <= today && count < 366 && generated < 500; day = nextDay(day), count += 1) {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
      if (plan.frequency === "daily" || plan.weekdays.includes(weekday)) {
        const id = `mwt-${createHash("sha256").update(`${siteId}:${plan.id}:${day}`).digest("hex").slice(0, 32)}`;
        if (!ids.has(id)) {
          const { title, type, targetType, tankId, tankName, stockItemId, fishCode, productName, assignedTo, dueTime, notes } = plan;
          data.tasks.unshift({ id, siteId, planId: plan.id, title, type, targetType: targetType || "group", tankId, tankName, stockItemId, fishCode, productName,
            assignedTo, dueTime, notes, dueDate: day, status: "pending", createdAt: now, createdBy: "system", createdByName: "重复计划" });
          ids.add(id);
          generated += 1;
          history(data, "materialize_task", title, { username: "system", name: "重复计划" }, now, { taskId: id, planId: plan.id, detail: `${day} ${dueTime}` });
        }
      }
      plan.lastMaterializedDate = day; changed = true;
    }
    if (day <= today) materializationPending = true;
  }
  return { data, changed, materializationPending };
}

export function applyMaintenanceWorkbenchAction(stored, body, { state, siteId, account, now, completionRecord, createId = prefix => `${prefix}-${randomUUID()}` }) {
  fields(body, ["siteId", "expectedRevision", "clientMutationId", "action", "task", "plan", "targets", "handoff", "taskId", "planId", "enabled", "completion", "reason"]);
  if (!actionPermission[body.action]) fail("不支持的工作台操作");
  if (body.targets !== undefined && !["create_task", "create_plan"].includes(body.action)) fail("只有新建计划或任务可以批量选择目标");
  const data = clone(stored), today = now.slice(0, 10), action = body.action;
  if (action === "create_task") {
    fields(body.task, taskFields);
    for (const input of targetsFor(body, body.task)) {
      const task = { ...taskDefinition(state, input, siteId, today), id: createId("mwt"), siteId, status: "pending", ...actor(account, now) };
      data.tasks.unshift(task); history(data, action, task.title, account, now, { taskId: task.id, after: clone(task) });
    }
  } else if (action === "create_plan") {
    fields(body.plan, [...taskFields.filter(key => key !== "dueDate"), "frequency", "weekdays", "startDate", "enabled"]);
    for (const input of targetsFor(body, body.plan)) {
      const plan = { ...planDefinition(state, input, siteId, today), id: createId("mwp"), siteId, ...actor(account, now) };
      data.plans.unshift(plan); history(data, action, plan.title, account, now, { planId: plan.id, after: clone(plan) });
    }
  } else if (action === "update_plan") {
    const matches = data.plans.filter(plan => plan.id === body.planId);
    if (matches.length !== 1) fail("重复计划不存在，请刷新后重试", 404);
    const plan = matches[0], before = clone(plan), definition = planDefinition(state, body.plan, siteId, today, plan);
    delete plan.subTankId; delete plan.subTankName; delete plan.stockItemId; delete plan.fishCode; delete plan.productName;
    Object.assign(plan, definition, { updatedAt: now, updatedBy: account.username, lastMaterializedDate: plan.lastMaterializedDate && plan.lastMaterializedDate > today ? plan.lastMaterializedDate : today });
    history(data, action, plan.title, account, now, { planId: plan.id, detail: "只修改后续计划，已生成任务保持原安排", before, after: clone(plan) });
  } else if (action === "set_plan_enabled") {
    const matches = data.plans.filter(plan => plan.id === body.planId);
    if (matches.length !== 1) fail("重复计划不存在，请刷新后重试", 404);
    if (typeof body.enabled !== "boolean") fail("计划启用状态不正确");
    const plan = matches[0];
    if (plan.enabled === body.enabled) return data;
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
    if (action === "update_task") {
      fields(body.task, taskFields);
      const before = clone(task), definition = taskDefinition(state, body.task, siteId, today);
      delete task.subTankId; delete task.subTankName; delete task.stockItemId; delete task.fishCode; delete task.productName;
      Object.assign(task, definition, { updatedAt: now, updatedBy: account.username });
      history(data, action, task.title, account, now, { taskId: task.id, before, after: clone(task) }); return data;
    }
    if (["start_task", "complete_task"].includes(action)) {
      if (task.assignedTo && task.assignedTo !== account.username && account.accessRole !== "admin") fail("此任务已安排给其他负责人", 403, "MAINTENANCE_TASK_ASSIGNEE_ONLY");
      const available = maintenanceTargetAvailability(task, state, siteId);
      if (available.targetUnavailable) fail(available.targetUnavailableReason, 409, "MAINTENANCE_TARGET_UNAVAILABLE");
    }
    if (action === "start_task") {
      if (task.status !== "pending") fail("任务已开始，请刷新后继续记录", 409);
      task.status = "in_progress"; task.startedAt = now; task.startedBy = account.username; task.startedByName = account.name || account.username;
      if (!task.assignedTo) task.assignedTo = account.username;
    } else if (action === "complete_task") {
      const completion = verifyCompletion(data, task, body, state, siteId, account, completionRecord, now);
      const result = text(completion.record.text || completion.record.notes || completion.record.action) || (completion.kind === "waterQualityRecord" ? "已记录实际水质" : "已上传照片视频");
      if (!task.startedAt) { task.startedAt = now; task.startedBy = account.username; task.startedByName = account.name || account.username; }
      Object.assign(task, { status: "completed", result, completion,
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

const requestDigest = value => {
  const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
};
function responseData(data, state, siteId, hasPermission) {
  const available = row => ({ ...row, ...maintenanceTargetAvailability(row, state, siteId) });
  return { tasks: data.tasks.map(available), plans: data.plans.map(available), handoffs: data.handoffs, history: data.history,
    assignees: list(state.personnel).filter(person => isPersonnelAccountEnabled(person)
      && (person.accessRole === "admin" || list(person.visibleSiteIds).includes(siteId))
      && ["create", "update"].every(action => hasPermission(person, "daily", action)))
      .map(person => ({ id: person.id, username: person.username, name: person.name || person.username })) };
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
      if (Buffer.byteLength(raw) > 256 * 1024) fail("工作台记录过大，请缩短内容", 413);
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { fail("请求内容不是有效 JSON"); }
      const siteId = string(req.method === "GET" ? url.searchParams.get("siteId") : body?.siteId, "场地", 120, true);
      const querySite = url.searchParams.get("siteId");
      if (querySite && querySite !== siteId) fail("场地不一致，请重新选择");
      schemaReady ??= ensureMaintenanceWorkbenchSchema(pool).catch(error => { schemaReady = undefined; throw error; });
      await schemaReady;
      client = await pool.connect();
      await client.query("BEGIN");
      const state = (await client.query(`SELECT data->'personnel' AS personnel, data->'sites' AS sites,
        data->'tankGroups' AS "tankGroups", data->'products' AS products,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s->'id','siteId',s->'siteId','subTankId',s->'subTankId',
          'productId',s->'productId','code',s->'code','lost',s->'lost','tankTransfer',s->'tankTransfer'))
          FROM jsonb_array_elements(COALESCE(data->'stock','[]'::jsonb)) s),'[]'::jsonb) AS stock,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('status',s->'status','itemStockIds',s->'itemStockIds'))
          FROM jsonb_array_elements(COALESCE(data->'shipments','[]'::jsonb)) s),'[]'::jsonb) AS shipments,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('status',o->'status','items',o->'items'))
          FROM jsonb_array_elements(COALESCE(data->'orders','[]'::jsonb)) o WHERE o->>'status'='completed'),'[]'::jsonb) AS orders
        FROM app_state WHERE id = $1 FOR SHARE`, [stateId])).rows[0];
      if (!state) fail("系统数据暂不可用", 503);
      state.maintenanceShippedIds = projectedShippedOutStockIds(state);
      refreshAuth(req, state); requireSite(req, state, siteId);
      const permissions = { canCreate: hasPermission(req.auth.account, "daily", "create"), canUpdate: hasPermission(req.auth.account, "daily", "update"), canDelete: hasPermission(req.auth.account, "daily", "delete") };
      if (!Object.values(permissions).some(Boolean)) fail("当前账号没有维护管理权限", 403, "MAINTENANCE_WORKBENCH_FORBIDDEN");
      if (req.method === "POST") {
        const needed = actionPermission[body.action];
        if (!needed) fail("不支持的工作台操作");
        if (!hasPermission(req.auth.account, "daily", needed)) fail("当前账号没有执行该养护操作的权限", 403, "MAINTENANCE_WORKBENCH_FORBIDDEN");
        if (["start_task", "complete_task"].includes(body.action) && !canExecute(req.auth.account)) fail("执行任务需要同时具备维护记录新增和任务执行权限", 403, "MAINTENANCE_WORKBENCH_FORBIDDEN");
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) fail("缺少有效工作台版本，请刷新后重试", 409, "MAINTENANCE_WORKBENCH_CONFLICT");
        if (!/^[A-Za-z0-9_-]{8,120}$/.test(text(body.clientMutationId))) fail("缺少有效提交编号，请重新打开操作", 400, "MAINTENANCE_MUTATION_ID_REQUIRED");
      }
      await client.query("INSERT INTO maintenance_workbench_sites (state_id, site_id) VALUES ($1, $2) ON CONFLICT (state_id, site_id) DO NOTHING", [stateId, siteId]);
      const row = (await client.query("SELECT revision, data FROM maintenance_workbench_sites WHERE state_id = $1 AND site_id = $2 FOR UPDATE", [stateId, siteId])).rows[0];
      if (!row || !Number.isSafeInteger(Number(row.revision))) fail("工作台数据暂不可用", 503);
      let revision = Number(row.revision), data = row.data;
      if (req.method === "POST") {
        const replay = list(data.mutations).find(entry => entry.id === body.clientMutationId);
        if (replay) {
          if (replay.operator !== req.auth.account.username || replay.digest !== requestDigest(body)) fail("提交编号已用于其他内容，请重新打开操作", 409, "MAINTENANCE_IDEMPOTENCY_CONFLICT");
          await client.query("COMMIT");
          sendJson(req, res, 200, { ok: true, siteId, revision, ...responseData(data, state, siteId, hasPermission), permissions, replayed: true }); return true;
        }
      }
      if (req.method === "POST" && body.expectedRevision !== revision) fail("工作台已被更新，请刷新后核对再保存", 409, "MAINTENANCE_WORKBENCH_CONFLICT");
      const now = nowInChina(), materialized = materializeMaintenancePlans(data, siteId, now);
      data = materialized.data;
      let changed = materialized.changed, materializationPending = materialized.materializationPending;
      if (req.method === "POST") {
        let completionRecord;
        if (body.action === "complete_task") {
          fields(body.completion, ["kind", "recordId"]);
          const collection = recordCollections[body.completion.kind];
          if (!collection) fail("请选择有效的执行记录类型");
          const recordId = string(body.completion.recordId, "执行记录", 120, true);
          const records = (await client.query(`SELECT record AS maintenance_completion_record
            FROM app_state CROSS JOIN LATERAL jsonb_array_elements(COALESCE(data->'${collection}','[]'::jsonb)) record
            WHERE id=$1 AND record->>'id'=$2 LIMIT 2`, [stateId, recordId])).rows;
          if (records.length !== 1) fail("执行记录不存在或编号不唯一", 409, "MAINTENANCE_COMPLETION_RECORD_INVALID");
          completionRecord = records[0].maintenance_completion_record;
        }
        data = applyMaintenanceWorkbenchAction(data, body, { state, siteId, account: req.auth.account, now, completionRecord });
        const afterAction = materializeMaintenancePlans(data, siteId, now);
        data = afterAction.data; materializationPending = afterAction.materializationPending;
        changed = true;
        data.mutations = [...list(data.mutations), { id: body.clientMutationId, digest: requestDigest(body), operator: req.auth.account.username, at: now }].slice(-200);
      }
      if (changed) {
        if (revision === Number.MAX_SAFE_INTEGER) fail("工作台版本超出范围，请联系管理员", 503);
        revision += 1;
        await client.query("UPDATE maintenance_workbench_sites SET data = $3::jsonb, revision = $4, updated_at = now() WHERE state_id = $1 AND site_id = $2", [stateId, siteId, JSON.stringify(data), revision]);
      }
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, siteId, revision, ...responseData(data, state, siteId, hasPermission), permissions, materializationPending });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error.statusCode || 500, { ok: false, code: error.code || "MAINTENANCE_WORKBENCH_UNAVAILABLE",
        error: error.statusCode ? error.message : "养护工作台暂不可用，请稍后重试" });
    } finally { client?.release(); }
    return true;
  };
}
