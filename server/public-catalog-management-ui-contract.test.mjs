import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const catalogManagementSource = await readFile(
  new URL("../src/app/components/CatalogManagementView.tsx", import.meta.url),
  "utf8",
);
const productsSource = await readFile(
  new URL("../src/app/components/ProductsView.tsx", import.meta.url),
  "utf8",
);

test("fish-list rule tabs have an unmistakable selected state", () => {
  assert.match(catalogManagementSource, /value=\{activeRuleTab\}/);
  assert.match(catalogManagementSource, /aria-label="鱼单规则设置方式"/);
  assert.match(catalogManagementSource, /bg-muted\/50/);
  assert.match(catalogManagementSource, /data-\[state=active\]:bg-primary/);
  assert.match(catalogManagementSource, /data-\[state=active\]:text-primary-foreground/);
  assert.match(catalogManagementSource, /data-\[state=active\]:font-semibold/);
  assert.match(catalogManagementSource, /按类型/);
});

test("an upstream product visibility lock is explained instead of shown as an enabled switch", () => {
  assert.doesNotMatch(catalogManagementSource, /商品档案未公开/);
  assert.match(catalogManagementSource, /对外展示总开关已关闭/);
  assert.match(catalogManagementSource, />对外展示已关闭<\/Badge>/);
  assert.match(catalogManagementSource, /不是资料不完整/);
  assert.match(catalogManagementSource, /品名管理 → 商品管理 → 编辑/);
  assert.match(catalogManagementSource, /开启后仍执行/);
  assert.match(catalogManagementSource, /类型规则隐藏/);
  assert.match(catalogManagementSource, /物种规则隐藏/);
  assert.match(catalogManagementSource, /productVisibilityLocked \? \(/);
  assert.match(catalogManagementSource, /先开启对外展示/);
  assert.match(catalogManagementSource, /对外展示已关闭/);
});

test("product management names the visibility gate and its fish-list effect clearly", () => {
  assert.match(productsSource, /对外展示（网站和小程序）/);
  assert.match(productsSource, /这是对外展示总开关/);
  assert.match(productsSource, /鱼单管理里的规则无法覆盖它/);
  assert.match(productsSource, /商品已恢复使用；对外展示仍关闭/);
});
