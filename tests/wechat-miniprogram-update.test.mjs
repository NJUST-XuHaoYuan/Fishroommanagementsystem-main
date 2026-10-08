import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const root = new URL("../wechat-miniprogram/", import.meta.url);
const updateSource = await readFile(new URL("utils/update.js", root), "utf8");
const appSource = await readFile(new URL("app.js", root), "utf8");

function loadController(wxApi) {
  const context = { module: { exports: {} }, wx: wxApi };
  vm.runInNewContext(updateSource, context);
  return context.module.exports.createUpdateController(wxApi);
}

function harness() {
  const readyListeners = [];
  const failedListeners = [];
  const modals = [];
  let managerRequests = 0;
  let applied = 0;
  const manager = {
    onUpdateReady: (callback) => readyListeners.push(callback),
    onUpdateFailed: (callback) => failedListeners.push(callback),
    applyUpdate: () => { applied++; },
  };
  const wxApi = {
    getUpdateManager: () => { managerRequests++; return manager; },
    showModal: (options) => modals.push(options),
  };
  const controller = loadController(wxApi);
  return {
    controller, modals, readyListeners, failedListeners,
    managerRequests: () => managerRequests,
    applied: () => applied,
    ready: () => readyListeners.forEach((callback) => callback()),
    failed: () => failedListeners.forEach((callback) => callback()),
    closeModal(index, result) {
      modals[index].success?.(result);
      modals[index].complete?.(result);
    },
  };
}

function assertReadyPrompt(modal) {
  assert.equal(modal.confirmText, "立即更新");
  assert.equal(modal.cancelText, "稍后");
  assert.notEqual(modal.showCancel, false, "the user can defer an update");
}

test("native update callbacks register once and ordinary foreground visits do not invent an update", () => {
  const h = harness();
  assert.equal(h.managerRequests(), 1);
  assert.equal(h.readyListeners.length, 1);
  assert.equal(h.failedListeners.length, 1);
  for (let visit = 0; visit < 3; visit++) {
    h.controller.onShow();
    h.controller.onHide();
  }
  assert.equal(h.managerRequests(), 1);
  assert.equal(h.readyListeners.length, 1);
  assert.equal(h.failedListeners.length, 1);
  assert.equal(h.modals.length, 0);
  assert.equal(h.applied(), 0);
});

test("a ready update asks the foreground user and applies only after explicit confirmation", () => {
  const h = harness();
  h.controller.onShow();
  h.ready();
  assert.equal(h.modals.length, 1);
  assertReadyPrompt(h.modals[0]);
  assert.equal(h.applied(), 0);
  h.closeModal(0, { confirm: true, cancel: false });
  assert.equal(h.applied(), 1);
  h.ready();
  h.controller.onHide();
  h.controller.onShow();
  assert.equal(h.modals.length, 1, "an accepted restart cannot create another update prompt");
  assert.equal(h.applied(), 1);
});

test("background readiness waits until the next foreground visit", () => {
  const h = harness();
  h.controller.onShow();
  h.controller.onHide();
  h.ready();
  h.ready();
  assert.equal(h.modals.length, 0);
  assert.equal(h.applied(), 0);
  h.controller.onShow();
  assert.equal(h.modals.length, 1);
  assertReadyPrompt(h.modals[0]);
});

test("deferring suppresses repeated ready events for this visit and allows a later visit to ask again", () => {
  const h = harness();
  h.controller.onShow();
  h.ready();
  h.closeModal(0, { confirm: false, cancel: true });
  h.ready();
  h.ready();
  assert.equal(h.modals.length, 1);
  assert.equal(h.applied(), 0);
  h.controller.onHide();
  h.ready();
  assert.equal(h.modals.length, 1);
  h.controller.onShow();
  assert.equal(h.modals.length, 2);
  assertReadyPrompt(h.modals[1]);
  assert.equal(h.applied(), 0);
});

test("a prompt carried across backgrounding still counts as this visit's only prompt", () => {
  const h = harness();
  h.controller.onShow();
  h.ready();
  h.ready();
  h.controller.onHide();
  h.controller.onShow();
  h.ready();
  assert.equal(h.modals.length, 1);
  assert.equal(h.applied(), 0);
  h.closeModal(0, { confirm: false, cancel: true });
  h.ready();
  assert.equal(h.modals.length, 1, "cancelling the retained prompt suppresses this foreground visit");
  assert.equal(h.applied(), 0);
  h.controller.onHide();
  h.controller.onShow();
  assert.equal(h.modals.length, 2);
  assertReadyPrompt(h.modals[1]);
});

test("an update failure explains that the current version remains usable and cannot apply an update", () => {
  const h = harness();
  h.controller.onShow();
  h.failed();
  assert.equal(h.modals.length, 1);
  const message = `${h.modals[0].title || ""} ${h.modals[0].content || ""}`;
  assert.match(message, /当前|现有/);
  assert.match(message, /仍可用|仍可使用|继续使用/);
  assert.equal(h.applied(), 0);
  h.closeModal(0, { confirm: true, cancel: false });
  assert.equal(h.applied(), 0, "acknowledging a failure is not consent to restart");
});

test("readiness during an open failure notice waits for a later visit without stacking prompts", () => {
  const h = harness();
  h.controller.onShow();
  h.failed();
  h.controller.onHide();
  h.ready();
  h.controller.onShow();
  assert.equal(h.modals.length, 1);
  h.closeModal(0, { confirm: true, cancel: false });
  assert.equal(h.modals.length, 1, "closing a failure notice must not immediately open another modal");
  assert.equal(h.applied(), 0);
  h.ready();
  assert.equal(h.modals.length, 1, "repeated native events do not bypass the visit limit");
  h.controller.onHide();
  h.controller.onShow();
  assert.equal(h.modals.length, 2);
  assertReadyPrompt(h.modals[1]);
  assert.equal(h.applied(), 0);
  h.closeModal(1, { confirm: true, cancel: false });
  assert.equal(h.applied(), 1);
});

test("platforms without the update API can enter and leave without dialogs or errors", () => {
  let shown = 0;
  const controller = loadController({ showModal() { shown++; } });
  assert.doesNotThrow(() => {
    controller.onShow();
    controller.onHide();
    controller.onShow();
  });
  assert.equal(shown, 0);
});

test("app launch creates the controller and forwards foreground and background lifecycle events", () => {
  let definition;
  const calls = [];
  const wxApi = {};
  const context = {
    wx: wxApi,
    App(value) { definition = value; },
    require(path) {
      if (path === "./utils/config") return { apiBaseUrl: "https://example.test", siteId: "all" };
      assert.equal(path, "./utils/update");
      return {
        createUpdateController(api) {
          assert.equal(api, wxApi);
          calls.push("create");
          return { onShow: () => calls.push("show"), onHide: () => calls.push("hide") };
        },
      };
    },
  };
  vm.runInNewContext(appSource, context);
  assert.deepEqual(calls, [], "controller construction belongs to app launch");
  definition.onLaunch();
  definition.onShow();
  definition.onHide();
  definition.onShow();
  assert.deepEqual(calls, ["create", "show", "hide", "show"]);
});
