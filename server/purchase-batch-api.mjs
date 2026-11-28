import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertReceivedProcurementUnchanged } from "./purchase-batch-receiving-rules.mjs";
import { preparePurchaseProcurement } from "./purchase-batch-costing-rules.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => typeof value === "string" ? value.trim() : "";
const fail = (message, statusCode = 400, code = "BATCH_COSTING_INVALID") => { throw Object.assign(new Error(message), { statusCode, code }); };
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const fields = ["batchNo", "supplier", "arrivalDate", "notes", "lossCount", "lossProof", "bioFee", "shippingFee"];
const protectedFields = ["procurement", "costingRevision", "totalCost", "costingMutations", "receiving"];
function required(value, label, max = 120) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(`${label}不能为空，且不能超过 ${max} 字`);
  return value.trim();
}
function money(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9 || Math.abs(value * 100 - Math.round(value * 100)) > 0.0001) fail(`${label}须为非负金额，最多两位小数`);
  return Math.round(value * 100) / 100;
}
function moneyFromCents(value, label) {
  const amount = value / 100;
  if (!Number.isSafeInteger(value) || value < 0 || Math.round(amount * 100) !== value) {
    fail(`${label}超出可准确保存到分的金额范围，请核对采购单价和数量`, 400, "BATCH_COSTING_MONEY_PRECISION");
  }
  return amount;
}
function digest(value) {
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, canonical(v[key])])) : v;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function assertPurchaseBatchCostingPatch(current, next, changedKeys = []) {
  if (!changedKeys.includes("batches")) return;
  const before = new Map(list(current.batches).map(batch => [batch.id, batch]));
  const nextIds = new Set(list(next.batches).map(batch => batch.id));
  if (list(current.batches).some(batch => batch.receiving?.receipts?.length && !nextIds.has(batch.id))) fail("已有接收记录的批次不能删除", 409, "BATCH_RECEIVING_SOURCE_LOCKED");
  for (const batch of list(next.batches)) {
    const old = before.get(batch.id);
    if (protectedFields.some(key => !isDeepStrictEqual(old?.[key], batch[key]))) fail("采购清单、装箱与分摊结果须通过采购批次专用页面保存，请刷新后重试", 409, "BATCH_COSTING_DEDICATED_REQUIRED");
    // Legacy rows also need the dedicated revision check. Otherwise an older
    // client can change a revision-0 batch behind an already-open editor and
    // that editor can silently overwrite it on its first dedicated save.
    const strip = record => Object.fromEntries(Object.entries(record).filter(([key]) => changedKeys.includes("stock") && ["stockedCount", "lossCount", "arrivalLossCount"].includes(key) ? false : true));
    if (!old || !isDeepStrictEqual(strip(old), strip(batch))) fail("批次新增和资料修改须通过采购批次专用页面保存，请刷新后重试", 409, "BATCH_COSTING_DEDICATED_REQUIRED");
  }
}

