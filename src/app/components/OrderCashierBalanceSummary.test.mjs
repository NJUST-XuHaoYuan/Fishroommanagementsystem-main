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
const renderActions = (amountDue, netRecorded, override={}) => renderToStaticMarkup(createElement(Summary, {
  order, shipments:[], amountDue, netRecorded, canRecordPayment:true,
  onRecordPayment:()=>{}, onRecordRefund:()=>{}, ...override,
}));
test('initial receivable includes goods, packaging and advance freight in a single total',()=>{
  const html=render([],126,0);
  for(const text of ['订单应收合计','¥126.00','商品及包装（优惠调整后）','¥76.00','预收运费','¥50.00','统一登记收款','应收金额']) assert.ok(html.includes(text),text);
});
test('actual freight below the estimate shows the full-order refundable difference',()=>{
  const html=render([shipment(40)],116,126);
  for(const text of ['¥116.00','实际运费','¥40.00','应付金额（退款）','¥10.00']) assert.ok(html.includes(text),text);
  assert.ok(!html.includes('应收金额'));
});
test('actual freight above estimate shows only the additional collection and refunds reserve the balance',()=>{
  const shortage=render([shipment(70)],146,126);
  assert.ok(shortage.includes('应收金额'));assert.ok(shortage.includes('¥20.00'));
  const refunded=render([shipment(40)],116,116);
  assert.ok(refunded.includes('无应收应付'));assert.ok(refunded.includes('财务核验进度见下方记录'));
});
test('deferred freight is not silently charged in initial receivable',()=>{
  const html=render([],76,0,{shippingSettlementTiming:'after_shipping',shippingFee:0});
  assert.ok(html.includes('订单应收合计'));assert.ok(html.includes('¥76.00'));
  assert.ok(html.includes('已确定运费'));assert.ok(html.includes('¥0.00'));
  assert.ok(!html.includes('预收运费'));
});
test('only the action matching the outstanding balance is offered',()=>{
  const receivable=renderActions(88,72);
  assert.match(receivable,/应收金额/); assert.match(receivable,/¥16\.00/);
  assert.match(receivable,/>登记收款<\/button>/); assert.doesNotMatch(receivable,/>登记退款<\/button>/);
  const payable=renderActions(88,104);
  assert.match(payable,/应付金额（退款）/); assert.match(payable,/¥16\.00/);
  assert.match(payable,/>登记退款<\/button>/); assert.doesNotMatch(payable,/>登记收款<\/button>/);
});
test('recorded receipts and refunds balance even before verification, with no payment actions',()=>{
  const html=renderActions(88,104-16);
  assert.match(html,/无应收应付/); assert.match(html,/包含待核验款项/);
  assert.doesNotMatch(html,/<button/); assert.doesNotMatch(html,/财务已结清/);
});
test('a one-cent balance remains actionable and floating point residue does not',()=>{
  assert.match(renderActions(0.3,0.1+0.2),/无应收应付/);
  assert.doesNotMatch(renderActions(0.3,0.1+0.2),/<button/);
  for(const [due,received,action] of [[88,87.99,'登记收款'],[88,88.01,'登记退款']]) {
    const html=renderActions(due,received);
    assert.match(html,/¥0\.01/); assert.ok(html.includes(action));
    assert.doesNotMatch(html,/无应收应付/);
  }
});
test('amount visibility does not grant permission or bypass loading and saving locks',()=>{
  const readOnly=renderActions(88,0,{onRecordPayment:undefined,onRecordRefund:undefined});
  assert.match(readOnly,/应收金额/); assert.doesNotMatch(readOnly,/<button/);
  const refundReadOnly=renderActions(88,104,{onRecordRefund:undefined});
  assert.match(refundReadOnly,/应付金额（退款）/); assert.doesNotMatch(refundReadOnly,/<button/);
  assert.match(renderActions(88,0,{canRecordPayment:false}),/<button[^>]*disabled/);
  assert.match(renderActions(88,104,{refundSaving:true}),/<button[^>]*disabled/);
});
