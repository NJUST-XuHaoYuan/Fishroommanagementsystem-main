import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, helper, ui, sessionHelpers;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  helper = await server.ssrLoadModule("/src/app/utils/orderOwnerAssignment.ts");
  ui = await server.ssrLoadModule("/src/app/components/OrderOwnerAssignment.tsx");
  sessionHelpers = await server.ssrLoadModule("/src/app/utils/newCustomerEvidence.ts");
});
after(async () => server?.close());

const assignment = (overrides = {}) => ({ requestId: "r1", version: 1, status: "pending", fromPersonnelId: "p-a", fromName: "登记甲", toPersonnelId: "p-b", toUsername: "staff-b", toName: "接收乙", requestedBy: "staff-a", requestedByPersonnelId: "p-a", requestedByName: "登记甲", requestedAt: "2026-11-04T03:00:00.000Z", ...overrides });
const detail = (overrides = {}) => ({ orderId: "o1", assignment: assignment(), currentOwner: { personnelId: "p-a", name: "登记甲" }, canAccept: true, canReject: true, canCancel: false, blockedReason: "", ...overrides });
const ownerOrder = (overrides = {}) => ({ id: "o1", contactPersonnelId: "p-a", contactPerson: "登记甲", ownerAssignment: assignment(), ...overrides });
const render = (props = {}) => renderToStaticMarkup(createElement(ui.OrderOwnerAssignmentPanel, { orderId: "o1", requestId: "r1", viewer: { username: "staff-b", role: "staff" }, initialDetail: detail(), onOrderUpdated() {}, ...props }));

test("assignment parser rejects malformed identity, state, timestamp and version", () => {
  assert.deepEqual(helper.parseOwnerAssignment(assignment()), assignment());
  for (const patch of [{ requestId: "" }, { toPersonnelId: "" }, { toUsername: "" }, { status: "approved" }, { requestedAt: "bad" }, { resolvedAt: "bad" }, { version: -1 }, { version: 1.2 }, { fromPersonnelId: null }, { toName: {} }, { note: [] }]) assert.equal(helper.parseOwnerAssignment(assignment(patch)), null);
});

test("legacy name-only owner remains renderable and cannot be confused with target", () => {
  const legacy = assignment({ fromPersonnelId: "" });
  assert.ok(helper.parseOwnerAssignment(legacy));
  const parsed = helper.ownerFieldsFromPayload({ order: { id: "o1", contactPerson: "历史销售", ownerAssignment: legacy } }, "o1");
  assert.equal(parsed.contactPersonnelId, "");
  assert.equal(parsed.contactPerson, "历史销售");
  assert.equal(parsed.ownerAssignment.toPersonnelId, "p-b");
});

test("detail requires correct order identity and strict action booleans", () => {
  const parsed = helper.ownerAssignmentDetailFromPayload({ ok: true, ...detail(), canAccept: "true" }, "o1");
  assert.equal(parsed.canAccept, false);
  assert.equal(parsed.canReject, true);
  for (const payload of [null, {}, { ok: false, ...detail() }, { ok: true, ...detail(), orderId: "other" }, { ok: true, ...detail(), assignment: { requestId: "r1" } }]) assert.equal(helper.ownerAssignmentDetailFromPayload(payload, "o1"), null);
});

test("order mutation parsing strips unrelated business fields", () => {
  const result = helper.ownerFieldsFromPayload({ order: ownerOrder({ payments: [1], status: "completed", discount: 999, newCustomerApproval: { status: "rejected", version: 3 } }) }, "o1");
  assert.equal(result.status, undefined);
  assert.equal(result.payments, undefined);
  assert.equal(result.discount, undefined);
  assert.equal(result.newCustomerApproval.version, 3);
  assert.equal(helper.ownerFieldsFromPayload({ order: ownerOrder({ id: "o2" }) }, "o1"), null);
});

test("newer owner fields survive delayed order responses without clobbering their business changes", () => {
  const current = [ownerOrder({ contactPersonnelId: "p-b", contactPerson: "接收乙", ownerAssignment: assignment({ version: 2, status: "accepted" }), newCustomerApproval: { status: "rejected", version: 8 }, creditSaleApproval: undefined, status: "confirmed" })];
  const incoming = [ownerOrder({ status: "completed", payments: [200], discount: 8, newCustomerApproval: { status: "approved", version: 7 }, creditSaleApproval: { amount: 500 } })];
  const result = helper.retainNewerOwnerAssignments(current, incoming)[0];
  assert.equal(result.contactPersonnelId, "p-b");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.payments, [200]);
  assert.equal(result.discount, 8);
  assert.equal(result.newCustomerApproval.status, "rejected");
  assert.equal(result.creditSaleApproval, undefined);
  assert.deepEqual(helper.retainNewerOwnerAssignments(current, []), []);
  assert.equal(helper.retainNewerOwnerAssignments(current, [{ id: "o1", status: "completed" }])[0].contactPersonnelId, "p-b");
});

