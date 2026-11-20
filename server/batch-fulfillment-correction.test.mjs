import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPurchaseBatchFishHistory, buildPurchaseBatchOrderDetail } from './purchase-batch-details.mjs';
import { calculateOrderFeeBreakdown } from './finance-utils.mjs';
import { batchDetailsFixture } from './test-support/batch-details-fixture.mjs';
const scope={batchId:'batch-nj',siteId:'nanjing',visibleSiteIds:['nanjing','jiangyin'],isAdmin:true,page:1,pageSize:100};
const corrected=()=>{const state=structuredClone(batchDetailsFixture.state);state.shipments.find(s=>s.id==='shipment-sold').fulfillmentCorrection={version:1,shippingTimeStatus:'unknown',receiptStatus:'unknown',reason:'历史提前出库，实际日期待核实',updatedAt:'2026-11-20T12:00:00',operator:'admin',operatorName:'管理员'};return state};
test('batch fish history keeps original registrations distinct from unverified physical fulfillment',()=>{
 const state=corrected(),before=JSON.stringify(state);
 const result=buildPurchaseBatchFishHistory(state,{...scope,stockItemId:'fish-sold'});
 assert.match(result.events.find(e=>e.id==='shipment:shipment-sold:shipped').title,/原发货登记/);
 assert.match(result.events.find(e=>e.id==='shipment:shipment-sold:delivered').title,/原签收登记/);
 const correction=result.events.find(e=>e.id==='shipment:shipment-sold:fulfillment-correction');
 assert.equal(correction.date,'2026-11-20T12:00:00');assert.match(correction.text,/本条时间为更正登记时间/);assert.match(correction.text,/实际发货时间待核实.*签收情况待核实/);assert.equal(correction.operator,'管理员');
 assert.equal(JSON.stringify(state),before);
});
test('read-only batch order shows correction alongside raw dates without changing monetary totals',()=>{
 const state=corrected();const original=structuredClone(state);delete original.shipments.find(s=>s.id==='shipment-sold').fulfillmentCorrection;
 const a=buildPurchaseBatchOrderDetail(state,{...scope,orderId:'ORDER-SALE'},calculateOrderFeeBreakdown).order;
 const b=buildPurchaseBatchOrderDetail(original,{...scope,orderId:'ORDER-SALE'},calculateOrderFeeBreakdown).order;
 assert.deepEqual(a.totals,b.totals);assert.deepEqual(a.payments,b.payments);assert.deepEqual(a.items,b.items);
 const shipment=a.shipments.find(s=>s.id==='shipment-sold');assert.equal(shipment.deliveredAt,'2026-08-04T10:00:00+08:00');assert.equal(shipment.fulfillmentCorrection.receiptStatus,'unknown');assert.equal(shipment.fulfillmentCorrection.actualShippedAt,'');
});
test('known corrected dates and received-with-unknown-date remain explicit in fish history',()=>{
 const state=corrected();Object.assign(state.shipments.find(s=>s.id==='shipment-sold').fulfillmentCorrection,{shippingTimeStatus:'known',actualShippedAt:'2026-08-10T10:00:00',receiptStatus:'received'});
 const event=buildPurchaseBatchFishHistory(state,{...scope,stockItemId:'fish-sold'}).events.find(e=>e.id==='shipment:shipment-sold:fulfillment-correction');
 assert.match(event.text,/实际发货时间：2026-08-10T10:00:00/);assert.match(event.text,/已收到，签收日期待核实/);
});
