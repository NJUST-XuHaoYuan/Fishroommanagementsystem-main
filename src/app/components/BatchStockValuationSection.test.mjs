import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let BatchStockValuationSection;
let BatchValuationListSummary;
let BatchValuationScopeWarning;
before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, entries: [] },
    esbuild: { jsx: "automatic" },
  });
  ({ BatchStockValuationSection, BatchValuationListSummary, BatchValuationScopeWarning } = await server.ssrLoadModule("/src/app/components/BatchStockValuationSection.tsx"));
});
after(async () => { await server?.close(); });

const known = { count: 2, estimatedSaleValue: 450, unpricedCount: 0 };
const unknown = { count: 1, estimatedSaleValue: 0, unpricedCount: 1 };
const valuation = {
  unsold: known,
  lost: unknown,
  restrictedCount: 1,
  bySpecies: [{ speciesId: "s1", speciesName: "黄金吊", unsold: known, lost: unknown }],
};
const render = (props) => renderToStaticMarkup(createElement(BatchStockValuationSection, { loading: false, error: "", ...props }));

test("batch valuation UI provides labelled totals, quantities and an accessible species breakdown", () => {
  const html = render({ valuation });
  assert.match(html, /未销售预计售价/);
  assert.match(html, /已损耗预计售价/);
  assert.match(html, /¥450\.00/);
  assert.match(html, /2 条/);
  assert.match(html, /<summary[^>]*>按品种查看/);
  assert.match(html, /<th scope="row"[^>]*>黄金吊/);
  assert.match(html, /暂无可估价/);
  assert.match(html, /全批次汇总，不随下方鱼只筛选变化/);
  assert.match(html, /受场地权限限制，未计入/);
  assert.match(html, /不代表损耗当天的准确售价/);
});

test("batch valuation loading, failure and empty states never substitute fabricated zero amounts", () => {
  const loading = render({ loading: true });
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /正在加载估价/);
  assert.doesNotMatch(loading, /¥0\.00/);
  assert.match(render({ error: "failure" }), /估价暂未加载/);
  assert.match(render({ valuation, error: "failure" }), /上次成功加载的估价/);
  assert.match(render({ valuation: { ...valuation, bySpecies: [] } }), /暂无可统计的未销售或已损耗单鱼档案/);
});

test("compact list estimates retain all-unpriced and partial-subtotal disclosures", () => {
  const html = renderToStaticMarkup(createElement(BatchValuationListSummary, {
    valuation: { ...valuation, unsold: { ...known, unpricedCount: 1 } },
  }));
  assert.match(html, /未销售/);
  assert.match(html, /已损耗/);
  assert.match(html, /部分合计 · 1 条缺少售价/);
  assert.match(html, /暂无可估价/);
});

test("desktop and mobile estimates flag totals that exclude restricted or invalid archives", () => {
  const partial = { ...valuation, invalidStockCount: 2 };
  for (const Component of [BatchValuationListSummary, BatchValuationScopeWarning]) {
    const html = renderToStaticMarkup(createElement(Component, { valuation: partial }));
    assert.match(html, /部分档案合计/);
    assert.match(html, /未计入1 条受限、2 条档案异常/);
  }
  const detail = render({ valuation: partial });
  assert.match(detail, /有 2 条库存档案缺少有效编号或存在冲突/);
  assert.equal(renderToStaticMarkup(createElement(BatchValuationScopeWarning, {
    valuation: { ...valuation, restrictedCount: 0, invalidStockCount: 0 },
  })), "");
  assert.equal(renderToStaticMarkup(createElement(BatchValuationScopeWarning, {})), "");
});