test("version and terminal state reject same-millisecond stale snapshots", () => {
  assert.ok(helper.compareOwnerAssignment(assignment({ version: 3, requestId: "r2" }), assignment({ version: 2, status: "accepted" })) > 0);
  assert.ok(helper.compareOwnerAssignment(assignment({ version: undefined, status: "accepted" }), assignment({ version: undefined })) > 0);
  assert.equal(helper.compareOwnerAssignment(null, null), 0);
});

function withSession(run) {
  const original = globalThis.window;
  const values = new Map();
  const auth = { username: "staff-b", role: "staff", token: "test-token", expiresAt: Date.now() + 3600000, visibleSiteIds: ["nanjing"] };
  const write = (value = auth) => values.set("fishroom-auth-session", JSON.stringify(value));
  globalThis.window = { localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } };
  write();
  try { run({ auth, write, clear: () => values.clear(), session: sessionHelpers.captureNewCustomerSession() }); }
  finally { if (original === undefined) delete globalThis.window; else globalThis.window = original; }
}

test("decision merge updates only owner fields and approval invalidation, and never resurrects deleted orders", () => withSession(({ auth, session }) => {
  const current = { user: auth, orders: [ownerOrder({ payments: [100], items: ["latest"], status: "shipped", discount: 9 })] };
  const update = helper.ownerFieldsFromPayload({ order: ownerOrder({ contactPersonnelId: "p-b", contactPerson: "接收乙", ownerAssignment: assignment({ version: 2, status: "accepted" }), payments: [], status: "draft" }) }, "o1");
  const result = helper.mergeOwnerAssignmentForSession(current, update, session);
  assert.equal(result.orders[0].contactPersonnelId, "p-b");
  assert.deepEqual(result.orders[0].payments, [100]);
  assert.deepEqual(result.orders[0].items, ["latest"]);
  assert.equal(result.orders[0].status, "shipped");
  assert.equal(result.orders[0].discount, 9);
  const deleted = { ...current, orders: [] };
  assert.strictEqual(helper.mergeOwnerAssignmentForSession(deleted, update, session), deleted);
  const sameOwnerNewApproval = { ...result, orders: [{ ...result.orders[0], newCustomerApproval: { version: 10 } }] };
  assert.strictEqual(helper.mergeOwnerAssignmentForSession(sameOwnerNewApproval, update, session), sameOwnerNewApproval);
}));

test("late decisions cannot cross logout, renewed token, expiry, role or scope changes", () => withSession(({ auth, write, clear, session }) => {
  const current = { user: auth, orders: [ownerOrder()] };
  const update = ownerOrder({ ownerAssignment: assignment({ version: 2, status: "accepted" }) });
  for (const patch of [{ username: "another" }, { token: "new-token" }, { expiresAt: Date.now() - 1 }, { role: "admin" }, { visibleSiteIds: ["jiangyin"] }]) {
    write({ ...auth, ...patch }); assert.strictEqual(helper.mergeOwnerAssignmentForSession(current, update, session), current);
  }
  clear(); assert.strictEqual(helper.mergeOwnerAssignmentForSession(current, update, session), current);
  write();
  const otherStore = { ...current, user: { ...auth, username: "other" } };
  assert.strictEqual(helper.mergeOwnerAssignmentForSession(otherStore, update, session), otherStore);
}));

test("only pending matching request can be accepted/rejected/cancelled according to server permissions", () => {
  assert.equal(helper.ownerAssignmentActionReady(detail(), "accept", "r1"), true);
  assert.equal(helper.ownerAssignmentActionReady(detail(), "reject", "r1"), true);
  assert.equal(helper.ownerAssignmentActionReady(detail(), "cancel", "r1"), false);
  for (const change of [{ canAccept: false }, { blockedReason: "订单已完成" }, { assignment: assignment({ status: "accepted" }) }]) assert.equal(helper.ownerAssignmentActionReady(detail(change), "accept", "r1"), false);
  for (const action of ["accept", "reject", "cancel"]) assert.equal(helper.ownerAssignmentActionReady(detail({ canCancel: true }), action, "old-request"), false);
});

test("successful decision must include matching terminal status and effective owner", () => {
  assert.equal(helper.ownerAssignmentDecisionApplied(ownerOrder({ contactPersonnelId: "p-b", ownerAssignment: assignment({ status: "accepted" }) }), "accept", "r1"), true);
  assert.equal(helper.ownerAssignmentDecisionApplied(ownerOrder({ ownerAssignment: assignment({ status: "rejected" }) }), "reject", "r1"), true);
  assert.equal(helper.ownerAssignmentDecisionApplied(ownerOrder({ ownerAssignment: assignment({ status: "cancelled" }) }), "cancel", "r1"), true);
  for (const order of [null, ownerOrder(), ownerOrder({ ownerAssignment: assignment({ status: "accepted" }) }), ownerOrder({ contactPersonnelId: "p-b", ownerAssignment: assignment({ status: "accepted", requestId: "other" }) })]) assert.equal(helper.ownerAssignmentDecisionApplied(order, "accept", "r1"), false);
});

