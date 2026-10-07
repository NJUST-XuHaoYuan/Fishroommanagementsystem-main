import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pages = new URL("../wechat-miniprogram/pages/", import.meta.url);

test("product and stock cards emphasize size and origin without losing wrapping", async () => {
  for (const [page, selector, wrapping] of [
    ["products", "product-spec", /word-break:\s*break-all/],
    ["specimens", "specimen-spec", /overflow-wrap:\s*anywhere/]
  ]) {
    const styles = await readFile(new URL(`${page}/index.wxss`, pages), "utf8");
    const rule = styles.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`))[1];
    assert.match(rule, /color:\s*var\(--ink-soft\)/);
    assert.match(rule, /font-size:\s*13px/);
    assert.match(rule, /font-weight:\s*650/);
    assert.match(rule, /line-height:\s*20px/);
    assert.match(rule, wrapping);
    const template = await readFile(new URL(`${page}/index.wxml`, pages), "utf8");
    assert.match(template, new RegExp(`class="${selector}">\\{\\{item.size\\}\\}.*\\{\\{item.origin\\}\\}`));
  }
});

test("the species line remains a smaller muted secondary label", async () => {
  const styles = await readFile(new URL("products/index.wxss", pages), "utf8");
  const rule = styles.match(/\.product-species\s*\{([^}]+)\}/)[1];
  assert.match(rule, /color:\s*var\(--muted\)/);
  assert.match(rule, /font-size:\s*11px/);
  assert.match(rule, /font-weight:\s*400/);
});
