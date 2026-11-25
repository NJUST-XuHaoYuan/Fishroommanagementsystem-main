import { randomUUID } from "node:crypto";
import { resolveNewCustomerOrderOwner } from "./new-customer-approval.mjs";
import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value.trim() : "";
const fail = (message, statusCode = 400, code = "ORDER_FOLLOWUP_INVALID") => { throw Object.assign(new Error(message), { statusCode, code }); };
function requiredText(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(`${label}不能为空，且最多 ${max} 字`);
  return value.trim();
}

export function isOrderFollowupOwner(personnel, order, account) {
  const owner = resolveNewCustomerOrderOwner(personnel, order);
  return Boolean(isPersonnelAccountEnabled(account) && text(account.id) && text(account.username)
    && owner && text(owner.id) === text(account.id) && text(owner.username) === text(account.username));
}

export function normalizeOrderFollowupInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => !["siteId", "orderId", "content", "clientMutationId"].includes(key))) fail("回访请求包含无效字段，请刷新后重试");
  const input = { siteId: requiredText(body.siteId, "场地", 120), orderId: requiredText(body.orderId, "订单编号", 120),
    content: requiredText(body.content, "回访内容", 3000), clientMutationId: requiredText(body.clientMutationId, "提交编号", 120) };
  if (input.siteId === "all") fail("请选择具体场地后登记回访");
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(input.clientMutationId)) fail("提交编号无效，请重新打开回访窗口");
  return input;
}

