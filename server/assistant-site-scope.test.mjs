import test from "node:test";
import assert from "node:assert/strict";
import { resolveAssistantSiteScope } from "./assistant-site-scope.mjs";

test("staff may summarize all of their already-filtered visible sites", () => {
  assert.equal(resolveAssistantSiteScope({
    requestedSiteId: "all",
    accessRole: "staff",
    visibleSiteIds: ["nanjing"],
  }), "all");
});

test("staff may request an authorized site but not another site", () => {
  assert.equal(resolveAssistantSiteScope({
    requestedSiteId: "nanjing",
    accessRole: "staff",
    visibleSiteIds: ["nanjing"],
  }), "nanjing");
  assert.throws(() => resolveAssistantSiteScope({
    requestedSiteId: "jiangyin",
    accessRole: "staff",
    visibleSiteIds: ["nanjing"],
  }), /无权查看/);
});

test("admin keeps explicit and all-site scopes", () => {
  assert.equal(resolveAssistantSiteScope({ requestedSiteId: "all", accessRole: "admin" }), "all");
  assert.equal(resolveAssistantSiteScope({ requestedSiteId: "jiangyin", accessRole: "admin" }), "jiangyin");
});
