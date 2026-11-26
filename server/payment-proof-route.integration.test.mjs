import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { paymentProofFixture, evidencePng, EVIDENCE_TEST_KEYRING, PRICING_TEST_PASSWORD } from "./test-support/payment-proof-fixture.mjs";
import { reconcileCommissionLedger } from "./commission-ledger.mjs";
import { shipmentPaymentGate } from "./shipment-payment-rules.mjs";
import { paymentEvidencePath, PAYMENT_EVIDENCE_DIRECTORY } from "./payment-evidence.mjs";
import { publicVideoDerivativeProxyPath } from "./video-preview.mjs";
import { orderCompletionFinancialCheck } from "./order-completion-finance.mjs";

const ok = result => assert.equal(result.response.status, 200, JSON.stringify(result.body));
const denied = result => assert.ok(result.response.status >= 400 && result.response.status < 500, JSON.stringify(result.body));
const pendingClaim = state => state.orders.find(order => order.id === "proof-order").paymentClaims.at(-1);
async function setup(t, customize = () => {}) {
  const fixture = paymentProofFixture(); customize(fixture.state);
  const s = await startMutableRouteServer(fixture, { env: { PERSONNEL_DATA_KEYRING_JSON: EVIDENCE_TEST_KEYRING } });
  t.after(s.stop);
  const tokens = {};
  for (const username of ["pricing-admin", "pricing-editor", "pricing-viewer", "finance-reviewer", "other-owner"]) tokens[username] = await s.login(username, PRICING_TEST_PASSWORD);
  const request = (path, body, actor = "pricing-editor") => s.request(path, { token: tokens[actor], ...(body === undefined ? {} : { body }) });
  const detail = (actor = "pricing-editor", orderId = "proof-order") => request(`/api/orders/payment-proof/detail?orderId=${orderId}`, undefined, actor);
  const upload = async ({ actor = "pricing-editor", orderId = "proof-order", image = evidencePng(), mime = "image/png" } = {}) => {
    const response = await fetch(`${s.baseUrl}/api/orders/payment-proof/evidence?orderId=${orderId}`, { method: "POST",
      headers: { Authorization: `Bearer ${tokens[actor]}`, "Content-Type": mime, "x-file-name": encodeURIComponent("合成付款截图.png") }, body: image });
    return { response, body: await response.json() };
  };
  const submit = async (amount = 300, extra = {}, actor = "pricing-editor", image = evidencePng()) => {
    const uploaded = await upload({ actor, image }); ok(uploaded);
    return request("/api/orders/payment-proof/submit", { orderId: "proof-order", amount, time: "2026-11-18T12:00:00+08:00",
      paymentMethodId: "pm-wechat", notes: "负责人核对合成收款凭证", evidenceIds: [uploaded.body.attachment.id], ...extra }, actor);
  };
  const review = async (claim, extra = {}, actor = "finance-reviewer") => {
    const d = await detail(actor); ok(d);
    return request("/api/orders/payment-proof/review", { orderId: "proof-order", claimId: claim.id, expectedVersion: claim.version,
      reviewToken: d.body.reviewToken, decision: "approve", ...extra }, actor);
  };
  return { ...s, tokens, request, detail, upload, submit, review };
}

