import test from 'node:test';
import assert from 'node:assert/strict';
import { startMutableRouteServer } from './test-support/mutable-route-server.mjs';
import { paymentProofFixture, PRICING_TEST_PASSWORD, EVIDENCE_TEST_KEYRING } from './test-support/payment-proof-fixture.mjs';
const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const denied = r => assert.ok(r.response.status >= 400 && r.response.status < 500, JSON.stringify(r.body));
const payment = (id, amount = 1000, verificationStatus = 'verified', extra = {}) => ({ id, amount, verificationStatus, type: 'balance',
  time: '2026-11-26T10:00:00', channel: 'wechat', account: '合成微信收款账户', paymentMethodId: 'pm-wechat', paymentMethodName: '微信',
  recordSource: 'finance', recordedBy: 'pricing-editor', verifiedBy: verificationStatus === 'verified' ? 'finance-reviewer' : '',
  verifiedAt: verificationStatus === 'verified' ? '2026-11-26T11:00:00' : '', proof: ['original-proof.jpg'], notes: '原始记录', ...extra });
async function setup(t, mutate = () => {}) {
  const fixture = paymentProofFixture();
  fixture.state.personnel.find(p => p.id === 'finance-reviewer').permissions = {};
  fixture.state.orders[0].payments = [payment('receipt')];
  mutate(fixture.state);
  const s = await startMutableRouteServer(fixture, { env: { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING } }); t.after(s.stop);
  const tokens = {};
  for (const actor of ['finance-reviewer', 'pricing-editor', 'pricing-admin']) tokens[actor] = await s.login(actor, PRICING_TEST_PASSWORD);
  const request = (path, body, actor = 'finance-reviewer') => s.request(path, { token: tokens[actor], ...(body === undefined ? {} : { body }) });
  let mutation = 0;
  const overview = async () => { const r = await request('/api/finance/overview?siteId=nanjing'); ok(r); return r.body.orders.find(o => o.id === 'proof-order'); };
  const correctionBody = async (paymentId = 'receipt', extra = {}) => ({ orderId: 'proof-order', paymentId, action: 'correct', mode: 'retract', reason: '合成错误登记纠正', clientMutationId: `mutation-${++mutation}`,
    expectedToken: (await overview()).payments.find(p => p.id === paymentId).correctionToken, ...extra });
  await overview(); // Existing overview initializes the commission journal once.
  return { ...s, request, overview, correctionBody };
}

test('finance without delete can void pending shipping allocation; keeps immutable original and retries once', async t => {
  const s = await setup(t, state => { state.orders[0].payments = [payment('receipt', 1000, 'pending', { shippingAmount: 0 })]; });
  const before = await s.readPersistedState(); const initial = await s.overview(); assert.equal(initial.payments[0].canVoid, true);
  const body = await s.correctionBody('receipt', { action: 'void' });
  const r = await s.request('/api/orders/payment-correction', body); ok(r);
  const after = await s.readPersistedState(); assert.deepEqual(after.orders[0].payments, []);
  assert.deepEqual(after.orders[0].paymentCorrections[0].originalPayment, before.orders[0].payments[0]);
  assert.equal(after.orders[0].paymentCorrections[0].operator, 'finance-reviewer');
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.shipments, before.shipments);
  ok(await s.request('/api/orders/payment-correction', body));
  assert.deepEqual(await s.readPersistedState(), after);
  denied(await s.request('/api/orders/payment-correction', { ...body, reason: 'changed retry' }));
  const final = await s.overview(); assert.equal(final.pendingReceived, 0); assert.equal(final.paymentCorrections.length, 1);
});

