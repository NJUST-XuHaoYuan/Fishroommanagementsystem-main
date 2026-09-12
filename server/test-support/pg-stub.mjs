import { createHash } from "node:crypto";

const fixture = JSON.parse(process.env.FISHROOM_TEST_DATABASE_FIXTURE_JSON || "{}");
const state = fixture.state && typeof fixture.state === "object" ? fixture.state : {};
const revision = String(fixture.revision ?? "1");
const settlements = Array.isArray(fixture.platformSettlements)
  ? fixture.platformSettlements
  : [];

function result(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function publicBioProjectionRow(sql, values = []) {
  if (!/\bcandidate_stock\s+AS\s+MATERIALIZED\b/i.test(sql)) return null;
  const targetId = String(values[1] ?? "").trim();
  const targetRows = (Array.isArray(state.stock) ? state.stock : [])
    .filter((item) => String(item?.id ?? "").trim() === targetId);
  const targetProductId = targetRows.length === 1 ? String(targetRows[0]?.productId ?? "").trim() : "";
  const stock = (Array.isArray(state.stock) ? state.stock : [])
    .filter((item) => targetProductId && String(item?.productId ?? "").trim() === targetProductId);
  const stockIds = new Set(stock.map((item) => String(item?.id ?? "").trim()).filter(Boolean));
  const products = (Array.isArray(state.products) ? state.products : [])
    .filter((item) => String(item?.id ?? "").trim() === targetProductId);
  const speciesId = products.length === 1 ? String(products[0]?.speciesId ?? "").trim() : "";
  const species = (Array.isArray(state.species) ? state.species : [])
    .filter((item) => String(item?.id ?? "").trim() === speciesId);
  const subTankIds = new Set(stock.map((item) => String(item?.subTankId ?? "").trim()).filter(Boolean));
  const tankGroups = (Array.isArray(state.tankGroups) ? state.tankGroups : [])
    .filter((group) => (Array.isArray(group?.subTanks) ? group.subTanks : [])
      .some((tank) => subTankIds.has(String(tank?.id ?? "").trim())));
  const orders = (Array.isArray(state.orders) ? state.orders : [])
    .filter((order) => (Array.isArray(order?.items) ? order.items : [])
      .some((item) => stockIds.has(String(item?.stockItemId ?? "").trim())));
  const orderIds = new Set(orders.map((order) => String(order?.id ?? "").trim()).filter(Boolean));
  const shipments = (Array.isArray(state.shipments) ? state.shipments : [])
    .filter((shipment) =>
      orderIds.has(String(shipment?.orderId ?? "").trim()) ||
      (Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds : [])
        .some((id) => stockIds.has(String(id ?? "").trim()))
    );
  const bioRecords = (Array.isArray(state.bioRecords) ? state.bioRecords : [])
    .filter((record) => {
      const recordStockId = String(record?.stockItemId ?? "").trim();
      return recordStockId === targetId || (
        stockIds.has(recordStockId) &&
        ((Array.isArray(record?.photos) && record.photos.length > 0) ||
          (Array.isArray(record?.videos) && record.videos.length > 0))
      );
    });
  return {
    version: revision,
    sites: Array.isArray(state.sites) ? state.sites : [],
    species_category_major_map: state.speciesCategoryMajorMap ?? {},
    public_catalog_policy: state.publicCatalogPolicy ?? {},
    tank_groups: tankGroups,
    products,
    species,
    orders,
    shipments,
    stock_item_count: targetRows.length,
    stock,
    bio_records: bioRecords,
  };
}

function purchaseBatchProjectionRow(sql, values = []) {
  if (!/\bcandidate_ids\s+AS\s+MATERIALIZED\b/i.test(sql)) return null;
  const list = (value) => Array.isArray(value) ? value : [];
  const isOrderDetail = /\brequested_orders\s+AS\s+MATERIALIZED\b/i.test(sql);
  const batchId = String(values[1] ?? "");
  const fishId = String(values[2] ?? "");
  const changes = list(state.approvalRequests).filter((request) => request.status === "approved")
    .flatMap((request) => list(request.stockDetails?.items).map((change) => ({ request, change })))
    .filter(({ change }) => change.before?.batchId === batchId || change.after?.batchId === batchId);
  const candidateIds = new Set([
    ...list(state.stock).filter((item) => item.batchId === batchId).map((item) => item.id),
    ...changes.map(({ change }) => change.stockItemId),
    ...list(state.orders).flatMap((order) => list(order.items).filter((item) => item.batchId === batchId).map((item) => item.stockItemId)),
  ]);
  const shipments = list(state.shipments).filter((shipment) =>
    list(shipment.itemStockIds).some((id) => candidateIds.has(id)) ||
    list(shipment.damageReplacements).some((relation) => candidateIds.has(relation.originalStockItemId) || candidateIds.has(relation.replacementStockItemId))
  );
  const orderIds = new Set(shipments.map((shipment) => shipment.orderId));
  const records = (rows, mediaKeys) => list(rows)
    .filter((row) => candidateIds.has(row.stockItemId) && (!fishId || row.stockItemId === fishId))
    .map((row) => fishId ? row : Object.fromEntries(Object.entries(row).filter(([key]) => !mediaKeys.includes(key))));
  const row = {
    version: revision,
    sites: list(state.sites), tank_groups: list(state.tankGroups), products: list(state.products), species: list(state.species),
    batches: list(state.batches).filter((batch) => batch.id === batchId),
    stock: list(state.stock).filter((item) => candidateIds.has(item.id)),
    orders: list(state.orders).filter((order) => orderIds.has(order.id) || list(order.items).some((item) => candidateIds.has(item.stockItemId))),
    shipments,
    bio_records: records(state.bioRecords, ["photos", "videos"]),
    loss_records: records(state.lossRecords, ["proofPhotos"]),
    approval_requests: changes.map(({ request, change }) => ({
      id: request.id, status: request.status, siteId: request.siteId, resolvedAt: request.resolvedAt,
      resolvedBy: request.resolvedBy, resolvedByName: request.resolvedByName, stockDetails: { items: [change] },
    })),
  };
  if (isOrderDetail) {
    row.order_id_count = list(state.orders).filter((order) => order.id === fishId).length;
    const visibleSites = new Set(list(values[3]));
    row.orders = row.orders.filter((order) => order.id === fishId && visibleSites.has(String(order.siteId || "nanjing")));
    const requestedOrderIds = new Set(row.orders.map((order) => order.id));
    row.shipments = list(state.shipments).filter((shipment) => requestedOrderIds.has(shipment.orderId));
    const customerIds = new Set(row.orders.map((order) => order.customerId));
    row.customers = list(state.customers).filter((customer) => customerIds.has(customer.id)).map(({ id, name }) => ({ id, name }));
    delete row.bio_records;
    delete row.loss_records;
  }
  return row;
}

function appStateRow(sql, values = []) {
  const purchaseBatchRow = purchaseBatchProjectionRow(sql, values);
  if (purchaseBatchRow) return purchaseBatchRow;
  const publicBioRow = publicBioProjectionRow(sql, values);
  if (publicBioRow) return publicBioRow;
  const row = {};
  if (/\bSELECT\s+data\s+FROM\s+app_state\b/i.test(sql)) row.data = state;
  if (/\brevision::text\s+AS\s+version\b/i.test(sql)) row.version = revision;
  // The general state/slice route quotes camelCase aliases, unlike compact
  // endpoints that use unquoted snake_case projections below.
  for (const match of sql.matchAll(/data\s*->\s*'([A-Za-z][A-Za-z0-9_]*)'\s+AS\s+"([A-Za-z][A-Za-z0-9_]*)"/gi)) {
    row[match[2]] = state[match[1]] ?? null;
  }
  for (const [stateKey, alias] of [
    ["personnel", "personnel"],
    ["sites", "sites"],
    ["species", "species"],
    ["speciesCategories", "species_categories"],
    ["tankGroups", "tank_groups"],
    ["batches", "batches"],
    ["products", "products"],
    ["stock", "stock"],
    ["orders", "orders"],
    ["shipments", "shipments"],
    ["bioRecords", "bio_records"],
    ["lossRecords", "loss_records"],
    ["customers", "customers"],
  ]) {
    const projection = new RegExp(`data\\s*->\\s*'${stateKey}'\\s+AS\\s+${alias}\\b`, "i");
    if (projection.test(sql)) row[alias] = Array.isArray(state[stateKey]) ? state[stateKey] : [];
  }
  for (const [stateKey, alias] of [
    ["speciesCategoryMajorMap", "species_category_major_map"],
    ["publicCatalogPolicy", "public_catalog_policy"],
  ]) {
    const projection = new RegExp(`data\\s*->\\s*'${stateKey}'\\s+AS\\s+${alias}\\b`, "i");
    if (projection.test(sql)) row[alias] = state[stateKey] && typeof state[stateKey] === "object"
      ? state[stateKey]
      : {};
  }
  if (/\bAS\s+bio_records\b/i.test(sql) && row.bio_records === undefined) {
    row.bio_records = (Array.isArray(state.bioRecords) ? state.bioRecords : []).filter((record) =>
      (Array.isArray(record?.photos) && record.photos.length > 0) ||
      (Array.isArray(record?.videos) && record.videos.length > 0)
    );
  }
  if (/\bAS\s+specimen_history_digests\b/i.test(sql)) {
    const histories = Map.groupBy(state.bioRecords || [], (record) => record.stockItemId);
    row.specimen_history_digests = Object.fromEntries([...histories].map(([id, records]) => [id,
      records.some((record) => !record.id) || new Set(records.map((record) => record.id)).size !== records.length
        ? null
        : createHash("sha256").update(JSON.stringify(records.map(({ id, stockItemId, ...content }) =>
          JSON.stringify(content, Object.keys(content).sort())
        ).sort())).digest("hex"),
    ]));
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
  if (/^\s*(?:SELECT|WITH)\b/i.test(sql) && /\bFROM\s+app_state\b/i.test(sql)) {
    return result([appStateRow(sql, values)]);
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