test("a receipt can be reviewed after an actual refund was registered but before that refund is verified", async t => {
  const s = await setup(t, state => {
    state.orders[0].orderFormSchemaVersion = 4;
    state.orders[0].items[0].price = 900;
    const extra = { ...state.stock[0], id: "returned-fish", code: "RETURN-100" };
    state.stock.push(extra);
    state.orders[0].items.push({ ...state.orders[0].items[0], stockItemId: extra.id, fishCode: extra.code, price: 100 });
  });
  ok(await s.submit(1000));
  const claim = pendingClaim(await s.readPersistedState());
  ok(await s.request("/api/orders/return-item", { orderId: "proof-order", stockItemId: "returned-fish" }));
  ok(await s.request("/api/orders/refund", { orderId: "proof-order", id: "refund-before-review", amount: 100,
    time: "2026-11-18T12:05:00+08:00", paymentMethodId: "pm-wechat", notes: "合成测试已实际退回100" }));
  ok(await s.review(claim));
  const order = (await s.readPersistedState()).orders[0];
  assert.equal(order.items.length, 1);
  assert.equal(order.payments.find(payment => payment.type === "refund").verificationStatus, "pending");
  assert.equal(order.payments.find(payment => payment.type !== "refund").amount, 1000);
  const completion = orderCompletionFinancialCheck(order, 900);
  assert.equal(completion.canComplete, false);
  assert.ok(completion.reasons.some(reason => reason.code === "REFUND_PENDING"));
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "refund-before-review" }, "finance-reviewer"));
  assert.equal(orderCompletionFinancialCheck((await s.readPersistedState()).orders[0], 900).canComplete, true);
});

for (const refundStatus of ["pending", "verified"]) {
  test(`pickup can register and review a replacement collection after a ${refundStatus} refund`, async t => {
    const s = await setup(t, state => {
      const order = state.orders[0];
      order.orderFormSchemaVersion = 4; order.source = "线下";
      order.payments = [
        { id: "original-receipt", type: "balance", amount: 1000, verificationStatus: "verified", channel: "wechat", account: "合成微信收款账户", paymentProofClaimId: "original-claim" },
        { id: "actual-refund", type: "refund", amount: 100, verificationStatus: refundStatus, channel: "wechat", account: "合成微信收款账户" },
      ];
      order.paymentClaims = [{ id: "original-claim", status: "approved", amount: 1000, paymentId: "original-receipt" }];
    });
    ok(await s.submit(100));
    const claim = pendingClaim(await s.readPersistedState());
    assert.equal(claim.status, "pending");
    ok(await s.review(claim));
    const order = (await s.readPersistedState()).orders[0];
    assert.equal(order.payments.filter(payment => payment.type !== "refund").reduce((sum, payment) => sum + payment.amount, 0), 1100);
    assert.equal(orderCompletionFinancialCheck(order, 1000).canComplete, refundStatus === "verified");
    const tooMuch = await s.submit(1, {}, "pricing-editor", evidencePng({ width: 11 }));
    denied(tooMuch); assert.equal(tooMuch.body.code, "PAYMENT_PROOF_OVERPAID");
  });
}

test("rejecting a receipt after refund preserves the actual refund and allows a corrected proof without double counting", async t => {
  const s = await setup(t, state => { state.orders[0].orderFormSchemaVersion = 4; });
  ok(await s.submit(1000)); const original = pendingClaim(await s.readPersistedState());
  ok(await s.request("/api/orders/refund", { orderId: "proof-order", id: "actual-refund-rejected-proof", amount: 100,
    time: "2026-11-18T12:05:00+08:00", paymentMethodId: "pm-wechat" }));
  ok(await s.review(original, { decision: "reject", reason: "合成凭证截图需要补正" }));
  const rejectedState = await s.readPersistedState();
  assert.equal(rejectedState.orders[0].payments.length, 1);
  assert.equal(rejectedState.orders[0].payments[0].type, "refund");
  assert.equal(orderCompletionFinancialCheck(rejectedState.orders[0], 1000).canComplete, false);
  const rejected = pendingClaim(rejectedState);
  ok(await s.submit(1000, { claimId: rejected.id, expectedVersion: rejected.version }, "pricing-editor", evidencePng({ width: 12 })));
  const resubmitted = pendingClaim(await s.readPersistedState());
  assert.equal(resubmitted.id, rejected.id); assert.equal(resubmitted.status, "pending");
  ok(await s.review(resubmitted));
  const order = (await s.readPersistedState()).orders[0];
  assert.equal(order.paymentClaims.length, 1); assert.equal(order.payments.length, 2);
  assert.equal(orderCompletionFinancialCheck(order, 1000).canComplete, false);
});