test('verified correction creates new pending record, retains snapshots and reopens completed order', async t => {
  const s = await setup(t, state => { state.orders[0].status = 'completed'; state.shipments = [{ id: 'delivered', orderId: 'proof-order', status: 'delivered', siteId: 'nanjing', itemStockIds: ['proof-fish'] }]; });
  const before = await s.readPersistedState();
  const body = await s.correctionBody('receipt', { mode: 'replace', payment: { amount: 900, time: '2026-11-26T12:30:00', paymentMethodId: 'pm-cash', notes: '金额及收款方式更正' } });
  const r = await s.request('/api/orders/payment-correction', body); ok(r); assert.equal(r.body.reopened, true);
  const after = await s.readPersistedState(); const order = after.orders[0]; const p = order.payments[0];
  assert.equal(order.status, 'shipped'); assert.notEqual(p.id, 'receipt'); assert.equal(p.verificationStatus, 'pending');
  assert.equal(p.amount, 900); assert.equal(p.channel, 'cash'); assert.equal(p.verifiedBy, '');
  assert.deepEqual(p.proof, before.orders[0].payments[0].proof); assert.equal(order.paymentCorrections[0].originalPayment.amount, 1000);
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.shipments, before.shipments);
  const summary = await s.overview(); assert.equal(summary.received, 0); assert.equal(summary.pendingReceived, 900);
  denied(await s.request('/api/orders/payment-correction', { ...body, clientMutationId: 'stale-new-id' }));
  ok(await s.request('/api/orders/payment', { orderId: 'proof-order', action: 'verify', paymentId: p.id }));
  assert.equal((await s.overview()).received, 900);
});

test('approved proof correction rejects claim for resubmission, preserves prior review and notifies owner', async t => {
  const s = await setup(t, state => {
    state.orders[0].payments[0].paymentProofClaimId = 'claim'; state.orders[0].status = 'completed';
    state.orders[0].paymentClaims = [{ id: 'claim', status: 'approved', version: 2, amount: 1000, paymentId: 'receipt', reviewedBy: 'finance-reviewer', evidenceAttachments: [{ id: 'private-proof', name: '凭证.jpg' }] }];
  });
  const before = await s.readPersistedState(); assert.equal((await s.overview()).payments[0].correctionMode, 'proof_resubmit');
  const body = await s.correctionBody();
  denied(await s.request('/api/orders/payment-correction', { ...body, payment: { amount: 900 } }));
  const r = await s.request('/api/orders/payment-correction', body); ok(r); assert.equal(r.body.proofResubmissionRequired, true);
  const after = await s.readPersistedState(); const order = after.orders[0];
  assert.equal(order.payments.length, 0); assert.equal(order.status, 'pending'); assert.equal(order.paymentClaims[0].status, 'rejected');
  assert.equal(order.paymentClaims[0].version, 3); assert.equal(order.paymentClaims[0].paymentId, '');
  assert.deepEqual(order.paymentClaims[0].previousReviews[0], before.orders[0].paymentClaims[0]);
  assert.deepEqual(order.paymentClaims[0].evidenceAttachments, before.orders[0].paymentClaims[0].evidenceAttachments);
  assert.equal(after.notifications[0].recipientUsername, 'pricing-editor'); assert.equal(after.notifications[0].claimId, 'claim');
  const detail = await s.request('/api/orders/payment-proof/detail?orderId=proof-order', undefined, 'pricing-editor'); ok(detail); assert.equal(detail.body.canSubmit, true);
});

test('refund balance prevents removal of supporting receipt; refunds can be corrected or withdrawn first', async t => {
  const s = await setup(t, state => { state.orders[0].payments.push(payment('refund', 100, 'pending', { type: 'refund', shippingAmount: 0 })); });
  const before = await s.readPersistedState();
  const blocked = await s.request('/api/orders/payment-correction', await s.correctionBody()); denied(blocked); assert.equal(blocked.body.code, 'PAYMENT_CORRECTION_REFUND_BALANCE');
  assert.deepEqual(await s.readPersistedState(), before);
  ok(await s.request('/api/orders/payment-correction', await s.correctionBody('refund', { action: 'void' })));
  ok(await s.request('/api/orders/payment-correction', await s.correctionBody()));
  assert.equal((await s.overview()).payments.length, 0);
  const final = await s.readPersistedState();
  assert.equal(final.commissionLedgerV1.entries.reduce((sum, item) => sum + item.regularPersonalCents, 0), 0);
  const deletion = await s.request('/api/orders/delete', { orderId: 'proof-order' }, 'pricing-admin');
  denied(deletion); assert.equal(deletion.body.code, 'PAYMENT_CORRECTION_AUDIT_RETAINED');
  assert.deepEqual(await s.readPersistedState(), final);
});

