import { randomUUID } from "node:crypto";

const STATUSES = new Set(["healthy", "feeding", "sick"]);
const list = (value) => Array.isArray(value) ? value : [];
const idOf = (value) => String(value ?? "").trim();

// This ledger is separate from editable biological records and capped operation
// logs. Only the server calls this after validation, inside the mutation lock.
export function stockStatusChanges({ before = [], after = [], account, source,
  changedAt = new Date().toISOString(), requestedBy, requestedByName } = {}) {
  const operator = idOf(account?.username);
  if (!operator || !idOf(account?.id)) throw new Error("状态记录缺少已认证的操作人");
  const previous = new Map();
  const affectedIds = new Set(list(after).map((item) => idOf(item?.id)));
  for (const item of list(before)) {
    const id = idOf(item?.id);
    if (!affectedIds.has(id)) continue;
    if (previous.has(id)) throw new Error("库存鱼 ID 不唯一，不能记录状态变更");
    previous.set(id, item);
  }
  const seen = new Set();
  return list(after).flatMap((item) => {
    const stockItemId = idOf(item?.id);
    if (!stockItemId || seen.has(stockItemId)) throw new Error("库存鱼 ID 不唯一，不能记录状态变更");
    seen.add(stockItemId);
    const oldItem = previous.get(stockItemId);
    if (!STATUSES.has(item?.status) || oldItem?.status === item.status) return [];
    return [{
      id: `status_${randomUUID()}`,
      stockItemId,
      previousStatus: oldItem ? (idOf(oldItem.status) || null) : null,
      status: item.status,
      changedAt,
      operator,
      operatorName: idOf(account?.name) || operator,
      operatorId: idOf(account?.id),
      siteId: idOf(item?.siteId),
      source,
      ...(requestedBy ? { requestedBy: idOf(requestedBy), requestedByName: idOf(requestedByName) || idOf(requestedBy) } : {}),
    }];
  });
}

export function appendStockStatusHistorySql(dataExpression, records, bindValue) {
  if (!records.length) return dataExpression;
  const rowsParam = bindValue(JSON.stringify(records));
  return `jsonb_set(${dataExpression}, '{stockStatusHistory}',
    COALESCE(data -> 'stockStatusHistory', '[]'::jsonb) || ${rowsParam}::jsonb, true)`;
}

export function stockStatusHistoryPageQuery(searchParams) {
  const stockItemId = idOf(searchParams.get("stockItemId"));
  if (!stockItemId || stockItemId.length > 160) throw new Error("缺少或无效的库存鱼编号");
  const offset = Number(searchParams.get("offset") ?? 0);
  const limit = Number(searchParams.get("limit") ?? 20);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("状态记录分页参数无效");
  return { stockItemId, offset, limit };
}

export function stockStatusHistoryForResponse(records) {
  return list(records).map((record) => ({
    id: idOf(record.id), stockItemId: idOf(record.stockItemId),
    previousStatus: record.previousStatus == null ? null : idOf(record.previousStatus),
    status: idOf(record.status), changedAt: idOf(record.changedAt),
    operator: idOf(record.operator), operatorName: idOf(record.operatorName) || idOf(record.operator),
    source: idOf(record.source), siteId: idOf(record.siteId),
    ...(record.requestedBy ? { requestedBy: idOf(record.requestedBy), requestedByName: idOf(record.requestedByName) || idOf(record.requestedBy) } : {}),
  }));
}

// One snapshot; only the requested fish and bounded journal page leave PostgreSQL.
// No FOR UPDATE on aggregate queries, and no read-triggered legacy backfill.
export const STOCK_STATUS_HISTORY_SQL = `WITH source AS MATERIALIZED (
  SELECT data FROM app_state WHERE id = $1
), target_stock AS MATERIALIZED (
  SELECT stock_item FROM source,
    LATERAL jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS s(stock_item)
  WHERE btrim(COALESCE(stock_item ->> 'id', '')) = $2
), status_history AS MATERIALIZED (
  SELECT history_item, ordinality FROM source,
    LATERAL jsonb_array_elements(COALESCE(data -> 'stockStatusHistory', '[]'::jsonb))
      WITH ORDINALITY AS h(history_item, ordinality)
  WHERE history_item ->> 'stockItemId' = $2
), status_page AS (
  SELECT history_item, ordinality FROM status_history
  ORDER BY history_item ->> 'changedAt' DESC, ordinality DESC LIMIT $3 OFFSET $4
)
SELECT data -> 'personnel' AS personnel, data -> 'sites' AS sites,
  data -> 'tankGroups' AS tank_groups,
  (SELECT count(*)::int FROM target_stock) AS stock_item_count,
  (SELECT stock_item FROM target_stock LIMIT 1) AS stock_item,
  (SELECT count(*)::int FROM status_history) AS history_total,
  COALESCE((SELECT jsonb_agg(history_item ORDER BY history_item ->> 'changedAt' DESC, ordinality DESC)
    FROM status_page), '[]'::jsonb) AS status_history_records
FROM source`;
