import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import pg from "pg";
import COS from "cos-nodejs-sdk-v5";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = join(root, ".data");
const legacyStateFile = join(dataDir, "fishroom-state.json");
const distDir = join(root, "dist");
const uploadDir = process.env.UPLOAD_DIR || join(root, "uploads");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || process.env.LOCAL_API_PORT || 8787);
const stateId = "main";
const MAX_OPERATION_LOGS = 10000;
const DEFAULT_FINANCE_DAYS = 30;
const MIN_FINANCE_DAYS = 7;
const MAX_FINANCE_DAYS = 730;
const DEFAULT_SITE_ID = "nanjing";
const ALL_SITE_ID = "all";
const DEFAULT_SITES = [
  { id: "jiangyin", name: "江阴" },
  { id: "nanjing", name: "南京" },
];
const cosConfig = {
  secretId: process.env.COS_SECRET_ID || "",
  secretKey: process.env.COS_SECRET_KEY || "",
  bucket: process.env.COS_BUCKET || "",
  region: process.env.COS_REGION || "",
  publicBaseUrl: String(process.env.COS_PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
  prefix: String(process.env.COS_PREFIX || "fishroom").replace(/^\/+|\/+$/g, ""),
};
let cosClient;
const STATE_KEYS = [
  "sites",
  "personnel",
  "operationLogs",
  "species",
  "speciesCategories",
  "products",
  "productOrigins",
  "tankGroups",
  "batches",
  "stock",
  "lossRecords",
  "logs",
  "checks",
  "bioRecords",
  "orders",
  "shipments",
  "customers",
  "customerSources",
];
const STATE_KEY_SET = new Set(STATE_KEYS);

const pgConfig = {
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || process.env.POSTGRES_DB || "fishroom",
  user: process.env.PGUSER || process.env.POSTGRES_USER || "fishroom",
  password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "fishroom_local_password",
};

const { Pool } = pg;
const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : pgConfig
);
let schemaReady;

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function acceptsGzip(req) {
  return /\bgzip\b/i.test(req.headers["accept-encoding"] || "");
}

function sendJson(req, res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  if (acceptsGzip(req) && payload.length > 1024) {
    res.writeHead(status, {
      ...jsonHeaders,
      "Content-Encoding": "gzip",
      "Vary": "Accept-Encoding",
    });
    const gzip = createGzip();
    gzip.pipe(res);
    gzip.end(payload);
    return;
  }

  res.writeHead(status, jsonHeaders);
  res.end(payload);
}

