const APPEND_ACTIONS = new Set(["create", "saveDetails"]);

function requireBinder(bindValue) {
  if (typeof bindValue !== "function") {
    throw new TypeError("bindValue must be a function");
  }
  return bindValue;
}

export function appendBioRecordsMutationSql({
  dataExpression = "data",
  action,
  targetRecordId,
  record,
  bindValue,
} = {}) {
  const bind = requireBinder(bindValue);
  const normalizedAction = String(action ?? "").trim();

  if (normalizedAction === "delete") {
    const recordIdParam = bind(targetRecordId);
    return `jsonb_set(
      ${dataExpression},
      '{bioRecords}',
      (
        SELECT COALESCE(jsonb_agg(record_row.record_item ORDER BY record_row.ordinality), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb))
          WITH ORDINALITY AS record_row(record_item, ordinality)
        WHERE btrim(COALESCE(record_row.record_item ->> 'id', '')) <> ${recordIdParam}
      ),
      true
    )`;
  }

  if (normalizedAction === "updateTime") {
    const recordIdParam = bind(targetRecordId);
    const recordParam = bind(JSON.stringify(record));
    return `jsonb_set(
      ${dataExpression},
      '{bioRecords}',
      (
        SELECT COALESCE(jsonb_agg(
          CASE WHEN btrim(COALESCE(record_row.record_item ->> 'id', '')) = ${recordIdParam} THEN ${recordParam}::jsonb ELSE record_row.record_item END
          ORDER BY record_row.ordinality
        ), '[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb))
          WITH ORDINALITY AS record_row(record_item, ordinality)
      ),
      true
    )`;
  }

  if (APPEND_ACTIONS.has(normalizedAction)) {
    const recordParam = bind(JSON.stringify(record));
    return `jsonb_set(
      ${dataExpression},
      '{bioRecords}',
      COALESCE(data -> 'bioRecords', '[]'::jsonb) || jsonb_build_array(${recordParam}::jsonb),
      true
    )`;
  }

  throw new Error(`Unsupported bio-record SQL action: ${normalizedAction || "missing"}`);
}
