import test from 'node:test';
import assert from 'node:assert/strict';
import { startMutableRouteServer } from './test-support/mutable-route-server.mjs';
import { normalizeReceivingInput, planBatchReceiving } from './purchase-batch-receiving-rules.mjs';
import { preparePurchaseProcurement } from './purchase-batch-costing-rules.mjs';
import { stockPricingFixture, PRICING_TEST_PASSWORD } from './test-support/stock-pricing-fixture.mjs';
const clone=structuredClone;
const ok=r=>assert.equal(r.response.status,200,JSON.stringify(r.body));
const rejected=r=>assert.ok(r.response.status>=400&&r.response.status<500,JSON.stringify(r.body));
const manifest=()=>({schemaVersion:1,currency:'CNY',lines:[{id:'line-a',productId:'price-product',quantity:5,unitPrice:20,taxWeightPercent:100}],boxes:[{id:'box-a',boxNo:'1',items:[{id:'item-a',lineId:'line-a',quantity:3,weightPercent:100}]},{id:'box-b',boxNo:'2',items:[{id:'item-b',lineId:'line-a',quantity:2,weightPercent:100}]}],fees:{internationalFreight:100,documentFee:10,domesticFreight:10,miscFee:0,importTax:5}});
async function setup(t){
 const fixture=clone(stockPricingFixture);fixture.state.products[0].defaultPrice=0;
 fixture.state.personnel.find(p=>p.id==='pricing-editor').permissions.lossRecords={create:true,update:true,delete:false};
 const s=await startMutableRouteServer(fixture);t.after(s.stop);const tokens={};
 for(const role of ['admin','editor','viewer'])tokens[role]=await s.login(`pricing-${role}`,PRICING_TEST_PASSWORD);
 const post=(body,role='editor')=>s.request('/api/batches/receive',{body,token:tokens[role]});
 const get=(role='editor',siteId='nanjing',batchId='receive-new')=>s.request(`/api/batches/receiving?siteId=${siteId}&batchId=${batchId}`,{token:tokens[role]});
 const create={siteId:'nanjing',batchId:'receive-new',expectedRevision:0,clientMutationId:'create-receive-01',mode:'confirm',batch:{batchNo:'RECEIVE-NEW',supplier:'接收测试',arrivalDate:'2026-09-01'},procurement:manifest()};
 ok(await s.request('/api/batches/save',{body:create,token:tokens.editor}));
 const body=(extra={})=>({siteId:'nanjing',batchId:'receive-new',expectedRevision:0,expectedCostingRevision:1,clientMutationId:'receive-request-01',date:'2026-09-02',entries:[{boxId:'box-a',itemId:'item-a',stockedQuantity:1,lostQuantity:1,subTankId:'tank-n'}],proofPhotos:['/uploads/test.jpg'],reason:'',notes:'',...extra});
 return {...s,tokens,post,get,body,create};
}
test('batch receipt persists source identity, zero catalog price, arrival death without tank, remaining and audit',async t=>{
 const s=await setup(t),before=await s.readPersistedState();const result=await s.post(s.body());ok(result);
 assert.deepEqual(result.body.summary,{orderedQuantity:5,stockedQuantity:1,lostQuantity:1,pendingQuantity:3});
 assert.equal(result.body.stockItems.length,2);const live=result.body.stockItems.find(i=>!i.lost),dead=result.body.stockItems.find(i=>i.lost);
 assert.equal(live.basePrice,0);assert.equal(live.priceMode,'product');assert.equal(live.entrySnapshot.subTankId,'tank-n');assert.equal(live.procurementSource.boxId,'box-a');
 assert.equal(dead.subTankId,'');assert.equal(dead.entrySnapshot,undefined);assert.equal(dead.entryDisposition,'arrival_dead');assert.equal(dead.neverEnteredTank,true);
 assert.equal(result.body.lossRecords[0].stockItemId,dead.id);assert.equal(result.body.bioRecords[0].stockItemId,dead.id);
 const after=await s.readPersistedState(),batch=after.batches.find(b=>b.id==='receive-new');assert.equal(batch.stockedCount,1);assert.equal(batch.lossCount,1);assert.equal(batch.arrivalLossCount,1);
 assert.deepEqual(after.batches.filter(b=>b.id!=='receive-new'),before.batches.filter(b=>b.id!=='receive-new'));
 assert.equal(after.operationLogs.length,before.operationLogs.length+1);assert.deepEqual(after.orders,before.orders);assert.deepEqual(after.products,before.products);
 const reopened=await s.get();ok(reopened);assert.equal(reopened.body.revision,1);assert.deepEqual(reopened.body.summary,result.body.summary);
});
test('replay cannot duplicate inventory or deaths; changed replay and stale concurrent submission fail atomically',async t=>{
 const s=await setup(t),body=s.body();ok(await s.post(body));const persisted=await s.readPersistedState();
 const replay=await s.post(body);ok(replay);assert.equal(replay.body.replayed,true);assert.deepEqual(await s.readPersistedState(),persisted);
 rejected(await s.post({...body,notes:'modified'}));rejected(await s.post({...body,clientMutationId:'new-receive-stale'}));assert.deepEqual(await s.readPersistedState(),persisted);
 const current=s.body({expectedRevision:1,clientMutationId:'remaining-one'});current.entries[0]={...current.entries[0],stockedQuantity:1,lostQuantity:0};
 const results=await Promise.all([s.post(current),s.post({...current,clientMutationId:'remaining-two'})]);assert.equal(results.filter(r=>r.response.status===200).length,1);assert.equal(results.filter(r=>r.response.status===409).length,1);
 assert.equal((await s.get()).body.summary.pendingQuantity,2);
});
test('permissions, tank/site, dates, aggregate overreceiving and missing death photo all reject without changes',async t=>{
 const s=await setup(t),before=await s.readPersistedState();
 assert.equal((await s.post(s.body(),'viewer')).response.status,403);assert.equal((await s.get('editor','jiangyin')).response.status,403);
 for(const patch of [{date:'2026-08-30'},{entries:[{boxId:'box-a',itemId:'item-a',stockedQuantity:4,lostQuantity:0,subTankId:'tank-n'}]},{entries:[{boxId:'box-a',itemId:'item-a',stockedQuantity:2,lostQuantity:0,subTankId:'tank-n'},{boxId:'box-a',itemId:'item-a',stockedQuantity:2,lostQuantity:0,subTankId:'tank-n'}]},{proofPhotos:[]},{entries:[{boxId:'box-a',itemId:'item-a',stockedQuantity:1,lostQuantity:0,subTankId:'tank-j'}]},{entries:[{boxId:'box-a',itemId:'missing',stockedQuantity:1,lostQuantity:0,subTankId:'tank-n'}]}])rejected(await s.post(s.body(patch)));
 assert.deepEqual(await s.readPersistedState(),before);
});
test('history batches are blocked; confirmed source cannot be deleted or relabeled after receipt',async t=>{
 const s=await setup(t);const old=await s.get('editor','nanjing','batch-n');ok(old);assert.match(old.body.blockedReason,/历史批次/);
 const historic={...s.create,batchId:'batch-n',expectedLossCount:0,clientMutationId:'historic-manifest',batch:{batchNo:'PRICE-N',supplier:'测试供应商',arrivalDate:'2026-09-01'}};ok(await s.request('/api/batches/save',{body:historic,token:s.tokens.editor}));
 assert.match((await s.get('editor','nanjing','batch-n')).body.blockedReason,/历史批次/);
 ok(await s.post(s.body()));const before=await s.readPersistedState();
 const changed={...s.create,expectedRevision:1,clientMutationId:'source-relabel-01',procurement:manifest()};changed.procurement.boxes[0].items[0].id='different-item';rejected(await s.request('/api/batches/save',{body:changed,token:s.tokens.editor}));
 assert.deepEqual(await s.readPersistedState(),before);
 const removed=before.batches.filter(b=>b.id!=='receive-new');rejected(await s.request('/api/state/patch',{token:s.tokens.admin,body:{patch:{batches:removed},basePatch:{batches:before.batches}}}));
});
test('freeform and generic creations cannot bypass receiving; real stocktake remains supported and received deletion never frees quantity',async t=>{
 const s=await setup(t);const received=await s.post(s.body());ok(received);const live=received.body.stockItems.find(i=>!i.lost);
 const write=(upsert,deleteIds=[],before={},extra={})=>s.request('/api/stock/save',{token:s.tokens.admin,body:{upsert,deleteIds,expectedOperations:Object.fromEntries([...upsert.map(i=>[i.id,before[i.id]?'update':'create']),...deleteIds.map(id=>[id,'delete'])]),expectedBefore:before,...extra}});
 const newFish={...stockPricingFixture.state.stock[0],id:'unchecked-new',code:'',basePrice:100};
 rejected(await write([newFish]));
 rejected(await write([newFish],[],{},{adjustmentContext:{kind:'inventory_adjustment',draftId:'forged',siteId:'nanjing',removeStockIds:[],additionStockIds:[newFish.id]}}));
 const before=await s.readPersistedState();
 rejected(await s.request('/api/state/patch',{token:s.tokens.admin,body:{basePatch:{stock:before.stock},patch:{stock:[...before.stock,newFish]}}}));
 const forged={...live,productId:'other-product',basePrice:100};rejected(await write([forged],[],{[live.id]:live}));
 const unchangedPrice={...live,notes:'采购到货尚未设零售价'};ok(await write([unchangedPrice],[],{[live.id]:live}));
 const latestLive=(await s.readPersistedState()).stock.find(i=>i.id===live.id);
 const updated={...latestLive,basePrice:123,priceMode:'manual',priceOverridden:true,notes:'正常编辑',procurementCostSnapshot:{totalCents:1},entrySnapshot:{operator:'fake'}};
 ok(await write([updated],[],{[live.id]:latestLive}));let state=await s.readPersistedState();const persisted=state.stock.find(i=>i.id===live.id);
 assert.deepEqual(persisted.procurementCostSnapshot,live.procurementCostSnapshot);assert.deepEqual(persisted.entrySnapshot,live.entrySnapshot);
 ok(await write([], [live.id], {[live.id]:persisted}));assert.equal((await s.get()).body.summary.pendingQuantity,3);assert.equal((await s.get()).body.batch.stockedCount,1);
 const draft=await s.request('/api/stock/adjustment-draft',{token:s.tokens.admin,body:{draft:{siteId:'nanjing',removeStockIds:[],additions:[{id:'add-one',batchId:'batch-n',productId:'price-product',subTankId:'tank-n',quantity:1,status:'healthy',inDate:'2026-09-02',basePrice:100,priceMode:'manual',priceOverridden:true}]}}});ok(draft);
 const adjustment={...newFish,inDate:'2026-09-02',priceMode:'manual',priceOverridden:true};
 ok(await write([adjustment],[],{},{adjustmentContext:{kind:'inventory_adjustment',draftId:draft.body.draft.id,siteId:'nanjing',removeStockIds:[],additionStockIds:[adjustment.id]}}));
 assert.ok((await s.readPersistedState()).stock.some(i=>i.id===adjustment.id));
});
test('staff can receive a confirmed procurement manifest created more than 48 hours ago without stock-change approval',async t=>{
 const fixture=clone(stockPricingFixture),batch={id:'old-created-manifest',siteId:'nanjing',batchNo:'OLD-CREATED',supplier:'供应商',arrivalDate:'2026-09-01',createdAt:'2026-01-01T00:00:00.000Z',receiving:{schemaVersion:1,revision:0,receipts:[]},stockedCount:0,lossCount:0,costingRevision:1,
  procurement:preparePurchaseProcurement(manifest(),{products:fixture.state.products,confirmed:true,operator:'pricing-admin',now:'2026-01-01T00:00:00.000Z'})};
 fixture.state.batches.push(batch);const s=await startMutableRouteServer(fixture);t.after(s.stop);const token=await s.login('pricing-editor',PRICING_TEST_PASSWORD);
 const result=await s.request('/api/batches/receive',{token,body:{siteId:'nanjing',batchId:batch.id,expectedRevision:0,expectedCostingRevision:1,clientMutationId:'older-manifest-receive',date:'2026-09-02',entries:[{boxId:'box-a',itemId:'item-a',stockedQuantity:1,lostQuantity:0,subTankId:'tank-n'}],proofPhotos:[],reason:'',notes:''}});ok(result);
 assert.equal(result.body.stockItems.length,1);assert.equal(result.body.pendingApproval,undefined);assert.deepEqual((await s.readPersistedState()).approvalRequests,[]);
});
test('retry after a received fish moves to another site returns no unauthorized current stock details',async t=>{
 const fixture=clone(stockPricingFixture);
 const batch={id:'receipt-privacy',siteId:'nanjing',batchNo:'PRIVACY',arrivalDate:'2026-09-01',stockedCount:0,lossCount:0,costingRevision:1,receiving:{schemaVersion:1,revision:0,receipts:[]},procurement:preparePurchaseProcurement(manifest(),{products:fixture.state.products,confirmed:true,operator:'pricing-admin',now:'2026-09-01T00:00:00Z'})};
 const body={siteId:'nanjing',batchId:batch.id,expectedRevision:0,expectedCostingRevision:1,clientMutationId:'retry-privacy-receive',date:'2026-09-02',entries:[{boxId:'box-a',itemId:'item-a',stockedQuantity:1,lostQuantity:0,subTankId:'tank-n'}],proofPhotos:[],reason:'',notes:''};
 const planned=planBatchReceiving({state:fixture.state,batch,input:normalizeReceivingInput(body,'2026-11-28'),operator:'pricing-editor',operatorId:'pricing-editor'});
 fixture.state.batches.push(planned.batch);fixture.state.stock.push({...planned.stockItems[0],siteId:'jiangyin',subTankId:'tank-j',notes:'PRIVATE_TRANSFER_CURRENT_NOTE'});
 const s=await startMutableRouteServer(fixture);t.after(s.stop);const token=await s.login('pricing-editor',PRICING_TEST_PASSWORD);
 const result=await s.request('/api/batches/receive',{token,body});ok(result);assert.equal(result.body.replayed,true);assert.deepEqual(result.body.stockItems,[]);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE_TRANSFER_CURRENT_NOTE|tank-j/);
});