function uid(prefix = "log") {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function mergeProductOrigins(origins = [], products = []) {
  const merged = [];
  const add = (value) => {
    const origin = String(value ?? "").trim();
    if (origin && !merged.includes(origin)) merged.push(origin);
  };
  if (Array.isArray(origins)) origins.forEach(add);
  if (Array.isArray(products)) products.forEach((product) => add(product?.origin));
  return merged;
}

function normalizeSiteId(value) {
  const id = String(value ?? "").trim();
  return id || DEFAULT_SITE_ID;
}

function normalizeSiteScope(value) {
  const id = String(value ?? "").trim();
  return id === ALL_SITE_ID ? ALL_SITE_ID : normalizeSiteId(id);
}

function matchesSite(item, siteId) {
  if (siteId === ALL_SITE_ID) return true;
  return normalizeSiteId(item?.siteId) === siteId;
}

function siteFilteredState(state = {}, siteId = ALL_SITE_ID) {
  const scope = normalizeSiteScope(siteId);
  if (scope === ALL_SITE_ID) return state;
  const tankGroups = (Array.isArray(state.tankGroups) ? state.tankGroups : []).filter((item) => matchesSite(item, scope));
  const subTankIds = new Set(tankGroups.flatMap((group) =>
    (Array.isArray(group?.subTanks) ? group.subTanks : []).map((tank) => String(tank?.id ?? "")).filter(Boolean)
  ));
  const orders = (Array.isArray(state.orders) ? state.orders : []).filter((item) => matchesSite(item, scope));
  const orderIds = new Set(orders.map((order) => String(order?.id ?? "")).filter(Boolean));
  const stock = (Array.isArray(state.stock) ? state.stock : []).filter((item) =>
    matchesSite(item, scope) || subTankIds.has(String(item?.subTankId ?? ""))
  );
  const stockIds = new Set(stock.map((item) => String(item?.id ?? "")).filter(Boolean));
  return {
    ...state,
    tankGroups,
    batches: (Array.isArray(state.batches) ? state.batches : []).filter((item) => matchesSite(item, scope)),
    stock,
    logs: (Array.isArray(state.logs) ? state.logs : []).filter((item) =>
      matchesSite(item, scope) || subTankIds.has(String(item?.subTankId ?? ""))
    ),
    checks: (Array.isArray(state.checks) ? state.checks : []).filter((item) =>
      matchesSite(item, scope) || subTankIds.has(String(item?.subTankId ?? ""))
    ),
    lossRecords: (Array.isArray(state.lossRecords) ? state.lossRecords : []).filter((item) =>
      matchesSite(item, scope) || stockIds.has(String(item?.stockItemId ?? ""))
    ),
    bioRecords: (Array.isArray(state.bioRecords) ? state.bioRecords : []).filter((item) =>
      matchesSite(item, scope) || stockIds.has(String(item?.stockItemId ?? ""))
    ),
    orders,
    shipments: (Array.isArray(state.shipments) ? state.shipments : []).filter((item) =>
      matchesSite(item, scope) || orderIds.has(String(item?.orderId ?? ""))
    ),
  };
}

function refreshBatchStockCounts(batches = [], stock = []) {
  if (!Array.isArray(batches)) return batches;
  const stockList = Array.isArray(stock) ? stock : [];
  return batches.map((batch) => ({
    ...batch,
    stockedCount: stockList.filter((item) => item?.batchId === batch.id).length,
    lossCount: stockList.filter((item) => item?.batchId === batch.id && item?.lost).length,
  }));
}

function preserveMissingById(currentItems, incomingItems, label) {
  if (!Array.isArray(currentItems) || !Array.isArray(incomingItems)) return incomingItems;
  const incomingIds = new Set(incomingItems.map((item) => item?.id).filter(Boolean));
  const preserved = currentItems.filter((item) => item?.id && !incomingIds.has(item.id));
  if (preserved.length > 0) {
    console.warn(`Preserved ${preserved.length} ${label}(s) missing from generic state POST`);
  }
  return preserved.length > 0 ? [...incomingItems, ...preserved] : incomingItems;
}

function mergeStockFromGenericPost(currentItems, incomingItems) {
  if (!Array.isArray(currentItems) || !Array.isArray(incomingItems)) return incomingItems;
  if (currentItems.length === 0) return incomingItems;

  const incomingById = new Map(
    incomingItems
      .filter((item) => item?.id)
      .map((item) => [String(item.id), item])
  );

  return currentItems.map((currentItem) => {
    const incomingItem = incomingById.get(String(currentItem?.id ?? ""));
    if (!incomingItem) return currentItem;

    const next = { ...currentItem };
    if (["healthy", "feeding", "sick"].includes(incomingItem.status)) next.status = incomingItem.status;
    if (Object.prototype.hasOwnProperty.call(incomingItem, "sold")) next.sold = Boolean(incomingItem.sold);
    if (Object.prototype.hasOwnProperty.call(incomingItem, "notes")) next.notes = String(incomingItem.notes ?? "");
    return next;
  });
}

function mergeOperationLogsForGenericPost(currentLogs = [], incomingLogs = []) {
  const seen = new Set();
  return [
    ...(Array.isArray(incomingLogs) ? incomingLogs : []),
    ...(Array.isArray(currentLogs) ? currentLogs : []),
  ]
    .filter((log) => {
      const id = String(log?.id ?? "");
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => String(b?.time ?? "").localeCompare(String(a?.time ?? "")))
    .slice(0, MAX_OPERATION_LOGS);
}

function parseStateKeys(value = "") {
  const keys = String(value)
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const invalid = keys.filter((key) => !STATE_KEY_SET.has(key));
  if (invalid.length > 0) throw new Error(`Invalid state key(s): ${invalid.join(", ")}`);
  return [...new Set(keys)];
}

function pickState(data = {}, keys = [], options = {}) {
  return keys.reduce((picked, key) => {
    if (key === "species" && options.liteSpecies && Array.isArray(data?.species)) {
      picked[key] = data.species.map((item) => ({
        id: item?.id ?? "",
        name: item?.name ?? "",
        scientificName: item?.scientificName ?? "",
        category: item?.category ?? "",
        commonNames: Array.isArray(item?.commonNames) ? item.commonNames : [],
        description: "",
        imageUrl: "",
      }));
    } else {
      picked[key] = data?.[key] ?? null;
    }
    return picked;
  }, {});
}

function getObjectId(item) {
  const id = item && typeof item === "object" ? item.id : undefined;
  return id === undefined || id === null || id === "" ? "" : String(id);
}

function hasObjectIds(items) {
  return Array.isArray(items) && items.some((item) => getObjectId(item));
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

function applyObjectDiff(currentItem = {}, baseItem = {}, incomingItem = {}) {
  if (!currentItem || typeof currentItem !== "object") return incomingItem;
  if (!baseItem || typeof baseItem !== "object") return incomingItem;
  if (!incomingItem || typeof incomingItem !== "object") return currentItem;

  const next = { ...currentItem };
  const keys = new Set([...Object.keys(baseItem), ...Object.keys(incomingItem)]);
  for (const key of keys) {
    if (key === "id") continue;
    const baseValue = baseItem[key];
    const incomingValue = incomingItem[key];
    if (stableJson(baseValue) !== stableJson(incomingValue)) {
      if (Object.prototype.hasOwnProperty.call(incomingItem, key)) next[key] = incomingValue;
      else delete next[key];
    }
  }
  return next;
}

function mergeIdArrayPatch(currentItems, baseItems, incomingItems) {
  if (!hasObjectIds(currentItems) && !hasObjectIds(baseItems) && !hasObjectIds(incomingItems)) {
    return incomingItems;
  }
  const current = Array.isArray(currentItems) ? currentItems : [];
  const base = Array.isArray(baseItems) ? baseItems : [];
  const incoming = Array.isArray(incomingItems) ? incomingItems : [];
  const baseById = new Map(base.map((item) => [getObjectId(item), item]).filter(([id]) => id));
  const incomingById = new Map(incoming.map((item) => [getObjectId(item), item]).filter(([id]) => id));
  const currentIds = new Set(current.map(getObjectId).filter(Boolean));

  const merged = [];
  for (const currentItem of current) {
    const id = getObjectId(currentItem);
    if (!id) {
      merged.push(currentItem);
      continue;
    }
    const baseItem = baseById.get(id);
    const incomingItem = incomingById.get(id);
    if (baseItem && !incomingItem) continue;
    if (incomingItem) {
      merged.push(baseItem ? applyObjectDiff(currentItem, baseItem, incomingItem) : incomingItem);
    } else {
      merged.push(currentItem);
    }
  }

  for (const incomingItem of incoming) {
    const id = getObjectId(incomingItem);
    if (id && !currentIds.has(id)) merged.push(incomingItem);
  }
  return merged;
}

function mergeIdArrayPreserveMissing(currentItems, incomingItems) {
  if (!hasObjectIds(currentItems) && !hasObjectIds(incomingItems)) return incomingItems;
  const current = Array.isArray(currentItems) ? currentItems : [];
  const incoming = Array.isArray(incomingItems) ? incomingItems : [];
  const incomingIds = new Set(incoming.map(getObjectId).filter(Boolean));
  return [
    ...incoming,
    ...current.filter((item) => {
      const id = getObjectId(item);
      return id && !incomingIds.has(id);
    }),
  ];
}

function mergeIncomingState(current = {}, incoming = {}) {
  const next = { ...incoming };
  if (Array.isArray(current.stock) && Array.isArray(incoming.stock)) {
    next.stock = mergeStockFromGenericPost(current.stock, incoming.stock);
    next.batches = refreshBatchStockCounts(incoming.batches, next.stock);
  }
  if (Array.isArray(current.lossRecords) && Array.isArray(incoming.lossRecords)) {
    next.lossRecords = current.lossRecords;
  }
  if (Array.isArray(current.operationLogs) && Array.isArray(incoming.operationLogs)) {
    next.operationLogs = mergeOperationLogsForGenericPost(current.operationLogs, incoming.operationLogs);
  }
  if (Array.isArray(current.tankGroups) && Array.isArray(incoming.tankGroups)) {
    next.tankGroups = current.tankGroups;
  }
  if (Array.isArray(current.logs) && Array.isArray(incoming.logs)) {
    next.logs = current.logs;
  }
  for (const key of ["species", "products", "batches", "bioRecords", "customers", "orders", "shipments", "personnel"]) {
    if (Array.isArray(current[key]) && Array.isArray(incoming[key])) {
      next[key] = mergeIdArrayPreserveMissing(current[key], incoming[key]);
    }
  }
  return next;
}

function shippedOutStockIds(state = {}) {
  return new Set(
    (Array.isArray(state.shipments) ? state.shipments : [])
      .filter((shipment) => shipment?.status !== "preparing")
      .flatMap((shipment) => Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds : [])
      .map(String)
  );
}

function isPhysicallyInTank(item, shippedIds) {
  return item && !item.lost && !shippedIds.has(String(item.id));
}

function todayInChina() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function nowDatetimeInChina() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

function addDaysToDateString(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseFinanceDays(value) {
  const days = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(days)) return DEFAULT_FINANCE_DAYS;
  return Math.min(MAX_FINANCE_DAYS, Math.max(MIN_FINANCE_DAYS, days));
}

function isFishCategory(category = "") {
  if (/(活石|活性炭|吸附|滤材|耗材|器材|设备|材料|药|盐|饲料|鱼粮|试剂)/.test(category)) return false;
  if (category.includes("虾虎") || category.includes("鰕虎")) return true;
  return !/(虾|蟹|螺|贝|海胆|珊瑚|海星|海葵)/.test(category);
}

function buildLossRows(state = {}, productById = new Map(), speciesById = new Map()) {
  const stock = Array.isArray(state.stock) ? state.stock : [];
  const lossRecords = Array.isArray(state.lossRecords) ? state.lossRecords : [];
  const explicitIds = new Set(lossRecords.map((record) => String(record?.stockItemId ?? "")).filter(Boolean));
  const fallbackRecords = stock
    .filter((item) => item?.lost && !explicitIds.has(String(item?.id ?? "")))
    .map((item) => ({
      id: `loss-${item.id}`,
      stockItemId: item.id,
      date: item.lossDate ?? item.inDate,
      reason: item.lossReason ?? "",
      proofPhotos: Array.isArray(item.lossProof) ? item.lossProof : [],
      operator: "",
    }));

  return [...lossRecords, ...fallbackRecords]
    .map((record) => {
      const stockItem = stock.find((item) => String(item?.id ?? "") === String(record?.stockItemId ?? ""));
      const product = stockItem ? productById.get(stockItem.productId) : null;
      const itemSpecies = product ? speciesById.get(product.speciesId) : null;
      return {
        record,
        stockItem,
        product,
        species: itemSpecies,
        date: String(record?.date ?? stockItem?.lossDate ?? "").slice(0, 10),
        estimatedValue: Number(stockItem?.basePrice ?? product?.defaultPrice ?? 0),
        isFish: isFishCategory(itemSpecies?.category ?? ""),
      };
    })
    .filter((row) => row.date && row.stockItem && row.isFish);
}

function buildDailyLossData(state = {}, dates = [], productById = new Map(), speciesById = new Map()) {
  const stock = Array.isArray(state.stock) ? state.stock : [];
  const shipments = Array.isArray(state.shipments) ? state.shipments : [];
  const lossRows = buildLossRows(state, productById, speciesById);
  const lossDateByStockId = new Map();
  for (const row of lossRows) {
    const stockId = String(row.stockItem?.id ?? "");
    if (!stockId) continue;
    const current = lossDateByStockId.get(stockId);
    if (!current || row.date < current) lossDateByStockId.set(stockId, row.date);
  }
  for (const item of stock) {
    const stockId = String(item?.id ?? "");
    const itemLossDate = String(item?.lossDate ?? "").slice(0, 10);
    if (!stockId || !itemLossDate) continue;
    const current = lossDateByStockId.get(stockId);
    if (!current || itemLossDate < current) lossDateByStockId.set(stockId, itemLossDate);
  }

  const shippedDateByStockId = new Map();
  for (const shipment of shipments) {
    if (!shipment || shipment.status === "preparing") continue;
    const date = String(shipment.shipDate ?? shipment.outboundDate ?? shipment.createdAt ?? "").slice(0, 10);
    if (!date) continue;
    for (const rawId of Array.isArray(shipment.itemStockIds) ? shipment.itemStockIds : []) {
      const stockId = String(rawId ?? "");
      if (!stockId) continue;
      const current = shippedDateByStockId.get(stockId);
      if (!current || date < current) shippedDateByStockId.set(stockId, date);
    }
  }

  const fishStock = stock.filter((item) => {
    const product = productById.get(item?.productId);
    const itemSpecies = product ? speciesById.get(product.speciesId) : undefined;
    return isFishCategory(itemSpecies?.category ?? "");
  });

  return dates.map((date) => {
    const seenLossIds = new Set();
    const rowsForDate = lossRows.filter((row) => {
      const stockId = String(row.stockItem?.id ?? "");
      if (row.date !== date || !stockId || seenLossIds.has(stockId)) return false;
      seenLossIds.add(stockId);
      return true;
    });
    const stockBase = fishStock.filter((item) => {
      const stockId = String(item?.id ?? "");
      const inDate = String(item?.inDate ?? "").slice(0, 10);
      if (!stockId || !inDate || inDate > date) return false;
      const lossDate = lossDateByStockId.get(stockId);
      if (lossDate && lossDate < date) return false;
      const shippedDate = shippedDateByStockId.get(stockId);
      if (shippedDate && shippedDate < date) return false;
      return true;
    }).length;
    const lostCount = rowsForDate.length;
    const estimatedValue = rowsForDate.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0);
    return {
      date,
      label: date.slice(5).replace("-", "/"),
      lostCount,
      stockBase,
      lossRate: stockBase > 0 ? lostCount / stockBase * 100 : 0,
      estimatedValue,
    };
  });
}

function buildDashboardSummary(state = {}, options = {}) {
  const today = todayInChina();
  const financeDays = parseFinanceDays(options.financeDays);
  const siteId = normalizeSiteScope(options.siteId);
  const scopedState = siteFilteredState(state, siteId);
  const shippedIds = shippedOutStockIds(scopedState);
  const products = Array.isArray(scopedState.products) ? scopedState.products : [];
  const species = Array.isArray(scopedState.species) ? scopedState.species : [];
  const stock = Array.isArray(scopedState.stock) ? scopedState.stock : [];
  const tankGroups = Array.isArray(scopedState.tankGroups) ? scopedState.tankGroups : [];
  const orders = Array.isArray(scopedState.orders) ? scopedState.orders : [];
  const shipments = Array.isArray(scopedState.shipments) ? scopedState.shipments : [];
  const productById = new Map(products.map((product) => [product?.id, product]));
  const speciesById = new Map(species.map((item) => [item?.id, item]));
  const inTankFishStock = stock
    .filter((item) => isPhysicallyInTank(item, shippedIds))
    .filter((item) => {
      const product = productById.get(item?.productId);
      const itemSpecies = product ? speciesById.get(product.speciesId) : undefined;
      return isFishCategory(itemSpecies?.category ?? "");
    });
  const todayPayments = orders.flatMap((order) =>
    (Array.isArray(order?.payments) ? order.payments : []).filter((payment) =>
      String(payment?.time ?? "").slice(0, 10) === today
    )
  );
  const dailyDates = Array.from({ length: financeDays }, (_, index) =>
    addDaysToDateString(today, index - financeDays + 1)
  );
  const dailyFinanceData = dailyDates.map((date) => {
    const payments = orders.flatMap((order) =>
      (Array.isArray(order?.payments) ? order.payments : []).filter((payment) =>
        String(payment?.time ?? "").slice(0, 10) === date
      )
    );
    return {
      date,
      label: date.slice(5).replace("-", "/"),
      received: payments
        .filter((payment) => payment?.type !== "refund")
        .reduce((sum, payment) => sum + Number(payment?.amount || 0), 0),
      refunded: payments
        .filter((payment) => payment?.type === "refund")
        .reduce((sum, payment) => sum + Number(payment?.amount || 0), 0),
    };
  });
  const dailyLossData = buildDailyLossData(scopedState, dailyDates, productById, speciesById);

  return {
    today,
    todayReceived: todayPayments
      .filter((payment) => payment?.type !== "refund")
      .reduce((sum, payment) => sum + Number(payment?.amount || 0), 0),
    todayRefunded: todayPayments
      .filter((payment) => payment?.type === "refund")
      .reduce((sum, payment) => sum + Number(payment?.amount || 0), 0),
    todayShippedOut: shipments
      .filter((shipment) => shipment?.shipDate === today && shipment?.status !== "preparing")
      .reduce((sum, shipment) => sum + (Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds.length : 0), 0),
    inFishStock: inTankFishStock.length,
    sick: inTankFishStock.filter((item) => item?.status === "sick").length,
    inTankSold: inTankFishStock.filter((item) => item?.sold).length,
    inTankSick: inTankFishStock.filter((item) => !item?.sold && item?.status === "sick").length,
    inTankNormal: inTankFishStock.filter((item) => !item?.sold && item?.status !== "sick").length,
    tankGroupCount: tankGroups.length,
    subTankCount: tankGroups.reduce((count, group) => count + (Array.isArray(group?.subTanks) ? group.subTanks.length : 0), 0),
    activeOrders: orders.filter((order) => !["cancelled", "completed", "damaged"].includes(order?.status)).length,
    totalRevenue: orders
      .filter((order) => order?.status !== "cancelled" && order?.status !== "damaged")
      .reduce((sum, order) => sum + (Array.isArray(order?.items) ? order.items : []).reduce((itemSum, item) => itemSum + Number(item?.price || 0), 0), 0),
    pendingShipments: shipments.filter((shipment) => shipment?.status === "preparing" || shipment?.status === "outbound" || shipment?.status === "shipped").length,
    financeDays,
    siteId,
    dailyFinanceData,
    dailyLossData,
  };
}

function activeStockCountForSubTank(state, subTankId) {
  const shippedIds = shippedOutStockIds(state);
  return (Array.isArray(state.stock) ? state.stock : [])
    .filter((item) => item?.subTankId === subTankId && isPhysicallyInTank(item, shippedIds))
    .length;
}

function activeStockCountForSubTanks(state, subTankIds) {
  const idSet = new Set(subTankIds);
  const shippedIds = shippedOutStockIds(state);
  return (Array.isArray(state.stock) ? state.stock : [])
    .filter((item) => idSet.has(item?.subTankId) && isPhysicallyInTank(item, shippedIds))
    .length;
}

function normalizeTankGroup(group, existingSubTanks = []) {
  const normalized = {
    id: String(group?.id || uid("group")),
    siteId: normalizeSiteId(group?.siteId),
    name: String(group?.name ?? "").trim(),
    location: String(group?.location ?? "").trim(),
    subTanks: existingSubTanks,
  };
  if (group?.rows !== undefined) normalized.rows = Number(group.rows);
  if (group?.cols !== undefined) normalized.cols = Number(group.cols);
  if (!normalized.name) throw new Error("Tank group name is required");
  return normalized;
}

function normalizeSubTank(subTank) {
  const normalized = {
    id: String(subTank?.id || uid("tank")),
    name: String(subTank?.name ?? "").trim(),
  };
  if (subTank?.row !== undefined) normalized.row = Number(subTank.row);
  if (subTank?.col !== undefined) normalized.col = Number(subTank.col);
  if (!normalized.name) throw new Error("Sub tank name is required");
  return normalized;
}

function normalizeDailyLog(log) {
  const normalized = {
    id: String(log?.id || uid("daily")),
    siteId: normalizeSiteId(log?.siteId),
    date: String(log?.date ?? "").trim(),
    tankGroupId: String(log?.tankGroupId ?? "").trim(),
    action: String(log?.action ?? "").trim(),
    operator: String(log?.operator ?? "").trim(),
    notes: String(log?.notes ?? "").trim(),
  };
  if (!normalized.date || !normalized.tankGroupId || !normalized.action || !normalized.operator) {
    throw new Error("Daily log date, tankGroupId, action and operator are required");
  }
  return normalized;
}

function pushOperationLog(operationLogs, operationLog) {
  return [operationLog, ...(Array.isArray(operationLogs) ? operationLogs : [])].slice(0, MAX_OPERATION_LOGS);
}

function normalizeStockItem(item) {
  const normalized = {
    ...item,
    id: String(item.id || uid("stock")),
    siteId: normalizeSiteId(item.siteId),
    productId: String(item.productId ?? "").trim(),
    batchId: String(item.batchId ?? "").trim(),
    subTankId: String(item.subTankId ?? "").trim(),
    status: ["healthy", "feeding", "sick"].includes(item.status) ? item.status : "healthy",
    inDate: String(item.inDate ?? "").trim(),
    basePrice: Number(item.basePrice ?? 0),
    commissionRate: Math.max(0, Number(item.commissionRate ?? 0)),
    code: String(item.code ?? "").trim(),
    notes: String(item.notes ?? ""),
    lossProof: Array.isArray(item.lossProof) ? item.lossProof : [],
  };
  if (!normalized.productId || !normalized.batchId || !normalized.subTankId || !normalized.inDate) {
    throw new Error("Stock item productId, batchId, subTankId and inDate are required");
  }
  if (!(normalized.basePrice > 0)) {
    throw new Error("Stock item basePrice must be greater than 0");
  }
  return normalized;
}

function findSubTank(state = {}, subTankId) {
  for (const group of Array.isArray(state.tankGroups) ? state.tankGroups : []) {
    const subTank = (Array.isArray(group.subTanks) ? group.subTanks : []).find((tank) => tank.id === subTankId);
    if (subTank) return { group, subTank };
  }
  return null;
}

function subTankDisplayName(state = {}, subTankId) {
  const found = findSubTank(state, subTankId);
  return found ? `${found.group.name} / ${found.subTank.name}` : "未知缸位";
}

function dailyLogGroupId(state = {}, log = {}) {
  const explicitGroupId = String(log?.tankGroupId ?? "").trim();
  if (explicitGroupId) return explicitGroupId;
  const subTankId = String(log?.subTankId ?? "").trim();
  if (!subTankId) return "";
  return findSubTank(state, subTankId)?.group?.id ?? "";
}

function activeStockItemsInTankGroup(state = {}, tankGroupId) {
  const group = (Array.isArray(state.tankGroups) ? state.tankGroups : [])
    .find((item) => String(item?.id ?? "") === String(tankGroupId ?? ""));
  if (!group) return [];
  const subTankIds = new Set(
    (Array.isArray(group.subTanks) ? group.subTanks : [])
      .map((tank) => String(tank?.id ?? ""))
      .filter(Boolean)
  );
  const shippedIds = shippedOutStockIds(state);
  return (Array.isArray(state.stock) ? state.stock : [])
    .filter((item) => subTankIds.has(String(item?.subTankId ?? "")) && isPhysicallyInTank(item, shippedIds));
}

function dailyLogRecordText(log = {}) {
  const action = String(log?.action ?? "").trim();
  const notes = String(log?.notes ?? "").trim();
  return `缸组养护：${action}${notes ? `；备注：${notes}` : ""}`;
}

function syncedDailyLogRecord(state = {}, log = {}, stockItem = {}, existingRecord = null, groupChanged = false) {
  const found = findSubTank(state, stockItem.subTankId);
  const group = (Array.isArray(state.tankGroups) ? state.tankGroups : [])
    .find((item) => String(item?.id ?? "") === String(log.tankGroupId ?? ""));
  const preserveSnapshot = existingRecord && !groupChanged;
  return {
    id: String(existingRecord?.id ?? `bio-daily-${log.id}-${stockItem.id}`),
    siteId: normalizeSiteId(log.siteId ?? stockItem.siteId),
    stockItemId: String(stockItem.id),
    date: String(log.date),
    text: dailyLogRecordText(log),
    photos: Array.isArray(existingRecord?.photos) ? existingRecord.photos : [],
    videos: Array.isArray(existingRecord?.videos) ? existingRecord.videos : [],
    sourceType: "dailyLog",
    sourceLogId: String(log.id),
    tankGroupId: String(log.tankGroupId),
    tankGroupName: preserveSnapshot
      ? String(existingRecord.tankGroupName ?? group?.name ?? "")
      : String(group?.name ?? found?.group?.name ?? ""),
    subTankId: preserveSnapshot
      ? String(existingRecord.subTankId ?? stockItem.subTankId ?? "")
      : String(stockItem.subTankId ?? ""),
    subTankName: preserveSnapshot
      ? String(existingRecord.subTankName ?? found?.subTank?.name ?? "")
      : String(found?.subTank?.name ?? ""),
    tankLocation: preserveSnapshot
      ? String(existingRecord.tankLocation ?? found?.group?.location ?? "")
      : String(found?.group?.location ?? ""),
    operator: String(log.operator ?? ""),
  };
}

function syncDailyLogToBioRecords(state = {}, bioRecords = [], normalizedLog = {}, previousLog = null) {
  const groupChanged = previousLog && dailyLogGroupId(state, previousLog) !== normalizedLog.tankGroupId;
  const existingForLog = (Array.isArray(bioRecords) ? bioRecords : [])
    .filter((record) => record?.sourceType === "dailyLog" && String(record?.sourceLogId ?? "") === String(normalizedLog.id));
  const existingByStockId = new Map(existingForLog.map((record) => [String(record.stockItemId), record]));
  const preservedStockIds = !groupChanged && Array.isArray(previousLog?.syncedStockItemIds)
    ? previousLog.syncedStockItemIds.map(String).filter(Boolean)
    : null;
  const targetItems = preservedStockIds
    ? preservedStockIds
        .map((id) => (Array.isArray(state.stock) ? state.stock : []).find((item) => String(item?.id ?? "") === id))
        .filter(Boolean)
    : activeStockItemsInTankGroup(state, normalizedLog.tankGroupId);
  const targetIds = targetItems.map((item) => String(item.id));
  const nextRecords = (Array.isArray(bioRecords) ? bioRecords : [])
    .filter((record) => !(record?.sourceType === "dailyLog" && String(record?.sourceLogId ?? "") === String(normalizedLog.id)));
  const syncedRecords = targetItems.map((item) =>
    syncedDailyLogRecord(state, normalizedLog, item, existingByStockId.get(String(item.id)), !!groupChanged)
  );
  return {
    log: {
      ...normalizedLog,
      syncedStockItemIds: targetIds,
      syncedAt: new Date().toISOString(),
    },
    bioRecords: [...nextRecords, ...syncedRecords],
    syncedCount: syncedRecords.length,
  };
}

function findActiveOrderForStock(state = {}, stockItemId) {
  return (Array.isArray(state.orders) ? state.orders : []).find((order) =>
    order?.status !== "cancelled" &&
    Array.isArray(order.items) &&
    order.items.some((item) => item?.stockItemId === stockItemId)
  );
}

function stockSiteId(state = {}, stockItem = {}) {
  const explicit = String(stockItem?.siteId ?? "").trim();
  if (explicit) return normalizeSiteId(explicit);
  return normalizeSiteId(findSubTank(state, stockItem?.subTankId)?.group?.siteId);
}

function orderActiveStockIds(state = {}, excludeOrderId = "") {
  const ids = new Set();
  for (const order of Array.isArray(state.orders) ? state.orders : []) {
    if (!order || order.status === "cancelled" || String(order.id ?? "") === String(excludeOrderId ?? "")) continue;
    for (const item of Array.isArray(order.items) ? order.items : []) {
      const id = String(item?.stockItemId ?? "");
      if (id) ids.add(id);
    }
  }
  return ids;
}

function shipmentBlocksInventory(shipment = {}) {
  return shipment?.status !== "preparing";
}

function shipmentActiveStockIds(state = {}, excludeShipmentId = "") {
  const ids = new Set();
  for (const shipment of Array.isArray(state.shipments) ? state.shipments : []) {
    if (!shipment || String(shipment.id ?? "") === String(excludeShipmentId ?? "") || !shipmentBlocksInventory(shipment)) continue;
    for (const id of Array.isArray(shipment.itemStockIds) ? shipment.itemStockIds : []) {
      const stockId = String(id ?? "");
      if (stockId) ids.add(stockId);
    }
  }
  return ids;
}

function normalizeMoney(value, label) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) throw new Error(`${label} must be a non-negative number`);
  return Number(amount.toFixed(2));
}

