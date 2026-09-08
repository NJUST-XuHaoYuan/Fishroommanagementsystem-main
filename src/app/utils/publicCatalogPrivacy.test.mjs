import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../components/PublicCatalogPage.tsx", import.meta.url),
  "utf8",
);

test("public catalog never falls back to internal initial state", () => {
  assert.doesNotMatch(source, /\binitialState\b/);
  assert.doesNotMatch(source, /fallbackCatalog/);
  assert.match(source, /const EMPTY_PUBLIC_CATALOG:[\s\S]*?stock:\s*\[\]/);
  assert.match(source, /setCatalog\(EMPTY_PUBLIC_CATALOG\)/);
});

test("public catalog gates rendering on a complete successful projection", () => {
  assert.match(source, /throw new Error\("公开鱼单数据不完整"\)/);
  assert.match(source, /if \(!catalogLoaded\)/);
  assert.match(source, /加载失败时不会展示缓存或内部数据/);
});

test("a revoked detail forces the catalog projection to refresh", () => {
  assert.match(source, /status === 404/);
  assert.match(source, /setDetailOpen\(false\)/);
  assert.match(source, /setCatalogLoadAttempt\(\(attempt\) => attempt \+ 1\)/);
});
