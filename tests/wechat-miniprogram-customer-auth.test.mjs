import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../wechat-miniprogram/", import.meta.url);
const source = await readFile(new URL("utils/customer-auth.js", root), "utf8");
const token = `mfs_${"a".repeat(43)}`;
function harness() {
  const requests = [];
  const storage = new Map();
  let loginCount = 0;
  let enabled = true;
  let status = 200;
  const context = { module: { exports: {} }, require: () => ({ buildUrl: (path) => `https://example.test${path}`, getApiBaseUrl: () => "https://example.test" }), wx: {
    getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), removeStorageSync: (key) => storage.delete(key),
    login: ({ success }) => { loginCount++; success({ code: "temporary-wechat-code" }); },
    request: (options) => {
      requests.push(options);
      const path = options.url.split("/").pop();
      options.success({ statusCode: status, data: status === 200 ? { ok: true,
        ...(path === "config" ? { loginEnabled: enabled, privacyVersion: "2026-09-09" } : {}),
        ...(path === "login" || path === "session" ? { token, expiresAt: Date.now() + 60000, customer: { id: "customer-id", label: "访客 ABC" } } : {})
      } : { error: "failed" } });
    }
  } };
  vm.runInNewContext(source, context);
  return { auth: context.module.exports, storage, requests, loginCount: () => loginCount, disable: () => { enabled = false; }, status: (next) => { status = next; } };
}

test("browsing never silently logs in; consent and enabled server required before wx.login", async () => {
  const h = harness();
  assert.equal(await h.auth.currentCustomer(), null);
  assert.equal(h.requests.length, 0);
  await assert.rejects(h.auth.login(false), /隐私/);
  assert.equal(h.loginCount(), 0);
  h.disable();
  await assert.rejects(h.auth.login(true), /尚未开通/);
  assert.equal(h.loginCount(), 0);
});

test("login is single-flight, stores only isolated customer credentials, and revokes on logout", async () => {
  const h = harness();
  await Promise.all([h.auth.login(true), h.auth.login(true)]);
  assert.equal(h.loginCount(), 1);
  assert.equal(h.storage.size, 1);
  assert.equal(h.requests[1].header.Authorization, undefined);
  assert.equal(h.requests[1].data.code, "temporary-wechat-code");
  assert.equal((await h.auth.currentCustomer()).id, "customer-id");
  assert.equal(h.requests[2].header.Authorization, `Bearer ${token}`);
  await h.auth.endSession();
  assert.equal(h.storage.size, 0);
  assert.equal(await h.auth.currentCustomer(), null);
});

test("401 invalidates saved login, while network/server errors never fake logout or deletion success", async () => {
  const h = harness();
  await h.auth.login(true);
  h.status(503);
  await assert.rejects(h.auth.endSession(true));
  assert.equal(h.storage.size, 1);
  h.status(401);
  await assert.rejects(h.auth.currentCustomer());
  assert.equal(h.storage.size, 0);
});

test("native contact stays available to guests; detail sends current product context but never credentials", async () => {
  for (const path of ["pages/catalog/index.wxml", "pages/account/index.wxml", "pages/detail/index.wxml"]) {
    const wxml = await readFile(new URL(path, root), "utf8");
    assert.match(wxml, /open-type="contact"/);
    assert.match(wxml, /show-message-card="\{\{true\}\}"/);
    assert.doesNotMatch(wxml, /session-from=|getUserInfo|getPhoneNumber/);
  }
  const detail = await readFile(new URL("pages/detail/index.wxml", root), "utf8");
  assert.match(detail, /send-message-title="\{\{contactCard.title\}\}"/);
  assert.match(detail, /send-message-path="\{\{contactCard.path\}\}"/);
  assert.match(detail, /disabled="\{\{refreshing \|\| !contactCard\}\}"/);
  const account = await readFile(new URL("pages/account/index.js", root), "utf8");
  assert.match(account, /wx\.showModal/);
  assert.match(account, /marineforest2024/);
});