function normalizeCommissionRate(value) {
  const rate = Number(value ?? 0);
  if (!Number.isFinite(rate) || rate < 0) return 0;
  return Number(rate.toFixed(4));
}

function normalizePaymentRecord(record = {}) {
  const type = String(record.type ?? "");
  if (!["deposit", "balance", "shipping_fee", "refund", "other"].includes(type)) {
    throw new Error("Invalid payment type");
  }
  return {
    id: String(record.id || uid("pay")),
    time: String(record.time || nowDatetimeInChina()),
    type,
    amount: normalizeMoney(record.amount, "Payment amount"),
    proof: Array.isArray(record.proof) ? record.proof : [],
    notes: String(record.notes ?? ""),
  };
}

function normalizeOrderNoValue(value) {
  const match = String(value ?? "").match(/(\d+)$/);
  return match ? Number(match[1]) || 0 : 0;
}

function nextOrderNo(state = {}) {
  const year = new Date(Date.now() + 8 * 60 * 60 * 1000).getFullYear();
  const maxNo = (Array.isArray(state.orders) ? state.orders : [])
    .map((order) => String(order?.orderNo ?? ""))
    .filter((value) => value.startsWith(`SO-${year}-`))
    .reduce((max, value) => Math.max(max, normalizeOrderNoValue(value)), 0);
  return `SO-${year}-${String(maxNo + 1).padStart(3, "0")}`;
}

function getBillableShippingFeeForOrder(order = {}, shipments = []) {
  const activeShipments = shipments.filter((shipment) =>
    shipment?.orderId === order.id && shipmentBlocksInventory(shipment)
  );
  if (activeShipments.length === 0) return Number(order.shippingFee ?? 0);
  return activeShipments.reduce((sum, shipment) => sum + Number(shipment.actualShippingFee ?? 0), 0);
}

function calcAmountRefundedForOrder(order = {}) {
  return (Array.isArray(order.payments) ? order.payments : [])
    .filter((payment) => payment?.type === "refund")
    .reduce((sum, payment) => sum + Number(payment?.amount ?? 0), 0);
}

