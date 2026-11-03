import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, helper, components, Panel, parser;
before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  helper = await server.ssrLoadModule("/src/app/utils/newCustomerEvidence.ts");
  components = await server.ssrLoadModule("/src/app/components/NewCustomerEvidence.tsx");
  ({ NewCustomerApprovalPanel: Panel } = await server.ssrLoadModule("/src/app/components/NewCustomerApprovalPanel.tsx"));
  ({ newCustomerApprovalDetailFromPayload: parser } = await server.ssrLoadModule("/src/app/utils/notificationCenter.ts"));
});
after(async () => { await server?.close(); });

const attachment = { id: "evidence-1", originalName: "客户聊天.png", mime: "image/jpeg", size: 1234, createdAt: "2026-11-02T03:00:00.000Z" };
const detail = overrides => ({ orderId: "order-1", canRequest: true, canApprove: false, linkedCustomer: { id: "customer-1", name: "客户" }, approval: null, currentOrder: { id: "order-1", customerId: "customer-1", contactPerson: "负责人" }, customerEvidence: { identityKnown: true, otherOrderCount: 0, priorOrders: [] }, policyEffectiveDate: "2026-10-01", ...overrides });
const approval = { status: "pending", requestId: "request-1", version: 1, reason: "这是首次成交依据", requestedAt: attachment.createdAt, requestedBy: "sales-a", evidenceAttachments: [attachment] };
const renderPanel = value => renderToStaticMarkup(createElement(Panel, { orderId: "order-1", initialDetail: detail(value) }));

function withSession(run) {
  const previous = globalThis.window;
  const values = new Map();
  globalThis.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } };
  const write = value => values.set("fishroom-auth-session", JSON.stringify(value));
  const session = { username: "sales-a", role: "staff", token: "private-token", expiresAt: Date.now() + 60_000, visibleSiteIds: ["nanjing", "jiangyin"] };
  write(session);
  return Promise.resolve().then(() => run({ write, session })).finally(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
}

test("legacy approvals have no evidence and metadata normalization strips URLs, invalid types, duplicates", () => {
  const value = parser(detail({ approval: { ...approval, evidenceAttachments: undefined } }));
  assert.deepEqual(value.approval.evidenceAttachments, []);
  assert.deepEqual(helper.normalizeNewCustomerEvidence([attachment, attachment, { ...attachment, id: "svg", mime: "image/svg+xml" }, { ...attachment, id: "zero", size: 0 }, null]), [attachment]);
  assert.deepEqual(helper.normalizeNewCustomerEvidence([{ ...attachment, url: "https://public.invalid/private.png", token: "secret" }]), [attachment]);
  assert.equal(helper.normalizeNewCustomerEvidence(Array.from({ length: 9 }, (_, i) => ({ ...attachment, id: `a-${i}` }))).length, 6);
});

test("file planning limits six images and rejects HEIC, oversized or empty files without discarding valid files", () => {
  const file = { name: "a.jpg", type: "image/jpeg", size: 500 };
  const { accepted, errors } = helper.planNewCustomerEvidenceFiles([file, { ...file, name: "b.png", type: "image/png" }, { ...file, name: "iphone.heic", type: "image/heic" }, { ...file, name: "huge.jpg", size: 10 * 1024 * 1024 + 1 }, { ...file, name: "empty.jpg", size: 0 }], 5);
  assert.deepEqual(accepted, [file]);
  assert.equal(errors.length, 4);
  assert.match(errors.join(" "), /HEIC.*10 MB.*文件为空/);
  assert.deepEqual(helper.planNewCustomerEvidenceFiles([file], 6).accepted, []);
  assert.equal(helper.planNewCustomerEvidenceFiles([{ ...file, size: 10 * 1024 * 1024 }], 0).accepted.length, 1);
});

