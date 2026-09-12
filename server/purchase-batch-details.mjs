import { paymentVerificationStatus, verifiedPaymentTotals } from "./payment-utils.mjs";

const array = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? "").trim();
const id = text;
const date = (value) => text(value);
const defaultSite = "nanjing";
function historyTime(value) {
  const raw = date(value).replace(" ", "T");
  const zoned = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00+08:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(raw) ? `${raw}+08:00` : raw;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
const compareHistoryDate = (left, right) => historyTime(left) - historyTime(right) || date(left).localeCompare(date(right));

// The list loads metadata for one batch, never every fish's media payloads.
// Expanding a fish enables media only for that exact stock ID.
const PURCHASE_BATCH_CTES = `
WITH source AS MATERIALIZED (
  SELECT data, revision::text AS version FROM app_state WHERE id = $1
), approved_changes AS MATERIALIZED (
  SELECT request, change
  FROM source,
       LATERAL jsonb_array_elements(COALESCE(data -> 'approvalRequests', '[]'::jsonb)) AS requests(request),
       LATERAL jsonb_array_elements(COALESCE(request -> 'stockDetails' -> 'items', '[]'::jsonb)) AS changes(change)
  WHERE request ->> 'status' = 'approved'
    AND (change -> 'before' ->> 'batchId' = $2 OR change -> 'after' ->> 'batchId' = $2)
), candidate_ids AS MATERIALIZED (
  SELECT item ->> 'id' AS stock_id FROM source,
    LATERAL jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS stocks(item)
    WHERE item ->> 'batchId' = $2
  UNION
  SELECT change ->> 'stockItemId' FROM approved_changes
  UNION
  SELECT item ->> 'stockItemId' FROM source,
    LATERAL jsonb_array_elements(COALESCE(data -> 'orders', '[]'::jsonb)) AS orders(order_item),
    LATERAL jsonb_array_elements(COALESCE(order_item -> 'items', '[]'::jsonb)) AS items(item)
    WHERE item ->> 'batchId' = $2
), related_shipments AS MATERIALIZED (
  SELECT shipment FROM source,
    LATERAL jsonb_array_elements(COALESCE(data -> 'shipments', '[]'::jsonb)) AS shipments(shipment)
  WHERE EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(shipment -> 'itemStockIds', '[]'::jsonb)) AS ids(stock_id)
    WHERE stock_id IN (SELECT stock_id FROM candidate_ids)
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(shipment -> 'damageReplacements', '[]'::jsonb)) AS replacements(relation)
    WHERE relation ->> 'originalStockItemId' IN (SELECT stock_id FROM candidate_ids)
       OR relation ->> 'replacementStockItemId' IN (SELECT stock_id FROM candidate_ids)
  )
)`;

export const PURCHASE_BATCH_DETAIL_SQL = `${PURCHASE_BATCH_CTES}
SELECT version,
       data -> 'sites' AS sites,
       data -> 'tankGroups' AS tank_groups,
       data -> 'products' AS products,
       data -> 'species' AS species,
       COALESCE((SELECT jsonb_agg(batch) FROM jsonb_array_elements(COALESCE(data -> 'batches', '[]'::jsonb)) AS batches(batch) WHERE batch ->> 'id' = $2), '[]'::jsonb) AS batches,
       COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS stocks(item) WHERE item ->> 'id' IN (SELECT stock_id FROM candidate_ids)), '[]'::jsonb) AS stock,
       COALESCE((SELECT jsonb_agg(order_item) FROM jsonb_array_elements(COALESCE(data -> 'orders', '[]'::jsonb)) AS orders(order_item)
         WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(order_item -> 'items', '[]'::jsonb)) AS items(item) WHERE item ->> 'stockItemId' IN (SELECT stock_id FROM candidate_ids))
         OR order_item ->> 'id' IN (SELECT shipment ->> 'orderId' FROM related_shipments)), '[]'::jsonb) AS orders,
       COALESCE((SELECT jsonb_agg(shipment) FROM related_shipments), '[]'::jsonb) AS shipments,
       COALESCE((SELECT jsonb_agg(CASE WHEN $3::text <> '' THEN record ELSE record - 'photos' - 'videos' END)
         FROM jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb)) AS records(record)
         WHERE record ->> 'stockItemId' IN (SELECT stock_id FROM candidate_ids) AND ($3::text = '' OR record ->> 'stockItemId' = $3)), '[]'::jsonb) AS bio_records,
       COALESCE((SELECT jsonb_agg(CASE WHEN $3::text <> '' THEN record ELSE record - 'proofPhotos' END)
         FROM jsonb_array_elements(COALESCE(data -> 'lossRecords', '[]'::jsonb)) AS records(record)
         WHERE record ->> 'stockItemId' IN (SELECT stock_id FROM candidate_ids) AND ($3::text = '' OR record ->> 'stockItemId' = $3)), '[]'::jsonb) AS loss_records,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', request -> 'id', 'status', request -> 'status', 'siteId', request -> 'siteId', 'resolvedAt', request -> 'resolvedAt', 'resolvedBy', request -> 'resolvedBy', 'resolvedByName', request -> 'resolvedByName', 'stockDetails', jsonb_build_object('items', jsonb_build_array(change)))) FROM approved_changes), '[]'::jsonb) AS approval_requests
FROM source`;

// A separate projection loads a single proven-related order and ALL of that
// order's shipments, including other batches, so its shipping bill is complete.
// The requested order's persisted site must also belong to the account scope.
export const PURCHASE_BATCH_ORDER_DETAIL_SQL = `${PURCHASE_BATCH_CTES},
requested_orders AS MATERIALIZED (
  SELECT order_item FROM source,
    LATERAL jsonb_array_elements(COALESCE(data -> 'orders', '[]'::jsonb)) AS orders(order_item)
  WHERE order_item ->> 'id' = $3
    AND COALESCE(NULLIF(order_item ->> 'siteId', ''), 'nanjing') = ANY($4::text[])
    AND (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(order_item -> 'items', '[]'::jsonb)) AS items(item)
           WHERE item ->> 'stockItemId' IN (SELECT stock_id FROM candidate_ids))
      OR order_item ->> 'id' IN (SELECT shipment ->> 'orderId' FROM related_shipments))
)
SELECT version,
       (SELECT COUNT(*)::int FROM jsonb_array_elements(COALESCE(data -> 'orders', '[]'::jsonb)) AS all_orders(order_item) WHERE order_item ->> 'id' = $3) AS order_id_count,
       data -> 'sites' AS sites,
       data -> 'tankGroups' AS tank_groups,
       data -> 'products' AS products,
       data -> 'species' AS species,
       COALESCE((SELECT jsonb_agg(batch) FROM jsonb_array_elements(COALESCE(data -> 'batches', '[]'::jsonb)) AS batches(batch) WHERE batch ->> 'id' = $2), '[]'::jsonb) AS batches,
       COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS stocks(item) WHERE item ->> 'id' IN (SELECT stock_id FROM candidate_ids)), '[]'::jsonb) AS stock,
       COALESCE((SELECT jsonb_agg(order_item) FROM requested_orders), '[]'::jsonb) AS orders,
       COALESCE((SELECT jsonb_agg(shipment) FROM jsonb_array_elements(COALESCE(data -> 'shipments', '[]'::jsonb)) AS shipments(shipment)
         WHERE shipment ->> 'orderId' IN (SELECT order_item ->> 'id' FROM requested_orders)), '[]'::jsonb) AS shipments,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', customer -> 'id', 'name', customer -> 'name')) FROM jsonb_array_elements(COALESCE(data -> 'customers', '[]'::jsonb)) AS customers(customer)
         WHERE customer ->> 'id' IN (SELECT order_item ->> 'customerId' FROM requested_orders)), '[]'::jsonb) AS customers,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('id', request -> 'id', 'status', request -> 'status', 'siteId', request -> 'siteId', 'resolvedAt', request -> 'resolvedAt', 'resolvedBy', request -> 'resolvedBy', 'resolvedByName', request -> 'resolvedByName', 'stockDetails', jsonb_build_object('items', jsonb_build_array(change)))) FROM approved_changes), '[]'::jsonb) AS approval_requests
FROM source`;

function fail(message, statusCode = 400, code = "BATCH_DETAIL_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  throw error;
}

function uniqueById(records, label) {
  const result = new Map();
  for (const record of array(records)) {
    const key = id(record?.id);
    if (!key) continue;
    if (result.has(key)) fail(`${label}编号不唯一，无法安全关联历史`, 409, "BATCH_HISTORY_ID_CONFLICT");
    result.set(key, record);
  }
  return result;
}

function indexBy(records, keyForRecord) {
  const result = new Map();
  for (const record of records) {
    const key = keyForRecord(record);
    if (!key) continue;
    const rows = result.get(key) ?? [];
    rows.push(record);
    result.set(key, rows);
  }
  return result;
}

export function parseBatchDetailQuery(params, { history = false, orderDetail = false } = {}) {
  const batchId = text(params.get("batchId"));
  const siteId = text(params.get("siteId"));
  const stockItemId = text(params.get("stockItemId"));
  const orderId = text(params.get("orderId"));
  if (!batchId || !siteId || siteId === "all" || (history && !stockItemId) || (orderDetail && !orderId)) {
    fail("请选择具体场地、采购批次及需要查看的鱼");
  }
  const integer = (name, fallback, max) => {
    const raw = params.get(name);
    if (raw == null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) fail("分页参数无效");
    return Number(raw);
  };
  const page = integer("page", 1, 1_000_000);
  const pageSize = integer("pageSize", history ? 100 : 50, history ? 100 : 100);
  const search = text(params.get("search"));
  if (search.length > 100) fail("搜索内容最多 100 个字符");
  const status = text(params.get("status")) || "all";
  if (!["all", "inStock", "sold", "lost", "removed", "restricted"].includes(status)) fail("库存状态筛选无效");
  const tankKey = text(params.get("tankKey"));
  if (tankKey.length > 600 || (tankKey && !["restricted", "removed", "unknown"].includes(tankKey) && !/^tank:[^:]+:[^:]+$/.test(tankKey))) fail("缸位筛选无效");
  return { batchId, siteId, stockItemId, orderId, page, pageSize, search, status, tankKey };
}

function locationIndex(state) {
  const sites = new Map(array(state.sites).map((site) => [id(site?.id), text(site?.name)]));
  const tanks = new Map();
  for (const group of array(state.tankGroups)) {
    for (const tank of array(group?.subTanks)) {
      const key = id(tank?.id);
      if (!key) continue;
      if (tanks.has(key)) fail("缸位编号不唯一，无法安全关联历史", 409, "BATCH_HISTORY_ID_CONFLICT");
      tanks.set(key, { siteId: text(group?.siteId) || defaultSite, tankGroupId: id(group?.id), tankGroupName: text(group?.name), subTankId: key, subTankName: text(tank?.name), tankName: [text(group?.name), text(tank?.name)].filter(Boolean).join(" / ") });
    }
  }
  const siteName = (siteId) => sites.get(siteId) || ({ nanjing: "南京", jiangyin: "江阴" })[siteId] || siteId;
  const current = (item) => {
    const tank = tanks.get(id(item?.subTankId));
    const siteId = tank?.siteId || text(item?.siteId) || defaultSite;
    return { siteId, siteName: siteName(siteId), tankName: tank?.tankName || "", subTankId: tank?.subTankId || "" };
  };
  const historical = (record, fallbackSiteId = "") => {
    const tank = tanks.get(id(record?.subTankId));
    const siteId = text(record?.siteId) || tank?.siteId || fallbackSiteId;
    const snapshotName = [text(record?.tankGroupName), text(record?.subTankName)].filter(Boolean).join(" / ");
    return { siteId, siteName: siteName(siteId), tankName: text(record?.tankName) || snapshotName || (tank?.siteId === siteId ? tank.tankName : "") };
  };
  return { tanks, siteName, current, historical };
}

/** Called only by the authoritative inventory mutation path after validation. */
export function preserveStockEntrySnapshot({ item, existing, tankGroups = [], sites = [], operator = "", recordedAt = new Date().toISOString() }) {
  const next = { ...item };
  // A client cannot introduce, replace, or backfill historical evidence.
  delete next.entrySnapshot;
  if (existing) {
    if (existing.entrySnapshot && typeof existing.entrySnapshot === "object") next.entrySnapshot = existing.entrySnapshot;
    return next;
  }
  const locations = locationIndex({ tankGroups, sites });
  const tank = locations.tanks.get(id(item?.subTankId));
  if (!tank) fail("初始入库缸位不存在", 409);
  next.entrySnapshot = {
    version: 1,
    recordedAt,
    inDate: text(item.inDate),
    ...tank,
    siteName: locations.siteName(tank.siteId),
    operator: text(operator),
  };
  return next;
}

const orderStatus = { pending: "未完成", confirmed: "已确认", shipped: "发货中", completed: "已完成", cancelled: "已取消", damaged: "已报损" };
const itemPrice = (value) => value !== "" && value != null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(Number(value).toFixed(2)) : null;

function contextFor(state, options) {
  const batchMatches = array(state.batches).filter((batch) => id(batch?.id) === options.batchId);
  if (batchMatches.length > 1) fail("采购批次编号不唯一", 409, "BATCH_HISTORY_ID_CONFLICT");
  const batch = batchMatches[0];
  if (!batch || (text(batch.siteId) || defaultSite) !== options.siteId) fail("采购批次不存在或无权查看", 404, "BATCH_NOT_FOUND");
  const visible = new Set(array(options.visibleSiteIds).map(text));
  if (!visible.has(options.siteId)) fail("不能查看未授权场地的采购批次", 403, "SITE_FORBIDDEN");
  const locations = locationIndex(state);
  const allStockById = uniqueById(state.stock, "库存鱼");
  const products = uniqueById(state.products, "商品");
  const species = uniqueById(state.species, "物种");
  const orderById = uniqueById(state.orders, "订单");
  const shipments = [...uniqueById(state.shipments, "发货单").values()];
  const bioRecords = [...uniqueById(state.bioRecords, "维护记录").values()];
  const lossRecords = [...uniqueById(state.lossRecords, "损耗记录").values()];
  const changes = array(state.approvalRequests).filter((request) => request?.status === "approved" && visible.has(text(request?.siteId) || defaultSite))
    .flatMap((request) => array(request?.stockDetails?.items).map((change) => ({ request, change })));
  const changesByStock = indexBy(changes, ({ change }) => id(change?.stockItemId));
  const candidateById = new Map([...allStockById].filter(([, item]) => id(item?.batchId) === options.batchId));
  // Only an explicit immutable batch snapshot can establish a deleted fish's
  // membership. Names, product IDs and public selection codes are not joins.
  for (const { change } of changes) {
    const snapshot = change.operation === "remove" ? change.before : change.after;
    const key = id(change.stockItemId);
    if (!key || allStockById.has(key) || candidateById.has(key) || id(snapshot?.batchId) !== options.batchId) continue;
    candidateById.set(key, { ...snapshot, id: key, code: text(snapshot.rawCode ?? snapshot.code), _removed: true });
  }
  for (const order of orderById.values()) {
    if (!visible.has(text(order?.siteId) || defaultSite)) continue;
    for (const item of array(order?.items)) {
      const key = id(item?.stockItemId);
      if (!key || allStockById.has(key) || candidateById.has(key) || id(item?.batchId) !== options.batchId) continue;
      candidateById.set(key, { id: key, batchId: options.batchId, productId: id(item.productId), code: text(item.fishCode), siteId: options.siteId, _removed: true });
    }
  }
  const visibleOrders = [...orderById.values()].filter((order) => visible.has(text(order?.siteId) || defaultSite));
  const visibleOrderIds = new Set(visibleOrders.map((order) => id(order?.id)));
  const visibleShipments = shipments.filter((shipment) => visibleOrderIds.has(id(shipment.orderId)));
  const shipmentsByStock = new Map();
  for (const shipment of visibleShipments) {
    const ids = new Set([...array(shipment.itemStockIds).map(id), ...array(shipment.damageReplacements).flatMap((relation) => [id(relation.originalStockItemId), id(relation.replacementStockItemId)])].filter(Boolean));
    for (const key of ids) {
      const rows = shipmentsByStock.get(key) ?? [];
      rows.push(shipment);
      shipmentsByStock.set(key, rows);
    }
  }
  const replacements = visibleShipments.flatMap((shipment) => array(shipment.damageReplacements).map((relation) => ({ shipment, relation })));
  const relationsByReplacement = indexBy(replacements, ({ relation }) => id(relation.replacementStockItemId));
  const salesByStock = new Map();
  const addSale = (key, sale) => { const rows = salesByStock.get(key) ?? []; rows.push(sale); salesByStock.set(key, rows); };
  for (const order of visibleOrders) {
    const lines = indexBy(array(order.items), (item) => id(item.stockItemId));
    for (const [key, matchingItems] of lines) {
      const replacement = (relationsByReplacement.get(key) ?? []).find(({ shipment }) => id(shipment.orderId) === id(order.id));
      const kind = replacement ? "replacement" : "sale";
      const price = replacement || matchingItems.length !== 1 ? null : itemPrice(matchingItems[0]?.price);
      addSale(key, {
        orderId: id(order.id), orderNo: text(order.orderNo), siteId: text(order.siteId) || defaultSite,
        date: replacement ? date(replacement.shipment.damagedAt) : date(order.date), price,
        status: text(order.status), statusLabel: orderStatus[order.status] || text(order.status), kind,
        note: replacement ? "补发沿用原订单，不是该鱼新成交；不将原单行价算作补发鱼售价"
          : matchingItems.length > 1 ? "同一订单存在重复鱼关联，无法确认单条价格"
          : price == null ? "未保存该鱼订单行价" : "订单商品行价，未分摊整单优惠、运费或退款",
      });
    }
  }
  for (const { shipment, relation } of replacements) {
    const originalId = id(relation.originalStockItemId);
    const order = orderById.get(id(shipment.orderId));
    if (!originalId || !order || (salesByStock.get(originalId) ?? []).some((sale) => sale.orderId === id(order.id))) continue;
    addSale(originalId, { orderId: id(order.id), orderNo: text(order.orderNo), siteId: text(order.siteId) || defaultSite, date: date(order.date), price: null, status: text(order.status), statusLabel: orderStatus[order.status] || text(order.status), kind: "originalReplaced", note: "原鱼已安排补发，原商品行已替换；未保留的原单条售价不能从补发总额推算" });
  }
  return { state, options, batch, visible, locations, candidateById, products, species, orderById, shipmentsByStock, replacements, salesByStock, changesByStock,
    bioByStock: indexBy(bioRecords, (record) => id(record.stockItemId)), lossByStock: indexBy(lossRecords, (record) => id(record.stockItemId)) };
}

function evidenceForFish(context, item) {
  const { visible, locations, options } = context;
  const key = id(item.id);
  const current = item._removed ? locations.historical(item, options.siteId) : locations.current(item);
  const currentVisible = visible.has(current.siteId);
  const visibleRecord = (record) => {
    const historicalSiteId = locations.historical(record).siteId;
    return historicalSiteId ? visible.has(historicalSiteId) : options.isAdmin === true;
  };
  const bio = (context.bioByStock.get(key) ?? []).filter(visibleRecord);
  const losses = (context.lossByStock.get(key) ?? []).filter(visibleRecord);
  const changes = context.changesByStock.get(key) ?? [];
  const addition = changes.filter(({ change }) => change.operation === "add" && id(change.after?.batchId) === options.batchId)
    .sort((a, b) => compareHistoryDate(a.request.resolvedAt, b.request.resolvedAt))[0];
  const entry = item.entrySnapshot && item.entrySnapshot.version === 1
    ? item.entrySnapshot
    : addition ? { ...addition.change.after, operator: addition.request.resolvedBy, recordedAt: addition.request.resolvedAt } : null;
  const entryLocation = entry ? locations.historical(entry, options.siteId) : { siteId: options.siteId, siteName: locations.siteName(options.siteId), tankName: "" };
  const entryVisible = visible.has(entryLocation.siteId);
  const sales = (context.salesByStock.get(key) ?? []).sort((a, b) => compareHistoryDate(a.date, b.date) || a.orderId.localeCompare(b.orderId));
  const shipments = context.shipmentsByStock.get(key) ?? [];
  const hasHiddenHistory = bio.length !== (context.bioByStock.get(key) ?? []).length || losses.length !== (context.lossByStock.get(key) ?? []).length;
  return { key, current, currentVisible, bio, losses, changes, entry, entryLocation, entryVisible, sales, shipments, hasHiddenHistory };
}

function rowForFish(context, item, evidence = evidenceForFish(context, item)) {
  const product = context.products.get(id(item.productId)) ?? {};
  const species = context.species.get(id(product.speciesId)) ?? {};
  const { key, current, currentVisible, bio, losses, entry, entryLocation, entryVisible, sales } = evidence;
  const status = !currentVisible ? "restricted" : item._removed ? "removed" : item.lost ? "lost" : item.sold || sales.some((sale) => sale.status !== "cancelled") ? "sold" : "inStock";
  const warnings = [];
  if (!entry || !entryVisible || !entryLocation.tankName) warnings.push("未留存可核实的初始入库缸位；当前缸位不代表初始缸位");
  if (!currentVisible) warnings.push("该鱼当前信息及部分历史不在账户可见范围内，已隐藏");
  else if (evidence.hasHiddenHistory) warnings.push("部分历史记录归属未知或不在账户可见范围内，已隐藏");
  if (currentVisible && item.sold && sales.length === 0) warnings.push("已售标记缺少可查看的原订单关联，不能推算成交时间和价格");
  if (item._removed) warnings.push("原库存记录已删除，仅展示留存快照及可核实关联");
  if (!id(item.productId) || !context.products.has(id(item.productId))) warnings.push("商品档案已缺失，无法补全未保存的商品信息");
  const latestLoss = [...losses].sort((a, b) => compareHistoryDate(b.date, a.date))[0];
  const tankKey = !currentVisible ? "restricted" : item._removed ? "removed" : !current.subTankId ? "unknown"
    : `tank:${encodeURIComponent(current.siteId)}:${encodeURIComponent(current.subTankId)}`;
  return {
    stockItemId: key, code: text(item.code), productName: text(product.name) || text(item.productName) || "商品档案缺失",
    speciesName: text(species.name) || text(item.speciesName), size: text(product.size) || text(item.size), origin: text(product.origin) || text(item.origin),
    status, statusLabel: { inStock: "在库", sold: "已售", lost: "已损耗", removed: "记录已删除", restricted: "记录受限" }[status],
    inDate: text(entry?.inDate) || text(item.inDate), initialTankName: entryVisible ? entryLocation.tankName : "",
    currentTankName: currentVisible && !item._removed ? current.tankName : "", currentSiteName: currentVisible && !item._removed ? current.siteName : "",
    currentSubTankId: currentVisible && !item._removed ? current.subTankId : "", tankKey,
    sales, lossDate: date(latestLoss?.date) || (currentVisible && !(context.lossByStock.get(key) ?? []).length ? date(item.lossDate) : ""), recordCount: bio.length, bioRecordCount: bio.length, warnings,
  };
}

export function buildPurchaseBatchDetail(state, options) {
  const context = contextFor(state, options);
  const rows = [...context.candidateById.values()].map((item) => rowForFish(context, item));
  const summary = { total: rows.length, inStock: 0, sold: 0, lost: 0, removed: 0, restricted: 0 };
  rows.forEach((row) => { summary[row.status] += 1; });
  const query = text(options.search).toLocaleLowerCase();
  const filtered = rows.filter((row) => (!options.status || options.status === "all" || row.status === options.status)
    && (!query || [row.stockItemId, row.code, row.productName, row.speciesName, row.size, row.origin, row.currentSiteName, row.currentTankName, ...row.sales.map((sale) => sale.orderNo)].some((value) => text(value).toLocaleLowerCase().includes(query))))
    .sort((a, b) => a.inDate.localeCompare(b.inDate) || a.code.localeCompare(b.code, "zh-Hans-CN", { numeric: true }) || a.stockItemId.localeCompare(b.stockItemId));
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  const tankGroups = new Map();
  for (const row of filtered) {
    if (!tankGroups.has(row.tankKey)) tankGroups.set(row.tankKey, {
      key: row.tankKey,
      siteName: row.tankKey.startsWith("tank:") ? row.currentSiteName : "",
      tankName: row.tankKey.startsWith("tank:") ? row.currentTankName : ({ restricted: "记录受限", removed: "记录已删除", unknown: "缸位未记录" })[row.tankKey],
      total: 0, inStock: 0, sold: 0, lost: 0, removed: 0, restricted: 0,
    });
    const group = tankGroups.get(row.tankKey);
    group.total += 1;
    group[row.status] += 1;
  }
  const tanks = [...tankGroups.values()].sort((a, b) => Number(!a.key.startsWith("tank:")) - Number(!b.key.startsWith("tank:"))
    || a.siteName.localeCompare(b.siteName, "zh-Hans-CN") || a.tankName.localeCompare(b.tankName, "zh-Hans-CN", { numeric: true }) || a.key.localeCompare(b.key));
  const selected = options.tankKey ? filtered.filter((row) => row.tankKey === options.tankKey) : filtered;
  return { ok: true, batch: { id: id(context.batch.id), batchNo: text(context.batch.batchNo), supplier: text(context.batch.supplier), arrivalDate: date(context.batch.arrivalDate), siteId: options.siteId, siteName: context.locations.siteName(options.siteId) }, summary,
    tanks, items: selected.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: selected.length,
    warnings: ["仅展示系统当前留存且有明确鱼只关联的记录；历史已删除且无快照的入库或退单明细无法还原"] };
}

const shipmentStatus = { preparing: "待出库", outbound: "已出库", shipped: "已发货", delivered: "已签收", damaged: "物流报损" };
const paymentType = { deposit: "定金", balance: "尾款", shipping_fee: "运费", refund: "退款", other: "其他" };
const money = (value) => value !== "" && value != null && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(2)) : null;

