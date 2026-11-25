import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrderFollowupHandler, ensureOrderFollowupSchema, isOrderFollowupOwner, normalizeOrderFollowupInput } from "./order-followups.mjs";

const siteId = "nanjing", now = "2026-11-26T15:30:00";
const staff = { id: "staff-id", username: "staff", name: "销售甲", accessRole: "staff", accountEnabled: true,
  visibleSiteIds: [siteId], permissions: { orders: { create: true, update: true, delete: false } }, sessionVersion: 0 };
const other = { ...staff, id: "other-id", username: "other", name: "销售乙" };
const admin = { ...staff, id: "admin-id", username: "admin", name: "管理员", accessRole: "admin" };
const order = (id, patch = {}) => ({ id, siteId, orderNo: `SO-${id}`, status: "completed", contactPersonnelId: staff.id, contactPerson: staff.name,
  amountDue: 100, payments: [{ id: "untouched-payment", amount: 100 }], ...patch });
const fixture = () => ({ sites: [{ id: siteId }, { id: "jiangyin" }], personnel: [structuredClone(staff), structuredClone(other), structuredClone(admin)],
  orders: [order("mine"), order("mine2"), order("other", { contactPersonnelId: other.id, contactPerson: other.name }),
    order("pending", { status: "pending" }), order("foreign", { siteId: "jiangyin" }), order("admin", { contactPersonnelId: admin.id, contactPerson: admin.name })],
  stock: [{ id: "fish-unchanged", sold: true }], operationLogs: [{ id: "unchanged" }] });
const body = (patch = {}) => ({ siteId, orderId: "mine", content: "已回访，客户反馈正常", clientMutationId: "mutation-0001", ...patch });

test("owner resolution uses canonical personnel ID, unique legacy reference and never createdBy", () => {
  const people = [staff, other];
  assert.equal(isOrderFollowupOwner(people, order("mine"), staff), true);
  assert.equal(isOrderFollowupOwner(people, order("foreign", { contactPersonnelId: other.id, createdBy: staff.username }), staff), false);
  assert.equal(isOrderFollowupOwner(people, order("legacy", { contactPersonnelId: "", contactPerson: staff.username }), staff), true);
  assert.equal(isOrderFollowupOwner([...people, { ...other, name: staff.name }], order("ambiguous", { contactPersonnelId: "" }), staff), false);
  assert.equal(isOrderFollowupOwner(people, order("stale", { contactPersonnelId: "missing-id" }), staff), false);
  assert.equal(isOrderFollowupOwner(people, order("pending-assignment", { ownerAssignment: { toPersonnelId: other.id, status: "pending" } }), other), false);
  assert.equal(isOrderFollowupOwner(people, order("mine"), { ...staff, accountEnabled: false }), false);
});

test("input requires meaningful content and stable ID, rejecting forged audit fields", () => {
  assert.equal(normalizeOrderFollowupInput(body({ content: "  正常  " })).content, "正常");
  for (const patch of [{ content: " " }, { content: "字".repeat(3001) }, { content: 123 }, { clientMutationId: "" }, { clientMutationId: "bad ID !" },
    { siteId: "all" }, { orderId: "" }, { operator: "admin" }, { createdAt: "1999-01-01" }, { status: "completed" }]) {
    assert.throws(() => normalizeOrderFollowupInput(body(patch)));
  }
});

// Only a separately created disposable local PostgreSQL database is accepted.
const databaseUrl = process.env.ORDER_FOLLOWUP_TEST_DATABASE_URL;
let pool, serial = 0;
before(async () => {
  if (!databaseUrl) return;
  const url = new URL(databaseUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && /^\/order_followups_test_[a-z0-9_]+$/.test(url.pathname));
  pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query("CREATE TABLE IF NOT EXISTS app_state (id TEXT PRIMARY KEY, data JSONB NOT NULL)");
  await ensureOrderFollowupSchema(pool); await ensureOrderFollowupSchema(pool);
});
after(async () => { await pool?.end(); });

