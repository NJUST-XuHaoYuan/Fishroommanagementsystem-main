import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let PersonalCommissionContent;
let parsePersonalCommissionSummary;
let currentCommissionMonth;
let CommissionSummaryContent;
let parseCommissionSummary;
let OrderCommissionDetails;

before(async () => {
  server = await createServer({ configFile: false, server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: "automatic" } });
  ({ PersonalCommissionContent, parsePersonalCommissionSummary, currentCommissionMonth } = await server.ssrLoadModule("/src/app/components/PersonalCommissionDashboard.tsx"));
  ({ CommissionSummaryContent, parseCommissionSummary, OrderCommissionDetails } = await server.ssrLoadModule("/src/app/components/FinanceView.tsx"));
});
after(async () => { await server?.close(); });

function personal(overrides = {}) {
  return { ok: true, month: "2026-10", policyEffectiveDate: "2026-10-01", personalAmount: 52, newCustomerAmount: 50, regularPersonalAmount: 2, ...overrides };
}
function summary(overrides = {}) {
  return { ok: true, month: "2026-10", policyEffectiveDate: "2026-10-01", personalTotal: 52, newCustomerTotal: 50, regularPersonalTotal: 2, teamPoolTotal: 3, orderCount: 2, reviewRequiredOrderCount: 0,
    rows: [{ personnelId: "p1", name: "销售甲", personalAmount: 52, newCustomerAmount: 50, regularPersonalAmount: 2 }], ...overrides };
}
function renderPersonal(overrides = {}) {
  return renderToStaticMarkup(createElement(PersonalCommissionContent, { data: null, loading: false, error: "", onRefresh() {}, ...overrides }));
}

test("personal home shows only the current person's total, never a pool or other people's rows", () => {
  const markup = renderPersonal({ data: personal() });
  assert.match(markup, /¥52\.00/);
  assert.match(markup, /2026 年 10 月/);
  assert.match(markup, /0\.2%/);
  assert.match(markup, /5%/);
  assert.match(markup, /两者不叠加/);
  assert.match(markup, /旧订单不参与/);
  assert.doesNotMatch(markup, /团队池|销售甲|<table|type="month"|¥50\.00|¥2\.00/);
});

test("loading and failures never turn missing personal data into a zero commission", () => {
  const loading = renderPersonal({ loading: true });
  assert.match(loading, /正在核对本月提成/);
  assert.doesNotMatch(loading, /¥0\.00/);
  const failed = renderPersonal({ error: "请重新登录" });
  assert.match(failed, /role="alert"/);
  assert.match(failed, /请重新登录/);
  assert.match(failed, /重试/);
  assert.doesNotMatch(failed, /¥0\.00/);
});

test("zero and negative refund-adjusted personal totals render accurately", () => {
  assert.match(renderPersonal({ data: personal({ personalAmount: 0 }) }), /本月个人提成合计为 0 元/);
  assert.match(renderPersonal({ data: personal({ personalAmount: -5 }) }), /¥-5\.00/);
});

test("personal projection drops unexpected data and rejects incomplete or non-finite results", () => {
  const result = parsePersonalCommissionSummary({ ...personal(), teamPoolTotal: 900, rows: [{ name: "其他人" }] });
  assert.deepEqual(result, personal());
  for (const value of [null, {}, personal({ ok: false }), personal({ month: "2026-13" }), personal({ personalAmount: null }), personal({ newCustomerAmount: NaN }), personal({ regularPersonalAmount: Infinity }), personal({ policyEffectiveDate: "2026-09-01" })]) {
    assert.throws(() => parsePersonalCommissionSummary(value), /提成数据不完整/);
  }
});

test("current commission month uses China time at UTC month boundary", () => {
  assert.equal(currentCommissionMonth(new Date("2026-09-30T15:59:59Z")), "2026-09");
  assert.equal(currentCommissionMonth(new Date("2026-09-30T16:00:00Z")), "2026-10");
});