/** Read-only, explicit allowlist: never spread customer/order/payment snapshots. */
export function buildPurchaseBatchOrderDetail(state, options, feeBreakdownForOrder) {
  const context = contextFor(state, options);
  const order = context.orderById.get(options.orderId);
  const orderSiteId = text(order?.siteId) || defaultSite;
  if (!order || !context.visible.has(orderSiteId)) fail("订单不存在或无权查看", 404, "BATCH_ORDER_NOT_FOUND");
  const batchFishIds = new Set(context.candidateById.keys());
  const shipments = [...uniqueById(state.shipments, "发货单").values()].filter((shipment) => id(shipment.orderId) === id(order.id));
  const isBatchFish = (key) => batchFishIds.has(id(key));
  const directlyRelated = array(order.items).some((item) => isBatchFish(item.stockItemId));
  const shipmentRelated = shipments.some((shipment) => array(shipment.itemStockIds).some(isBatchFish)
    || array(shipment.damageReplacements).some((relation) => isBatchFish(relation.originalStockItemId) || isBatchFish(relation.replacementStockItemId)));
  // Check the explicit ID join again in memory: SQL projection is not authority.
  if (!directlyRelated && !shipmentRelated) fail("订单不属于该采购批次或无权查看", 404, "BATCH_ORDER_NOT_FOUND");
  const replacements = new Set(shipments.flatMap((shipment) => array(shipment.damageReplacements).map((relation) => id(relation.replacementStockItemId))));
  const linesByStock = indexBy(array(order.items), (item) => id(item.stockItemId));
  const warnings = ["金额为整张订单口径，未分摊到本采购批次或单条鱼；商品名称和规格优先使用订单快照，缺失时参考现存商品档案"];
  if (!directlyRelated) warnings.push("本批次通过发货或原鱼补发记录关联此订单；当前商品行可能已替换为其他批次的补发鱼");
  if (order.status === "cancelled") warnings.push("该订单已取消，以下是留存账单及资金记录，不代表仍需收款");
  const items = array(order.items).map((item) => {
    const product = context.products.get(id(item.productId)) ?? {};
    const species = context.species.get(id(product.speciesId)) ?? {};
    const kind = replacements.has(id(item.stockItemId)) ? "replacement" : "sale";
    const price = itemPrice(item.price);
    const notes = [];
    if (kind === "replacement") notes.push("账单行沿用原鱼价格，不是补发鱼的新成交价");
    if (price == null) notes.push("订单未留存有效行价，不使用商品现价补填");
    if ((linesByStock.get(id(item.stockItemId)) ?? []).length > 1) notes.push("同一鱼关联了多条账单行，不能作为单条鱼的唯一成交价");
    return { stockItemId: id(item.stockItemId), code: text(item.fishCode) || text(item.code), productName: text(item.productName) || text(product.name) || "商品档案缺失",
      speciesName: text(item.speciesName) || text(species.name), size: text(item.size) || text(product.size), origin: text(item.origin) || text(product.origin),
      price, isBatchFish: isBatchFish(item.stockItemId), kind, note: notes.join("；") };
  });
  if (items.some((item) => item.price == null)) warnings.push("部分订单行价缺失，商品合计和应收余额无法可靠还原");
  if (typeof feeBreakdownForOrder !== "function") fail("订单金额计算未配置", 500);
  // The route supplies the existing authoritative shipping/damage fee rules.
  // This feature does not introduce a second receivable calculation.
  const fees = feeBreakdownForOrder(order, shipments);
  const totals = Object.fromEntries(["itemSubtotal", "discount", "goodsNetTotal", "packagingFee", "billableShippingFee", "customerShippingFee", "damageRefundAdjustment", "calculatedReceivable"].map((key) => [key, money(fees?.[key])]));
  if (items.some((item) => item.price == null)) for (const key of ["itemSubtotal", "goodsNetTotal", "calculatedReceivable"]) totals[key] = null;
  const verified = verifiedPaymentTotals(order.payments);
  const received = money(verified.received);
  const refunded = money(verified.refunded);
  const netReceived = money(received - refunded);
  Object.assign(totals, { shippingFeeMode: text(fees?.shippingFeeMode), received, refunded, netReceived,
    pendingReceived: money(verified.pendingReceived), pendingRefunded: money(verified.pendingRefunded),
    balance: totals.calculatedReceivable == null ? null : money(totals.calculatedReceivable - netReceived) });
  const customers = uniqueById(state.customers, "客户");
  const customer = customers.get(id(order.customerId));
  const payments = array(order.payments).map((payment) => ({ id: id(payment.id), date: date(payment.time || payment.date), type: text(payment.type),
    typeLabel: paymentType[payment.type] || "资金记录", amount: itemPrice(payment.amount), verificationStatus: paymentVerificationStatus(payment) }))
    .sort((a, b) => compareHistoryDate(a.date, b.date) || a.id.localeCompare(b.id));
  const shipping = shipments.map((shipment) => ({ id: id(shipment.id), status: text(shipment.status), statusLabel: shipmentStatus[shipment.status] || text(shipment.status),
    shipMethod: text(shipment.shipMethod), carrier: text(shipment.carrier), trackingNo: text(shipment.trackingNo),
    itemCount: new Set(array(shipment.itemStockIds).map(id).filter(Boolean)).size,
    batchFishCount: new Set(array(shipment.itemStockIds).map(id).filter(isBatchFish)).size,
    createdAt: date(shipment.createdAt), outboundDate: date(shipment.outboundDate), shipDate: date(shipment.shipDate), shippedAt: date(shipment.shippedAt),
    deliveredAt: date(shipment.deliveredAt), damagedAt: date(shipment.damagedAt), actualShippingFee: itemPrice(shipment.actualShippingFee),
    damageResolution: text(shipment.damageResolution), damageRefundAmount: itemPrice(shipment.damageRefundAmount) }))
    .sort((a, b) => compareHistoryDate(a.createdAt || a.outboundDate || a.shipDate, b.createdAt || b.outboundDate || b.shipDate) || a.id.localeCompare(b.id));
  return { ok: true, batch: { id: id(context.batch.id), batchNo: text(context.batch.batchNo), siteId: options.siteId, siteName: context.locations.siteName(options.siteId) },
    order: { id: id(order.id), orderNo: text(order.orderNo), siteId: orderSiteId, siteName: context.locations.siteName(orderSiteId), date: date(order.date),
      status: text(order.status), statusLabel: orderStatus[order.status] || text(order.status), customerName: text(customer?.name) || text(order.customerName), source: text(order.source),
      items, totals, payments, shipments: shipping, warnings } };
}

