import test from 'node:test';
import assert from 'node:assert/strict';
import { shippingSettlementSummary, allocateShippingProof, validateShippingReceipt, planShippingRefund } from './shipping-settlement.mjs';
import { paymentProofDetail, planPaymentProofSubmission, planPaymentProofReview, paymentProofReviewToken } from './payment-proof-rules.mjs';

const now = '2026-11-25T12:00:00+08:00';
const order = extra => ({ id:'o', source:'私域线上', status:'pending', shippingFeeMode:'prepaid', shippingSettlementTiming:'before_shipping', shippingFee:50, items:[{stockItemId:'fish',price:1000}], discount:0,packagingFee:0,payments:[],paymentClaims:[],...extra });
const shipment = extra => ({id:'s',orderId:'o',status:'shipped',itemStockIds:['fish'],actualShippingFee:40,...extra});
const receipt = (id, amount, shippingAmount, extra={})=>({id,type:'balance',amount,shippingAmount,verificationStatus:'verified',...extra});

test('prepay and deferred charge different receivables, unknown and real zero are distinct',()=>{
  assert.equal(shippingSettlementSummary(order(),[]).shippingDue,50);
  assert.equal(shippingSettlementSummary(order({shippingSettlementTiming:'after_shipping',shippingFee:0}),[]).shippingDue,0);
  assert.equal(shippingSettlementSummary(order(),[shipment({actualShippingFee:0})]).finalized,false);
  const zero=shippingSettlementSummary(order(),[shipment({actualShippingFee:0,actualShippingFeeRecordedAt:now})]);
  assert.equal(zero.finalized,true);assert.equal(zero.shippingDue,0);
});
test('split shipment confirmed subtotals never imply final refund before remaining fish are dispatched',()=>{
  const o=order({items:[{stockItemId:'fish',price:500},{stockItemId:'fish2',price:500}],payments:[receipt('p',1050,50)]});
  assert.equal(shippingSettlementSummary(o,[shipment()]).shippingDue,50);
  assert.equal(shippingSettlementSummary(o,[shipment()]).toRefund,0);
  const deferred={...o,shippingSettlementTiming:'after_shipping',shippingFee:0};
  assert.equal(shippingSettlementSummary(deferred,[shipment()]).shippingDue,40);
  assert.equal(shippingSettlementSummary(deferred,[shipment()]).finalized,false);
  const done=shippingSettlementSummary(o,[shipment(),shipment({id:'s2',itemStockIds:['fish2'],actualShippingFee:0,actualShippingFeeRecordedAt:now})]);
  assert.equal(done.toRefund,10);
});
test('registered pending freight reserves collection but is not refundable until verified',()=>{
  const o=order({shippingSettlementTiming:'after_shipping',shippingFee:0,paymentClaims:[{id:'c',status:'pending',purpose:'shipping_fee',amount:40,shippingAmount:40}]});
  const summary=shippingSettlementSummary(o,[shipment()]);
  assert.equal(summary.toCollect,0);assert.equal(summary.verifiedShippingReceived,0);assert.equal(summary.status,'proof_pending');assert.equal(summary.toRefund,0);
  o.paymentClaims[0].status='rejected';assert.equal(shippingSettlementSummary(o,[shipment()]).toCollect,40);
});
test('receipts allocate merchandise first and later freight never duplicates earlier declarations',()=>{
  const o=order();assert.deepEqual(allocateShippingProof(o,[],1050),{purpose:'order',shippingAmount:50,goodsAmount:1000});
  o.paymentClaims=[{id:'c',status:'pending',amount:1000,shippingAmount:0,purpose:'order'}];
  assert.equal(validateShippingReceipt(o,[],50,'shipping_fee').shippingAmount,50);
  assert.throws(()=>validateShippingReceipt(o,[],51,'shipping_fee'),error=>error.code==='PAYMENT_PROOF_SHIPPING_OVERPAID');
});
test('refunds reserve the confirmed excess exactly once without reducing merchandise receivable',()=>{
  const o=order({payments:[receipt('p',1050,50)]});
  const planned=planShippingRefund(o,[shipment()],{amount:10,time:now,reason:'运费差额'},{now,account:{username:'owner'},createId:()=> 'r'});
  assert.equal(planned.payment.refundCategory,'shipping_fee');assert.equal(planned.payment.verificationStatus,'pending');
  assert.equal(shippingSettlementSummary(planned.order,[shipment()]).toRefund,0);
  assert.equal(shippingSettlementSummary(planned.order,[shipment()]).pendingRefundAmount,10);
  assert.throws(()=>planShippingRefund(planned.order,[shipment()],{amount:10,time:now},{now,account:{username:'owner'},createId:()=> 'r2'}));
});