test("admin summary shows a separate monthly team pool without adding it to anyone's personal total", () => {
  const markup = renderToStaticMarkup(createElement(CommissionSummaryContent, { data: parseCommissionSummary(summary()) }));
  assert.match(markup, /公共团队池/);
  assert.match(markup, /单独记账，不计入任何个人提成/);
  assert.match(markup, /¥3\.00/);
  assert.match(markup, /销售甲/);
  assert.match(markup, /¥52\.00/);
  assert.doesNotMatch(markup, /¥55\.00/);
  const table = markup.slice(markup.indexOf("<table"));
  assert.doesNotMatch(table, /团队池|¥3\.00/);
});

test("empty admin month is explicit and malformed summary data is rejected", () => {
  const markup = renderToStaticMarkup(createElement(CommissionSummaryContent, { data: summary({ rows: [], personalTotal: 0, newCustomerTotal: 0, regularPersonalTotal: 0, teamPoolTotal: 0, orderCount: 0 }) }));
  assert.match(markup, /该月暂无符合新制度的核销提成记录/);
  for (const value of [null, summary({ rows: null }), summary({ teamPoolTotal: NaN }), summary({ reviewRequiredOrderCount: -1 }), summary({ rows: [{ personnelId: "p1", name: "销售甲", personalAmount: 12 }] })]) {
    assert.throws(() => parseCommissionSummary(value), /月度提成数据不完整/);
  }
});

test("admin-only data review warning is conditional and preserves the calculated totals", () => {
  const clean = renderToStaticMarkup(createElement(CommissionSummaryContent, { data: summary() }));
  assert.doesNotMatch(clean, /存在需核对项/);
  const warning = renderToStaticMarkup(createElement(CommissionSummaryContent, { data: summary({ reviewRequiredOrderCount: 2 }) }));
  assert.match(warning, /有 2 笔订单存在需核对项/);
  assert.match(warning, /请先核对再确认提成/);
  assert.match(warning, /¥52\.00/);
  assert.doesNotMatch(warning, /异常部分未计提/);
});

test("order detail is read-only lifetime personal commission and excludes old orders", () => {
  const order = { commissionEligible: true, commissionPolicyLabel: "新客首单个人 5%", commissionBase: 1000, personalCommissionAmount: 50, newCustomerCommissionAmount: 50, commissionRate: 99, commissionCap: 999, teamCommissionAmount: 500 };
  const markup = renderToStaticMarkup(createElement(OrderCommissionDetails, { order }));
  assert.match(markup, /¥50\.00/);
  assert.match(markup, /不是当月提成/);
  assert.doesNotMatch(markup, /input|button|99%|999|500|提成上限|最低回厂|团队池/);
  const old = renderToStaticMarkup(createElement(OrderCommissionDetails, { order: { ...order, commissionEligible: false, commissionPolicyLabel: "旧订单不参与" } }));
  assert.match(old, /不按旧算法计算提成/);
  assert.doesNotMatch(old, /¥50\.00/);
});

test("route wiring uses a self-only endpoint and reserves business and aggregate screens for admin", async () => {
  const personalSource = await readFile(new URL("./PersonalCommissionDashboard.tsx", import.meta.url), "utf8");
  const dashboard = await readFile(new URL("./Dashboard.tsx", import.meta.url), "utf8");
  const finance = await readFile(new URL("./FinanceView.tsx", import.meta.url), "utf8");
  assert.match(personalSource, /fetch\("\/api\/commissions\/me",/);
  assert.doesNotMatch(personalSource, /\/api\/(orders|dashboard|finance|state|commissions\/summary)|\/api\/commissions\/me\?/);
  assert.match(personalSource, /return \(\) => controller\.abort\(\)/);
  assert.match(dashboard, /canAccessAdminDashboard\(state\.user\)\s*\? <AdminDashboard \/>\s*: <PersonalCommissionDashboard/);
  assert.match(finance, /permission\.isAdmin && <CommissionSummarySection/);
  assert.match(finance, /permission\.isAdmin && <OrderCommissionDetails/);
  assert.match(finance, /permission\.isAdmin && <th[^\n]+累计个人/);
  assert.match(finance, /permission\.isAdmin && <div><div[^\n]+累计个人提成/);
  assert.match(finance, /\/api\/commissions\/summary\?month=/);
  assert.doesNotMatch(finance, /defaultCommissionRate|commissionRate|commissionCap|\/api\/finance\/settings|\/api\/finance\/order-commission/);
});