test("owner proof is a pending declaration; finance approval confirms one receipt and accrues commission once", async t => {
  const s = await setup(t);
  ok(await s.submit(300, { status: "approved", verificationStatus: "verified", reviewedBy: "pricing-editor" }));
  const pending = await s.readPersistedState(); const claim = pendingClaim(pending);
  assert.equal(claim.status, "pending"); assert.equal(claim.submittedBy, "pricing-editor"); assert.equal(claim.amount, 300);
  assert.equal(pending.orders[0].payments.length, 0, "a screenshot is not confirmed money");
  const beforeCommission = reconcileCommissionLedger(pending, [], new Date());
  assert.equal(beforeCommission.byOrder.get("proof-order").commissionBase, 0);
  const d = await s.detail(); ok(d); assert.equal(d.body.summary.pendingProofAmount, 300); assert.equal(d.body.summary.creditAmount, 700);
  denied(await s.review(claim, {}, "pricing-editor"));
  ok(await s.review(claim));
  const after = await s.readPersistedState(); const approved = pendingClaim(after);
  assert.equal(approved.status, "approved"); assert.equal(approved.reviewedBy, "finance-reviewer");
  assert.equal(after.orders[0].payments.length, 1); const payment = after.orders[0].payments[0];
  assert.equal(payment.amount, 300); assert.equal(payment.verificationStatus, "verified"); assert.equal(approved.paymentId, payment.id);
  assert.equal(reconcileCommissionLedger(after, [], new Date()).byOrder.get("proof-order").commissionBase, 300);
  const retry = await s.review(claim); ok(retry);
  assert.equal((await s.readPersistedState()).orders[0].payments.length, 1);
});

test("images are mandatory, amounts are bounded and attachment identity cannot cross orders or owners", async t => {
  const s = await setup(t, state => {
    state.orders.push({ ...structuredClone(state.orders[0]), id: "other-order", orderNo: "SO-OTHER", contactPersonnelId: "other-owner", contactPerson: "其他订单负责人", items: [] });
  });
  const uploaded = await s.upload(); ok(uploaded); const id = uploaded.body.attachment.id;
  const valid = { orderId: "proof-order", amount: 300, time: "2026-11-18T12:00:00+08:00", paymentMethodId: "pm-wechat", evidenceIds: [id] };
  const before = await s.readPersistedState();
  for (const change of [{ evidenceIds: [] }, { evidenceIds: ["/uploads/forged.jpg"] }, { evidenceIds: [id, id] }, { amount: 0 }, { amount: -1 }, { amount: 1000.001 }, { amount: 1001 }, { orderId: "other-order" }]) {
    denied(await s.request("/api/orders/payment-proof/submit", { ...valid, ...change }));
    assert.deepEqual(await s.readPersistedState(), before);
  }
  denied(await s.request("/api/orders/payment-proof/submit", valid, "other-owner"));
  denied(await s.request("/api/orders/payment-proof/submit", valid, "pricing-viewer"));
  ok(await s.request("/api/orders/payment-proof/submit", valid));
  const sameBytes = await s.upload(); ok(sameBytes);
  denied(await s.request("/api/orders/payment-proof/submit", { ...valid, evidenceIds: [sameBytes.body.attachment.id] }));
  assert.equal((await s.readPersistedState()).orders[0].paymentClaims.length, 1, "uploading the same screenshot under a new id must not create a second receipt claim");
});

