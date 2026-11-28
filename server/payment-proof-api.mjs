import { constants } from "node:fs";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  PAYMENT_EVIDENCE_DIRECTORY, PAYMENT_EVIDENCE_MAX_BYTES, PAYMENT_EVIDENCE_DRAFT_TTL, isPaymentEvidenceId, paymentEvidenceId, paymentEvidencePath,
  paymentEvidenceMetadata, paymentEvidenceFilename, resolvePaymentEvidence, checkPaymentEvidenceQuota,
  evidenceIsBound, evidenceIsExpired, encryptPaymentEvidence, decryptPaymentEvidence, normalizePaymentEvidenceImage,
} from "./payment-evidence.mjs";
import { canSubmitPaymentProof, paymentProofDetail, paymentClaims, planPaymentProofSubmission, planPaymentProofReview } from "./payment-proof-rules.mjs";
import { isOrderBusinessMutationOwner, resolveOrderBusinessOwner } from "./order-mutation-ownership.mjs";
import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const fail = (message, statusCode = 403, code = "PAYMENT_PROOF_FORBIDDEN") => { throw Object.assign(new Error(message), { statusCode, code }); };

export async function cleanupPaymentEvidenceDrafts({ pool, stateId, uploadDir }) {
  const client = await pool.connect(), paths = [];
  try {
    await client.query("BEGIN");
    const state = (await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId])).rows[0]?.data ?? {};
    const records = list(state.paymentEvidenceAttachments);
    const expired = records.filter(record => isPaymentEvidenceId(record.id) && evidenceIsExpired(record));
    const retained = records.filter(record => !expired.includes(record));
    if (expired.length) await client.query("UPDATE app_state SET data = jsonb_set(data, '{paymentEvidenceAttachments}', $2::jsonb, true), updated_at = now() WHERE id = $1", [stateId, JSON.stringify(retained)]);
    const known = new Set(retained.map(record => record.id));
    const files = await readdir(join(uploadDir, PAYMENT_EVIDENCE_DIRECTORY), { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const file of files) {
      const id = file.name.endsWith(".bin") ? file.name.slice(0, -4) : "";
      if (!file.isFile() || !isPaymentEvidenceId(id) || known.has(id)) continue;
      const path = paymentEvidencePath(uploadDir, id), info = await stat(path);
      if (expired.some(record => record.id === id) || info.mtimeMs + PAYMENT_EVIDENCE_DRAFT_TTL < Date.now()) paths.push(path);
    }
    await client.query("COMMIT");
    for (const path of paths) await rm(path, { force: true });
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); console.warn("[payment-evidence] draft cleanup failed", error.code || "unknown"); }
  finally { client.release(); }
}