export async function ensureOrderFollowupSchema(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS order_followups (
    id TEXT PRIMARY KEY, state_id TEXT NOT NULL, site_id TEXT NOT NULL, order_id TEXT NOT NULL,
    order_no TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
    operator TEXT NOT NULL, operator_name TEXT NOT NULL, operator_personnel_id TEXT NOT NULL,
    client_mutation_id TEXT NOT NULL, UNIQUE (state_id, client_mutation_id))`);
  await pool.query("CREATE INDEX IF NOT EXISTS order_followups_order_history ON order_followups (state_id, order_id, created_at DESC, id DESC)");
}

// A projection under the same row lock as order mutations keeps ownership and
// completion authoritative without transferring inventory, payments or media.
const stateQuery = `SELECT jsonb_build_object(
  'personnel', COALESCE(data -> 'personnel', '[]'::jsonb),
  'sites', COALESCE(data -> 'sites', '[]'::jsonb),
  'orders', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', item -> 'id', 'orderNo', item -> 'orderNo', 'siteId', item -> 'siteId',
    'status', item -> 'status', 'contactPersonnelId', item -> 'contactPersonnelId', 'contactPerson', item -> 'contactPerson'))
    FROM jsonb_array_elements(COALESCE(data -> 'orders', '[]'::jsonb)) item), '[]'::jsonb)
) AS data FROM app_state WHERE id = $1 FOR SHARE`;

async function readRecords(client, stateId, siteId, orderId) {
  return (await client.query(`SELECT id, content, created_at AS "createdAt", operator,
    operator_name AS "operatorName", operator_personnel_id AS "operatorPersonnelId"
    FROM order_followups WHERE state_id = $1 AND site_id = $2 AND order_id = $3
    ORDER BY created_at DESC, id DESC`, [stateId, siteId, orderId])).rows;
}

/** Append-only records are their own audit trail; this API never writes app_state. */
export function createOrderFollowupHandler({ pool, stateId, readBody, sendJson, refreshAuth, requireSite, hasPermission, normalizeSiteId, nowInChina }) {
  let schemaReady;
  return async (req, res, url) => {
    if (url.pathname !== "/api/order-followups") return false;
    res.setHeader("Cache-Control", "no-store, private");
    let client;
    try {
      if (!["GET", "POST"].includes(req.method)) fail("不支持的请求方式", 405);
      let input;
      if (req.method === "POST") {
        const raw = await readBody(req, 16 * 1024);
        if (Buffer.byteLength(raw) > 16 * 1024) fail("回访内容过大，请缩短后重试", 413);
        let body;
        try { body = JSON.parse(raw); } catch { fail("请求内容不是有效 JSON"); }
        input = normalizeOrderFollowupInput(body);
      } else {
        input = { siteId: requiredText(url.searchParams.get("siteId"), "场地", 120), orderId: text(url.searchParams.get("orderId")) };
        if (input.siteId === "all") fail("请选择具体场地后查看回访");
        if (input.orderId.length > 120 || (url.searchParams.has("orderId") && !input.orderId)) fail("订单编号无效");
      }
      for (const key of ["siteId", "orderId"]) {
        if (req.method === "POST" && url.searchParams.has(key) && url.searchParams.get(key) !== input[key]) fail("请求场地或订单不一致，请重新打开回访窗口");
      }
      schemaReady ??= ensureOrderFollowupSchema(pool).catch(error => { schemaReady = undefined; throw error; });
      await schemaReady;
      client = await pool.connect();
      await client.query("BEGIN");
      const state = (await client.query(stateQuery, [stateId])).rows[0]?.data ?? {};
      refreshAuth(req, state);
      requireSite(req, state, input.siteId);
      const account = req.auth.account;
      if (!["create", "update", "delete"].some(action => hasPermission(account, "orders", action))) fail("当前账号没有订单查看权限", 403, "ORDER_FOLLOWUP_FORBIDDEN");
      let payload;
      if (!input.orderId) {
        // Even administrators see their own work queue; other owners' history is
        // available only when explicitly opening an authorized order detail.
        const orders = list(state.orders).filter(order => normalizeSiteId(order.siteId) === input.siteId && order.status === "completed"
          && isOrderFollowupOwner(state.personnel, order, account));
        const ids = orders.map(order => text(order.id));
        const allIds = new Map();
        for (const order of list(state.orders)) allIds.set(text(order.id), (allIds.get(text(order.id)) || 0) + 1);
        if (ids.some(id => !id || allIds.get(id) !== 1)) fail("订单编号不唯一，无法安全读取回访", 409, "ORDER_FOLLOWUP_ORDER_CONFLICT");
        const summaries = ids.length ? (await client.query(`SELECT order_id, count(*)::int AS count, max(created_at) AS latest
          FROM order_followups WHERE state_id = $1 AND site_id = $2 AND order_id = ANY($3::text[]) GROUP BY order_id`, [stateId, input.siteId, ids])).rows : [];
        const byOrder = new Map(summaries.map(row => [row.order_id, row]));
        payload = { ok: true, siteId: input.siteId, orders: ids.map(orderId => ({ orderId,
          followupCount: Number(byOrder.get(orderId)?.count || 0), lastFollowupAt: byOrder.get(orderId)?.latest || "" })) };
      } else {
        const matches = list(state.orders).filter(order => text(order.id) === input.orderId);
        if (matches.length > 1) fail("订单编号不唯一，无法安全读取回访", 409, "ORDER_FOLLOWUP_ORDER_CONFLICT");
        const order = matches[0];
        if (!order || normalizeSiteId(order.siteId) !== input.siteId) fail("订单不存在或不属于当前场地", 404, "ORDER_FOLLOWUP_NOT_FOUND");
        if (account.accessRole !== "admin" && !isOrderFollowupOwner(state.personnel, order, account)) fail("仅当前订单负责人或管理员可以查看和登记回访", 403, "ORDER_FOLLOWUP_FORBIDDEN");
        const canCreate = order.status === "completed" && hasPermission(account, "orders", "update");
        let replayed = false;
        if (req.method === "POST") {
          if (!hasPermission(account, "orders", "update")) fail("当前账号没有登记回访的订单修改权限", 403, "ORDER_FOLLOWUP_FORBIDDEN");
          if (order.status !== "completed") fail("订单完成后才能登记回访", 409, "ORDER_FOLLOWUP_ORDER_NOT_COMPLETED");
          const inserted = await client.query(`INSERT INTO order_followups
            (id, state_id, site_id, order_id, order_no, content, created_at, operator, operator_name, operator_personnel_id, client_mutation_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (state_id, client_mutation_id) DO NOTHING RETURNING id`,
          [`of-${randomUUID()}`, stateId, input.siteId, input.orderId, text(order.orderNo), input.content, nowInChina(),
            account.username, account.name || account.username, account.id, input.clientMutationId]);
          if (!inserted.rowCount) {
            const prior = (await client.query("SELECT * FROM order_followups WHERE state_id = $1 AND client_mutation_id = $2", [stateId, input.clientMutationId])).rows[0];
            if (!prior || prior.site_id !== input.siteId || prior.order_id !== input.orderId || prior.content !== input.content
              || prior.operator !== account.username || prior.operator_personnel_id !== account.id) fail("该提交编号已用于其他回访内容，请刷新后重试", 409, "ORDER_FOLLOWUP_IDEMPOTENCY_CONFLICT");
            replayed = true;
          }
        }
        const records = await readRecords(client, stateId, input.siteId, input.orderId);
        payload = { ok: true, siteId: input.siteId, orderId: input.orderId, records, total: records.length, canCreate,
          ...(req.method === "POST" ? { replayed } : {}) };
      }
      await client.query("COMMIT");
      sendJson(req, res, 200, payload);
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error.statusCode || 500, { ok: false, code: error.code || "ORDER_FOLLOWUP_UNAVAILABLE",
        error: error.statusCode ? error.message : "回访记录暂不可用，请稍后重试" });
    } finally { client?.release(); }
    return true;
  };
}
