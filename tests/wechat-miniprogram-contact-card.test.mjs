import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../wechat-miniprogram/", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
function load(source, dependencies = {}, globals = {}) {
  const context = { module: { exports: {} }, require: (key) => {
    assert.ok(key in dependencies, `unknown dependency: ${key}`);
    return dependencies[key];
  }, ...globals };
  vm.runInNewContext(source, context);
  return context.module.exports;
}
const contact = load(await read("utils/contact-card.js"));

test("only the contact button floats; transparent scroll spacing keeps the final record clear", async () => {
  const css = await read("pages/detail/index.wxss");
  const template = await read("pages/detail/index.wxml");
  assert.match(css, /\.detail-page\.safe-page\s*\{[^}]*--contact-space-height:\s*calc\([^;]+env\(safe-area-inset-bottom\)\)[^}]*padding-bottom:\s*0/);
  assert.match(css, /\.detail-content\s*\{\s*padding-bottom:\s*0/);
  const spacer = css.match(/\.detail-contact-space\s*\{([^}]*)\}/)[1];
  assert.match(spacer, /height: var\(--contact-space-height\)/);
  assert.doesNotMatch(spacer, /background|border|position:\s*fixed/);
  assert.doesNotMatch(template + css, /detail-contact-bar/);
  assert.match(css, /\.detail-page \.detail-contact-button\s*\{[^}]*position: fixed[^}]*bottom: calc\(var\(--contact-button-inset\) \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.detail-page \.detail-contact-button\s*\{[^}]*right: 16px;[^}]*left: auto;[^}]*width: var\(--contact-button-height\);[^}]*height: var\(--contact-button-height\);[^}]*border-radius: 50%/);
  assert.doesNotMatch(css, /\.detail-contact-button\[/);
  assert.match(template, /<block wx:if="\{\{!loading && !error && specimen\}\}">\s*<view class="detail-contact-space" aria-hidden="true"><\/view>\s*<button class="detail-contact-button\b/);
});

test("individual cards preserve human numbers; IDs are encoded only in the destination", () => {
  const fish = { id: "fish & group=1", productName: "蓝圈神仙", code: "304", selectionCode: "MFISH-private", size: "12-14", origin: "印尼", unit: "条" };
  const card = contact.specimenContactCard(fish);
  assert.match(card.title, /编号 304/);
  assert.doesNotMatch(card.title, /MFISH|fish &/);
  const path = new URL(card.path, "https://example.test");
  assert.equal(path.searchParams.get("stockItemId"), fish.id);
  assert.equal(path.searchParams.has("group"), false);
  const noNumber = contact.specimenContactCard({ ...fish, code: "" });
  assert.doesNotMatch(noNumber.title, /编号|MFISH/);
});

test("identical grouped stock stays a group inquiry and never claims a member is chosen", () => {
  const card = contact.specimenContactCard({ id: "member-one", productName: "蓝圈神仙", code: "should-not-be-used", unit: "条" }, 3);
  assert.match(card.title, /同款可选 3 条/);
  assert.doesNotMatch(card.title, /编号|should-not/);
  assert.equal(new URL(card.path, "https://example.test").searchParams.get("group"), "1");
  for (const input of [null, {}, { id: "" }, { id: 123 }]) {
    assert.equal(contact.specimenContactCard(input), null);
  }
});

test("list pages only present stock and navigate to detail without preparing customer-service cards", async () => {
  const specimen = { id: "fish-one", productName: "蓝圈", code: "304", quantity: 1 };
  const product = { id: "product-one", name: "蓝圈" };
  const dependencies = {
    "../../utils/api": {},
    "../../utils/navigation": { getNavigationMetrics: () => ({}) },
    "../../utils/public-catalog-refresh": {},
    "../../utils/card-video-preview": { stopCardVideoPreview() {} },
    "../../utils/catalog": { filterProducts: () => [product], filterSpecimens: () => [specimen], groupSpecimens: (items) => items }
  };
  for (const route of ["products", "specimens"]) {
    let page;
    load(await read(`pages/${route}/index.js`), dependencies, { Page: (value) => { page = value; } });
    page.viewModel = {};
    page.setData = (update) => Object.assign(page.data, update);
    if (route === "products") page.applyFilter("blue"); else page.showAllStock();
    const rendered = page.data[route][0];
    assert.equal(rendered.id, route === "products" ? product.id : specimen.id);
    assert.equal(rendered.contactCard, undefined);
    assert.equal(page.data.refreshing, false);
  }
});

test("only detail offers product consultation with a readable brand-green icon and label button", async () => {
  for (const route of ["products", "specimens"]) {
    const template = await read(`pages/${route}/index.wxml`);
    const outerCard = template.match(new RegExp(`<view\\b[^>]*class="${route === "products" ? "product" : "specimen"}-card"[^>]*>`))[0];
    assert.match(outerCard, /bindtap="on(?:Product|Specimen)Tap"/);
    assert.doesNotMatch(template, /open-type="contact"|咨询客服|card-contact-button/);
  }
  const detail = await read("pages/detail/index.wxml");
  const button = detail.match(/<button\b[^>]*class="detail-contact-button\b[^>]*>/)[0];
  assert.match(button, /open-type="contact"/);
  assert.match(button, /size="mini"/);
  assert.match(button, /show-message-card="\{\{true\}\}"/);
  assert.match(button, /send-message-path="\{\{contactCard.path\}\}"/);
  assert.match(button, /send-message-img="\{\{specimen.image \|\| '\/assets\/brand-logo.jpg'\}\}"/);
  assert.doesNotMatch(button, /bindtap|catchtap|session-from|login|token/);
  const css = await read("pages/detail/index.wxss");
  assert.match(css, /--contact-button-height:\s*64px/);
  assert.match(css, /\.detail-page \.detail-contact-button\s*\{[^}]*background: var\(--brand\);[^}]*color: #fff;/);
  assert.match(css, /\.detail-contact-button\.contact-button-hover\s*\{\s*background: var\(--brand-dark\)/);
  assert.match(css, /\.detail-contact-button\.is-disabled\s*\{\s*background: var\(--muted\); color: #fff;/);
  assert.match(button, /\{\{refreshing \|\| !contactCard \? 'is-disabled' : ''\}\}/);
  assert.match(button, /aria-label="咨询此商品"/);
  const content = detail.slice(detail.indexOf(button) + button.length).split("</button>")[0];
  assert.match(content, /<text class="detail-contact-label" aria-hidden="true">客服<\/text>/);
  assert.match(content, /class="detail-contact-icon"/);
  assert.match(css, /\.detail-contact-icon\s*\{[^}]*width: 28px;[^}]*height: 28px;/);
  assert.match(css, /\.detail-page \.detail-contact-button\s*\{[^}]*flex-direction: column;[^}]*gap: 2px;/);
  assert.match(css, /\.detail-contact-label\s*\{[^}]*font-size: 13px;[^}]*line-height: 18px;[^}]*white-space: nowrap;/);
  assert.match(detail, /src="\/assets\/headset-white.svg" aria-hidden="true"/);
  const icon = await read("assets/headset-white.svg");
  assert.match(icon, /stroke="#fff"/);
  assert.match(icon, /Lucide headset/);
  assert.match(icon, /M21 16v2a4 4 0 0 1-4 4h-5/);
  assert.doesNotMatch(detail, /选鱼码|selectionCode|onCopyCode/);
  assert.match(detail, /编号/);
  assert.match(detail, /维护记录/);
});
