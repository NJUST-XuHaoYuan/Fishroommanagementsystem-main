import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLocalDateTime } from "./local-datetime-utils.mjs";

test("normalizes legacy dates and minute values to seconds", () => {
  assert.equal(normalizeLocalDateTime("2026-08-03"), "2026-08-03T00:00:00");
  assert.equal(normalizeLocalDateTime("2026-08-03T09:08"), "2026-08-03T09:08:00");
});

test("preserves entered seconds and accepts display-formatted values", () => {
  assert.equal(normalizeLocalDateTime("2026-08-03T09:08:07"), "2026-08-03T09:08:07");
  assert.equal(normalizeLocalDateTime("2026-08-03 09:08:07"), "2026-08-03T09:08:07");
});
