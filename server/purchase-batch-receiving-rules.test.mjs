import test from 'node:test';
import assert from 'node:assert/strict';
import { receivingBlockedReason, assertReceivedProcurementUnchanged } from './purchase-batch-receiving-rules.mjs';
const batch={id:'b',procurement:{status:'confirmed',lines:[{id:'l',productId:'p'}],boxes:[{id:'x',boxNo:'1',items:[{id:'i',lineId:'l',quantity:2}]}],fees:{internationalFreight:20},allocation:{totalCents:2000}},receiving:{schemaVersion:1,revision:1,receipts:[{id:'r',entries:[{boxId:'x',itemId:'i',lineId:'l',stockedQuantity:1,lostQuantity:0,stockItemIds:['fish'],lossStockItemIds:[]}]}]}};
test('approved snapshots use canonical stockItemId so deleted or edited received fish do not become ambiguous historical stock',()=>{
 const state={stock:[],approvalRequests:[{status:'approved',stockDetails:{items:[{stockItemId:'fish',before:{batchId:'b',productId:'p'},after:null}]}}]};
 assert.equal(receivingBlockedReason(state,batch),'');
 state.approvalRequests[0].stockDetails.items[0].stockItemId='historical-fish';assert.match(receivingBlockedReason(state,batch),/历史批次/);
});
test('first receipt locks cost and box configuration but accepts unchanged procurement and basic edits',()=>{
 assert.doesNotThrow(()=>assertReceivedProcurementUnchanged(batch,{...batch,notes:'updated',procurement:{...batch.procurement,updatedAt:'new date'}}));
 for(const alter of [p=>p.fees.internationalFreight++,p=>p.boxes[0].items[0].quantity++,p=>p.lines[0].productId='another']){
  const next=structuredClone(batch);alter(next.procurement);assert.throws(()=>assertReceivedProcurementUnchanged(batch,next),{code:'BATCH_RECEIVING_COST_LOCKED'});
 }
});
test('legacy batches without a server-issued receipt ledger remain blocked even when all original stock was removed',()=>{
 const old={...batch,receiving:undefined,stockedCount:0,lossCount:0};assert.match(receivingBlockedReason({stock:[],approvalRequests:[]},old),/历史批次/);
});