test("session guard blocks account, token, expiry and scope changes including delayed React updater", async () => withSession(({ write, session }) => {
  const captured = helper.captureNewCustomerSession();
  assert.equal(helper.isNewCustomerSessionCurrent(captured, { username: "sales-a", role: "staff", visibleSiteIds: ["jiangyin", "nanjing"] }), true);
  assert.equal(helper.isNewCustomerSessionCurrent(captured, { username: "sales-a", role: "staff", visibleSiteIds: ["nanjing"] }), false);
  assert.equal(helper.isNewCustomerSessionCurrent(captured, null), false);
  for (const change of [{ username: "sales-b" }, { token: "renewed-token" }, { expiresAt: Date.now() - 1 }, { visibleSiteIds: ["nanjing"] }, { role: "admin" }]) {
    write({ ...session, ...change }); assert.equal(helper.isNewCustomerSessionCurrent(captured), false);
  }
  write(session); assert.equal(helper.isNewCustomerSessionCurrent(captured), true);
}));

test("private upload uses authenticated raw body and encoded filename, exposes progress, returns metadata only", async () => withSession(async () => {
  const original = globalThis.XMLHttpRequest;
  let xhr;
  globalThis.XMLHttpRequest = class {
    constructor() { xhr = this; this.upload = {}; this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(body) { this.body = body; }
    abort() { this.onabort?.(); }
  };
  try {
    const file = { name: "聊天 1.png", type: "image/png", size: 500 };
    const values = [];
    const promise = helper.uploadNewCustomerEvidence("order /1", file, new AbortController().signal, value => values.push(value));
    assert.equal(xhr.url, "/api/orders/new-customer/evidence?orderId=order%20%2F1");
    assert.equal(xhr.method, "POST"); assert.strictEqual(xhr.body, file);
    assert.equal(xhr.headers.Authorization, "Bearer private-token");
    assert.equal(xhr.headers["x-file-name"], encodeURIComponent(file.name));
    assert.equal(xhr.headers["Content-Type"], "image/png");
    xhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
    assert.deepEqual(values, [50]);
    xhr.status = 200; xhr.responseText = JSON.stringify({ ok: true, attachment }); xhr.onload();
    assert.deepEqual(await promise, attachment);
    const controller = new AbortController();
    const cancelled = helper.uploadNewCustomerEvidence("order-1", file, controller.signal, () => {});
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
  } finally { if (original === undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest = original; }
}));

test("private previews fetch authenticated blobs, reject unauthorized and unsafe content; delete failure throws", async () => withSession(async () => {
  const original = globalThis.fetch; const calls = [];
  try {
    globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(new Blob(["binary"], { type: "image/jpeg" }), { status: 200 }); };
    const blob = await helper.fetchNewCustomerEvidence("evidence /1", new AbortController().signal);
    assert.equal(blob.type, "image/jpeg");
    assert.equal(calls[0].url, "/api/orders/new-customer/evidence/evidence%20%2F1");
    assert.equal(calls[0].options.headers.Authorization, "Bearer private-token");
    assert.equal(calls[0].options.cache, "no-store");
    assert.doesNotMatch(calls[0].url, /token|upload/);
    globalThis.fetch = async () => new Response(new Blob(["<svg/>"], { type: "image/svg+xml" }), { status: 200 });
    await assert.rejects(helper.fetchNewCustomerEvidence("id", new AbortController().signal), /格式异常/);
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "blocked" }), { status: 403 });
    await assert.rejects(helper.fetchNewCustomerEvidence("id", new AbortController().signal), /没有访问/);
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: "已绑定图片不可删除" }), { status: 409 });
    await assert.rejects(helper.deleteNewCustomerEvidence("id", new AbortController().signal), /不可删除/);
  } finally { globalThis.fetch = original; }
}));

test("new request requires WeChat proof with explicit clarity, format, size and draft limits", () => {
  const markup = renderPanel({});
  assert.match(markup, /添加微信证明.*必填，至少1张/);
  assert.match(markup, /系统不会自动识别图片真伪/);
  assert.match(markup, /multiple=""/);
  assert.match(markup, /最多 6 张.*10 MB.*JPG、PNG、WebP/);
  assert.match(markup, /HEIC.*文字清晰/);
  assert.match(markup, /24 小时内可恢复/);
  assert.match(markup, /min-h-11/);
});