test('auth, scope, external statements, required reason and legacy mutation bypass are rejected', async t => {
  const s = await setup(t, state => {
    state.orders.push({ ...structuredClone(state.orders[0]), id: 'hidden', siteId: 'jiangyin', orderNo: 'hidden-order' });
    state.orders[0].payments.push(payment('statement', 30, 'pending', { statementId: 'statement-id', recordSource: 'statement' }));
  });
  const before = await s.readPersistedState(); const body = await s.correctionBody();
  denied(await s.request('/api/orders/payment-correction', body, 'pricing-editor'));
  denied(await s.request('/api/orders/payment-correction', { ...body, orderId: 'hidden' }));
  denied(await s.request('/api/orders/payment-correction', { ...body, reason: '  ' }));
  const stmt = (await s.overview()).payments.find(p => p.id === 'statement'); assert.equal(stmt.canVoid, false);
  denied(await s.request('/api/orders/payment-correction', { ...body, paymentId: 'statement', action: 'void' }));
  denied(await s.request('/api/orders/payment', { orderId: 'proof-order', action: 'delete', paymentId: 'receipt' }, 'pricing-admin'));
  denied(await s.request('/api/orders/payment', { orderId: 'proof-order', action: 'update', payment: { id: 'receipt', type: 'balance', amount: 5 } }));
  assert.deepEqual(await s.readPersistedState(), before);
});

test('generic writes cannot forge, erase audit or bypass correction for legacy payments', async t => {
  const s = await setup(t); ok(await s.request('/api/orders/payment-correction', await s.correctionBody()));
  const before = await s.readPersistedState();
  for (const orders of [before.orders.map(o => ({ ...o, paymentCorrections: [] })), before.orders.map(o => ({ ...o, payments: [payment('forged')] }))]) {
    denied(await s.request('/api/state/patch', { patch: { orders }, basePatch: { orders: before.orders } }, 'pricing-admin'));
  }
  assert.deepEqual(await s.readPersistedState(), before);
});

test('cancelled order remains cancelled; legacy account snapshot can be corrected without inventing an account', async t => {
  const s = await setup(t, state => { state.orders[0].status = 'cancelled'; state.orders[0].payments[0].paymentMethodId = ''; state.orders[0].payments[0].account = '停用的历史账户'; });
  const body = await s.correctionBody('receipt', { mode: 'replace', payment: { amount: 900, time: '2026-11-26T12:00:00', paymentMethodId: '', channel: 'wechat', account: '伪造账户' } });
  const r = await s.request('/api/orders/payment-correction', body); ok(r);
  assert.equal(r.body.order.status, 'cancelled'); assert.equal(r.body.order.payments[0].account, '停用的历史账户');
});


test('concurrent correction requests cannot remove or replace one record twice', async t => {
  const s = await setup(t); const body = await s.correctionBody();
  const results = await Promise.all([s.request('/api/orders/payment-correction', body), s.request('/api/orders/payment-correction', { ...body, clientMutationId: 'concurrent-other' })]);
  assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409]);
  const final = await s.readPersistedState(); assert.equal(final.orders[0].paymentCorrections.length, 1); assert.equal(final.orders[0].payments.length, 0);
});

