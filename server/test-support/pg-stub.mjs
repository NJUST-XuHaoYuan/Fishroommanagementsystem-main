const fixture = JSON.parse(process.env.FISHROOM_TEST_DATABASE_FIXTURE_JSON || "{}");
const state = fixture.state && typeof fixture.state === "object" ? fixture.state : {};
const revision = String(fixture.revision ?? "1");
const settlements = Array.isArray(fixture.platformSettlements)
  ? fixture.platformSettlements
  : [];

function result(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function appStateRow(sql) {
  const row = {};
  if (/\bSELECT\s+data\s+FROM\s+app_state\b/i.test(sql)) row.data = state;
  if (/\brevision::text\s+AS\s+version\b/i.test(sql)) row.version = revision;
  for (const [stateKey, alias] of [
    ["personnel", "personnel"],
    ["sites", "sites"],
    ["tankGroups", "tank_groups"],
    ["batches", "batches"],
    ["stock", "stock"],
    ["orders", "orders"],
    ["shipments", "shipments"],
  ]) {
    const projection = new RegExp(`data\\s*->\\s*'${stateKey}'\\s+AS\\s+${alias}\\b`, "i");
    if (projection.test(sql)) row[alias] = Array.isArray(state[stateKey]) ? state[stateKey] : [];
  }
  return row;
}

function aggregatedSettlementRows(sql, values = []) {
  const requestedStateId = String(values[0] ?? "");
  const requestedSiteId = String(values[1] ?? "");
  const filtersState = /\bstate_id\s*=\s*\$1\b/i.test(sql);
  const filtersSite = /\bsite_id\s*=\s*\$2\b/i.test(sql);
  const filtersPlatform = /\bplatform\s*=\s*'douyin'\b/i.test(sql);
  const grouped = new Map();

  for (const row of settlements) {
    if (filtersState && String(row?.state_id ?? "") !== requestedStateId) continue;
    if (filtersSite && String(row?.site_id ?? "") !== requestedSiteId) continue;
    if (filtersPlatform && String(row?.platform ?? "") !== "douyin") continue;
    const externalOrderNo = String(row?.external_order_no ?? "");
    const current = grouped.get(externalOrderNo) ?? { income: 0, rowCount: 0 };
    const income = typeof row?.data?.incomeTotal === "number" && Number.isFinite(row.data.incomeTotal)
      ? row.data.incomeTotal
      : 0;
    current.income += income;
    current.rowCount += 1;
    grouped.set(externalOrderNo, current);
  }

  return [...grouped.entries()].map(([externalOrderNo, aggregate]) => ({
    external_order_no: externalOrderNo,
    row_count: aggregate.rowCount,
    income_total: String(aggregate.income),
  }));
}

function runQuery(query, values = []) {
  const sql = String(query?.text ?? query ?? "");

  if (/^\s*SELECT\s+1\s+FROM\s+app_state\b/i.test(sql)) {
    return result([{ "?column?": 1 }]);
  }
  if (
    /^\s*SELECT\b/i.test(sql) &&
    /\bFROM\s+finance_platform_settlements\b/i.test(sql) &&
    /\bGROUP\s+BY\s+external_order_no\b/i.test(sql)
  ) {
    return result(aggregatedSettlementRows(sql, values));
  }
  if (/^\s*SELECT\b/i.test(sql) && /\bFROM\s+app_state\b/i.test(sql)) {
    return result([appStateRow(sql)]);
  }
  if (/^\s*SELECT\s+current_database\(\)/i.test(sql)) {
    return result([{ database: "fishroom_route_test", user: "fishroom_route_test" }]);
  }
  if (/^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) {
    return result([], 1);
  }
  return result();
}

class TestClient {
  query(query, values) {
    return Promise.resolve(runQuery(query, values));
  }

  release() {}
}

export class Pool {
  query(query, values) {
    return Promise.resolve(runQuery(query, values));
  }

  connect() {
    return Promise.resolve(new TestClient());
  }

  end() {
    return Promise.resolve();
  }
}

export default { Pool };
