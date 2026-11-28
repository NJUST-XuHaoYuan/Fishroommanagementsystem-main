import { normalizeMaintenanceMedia } from "./daily-log-save-rules.mjs";
import { assertMaintenanceExpectedItems, findMaintenanceMutationLog, resolveMaintenanceDeltaByIds, withMaintenanceMutationMetadata } from "./maintenance-save-rules.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const fail = (message, statusCode = 400, code = "STOCK_LOSS_INVALID") => { throw Object.assign(new Error(message), { statusCode, code }); };
const id = value => { const result = text(value); if (!result || result.length > 160) fail("请选择有效的损耗记录"); return result; };
const delta = (stockUpdates = [], lossRecordUpdates = [], bioRecordUpdates = [], operationLog = null) => ({ stockUpdates, lossRecordUpdates, bioRecordUpdates, batchUpdates: [], operationLog });

export function normalizeLossReasonRequest(body = {}) {
  if (typeof body.reason !== "string" || !body.reason.trim() || body.reason.trim().length > 2000) fail("请填写损耗原因，最多2000字");
  if (typeof body.expectedReason !== "string") fail("缺少当前原因，请刷新记录后重试", 409, "LOSS_REASON_STALE");
  return { recordId: id(body.recordId), reason: body.reason.trim(), expectedReason: body.expectedReason.trim() };
}

function lossBioText(record, supplemental = false) {
  return `${supplemental ? "损耗原因补充" : "损耗"}${record.reason ? `：${record.reason}` : ""}${record.relatedOrderNo ? `。关联订单：${record.relatedOrderNo}，请在订单详情中退商品并按实际情况填写退款金额` : ""}`;
}

