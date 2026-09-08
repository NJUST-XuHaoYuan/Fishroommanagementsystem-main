import { createHmac } from "node:crypto";

// Hash complete JSON history in Postgres so the compact catalog projection does
// not start transferring every text-only maintenance record to the API process.
export const PUBLIC_SPECIMEN_HISTORY_SQL = `COALESCE((
  SELECT jsonb_object_agg(stock_item_id, CASE WHEN valid THEN digest ELSE NULL END)
  FROM (
    SELECT record_item ->> 'stockItemId' AS stock_item_id,
      bool_and(COALESCE(record_item ->> 'id', '') <> '')
        AND count(*) = count(DISTINCT record_item ->> 'id') AS valid,
      encode(sha256(convert_to(string_agg(
        (record_item - 'id' - 'stockItemId')::text, E'\\n'
        ORDER BY (record_item - 'id' - 'stockItemId')::text
      ), 'UTF8')), 'hex') AS digest
    FROM jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb)) AS records(record_item)
    WHERE COALESCE(record_item ->> 'stockItemId', '') <> ''
    GROUP BY record_item ->> 'stockItemId'
  ) AS history
), '{}'::jsonb)`;

const text = (value) => String(value ?? "");

export function publicSpecimenGroupKeys(stock, historyDigests, secret) {
  return new Map(stock.map((item) => {
    const id = text(item.id);
    const digest = historyDigests && Object.hasOwn(historyDigests, id) ? historyDigests[id] : "empty";
    // Unknown arrival/location and ambiguous history must never collapse.
    if (!historyDigests || !item.inDate || !item.subTankId || !Number.isFinite(Number(item.basePrice || 0)) || digest === null) return [id, ""];
    const content = JSON.stringify([
      text(item.productId), text(item.siteId), text(item.batchId),
      text(item.subTankId), text(item.inDate), text(item.status),
      Number(item.basePrice || 0), text(item.notes),
      digest,
    ]);
    return [id, `v1:${createHmac("sha256", secret).update(content).digest("hex")}`];
  }));
}