test("submitted evidence is readonly in pending/approved states; rejected reapply starts with empty new drafts", () => {
  for (const status of ["pending", "approved"]) {
    const markup = renderPanel({ canRequest: false, approval: { ...approval, status } });
    assert.match(markup, /客户聊天.png/);
    assert.match(markup, /只读查看，不可修改或删除/);
    assert.doesNotMatch(markup, /type="file"|删除凭证|添加图片凭证/);
  }
  const rejected = renderPanel({ approval: { ...approval, status: "rejected" } });
  assert.match(rejected, /上次申请图片凭证/); assert.match(rejected, /重新提交申请/);
  assert.match(rejected, /0\/6 张/); assert.doesNotMatch(rejected, /删除凭证：客户聊天/);
  const legacy = renderPanel({ approval: { ...approval, evidenceAttachments: undefined }, canRequest: false });
  assert.match(legacy, /未上传图片凭证/);
});

test("same-site unrelated viewers see no private thumbnails when canViewEvidence is false", () => {
  const markup = renderPanel({ approval, canRequest: false, canViewEvidence: false });
  assert.match(markup, /仅申请人、订单负责人和管理员可查看凭证/);
  assert.doesNotMatch(markup, /客户聊天.png|新客审批图片凭证|放大凭证/);
});

test("only the applicant's returned unsubmitted drafts are restored and remain removable", () => {
  const markup = renderPanel({ draftEvidenceAttachments: [attachment] });
  assert.match(markup, /1\/6 张/);
  assert.match(markup, /删除凭证：客户聊天.png/);
  const notRequester = parser(detail({ canRequest: false, approval, draftEvidenceAttachments: [attachment] }));
  assert.deepEqual(notRequester.draftEvidenceAttachments, []);
  const restored = parser(detail({ draftEvidenceAttachments: [attachment, attachment] }));
  assert.deepEqual(restored.draftEvidenceAttachments, [attachment]);
  const notificationSnapshot = parser({ notification: { newCustomerReview: detail({ approval: { ...approval, status: "rejected" } }) } });
  assert.equal(notificationSnapshot.draftEvidenceAttachments, undefined, "missing draft projection must trigger protected order-detail recovery");
});

test("draft gallery alone permits deletion and has accessible full filename preview labels", () => {
  const markup = renderToStaticMarkup(createElement(components.NewCustomerEvidenceGallery, { orderId: "order-1", attachments: [attachment], onRemove() {} }));
  assert.match(markup, /aria-label="放大凭证：客户聊天.png"/);
  assert.match(markup, /aria-label="删除凭证：客户聊天.png"/);
});

test("components retain cancellation, objectURL cleanup, guarded store callbacks, and evidence submit contract", async () => {
  const gallery = await readFile(new URL("./NewCustomerEvidence.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("./NewCustomerApprovalPanel.tsx", import.meta.url), "utf8");
  const orders = await readFile(new URL("./OrdersView.tsx", import.meta.url), "utf8");
  const notifications = await readFile(new URL("./NotificationCenter.tsx", import.meta.url), "utf8");
  assert.match(gallery, /URL\.createObjectURL\(blob\)/); assert.match(gallery, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.match(gallery, /controller\.abort\(\)/); assert.match(gallery, /isNewCustomerSessionCurrent\(session\)/);
  assert.match(panel, /evidenceBusyRef\.current/);
  assert.match(panel, /evidenceIds: draftEvidenceRef\.current\.map/);
  assert.match(panel, /notificationId && !fromOrderEndpoint && nextDetail.canRequest && nextDetail.draftEvidenceAttachments === undefined/);
  assert.match(panel, /initialDetail.canRequest && initialDetail.draftEvidenceAttachments === undefined/);
  assert.match(panel, /if \(!mutationCurrent\(session\)\) return/);
  assert.match(panel, /onOrderUpdated\?\.\(order, session\)/);
  assert.match(panel, /key=\{JSON\.stringify\(\[props.orderId, props.notificationId, props.approvalRequestId, sessionKey\]\)\}/);
  assert.match(orders, /!isNewCustomerSessionCurrent\(session, current.user\) \? current/);
  assert.match(notifications, /!isNewCustomerSessionCurrent\(session, current.user\) \? current/);
  assert.match(notifications, /orders: mergeNewCustomerApproval\(current.orders, order\)/);
  assert.doesNotMatch(gallery + panel, /api\/media\/upload|token=/);
});
