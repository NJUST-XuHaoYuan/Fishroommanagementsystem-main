import assert from "node:assert/strict";
import { test } from "node:test";
import { createOrderFollowupMutationId, fetchOrderFollowups, orderFollowupContent, orderFollowupMutation, OrderFollowupRequestError, parseOrderFollowupDetail, saveOrderFollowup } from "./orderFollowups.ts";

const record = (id = "f1", createdAt = "2026-11-26T10:00:00") => ({ id, createdAt, content: "客户反馈已正常开口", operator: "worker", operatorName: "员工", operatorPersonnelId: "person1" });
const detail = (patch = {}) => ({ ok: true, siteId: "nanjing", orderId: "order1", records: [record()], total: 1, canCreate: true, ...patch });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

test("follow-up content trims outer whitespace while preserving meaningful line breaks", () => {
  assert.equal(orderFollowupContent(" \n 已收到\n明天继续回访 \n"), "已收到\n明天继续回访");
  assert.throws(() => orderFollowupContent(" \n "), /填写/);
  assert.throws(() => orderFollowupContent("字".repeat(3001)), /3000/);
  assert.equal(orderFollowupContent("字".repeat(3000)).length, 3000);
});

test("lost-response retries reuse the mutation ID; another content or identity never does", () => {
  let id = 0; const createId = () => `synthetic-${++id}`;
  const first = orderFollowupMutation(null, "account1:order1", " 已收到 ", createId);
  assert.equal(orderFollowupMutation(first, "account1:order1", "已收到", createId), first);
  const edited = orderFollowupMutation(first, "account1:order1", "明天再联系", createId);
  assert.notEqual(edited.clientMutationId, first.clientMutationId);
  assert.notEqual(orderFollowupMutation(first, "account2:order1", "已收到", createId).clientMutationId, first.clientMutationId);
  assert.notEqual(orderFollowupMutation(first, "account1:order2", "已收到", createId).clientMutationId, first.clientMutationId);
});

test("mutation IDs are RFC 4122 UUIDs, including the HTTP getRandomValues fallback", () => {
  assert.match(createOrderFollowupMutationId(), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues(bytes) { return bytes.fill(7); } } });
  try { assert.match(createOrderFollowupMutationId(), /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i); }
  finally { if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor); else delete globalThis.crypto; }
});

test("parser retains every history row, sorts newest first and preserves explicit read-only permission", () => {
  const parsed = parseOrderFollowupDetail(detail({ records: [record("old", "2026-11-25T10:00:00"), record("new")], total: 2, canCreate: false, replayed: true }), "nanjing", "order1");
  assert.deepEqual(parsed.records.map(item => item.id), ["new", "old"]);
  assert.equal(parsed.total, 2); assert.equal(parsed.canCreate, false); assert.equal(parsed.replayed, true);
  assert.deepEqual(parseOrderFollowupDetail(detail({ records: [], total: 0 }), "nanjing", "order1").records, []);
});

test("parser rejects another order/site and partial or ambiguous history", () => {
  for (const patch of [{ siteId: "jiangyin" }, { orderId: "other" }, { total: 2 }, { canCreate: "true" }, { records: [record(), record()], total: 2 }, { records: [{ ...record(), content: "" }] }, { records: [{ ...record(), createdAt: "invalid" }] }]) {
    assert.throws(() => parseOrderFollowupDetail(detail(patch), "nanjing", "order1"), /回访记录/);
  }
  assert.throws(() => parseOrderFollowupDetail(detail(), "all", "order1"), /具体场地/);
});

async function withSession(run) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem() { return JSON.stringify({ username: "worker", role: "staff", token: "synthetic-token", expiresAt: Date.now() + 10000 }); }, removeItem() {} } } });
  try { await run(); } finally { if (original) Object.defineProperty(globalThis, "window", original); else delete globalThis.window; }
}

test("GET scopes both query parameters, sends authentication and forwards cancellation", async () => withSession(async () => {
  const signal = new AbortController().signal;
  const parsed = await fetchOrderFollowups("nanjing", "order1", signal, async (url, init) => {
    const parsedUrl = new URL(url, "http://local.test");
    assert.equal(parsedUrl.pathname, "/api/order-followups");
    assert.equal(parsedUrl.searchParams.get("siteId"), "nanjing"); assert.equal(parsedUrl.searchParams.get("orderId"), "order1");
    assert.equal(init.signal, signal); assert.equal(init.cache, "no-store"); assert.equal(init.headers.Authorization, "Bearer synthetic-token");
    return response(detail());
  });
  assert.equal(parsed.total, 1);
}));

test("POST only sends the scoped text and stable mutation ID; no client-supplied operator/time", async () => withSession(async () => {
  const signal = new AbortController().signal;
  const parsed = await saveOrderFollowup({ siteId: "nanjing", orderId: "order1", content: " 已收到 ", clientMutationId: "synthetic-id" }, signal, async (url, init) => {
    assert.equal(url, "/api/order-followups"); assert.equal(init.method, "POST"); assert.equal(init.signal, signal);
    assert.deepEqual(JSON.parse(init.body), { siteId: "nanjing", orderId: "order1", content: "已收到", clientMutationId: "synthetic-id" });
    return response(detail({ replayed: true }));
  });
  assert.equal(parsed.replayed, true);
}));

test("authorization failures are typed for immediate draft removal and failed saves remain retryable", async () => withSession(async () => {
  for (const status of [401, 403, 409, 500]) await assert.rejects(fetchOrderFollowups("nanjing", "order1", new AbortController().signal, async () => response({ error: "拒绝" }, status)), error => error instanceof OrderFollowupRequestError && error.status === status);
  let calls = 0;
  await assert.rejects(saveOrderFollowup({ siteId: "all", orderId: "order1", content: "记录", clientMutationId: "synthetic-id" }, new AbortController().signal, async () => { calls++; return response(detail()); }), /具体场地/);
  assert.equal(calls, 0);
}));