/** Loss-specific writes avoid loading the large biological and operation history into Node. */
export function createStockLossService(deps) {
  const { pool, stateId, readBody, sendJson, refreshAuth, requireSite, hasPermission, requirePermission,
    operatorFor, createId, findTank, normalizeSite, shippedIdsFor, isInTank, refreshBatches, findOrder,
    sanitizeDelta, today, nowLocal, maxOperationLogs = 10000 } = deps;
  const authorizeSite = (req, state, siteId) => requireSite(req, state, normalizeSite(siteId), "不能操作未授权场地的损耗记录");
  async function writeSmall(client, key, value) {
    if (!["stock", "batches"].includes(key)) throw new Error("Unexpected loss field");
    await client.query(`UPDATE app_state SET data=jsonb_set(data,'{${key}}',$2::jsonb,true), updated_at=now() WHERE id=$1`, [stateId, JSON.stringify(value)]);
  }
  async function append(client, key, records) {
    if (!["bioRecords", "lossRecords"].includes(key)) throw new Error("Unexpected loss collection");
    await client.query(`UPDATE app_state SET data=jsonb_set(data,'{${key}}',COALESCE(data -> '${key}','[]'::jsonb) || $2::jsonb,true), updated_at=now() WHERE id=$1`, [stateId, JSON.stringify(records)]);
  }
  async function audit(client, operationLog) {
    await client.query(`UPDATE app_state SET data=jsonb_set(data,'{operationLogs}',(
      SELECT COALESCE(json_agg(entry ORDER BY ordering),'[]'::json)::jsonb FROM (
        SELECT $2::jsonb AS entry, 0::bigint AS ordering UNION ALL
        SELECT operation_row.item, operation_row.ordinality FROM jsonb_array_elements(COALESCE(data -> 'operationLogs','[]'::jsonb))
          WITH ORDINALITY AS operation_row(item,ordinality) WHERE operation_row.ordinality <= $3
      ) AS audit_rows),true), updated_at=now() WHERE id=$1`, [stateId, JSON.stringify(operationLog), maxOperationLogs - 1]);
  }
  async function linkedBio(client, recordIds) {
    if (!recordIds.length) return [];
    return list((await client.query(`SELECT COALESCE((SELECT json_agg(item) FROM jsonb_array_elements(COALESCE(data -> 'bioRecords','[]'::jsonb)) AS records(item)
      WHERE item ->> 'id' = ANY($2::text[])), '[]'::json) AS loss_linked_bio_records FROM app_state WHERE id=$1`, [stateId, recordIds])).rows[0]?.loss_linked_bio_records);
  }
  async function replaceByIndex(client, key, index, record) {
    if (!["stock", "lossRecords", "bioRecords"].includes(key) || !Number.isSafeInteger(index) || index < 0) throw new Error("Invalid loss update target");
    await client.query(`UPDATE app_state SET data=jsonb_set(data,ARRAY['${key}',$2::text],$3::jsonb,false),updated_at=now() WHERE id=$1`, [stateId, String(index), JSON.stringify(record)]);
  }

  async function saveLoss({ client, req, preparedMutation }) {
    const { change, clientMutationId, digest } = preparedMutation;
    const operator = operatorFor(req);
    await client.query("SELECT 1 FROM app_state WHERE id=$1 FOR UPDATE", [stateId]);
    const row = (await client.query(`SELECT data -> 'sites' AS sites, data -> 'personnel' AS personnel, data -> 'tankGroups' AS tank_groups,
      data -> 'stock' AS stock, data -> 'batches' AS batches, data -> 'products' AS products,
      data -> 'orders' AS orders, data -> 'shipments' AS shipments,
      COALESCE((SELECT json_agg(item) FROM jsonb_array_elements(COALESCE(data -> 'operationLogs','[]'::jsonb)) AS records(item)
        WHERE item ->> 'operator'=$2 AND item ->> 'clientMutationId'=$3), '[]'::json) AS loss_mutation_logs,
      COALESCE((SELECT json_agg(item) FROM jsonb_array_elements(COALESCE(data -> 'lossRecords','[]'::jsonb)) AS records(item)
        WHERE item ->> 'stockItemId'=ANY($4::text[])), '[]'::json) AS loss_matching_records
      FROM app_state WHERE id=$1`, [stateId, operator, clientMutationId, change.itemIds])).rows[0] ?? {};
    const state = { sites: list(row.sites), personnel: list(row.personnel), tankGroups: list(row.tank_groups), stock: list(row.stock), batches: list(row.batches),
      products: list(row.products), orders: list(row.orders), shipments: list(row.shipments), operationLogs: list(row.loss_mutation_logs), lossRecords: list(row.loss_matching_records), bioRecords: [] };
    refreshAuth(req, state); requirePermission(req, "daily", "delete"); requirePermission(req, "lossRecords", "create");
    const targets = state.stock.filter(item => change.itemIds.includes(text(item.id)));
    if (targets.length !== change.itemIds.length || new Set(targets.map(item => text(item.id))).size !== targets.length) fail("库存鱼已变化，请重新核对选鱼", 409, "MAINTENANCE_STALE");
    for (const item of targets) authorizeSite(req, state, findTank(state, item.subTankId)?.group?.siteId ?? item.siteId);
    const replay = findMaintenanceMutationLog({ operationLogs: state.operationLogs, operator, clientMutationId, digest });
    if (replay) {
      state.bioRecords = await linkedBio(client, replay.deltaIds.bioRecordUpdateIds);
      return { ok: true, idempotent: true, ...sanitizeDelta(state, resolveMaintenanceDeltaByIds(state, replay.deltaIds), req.auth.account), operationLog: replay.operationLog };
    }
    assertMaintenanceExpectedItems({ mode: "loss", itemIds: change.itemIds, expectedItems: change.expectedItems, currentItems: state.stock });
    const shipped = shippedIdsFor(state);
    if (targets.some(item => !isInTank(item, shipped))) fail("已损耗、已出库或移缸在途的鱼不能登记损耗", 409, "MAINTENANCE_STALE");
    if (state.lossRecords.length) fail("所选鱼已有损耗记录，请核对后再操作", 409, "STOCK_ALREADY_LOST");
    const date = text(change.lossDate);
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date > today()) fail("请选择不晚于今天的有效损耗日期");
    if (targets.some(item => item.inDate && date < item.inDate)) fail("损耗日期不能早于入库日期");
    const proof = normalizeMaintenanceMedia(change.lossProof, "损耗照片凭证");
    if (!proof.length || proof.some(url => !/\.(?:jpe?g|png|webp|gif|heic|heif|avif)(?:[?#]|$)/i.test(url))) fail("请上传有效的损耗照片凭证");
    const reason = text(change.lossReason), createdAt = new Date().toISOString();
    const lossRecordUpdates = [], bioRecordUpdates = [];
    for (const item of targets) {
      const tank = findTank(state, item.subTankId), relatedOrder = findOrder(state, item.id);
      const record = { id: createId("loss"), siteId: normalizeSite(tank?.group?.siteId ?? item.siteId), stockItemId: item.id, date, reason, proofPhotos: proof, operator, createdAt,
        sourceBioRecordId: createId("bio"), fishCode: text(item.code), productName: text(state.products.find(product => product.id === item.productId)?.name),
        subTankId: item.subTankId, tankGroupId: tank?.group?.id ?? "", tankGroupName: tank?.group?.name ?? "", subTankName: tank?.subTank?.name ?? "", tankLocation: tank?.group?.location ?? "",
        tankName: tank ? `${tank.group.name} / ${tank.subTank.name}` : `已删除缸位（${item.subTankId || "无缸位ID"}）`, ...(relatedOrder ? { relatedOrderNo: relatedOrder.orderNo } : {}) };
      lossRecordUpdates.push(record);
      bioRecordUpdates.push({ id: record.sourceBioRecordId, siteId: record.siteId, stockItemId: item.id, date, text: lossBioText(record), photos: proof, videos: [],
        sourceType: "stockLoss", sourceLossRecordId: record.id, operator, tankGroupId: record.tankGroupId, subTankId: record.subTankId,
        tankGroupName: record.tankGroupName, subTankName: record.subTankName, tankLocation: record.tankLocation });
    }
    const nextStock = state.stock.map(item => change.itemIds.includes(text(item.id)) ? { ...item, lost: true, lossDate: date, lossReason: reason, lossProof: proof } : item);
    const stockUpdates = nextStock.filter(item => change.itemIds.includes(text(item.id)));
    const nextBatches = refreshBatches(state.batches, nextStock), affectedBatches = new Set(targets.map(item => item.batchId));
    const batchUpdates = nextBatches.filter(batch => affectedBatches.has(batch.id));
    const operationLog = withMaintenanceMutationMetadata({ id: createId("log"), time: createdAt, operator, module: "日常管理", action: "删除记录",
      detail: `登记损耗 ${targets.length} 条${reason ? `：${reason}` : ""}`, maintenanceSiteIds: [...new Set(lossRecordUpdates.map(record => record.siteId))] },
      { clientMutationId, digest, delta: { stockUpdates, batchUpdates, bioRecordUpdates, lossRecordUpdates } });
    await writeSmall(client, "stock", nextStock);
    if (batchUpdates.length) await writeSmall(client, "batches", nextBatches);
    await append(client, "bioRecords", bioRecordUpdates);
    await append(client, "lossRecords", lossRecordUpdates);
    await audit(client, operationLog);
    return { ok: true, idempotent: false, ...sanitizeDelta({ ...state, stock: nextStock, batches: nextBatches, lossRecords: lossRecordUpdates, bioRecords: bioRecordUpdates },
      { stockUpdates, batchUpdates, bioRecordUpdates, lossRecordUpdates }, req.auth.account), operationLog };
  }

  async function handleReason(req, res, url) {
    if (url.pathname !== "/api/stock-loss-records/reason") return false;
    let client;
    try {
      if (req.method !== "POST") fail("不支持的请求方式", 405);
      const input = normalizeLossReasonRequest(JSON.parse(await readBody(req, 64 * 1024) || "{}"));
      client = await pool.connect(); await client.query("BEGIN"); await client.query("SELECT 1 FROM app_state WHERE id=$1 FOR UPDATE", [stateId]);
      const row = (await client.query(`SELECT data -> 'sites' AS sites, data -> 'personnel' AS personnel, data -> 'tankGroups' AS tank_groups,
        COALESCE((SELECT json_agg(json_build_object('record', item, 'index', ordinality-1)) FROM jsonb_array_elements(COALESCE(data -> 'lossRecords','[]'::jsonb)) WITH ORDINALITY AS records(item,ordinality)
          WHERE item ->> 'id'=$2), '[]'::json) AS loss_reason_targets FROM app_state WHERE id=$1`, [stateId, input.recordId])).rows[0] ?? {};
      const state = { sites: list(row.sites), personnel: list(row.personnel), tankGroups: list(row.tank_groups) };
      refreshAuth(req, state);
      const visibleDelta = (stockUpdates, lossRecordUpdates, bioRecordUpdates, operationLog = null) => ({
        ...sanitizeDelta({ ...state, stock: stockUpdates, lossRecords: lossRecordUpdates, bioRecords: bioRecordUpdates },
          delta(stockUpdates, lossRecordUpdates, bioRecordUpdates), req.auth.account), operationLog,
      });
      const matches = list(row.loss_reason_targets);
      if (matches.length !== 1) fail("损耗记录不存在或编号不唯一，请刷新后核对", matches.length ? 409 : 404);
      const current = matches[0].record, operator = operatorFor(req);
      const recordSiteId = normalizeSite(current.siteId || state.tankGroups.find(group => group.id === current.tankGroupId)?.siteId);
      authorizeSite(req, state, recordSiteId);
      if (!(hasPermission(req.auth.account, "lossRecords", "update") || text(current.operator) === operator && hasPermission(req.auth.account, "daily", "update"))) fail("只能修改自己登记的损耗原因，或由有损耗修改权限的人员处理", 403);
      const reasonBefore = text(current.reason);
      const idempotent = reasonBefore === input.reason;
      if (!idempotent && reasonBefore !== input.expectedReason) fail("损耗原因已被修改，请刷新后核对", 409, "LOSS_REASON_STALE");
      const rows = (await client.query(`SELECT
        COALESCE((SELECT json_agg(json_build_object('record', item, 'index', ordinality-1)) FROM jsonb_array_elements(COALESCE(data -> 'stock','[]'::jsonb)) WITH ORDINALITY AS records(item,ordinality) WHERE item ->> 'id'=$2), '[]'::json) AS loss_reason_stock,
        COALESCE((SELECT json_agg(json_build_object('record', item, 'index', ordinality-1)) FROM jsonb_array_elements(COALESCE(data -> 'bioRecords','[]'::jsonb)) WITH ORDINALITY AS records(item,ordinality) WHERE $3 <> '' AND item ->> 'id'=$3), '[]'::json) AS loss_reason_bio,
        (SELECT count(*) FROM jsonb_array_elements(COALESCE(data -> 'lossRecords','[]'::jsonb)) AS records(item) WHERE item ->> 'stockItemId'=$2) AS loss_reason_count
        FROM app_state WHERE id=$1`, [stateId, text(current.stockItemId), text(current.sourceBioRecordId)])).rows[0] ?? {};
      const stockRows = list(rows.loss_reason_stock), bioRows = list(rows.loss_reason_bio);
      if (stockRows.length > 1 || bioRows.length > 1) fail("关联库存或历史记录编号不唯一，无法安全更正", 409);
      if (current.sourceBioRecordId && (bioRows.length !== 1 || text(bioRows[0].record.stockItemId) !== text(current.stockItemId) ||
        bioRows[0].record.siteId && normalizeSite(bioRows[0].record.siteId) !== recordSiteId ||
        bioRows[0].record.sourceLossRecordId && text(bioRows[0].record.sourceLossRecordId) !== input.recordId)) fail("损耗历史关联已变化，请管理员核对", 409);
      const stockIsSameLoss = stockRows.length && Number(rows.loss_reason_count) === 1 && stockRows[0].record.lost && text(stockRows[0].record.lossDate) === text(current.date) &&
        normalizeSite(findTank(state, stockRows[0].record.subTankId)?.group?.siteId ?? stockRows[0].record.siteId) === recordSiteId;
      if (idempotent) {
        await client.query("COMMIT"); sendJson(req, res, 200, { ok: true, idempotent: true, ...visibleDelta(stockIsSameLoss ? [stockRows[0].record] : [], [current], bioRows.map(row => row.record)) }); return true;
      }
      const changedAt = new Date().toISOString();
      const updated = { ...current, reason: input.reason, reasonUpdatedBy: operator, reasonUpdatedAt: changedAt };
      const stockUpdates = [], bioRecordUpdates = [];
      if (stockIsSameLoss) {
        const changed = { ...stockRows[0].record, lossReason: input.reason };
        await replaceByIndex(client, "stock", Number(stockRows[0].index), changed); stockUpdates.push(changed);
      }
      if (bioRows.length) {
        const changed = { ...bioRows[0].record, text: lossBioText(updated, bioRows[0].record.lossReasonSupplement === true), reasonUpdatedBy: operator, reasonUpdatedAt: changedAt };
        await replaceByIndex(client, "bioRecords", Number(bioRows[0].index), changed); bioRecordUpdates.push(changed);
      } else {
        updated.sourceBioRecordId = createId("bio");
        const supplement = { id: updated.sourceBioRecordId, siteId: recordSiteId, stockItemId: current.stockItemId, date: nowLocal(), text: lossBioText(updated, true), photos: [], videos: [],
          sourceType: "stockLoss", sourceLossRecordId: current.id, lossReasonSupplement: true, operator, reasonUpdatedBy: operator, reasonUpdatedAt: changedAt,
          tankGroupId: current.tankGroupId, subTankId: current.subTankId, tankGroupName: current.tankGroupName,
          subTankName: current.subTankName, tankLocation: current.tankLocation };
        await append(client, "bioRecords", [supplement]); bioRecordUpdates.push(supplement);
      }
      await replaceByIndex(client, "lossRecords", Number(matches[0].index), updated);
      const operationLog = { id: createId("log"), time: changedAt, operator, module: "损耗记录", action: "修改记录",
        detail: `修改损耗原因（记录 ${current.id}，鱼只 ${current.fishCode || current.stockItemId}）：${reasonBefore || "未填写"} → ${input.reason}` };
      await audit(client, operationLog); await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, idempotent: false, ...visibleDelta(stockUpdates, [updated], bioRecordUpdates, operationLog) });
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, Number(error.statusCode ?? 400), { ok: false, code: error.code || "LOSS_REASON_FAILED", error: error.message || "损耗原因保存失败" });
    } finally { client?.release(); }
    return true;
  }
  return { saveLoss, handleReason };
}