test('cashier replacement cannot increase over due or forge immutable type and snapshot', async t => {
  const s = await setup(t, state => { state.orders[0].orderFormSchemaVersion = 4; });
  const body = await s.correctionBody('receipt', { mode: 'replace', payment: { amount: 1000.01, time: '2026-11-26T12:00:00', paymentMethodId: 'pm-wechat' } });
  const before = await s.readPersistedState();
  const excess = await s.request('/api/orders/payment-correction', body); denied(excess); assert.equal(excess.body.code, 'PAYMENT_CORRECTION_OVERPAID');
  denied(await s.request('/api/orders/payment-correction', { ...body, payment: { ...body.payment, amount: 10, type: 'refund' } }));
  denied(await s.request('/api/orders/payment-correction', { ...body, payment: { ...body.payment, amount: 1000, paymentMethodId: 'pm-douyin' } }));
  assert.deepEqual(await s.readPersistedState(), before);
  const r = await s.request('/api/orders/payment-correction', { ...body, payment: { ...body.payment, amount: 1000, verifiedBy: 'forged', shippingAmount: 999, paymentProofClaimId: 'forged' } }); ok(r);
  const newPayment = r.body.order.payments[0]; assert.equal(newPayment.verifiedBy, ''); assert.equal(newPayment.shippingAmount, undefined); assert.equal(newPayment.paymentProofClaimId, undefined);
});

test('voiding a pending matched receipt also rejects its pending proof without double counting', async t => {
  const s = await setup(t, state => {
    state.orders[0].payments = [payment('receipt', 1000, 'pending')];
    state.orders[0].paymentClaims = [{ id: 'matched-claim', status: 'pending', version: 1, amount: 1000, matchingPaymentId: 'receipt', evidenceAttachments: [] }];
  });
  ok(await s.request('/api/orders/payment-correction', await s.correctionBody('receipt', { action: 'void' })));
  const after = await s.readPersistedState(); assert.equal(after.orders[0].payments.length, 0);
  assert.equal(after.orders[0].paymentClaims[0].status, 'rejected');
  assert.equal(after.orders[0].paymentClaims[0].previousReviews[0].matchingPaymentId, 'receipt');
  const detail = await s.request('/api/orders/payment-proof/detail?orderId=proof-order'); ok(detail); assert.equal(detail.body.shippingSettlement.recordedShippingReceived, 0);
});

test('pending proof is verified directly once instead of adding another receipt', async t => {
  const s = await setup(t, state => {
    const order = state.orders[0]; order.shippingFeeMode = 'prepaid'; order.shippingSettlementTiming = 'before_shipping'; order.payments = [];
    order.paymentClaims = [{ id: 'submitted', status: 'pending', version: 1, amount: 1000, purpose: 'order', shippingAmount: 0, shippingDueAtSubmission: 0,
      paymentMethodId: 'pm-wechat', paymentMethodName: '微信', channel: 'wechat', account: '合成微信收款账户', time: '2026-11-26T10:00:00', submittedBy: 'pricing-editor', evidenceAttachments: [] }];
  });
  const before = await s.readPersistedState();
  const duplicate = await s.request('/api/orders/payment', { orderId: 'proof-order', action: 'add', payment: payment('duplicate', 1000, 'pending') }); denied(duplicate);
  assert.deepEqual(await s.readPersistedState(), before);
  const detail = await s.request('/api/orders/payment-proof/detail?orderId=proof-order'); ok(detail);
  const body = { orderId: 'proof-order', claimId: 'submitted', expectedVersion: 1, reviewToken: detail.body.reviewToken, decision: 'approve' };
  ok(await s.request('/api/orders/payment-proof/review', body)); ok(await s.request('/api/orders/payment-proof/review', body));
  const after = await s.readPersistedState(); assert.equal(after.orders[0].payments.length, 1);
  assert.equal(after.orders[0].payments[0].amount, 1000); assert.equal(after.orders[0].payments[0].verificationStatus, 'verified');
});