function calcDamageRefundAdjustmentForOrder(order = {}, shipments = []) {
  const orderShipments = shipments.filter((shipment) => shipment?.orderId === order.id);
  const explicitAdjustment = orderShipments.reduce((sum, shipment) => {
    if (shipment?.status !== "damaged" || shipment?.damageResolution !== "refund") return sum;
    return sum + Number(shipment.damageRefundAmount ?? 0);
  }, 0);
  if (explicitAdjustment > 0.005) return explicitAdjustment;
  const hasLegacyDamageRefund = orderShipments.some((shipment) =>
    shipment?.status === "damaged" &&
    shipment?.damageResolution === "refund" &&
    shipment?.damageRefundAmount == null
  );
  return hasLegacyDamageRefund ? calcAmountRefundedForOrder(order) : 0;
}

function calcAmountDueForOrder(order = {}, shipments = []) {
  const itemTotal = (Array.isArray(order.items) ? order.items : [])
    .reduce((sum, item) => sum + Number(item?.price ?? 0), 0);
  return Number((
    itemTotal +
    getBillableShippingFeeForOrder(order, shipments) +
    Number(order.packagingFee ?? 0) -
    Number(order.discount ?? 0) -
    calcDamageRefundAdjustmentForOrder(order, shipments)
  ).toFixed(2));
}

function calcAmountPaidForOrder(order = {}) {
  return Number((Array.isArray(order.payments) ? order.payments : [])
    .reduce((sum, payment) => payment?.type === "refund"
      ? sum - Number(payment?.amount ?? 0)
      : sum + Number(payment?.amount ?? 0), 0)
    .toFixed(2));
}

function getOrderFinancialStateForOrder(order = {}, shipments = []) {
  const balance = calcAmountDueForOrder(order, shipments) - calcAmountPaidForOrder(order);
  if (balance > 0.005) return { kind: "payable", amount: Number(balance.toFixed(2)) };
  if (balance < -0.005) return { kind: "refundable", amount: Number(Math.abs(balance).toFixed(2)) };
  return { kind: "paid", amount: 0 };
}

function orderPermissionAllowed(state = {}, operator = "system", action = "update") {
  if (!operator || operator === "system") return true;
  const account = (Array.isArray(state.personnel) ? state.personnel : [])
    .find((person) => person?.username === operator || person?.name === operator);
  if (!account) return true;
  if (account.accessRole === "admin") return true;
  return account.permissions?.orders?.[action] !== false;
}

function requireOrderPermission(state = {}, operator = "system", action = "update") {
  if (!orderPermissionAllowed(state, operator, action)) {
    throw new Error("当前账号没有订单模块的操作权限");
  }
}

function normalizeOrderItemInput(state = {}, input = {}, options = {}) {
  const stockId = String(input.stockItemId ?? "").trim();
  if (!stockId) throw new Error("Order item stockItemId is required");
  const stockItem = (Array.isArray(state.stock) ? state.stock : []).find((item) => String(item?.id ?? "") === stockId);
  if (!stockItem) throw new Error(`库存鱼不存在或已被删除：${stockId}`);
  const expectedSiteId = normalizeSiteId(options.siteId);
  if (stockSiteId(state, stockItem) !== expectedSiteId) {
    throw new Error("不能跨场地选择库存鱼");
  }
  const stockInOtherOrders = options.activeOrderIds ?? orderActiveStockIds(state, options.excludeOrderId);
  const stockInShipments = options.activeShipmentIds ?? shipmentActiveStockIds(state, options.excludeShipmentId);
  if (stockInOtherOrders.has(stockId)) throw new Error("所选鱼已被其他订单占用，请刷新后重选");
  if (stockInShipments.has(stockId)) throw new Error("所选鱼已出库或发货，不能再次加入订单");
  if (!isPhysicallyInTank(stockItem, shippedOutStockIds(state))) throw new Error("所选鱼已不在缸内，不能加入订单");

  const price = normalizeMoney(input.price ?? stockItem.basePrice, "Order item price");
  return {
    stockItemId: stockId,
    productId: String(stockItem.productId ?? input.productId ?? "").trim(),
    price,
    commissionRate: normalizeCommissionRate(input.commissionRate ?? stockItem.commissionRate),
  };
}

function normalizeOrderMutationInput(state = {}, body = {}, currentOrder = null) {
  const incomingSiteId = body.siteId === ALL_SITE_ID ? DEFAULT_SITE_ID : body.siteId;
  const siteId = normalizeSiteId(incomingSiteId ?? currentOrder?.siteId);
  const customerId = String(body.customerId ?? currentOrder?.customerId ?? "").trim();
  const customerExists = (Array.isArray(state.customers) ? state.customers : [])
    .some((customer) => String(customer?.id ?? "") === customerId);
  if (!customerId || !customerExists) throw new Error("请选择有效客户");
  const date = String(body.date ?? currentOrder?.date ?? "").trim();
  if (!date) throw new Error("下单日期不能为空");
  if (date > todayInChina()) throw new Error("下单日期不能晚于今天");
  const plannedShipDate = String(body.plannedShipDate ?? "").trim();
  if (plannedShipDate && plannedShipDate < date) throw new Error("预计发货日期不能早于下单日期");
  const contactPerson = String(body.contactPerson ?? currentOrder?.contactPerson ?? "").trim();
  if (!contactPerson) throw new Error("请选择对接人");
  const itemsInput = Array.isArray(body.items) ? body.items : [];
  if (itemsInput.length === 0) throw new Error("请至少添加一条商品");
  const itemIds = itemsInput.map((item) => String(item?.stockItemId ?? "").trim()).filter(Boolean);
  if (new Set(itemIds).size !== itemIds.length) throw new Error("订单内不能重复选择同一条鱼");
  const currentItemIds = new Set((Array.isArray(currentOrder?.items) ? currentOrder.items : [])
    .map((item) => String(item?.stockItemId ?? ""))
    .filter(Boolean));
  const items = itemsInput.map((item) => {
    const stockId = String(item?.stockItemId ?? "").trim();
    if (!currentItemIds.has(stockId)) {
      return normalizeOrderItemInput(state, item, {
        siteId,
        excludeOrderId: currentOrder?.id ?? "",
      });
    }
    const stockItem = (Array.isArray(state.stock) ? state.stock : []).find((stock) => String(stock?.id ?? "") === stockId);
    const existingItem = (Array.isArray(currentOrder?.items) ? currentOrder.items : [])
      .find((orderItem) => String(orderItem?.stockItemId ?? "") === stockId);
    if (!stockItem && !existingItem) throw new Error(`库存鱼不存在或已被删除：${stockId}`);
    return {
      stockItemId: stockId,
      productId: String(stockItem?.productId ?? existingItem?.productId ?? item?.productId ?? "").trim(),
      price: normalizeMoney(item.price ?? existingItem?.price, "Order item price"),
      commissionRate: normalizeCommissionRate(item.commissionRate ?? existingItem?.commissionRate),
    };
  });
  const shippingFee = normalizeMoney(body.shippingFee ?? currentOrder?.shippingFee, "Shipping fee");
  const packagingFee = normalizeMoney(body.packagingFee ?? currentOrder?.packagingFee, "Packaging fee");
  const discount = normalizeMoney(body.discount ?? currentOrder?.discount, "Discount");
  if (items.reduce((sum, item) => sum + item.price, 0) + shippingFee + packagingFee - discount < -0.005) {
    throw new Error("折扣过大，应付金额不能为负数");
  }
  return {
    siteId,
    customerId,
    date,
    plannedShipDate: plannedShipDate || undefined,
    contactPerson,
    items,
    shippingFee,
    packagingFee,
    discount,
    notes: String(body.notes ?? currentOrder?.notes ?? ""),
  };
}

function setStockSoldForOrders(state = {}, orders = []) {
  const activeOrderIds = new Set();
  for (const order of orders) {
    if (!order || order.status === "cancelled") continue;
    for (const item of Array.isArray(order.items) ? order.items : []) {
      const stockId = String(item?.stockItemId ?? "");
      if (stockId) activeOrderIds.add(stockId);
    }
  }
  return (Array.isArray(state.stock) ? state.stock : []).map((stockItem) =>
    activeOrderIds.has(String(stockItem?.id ?? ""))
      ? { ...stockItem, sold: true }
      : { ...stockItem, sold: false }
  );
}

function deletedIdsByKey(current = [], next = []) {
  const nextIds = new Set((Array.isArray(next) ? next : []).map((item) => String(item?.id ?? "")).filter(Boolean));
  return (Array.isArray(current) ? current : [])
    .map((item) => String(item?.id ?? ""))
    .filter((id) => id && !nextIds.has(id));
}

function validateReferenceIntegrity(current = {}, next = {}, changedKeys = []) {
  const changed = new Set(changedKeys);
  if (changed.has("species")) {
    const deletedSpeciesIds = new Set(deletedIdsByKey(current.species, next.species));
    if (deletedSpeciesIds.size > 0) {
      const used = (Array.isArray(current.products) ? current.products : [])
        .find((product) => deletedSpeciesIds.has(String(product?.speciesId ?? "")));
      if (used) throw new Error("该物种已被商品引用，不能删除");
    }
  }

  if (changed.has("products")) {
    const deletedProductIds = new Set(deletedIdsByKey(current.products, next.products));
    if (deletedProductIds.size > 0) {
      const usedByStock = (Array.isArray(current.stock) ? current.stock : [])
        .find((stock) => deletedProductIds.has(String(stock?.productId ?? "")));
      const usedByOrder = (Array.isArray(current.orders) ? current.orders : [])
        .find((order) => Array.isArray(order?.items) && order.items.some((item) => deletedProductIds.has(String(item?.productId ?? ""))));
      if (usedByStock || usedByOrder) throw new Error("该商品已被库存或订单引用，不能删除");
    }
  }

  if (changed.has("batches")) {
    const deletedBatchIds = new Set(deletedIdsByKey(current.batches, next.batches));
    if (deletedBatchIds.size > 0) {
      const used = (Array.isArray(current.stock) ? current.stock : [])
        .find((stock) => deletedBatchIds.has(String(stock?.batchId ?? "")));
      if (used) throw new Error("该采购批次已被库存引用，不能删除");
    }
  }

  if (changed.has("customers")) {
    const deletedCustomerIds = new Set(deletedIdsByKey(current.customers, next.customers));
    if (deletedCustomerIds.size > 0) {
      const used = (Array.isArray(current.orders) ? current.orders : [])
        .find((order) => deletedCustomerIds.has(String(order?.customerId ?? "")));
      if (used) throw new Error("该客户已被订单引用，不能删除");
    }
  }
}

function cosReady() {
  return Boolean(cosConfig.secretId && cosConfig.secretKey && cosConfig.bucket && cosConfig.region);
}

function getCosClient() {
  if (!cosReady()) return null;
  cosClient ??= new COS({
    SecretId: cosConfig.secretId,
    SecretKey: cosConfig.secretKey,
  });
  return cosClient;
}

function defaultCosBaseUrl() {
  return `https://${cosConfig.bucket}.cos.${cosConfig.region}.myqcloud.com`;
}

function cosBaseUrl() {
  return cosConfig.publicBaseUrl || defaultCosBaseUrl();
}