function safeMedia(value) {
  return array(value).map(text).filter((url) => /^https?:\/\//i.test(url) || url.startsWith("/uploads/") || /^data:(image|video)\//i.test(url));
}

export function buildPurchaseBatchFishHistory(state, options) {
  const context = contextFor(state, options);
  const item = context.candidateById.get(options.stockItemId);
  if (!item) fail("该鱼不存在于指定采购批次或无权查看", 404, "BATCH_FISH_NOT_FOUND");
  const evidence = evidenceForFish(context, item);
  const fish = rowForFish(context, item, evidence);
  const events = [];
  const add = (event) => events.push({ text: "", siteName: "", tankName: "", operator: "", photos: [], videos: [], ...event });
  add({ id: `stock-in:${fish.stockItemId}`, type: "stockIn", date: fish.inDate, title: "入库", text: fish.initialTankName ? `初始入库：${fish.initialTankName}` : "未留存可核实的初始缸位", siteName: evidence.entryVisible ? evidence.entryLocation.siteName : "", tankName: fish.initialTankName, operator: evidence.entryVisible ? text(evidence.entry?.operator) : "" });
  for (const record of evidence.bio) {
    const recordLocation = context.locations.historical(record);
    const isMove = record.sourceType === "stockMove" || /^移缸[：:]/.test(text(record.text));
    const fromSiteId = text(record.fromSiteId);
    const toSiteId = text(record.toSiteId) || recordLocation.siteId;
    const canShowMoveText = options.isAdmin || (fromSiteId && context.visible.has(fromSiteId) && context.visible.has(toSiteId));
    const recordText = isMove && !canShowMoveText ? "移缸记录；未授权或未结构化保存的历史位置已隐藏" : text(record.text);
    add({ id: `bio:${record.id}`, type: isMove ? "move" : "maintenance", date: date(record.date), title: isMove ? "移缸" : record.sourceType === "dailyLog" ? "缸组养护" : "观察 / 治疗记录", text: recordText, ...recordLocation, operator: text(record.operator), photos: safeMedia(record.photos), videos: safeMedia(record.videos) });
  }
  for (const sale of evidence.sales) {
    const timeNote = sale.kind === "replacement" ? "时间为补发关联登记时间。"
      : sale.status === "cancelled" ? "时间为下单时间，取消时间未单独记录。" : "时间为下单时间。";
    add({ id: `sale:${sale.orderId}:${sale.kind}`, type: "sale", date: sale.date, title: sale.kind === "replacement" ? "作为补发关联订单" : sale.kind === "originalReplaced" ? "原销售订单（已安排补发）" : sale.status === "cancelled" ? "下单（订单现已取消）" : "关联销售订单", text: `${timeNote}${sale.statusLabel}。${sale.note}`, siteName: context.locations.siteName(sale.siteId), orderSiteId: sale.siteId, orderId: sale.orderId, orderNo: sale.orderNo, price: sale.price });
  }
  for (const shipment of evidence.shipments) {
    const order = context.orderById.get(id(shipment.orderId));
    if (!order) continue;
    const siteId = text(order.siteId) || defaultSite;
    const common = { type: "shipment", text: `${shipment.shipMethod === "pickup" ? "自提" : text(shipment.carrier) || "快递"}${shipment.trackingNo ? ` · ${text(shipment.trackingNo)}` : ""}`, siteName: context.locations.siteName(siteId), orderSiteId: siteId, orderId: id(order.id), orderNo: text(order.orderNo) };
    const physical = array(shipment.itemStockIds).some((value) => id(value) === fish.stockItemId);
    if (!physical) {
      add({ ...common, id: `shipment:${shipment.id}:replacement`, date: date(shipment.damagedAt), title: "原鱼报损，安排本鱼补发", text: "这是补发关联记录；本鱼实际出库以包含它的发货单为准" });
      continue;
    }
    if (shipment.status === "preparing") {
      add({ ...common, id: `shipment:${shipment.id}:preparing`, date: date(shipment.createdAt), title: "待出库", text: `计划日期：${date(shipment.shipDate) || "未填写"}` });
      continue;
    }
    if (shipment.outboundDate || shipment.createdAt) {
      add({ ...common, id: `shipment:${shipment.id}:outbound`, date: date(shipment.outboundDate || shipment.createdAt), title: "出库", photos: safeMedia(shipment.packingProof) });
    }
    if (["shipped", "delivered", "damaged"].includes(shipment.status)) {
      add({ ...common, id: `shipment:${shipment.id}:shipped`, date: date(shipment.shippedAt || shipment.shipDate), title: shipment.shipMethod === "pickup" ? "自提交付" : "发货" });
    }
    if (shipment.status === "delivered") add({ ...common, id: `shipment:${shipment.id}:delivered`, date: date(shipment.deliveredAt), title: "签收" });
    if (shipment.status === "damaged") add({ ...common, id: `shipment:${shipment.id}:damaged`, date: date(shipment.damagedAt), title: "物流报损", text: shipment.damageResolution === "reship" ? "报损后补发" : shipment.damageResolution === "refund" ? "报损后退款；整单或多鱼退款金额不作为本鱼单价" : "物流报损", photos: safeMedia(shipment.damageProof) });
  }
  for (const loss of evidence.losses) {
    add({ id: `loss:${loss.id}`, type: "loss", date: date(loss.date), title: "损耗", text: text(loss.reason), ...context.locations.historical(loss), operator: text(loss.operator), photos: safeMedia(loss.proofPhotos) });
  }
  if (evidence.currentVisible && item.lost && !(context.lossByStock.get(fish.stockItemId) ?? []).length) {
    add({ id: `loss:legacy:${fish.stockItemId}`, type: "loss", date: date(item.lossDate), title: "损耗（库存留存信息）", text: `${text(item.lossReason)}${item.lossReason ? "。" : ""}未留存独立损耗事件，发生缸位无法核实`, photos: safeMedia(item.lossProof) });
  }
  for (const { request, change } of evidence.changes) {
    if (change.operation === "add") continue;
    const snapshot = change.operation === "remove" ? change.before : change.after;
    const eventLocation = context.locations.historical(snapshot, text(request.siteId) || options.siteId);
    if (!context.visible.has(eventLocation.siteId)) continue;
    add({ id: `change:${request.id}:${fish.stockItemId}`, type: "change", date: date(request.resolvedAt), title: change.operation === "remove" ? "库存记录删除" : "库存信息修改", text: "已批准并执行的库存变更", ...eventLocation, operator: text(request.resolvedByName || request.resolvedBy) });
  }
  events.sort((a, b) => compareHistoryDate(a.date, b.date) || a.id.localeCompare(b.id));
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 100;
  return { ok: true, stockItemId: fish.stockItemId, fish, events: events.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: events.length, warnings: fish.warnings };
}
