import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
let vite, Summary;
before(async () => {
  vite = await createServer({ configFile:false, server:{middlewareMode:true,hmr:false}, optimizeDeps:{noDiscovery:true,entries:[]}, esbuild:{jsx:'automatic'} });
  ({ OrderCashierBalanceSummary: Summary } = await vite.ssrLoadModule('/src/app/components/OrderCashierPanel.tsx'));
});
after(async () => { await vite?.close(); });
const order = { id:'synthetic', source:'私域线上', shippingFeeMode:'prepaid', shippingSettlementTiming:'before_shipping', shippingFee:50, items:[{stockItemId:'fish',price:70}], packagingFee:6, discount:0, payments:[] };
const shipment = fee => ({id:'s',orderId:order.id,itemStockIds:['fish'],status:'delivered',shipMethod:'express',actualShippingFee:fee});
const render = (shipments,amountDue,netRecorded,override={}) => renderToStaticMarkup(createElement(Summary,{order:{...order,...override},shipments,amountDue,netRecorded}));
test('initial receivable includes goods, packaging and advance freight in a single total',()=>{
  const html=render([],126,0);
  for(const text of ['当前订单应收','¥126.00','商品及包装（优惠调整后）','¥76.00','预收运费','¥50.00','统一登记收款','待收金额']) assert.ok(html.includes(text),text);
});
test('actual freight below the estimate shows the full-order refundable difference',()=>{
  const html=render([shipment(40)],116,126);
  for(const text of ['¥116.00','实际运费','¥40.00','应退金额','¥10.00']) assert.ok(html.includes(text),text);
  assert.ok(!html.includes('待收金额'));
});
test('actual freight above estimate shows only the additional collection and refunds reserve the balance',()=>{
  const shortage=render([shipment(70)],146,126);
  assert.ok(shortage.includes('待收金额'));assert.ok(shortage.includes('¥20.00'));
  const refunded=render([shipment(40)],116,116);
  assert.ok(refunded.includes('已登记收齐'));assert.ok(refunded.includes('到账仍需财务核验'));
});
test('deferred freight is not silently charged in initial receivable',()=>{
  const html=render([],76,0,{shippingSettlementTiming:'after_shipping',shippingFee:0});
  assert.ok(html.includes('当前订单应收'));assert.ok(html.includes('¥76.00'));
  assert.ok(html.includes('已确定运费'));assert.ok(html.includes('¥0.00'));
  assert.ok(!html.includes('预收运费'));
});