test("private proof requires authentication and scope; registry and claims cannot be forged through generic writes", async t => {
  const s = await setup(t); const uploaded = await s.upload(); ok(uploaded); const id = uploaded.body.attachment.id;
  const get = token => fetch(`${s.baseUrl}/api/orders/payment-proof/evidence/${id}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal((await get()).status, 401);
  assert.equal((await get(s.tokens["pricing-viewer"])).status, 403);
  const own = await get(s.tokens["pricing-editor"]); assert.equal(own.status, 200);
  assert.match(own.headers.get("cache-control"), /private|no-store/);
  const privateBytes = Buffer.from(await own.arrayBuffer()); assert.equal(privateBytes.subarray(0, 3).toString("hex"), "ffd8ff");
  const encrypted = await readFile(paymentEvidencePath(s.uploadDir, id));
  assert.ok(encrypted.toString().startsWith("payment-evidence$")); assert.notDeepEqual(encrypted, privateBytes);
  assert.equal((await stat(paymentEvidencePath(s.uploadDir, id))).mode & 0o777, 0o600);
  for (const path of [`/uploads/${PAYMENT_EVIDENCE_DIRECTORY}/${id}.bin`, `/uploads/%2epayment-evidence/${id}.bin`]) {
    assert.equal((await fetch(`${s.baseUrl}${path}`)).status, 404);
    assert.equal((await fetch(`${s.baseUrl}${path}`, { headers: { Authorization: `Bearer ${s.tokens["pricing-editor"]}` } })).status, 404);
    const signed = publicVideoDerivativeProxyPath(path, "poster", { secret: "replace_with_stock_pricing_integration_secret" });
    assert.equal((await fetch(`${s.baseUrl}${signed}`)).status, 400);
  }
  ok(await s.request("/api/orders/payment-proof/submit", { orderId: "proof-order", amount: 300, time: "2026-11-18T12:00:00+08:00", paymentMethodId: "pm-wechat", evidenceIds: [id] }));
  assert.equal((await get(s.tokens["finance-reviewer"])).status, 200);
  const state = await s.readPersistedState();
  const full = await s.request("/api/state", undefined, "pricing-admin"); ok(full); assert.equal(full.body.data.paymentEvidenceAttachments, undefined);
  denied(await s.request("/api/state/patch", { patch: { paymentEvidenceAttachments: [] } }, "pricing-admin"));
  denied(await s.request("/api/state/slice?keys=paymentEvidenceAttachments", undefined, "pricing-admin"));
  const forged = structuredClone(state.orders[0]); forged.paymentClaims[0].status = "approved";
  denied(await s.request("/api/state/patch", { patch: { orders: [forged] }, basePatch: { orders: state.orders } }, "pricing-admin"));
  const generic = await s.request("/api/orders/payment", { orderId: "proof-order", action: "add", payment: {
    id: "forged-payment", type: "balance", amount: 300, time: "2026-11-18T12:00:00+08:00", proof: [],
    verificationStatus: "verified", paymentClaimId: forged.paymentClaims[0].id,
  } }); denied(generic);
  assert.deepEqual(await s.readPersistedState(), state);
});

test("rejection preserves proof history, confirms no money and invalidates a stale finance review", async t => {
  const s = await setup(t); ok(await s.submit(300)); const claim = pendingClaim(await s.readPersistedState());
  const d = await s.detail("finance-reviewer"); ok(d);
  denied(await s.review(claim, { decision: "reject", reason: "" }));
  ok(await s.review(claim, { decision: "reject", reason: "凭证金额与实际到账不一致，请重新上传" }));
  const rejected = pendingClaim(await s.readPersistedState()); assert.equal(rejected.status, "rejected"); assert.ok(rejected.rejectionReason);
  assert.equal((await s.readPersistedState()).orders[0].payments.length, 0);
  const stale = await s.request("/api/orders/payment-proof/review", { orderId: "proof-order", claimId: claim.id, expectedVersion: claim.version,
    reviewToken: d.body.reviewToken, decision: "approve" }, "finance-reviewer"); denied(stale);
  const fresh = await s.upload({ image: evidencePng({ width: 9 }) }); ok(fresh);
  const resubmit = await s.request("/api/orders/payment-proof/submit", { orderId: "proof-order", claimId: rejected.id, expectedVersion: rejected.version,
    amount: 200, time: "2026-11-18T12:00:00+08:00", paymentMethodId: "pm-wechat", evidenceIds: [fresh.body.attachment.id] }); ok(resubmit);
  const next = pendingClaim(await s.readPersistedState()); assert.equal(next.id, rejected.id); assert.ok(next.version > rejected.version); assert.equal(next.status, "pending");
  denied(await s.request("/api/orders/payment-proof/review", { orderId: "proof-order", claimId: claim.id, expectedVersion: claim.version, reviewToken: d.body.reviewToken, decision: "approve" }, "finance-reviewer"));
  assert.equal((await s.readPersistedState()).orders[0].payments.length, 0);
});

test("finance approval links the existing statement receipt instead of counting the same collection twice", async t => {
  const s = await setup(t, state => {
    state.orders[0].payments = [{ id: "existing-statement", type: "balance", amount: 300, time: "2026-11-18T12:00:00+08:00",
      channel: "wechat", account: "合成微信收款账户", paymentMethodId: "pm-wechat", recordSource: "statement", statementId: "statement-synthetic", verificationStatus: "pending", proof: [], notes: "导入收款账单" }];
  });
  ok(await s.submit(300)); const claim = pendingClaim(await s.readPersistedState());
  denied(await s.review(claim));
  ok(await s.review(claim, { existingPaymentId: "existing-statement" }));
  const after = await s.readPersistedState(); assert.equal(after.orders[0].payments.length, 1);
  assert.equal(after.orders[0].payments[0].id, "existing-statement"); assert.equal(after.orders[0].payments[0].verificationStatus, "verified");
  assert.equal(pendingClaim(after).paymentId, "existing-statement");
  assert.equal(reconcileCommissionLedger(after, [], new Date()).byOrder.get("proof-order").commissionBase, 300);
});

test("proof approved before bank import can explicitly bind the later statement without creating another collection", async t => {
  const s = await setup(t); ok(await s.submit(1000)); ok(await s.review(pendingClaim(await s.readPersistedState())));
  const before = await s.readPersistedState(); const receipt = before.orders[0].payments[0];
  assert.equal(receipt.externalTransactionNo || "", "");
  const csvText = ["交易时间,交易单号,收支类型,交易金额,付款方,备注",
    "2026-11-18 12:00:00,BANK-LATE-PROOF-001,收入,1000.00,付款凭证合成客户,SO-PROOF-TEST 鱼款"].join("\n");
  const imported = await s.request("/api/finance/statements/import", { siteId: "nanjing", paymentMethodId: "pm-wechat", fileName: "合成后到收款流水.csv", csvText }, "finance-reviewer"); ok(imported);
  assert.equal(imported.body.matchedCount, 0, "same amount or order number alone must not guess a duplicate link");
  const overview = await s.request("/api/finance/overview?siteId=nanjing", undefined, "finance-reviewer"); ok(overview);
  assert.equal(overview.body.statements.length, 1); const statement = overview.body.statements[0];
  assert.equal(statement.matchStatus, "unmatched");
  const candidate = statement.candidates.find(row => row.orderId === "proof-order");
  assert.ok(candidate, "fully paid orders with an unlinked proof receipt must remain match candidates");
  assert.equal(candidate.requiresPaymentSelection, true);
  const noSelection = await s.request("/api/finance/statements/link", { action: "link", statementId: statement.id, orderId: "proof-order" }, "finance-reviewer"); denied(noSelection);
  assert.equal((await s.readPersistedState()).orders[0].payments.length, 1);
  const linked = await s.request("/api/finance/statements/link", { action: "link", statementId: statement.id, orderId: "proof-order", existingPaymentId: receipt.id }, "finance-reviewer"); ok(linked);
  const after = await s.readPersistedState();
  assert.equal(after.orders[0].payments.length, 1);
  assert.equal(after.orders[0].payments[0].id, receipt.id); assert.equal(after.orders[0].payments[0].amount, 1000);
  assert.equal(after.orders[0].payments[0].statementId, statement.id);
  assert.equal(after.orders[0].payments[0].verifiedAt, receipt.verifiedAt); assert.equal(after.orders[0].payments[0].verifiedBy, receipt.verifiedBy);
  assert.equal(pendingClaim(after).paymentId, receipt.id);
  assert.equal(reconcileCommissionLedger(after, [], new Date()).byOrder.get("proof-order").commissionBase, 1000);
  const afterOverview = await s.request("/api/finance/overview?siteId=nanjing", undefined, "finance-reviewer"); ok(afterOverview);
  assert.equal(afterOverview.body.statements[0].matchStatus, "verified"); assert.equal(afterOverview.body.statements[0].matchedPaymentId, receipt.id);
  denied(await s.request("/api/finance/statements/link", { action: "link", statementId: statement.id, orderId: "proof-order", existingPaymentId: receipt.id }, "finance-reviewer"));
  const duplicateImport = await s.request("/api/finance/statements/import", { siteId: "nanjing", paymentMethodId: "pm-wechat", fileName: "重复文件.csv", csvText }, "finance-reviewer"); ok(duplicateImport);
  assert.equal(duplicateImport.body.duplicateFile, true); assert.equal((await s.readPersistedState()).orders[0].payments.length, 1);
});

test("new verified receipts cannot overlap already recorded money; fully paid legacy orders may bind proof without extra money", async t => {
  const s = await setup(t, state => { state.orders[0].items[0].price = 100; });
  ok(await s.submit(100)); const claim = pendingClaim(await s.readPersistedState());
  // A receipt imported/recorded after submission must still be checked at review.
  ok(await s.request("/api/orders/payment", { orderId: "proof-order", action: "add", payment: {
    id: "already-received", type: "balance", amount: 50, time: "2026-11-18T11:00:00+08:00", paymentMethodId: "pm-wechat",
  } }, "finance-reviewer"));
  const before = await s.readPersistedState();
  const overlap = await s.review(claim); denied(overlap); assert.match(overlap.body.error, /超过|重叠|已有|应收/);
  assert.deepEqual(await s.readPersistedState(), before);
  const full = await setup(t, state => { state.orders[0].payments = [{ id: "legacy-full", type: "balance", amount: 1000,
    time: "2026-11-18T11:00:00+08:00", channel: "wechat", account: "合成微信收款账户", verificationStatus: "verified", proof: [] }]; });
  ok(await full.submit(1000)); const fullClaim = pendingClaim(await full.readPersistedState());
  denied(await full.review(fullClaim)); ok(await full.review(fullClaim, { existingPaymentId: "legacy-full" }));
  assert.equal((await full.readPersistedState()).orders[0].payments.length, 1);
  assert.equal((await full.detail()).body.summary.verifiedAmount, 1000);
});

test("approved platform proof is a fallback receipt and later authoritative settlements replace it without double commission", async t => {
  const s = await setup(t, state => Object.assign(state.orders[0], { source: "平台下单", platformOrderNo: "PROOF-PLATFORM-001", douyinOrderNo: "PROOF-PLATFORM-001",
    paymentMethodId: "pm-douyin", paymentMethodName: "抖音", paymentChannel: "douyin", paymentAccount: "抖店账户" }));
  ok(await s.submit(300, { paymentMethodId: "pm-douyin" })); ok(await s.review(pendingClaim(await s.readPersistedState())));
  const state = await s.readPersistedState();
  assert.equal(reconcileCommissionLedger(state, [], new Date()).byOrder.get("proof-order").commissionBase, 300);
  const row = { id: "authoritative-proof-settlement", platform: "douyin", site_id: "nanjing", external_order_no: "PROOF-PLATFORM-001",
    settlement_time: "2026-11-18T14:00:00+08:00", data: { userPaid: 300, preSettlementRefund: 0 } };
  const reconciled = reconcileCommissionLedger(state, [row], new Date());
  assert.equal(reconciled.byOrder.get("proof-order").commissionBase, 300);
  assert.ok(reconciled.diagnostics.some(item => item.code === "PLATFORM_REPLACES_ORDER_PAYMENTS"));
  const zero = reconcileCommissionLedger(state, [{ ...row, data: { userPaid: 0, incomeTotal: 0, preSettlementRefund: 0 } }], new Date());
  assert.equal(zero.byOrder.get("proof-order").commissionBase, 0, "an authoritative zero settlement must not fall back to a screenshot receipt");
});

test("the same screenshot or transaction reference cannot be collected again on a different order", async t => {
  const s = await setup(t, state => {
    state.orders.push({ ...structuredClone(state.orders[0]), id: "second-proof-order", orderNo: "SO-PROOF-SECOND", payments: [], paymentClaims: [] });
  });
  ok(await s.submit(300));
  const secondUpload = await s.upload({ orderId: "second-proof-order" }); ok(secondUpload);
  const before = await s.readPersistedState();
  const second = await s.request("/api/orders/payment-proof/submit", { orderId: "second-proof-order", amount: 200,
    time: "2026-11-18T12:00:00+08:00", paymentMethodId: "pm-wechat", evidenceIds: [secondUpload.body.attachment.id] }); denied(second);
  assert.equal(second.body.code, "PAYMENT_PROOF_DUPLICATE");
  assert.deepEqual(await s.readPersistedState(), before);
  const sameRef = await setup(t, state => {
    state.orders.push({ ...structuredClone(state.orders[0]), id: "other-money-order", orderNo: "SO-MONEY-OTHER", items: [],
      payments: [{ id: "global-payment", type: "balance", amount: 300, time: "2026-11-18T10:00:00+08:00", verificationStatus: "verified",
        channel: "wechat", account: "合成微信收款账户", externalTransactionNo: "GLOBAL-RECEIPT-001", proof: [] }] });
  });
  ok(await sameRef.submit(300, { externalTransactionNo: "GLOBAL-RECEIPT-001" }));
  const refBefore = await sameRef.readPersistedState();
  denied(await sameRef.review(pendingClaim(refBefore)));
  assert.deepEqual(await sameRef.readPersistedState(), refBefore);
});

test("partial pending proof permits shipment and snapshots only the uncovered amount as credit; rejection restores current gap", async t => {
  const s = await setup(t); ok(await s.submit(300)); const claim = pendingClaim(await s.readPersistedState());
  const out = await s.request("/api/shipments/outbound", { orderId: "proof-order", selectedItemIds: ["proof-fish"], shipMethod: "express", carrier: "顺丰", shipDate: "2026-11-19" }); ok(out);
  assert.equal(out.body.shipment.paymentEvidenceSnapshot.pendingProofAmount, 300);
  assert.equal(out.body.shipment.paymentEvidenceSnapshot.creditAmount, 700);
  ok(await s.review(claim, { decision: "reject", reason: "无法核实真实到账，请补充正确付款记录" }));
  const d = await s.detail(); ok(d); assert.equal(d.body.summary.pendingProofAmount, 0); assert.equal(d.body.summary.creditAmount, 1000);
  assert.equal((await s.readPersistedState()).shipments[0].paymentEvidenceSnapshot.creditAmount, 700, "dispatch evidence remains a historical snapshot");
});

test("all order sources ship without proof as automatic credit and legacy verified receipts remain recognized", async t => {
  for (const source of ["私域线上", "平台下单", "闲鱼平台", "微拍堂平台", "线下"]) {
    const gate = shipmentPaymentGate({ source, payments: [] }, 1000);
    assert.equal(gate.canShip, true, source); assert.equal(gate.status, "credit_sale", source); assert.equal(gate.creditAmount, 1000, source);
  }
  assert.equal(shipmentPaymentGate({ source: "平台下单", payments: [{ type: "balance", amount: 1000 }] }, 1000).status, "verified");
  const s = await setup(t); const out = await s.request("/api/shipments/outbound", { orderId: "proof-order", selectedItemIds: ["proof-fish"], shipMethod: "express", carrier: "顺丰", shipDate: "2026-11-19" }); ok(out);
  assert.equal(out.body.shipment.paymentEvidenceSnapshot.creditAmount, 1000);
  for (const path of ["/api/orders/credit-sale/request", "/api/orders/credit-sale/confirm"]) {
    const legacy = await s.request(path, { orderId: "proof-order" }, "pricing-admin"); assert.equal(legacy.response.status, 409);
  }
});

test("concurrent finance approval commits one payment; current account and ownership changes revoke pending upload/review rights", async t => {
  const s = await setup(t); ok(await s.submit(300)); const claim = pendingClaim(await s.readPersistedState());
  const results = await Promise.all([s.review(claim), s.review(claim)]);
  assert.ok(results.some(r => r.response.status === 200)); assert.equal((await s.readPersistedState()).orders[0].payments.length, 1);
  const d = await s.detail("finance-reviewer"); ok(d);
  await s.patchTestPersonnel("finance-reviewer", { accessRole: "staff", permissions: {} });
  denied(await s.request("/api/orders/payment-proof/review", { orderId: "proof-order", claimId: claim.id, expectedVersion: claim.version,
    reviewToken: d.body.reviewToken, decision: "reject", reason: "不应接受已撤权操作" }, "finance-reviewer"));
  await s.patchTestPersonnel("pricing-editor", { visibleSiteIds: ["jiangyin"] });
  denied(await s.upload());
  denied(await s.detail());
});

test("new shipping prepayment remains reviewable after cost decrease and freight difference refund preserves goods commission", async t => {
  const s = await setup(t, state => {
    Object.assign(state.orders[0], { shippingFeeMode: "prepaid", shippingSettlementTiming: "before_shipping", shippingFee: 50 });
    state.shipments = [{ id: "freight-shipment", orderId: "proof-order", status: "shipped", shipMethod: "express", itemStockIds: ["proof-fish"], actualShippingFee: 0 }];
  });
  ok(await s.submit(1050, { purpose: "order", shippingAmount: 50 }));
  const claim = pendingClaim(await s.readPersistedState());
  const fee = await s.request("/api/shipments/actual-shipping-fee", { shipmentId: "freight-shipment", actualShippingFee: 40, expectedActualShippingFee: 0, expectedActualShippingFeeRecordedAt: "" }); ok(fee);
  ok(await s.review(claim));
  let state = await s.readPersistedState();
  assert.equal(state.orders[0].payments[0].shippingAmount, 50);
  assert.equal(reconcileCommissionLedger(state, [], new Date()).byOrder.get("proof-order").commissionBase, 1000);
  const detail = await s.request("/api/orders/shipping-settlement?orderId=proof-order"); ok(detail);
  assert.equal(detail.body.shippingSettlement.toRefund, 10);
  const uploaded = await s.upload({ image: evidencePng({ width: 12 }) }); ok(uploaded);
  const refunded = await s.request("/api/orders/shipping-refund", { orderId: "proof-order", id: "freight-refund-10", amount: 10,
    time: "2026-11-18T12:30:00+08:00", paymentMethodId: "pm-wechat", expectedVersion: detail.body.shippingSettlement.version,
    evidenceIds: [uploaded.body.attachment.id], notes: "合成测试运费退差额" }); ok(refunded);
  assert.equal(refunded.body.payment.refundCategory, "shipping_fee");
  assert.equal(refunded.body.shippingSettlement.toRefund, 0);
  const verify = await s.request("/api/orders/payment", { orderId: "proof-order", action: "verify", paymentId: "freight-refund-10" }, "finance-reviewer"); ok(verify);
  state = await s.readPersistedState();
  assert.equal(reconcileCommissionLedger(state, [], new Date()).byOrder.get("proof-order").commissionBase, 1000);
  denied(await s.request("/api/orders/payment-proof/submit", { orderId: "proof-order", amount: 10, purpose: "shipping_fee", shippingAmount: 10,
    time: "2026-11-18T12:30:00+08:00", paymentMethodId: "pm-wechat", evidenceIds: [uploaded.body.attachment.id] }));
});