function objectUrlForKey(key) {
  return `${cosBaseUrl()}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
}

function cosKeyFromUrl(value) {
  if (!cosReady() || typeof value !== "string" || !value.trim()) return "";
  try {
    const parsed = new URL(value);
    const allowedHosts = new Set([
      new URL(cosBaseUrl()).host,
      new URL(defaultCosBaseUrl()).host,
    ]);
    if (!allowedHosts.has(parsed.host)) return "";
    const key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    if (!key || key.includes("..")) return "";
    if (cosConfig.prefix && !key.startsWith(`${cosConfig.prefix}/`)) return "";
    return key;
  } catch {
    return "";
  }
}

function sendCosObject(req, res, key) {
  const client = getCosClient();
  if (!client) {
    sendJson(req, res, 503, { error: "COS is not configured" });
    return;
  }
  client.getObject({
    Bucket: cosConfig.bucket,
    Region: cosConfig.region,
    Key: key,
  }, (error, data = {}) => {
    if (error) {
      const status = Number(error.statusCode || error.status) || 502;
      sendJson(req, res, status === 404 ? 404 : 502, { error: "Failed to load COS object" });
      return;
    }
    const body = data.Body ?? Buffer.alloc(0);
    res.writeHead(200, {
      "Content-Type": data.ContentType || mimeForExtension(extname(key)),
      "Cache-Control": "private, max-age=3600",
    });
    res.end(body);
  });
}

async function signedCosObjectUrl(key) {
  const client = getCosClient();
  if (!client) return "";
  return await new Promise((resolvePromise, rejectPromise) => {
    client.getObjectUrl({
      Bucket: cosConfig.bucket,
      Region: cosConfig.region,
      Key: key,
      Sign: true,
      Expires: 3600,
    }, (error, data = {}) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(typeof data === "string" ? data : (data.Url || data.url || ""));
    });
  });
}

function prefixedCosKey(...parts) {
  return [cosConfig.prefix, ...parts]
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "");
}

function extensionForMime(mime) {
  const normalized = String(mime || "").toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/png") return ".png";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "video/webm") return ".webm";
  return ".bin";
}

function mimeForExtension(ext) {
  const normalized = String(ext || "").toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".png") return "image/png";
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".gif") return "image/gif";
  if (normalized === ".mp4") return "video/mp4";
  if (normalized === ".webm") return "video/webm";
  return "application/octet-stream";
}

async function uploadBufferToCos(buffer, mime, key) {
  const client = getCosClient();
  if (!client) return null;
  await new Promise((resolvePromise, rejectPromise) => {
    client.putObject({
      Bucket: cosConfig.bucket,
      Region: cosConfig.region,
      Key: key,
      Body: buffer,
      ContentType: mime || "application/octet-stream",
    }, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
  return objectUrlForKey(key);
}

function localUploadPathFromUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/uploads/")) return "";
  const relative = decodeURIComponent(value.replace(/^\/uploads\/?/, ""));
  const candidate = normalize(join(uploadDir, relative));
  return candidate === uploadDir || candidate.startsWith(`${uploadDir}/`) ? candidate : "";
}

async function externalizeDataUrl(value) {
  const match = typeof value === "string"
    ? value.match(/^data:([^;,]+);base64,(.+)$/)
    : null;
  if (!match) return value;

  const [, mime, encoded] = match;
  const buffer = Buffer.from(encoded, "base64");
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  const ext = extensionForMime(mime);
  if (cosReady()) {
    const typeFolder = String(mime).startsWith("video/") ? "videos" : "images";
    const cosUrl = await uploadBufferToCos(
      buffer,
      mime,
      prefixedCosKey("auto", typeFolder, `${hash}${ext}`)
    );
    if (cosUrl) return cosUrl;
  }
  const folder = join(uploadDir, "auto");
  const fileName = `${hash}${ext}`;
  const filePath = join(folder, fileName);
  await mkdir(folder, { recursive: true });
  if (!existsSync(filePath)) {
    await writeFile(filePath, buffer);
  }
  return `/uploads/auto/${fileName}`;
}

async function externalizeLocalUploadUrl(value) {
  const filePath = localUploadPathFromUrl(value);
  if (!filePath || !cosReady()) return value;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return value;
    const buffer = await readFile(filePath);
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
    const ext = extname(filePath) || ".bin";
    const mime = mimeForExtension(ext);
    const typeFolder = mime.startsWith("video/") ? "videos" : "images";
    return await uploadBufferToCos(
      buffer,
      mime,
      prefixedCosKey("migrated", typeFolder, `${hash}${ext.toLowerCase()}`)
    ) || value;
  } catch (error) {
    console.warn(`Failed to migrate local upload to COS: ${value} (${error.message})`);
    return value;
  }
}

async function externalizeDataUrls(value) {
  if (typeof value === "string") {
    const dataUrl = await externalizeDataUrl(value);
    return externalizeLocalUploadUrl(dataUrl);
  }
  if (Array.isArray(value)) {
    const next = [];
    for (const item of value) next.push(await externalizeDataUrls(item));
    return next;
  }
  if (value && typeof value === "object") {
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      next[key] = await externalizeDataUrls(item);
    }
    return next;
  }
  return value;
}

async function externalizePersistedUploads() {
  const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
  const current = rows[0]?.data;
  if (!current) return;
  const next = await externalizeDataUrls(current);
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  await pool.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
    stateId,
    JSON.stringify(next),
  ]);
  console.log(cosReady()
    ? "Migrated embedded/local uploads from PostgreSQL state to COS"
    : "Externalized embedded base64 uploads from PostgreSQL state"
  );
}

async function backfillDailyLogBioRecords() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const state = rows[0]?.data ?? {};
    const logs = Array.isArray(state.logs) ? state.logs : [];
    const bioRecords = Array.isArray(state.bioRecords) ? state.bioRecords : [];
    let nextBioRecords = bioRecords;
    let changed = false;
    const nextLogs = logs.map((log) => {
      if (Array.isArray(log?.syncedStockItemIds)) return log;
      const tankGroupId = dailyLogGroupId(state, log);
      if (!tankGroupId || !log?.date || !log?.action || !log?.operator) return log;
      const normalizedLog = {
        id: String(log.id || uid("daily")),
        date: String(log.date),
        tankGroupId,
        action: String(log.action ?? "").trim(),
        operator: String(log.operator ?? "").trim(),
        notes: String(log.notes ?? "").trim(),
      };
      const synced = syncDailyLogToBioRecords(
        { ...state, bioRecords: nextBioRecords },
        nextBioRecords,
        normalizedLog,
        log
      );
      nextBioRecords = synced.bioRecords;
      changed = true;
      return {
        ...log,
        ...synced.log,
      };
    });

    if (!changed) {
      await client.query("ROLLBACK");
      return;
    }

    const nextState = {
      ...state,
      logs: nextLogs,
      bioRecords: nextBioRecords,
    };
    await client.query(
      "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
      [stateId, JSON.stringify(nextState)]
    );
    await client.query("COMMIT");
    console.log(`Backfilled daily logs into bio records: ${nextBioRecords.length - bioRecords.length} records added`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to backfill daily log bio records:", error);
  } finally {
    client.release();
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function importLegacyStateIfPresent() {
  const existing = await pool.query("SELECT 1 FROM app_state WHERE id = $1", [stateId]);
  if (existing.rowCount > 0 || !existsSync(legacyStateFile)) return;

  const legacyState = JSON.parse(await readFile(legacyStateFile, "utf8"));
  await pool.query(
    `INSERT INTO app_state (id, data, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
    [stateId, JSON.stringify(legacyState)]
  );
  console.log(`Imported legacy JSON state from ${legacyStateFile}`);
}