export function createPurchaseBatchHandler({ pool, stateId, readBody, sendJson, refreshAuth, requireSite,
  requirePermission, hasPermission, normalizeSiteId, todayInChina, externalizeDataUrls, maxOperationLogs = 1000 }) {
  return async (req, res, url) => {
    if (url.pathname !== "/api/batches/save") return false;
    res.setHeader("Cache-Control", "no-store, private");
    let client;
    try {
      if (req.method !== "POST") fail("不支持的请求方式", 405);
      const raw = await readBody(req, 16 * 1024 * 1024);
      let input;
      try { input = JSON.parse(raw); } catch { fail("请求内容不是有效 JSON"); }
      if (!input || Array.isArray(input) || typeof input !== "object" || Object.keys(input).some(key => !["siteId", "batchId", "expectedRevision", "expectedLossCount", "clientMutationId", "mode", "batch", "procurement"].includes(key))) fail("批次请求字段无效");
      const siteId = required(input.siteId, "场地"), batchId = required(input.batchId, "批次编号");
      const mutationId = required(input.clientMutationId, "提交编号");
      if (siteId === "all" || !/^[A-Za-z0-9_-]{8,120}$/.test(mutationId)) fail("请选择具体场地并重新打开批次编辑");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail("批次版本无效");
      if (!["legacy", "draft", "confirm"].includes(input.mode)) fail("保存方式无效");
      const basic = input.batch;
      if (!basic || Array.isArray(basic) || typeof basic !== "object" || Object.keys(basic).some(key => !fields.includes(key))) fail("批次资料字段无效");
      const batchNo = required(basic.batchNo, "批次号"), supplier = required(basic.supplier, "供应商", 300);
      const arrivalDate = required(basic.arrivalDate, "到货日期", 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(arrivalDate) || !Number.isFinite(Date.parse(arrivalDate)) || new Date(arrivalDate).toISOString().slice(0, 10) !== arrivalDate || arrivalDate > todayInChina()) fail("到货日期须为有效日期，且不能晚于今天");
      if (basic.notes != null && (typeof basic.notes !== "string" || basic.notes.length > 6000)) fail("备注最多 6000 字");
      if (basic.lossCount !== undefined && (!Number.isSafeInteger(basic.lossCount) || basic.lossCount < 0 || basic.lossCount > 1000000)) fail("报损数量须为非负整数");
      if (basic.lossProof !== undefined && (!Array.isArray(basic.lossProof) || basic.lossProof.length > 30 || basic.lossProof.some(url => typeof url !== "string" || url.length > 3e6 || !/^(?:\/uploads\/|https?:\/\/|data:image\/(?:jpeg|png|webp);base64,)/.test(url)))) fail("报损凭证无效，最多 30 张图片");
      const requestDigest = digest(input);
      // Upload processing precedes the state lock. The locked check below remains
      // authoritative if the account's permissions change while uploading.
      if (!["create", "update"].some(action => hasPermission(req.auth?.account, "batches", action))) requirePermission(req, "batches", "update");
      const media = externalizeDataUrls ? await externalizeDataUrls({ lossProof: basic.lossProof ?? [] }) : { lossProof: basic.lossProof ?? [] };
      client = await pool.connect();
      await client.query("BEGIN");
      const row = (await client.query(`SELECT data -> 'personnel' AS personnel, data -> 'sites' AS sites,
        data -> 'batches' AS batches, data -> 'products' AS products,
        data -> 'operationLogs' AS "operationLogs",
        (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s->'id','batchId',s->'batchId','inDate',s->'inDate')), '[]'::jsonb)
          FROM jsonb_array_elements(COALESCE(data->'stock','[]'::jsonb)) s WHERE s->>'batchId'=$2) AS purchase_batch_stock
        FROM app_state WHERE id=$1 FOR UPDATE`, [stateId, batchId])).rows[0];
      if (!row) fail("系统数据暂不可用", 503);
      const state = { personnel: list(row.personnel), sites: list(row.sites), batches: list(row.batches), products: list(row.products) };
      refreshAuth(req, state);
      requireSite(req, state, siteId);
      const matches = state.batches.filter(batch => text(batch.id) === batchId);
      if (matches.length > 1) fail("批次编号不唯一，请联系管理员", 409);
      const current = matches[0];
      if (current && normalizeSiteId(current.siteId) !== siteId) fail("批次不存在或不属于当前场地", 404, "BATCH_NOT_FOUND");
      requirePermission(req, "batches", current ? "update" : "create");
      const actor = req.auth.account.username;
      const replay = list(current?.costingMutations).find(entry => entry.id === mutationId);
      if (replay) {
        if (replay.digest !== requestDigest || replay.operator !== actor) fail("该提交编号已用于其他内容，请重新打开编辑", 409, "BATCH_COSTING_IDEMPOTENCY_CONFLICT");
        await client.query("COMMIT"); sendJson(req, res, 200, { ok: true, batch: current, replayed: true }); return true;
      }
      const revision = Number(current?.costingRevision ?? 0);
      if (revision !== input.expectedRevision) fail("批次已被其他人修改，请重新打开后再保存", 409, "BATCH_COSTING_VERSION_CONFLICT");
      // Inventory losses update this derived counter independently of costing
      // revisions. Only an explicit, separately checked edit may replace it.
      if (current && own(basic, "lossCount") && (!Number.isSafeInteger(input.expectedLossCount) || input.expectedLossCount < 0 || input.expectedLossCount !== Number(current.lossCount ?? 0))) {
        fail("批次报损数量已变化，请重新打开核对；保存成本时无需重复提交报损数量", 409, "BATCH_LOSS_COUNT_CONFLICT");
      }
      if (current && text(current.batchNo) !== batchNo) fail("已有批次号不能修改");
      if (state.batches.some(batch => batch.id !== batchId && normalizeSiteId(batch.siteId) === siteId && text(batch.batchNo) === batchNo)) fail("该场地已有相同批次号，请更换批次号", 409, "BATCH_NUMBER_CONFLICT");
      const earliest = [...list(row.purchase_batch_stock).map(stock => text(stock.inDate)), ...list(current?.receiving?.receipts).map(receipt => text(receipt.date))].filter(Boolean).sort()[0];
      if (earliest && arrivalDate > earliest) fail("到货日期不能晚于该批次最早接收或入库日期");
      if (input.mode === "legacy" && (!current || current.procurement)) fail("采购明细批次须通过采购清单页面保存", 409);
      if (current?.procurement?.status === "confirmed" && input.mode !== "confirm") fail("已确认的批次须保存并重新分摊，不能退回草稿", 409, "BATCH_COSTING_CONFIRMED_REQUIRED");
      const now = new Date().toISOString();
      const next = { ...(current ?? {}), id: batchId, siteId, batchNo, supplier, arrivalDate,
        notes: basic.notes ?? current?.notes ?? "", createdAt: current ? current.createdAt : now,
        ...(!current ? { receiving: { schemaVersion: 1, revision: 0, receipts: [] } } : {}),
        lossCount: basic.lossCount ?? current?.lossCount ?? 0,
        lossProof: own(basic, "lossProof") ? media.lossProof : current?.lossProof ?? [],
        stockedCount: current?.stockedCount ?? 0, commissionMultiplier: 100, costingRevision: revision + 1 };
      if (input.mode === "legacy") {
        next.bioFee = money(basic.bioFee ?? current.bioFee ?? 0, "生物费用");
        next.shippingFee = money(basic.shippingFee ?? current.shippingFee ?? 0, "运输费用");
        next.totalCost = Math.round((next.bioFee + next.shippingFee) * 100) / 100;
      } else {
        next.procurement = preparePurchaseProcurement(input.procurement, { current: current?.procurement, products: state.products,
          confirmed: input.mode === "confirm", operator: actor, now });
        if (input.mode === "confirm") {
          const totals = next.procurement.allocation.totals;
          next.bioFee = moneyFromCents(totals.purchaseCents, "生物费用"); next.shippingFee = moneyFromCents(totals.internationalFreightCents, "运输费用");
          next.totalCost = moneyFromCents(totals.totalCents, "采购总成本");
        } else {
          next.bioFee = current?.bioFee ?? 0; next.shippingFee = current?.shippingFee ?? 0;
          if (current && (!current.procurement || Number.isFinite(current.totalCost))) next.totalCost = current.totalCost ?? Math.round((next.bioFee + next.shippingFee) * 100) / 100;
          else delete next.totalCost;
        }
      }
      assertReceivedProcurementUnchanged(current, next);
      if ((!current || current.receiving?.schemaVersion === 1) && own(basic, "lossCount") && basic.lossCount !== Number(current?.lossCount || 0)) fail("已接收批次的损耗数量由单鱼损耗记录计算，不能直接修改汇总数量", 409, "BATCH_RECEIVING_SOURCE_LOCKED");
      next.costingMutations = [...list(current?.costingMutations), { id: mutationId, digest: requestDigest, operator: actor, revision: next.costingRevision, time: now }].slice(-50);
      const amount = batch => Number.isFinite(batch?.totalCost) ? batch.totalCost : Number(batch?.bioFee || 0) + Number(batch?.shippingFee || 0);
      const details = input.mode === "confirm" ? `采购 ${next.procurement.allocation.totals.quantity} 条，${next.procurement.boxes.length} 箱；采购成本 ¥${amount(current).toFixed(2)} → ¥${amount(next).toFixed(2)}；费用 ${JSON.stringify(next.procurement.fees)}；税金权重 ${next.procurement.lines.map(line => `${line.productName}(${line.id}) ${line.taxWeightPercent}%`).join("、")}`
        : input.mode === "draft" ? "保存采购与装箱草稿，原正式成本不变" : `修改批次资料，成本 ¥${amount(current).toFixed(2)} → ¥${amount(next).toFixed(2)}`;
      const operationLog = { id: `log-${randomUUID()}`, time: now, operator: actor, module: "采购批次", action: current ? "修改记录" : "新增记录",
        detail: `批次「${batchNo}」第 ${next.costingRevision} 版：${details}` };
      const batches = current ? state.batches.map(batch => batch.id === batchId ? next : batch) : [...state.batches, next];
      const logs = [operationLog, ...list(row.operationLogs)].slice(0, maxOperationLogs);
      await client.query("UPDATE app_state SET data = jsonb_set(jsonb_set(data, '{batches}', $2::jsonb, true), '{operationLogs}', $3::jsonb, true), updated_at = now() WHERE id = $1", [stateId, JSON.stringify(batches), JSON.stringify(logs)]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, batch: next, operationLog, replayed: false });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error.statusCode || 500, { ok: false, code: error.code || "BATCH_COSTING_UNAVAILABLE",
        error: error.statusCode ? error.message : "采购批次保存失败，请稍后重试" });
    } finally { client?.release(); }
    return true;
  };
}