async function harness(t) {
  const stateId = `followup-test-${++serial}`, original = fixture();
  await pool.query("INSERT INTO app_state VALUES ($1,$2::jsonb)", [stateId, JSON.stringify(original)]);
  t.after(async () => {
    await pool.query("DELETE FROM order_followups WHERE state_id = $1", [stateId]);
    await pool.query("DELETE FROM app_state WHERE id = $1", [stateId]);
  });
  let clock = now;
  const hasPermission = (account, module, action) => account.accountEnabled !== false && (account.accessRole === "admin" || account.permissions?.[module]?.[action] === true);
  const handler = createOrderFollowupHandler({ pool, stateId, readBody: async req => JSON.stringify(req.body),
    sendJson: (_req, res, status, payload) => { res.status = status; res.body = payload; },
    nowInChina: () => clock, normalizeSiteId: value => String(value || "nanjing").trim(), hasPermission,
    refreshAuth(req, state) {
      const matches = state.personnel.filter(person => person.username === req.auth.user.username);
      const live = matches.length === 1 ? matches[0] : null;
      if (!live || live.id !== req.auth.account.id || live.accountEnabled === false || live.employmentStatus === "resigned"
        || (live.sessionVersion || 0) !== (req.auth.account.sessionVersion || 0) || live.accessRole !== req.auth.account.accessRole) throw Object.assign(new Error("账号已变化"), { statusCode: 403 });
      req.auth.account = live;
    },
    requireSite(req, state, selected) {
      if (state.sites.filter(site => site.id === selected).length !== 1 || (req.auth.account.accessRole !== "admin" && !req.auth.account.visibleSiteIds.includes(selected))) {
        throw Object.assign(new Error("场地无权访问"), { statusCode: 403 });
      }
    },
  });
  const request = async ({ payload, orderId, selected = siteId, actor = staff, method = payload ? "POST" : "GET", extraQuery = {} } = {}) => {
    const query = new URLSearchParams({ siteId: selected, ...(orderId != null ? { orderId } : {}), ...extraQuery });
    const req = { method, body: payload, auth: { user: { username: actor.username }, account: structuredClone(actor) } }, res = { setHeader() {} };
    await handler(req, res, new URL(`http://localhost/api/order-followups?${query}`));
    return res;
  };
  const read = async () => (await pool.query("SELECT data FROM app_state WHERE id=$1", [stateId])).rows[0].data;
  const change = async mutate => { const state = await read(); mutate(state); await pool.query("UPDATE app_state SET data=$2::jsonb WHERE id=$1", [stateId, JSON.stringify(state)]); };
  return { stateId, request, read, change, original, setTime: value => { clock = value; } };
}
const pgTest = (name, run) => test(`PostgreSQL: ${name}`, { skip: !databaseUrl }, run);

pgTest("append and reopen preserve records, immutable business state, and summary clears first-followup queue", async t => {
  const s = await harness(t);
  const empty = await s.request(); assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.orders.map(row => row.orderId).sort(), ["mine", "mine2"]);
  assert.ok(empty.body.orders.every(row => row.followupCount === 0));
  const first = await s.request({ payload: body() }); assert.equal(first.status, 200);
  assert.equal(first.body.replayed, false); assert.equal(first.body.total, 1); assert.equal(first.body.canCreate, true);
  assert.deepEqual(Object.fromEntries(["content", "createdAt", "operator", "operatorName", "operatorPersonnelId"].map(key => [key, first.body.records[0][key]])),
    { content: body().content, createdAt: now, operator: staff.username, operatorName: staff.name, operatorPersonnelId: staff.id });
  s.setTime("2026-11-27T10:00:00");
  const second = await s.request({ payload: body({ content: "第二次回访", clientMutationId: "mutation-0002" }) });
  assert.equal(second.body.total, 2); assert.equal(second.body.records[0].content, "第二次回访");
  const reopened = await s.request({ orderId: "mine" }); assert.deepEqual(reopened.body.records, second.body.records);
  const summary = await s.request(); const mine = summary.body.orders.find(row => row.orderId === "mine");
  assert.equal(mine.followupCount, 2); assert.equal(mine.lastFollowupAt, "2026-11-27T10:00:00");
  assert.deepEqual(summary.body.orders.filter(row => row.followupCount === 0).map(row => row.orderId), ["mine2"]);
  assert.doesNotMatch(JSON.stringify(summary.body), /第二次回访|客户反馈正常/);
  assert.deepEqual(await s.read(), s.original);
});

pgTest("concurrent retry is idempotent, changed content/order/actor conflicts without duplicate writes", async t => {
  const s = await harness(t);
  const results = await Promise.all([s.request({ payload: body() }), s.request({ payload: body() })]);
  assert.ok(results.every(result => result.status === 200));
  assert.deepEqual(results.map(result => result.body.replayed).sort(), [false, true]);
  for (const request of [{ payload: body({ content: "不同内容" }) }, { payload: body({ orderId: "mine2" }) }, { payload: body(), actor: admin }]) {
    const response = await s.request(request); assert.equal(response.status, 409); assert.equal(response.body.code, "ORDER_FOLLOWUP_IDEMPOTENCY_CONFLICT");
  }
  assert.equal((await s.request({ orderId: "mine" })).body.total, 1);
  assert.equal((await s.request({ orderId: "mine2" })).body.total, 0);
  assert.deepEqual(await s.read(), s.original);
});

pgTest("other owners, foreign sites and incomplete orders cannot receive followups; admins may append but summary stays personal", async t => {
  const s = await harness(t);
  for (const orderId of ["other", "foreign"]) {
    for (const request of [{ orderId }, { payload: body({ orderId }) }]) assert.ok([403, 404].includes((await s.request(request)).status));
  }
  assert.equal((await s.request({ selected: "jiangyin" })).status, 403);
  assert.equal((await s.request({ selected: "all" })).status, 400);
  assert.equal((await s.request({ payload: body({ siteId: "jiangyin", orderId: "foreign" }), selected: "jiangyin" })).status, 403);
  assert.equal((await s.request({ payload: body({ orderId: "pending" }) })).body.code, "ORDER_FOLLOWUP_ORDER_NOT_COMPLETED");
  assert.equal((await s.request({ orderId: "pending" })).body.canCreate, false);
  const allowed = await s.request({ actor: admin, payload: body({ orderId: "other" }) }); assert.equal(allowed.status, 200);
  assert.equal(allowed.body.records[0].operator, "admin");
  assert.deepEqual((await s.request({ actor: admin })).body.orders.map(row => row.orderId), ["admin"]);
  assert.deepEqual(await s.read(), s.original);
});