test("assignee panel clearly separates current and requested owner and explains commission impact", () => {
  const markup = render();
  assert.match(markup, /当前有效负责人/);
  assert.match(markup, /登记甲/);
  assert.match(markup, /接收乙/);
  assert.match(markup, /确认接手/);
  assert.match(markup, /拒绝接手/);
  assert.match(markup, /对应提成归属将变为你/);
  assert.match(markup, /!min-h-\[44px\]/);
  assert.match(markup, /处理备注（选填）/);
});

test("requester can withdraw while unrelated viewers have no decision actions", () => {
  const requester = render({ initialDetail: detail({ canAccept: false, canReject: false, canCancel: true }) });
  assert.match(requester, /撤回转交申请/);
  assert.doesNotMatch(requester, /<button[^>]*>[\s\S]*?确认接手<\/button>/);
  const readonly = render({ initialDetail: detail({ canAccept: false, canReject: false, canCancel: false }) });
  assert.doesNotMatch(readonly, /处理备注（选填）|撤回转交申请|拒绝接手/);
});

test("stale notification cannot show decision controls for a replacement request", () => {
  const markup = render({ requestId: "old-request" });
  assert.match(markup, /对应的申请已过期或被替换/);
  assert.doesNotMatch(markup, /处理备注（选填）|拒绝接手|撤回转交申请/);
});

test("blocked acceptance and invalidated approvals remain explicit", () => {
  const blocked = render({ initialDetail: detail({ canAccept: false, blockedReason: "订单已完成或已取消，不能接受转交" }) });
  assert.match(blocked, /暂不可接手/);
  assert.match(blocked, /订单已完成或已取消/);
  assert.match(blocked, /拒绝接手/);
  const reset = render({ initialDetail: detail({ approvalResetRequired: { newCustomer: true, creditSale: false } }) });
  assert.match(reset, /原新客审批或赊销批准将失效，需要重新申请/);
});

test("badges show only pending assignments and wrap long recipient names", () => {
  const pending = renderToStaticMarkup(createElement(ui.OrderOwnerAssignmentBadge, { order: ownerOrder() }));
  assert.match(pending, /负责人待确认：接收乙/);
  assert.match(pending, /whitespace-normal break-words/);
  for (const status of ["accepted", "rejected", "cancelled"]) assert.equal(renderToStaticMarkup(createElement(ui.OrderOwnerAssignmentBadge, { order: ownerOrder({ ownerAssignment: assignment({ status }) }) })), "");
});

test("create/edit hints never promise immediate ownership transfer", () => {
  assert.match(helper.ownerSelectionHint({ creating: true, currentOwnerName: "甲（登记人）", selectedName: "乙", changed: true }), /确认前仍由甲（登记人）负责/);
  assert.match(helper.ownerSelectionHint({ creating: false, currentOwnerName: "甲", selectedName: "乙", changed: false }), /仅修改订单其他信息，不会改变负责人/);
  assert.match(helper.ownerSelectionHint({ creating: false, currentOwnerName: "甲", selectedName: "乙", changed: true, pendingName: "丙" }), /请先撤回待确认申请/);
});

test("integration uses eligible server candidates and snapshots owner concurrency without forcing changes on ordinary edit", async () => {
  const source = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  assert.match(source, /ownerSelectionChanged: false/);
  assert.match(source, /\.\.\.\(editForm.ownerSelectionChanged && selectedContactPersonnel \? \{/);
  assert.match(source, /expectedContactPersonnelId: editForm.expectedContactPersonnelId/);
  assert.match(source, /expectedOwnerAssignmentRequestId: editForm.expectedOwnerAssignmentRequestId/);
  assert.match(source, /session: session!/);
  assert.match(source, /ownerAssignment\?\.status === "pending"/);
  const panel = await readFile(new URL("./OrderOwnerAssignment.tsx", import.meta.url), "utf8");
  assert.match(panel, /\/api\/orders\/owner-assignment\/candidates\?siteId=/);
  assert.match(panel, /if \(busyRef.current \|\| loading/);
  assert.match(panel, /isNewCustomerSessionCurrent\(session, propsRef.current.viewer\)/);
  const notices = await readFile(new URL("./NotificationCenter.tsx", import.meta.url), "utf8");
  assert.match(notices, /notification.type === "order_owner_assignment"/);
  assert.match(notices, /requestId=\{selectedOwnerAssignment.ownerAssignmentRequestId\}/);
  assert.match(notices, /mergeOwnerAssignmentForSession\(current, updated, session\)/);
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  assert.ok((app.match(/retainNewerOwnerAssignments\(/g) || []).length >= 9);
});