function proofFixture(o=order()){
 const account={id:'admin',username:'admin',accessRole:'admin'};
 const evidence={id:'ppe_'+'a'.repeat(32),orderId:'o',uploaderPersonnelId:'admin',uploaderUsername:'admin',createdAt:new Date().toISOString(),size:100,mime:'image/jpeg',sha256:'a'};
 const state={orders:[o],personnel:[account],shipments:[],paymentEvidenceAttachments:[evidence],systemSettings:{paymentMethods:[{id:'cash',name:'现金',channel:'cash',account:'现金',enabled:true}]}};
 Object.assign(o,{paymentChannel:'cash',paymentAccount:'现金'});
 return {o,account,state,body:{amount:1050,time:now,paymentMethodId:'cash',evidenceIds:[evidence.id],purpose:'order',shippingAmount:50}};
}
test('valid prepay proof survives later carrier cost decrease; settled freight allocation is retained',()=>{
 const f=proofFixture();
 const submitted=planPaymentProofSubmission(f.state,f.o,f.account,f.body,{amountDue:1050,now,createId:()=> 'c'});
 assert.equal(submitted.claim.shippingDueAtSubmission,50);
 const o=submitted.order;f.state.shipments=[shipment()];f.state.orders=[o];
 const reviewed=planPaymentProofReview(o,f.account,{claimId:'c',expectedVersion:1,reviewToken:paymentProofReviewToken(o),decision:'approve'},{amountDue:1040,now,createPaymentId:()=> 'p',state:f.state});
 assert.equal(reviewed.order.payments[0].shippingAmount,50);
 assert.equal(shippingSettlementSummary(reviewed.order,f.state.shipments).toRefund,10);
});
test('new freight claims cannot overbook pending claims, spoof allocation, or become ordinary receipts',()=>{
 const f=proofFixture(order({shippingSettlementTiming:'after_shipping',shippingFee:0,payments:[receipt('g',1000,0,{channel:'cash',account:'现金'})]}));
 f.state.shipments=[shipment({actualShippingFee:60})];
 assert.throws(()=>planPaymentProofSubmission(f.state,f.o,f.account,{...f.body,amount:61,purpose:'shipping_fee',shippingAmount:61},{amountDue:1060,now,createId:()=> 'c'}));
 assert.throws(()=>planPaymentProofSubmission(f.state,f.o,f.account,{...f.body,amount:60,purpose:'shipping_fee',shippingAmount:0},{amountDue:1060,now,createId:()=> 'c'}));
 const submitted=planPaymentProofSubmission(f.state,f.o,f.account,{...f.body,amount:60,purpose:'shipping_fee',shippingAmount:60},{amountDue:1060,now,createId:()=> 'c'});
 const o=submitted.order;
 const reviewed=planPaymentProofReview(o,f.account,{claimId:'c',expectedVersion:1,reviewToken:paymentProofReviewToken(o),decision:'approve'},{amountDue:1060,now,createPaymentId:()=> 'p',state:f.state});
 assert.equal(reviewed.order.payments[1].type,'shipping_fee');assert.equal(reviewed.order.payments[1].shippingAmount,60);
 assert.equal(paymentProofDetail({...f.state,orders:[o]},o,f.account,1060,true).shippingSettlement.toCollect,0);
});
test('bank-first receipt proof links the existing record and never invents a duplicate',()=>{
 const f=proofFixture(order({payments:[receipt('bank',1050,50,{channel:'cash',account:'现金'})]}));
 const submitted=planPaymentProofSubmission(f.state,f.o,f.account,f.body,{amountDue:1050,now,createId:()=> 'c'});
 assert.equal(submitted.claim.matchingPaymentId,'bank');
 const o=submitted.order;
 const review={claimId:'c',expectedVersion:1,reviewToken:paymentProofReviewToken(o),decision:'approve'};
 assert.throws(()=>planPaymentProofReview(o,f.account,review,{amountDue:1050,now,createPaymentId:()=> 'new',state:f.state}));
 const done=planPaymentProofReview(o,f.account,{...review,existingPaymentId:'bank'},{amountDue:1050,now,createPaymentId:()=> 'new',state:f.state});
 assert.equal(done.order.payments.length,1);assert.equal(done.order.payments[0].shippingAmount,50);
});

test('mixed ordinary refunds reserve their freight portion against any second difference refund',async()=>{
 const {validateOrderRefundAllocation}=await import('./shipping-settlement.mjs');
 const o=order({payments:[receipt('p',1050,50)]});
 assert.deepEqual(validateOrderRefundAllocation(o,1050),{shippingAmount:50,goodsAmount:1000});
 o.payments.push({id:'r',type:'refund',amount:1050,shippingAmount:50,verificationStatus:'pending'});
 assert.equal(shippingSettlementSummary(o,[shipment()]).toRefund,0);
 assert.throws(()=>validateOrderRefundAllocation(o,1));
});

test('bank-first prepayment receipt may receive its proof after carrier fee falls',()=>{
 const f=proofFixture(order({payments:[receipt('bank',1050,50,{channel:'cash',account:'现金'})]}));f.state.shipments=[shipment()];
 const submitted=planPaymentProofSubmission(f.state,f.o,f.account,f.body,{amountDue:1040,now,createId:()=> 'c'});
 assert.equal(submitted.claim.shippingAmount,50);assert.equal(submitted.claim.matchingPaymentId,'bank');
 assert.equal(shippingSettlementSummary(submitted.order,f.state.shipments).recordedShippingReceived,50);
});
test('refund evidence cannot be reused as income proof, including re-uploaded identical bytes',()=>{
 const f=proofFixture();f.state.paymentEvidenceAttachments[0].boundClaimIds=['shipping-refund:r'];
 assert.throws(()=>planPaymentProofSubmission(f.state,f.o,f.account,f.body,{amountDue:1050,now,createId:()=> 'c'}),error=>error.code==='PAYMENT_PROOF_DUPLICATE');
 const copied={...f.state.paymentEvidenceAttachments[0],id:'ppe_'+'b'.repeat(32),boundClaimIds:[]};f.state.paymentEvidenceAttachments.push(copied);
 assert.throws(()=>planPaymentProofSubmission(f.state,f.o,f.account,{...f.body,evidenceIds:[copied.id]},{amountDue:1050,now,createId:()=> 'c'}),error=>error.code==='PAYMENT_PROOF_DUPLICATE');
});
test('cancelled orders do not re-open freight collection after refunds',()=>{
 const o=order({status:'cancelled',payments:[receipt('p',1050,50),{id:'r',type:'refund',amount:1050,shippingAmount:50}]});
 const summary=shippingSettlementSummary(o,[shipment()]);assert.equal(summary.toCollect,0);assert.equal(summary.status,'not_applicable');
});