pgTest("permissions, owner, account, site and session changes are read live even when a client retries", async t => {
  const s = await harness(t);
  await s.request({ payload: body() });
  await s.change(state => { state.personnel[0].permissions.orders.update = false; });
  assert.equal((await s.request({ orderId: "mine" })).body.canCreate, false);
  assert.equal((await s.request({ payload: body() })).status, 403);
  await s.change(state => { state.personnel[0].permissions.orders.create = false; });
  assert.equal((await s.request()).status, 403);
  await s.change(state => { state.personnel[0] = structuredClone(staff); state.orders[0].contactPersonnelId = other.id; });
  assert.equal((await s.request({ orderId: "mine" })).status, 403);
  assert.equal((await s.request({ payload: body() })).status, 403);
  for (const patch of [{ visibleSiteIds: [] }, { accountEnabled: false }, { sessionVersion: 1 }, { employmentStatus: "resigned" }]) {
    await s.change(state => { state.personnel[0] = { ...structuredClone(staff), ...patch }; });
    assert.equal((await s.request({ orderId: "mine" })).status, 403);
    assert.equal((await s.request({ payload: body() })).status, 403);
  }
  assert.equal(Number((await pool.query("SELECT count(*) FROM order_followups WHERE state_id=$1", [s.stateId])).rows[0].count), 1);
});

pgTest("duplicate order identities fail closed and malformed audit fields persist nothing", async t => {
  const s = await harness(t);
  for (const patch of [{ operator: "admin" }, { createdAt: now }, { content: " " }]) assert.equal((await s.request({ payload: body(patch) })).status, 400);
  assert.equal((await s.request({ payload: body(), extraQuery: { orderId: "mine2" } })).status, 400);
  assert.equal((await s.request({ method: "DELETE", orderId: "mine" })).status, 405);
  await s.change(state => { state.orders.push(order("mine", { siteId: "jiangyin", contactPersonnelId: other.id })); });
  for (const request of [{}, { orderId: "mine" }, { payload: body() }]) {
    const response = await s.request(request); assert.equal(response.status, 409); assert.equal(response.body.code, "ORDER_FOLLOWUP_ORDER_CONFLICT");
  }
  assert.equal(Number((await pool.query("SELECT count(*) FROM order_followups WHERE state_id=$1", [s.stateId])).rows[0].count), 0);
});

pgTest("legacy unique owner works while duplicate names and createdBy do not grant access", async t => {
  const s = await harness(t);
  await s.change(state => { delete state.orders[0].contactPersonnelId; state.orders[0].contactPerson = staff.username; });
  assert.equal((await s.request({ payload: body() })).status, 200);
  await s.change(state => { state.orders[0].contactPerson = staff.name; state.personnel[1].name = staff.name; });
  assert.equal((await s.request({ orderId: "mine" })).status, 403);
  await s.change(state => { state.orders[0].contactPerson = "unknown"; state.orders[0].createdBy = staff.username; });
  assert.equal((await s.request({ payload: body() })).status, 403);
});

pgTest("existing followup history remains readable if an order is no longer completed, but appending is blocked", async t => {
  const s = await harness(t);
  const saved = await s.request({ payload: body() }); assert.equal(saved.status, 200);
  await s.change(state => { state.orders[0].status = "pending"; });
  const reopened = await s.request({ orderId: "mine" });
  assert.equal(reopened.status, 200); assert.equal(reopened.body.canCreate, false);
  assert.deepEqual(reopened.body.records, saved.body.records);
  const append = await s.request({ payload: body({ clientMutationId: "mutation-after-reopen", content: "不应追加" }) });
  assert.equal(append.status, 409); assert.equal(append.body.code, "ORDER_FOLLOWUP_ORDER_NOT_COMPLETED");
  assert.equal((await s.request({ orderId: "mine" })).body.total, 1);
  assert.ok((await s.request()).body.orders.every(row => row.orderId !== "mine"));
});

pgTest("order state/owner changes serialize before authorization and block stale writes", async t => {
  const s = await harness(t), client = await pool.connect();
  try {
    await client.query("BEGIN");
    const state = (await client.query("SELECT data FROM app_state WHERE id=$1 FOR UPDATE", [s.stateId])).rows[0].data;
    state.orders[0].status = "cancelled";
    await client.query("UPDATE app_state SET data=$2::jsonb WHERE id=$1", [s.stateId, JSON.stringify(state)]);
    let settled = false;
    const pending = s.request({ payload: body() }).then(result => { settled = true; return result; });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    await client.query("COMMIT");
    const result = await pending; assert.equal(result.status, 409); assert.equal(result.body.code, "ORDER_FOLLOWUP_ORDER_NOT_COMPLETED");
    assert.equal((await s.request({ orderId: "mine" })).body.total, 0);
  } finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
});