/** Isolated financial-proof purpose: never served through public /uploads. */
export function createPaymentProofHandler(deps) {
  const { pool, stateId, uploadDir, keyring, readBody, readRawBody, sendJson, refreshAuth, resolveOrder,
    hasPermission, requirePermission, visibleState, amountDue, commissionMutation, createId, createLog,
    limiter, ffmpegPath, ffprobePath, nowInChina } = deps;
  const readState = async (client, lock = false) => (await client.query(`SELECT data FROM app_state WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [stateId])).rows[0]?.data ?? {};
  const readImage = async record => {
    let handle;
    try {
      handle = await open(paymentEvidencePath(uploadDir, record.id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > PAYMENT_EVIDENCE_MAX_BYTES * 2) fail("凭证文件无效，请联系管理员", 409);
      return decryptPaymentEvidence(await handle.readFile(), record, keyring);
    } catch (error) { if (error.statusCode) throw error; fail("凭证文件暂不可用，请重新上传或联系管理员", 409, "PAYMENT_EVIDENCE_FILE_UNAVAILABLE"); }
    finally { await handle?.close(); }
  };
  const assertRead = (req, state, order) => {
    const account = req.auth.account;
    if (!hasPermission(account, "finance", "update") && !(hasPermission(account, "orders", "update") &&
      isOrderBusinessMutationOwner(state, order, account))) fail("仅订单负责人、管理员或财务核验人员可以查看付款凭证");
  };
  const detail = (state, order, req) => ({ ...paymentProofDetail(state, order, req.auth.account, amountDue(order, state.shipments), hasPermission(req.auth.account, "finance", "update")),
    canSubmit: hasPermission(req.auth.account, "orders", "update") && canSubmitPaymentProof(state, order, req.auth.account) });
  const save = (client, state) => client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(state)]);
  const notify = (state, order, claim, req, reviewing) => {
    const now = new Date().toISOString();
    const old = list(state.notifications).map(notice => notice.type === "payment_proof" && notice.claimId === claim.id && notice.status === "pending"
      ? { ...notice, status: "completed", resolvedAt: now, resolution: claim.status } : notice);
    const owner = resolveOrderBusinessOwner(state, order);
    const recipients = reviewing ? owner ? [owner] : [] : list(state.personnel).filter(person =>
      isPersonnelAccountEnabled(person) && hasPermission(person, "finance", "update") && list(visibleState(state, person).orders).some(item => item.id === order.id));
    return [...recipients.map(person => ({ id: createId("notice"), type: "payment_proof", status: reviewing ? "completed" : "pending",
      title: reviewing ? claim.status === "approved" ? "付款凭证核验通过" : "付款凭证已驳回，请核对补款" : "付款凭证待财务核验",
      message: `订单「${order.orderNo}」付款申报 ¥${Number(claim.amount).toFixed(2)}${claim.rejectionReason ? `；原因：${claim.rejectionReason}` : ""}`,
      createdAt: now, createdBy: req.auth.account.username, readAt: "", recipientUsername: person.username,
      recipientName: person.name || person.username, siteId: order.siteId, orderId: order.id, orderNo: order.orderNo,
      claimId: claim.id, notificationRole: reviewing ? "requester" : "approver", resolution: reviewing ? claim.status : "" })), ...old];
  };

  return async function handlePaymentProof(req, res, url) {
    const prefix = "/api/orders/payment-proof/";
    if (!url.pathname.startsWith(prefix)) return false;
    res.setHeader("Cache-Control", "no-store, private");
    let client = null, release = null, createdPath = "", record = null, commitAttempted = false;
    try {
      const suffix = url.pathname.slice(prefix.length);
      if (suffix === "evidence" && req.method === "POST") {
        const orderId = text(url.searchParams.get("orderId"));
        const preflight = await readState(pool); refreshAuth(req, preflight);
        const { order } = resolveOrder(req, preflight, orderId);
        requirePermission(req, "orders", "update");
        if (!canSubmitPaymentProof(preflight, order, req.auth.account)) fail("仅当前订单负责人或管理员可以上传付款凭证");
        if (!keyring) fail("凭证安全存储暂不可用，请联系管理员", 503);
        const mime = text(req.headers["content-type"]).split(";")[0].toLowerCase();
        if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) fail("仅支持 JPG、PNG、WebP 图片", 415);
        if (Number(req.headers["content-length"] || 0) > PAYMENT_EVIDENCE_MAX_BYTES) fail("每张付款凭证不能超过10 MB", 413);
        checkPaymentEvidenceQuota(preflight.paymentEvidenceAttachments, req.auth.account.id, orderId, 0);
        release = await limiter.acquire();
        const image = await normalizePaymentEvidenceImage(await readRawBody(req, PAYMENT_EVIDENCE_MAX_BYTES), mime, { ffmpegPath, ffprobePath });
        client = await pool.connect(); await client.query("BEGIN");
        const state = await readState(client, true); refreshAuth(req, state);
        const current = resolveOrder(req, state, orderId).order; requirePermission(req, "orders", "update");
        if (!canSubmitPaymentProof(state, current, req.auth.account)) fail("订单负责人或权限已变化，请重新操作");
        const registry = list(state.paymentEvidenceAttachments);
        checkPaymentEvidenceQuota(registry, req.auth.account.id, orderId, image.length);
        record = { id: paymentEvidenceId(), orderId, uploaderPersonnelId: req.auth.account.id, uploaderUsername: req.auth.account.username,
          originalName: paymentEvidenceFilename(req.headers["x-file-name"]), mime: "image/jpeg", size: image.length,
          createdAt: new Date().toISOString(), boundClaimIds: [], sha256: createHash("sha256").update(image).digest("hex") };
        await mkdir(join(uploadDir, PAYMENT_EVIDENCE_DIRECTORY), { recursive: true, mode: 0o700 });
        createdPath = paymentEvidencePath(uploadDir, record.id);
        const file = await open(createdPath, "wx", 0o600);
        try { await file.writeFile(encryptPaymentEvidence(image, record, keyring)); await file.sync(); } finally { await file.close(); }
        await save(client, { ...state, paymentEvidenceAttachments: [...registry, record] });
        commitAttempted = true; await client.query("COMMIT");
        sendJson(req, res, 200, { ok: true, attachment: paymentEvidenceMetadata(record) });
      } else if (suffix.startsWith("evidence/") && ["GET", "DELETE"].includes(req.method)) {
        const deleting = req.method === "DELETE";
        client = await pool.connect(); await client.query("BEGIN");
        const state = await readState(client, deleting); refreshAuth(req, state);
        const evidence = resolvePaymentEvidence(state.paymentEvidenceAttachments, suffix.slice("evidence/".length));
        const { order } = resolveOrder(req, state, evidence.orderId);
        const own = evidence.uploaderPersonnelId === req.auth.account.id && evidence.uploaderUsername === req.auth.account.username;
        if (deleting || !evidenceIsBound(evidence)) { if (!own) fail("只能查看或删除本人上传的凭证草稿"); if (!deleting) assertRead(req, state, order); }
        else assertRead(req, state, order);
        if (deleting) {
          if (evidenceIsBound(evidence)) fail("已提交的付款凭证不可删除或替换", 409);
          await save(client, { ...state, paymentEvidenceAttachments: list(state.paymentEvidenceAttachments).filter(item => item.id !== evidence.id) });
          await client.query("COMMIT"); await rm(paymentEvidencePath(uploadDir, evidence.id), { force: true });
          sendJson(req, res, 200, { ok: true });
        } else {
          if (evidenceIsExpired(evidence)) fail("凭证草稿已过期，请重新上传", 410);
          const image = await readImage(evidence); await client.query("COMMIT");
          res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": image.length, "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=\"payment-evidence.jpg\"", "Cross-Origin-Resource-Policy": "same-origin" }); res.end(image);
        }
      } else if (suffix === "queue" && req.method === "GET") {
        const state = await readState(pool); refreshAuth(req, state); requirePermission(req, "finance", "update");
        const siteId = text(url.searchParams.get("siteId"));
        const scoped = visibleState(state, req.auth.account);
        const offset = Math.max(0, Math.floor(Number(url.searchParams.get("offset")) || 0));
        const limit = Math.min(100, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 50)));
        const rows = list(scoped.orders).filter(order => (!siteId || siteId === "all" || order.siteId === siteId) && paymentClaims(order).some(claim => claim.status === "pending"))
          .map(order => { const pending = paymentClaims(order).filter(claim => claim.status === "pending"); return { orderId: order.id, orderNo: order.orderNo, siteId: order.siteId,
            date: order.date, contactPerson: order.contactPerson, customerName: list(state.customers).find(customer => customer.id === order.customerId)?.name || "",
            pendingCount: pending.length, pendingAmount: Number(pending.reduce((sum, claim) => sum + claim.amount, 0).toFixed(2)) }; });
        sendJson(req, res, 200, { ok: true, items: rows.slice(offset, offset + limit), total: rows.length, offset, limit });
      } else if (suffix === "detail" && req.method === "GET") {
        const state = await readState(pool); refreshAuth(req, state);
        const { order } = resolveOrder(req, state, url.searchParams.get("orderId")); assertRead(req, state, order);
        sendJson(req, res, 200, { ok: true, ...detail(state, order, req) });
      } else if (["submit", "review"].includes(suffix) && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        client = await pool.connect(); await client.query("BEGIN");
        const state = await readState(client, true); refreshAuth(req, state);
        const { order, orders } = resolveOrder(req, state, body.orderId);
        const reviewing = suffix === "review";
        requirePermission(req, reviewing ? "finance" : "orders", "update");
        if (reviewing && body.decision === "approve") {
          const claim = paymentClaims(order).find(item => item.id === body.claimId);
          if (claim?.status === "pending") for (const attachment of list(claim.evidenceAttachments)) await readImage(resolvePaymentEvidence(state.paymentEvidenceAttachments, attachment.id));
        }
        const now = nowInChina();
        const result = reviewing ? planPaymentProofReview(order, req.auth.account, body, { now, createPaymentId: () => createId("pay"), amountDue: amountDue(order, state.shipments), state })
          : planPaymentProofSubmission(state, order, req.auth.account, body, { amountDue: amountDue(order, state.shipments), now, createId: () => createId("payment-claim") });
        if (result.unchanged) { await client.query("ROLLBACK"); sendJson(req, res, 200, { ok: true, order, orders: visibleState(state, req.auth.account).orders, ...detail(state, order, req) }); return true; }
        const operationLog = createLog(req, "订单管理", reviewing ? "付款凭证核验" : "提交付款凭证", `订单「${order.orderNo}」付款凭证 ¥${result.claim.amount.toFixed(2)}${reviewing ? result.claim.status === "approved" ? " 核验通过" : " 已驳回" : " 待财务核验"}`);
        const ids = new Set(list(result.evidence).map(item => item.id));
        const nextState = { ...state, orders: orders.map(item => item.id === order.id ? result.order : item),
          paymentEvidenceAttachments: list(state.paymentEvidenceAttachments).map(item => ids.has(item.id) ? { ...item, boundClaimIds: [...new Set([...list(item.boundClaimIds), result.claim.id])] } : item),
          paymentEvidenceAudits: [...list(state.paymentEvidenceAudits), { id: createId("payment-proof-audit"), orderId: order.id, claimId: result.claim.id, action: suffix,
            operator: req.auth.account.username, time: now, before: paymentClaims(order).find(item => item.id === result.claim.id) || null, after: result.claim,
            paymentsBefore: order.payments, paymentsAfter: result.order.payments }],
          operationLogs: [operationLog, ...list(state.operationLogs)], notifications: notify(state, result.order, result.claim, req, reviewing) };
        if (reviewing && result.claim.paymentId) {
          const selected = result.order.payments.find(payment => payment.id === result.claim.paymentId);
          if (selected?.statementId) await client.query(`UPDATE finance_payment_statements SET match_status = 'verified', verified_at = now(), verified_by = $3 WHERE id = $1 AND state_id = $2`, [selected.statementId, stateId, req.auth.account.username]);
        }
        await save(client, await commissionMutation(client, state, nextState)); await client.query("COMMIT");
        sendJson(req, res, 200, { ok: true, order: result.order, orders: visibleState(nextState, req.auth.account).orders, operationLog, ...detail(nextState, result.order, req) });
      } else fail("付款凭证接口不存在", 404);
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      if (createdPath) {
        let absent = !commitAttempted;
        if (commitAttempted) try { absent = !list((await readState(pool)).paymentEvidenceAttachments).some(item => item.id === record.id); } catch { /* Keep private file after uncertain COMMIT. */ }
        if (absent) await rm(createdPath, { force: true }).catch(() => undefined);
      }
      const status = error.statusCode || 400;
      sendJson(req, res, status, { ok: false, code: error.code, error: status >= 500 ? "付款凭证服务暂不可用，请稍后重试" : error.message });
    } finally { client?.release(); release?.(); }
    return true;
  };
}
