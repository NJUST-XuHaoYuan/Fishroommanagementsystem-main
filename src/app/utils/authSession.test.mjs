import assert from "node:assert/strict";
import test from "node:test";
import { saveAuthSession, getValidAuthSession, clearAuthSession } from "./authSession.ts";

const data = new Map();
globalThis.window = { localStorage: {
  getItem: key => data.get(key) ?? null,
  setItem: (key, value) => data.set(key, value),
  removeItem: key => data.delete(key),
} };

test("finance sessions survive refresh and retain only authorized sites", () => {
  saveAuthSession({ username: "finance-a", role: "finance", visibleSiteIds: ["nanjing"] }, "sample-token", Date.now() + 60_000);
  const session = getValidAuthSession();
  assert.equal(session.role, "finance");
  assert.deepEqual(session.visibleSiteIds, ["nanjing"]);
  clearAuthSession();
  assert.equal(getValidAuthSession(), null);
});

test("unsupported roles still fail closed", () => {
  data.set("fishroom-auth-session", JSON.stringify({ username: "bad", role: "superuser", expiresAt: Date.now() + 60_000 }));
  assert.equal(getValidAuthSession(), null);
  assert.equal(data.size, 0);
});