async function ensureSchema() {
  schemaReady ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await importLegacyStateIfPresent();
    await externalizePersistedUploads();
    await backfillDailyLogBioRecords();
  })();
  return schemaReady;
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, jsonHeaders);
    res.end();
    return;
  }

  await ensureSchema();

  if (url.pathname === "/api/health" && req.method === "GET") {
    const { rows } = await pool.query("SELECT current_database() AS database, current_user AS user");
    sendJson(req, res, 200, {
      status: "ok",
      storage: "postgresql",
      database: rows[0]?.database,
      user: rows[0]?.user,
      host: pgConfig.host,
      port: pgConfig.port,
      table: "app_state",
      cos: {
        enabled: cosReady(),
        bucket: cosConfig.bucket || null,
        region: cosConfig.region || null,
        publicBaseUrl: cosReady() ? cosBaseUrl() : null,
      },
    });
    return;
  }

  if (url.pathname === "/api/media/cos" && req.method === "GET") {
    const key = cosKeyFromUrl(url.searchParams.get("url") ?? "");
    if (!key) {
      sendJson(req, res, 400, { error: "Invalid COS media URL" });
      return;
    }
    sendCosObject(req, res, key);
    return;
  }

  if (url.pathname === "/api/media/cos-url" && req.method === "GET") {
    try {
      const key = cosKeyFromUrl(url.searchParams.get("url") ?? "");
      if (!key) {
        sendJson(req, res, 400, { error: "Invalid COS media URL" });
        return;
      }
      const signedUrl = await signedCosObjectUrl(key);
      if (!signedUrl) {
        sendJson(req, res, 503, { error: "COS is not configured" });
        return;
      }
      sendJson(req, res, 200, { url: signedUrl, expiresIn: 3600 });
    } catch (error) {
      sendJson(req, res, 502, { error: "Failed to sign COS media URL" });
    }
    return;
  }

  if (url.pathname === "/api/login-data" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data -> 'personnel' AS personnel FROM app_state WHERE id = $1", [stateId]);
    sendJson(req, res, 200, { personnel: rows[0]?.personnel ?? null });
    return;
  }

  if (url.pathname === "/api/dashboard-summary" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
    sendJson(req, res, 200, {
      summary: buildDashboardSummary(rows[0]?.data ?? {}, {
        financeDays: url.searchParams.get("financeDays") ?? url.searchParams.get("days"),
        siteId: url.searchParams.get("siteId") ?? ALL_SITE_ID,
      }),
    });
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
    sendJson(req, res, 200, { data: rows[0]?.data ?? null });
    return;
  }

  if (url.pathname === "/api/state/slice" && req.method === "GET") {
    try {
      const keys = parseStateKeys(url.searchParams.get("keys") ?? "");
      if (keys.length === 0) {
        sendJson(req, res, 400, { error: "Missing state slice keys" });
        return;
      }
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const lite = new Set(String(url.searchParams.get("lite") ?? "").split(",").map((item) => item.trim()).filter(Boolean));
      sendJson(req, res, 200, {
        data: pickState(rows[0]?.data ?? {}, keys, { liteSpecies: lite.has("species") }),
      });
    } catch (error) {
      sendJson(req, res, 400, { error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/bio-records" && req.method === "GET") {
    const stockItemId = String(url.searchParams.get("stockItemId") ?? "").trim();
    if (!stockItemId) {
      sendJson(req, res, 400, { error: "Missing stockItemId" });
      return;
    }
    const { rows } = await pool.query(
      "SELECT data -> 'bioRecords' AS bio_records, data -> 'stock' AS stock FROM app_state WHERE id = $1",
      [stateId]
    );
    const bioRecords = Array.isArray(rows[0]?.bio_records) ? rows[0].bio_records : [];
    const stock = Array.isArray(rows[0]?.stock) ? rows[0].stock : [];
    sendJson(req, res, 200, {
      bioRecords: bioRecords.filter((record) => String(record?.stockItemId ?? "") === stockItemId),
      stockItem: stock.find((item) => String(item?.id ?? "") === stockItemId) ?? null,
    });
    return;
  }

  if (url.pathname === "/api/state" && req.method === "POST") {
    sendJson(req, res, 410, {
      ok: false,
      error: "Full state save is disabled. Use dedicated save endpoints or /api/state/patch.",
    });
    return;
  }

  if (url.pathname === "/api/orders/create" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await externalizeDataUrls(JSON.parse(await readBody(req)));
      const operator = String(body.operator ?? "system");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermission(state, operator, "create");
      const orderInput = normalizeOrderMutationInput(state, body);
      const payments = Array.isArray(body.payments) ? body.payments.map(normalizePaymentRecord) : [];
      const order = {
        id: String(body.id || uid("order")),
        orderNo: nextOrderNo(state),
        createdAt: nowDatetimeInChina(),
        ...orderInput,
        status: "pending",
        payments,
      };
      const nextOrders = [...(Array.isArray(state.orders) ? state.orders : []), order];
      const nextStock = setStockSoldForOrders(state, nextOrders);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "添加记录",
        detail: `创建订单「${order.orderNo}」，商品 ${order.items.length} 条`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        stock: nextStock,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, order, orders: nextOrders, stock: nextStock, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/update" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await externalizeDataUrls(JSON.parse(await readBody(req)));
      const operator = String(body.operator ?? "system");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermission(state, operator, "update");
      const orders = Array.isArray(state.orders) ? state.orders : [];
      const orderId = String(body.orderId ?? body.id ?? "");
      const currentOrder = orders.find((order) => String(order?.id ?? "") === orderId);
      if (!currentOrder) throw new Error("订单不存在，请刷新后重试");
      if (currentOrder.status === "completed") throw new Error("已完成订单不能再编辑");

      const nextOrderInput = normalizeOrderMutationInput(state, body, currentOrder);
      const nextItemIds = new Set(nextOrderInput.items.map((item) => item.stockItemId));
      const removedItemIds = (Array.isArray(currentOrder.items) ? currentOrder.items : [])
        .map((item) => String(item?.stockItemId ?? ""))
        .filter((id) => id && !nextItemIds.has(id));
      const blockingShipmentIds = shipmentActiveStockIds(state);
      const removedShippedIds = removedItemIds.filter((id) => blockingShipmentIds.has(id));
      if (removedShippedIds.length > 0) throw new Error("已出库或发货的商品不能直接从订单中删除");

      const nextOrder = {
        ...currentOrder,
        ...nextOrderInput,
      };
      const nextOrders = orders.map((order) => String(order?.id ?? "") === orderId ? nextOrder : order);
      const nextStock = setStockSoldForOrders(state, nextOrders);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: `修改订单「${nextOrder.orderNo}」`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        stock: nextStock,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, order: nextOrder, orders: nextOrders, stock: nextStock, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/delete" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req));
      const operator = String(body.operator ?? "system");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermission(state, operator, "delete");
      const orderId = String(body.orderId ?? "");
      const orders = Array.isArray(state.orders) ? state.orders : [];
      const order = orders.find((item) => String(item?.id ?? "") === orderId);
      if (!order) throw new Error("订单不存在，请刷新后重试");
      if (Array.isArray(order.payments) && order.payments.length > 0) throw new Error("该订单已有收款记录，不能删除");

      const nextOrders = orders.filter((item) => String(item?.id ?? "") !== orderId);
      const nextShipments = (Array.isArray(state.shipments) ? state.shipments : [])
        .filter((shipment) => String(shipment?.orderId ?? "") !== orderId);
      const nextStock = setStockSoldForOrders({ ...state, shipments: nextShipments }, nextOrders);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "删除记录",
        detail: `删除订单「${order.orderNo}」`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        shipments: nextShipments,
        stock: nextStock,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, orders: nextOrders, shipments: nextShipments, stock: nextStock, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/shipments/outbound" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await externalizeDataUrls(JSON.parse(await readBody(req)));
      const operator = String(body.operator ?? "system");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermission(state, operator, "update");
      const orders = Array.isArray(state.orders) ? state.orders : [];
      const orderId = String(body.orderId ?? "");
      const order = orders.find((item) => String(item?.id ?? "") === orderId);
      if (!order) throw new Error("订单不存在，请刷新后重试");
      if (order.status === "completed" || order.status === "cancelled") throw new Error("该订单当前状态不能出库");
      const financialState = getOrderFinancialStateForOrder(order, state.shipments);
      if (financialState.kind !== "paid") throw new Error("订单未结清或存在待退款，不能出库");

      const selectedItemIds = Array.isArray(body.selectedItemIds)
        ? body.selectedItemIds.map((id) => String(id ?? "").trim()).filter(Boolean)
        : [];
      if (selectedItemIds.length === 0) throw new Error("请选择要出库的商品");
      if (new Set(selectedItemIds).size !== selectedItemIds.length) throw new Error("同一条鱼不能重复出库");
      const orderItemIds = new Set((Array.isArray(order.items) ? order.items : [])
        .map((item) => String(item?.stockItemId ?? ""))
        .filter(Boolean));
      const notInOrderIds = selectedItemIds.filter((id) => !orderItemIds.has(id));
      if (notInOrderIds.length > 0) throw new Error("所选商品不属于当前订单，请刷新后重试");
      const blockedShipmentIds = shipmentActiveStockIds(state);
      const duplicatedShipmentIds = selectedItemIds.filter((id) => blockedShipmentIds.has(id));
      if (duplicatedShipmentIds.length > 0) throw new Error("所选商品已经出库或发货，请刷新后重试");
      const shippedIds = shippedOutStockIds(state);
      for (const stockId of selectedItemIds) {
        const stockItem = (Array.isArray(state.stock) ? state.stock : []).find((item) => String(item?.id ?? "") === stockId);
        if (!stockItem) throw new Error("所选库存不存在，请刷新后重试");
        if (!isPhysicallyInTank(stockItem, shippedIds)) throw new Error("所选商品已不在缸内，不能出库");
        if (stockItem.lost) throw new Error("已损耗商品不能出库，请先从订单中删除");
      }

      const shipMethod = body.shipMethod === "pickup" ? "pickup" : "express";
      const carrier = String(body.carrier ?? "").trim();
      if (shipMethod === "express" && !carrier) throw new Error("请选择快递公司");
      const shipDate = String(body.shipDate ?? "").trim();
      if (!shipDate) throw new Error("请选择出库日期");
      const shipment = {
        id: String(body.id || uid("ship")),
        siteId: normalizeSiteId(order.siteId),
        orderId: order.id,
        createdAt: nowDatetimeInChina(),
        outboundDate: shipDate,
        shipDate,
        carrier,
        trackingNo: "",
        status: "outbound",
        notes: String(body.notes ?? ""),
        shipMethod,
        actualShippingFee: shipMethod === "pickup" ? 0 : normalizeMoney(body.actualShippingFee, "Actual shipping fee"),
        itemStockIds: selectedItemIds,
      };
      const nextShipments = [...(Array.isArray(state.shipments) ? state.shipments : []), shipment];
      const nextOrders = orders.map((item) =>
        String(item?.id ?? "") === order.id
          ? { ...item, status: item.status === "damaged" ? "damaged" : "shipped" }
          : item
      );
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: `订单「${order.orderNo}」出库 ${selectedItemIds.length} 条商品`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        shipments: nextShipments,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, shipment, orders: nextOrders, shipments: nextShipments, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/state/patch" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body);
      const patch = await externalizeDataUrls(parsed?.patch ?? {});
      const basePatch = parsed?.basePatch && typeof parsed.basePatch === "object" ? parsed.basePatch : {};
      const incomingLogs = Array.isArray(parsed?.operationLogs) ? parsed.operationLogs : [];
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const current = rows[0]?.data ?? {};
      const nextState = { ...current, ...patch };

      for (const key of Object.keys(patch)) {
        if (
          key !== "operationLogs" &&
          Array.isArray(current[key]) &&
          Array.isArray(patch[key]) &&
          (hasObjectIds(current[key]) || hasObjectIds(basePatch[key]) || hasObjectIds(patch[key]))
        ) {
          nextState[key] = Array.isArray(basePatch[key])
            ? mergeIdArrayPatch(current[key], basePatch[key], patch[key])
            : key === "stock"
              ? mergeStockFromGenericPost(current[key], patch[key])
              : mergeIdArrayPreserveMissing(current[key], patch[key]);
        }
      }

      if (Object.prototype.hasOwnProperty.call(patch, "stock") && Array.isArray(current.stock) && Array.isArray(patch.stock)) {
        nextState.batches = refreshBatchStockCounts(nextState.batches, nextState.stock);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "tankGroups") && Array.isArray(current.tankGroups)) {
        nextState.tankGroups = current.tankGroups;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "logs") && Array.isArray(current.logs)) {
        nextState.logs = current.logs;
      }
      if (Object.prototype.hasOwnProperty.call(patch, "lossRecords") && Array.isArray(current.lossRecords)) {
        nextState.lossRecords = current.lossRecords;
      }
      nextState.operationLogs = mergeOperationLogsForGenericPost(
        current.operationLogs,
        [...incomingLogs, ...(Array.isArray(patch.operationLogs) ? patch.operationLogs : [])]
      );

      validateReferenceIntegrity(current, nextState, Object.keys(patch));

      await client.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, appliedOperationLogs: incomingLogs });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { error: `Failed to patch PostgreSQL state: ${error.message}` });
    } finally {
      client.release();
    }
    return;
  }

	  if (url.pathname === "/api/stock/save" && req.method === "POST") {
	    try {
	      const body = await readBody(req);
      const {
        upsert = [],
        deleteIds = [],
        operator = "system",
      } = await externalizeDataUrls(JSON.parse(body));
      const upsertItems = Array.isArray(upsert) ? upsert.map(normalizeStockItem) : [];
      const deleteIdSet = new Set(Array.isArray(deleteIds) ? deleteIds.map((id) => String(id)) : []);
      if (upsertItems.length === 0 && deleteIdSet.size === 0) {
        sendJson(req, res, 400, { error: "No stock changes provided" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
        const state = rows[0]?.data ?? {};
        const stock = Array.isArray(state.stock) ? state.stock : [];
        const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
        const upsertById = new Map(upsertItems.map((item) => [item.id, item]));
        const existingIds = new Set(stock.map((item) => item?.id).filter(Boolean));
        const nextStock = stock
          .filter((item) => !deleteIdSet.has(item?.id))
          .map((item) => upsertById.get(item.id) ?? item);
        for (const item of upsertItems) {
          if (!existingIds.has(item.id)) nextStock.push(item);
        }
        const nextBatches = refreshBatchStockCounts(state.batches, nextStock);
        const operationLog = {
          id: uid("log"),
          time: new Date().toISOString(),
          operator,
          module: "商品入库",
          action: deleteIdSet.size > 0 ? "删除记录" : upsertItems.some((item) => existingIds.has(item.id)) ? "修改记录" : "添加记录",
          detail: deleteIdSet.size > 0
            ? `删除入库记录 ${deleteIdSet.size} 条`
            : `保存入库记录 ${upsertItems.length} 条`,
        };
	        const nextState = {
	          ...state,
	          stock: nextStock,
	          batches: nextBatches,
	          operationLogs: pushOperationLog(operationLogs, operationLog),
	        };
        await client.query(
          "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
          [stateId, JSON.stringify(nextState)]
        );
        await client.query("COMMIT");
        sendJson(req, res, 200, {
          ok: true,
          stock: nextStock,
          batches: nextBatches,
          operationLog,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      sendJson(req, res, 400, { error: `Failed to save stock: ${error.message}` });
	    }
	    return;
	  }

	  if (url.pathname === "/api/maintenance/save" && req.method === "POST") {
	    try {
	      const body = await readBody(req);
	      const {
	        mode,
	        itemIds = [],
	        stockItemId,
	        targetSubTankId,
	        moveDate,
	        moveNotes = "",
	        recordDate,
	        recordText = "",
	        recordPhotos = [],
	        recordVideos = [],
	        lossDate,
	        lossReason = "",
	        lossProof = [],
	        operator = "system",
	      } = await externalizeDataUrls(JSON.parse(body));
	      if (!mode) {
	        sendJson(req, res, 400, { error: "Missing maintenance save mode" });
	        return;
	      }

	      const client = await pool.connect();
	      try {
	        await client.query("BEGIN");
	        const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
	        const state = rows[0]?.data ?? {};
	        const stock = Array.isArray(state.stock) ? state.stock : [];
	        const bioRecords = Array.isArray(state.bioRecords) ? state.bioRecords : [];
	        const lossRecords = Array.isArray(state.lossRecords) ? state.lossRecords : [];
	        const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
	        let nextStock = stock;
	        let nextBioRecords = bioRecords;
	        let nextLossRecords = lossRecords;
	        let nextBatches = state.batches;
	        let operationLog;

	        if (mode === "record") {
	          const requestedIds = Array.isArray(itemIds) ? itemIds.map((id) => String(id)) : [];
	          const idSet = new Set(requestedIds);
	          if (idSet.size === 0) throw new Error("请选择要维护记录的鱼");
	          const targetItems = stock.filter((item) => idSet.has(String(item.id)));
	          if (targetItems.length !== idSet.size) throw new Error("部分库存鱼不存在或已被删除");
	          const shippedIds = shippedOutStockIds(state);
	          const invalidItem = targetItems.find((item) => !isPhysicallyInTank(item, shippedIds));
	          if (invalidItem) throw new Error("已损耗或已发货的鱼不能添加维护记录");
	          const date = String(recordDate ?? "").trim();
	          if (!date) throw new Error("请选择记录时间");
	          if (date > nowDatetimeInChina()) throw new Error("记录时间不能晚于当前时间");
	          const invalidDateItem = targetItems.find((item) => item.inDate && date < `${item.inDate}T00:00`);
	          if (invalidDateItem) throw new Error("记录时间不能早于入库日期");
	          const text = String(recordText ?? "").trim();
	          const photos = Array.isArray(recordPhotos) ? recordPhotos : [];
	          const videos = Array.isArray(recordVideos) ? recordVideos : [];
	          if (!text && photos.length === 0 && videos.length === 0) {
	            throw new Error("请填写记录内容或上传照片/视频");
	          }
	          const records = targetItems.map((item) => ({
	            id: uid("bio"),
	            siteId: normalizeSiteId(item.siteId),
	            stockItemId: item.id,
	            date,
	            text,
	            photos,
	            videos,
	            sourceType: "manual",
	            operator,
	          }));
	          nextBioRecords = [...bioRecords, ...records];
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "日常管理",
	            action: "添加记录",
	            detail: `批量添加观察/治疗记录 ${targetItems.length} 条（${date}）`,
	          };
	        } else if (mode === "move") {
	          const targetId = String(targetSubTankId ?? "");
	          if (!findSubTank(state, targetId)) throw new Error("目标子缸不存在或已被删除");
	          const targetName = subTankDisplayName(state, targetId);
	          const requestedIds = Array.isArray(itemIds) ? itemIds.map((id) => String(id)) : [];
	          const idSet = new Set(requestedIds);
	          if (idSet.size === 0) throw new Error("请选择要移缸的鱼");
	          const shippedIds = shippedOutStockIds(state);
	          const movingItems = stock.filter((item) => idSet.has(item.id));
	          if (movingItems.length === 0) throw new Error("没有找到要移缸的库存鱼");
	          const invalidItem = movingItems.find((item) => !isPhysicallyInTank(item, shippedIds));
	          if (invalidItem) throw new Error("已损耗或已发货的鱼不能移缸");
	          if (movingItems.every((item) => item.subTankId === targetId)) throw new Error("目标子缸与当前子缸相同");
	          const notes = String(moveNotes ?? "").trim();
	          const date = String(moveDate ?? new Date().toISOString().slice(0, 10)).trim();
	          const moveRecords = movingItems.map((item) => ({
	            id: uid("bio"),
	            siteId: normalizeSiteId(item.siteId),
	            stockItemId: item.id,
	            date,
	            text: `移缸：${subTankDisplayName(state, item.subTankId)} → ${targetName}${notes ? `。备注：${notes}` : ""}`,
	            photos: [],
	            videos: [],
	          }));
	          nextStock = stock.map((item) =>
	            idSet.has(item.id) ? { ...item, subTankId: targetId } : item
	          );
	          nextBioRecords = [...bioRecords, ...moveRecords];
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "日常管理",
	            action: "修改记录",
	            detail: `移缸 ${movingItems.length} 条至「${targetName}」`,
	          };
	        } else if (mode === "loss") {
	          const requestedLossIds = Array.isArray(itemIds) && itemIds.length > 0
	            ? itemIds.map((id) => String(id))
	            : [String(stockItemId ?? "")].filter(Boolean);
	          const idSet = new Set(requestedLossIds);
	          if (idSet.size === 0) throw new Error("请选择要损耗的鱼");
	          const losingItems = stock.filter((item) => idSet.has(String(item.id)));
	          if (losingItems.length !== idSet.size) throw new Error("部分库存鱼不存在或已被删除");
	          const shippedIds = shippedOutStockIds(state);
	          const invalidItem = losingItems.find((item) => !isPhysicallyInTank(item, shippedIds));
	          if (invalidItem) throw new Error("已损耗或已发货的鱼不能重复损耗");
	          const date = String(lossDate ?? "").trim();
	          if (!date) throw new Error("请选择损耗日期");
	          const invalidDateItem = losingItems.find((item) => item.inDate && date < item.inDate);
	          if (invalidDateItem) throw new Error("损耗日期不能早于入库日期");
	          const today = todayInChina();
	          if (date > today) throw new Error("损耗日期不能晚于今天");
	          const proof = Array.isArray(lossProof) ? lossProof : [];
	          if (proof.length === 0) throw new Error("请上传损耗照片凭证");
	          const reason = String(lossReason ?? "").trim();
	          const lossBioRecords = losingItems.map((item) => {
	            const relatedOrder = findActiveOrderForStock(state, item.id);
	            const text = `损耗${reason ? `：${reason}` : ""}${relatedOrder ? `。关联订单：${relatedOrder.orderNo}，请在订单详情中退商品并按实际情况填写退款金额` : ""}`;
	            return { id: uid("bio"), siteId: normalizeSiteId(item.siteId), stockItemId: item.id, date, text, photos: proof, videos: [] };
	          });
	          const lossRecordRows = losingItems.map((item) => {
	            const sourceTank = findSubTank(state, item.subTankId);
	            const sourceTankName = sourceTank
	              ? `${sourceTank.group.name} / ${sourceTank.subTank.name}`
	              : `已删除缸位（${item.subTankId || "无缸位ID"}）`;
	            return {
	              id: uid("loss"),
	              siteId: normalizeSiteId(item.siteId),
	              stockItemId: item.id,
	              date,
	              reason,
	              proofPhotos: proof,
	              operator,
	              subTankId: item.subTankId,
	              tankGroupId: sourceTank?.group?.id ?? "",
	              tankGroupName: sourceTank?.group?.name ?? "",
	              subTankName: sourceTank?.subTank?.name ?? "",
	              tankLocation: sourceTank?.group?.location ?? "",
	              tankName: sourceTankName,
	            };
	          });
	          nextStock = stock.map((item) =>
	            idSet.has(String(item.id))
	              ? { ...item, lost: true, lossDate: date, lossReason: reason, lossProof: proof }
	              : item
	          );
	          nextBatches = refreshBatchStockCounts(state.batches, nextStock);
	          nextBioRecords = [...bioRecords, ...lossBioRecords];
	          nextLossRecords = [...lossRecords, ...lossRecordRows];
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "日常管理",
	            action: "删除记录",
	            detail: `登记损耗 ${losingItems.length} 条${reason ? `：${reason}` : ""}`,
	          };
	        } else {
	          throw new Error("Unsupported maintenance save mode");
	        }

	        const nextState = {
	          ...state,
	          stock: nextStock,
	          batches: nextBatches,
	          bioRecords: nextBioRecords,
	          lossRecords: nextLossRecords,
	          operationLogs: pushOperationLog(operationLogs, operationLog),
	        };
	        await client.query(
	          "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
	          [stateId, JSON.stringify(nextState)]
	        );
	        await client.query("COMMIT");
	        sendJson(req, res, 200, {
	          ok: true,
	          stock: nextStock,
	          batches: nextBatches,
	          bioRecords: nextBioRecords,
	          lossRecords: nextLossRecords,
	          operationLog,
	        });
	      } catch (error) {
	        await client.query("ROLLBACK");
	        throw error;
	      } finally {
	        client.release();
	      }
	    } catch (error) {
	      sendJson(req, res, 400, { error: `Failed to save maintenance action: ${error.message}` });
	    }
	    return;
	  }

	  if (url.pathname === "/api/tank-groups/save" && req.method === "POST") {
	    try {
	      const body = await readBody(req);
	      const {
	        mode,
	        group,
	        groupId,
	        subTank,
	        subTankId,
	        operator = "system",
	      } = await externalizeDataUrls(JSON.parse(body));
	      if (!mode) {
	        sendJson(req, res, 400, { error: "Missing tank group save mode" });
	        return;
	      }

	      const client = await pool.connect();
	      try {
	        await client.query("BEGIN");
	        const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
	        const state = rows[0]?.data ?? {};
	        const tankGroups = Array.isArray(state.tankGroups) ? state.tankGroups : [];
	        const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
	        let nextTankGroups = tankGroups;
	        let operationLog;

	        if (mode === "upsertGroup") {
	          const rawGroup = group && typeof group === "object" ? group : {};
	          const existing = rawGroup.id ? tankGroups.find((item) => item.id === rawGroup.id) : null;
	          const existingSubTanks = existing?.subTanks ?? (Array.isArray(rawGroup.subTanks) ? rawGroup.subTanks.map(normalizeSubTank) : []);
	          const normalizedGroup = normalizeTankGroup(rawGroup, existingSubTanks);
	          const duplicate = tankGroups.find((item) =>
	            item.id !== normalizedGroup.id &&
	            normalizeSiteId(item.siteId) === normalizedGroup.siteId &&
	            String(item.name ?? "").trim() === normalizedGroup.name
	          );
	          if (duplicate) throw new Error("缸组名已存在，请使用不同的名称");

	          const exists = tankGroups.some((item) => item.id === normalizedGroup.id);
	          nextTankGroups = exists
	            ? tankGroups.map((item) => item.id === normalizedGroup.id ? normalizedGroup : item)
	            : [...tankGroups, normalizedGroup];
	          const changeParts = [];
	          if (existing && String(existing.name ?? "") !== normalizedGroup.name) {
	            changeParts.push(`名称「${existing.name || "未填写"}」→「${normalizedGroup.name}」`);
	          }
	          if (existing && String(existing.location ?? "") !== normalizedGroup.location) {
	            changeParts.push(`位置「${existing.location || "未填写"}」→「${normalizedGroup.location || "未填写"}」`);
	          }
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "缸组管理",
	            action: exists ? "修改记录" : "添加记录",
	            detail: exists
	              ? `修改缸组「${normalizedGroup.name}」（${normalizedGroup.id}）${changeParts.length ? `：${changeParts.join("，")}` : ""}`
	              : `新增缸组「${normalizedGroup.name}」（${normalizedGroup.id}）`,
	          };
	        } else if (mode === "deleteGroup") {
	          const targetId = String(groupId ?? "");
	          const target = tankGroups.find((item) => item.id === targetId);
	          if (!target) throw new Error("缸组不存在或已被删除");
	          const subTankIds = Array.isArray(target.subTanks) ? target.subTanks.map((item) => item.id) : [];
	          const activeCount = activeStockCountForSubTanks(state, subTankIds);
	          if (activeCount > 0) throw new Error(`该缸组还有 ${activeCount} 条在缸库存，不能删除`);
	          nextTankGroups = tankGroups.filter((item) => item.id !== targetId);
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "缸组管理",
	            action: "删除记录",
	            detail: `删除缸组「${target.name}」（${target.id}），包含 ${subTankIds.length} 个子缸`,
	          };
	        } else if (mode === "upsertSubTank") {
	          const targetGroupId = String(groupId ?? "");
	          const groupIndex = tankGroups.findIndex((item) => item.id === targetGroupId);
	          if (groupIndex < 0) throw new Error("缸组不存在或已被删除");
	          const targetGroup = tankGroups[groupIndex];
	          const rawSubTank = subTank && typeof subTank === "object" ? subTank : {};
	          const normalizedSubTank = normalizeSubTank(rawSubTank);
	          const currentSubTanks = Array.isArray(targetGroup.subTanks) ? targetGroup.subTanks : [];
	          const duplicate = currentSubTanks.find((item) =>
	            item.id !== normalizedSubTank.id && String(item.name ?? "").trim() === normalizedSubTank.name
	          );
	          if (duplicate) throw new Error("该缸组内已存在同名子缸，请使用不同的名称");
	          const existing = currentSubTanks.find((item) => item.id === normalizedSubTank.id);
	          const nextSubTanks = existing
	            ? currentSubTanks.map((item) => item.id === normalizedSubTank.id ? normalizedSubTank : item)
	            : [...currentSubTanks, normalizedSubTank];
	          nextTankGroups = tankGroups.map((item, index) =>
	            index === groupIndex ? { ...targetGroup, subTanks: nextSubTanks } : item
	          );
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "缸组管理",
	            action: existing ? "修改记录" : "添加记录",
	            detail: existing
	              ? `修改缸组「${targetGroup.name}」（${targetGroup.id}）子缸「${existing.name}」（${normalizedSubTank.id}）→「${normalizedSubTank.name}」`
	              : `在缸组「${targetGroup.name}」（${targetGroup.id}）新增子缸「${normalizedSubTank.name}」（${normalizedSubTank.id}）`,
	          };
	        } else if (mode === "deleteSubTank") {
	          const targetGroupId = String(groupId ?? "");
	          const targetSubTankId = String(subTankId ?? "");
	          const groupIndex = tankGroups.findIndex((item) => item.id === targetGroupId);
	          if (groupIndex < 0) throw new Error("缸组不存在或已被删除");
	          const targetGroup = tankGroups[groupIndex];
	          const currentSubTanks = Array.isArray(targetGroup.subTanks) ? targetGroup.subTanks : [];
	          const targetSubTank = currentSubTanks.find((item) => item.id === targetSubTankId);
	          if (!targetSubTank) throw new Error("子缸不存在或已被删除");
	          const activeCount = activeStockCountForSubTank(state, targetSubTankId);
	          if (activeCount > 0) throw new Error(`该子缸还有 ${activeCount} 条在缸库存，不能删除`);
	          const nextSubTanks = currentSubTanks.filter((item) => item.id !== targetSubTankId);
	          nextTankGroups = tankGroups.map((item, index) =>
	            index === groupIndex ? { ...targetGroup, subTanks: nextSubTanks } : item
	          );
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "缸组管理",
	            action: "删除记录",
	            detail: `删除缸组「${targetGroup.name}」（${targetGroup.id}）子缸「${targetSubTank.name}」（${targetSubTank.id}）`,
	          };
	        } else {
	          throw new Error("Unsupported tank group save mode");
	        }

	        const nextState = {
	          ...state,
	          tankGroups: nextTankGroups,
	          operationLogs: pushOperationLog(operationLogs, operationLog),
	        };
	        await client.query(
	          "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
	          [stateId, JSON.stringify(nextState)]
	        );
	        await client.query("COMMIT");
	        sendJson(req, res, 200, {
	          ok: true,
	          tankGroups: nextTankGroups,
	          operationLog,
	        });
	      } catch (error) {
	        await client.query("ROLLBACK");
	        throw error;
	      } finally {
	        client.release();
	      }
	    } catch (error) {
	      sendJson(req, res, 400, { error: `Failed to save tank groups: ${error.message}` });
	    }
	    return;
	  }

	  if (url.pathname === "/api/daily-logs/save" && req.method === "POST") {
	    try {
	      const body = await readBody(req);
	      const { log, deleteId, operator = "system" } = await externalizeDataUrls(JSON.parse(body));
	      if (!log && !deleteId) {
	        sendJson(req, res, 400, { error: "No daily log change provided" });
	        return;
	      }

	      const client = await pool.connect();
	      try {
	        await client.query("BEGIN");
	        const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
	        const state = rows[0]?.data ?? {};
	        const logs = Array.isArray(state.logs) ? state.logs : [];
	        const tankGroups = Array.isArray(state.tankGroups) ? state.tankGroups : [];
	        const bioRecords = Array.isArray(state.bioRecords) ? state.bioRecords : [];
	        const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
	        let nextLogs = logs;
	        let nextBioRecords = bioRecords;
	        let operationLog;

	        if (deleteId) {
	          const targetId = String(deleteId);
	          const target = logs.find((item) => item.id === targetId);
	          if (!target) throw new Error("养护日志不存在或已被删除");
	          const targetGroupId = target.tankGroupId || tankGroups.find((group) =>
	            Array.isArray(group.subTanks) && group.subTanks.some((tank) => tank.id === target.subTankId)
	          )?.id;
	          const groupName = tankGroups.find((group) => group.id === targetGroupId)?.name ?? "未知缸组";
	          nextLogs = logs.filter((item) => item.id !== targetId);
	          nextBioRecords = bioRecords.filter((record) =>
	            !(record?.sourceType === "dailyLog" && String(record?.sourceLogId ?? "") === targetId)
	          );
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "日常管理",
	            action: "删除记录",
	            detail: `删除养护日志「${target.action}」（${target.date}，缸组：${groupName}/${targetGroupId || "未知"}）`,
	          };
	        } else {
	          const normalizedLog = normalizeDailyLog(log);
	          const group = tankGroups.find((item) => item.id === normalizedLog.tankGroupId);
	          if (!group) throw new Error("缸组不存在或已被删除");
	          const previousLog = logs.find((item) => item.id === normalizedLog.id) ?? null;
	          const exists = !!previousLog;
	          const synced = syncDailyLogToBioRecords(
	            { ...state, logs, bioRecords },
	            bioRecords,
	            normalizedLog,
	            previousLog
	          );
	          const logToStore = synced.log;
	          nextBioRecords = synced.bioRecords;
	          nextLogs = exists
	            ? logs.map((item) => item.id === normalizedLog.id ? logToStore : item)
	            : [...logs, logToStore];
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "日常管理",
	            action: exists ? "修改记录" : "添加记录",
	            detail: `${exists ? "修改" : "新增"}养护日志「${normalizedLog.action}」（${normalizedLog.date}，缸组：${group.name}/${group.id}，操作员：${normalizedLog.operator}，同步 ${synced.syncedCount} 条鱼）`,
	          };
	        }

	        const nextState = {
	          ...state,
	          logs: nextLogs,
	          bioRecords: nextBioRecords,
	          operationLogs: pushOperationLog(operationLogs, operationLog),
	        };
	        await client.query(
	          "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
	          [stateId, JSON.stringify(nextState)]
	        );
	        await client.query("COMMIT");
	        sendJson(req, res, 200, {
	          ok: true,
	          logs: nextLogs,
	          bioRecords: nextBioRecords,
	          operationLog,
	        });
	      } catch (error) {
	        await client.query("ROLLBACK");
	        throw error;
	      } finally {
	        client.release();
	      }
	    } catch (error) {
	      sendJson(req, res, 400, { error: `Failed to save daily logs: ${error.message}` });
	    }
	    return;
	  }

	  if (url.pathname === "/api/products/upsert" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { product, operator = "system" } = JSON.parse(body);
      if (!product || typeof product !== "object") {
        sendJson(req, res, 400, { error: "Missing product" });
        return;
      }
      if (!product.id || !product.speciesId || !product.name || !product.size || !product.origin) {
        sendJson(req, res, 400, { error: "Product id, speciesId, name, size and origin are required" });
        return;
      }
      if (!(Number(product.defaultPrice) > 0)) {
        sendJson(req, res, 400, { error: "Product defaultPrice must be greater than 0" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
        const state = rows[0]?.data ?? {};
        const products = Array.isArray(state.products) ? state.products : [];
        const productOrigins = Array.isArray(state.productOrigins) ? state.productOrigins : [];
        const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];

        const normalizedProduct = await externalizeDataUrls({
          ...product,
          name: String(product.name).trim(),
          size: String(product.size).trim(),
          origin: String(product.origin).trim(),
          imageUrl: String(product.imageUrl ?? ""),
          notes: String(product.notes ?? "").trim(),
          defaultPrice: Number(product.defaultPrice),
          commissionRate: Math.max(0, Number(product.commissionRate ?? 0)),
        });
        const exists = products.some((item) => item.id === normalizedProduct.id);
        const nextProducts = exists
          ? products.map((item) => item.id === normalizedProduct.id ? normalizedProduct : item)
          : [...products, normalizedProduct];
        const nextOrigins = mergeProductOrigins(productOrigins, nextProducts);
        const operationLog = {
          id: uid("log"),
          time: new Date().toISOString(),
          operator,
          module: "商品管理",
          action: exists ? "修改记录" : "添加记录",
          detail: `${exists ? "修改" : "新增"}商品「${normalizedProduct.name}」`,
        };
	        const nextState = {
	          ...state,
	          products: nextProducts,
	          productOrigins: nextOrigins,
	          operationLogs: pushOperationLog(operationLogs, operationLog),
	        };

        await client.query(
          `UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1`,
          [stateId, JSON.stringify(nextState)]
        );
        await client.query("COMMIT");
        sendJson(req, res, 200, {
          ok: true,
          product: normalizedProduct,
          products: nextProducts,
          productOrigins: nextOrigins,
          operationLog,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      sendJson(req, res, 400, { error: `Failed to save product: ${error.message}` });
    }
    return;
  }

  sendJson(req, res, 404, { error: "Not found" });
}

async function serveStatic(req, res, url) {
  if (!existsSync(distDir)) {
    sendJson(req, res, 404, {
      error: "No production build found. Run npm run build first, or use npm run dev:local for development.",
    });
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const candidate = normalize(join(distDir, requested));
  const filePath = candidate.startsWith(distDir) ? candidate : join(distDir, "index.html");
  const finalPath = existsSync(filePath) ? filePath : join(distDir, "index.html");

  try {
    const fileStat = await stat(finalPath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "Content-Type": mimeTypes[extname(finalPath)] || "application/octet-stream" });
    createReadStream(finalPath).pipe(res);
  } catch {
    sendJson(req, res, 404, { error: "Static file not found" });
  }
}

async function serveUpload(req, res, url) {
  const relative = decodeURIComponent(url.pathname.replace(/^\/uploads\/?/, ""));
  const candidate = normalize(join(uploadDir, relative));
  const finalPath = candidate === uploadDir || candidate.startsWith(`${uploadDir}/`) ? candidate : "";
  if (!finalPath) {
    sendJson(req, res, 404, { error: "Upload file not found" });
    return;
  }

  try {
    const fileStat = await stat(finalPath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    res.writeHead(200, {
      "Content-Type": mimeTypes[extname(finalPath)] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    createReadStream(finalPath).pipe(res);
  } catch {
    sendJson(req, res, 404, { error: "Upload file not found" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/uploads/")) {
      await serveUpload(req, res, url);
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(req, res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(port, host, () => {
  console.log(`Local Fishroom API/static server: http://${host}:${port}`);
  console.log(`PostgreSQL state table: ${pgConfig.database}.app_state`);
});
