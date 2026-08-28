import assert from "node:assert/strict";
import test from "node:test";

import { appendBioRecordsMutationSql } from "./bio-record-save-sql.mjs";

function buildUpdate(action) {
  const values = ["main", "stock-1", JSON.stringify({ id: "stock-1" })];
  const bindValue = (value) => {
    values.push(value);
    return `$${values.length}`;
  };
  let dataExpression = "jsonb_set(data, '{stock}', jsonb_build_object('id', $2, 'item', $3::jsonb), true)";
  const record = { id: "bio-1", stockItemId: "stock-1", date: "2026-08-28T10:00:00" };
  dataExpression = appendBioRecordsMutationSql({
    dataExpression,
    action,
    targetRecordId: record.id,
    record,
    bindValue,
  });
  const operationLogParam = bindValue(JSON.stringify({ id: "log-1" }));
  const operationLogLimitParam = bindValue(9_999);
  const sql = `UPDATE app_state
    SET data = jsonb_set(
      ${dataExpression},
      '{operationLogs}',
      jsonb_build_array(${operationLogParam}::jsonb) || COALESCE(data -> 'operationLogs', '[]'::jsonb),
      true
    )
    WHERE id = $1 AND jsonb_array_length(COALESCE(data -> 'operationLogs', '[]'::jsonb)) <= ${operationLogLimitParam}`;
  return { sql, values };
}

function assertEveryBindingIsUsed({ sql, values }) {
  const referenced = [...sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
  const unique = [...new Set(referenced)].sort((left, right) => left - right);
  assert.deepEqual(unique, Array.from({ length: values.length }, (_, index) => index + 1));
}

for (const action of ["create", "saveDetails", "updateTime", "delete"]) {
  test(`${action} bio-record SQL uses every contiguous placeholder`, () => {
    const update = buildUpdate(action);
    assertEveryBindingIsUsed(update);
    if (action === "create" || action === "saveDetails") {
      assert.equal(update.values.filter((value) => value === "bio-1").length, 0);
      assert.match(update.sql, /jsonb_build_array\(\$4::jsonb\)/);
    } else {
      assert.equal(update.values.filter((value) => value === "bio-1").length, 1);
    }
  });
}

test("bio-record SQL builder rejects unknown actions before binding values", () => {
  const values = [];
  assert.throws(() => appendBioRecordsMutationSql({
    action: "replace",
    bindValue: (value) => {
      values.push(value);
      return `$${values.length}`;
    },
  }), /Unsupported bio-record SQL action/);
  assert.deepEqual(values, []);
});
