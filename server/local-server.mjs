import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
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
const MAX_IMAGE_UPLOAD_BYTES = numberFromEnv(process.env.MAX_IMAGE_UPLOAD_BYTES, 50 * 1024 * 1024);
const MAX_VIDEO_UPLOAD_BYTES = numberFromEnv(process.env.MAX_VIDEO_UPLOAD_BYTES, 300 * 1024 * 1024);
const DEFAULT_SITE_ID = "nanjing";
const ALL_SITE_ID = "all";
const DEFAULT_SITES = [
  { id: "jiangyin", name: "江阴" },
  { id: "nanjing", name: "南京" },
  { id: "beijing", name: "北京" },
];
const AUTH_SESSION_TTL_MS = numberFromEnv(process.env.AUTH_SESSION_TTL_MS, 4 * 60 * 60 * 1000);
const AUTH_COOKIE_NAME = "fishroom_auth";
const configuredAuthTokenSecret = process.env.AUTH_SESSION_SECRET || process.env.SESSION_SECRET || "";
if (process.env.NODE_ENV === "production" && !configuredAuthTokenSecret) {
  throw new Error("AUTH_SESSION_SECRET or SESSION_SECRET must be set in production");
}
const authTokenSecret = configuredAuthTokenSecret || randomBytes(32).toString("hex");
const allowDefaultCredentials = process.env.ALLOW_DEFAULT_CREDENTIALS === "true";
const BOOTSTRAP_AUTH_ACCOUNTS = [
  { id: "person-admin", name: "admin", username: "admin", password: process.env.BOOTSTRAP_ADMIN_PASSWORD || "", accessRole: "admin", employmentStatus: "active" },
  { id: "person-staff", name: "staff", username: "staff", password: process.env.BOOTSTRAP_STAFF_PASSWORD || "", accessRole: "staff", employmentStatus: "active" },
  { id: "person-staff-a", name: "员工A", username: "staff-a", password: process.env.BOOTSTRAP_STAFF_A_PASSWORD || "", accessRole: "staff", employmentStatus: "active" },
].filter((account) => account.password);
const DEFAULT_CREDENTIAL_DIGESTS = new Set([
  "8da193366e1554c08b2870c50f737b9587c3372b656151c4a96028af26f51334",
  "6a49d425846a4d91e07e1ed9ea784e28a9a51381f53189bae64cbd53491e37b4",
  "58624d00f23ec46db114b446abf858d4310b88a970c69782ff3d3723b1fa2eec",
  "f5aeab35700ff0aa77236eb296bd9e4e7b9b55cda1b790718f14d712184d8909",
]);
const PERMISSION_MODULE_KEYS = [
  "species",
  "products",
  "tankGroups",
  "batches",
  "stockIn",
  "daily",
  "lossRecords",
  "customers",
  "orders",
  "accounts",
];
const PERMISSION_ACTIONS = ["create", "update", "delete"];
const STATE_PATCH_PERMISSION_MODULES = {
  systemSettings: "accounts",
  sites: "accounts",
  species: "species",
  speciesCategories: "species",
  products: "products",
  productOrigins: "products",
  tankGroups: "tankGroups",
  batches: "batches",
  stock: "stockIn",
  logs: "daily",
  checks: "daily",
  bioRecords: "daily",
  lossRecords: "lossRecords",
  customers: "customers",
  customerSources: "customers",
  orders: "orders",
  shipments: "orders",
};
const DISALLOWED_STATE_PATCH_KEYS = new Set(["personnel"]);
const PASSWORD_HASH_PREFIX = "scrypt$1$";
const cosConfig = {
  secretId: process.env.COS_SECRET_ID || "",
  secretKey: process.env.COS_SECRET_KEY || "",
  bucket: process.env.COS_BUCKET || "",
  region: process.env.COS_REGION || "",
  publicBaseUrl: String(process.env.COS_PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
  prefix: String(process.env.COS_PREFIX || "fishroom").replace(/^\/+|\/+$/g, ""),
};
let cosClient;

const aiConfig = {
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "",
  apiBaseUrl: String(process.env.AI_API_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
  chatPath: `/${String(process.env.AI_CHAT_COMPLETIONS_PATH || "chat/completions").replace(/^\/+/, "")}`,
  model: process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
  temperature: numberFromEnv(process.env.AI_TEMPERATURE, 0.2),
  timeoutMs: numberFromEnv(process.env.AI_TIMEOUT_MS, 25000),
  maxContextRows: numberFromEnv(process.env.AI_MAX_CONTEXT_ROWS, 80),
};

const feishuConfig = {
  webhookUrl: process.env.FEISHU_WEBHOOK_URL || "",
  webhookSecret: process.env.FEISHU_WEBHOOK_SECRET || "",
  appId: process.env.FEISHU_APP_ID || "",
  appSecret: process.env.FEISHU_APP_SECRET || "",
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
  openApiBaseUrl: String(process.env.FEISHU_OPEN_API_BASE_URL || "https://open.feishu.cn").replace(/\/+$/, ""),
  defaultSiteId: process.env.FEISHU_DEFAULT_SITE_ID || ALL_SITE_ID,
};
let feishuTenantTokenCache = { token: "", expiresAt: 0 };
const weatherForecastConfig = {
  geocodingBaseUrl: String(process.env.WEATHER_GEOCODING_BASE_URL || "https://geocoding-api.open-meteo.com/v1/search").replace(/\/+$/, ""),
  forecastBaseUrl: String(process.env.WEATHER_FORECAST_BASE_URL || "https://api.open-meteo.com/v1/forecast").replace(/\/+$/, ""),
  timeoutMs: numberFromEnv(process.env.WEATHER_FORECAST_TIMEOUT_MS, 8000),
  cacheTtlMs: numberFromEnv(process.env.WEATHER_FORECAST_CACHE_TTL_MS, 6 * 60 * 60 * 1000),
};
const weatherForecastCache = new Map();
const STATE_KEYS = [
  "systemSettings",
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

function sendJson(req, res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  if (acceptsGzip(req) && payload.length > 1024) {
    res.writeHead(status, {
      ...jsonHeaders,
      ...extraHeaders,
      "Content-Encoding": "gzip",
      "Vary": "Accept-Encoding",
    });
    const gzip = createGzip();
    gzip.pipe(res);
    gzip.end(payload);
    return;
  }

  res.writeHead(status, { ...jsonHeaders, ...extraHeaders });
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

function normalizeVisibleSiteIds(value, sites = []) {
  if (!Array.isArray(value)) return [];
  const allowedIds = new Set((Array.isArray(sites) ? sites : []).map((site) => normalizeSiteId(site?.id)));
  const normalized = [];
  value.forEach((item) => {
    const rawId = String(item ?? "").trim();
    const id = rawId ? normalizeSiteId(rawId) : "";
    if (!id || (allowedIds.size > 0 && !allowedIds.has(id)) || normalized.includes(id)) return;
    normalized.push(id);
  });
  return normalized;
}

function visibleSiteIdsForAccount(account = {}, state = {}) {
  const sites = getSitesFromState(state);
  const allSiteIds = sites.map((site) => site.id);
  if (account?.accessRole === "admin") return allSiteIds;
  const configuredIds = normalizeVisibleSiteIds(account?.visibleSiteIds, sites);
  return configuredIds.length > 0 ? configuredIds : allSiteIds;
}

function matchesAnyVisibleSite(item, visibleSiteIds = []) {
  return visibleSiteIds.some((siteId) => matchesSite(item, siteId));
}

function stockMatchesSite(state = {}, item = {}, siteId = ALL_SITE_ID) {
  if (siteId === ALL_SITE_ID) return true;
  const tankSiteId = findSubTank(state, item?.subTankId)?.group?.siteId;
  if (tankSiteId) return normalizeSiteId(tankSiteId) === siteId;
  return matchesSite(item, siteId);
}

function stockMatchesAnyVisibleSite(state = {}, item = {}, visibleSiteIds = []) {
  return visibleSiteIds.some((siteId) => stockMatchesSite(state, item, siteId));
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
  const stock = (Array.isArray(state.stock) ? state.stock : []).filter((item) => stockMatchesSite(state, item, scope));
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

function siteVisibilityFilteredState(state = {}, account = {}) {
  if (!account || account.accessRole === "admin") return state;
  const sites = getSitesFromState(state);
  const visibleSiteIds = visibleSiteIdsForAccount(account, state);
  if (visibleSiteIds.length === 0 || visibleSiteIds.length >= sites.length) return state;
  const tankGroups = (Array.isArray(state.tankGroups) ? state.tankGroups : []).filter((item) =>
    matchesAnyVisibleSite(item, visibleSiteIds)
  );
  const subTankIds = new Set(tankGroups.flatMap((group) =>
    (Array.isArray(group?.subTanks) ? group.subTanks : []).map((tank) => String(tank?.id ?? "")).filter(Boolean)
  ));
  const orders = (Array.isArray(state.orders) ? state.orders : []).filter((item) =>
    matchesAnyVisibleSite(item, visibleSiteIds)
  );
  const orderIds = new Set(orders.map((order) => String(order?.id ?? "")).filter(Boolean));
  const stock = (Array.isArray(state.stock) ? state.stock : []).filter((item) =>
    stockMatchesAnyVisibleSite(state, item, visibleSiteIds)
  );
  const stockIds = new Set(stock.map((item) => String(item?.id ?? "")).filter(Boolean));
  return {
    ...state,
    tankGroups,
    batches: (Array.isArray(state.batches) ? state.batches : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds)
    ),
    stock,
    logs: (Array.isArray(state.logs) ? state.logs : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds) || subTankIds.has(String(item?.subTankId ?? ""))
    ),
    checks: (Array.isArray(state.checks) ? state.checks : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds) || subTankIds.has(String(item?.subTankId ?? ""))
    ),
    lossRecords: (Array.isArray(state.lossRecords) ? state.lossRecords : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds) || stockIds.has(String(item?.stockItemId ?? ""))
    ),
    bioRecords: (Array.isArray(state.bioRecords) ? state.bioRecords : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds) || stockIds.has(String(item?.stockItemId ?? ""))
    ),
    orders,
    shipments: (Array.isArray(state.shipments) ? state.shipments : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds) || orderIds.has(String(item?.orderId ?? ""))
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

function buildStatePatch(current = {}, patch = {}, basePatch = {}, incomingLogs = [], req) {
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
    [...incomingLogs, ...sanitizeOperationLogsForAuth(patch.operationLogs, req)]
  );
  return nextState;
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

function isPublicMediaUrl(value) {
  const src = String(value ?? "").trim();
  if (!src) return false;
  if (src.startsWith("/uploads/")) return true;
  try {
    const url = new URL(src);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function publicMediaUrls(value, limit = 6) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? "").trim())
    .filter(isPublicMediaUrl)
    .slice(0, limit);
}

function publicCatalogMediaUrl(src) {
  const value = String(src ?? "").trim();
  if (!value) return "";
  return cosKeyFromUrl(value)
    ? `/api/public/media/cos?url=${encodeURIComponent(value)}`
    : value;
}

function publicCatalogMediaUrls(value, limit = 6) {
  return publicMediaUrls(value, limit).map(publicCatalogMediaUrl);
}

function publicBioRecordText(value) {
  return clampText(String(value ?? "").replace(/[；。]?备注[:：].*$/u, ""), 220);
}

function publicBioRecordPayload(record = {}, media = {}) {
  return {
    id: String(record?.id ?? ""),
    stockItemId: String(record?.stockItemId ?? ""),
    date: String(record?.date ?? ""),
    text: publicBioRecordText(record?.text ?? ""),
    sourceType: String(record?.sourceType ?? ""),
    tankGroupName: String(record?.tankGroupName ?? ""),
    subTankName: String(record?.subTankName ?? ""),
    operator: String(record?.operator ?? ""),
    photos: (media.photos ?? publicMediaUrls(record?.photos, 6)).map(publicCatalogMediaUrl),
    videos: (media.videos ?? publicMediaUrls(record?.videos, 3)).map(publicCatalogMediaUrl),
  };
}

function buildPublicCatalog(state = {}, siteId = ALL_SITE_ID) {
  const scopedState = siteFilteredState(normalizePickupShipmentsForState(state), siteId);
  const shippedIds = shippedOutStockIds(scopedState);
  const species = Array.isArray(scopedState.species) ? scopedState.species : [];
  const products = Array.isArray(scopedState.products) ? scopedState.products : [];
  const stock = Array.isArray(scopedState.stock) ? scopedState.stock : [];
  const bioRecords = Array.isArray(scopedState.bioRecords) ? scopedState.bioRecords : [];
  const publicProductIds = new Set(
    products
      .filter((product) => product?.publicVisible !== false)
      .map((product) => String(product?.id ?? ""))
      .filter(Boolean)
  );
  const sellableStock = stock.filter((item) =>
    !item?.sold &&
    item?.status !== "sick" &&
    isPhysicallyInTank(item, shippedIds) &&
    publicProductIds.has(String(item?.productId ?? ""))
  );
  const sellableStockIds = new Set(sellableStock.map((item) => String(item?.id ?? "")).filter(Boolean));
  const sellableProductIds = new Set(sellableStock.map((item) => String(item?.productId ?? "")).filter(Boolean));
  const availableProducts = products.filter((product) =>
    product?.publicVisible !== false &&
    sellableProductIds.has(String(product?.id ?? ""))
  );
  const productIds = new Set(availableProducts.map((product) => String(product?.id ?? "")).filter(Boolean));
  const speciesIds = new Set(availableProducts.map((product) => String(product?.speciesId ?? "")).filter(Boolean));
  const latestMediaByStockId = new Map();
  bioRecords
    .filter((record) => sellableStockIds.has(String(record?.stockItemId ?? "")))
    .forEach((record) => {
      const stockItemId = String(record?.stockItemId ?? "");
      const photos = publicMediaUrls(record?.photos, 6);
      const videos = publicMediaUrls(record?.videos, 3);
      if (photos.length > 0 || videos.length > 0) {
        const currentMedia = latestMediaByStockId.get(stockItemId);
        if (!currentMedia || String(record?.date ?? "").localeCompare(String(currentMedia?.date ?? "")) > 0) {
          latestMediaByStockId.set(stockItemId, { record, photos, videos });
        }
      }
    });
  const categorySet = new Set(
    species
      .filter((item) => speciesIds.has(String(item?.id ?? "")))
      .map((item) => String(item?.category ?? "").trim())
      .filter(Boolean)
  );
  const storedCategories = Array.isArray(scopedState.speciesCategories) ? scopedState.speciesCategories : [];
  const speciesCategories = [
    ...storedCategories.map((item) => String(item ?? "").trim()).filter((item) => item && categorySet.has(item)),
    ...[...categorySet].filter((item) => !storedCategories.includes(item)),
  ];

  return {
    speciesCategories,
    species: species
      .filter((item) => speciesIds.has(String(item?.id ?? "")))
      .map((item) => ({
        id: String(item?.id ?? ""),
        name: String(item?.name ?? ""),
        scientificName: String(item?.scientificName ?? ""),
        category: String(item?.category ?? ""),
        commonNames: Array.isArray(item?.commonNames) ? item.commonNames.map(String).slice(0, 6) : [],
        description: clampText(item?.description ?? "", 260),
        imageUrl: publicCatalogMediaUrl(item?.imageUrl),
      })),
    products: availableProducts
      .filter((item) => productIds.has(String(item?.id ?? "")))
      .map((item) => ({
        id: String(item?.id ?? ""),
        speciesId: String(item?.speciesId ?? ""),
        name: String(item?.name ?? ""),
        size: String(item?.size ?? ""),
        origin: String(item?.origin ?? ""),
        imageUrl: publicCatalogMediaUrl(item?.imageUrl),
        defaultPrice: Number(item?.defaultPrice ?? 0),
      })),
    stock: sellableStock.map((item) => {
      const tank = findSubTank(scopedState, item?.subTankId);
      return {
        id: String(item?.id ?? ""),
        productId: String(item?.productId ?? ""),
        code: String(item?.code ?? ""),
        status: item?.status === "feeding" ? "feeding" : "healthy",
        inDate: String(item?.inDate ?? ""),
        basePrice: Number(item?.basePrice ?? 0),
        tankGroupName: String(tank?.group?.name ?? ""),
        subTankName: String(tank?.subTank?.name ?? ""),
        tankLocation: String(tank?.group?.location ?? ""),
      };
    }),
    bioRecords: [...latestMediaByStockId.values()]
      .sort((a, b) =>
        String(b?.record?.date ?? "").localeCompare(String(a?.record?.date ?? "")) ||
        String(a?.record?.id ?? "").localeCompare(String(b?.record?.id ?? ""))
      )
      .map((media) => publicBioRecordPayload(media.record, media)),
  };
}

function buildPublicBioRecordsForStock(state = {}, siteId = ALL_SITE_ID, stockItemId = "") {
  const scopedState = siteFilteredState(normalizePickupShipmentsForState(state), siteId);
  const shippedIds = shippedOutStockIds(scopedState);
  const products = Array.isArray(scopedState.products) ? scopedState.products : [];
  const stock = Array.isArray(scopedState.stock) ? scopedState.stock : [];
  const targetId = String(stockItemId ?? "").trim();
  const item = stock.find((candidate) => String(candidate?.id ?? "") === targetId);
  if (!item || item?.sold || item?.status === "sick" || !isPhysicallyInTank(item, shippedIds)) return null;
  const product = products.find((candidate) => String(candidate?.id ?? "") === String(item?.productId ?? ""));
  if (!product || product?.publicVisible === false) return null;
  const records = Array.isArray(scopedState.bioRecords) ? scopedState.bioRecords : [];
  return records
    .filter((record) => String(record?.stockItemId ?? "") === targetId)
    .sort((a, b) =>
      String(a?.date ?? "").localeCompare(String(b?.date ?? "")) ||
      String(a?.id ?? "").localeCompare(String(b?.id ?? ""))
    )
    .map((record) => publicBioRecordPayload(record));
}

function publicCatalogAllowedMediaUrls(state = {}, siteId = ALL_SITE_ID) {
  const scopedState = siteFilteredState(normalizePickupShipmentsForState(state), siteId);
  const shippedIds = shippedOutStockIds(scopedState);
  const species = Array.isArray(scopedState.species) ? scopedState.species : [];
  const products = Array.isArray(scopedState.products) ? scopedState.products : [];
  const stock = Array.isArray(scopedState.stock) ? scopedState.stock : [];
  const bioRecords = Array.isArray(scopedState.bioRecords) ? scopedState.bioRecords : [];
  const publicProductIds = new Set(
    products
      .filter((product) => product?.publicVisible !== false)
      .map((product) => String(product?.id ?? ""))
      .filter(Boolean)
  );
  const sellableStock = stock.filter((item) =>
    !item?.sold &&
    item?.status !== "sick" &&
    isPhysicallyInTank(item, shippedIds) &&
    publicProductIds.has(String(item?.productId ?? ""))
  );
  const sellableStockIds = new Set(sellableStock.map((item) => String(item?.id ?? "")).filter(Boolean));
  const sellableProductIds = new Set(sellableStock.map((item) => String(item?.productId ?? "")).filter(Boolean));
  const availableProducts = products.filter((product) =>
    product?.publicVisible !== false &&
    sellableProductIds.has(String(product?.id ?? ""))
  );
  const speciesIds = new Set(availableProducts.map((product) => String(product?.speciesId ?? "")).filter(Boolean));
  const allowed = new Set();
  const add = (value) => {
    const src = String(value ?? "").trim();
    if (src && cosKeyFromUrl(src)) allowed.add(src);
  };

  availableProducts.forEach((product) => add(product?.imageUrl));
  species
    .filter((item) => speciesIds.has(String(item?.id ?? "")))
    .forEach((item) => add(item?.imageUrl));
  bioRecords
    .filter((record) => sellableStockIds.has(String(record?.stockItemId ?? "")))
    .forEach((record) => {
      publicMediaUrls(record?.photos, 6).forEach(add);
      publicMediaUrls(record?.videos, 3).forEach(add);
    });
  return allowed;
}

function normalizePickupShipmentRecord(shipment = {}) {
  if (shipment?.shipMethod !== "pickup") return shipment;
  const next = {
    ...shipment,
    carrier: String(shipment.carrier ?? "").trim() || "上门自取",
    status: "delivered",
    actualShippingFee: 0,
  };
  if (!next.shippedAt) {
    next.shippedAt = String(shipment.createdAt ?? shipment.shipDate ?? shipment.outboundDate ?? nowDatetimeInChina());
  }
  if (!next.deliveredAt) {
    next.deliveredAt = next.shippedAt;
  }
  return stableJson(next) === stableJson(shipment) ? shipment : next;
}

function normalizePickupShipmentsForState(state = {}) {
  if (!state || typeof state !== "object" || !Array.isArray(state.shipments)) return state;
  let changed = false;
  const shipments = state.shipments.map((shipment) => {
    const normalized = normalizePickupShipmentRecord(shipment);
    if (normalized !== shipment) changed = true;
    return normalized;
  });
  return changed ? { ...state, shipments } : state;
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

function datePart(value) {
  const raw = String(value ?? "").trim();
  const date = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function isDateOnOrBefore(value, threshold) {
  const date = datePart(value);
  return !!date && date <= threshold;
}

function msUntilNextChinaTime(hour = 4, minute = 0) {
  const chinaNowMs = Date.now() + 8 * 60 * 60 * 1000;
  const chinaNow = new Date(chinaNowMs);
  let targetMs = Date.UTC(
    chinaNow.getUTCFullYear(),
    chinaNow.getUTCMonth(),
    chinaNow.getUTCDate(),
    hour,
    minute,
    0,
    0
  );
  if (targetMs <= chinaNowMs) targetMs += 24 * 60 * 60 * 1000;
  return targetMs - chinaNowMs;
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

function isFishInventoryItem(product = null, species = null) {
  const commonNames = Array.isArray(species?.commonNames) ? species.commonNames : [];
  const text = [
    species?.category,
    species?.name,
    species?.scientificName,
    ...commonNames,
    product?.name,
    product?.size,
    product?.origin,
    product?.notes,
  ].filter(Boolean).join(" ");
  if (/(耗材|活石|活石头|珊瑚|活性炭|吸附|滤材|器材|设备|材料|药|盐|饲料|鱼粮|试剂)/.test(text)) return false;
  return isFishCategory(String(species?.category ?? text));
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
        isFish: isFishInventoryItem(product, itemSpecies),
      };
    })
    .filter((row) => row.date && row.stockItem && row.isFish);
}

function buildDailyLossData(state = {}, dates = [], productById = new Map(), speciesById = new Map()) {
  const stock = Array.isArray(state.stock) ? state.stock : [];
  const shipments = Array.isArray(state.shipments) ? state.shipments : [];
  const batches = Array.isArray(state.batches) ? state.batches : [];
  const batchById = new Map(batches.map((batch) => [String(batch?.id ?? ""), batch]));
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
    return isFishInventoryItem(product, itemSpecies);
  });
  const fishStockByBatchId = new Map();
  for (const item of fishStock) {
    const batchId = String(item?.batchId ?? "");
    if (!batchId) continue;
    if (!fishStockByBatchId.has(batchId)) fishStockByBatchId.set(batchId, []);
    fishStockByBatchId.get(batchId).push(item);
  }
  const lossStockIdsByBatchId = new Map();
  for (const row of lossRows) {
    const batchId = String(row.stockItem?.batchId ?? "");
    const stockId = String(row.stockItem?.id ?? "");
    if (!batchId || !stockId) continue;
    if (!lossStockIdsByBatchId.has(batchId)) lossStockIdsByBatchId.set(batchId, new Set());
    lossStockIdsByBatchId.get(batchId).add(stockId);
  }

  function tankNameForLossRow(row = {}) {
    const record = row.record ?? {};
    const explicitTankName = String(record?.tankName ?? "").trim();
    if (explicitTankName) return explicitTankName;
    const snapshotName = [record?.tankGroupName, record?.subTankName]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join(" / ");
    if (snapshotName) return snapshotName;
    const subTankId = String(row.stockItem?.subTankId ?? "").trim();
    return subTankId ? subTankDisplayName(state, subTankId) : "未知缸位";
  }

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
    const lossDetails = rowsForDate.map((row) => {
      const stockItem = row.stockItem ?? {};
      const product = row.product ?? {};
      const species = row.species ?? {};
      const batch = batchById.get(String(stockItem?.batchId ?? "")) ?? {};
      return {
        id: String(row.record?.id ?? stockItem?.id ?? ""),
        stockItemId: String(stockItem?.id ?? ""),
        productName: String(product?.name ?? "未命名商品"),
        speciesName: String(species?.name ?? ""),
        size: String(product?.size ?? ""),
        origin: String(product?.origin ?? ""),
        tankName: tankNameForLossRow(row),
        batchNo: String(batch?.batchNo ?? ""),
        supplier: String(batch?.supplier ?? ""),
        arrivalDate: String(batch?.arrivalDate ?? ""),
        reason: String(row.record?.reason ?? stockItem?.lossReason ?? ""),
        estimatedValue: Number(row.estimatedValue || 0),
        code: String(stockItem?.code ?? ""),
      };
    });
    const batchArrivals = batches
      .filter((batch) => String(batch?.arrivalDate ?? "").slice(0, 10) === date)
      .map((batch) => {
        const batchId = String(batch?.id ?? "");
        const batchStock = fishStockByBatchId.get(batchId) ?? [];
        const reportedStockedCount = Number(batch?.stockedCount);
        const reportedLossCount = Number(batch?.lossCount);
        return {
          id: batchId,
          batchNo: String(batch?.batchNo ?? ""),
          supplier: String(batch?.supplier ?? ""),
          arrivalDate: String(batch?.arrivalDate ?? ""),
          stockedCount: Number.isFinite(reportedStockedCount) && reportedStockedCount > 0
            ? reportedStockedCount
            : batchStock.length,
          lossCount: Number.isFinite(reportedLossCount) && reportedLossCount > 0
            ? reportedLossCount
            : (lossStockIdsByBatchId.get(batchId)?.size ?? 0),
          bioFee: Number(batch?.bioFee || 0),
          shippingFee: Number(batch?.shippingFee || 0),
        };
      });
    return {
      date,
      label: date.slice(5).replace("-", "/"),
      lostCount,
      stockBase,
      lossRate: stockBase > 0 ? lostCount / stockBase * 100 : 0,
      estimatedValue,
      lossDetails,
      batchArrivals,
    };
  });
}

function isValidDashboardSalesOrder(order = {}) {
  return order?.status !== "cancelled" && order?.status !== "damaged";
}

function isOfflinePickupDashboardOrder(order = {}, orderShipments = []) {
  const source = String(order?.source ?? "").trim();
  return source === "线下" ||
    source === "线下自提" ||
    (!source && orderShipments.some((shipment) => shipment?.shipMethod === "pickup"));
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
  const shipmentsByOrderId = new Map();
  for (const shipment of shipments) {
    const orderId = String(shipment?.orderId ?? "");
    if (!orderId) continue;
    shipmentsByOrderId.set(orderId, [...(shipmentsByOrderId.get(orderId) ?? []), shipment]);
  }
  const productById = new Map(products.map((product) => [product?.id, product]));
  const speciesById = new Map(species.map((item) => [item?.id, item]));
  const inTankFishStock = stock
    .filter((item) => isPhysicallyInTank(item, shippedIds))
    .filter((item) => {
      const product = productById.get(item?.productId);
      const itemSpecies = product ? speciesById.get(product.speciesId) : undefined;
      return isFishInventoryItem(product, itemSpecies);
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
    const salesRows = orders
      .filter((order) => isValidDashboardSalesOrder(order) && String(order?.date ?? "").slice(0, 10) === date)
      .map((order) => {
        const orderShipments = shipmentsByOrderId.get(String(order?.id ?? "")) ?? [];
        return {
          order,
          orderShipments,
          amount: Math.max(0, calcAmountDueForOrder(order, orderShipments)),
        };
      });
    return {
      date,
      label: date.slice(5).replace("-", "/"),
      received: payments
        .filter((payment) => payment?.type !== "refund")
        .reduce((sum, payment) => sum + Number(payment?.amount || 0), 0),
      refunded: payments
        .filter((payment) => payment?.type === "refund")
        .reduce((sum, payment) => sum + Number(payment?.amount || 0), 0),
      orderAmount: salesRows.reduce((sum, row) => sum + row.amount, 0),
      platformAmount: salesRows
        .filter((row) => String(row.order?.source ?? "").trim() === "平台下单")
        .reduce((sum, row) => sum + row.amount, 0),
      offlinePickupAmount: salesRows
        .filter((row) => isOfflinePickupDashboardOrder(row.order, row.orderShipments))
        .reduce((sum, row) => sum + row.amount, 0),
      privateDomainAmount: salesRows
        .filter((row) => String(row.order?.source ?? "").trim() === "私域线上")
        .reduce((sum, row) => sum + row.amount, 0),
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

function numberFromEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signAuthPayload(payload) {
  return createHmac("sha256", authTokenSecret).update(payload).digest("base64url");
}

function fullPermissionsValue() {
  return Object.fromEntries(PERMISSION_MODULE_KEYS.map((module) => [
    module,
    Object.fromEntries(PERMISSION_ACTIONS.map((action) => [action, true])),
  ]));
}

function emptyPermissionsValue() {
  return Object.fromEntries(PERMISSION_MODULE_KEYS.map((module) => [
    module,
    Object.fromEntries(PERMISSION_ACTIONS.map((action) => [action, false])),
  ]));
}

function normalizePermissionsForStorage(permissions) {
  const full = fullPermissionsValue();
  return Object.fromEntries(PERMISSION_MODULE_KEYS.map((module) => [
    module,
    Object.fromEntries(PERMISSION_ACTIONS.map((action) => [
      action,
      permissions?.[module]?.[action] ?? full[module][action],
    ])),
  ]));
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("base64url");
  const hash = scryptSync(String(password), salt, 32).toString("base64url");
  return `${PASSWORD_HASH_PREFIX}${salt}$${hash}`;
}

function constantTimeStringEqual(a = "", b = "") {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyPassword(storedPassword, candidatePassword) {
  const stored = String(storedPassword ?? "");
  const candidate = String(candidatePassword ?? "");
  if (!stored || !candidate) return false;
  if (stored.startsWith(PASSWORD_HASH_PREFIX)) {
    const parts = stored.split("$");
    if (parts.length !== 4) return false;
    const [, version, salt, expectedHash] = parts;
    if (version !== "1" || !salt || !expectedHash) return false;
    const actualHash = scryptSync(candidate, salt, 32).toString("base64url");
    return constantTimeStringEqual(actualHash, expectedHash);
  }
  return constantTimeStringEqual(stored, candidate);
}

function passwordNeedsRehash(storedPassword) {
  return !String(storedPassword ?? "").startsWith(PASSWORD_HASH_PREFIX);
}

function credentialDigest(username, password) {
  return createHash("sha256").update(`${String(username ?? "").trim()}:${String(password ?? "")}`).digest("hex");
}

function isDefaultCredential(username, password) {
  return DEFAULT_CREDENTIAL_DIGESTS.has(credentialDigest(username, password));
}

function publicUserFromAccount(account = {}, state = null) {
  if (isPersonnelResigned(account)) return null;
  const username = String(account.username ?? "").trim();
  const role = account.accessRole === "admin" ? "admin" : "staff";
  if (!username) return null;
  if (role === "admin") return { username, role };
  const sites = state && Array.isArray(state.sites) ? getSitesFromState(state) : [];
  const visibleSiteIds = normalizeVisibleSiteIds(account.visibleSiteIds, sites);
  return visibleSiteIds.length > 0 ? { username, role, visibleSiteIds } : { username, role };
}

function isPersonnelResigned(person = {}) {
  return person?.employmentStatus === "resigned" || Boolean(person?.resignedAt);
}

function sanitizePersonnelRecordForResponse(person = {}, req, options = {}) {
  if (!person || typeof person !== "object") return person;
  const username = String(person.username ?? "");
  const isAdmin = req?.auth?.account?.accessRole === "admin";
  const isCurrentUser = username && username === req?.auth?.user?.username;
  const { password, ...safePerson } = person;
  if (safePerson.accessRole !== "admin" && safePerson.accessRole !== "staff") safePerson.accessRole = "staff";
  safePerson.visibleSiteIds = safePerson.accessRole === "admin"
    ? []
    : normalizeVisibleSiteIds(safePerson.visibleSiteIds, []);
  safePerson.employmentStatus = isPersonnelResigned(safePerson) ? "resigned" : "active";
  if (isPersonnelResigned(safePerson)) {
    safePerson.permissions = emptyPermissionsValue();
  }
  if (options.includePermissions || isAdmin || isCurrentUser) {
    safePerson.permissions = isPersonnelResigned(safePerson)
      ? emptyPermissionsValue()
      : normalizePermissionsForStorage(safePerson.permissions);
  } else {
    delete safePerson.permissions;
  }
  return safePerson;
}

function sanitizePersonnelForResponse(personnel = [], req, options = {}) {
  return (Array.isArray(personnel) ? personnel : []).map((person) =>
    sanitizePersonnelRecordForResponse(person, req, options)
  );
}

function sanitizeStateForResponse(data = {}, req) {
  if (!data || typeof data !== "object") return data;
  const next = { ...siteVisibilityFilteredState(normalizePickupShipmentsForState(data), req?.auth?.account) };
  next.sites = getSitesFromState(next);
  if (Array.isArray(next.personnel)) {
    next.personnel = sanitizePersonnelForResponse(next.personnel, req);
  }
  return next;
}

function sanitizePersonnelForLoginData(personnel = [], req) {
  return (Array.isArray(personnel) ? personnel : []).map((person) => {
    if (!person || typeof person !== "object") return person;
    return sanitizePersonnelRecordForResponse(person, req, { includePermissions: false });
  });
}

function createAuthToken(user) {
  const expiresAt = Date.now() + AUTH_SESSION_TTL_MS;
  const payload = base64UrlJson({
    username: user.username,
    role: user.role,
    exp: expiresAt,
  });
  const signature = signAuthPayload(payload);
  return { token: `${payload}.${signature}`, expiresAt };
}

function verifyAuthToken(token) {
  const [payload, signature] = String(token ?? "").split(".");
  if (!payload || !signature) return null;
  const expected = signAuthPayload(payload);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed.username !== "string" || (parsed.role !== "admin" && parsed.role !== "staff")) return null;
    if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function bearerTokenFromRequest(req) {
  const header = String(req.headers.authorization ?? "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  return cookieValue(req, AUTH_COOKIE_NAME);
}

function cookieValue(req, name) {
  const rawCookie = String(req.headers.cookie ?? "");
  const prefix = `${name}=`;
  const found = rawCookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : "";
}

function authCookieHeader(token, expiresAt) {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (process.env.AUTH_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function clearAuthCookieHeader() {
  const parts = [`${AUTH_COOKIE_NAME}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (process.env.AUTH_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

function authenticatedOperator(req) {
  return req.auth?.user?.username || "system";
}

function sanitizeOperationLogsForAuth(logs = [], req) {
  const operator = authenticatedOperator(req);
  return (Array.isArray(logs) ? logs : []).map((log) =>
    log && typeof log === "object" ? { ...log, operator } : log
  );
}

function hasModulePermission(account = {}, module, action = "update") {
  if (isPersonnelResigned(account)) return false;
  if (account?.accessRole === "admin") return true;
  if (!PERMISSION_MODULE_KEYS.includes(module) || !PERMISSION_ACTIONS.includes(action)) return false;
  return normalizePermissionsForStorage(account?.permissions)?.[module]?.[action] === true;
}

function requireModulePermissionForAuth(req, module, action = "update") {
  if (!hasModulePermission(req.auth?.account, module, action)) {
    throw new Error("当前账户没有执行该操作的权限");
  }
}

function validateStatePatchAuthorization(req, patch = {}) {
  for (const key of Object.keys(patch || {})) {
    if (!STATE_KEY_SET.has(key)) {
      throw new Error(`不支持的状态字段：${key}`);
    }
    if (DISALLOWED_STATE_PATCH_KEYS.has(key)) {
      throw new Error("人员账号和权限必须通过专用接口修改");
    }
    if (key === "operationLogs") continue;
    const module = STATE_PATCH_PERMISSION_MODULES[key];
    if (module) requireModulePermissionForAuth(req, module, "update");
  }
}

function normalizePersonnelInput(input = {}, existing = null, state = {}) {
  const source = input && typeof input === "object" ? input : {};
  const id = String(source.id || existing?.id || uid("person"));
  const name = String(source.name ?? existing?.name ?? "").trim();
  const username = String(source.username ?? existing?.username ?? "").trim();
  const accessRole = source.accessRole === "admin" ? "admin" : "staff";
  const sites = getSitesFromState(state);
  const visibleSiteIds = accessRole === "admin"
    ? []
    : normalizeVisibleSiteIds(source.visibleSiteIds ?? existing?.visibleSiteIds, sites);
  const role = String(source.role ?? existing?.role ?? "").trim();
  const phone = String(source.phone ?? existing?.phone ?? "").trim();
  const notes = String(source.notes ?? existing?.notes ?? "").trim();
  const plainPassword = String(source.password ?? "");
  if (!name) throw new Error("请填写人员姓名");
  if (!username) throw new Error("请填写登录账号");
  if (!existing && !plainPassword) throw new Error("新增人员必须设置登录密码");
  if (plainPassword && plainPassword.length < 6) throw new Error("登录密码至少 6 位");
  return {
    id,
    name,
    username,
    password: plainPassword ? hashPassword(plainPassword) : existing?.password,
    accessRole,
    visibleSiteIds,
    employmentStatus: isPersonnelResigned(existing) ? "resigned" : "active",
    resignedAt: isPersonnelResigned(existing) ? existing?.resignedAt : undefined,
    permissions: isPersonnelResigned(existing)
      ? emptyPermissionsValue()
      : accessRole === "admin"
      ? fullPermissionsValue()
      : normalizePermissionsForStorage(source.permissions ?? existing?.permissions),
    role,
    phone,
    notes,
  };
}

function normalizeCustomerInput(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const id = String(source.id || uid("customer")).trim();
  const name = String(source.name ?? "").trim();
  const addedDate = String(source.addedDate ?? todayInChina()).trim();
  if (!name) throw new Error("请输入客户名称");
  if (addedDate && addedDate > todayInChina()) throw new Error("客户添加时间不能晚于今天");
  return {
    id,
    name,
    customerType: source.customerType === "B" || source.customerType === "C" ? source.customerType : "",
    addedDate,
    phone: String(source.phone ?? "").trim(),
    wechat: String(source.wechat ?? "").trim(),
    douyin: String(source.douyin ?? "").trim(),
    source: String(source.source ?? "").trim(),
    address: String(source.address ?? "").trim(),
    notes: String(source.notes ?? "").trim(),
  };
}

function countAdmins(personnel = [], excludeId = "") {
  return (Array.isArray(personnel) ? personnel : [])
    .filter((person) =>
      String(person?.id ?? "") !== String(excludeId) &&
      person?.accessRole === "admin" &&
      !isPersonnelResigned(person)
    )
    .length;
}

function isActivePersonnelName(state = {}, value = "") {
  const normalized = String(value ?? "").trim();
  if (!normalized) return false;
  return (Array.isArray(state.personnel) ? state.personnel : [])
    .some((person) =>
      !isPersonnelResigned(person) &&
      (String(person?.name ?? "").trim() === normalized || String(person?.username ?? "").trim() === normalized)
    );
}

function assertActivePersonnelName(state = {}, value = "", label = "人员", allowedHistoricalValue = "") {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`请选择${label}`);
  if (allowedHistoricalValue && normalized === String(allowedHistoricalValue ?? "").trim()) return;
  if (!isActivePersonnelName(state, normalized)) throw new Error(`${label}必须是在职人员`);
}

function createOperationLog(req, module, action, detail) {
  return {
    id: uid("log"),
    time: new Date().toISOString(),
    operator: authenticatedOperator(req),
    module,
    action,
    detail,
  };
}

async function readAuthAccounts() {
  const { rows } = await pool.query("SELECT data -> 'personnel' AS personnel FROM app_state WHERE id = $1", [stateId]);
  const personnel = Array.isArray(rows[0]?.personnel) ? rows[0].personnel : [];
  if (personnel.length > 0) return personnel;
  return process.env.NODE_ENV === "production" ? [] : BOOTSTRAP_AUTH_ACCOUNTS;
}

async function rehashStoredPasswordIfNeeded(username, plainPassword) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const state = rows[0]?.data ?? {};
    const personnel = Array.isArray(state.personnel) ? state.personnel : [];
    const targetIndex = personnel.findIndex((person) => String(person?.username ?? "") === String(username ?? ""));
    if (targetIndex < 0 || !passwordNeedsRehash(personnel[targetIndex]?.password)) {
      await client.query("ROLLBACK");
      return;
    }
    const nextPersonnel = personnel.map((person, index) =>
      index === targetIndex ? { ...person, password: hashPassword(plainPassword) } : person
    );
    await client.query(
      "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
      [stateId, JSON.stringify({ ...state, personnel: nextPersonnel })]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function rehashPlaintextPersonnelPasswords() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const state = rows[0]?.data ?? {};
    const personnel = Array.isArray(state.personnel) ? state.personnel : [];
    let rehashedCount = 0;
    const nextPersonnel = personnel.map((person) => {
      if (!person || typeof person !== "object" || !person.password || !passwordNeedsRehash(person.password)) {
        return person;
      }
      rehashedCount += 1;
      return { ...person, password: hashPassword(person.password) };
    });
    if (rehashedCount > 0) {
      await client.query(
        "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
        [stateId, JSON.stringify({ ...state, personnel: nextPersonnel })]
      );
    }
    await client.query("COMMIT");
    if (rehashedCount > 0) {
      console.log(`Rehashed ${rehashedCount} plaintext personnel password(s)`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function authenticateApiRequest(req) {
  const payload = verifyAuthToken(bearerTokenFromRequest(req));
  if (!payload) return null;
  const accounts = await readAuthAccounts();
  const account = accounts.find((person) => String(person?.username ?? "") === payload.username);
  const user = account ? publicUserFromAccount(account) : null;
  if (!user || user.role !== payload.role) return null;
  return { user, account };
}

function isPublicApiRoute(req, url) {
  if (req.method === "OPTIONS") return true;
  if (url.pathname === "/api/health" && req.method === "GET") return true;
  if (url.pathname === "/api/public/catalog" && req.method === "GET") return true;
  if (url.pathname === "/api/public/bio-records" && req.method === "GET") return true;
  if (url.pathname === "/api/public/media/cos" && req.method === "GET") return true;
  if (url.pathname === "/api/auth/login" && req.method === "POST") return true;
  if (url.pathname === "/api/auth/logout" && req.method === "POST") return true;
  if (url.pathname === "/api/assistant/feishu/events" && req.method === "POST") return true;
  return false;
}

function aiReady() {
  return Boolean(aiConfig.apiKey && aiConfig.model);
}

function feishuWebhookReady() {
  return Boolean(feishuConfig.webhookUrl);
}

function feishuAppReady() {
  return Boolean(feishuConfig.appId && feishuConfig.appSecret);
}

function clampText(value, maxLength = 1800) {
  const text = String(value ?? "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function addUniqueWeatherCandidate(candidates, value) {
  const candidate = String(value ?? "")
    .replace(/[()（）【】\[\]{}<>《》]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
}

function stripChineseProvince(value) {
  return String(value ?? "").replace(/^.*?(?:省|自治区|特别行政区)/, "").trim();
}

function stripChinesePlaceSuffix(value) {
  return String(value ?? "").replace(/(?:市|自治州|地区|盟|县|区)$/u, "").trim();
}

function weatherSearchCandidates(address) {
  const clean = String(address ?? "")
    .replace(/\d{6,}/g, " ")
    .replace(/[，,。；;、\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const candidates = [];
  if (!clean) return candidates;

  for (const match of [...clean.matchAll(/([\u4e00-\u9fa5]{2,24}?(?:市|自治州|地区|盟))/gu)].reverse()) {
    const place = stripChineseProvince(match[1]);
    addUniqueWeatherCandidate(candidates, place);
    addUniqueWeatherCandidate(candidates, stripChinesePlaceSuffix(place));
  }
  const municipality = clean.match(/(北京|上海|天津|重庆)市?/u);
  if (municipality) addUniqueWeatherCandidate(candidates, municipality[1]);
  for (const match of [...clean.matchAll(/([\u4e00-\u9fa5]{2,18}?(?:县|区))/gu)].reverse()) {
    const place = stripChineseProvince(match[1]);
    addUniqueWeatherCandidate(candidates, place);
    addUniqueWeatherCandidate(candidates, stripChinesePlaceSuffix(place));
  }

  addUniqueWeatherCandidate(candidates, stripChineseProvince(clean));
  addUniqueWeatherCandidate(candidates, clean);
  return candidates.slice(0, 8);
}

function weatherCodeLabel(code) {
  const normalized = Number(code);
  if (normalized === 0) return "晴";
  if (normalized === 1) return "大部晴";
  if (normalized === 2) return "多云";
  if (normalized === 3) return "阴";
  if (normalized === 45 || normalized === 48) return "雾";
  if ([51, 53, 55].includes(normalized)) return "毛毛雨";
  if ([56, 57].includes(normalized)) return "冻毛毛雨";
  if ([61, 63, 65].includes(normalized)) return "雨";
  if ([66, 67].includes(normalized)) return "冻雨";
  if ([71, 73, 75].includes(normalized)) return "雪";
  if (normalized === 77) return "雪粒";
  if ([80, 81, 82].includes(normalized)) return "阵雨";
  if ([85, 86].includes(normalized)) return "阵雪";
  if (normalized === 95) return "雷阵雨";
  if ([96, 99].includes(normalized)) return "雷阵雨伴冰雹";
  return "天气未知";
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${clampText(raw, 240)}`);
    }
    return raw ? JSON.parse(raw) : {};
  } finally {
    clearTimeout(timeout);
  }
}

async function geocodeWeatherLocation(address) {
  let lastError = null;
  for (const candidate of weatherSearchCandidates(address)) {
    try {
      const params = new URLSearchParams({
        name: candidate,
        count: "5",
        language: "zh",
        format: "json",
      });
      const result = await fetchJsonWithTimeout(`${weatherForecastConfig.geocodingBaseUrl}?${params}`, weatherForecastConfig.timeoutMs);
      const locations = Array.isArray(result?.results) ? result.results : [];
      const location = locations.find((item) => String(item?.country_code ?? "").toUpperCase() === "CN") ?? locations[0];
      if (location?.latitude != null && location?.longitude != null) return location;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error("无法识别发货目的地");
}

function locationDisplayName(location) {
  const parts = [
    location?.name,
    location?.admin2,
    location?.admin1,
    location?.country,
  ].map((part) => String(part ?? "").trim()).filter(Boolean);
  return [...new Set(parts)].join(" / ");
}

async function weatherForecastForAddress(address) {
  const normalizedAddress = String(address ?? "").replace(/\s+/g, " ").trim();
  if (!normalizedAddress) throw new Error("发货目的地不能为空");
  const cached = weatherForecastCache.get(normalizedAddress);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const location = await geocodeWeatherLocation(normalizedAddress);
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    forecast_days: "4",
    timezone: "auto",
  });
  const result = await fetchJsonWithTimeout(`${weatherForecastConfig.forecastBaseUrl}?${params}`, weatherForecastConfig.timeoutMs);
  const daily = result?.daily ?? {};
  const dates = Array.isArray(daily.time) ? daily.time : [];
  const today = todayInChina();
  const days = dates.map((date, index) => ({
    date: String(date ?? ""),
    weather: weatherCodeLabel(daily.weather_code?.[index]),
    tempMax: Number(daily.temperature_2m_max?.[index]),
    tempMin: Number(daily.temperature_2m_min?.[index]),
    precipitationProbabilityMax: Number(daily.precipitation_probability_max?.[index]),
  })).filter((day) => day.date);
  const futureDays = days.filter((day) => day.date > today).slice(0, 2);
  const forecast = (futureDays.length >= 2 ? futureDays : days.slice(0, 2)).map((day) => ({
    ...day,
    tempMax: Number.isFinite(day.tempMax) ? day.tempMax : undefined,
    tempMin: Number.isFinite(day.tempMin) ? day.tempMin : undefined,
    precipitationProbabilityMax: Number.isFinite(day.precipitationProbabilityMax) ? day.precipitationProbabilityMax : undefined,
  }));
  if (forecast.length === 0) throw new Error("未获取到未来两天天气");

  const value = {
    address: normalizedAddress,
    locationName: locationDisplayName(location),
    latitude: location.latitude,
    longitude: location.longitude,
    forecast,
    source: "Open-Meteo",
  };
  weatherForecastCache.set(normalizedAddress, {
    expiresAt: Date.now() + weatherForecastConfig.cacheTtlMs,
    value,
  });
  return value;
}

function indexById(items = []) {
  return new Map((Array.isArray(items) ? items : [])
    .map((item) => [String(item?.id ?? ""), item])
    .filter(([id]) => id));
}

function subTankIndex(state = {}) {
  const entries = [];
  for (const group of Array.isArray(state.tankGroups) ? state.tankGroups : []) {
    for (const tank of Array.isArray(group?.subTanks) ? group.subTanks : []) {
      const id = String(tank?.id ?? "");
      if (!id) continue;
      entries.push([id, {
        tankGroupId: String(group?.id ?? ""),
        tankGroupName: String(group?.name ?? ""),
        subTankId: id,
        subTankName: String(tank?.name ?? ""),
        location: String(group?.location ?? ""),
        siteId: normalizeSiteId(group?.siteId),
      }]);
    }
  }
  return new Map(entries);
}

function orderAmount(order = {}, shipments = []) {
  return {
    due: calcAmountDueForOrder(order, shipments),
    paid: calcAmountPaidForOrder(order),
    balance: getOrderFinancialStateForOrder(order, shipments),
  };
}

function buildAssistantSnapshot(state = {}, options = {}) {
  const siteId = normalizeSiteScope(options.siteId ?? ALL_SITE_ID);
  const scopedState = siteFilteredState(state, siteId);
  const maxRows = Math.max(20, Math.min(200, Number(options.maxRows ?? aiConfig.maxContextRows)));
  const productsById = indexById(scopedState.products);
  const speciesById = indexById(scopedState.species);
  const batchesById = indexById(scopedState.batches);
  const customersById = indexById(scopedState.customers);
  const tanksById = subTankIndex(scopedState);
  const shippedIds = shippedOutStockIds(scopedState);
  const summary = buildDashboardSummary(state, { siteId, financeDays: DEFAULT_FINANCE_DAYS });
  const sites = getSitesFromState(state);
  const siteName = siteId === ALL_SITE_ID
    ? "全部场地"
    : sites.find((site) => site.id === siteId)?.name ?? siteId;

  const stockRows = (Array.isArray(scopedState.stock) ? scopedState.stock : [])
    .filter((item) => isPhysicallyInTank(item, shippedIds))
    .slice(0, maxRows)
    .map((item) => {
      const product = productsById.get(String(item?.productId ?? ""));
      const species = product ? speciesById.get(String(product?.speciesId ?? "")) : null;
      const tank = tanksById.get(String(item?.subTankId ?? ""));
      const batch = batchesById.get(String(item?.batchId ?? ""));
      return {
        code: String(item?.code ?? ""),
        product: String(product?.name ?? item?.productId ?? ""),
        species: String(species?.name ?? ""),
        tank: tank ? `${tank.tankGroupName}/${tank.subTankName}` : String(item?.subTankId ?? ""),
        status: item?.status ?? "healthy",
        sold: Boolean(item?.sold),
        inDate: String(item?.inDate ?? ""),
        batchNo: String(batch?.batchNo ?? ""),
        notes: clampText(item?.notes ?? "", 120),
      };
    });

  const orderRows = (Array.isArray(scopedState.orders) ? scopedState.orders : [])
    .slice()
    .sort((a, b) => String(b?.date ?? b?.createdAt ?? "").localeCompare(String(a?.date ?? a?.createdAt ?? "")))
    .slice(0, maxRows)
    .map((order) => {
      const customer = customersById.get(String(order?.customerId ?? ""));
      const amount = orderAmount(order, Array.isArray(scopedState.shipments) ? scopedState.shipments : []);
      return {
        orderNo: String(order?.orderNo ?? ""),
        date: String(order?.date ?? ""),
        plannedShipDate: String(order?.plannedShipDate ?? ""),
        customer: String(customer?.name ?? order?.customerId ?? ""),
        status: String(order?.status ?? ""),
        itemCount: Array.isArray(order?.items) ? order.items.length : 0,
        due: amount.due,
        paid: amount.paid,
        balance: amount.balance,
        notes: clampText(order?.notes ?? "", 120),
      };
    });

  const shipmentRows = (Array.isArray(scopedState.shipments) ? scopedState.shipments : [])
    .slice()
    .sort((a, b) => String(b?.shipDate ?? b?.createdAt ?? "").localeCompare(String(a?.shipDate ?? a?.createdAt ?? "")))
    .slice(0, maxRows)
    .map((shipment) => {
      const order = (Array.isArray(scopedState.orders) ? scopedState.orders : [])
        .find((item) => String(item?.id ?? "") === String(shipment?.orderId ?? ""));
      return {
        orderNo: String(order?.orderNo ?? shipment?.orderId ?? ""),
        shipDate: String(shipment?.shipDate ?? shipment?.outboundDate ?? ""),
        carrier: String(shipment?.carrier ?? ""),
        trackingNo: String(shipment?.trackingNo ?? ""),
        status: String(shipment?.status ?? ""),
        itemCount: Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds.length : 0,
      };
    });

  const dailyRows = (Array.isArray(scopedState.logs) ? scopedState.logs : [])
    .slice()
    .sort((a, b) => String(b?.date ?? "").localeCompare(String(a?.date ?? "")))
    .slice(0, Math.min(maxRows, 40))
    .map((log) => {
      const tank = tanksById.get(String(log?.subTankId ?? "")) ||
        (Array.isArray(scopedState.tankGroups) ? scopedState.tankGroups : [])
          .find((group) => String(group?.id ?? "") === String(log?.tankGroupId ?? ""));
      return {
        date: String(log?.date ?? ""),
        tank: tank?.tankGroupName ? `${tank.tankGroupName}/${tank.subTankName}` : String(tank?.name ?? log?.tankGroupId ?? log?.subTankId ?? ""),
        action: String(log?.action ?? ""),
        operator: String(log?.operator ?? ""),
        notes: clampText(log?.notes ?? "", 120),
      };
    });

  const lossRows = buildLossRows(scopedState, productsById, speciesById)
    .slice()
    .sort((a, b) => String(b?.date ?? "").localeCompare(String(a?.date ?? "")))
    .slice(0, Math.min(maxRows, 40))
    .map((row) => ({
      date: row.date,
      product: String(row.product?.name ?? ""),
      species: String(row.species?.name ?? ""),
      reason: clampText(row.record?.reason ?? row.stockItem?.lossReason ?? "", 120),
      estimatedValue: row.estimatedValue,
    }));

  return {
    generatedAt: new Date().toISOString(),
    siteId,
    siteName,
    dashboard: {
      today: summary.today,
      todayReceived: summary.todayReceived,
      todayRefunded: summary.todayRefunded,
      todayShippedOut: summary.todayShippedOut,
      inFishStock: summary.inFishStock,
      inTankNormal: summary.inTankNormal,
      inTankSold: summary.inTankSold,
      inTankSick: summary.inTankSick,
      tankGroupCount: summary.tankGroupCount,
      subTankCount: summary.subTankCount,
      activeOrders: summary.activeOrders,
      pendingShipments: summary.pendingShipments,
      totalRevenue: summary.totalRevenue,
    },
    rows: {
      stock: stockRows,
      orders: orderRows,
      shipments: shipmentRows,
      recentDailyLogs: dailyRows,
      recentLosses: lossRows,
    },
    rowLimits: {
      maxRows,
      stockTotal: Array.isArray(scopedState.stock) ? scopedState.stock.length : 0,
      ordersTotal: Array.isArray(scopedState.orders) ? scopedState.orders.length : 0,
      shipmentsTotal: Array.isArray(scopedState.shipments) ? scopedState.shipments.length : 0,
    },
  };
}

function getSitesFromState(state = {}) {
  const merged = DEFAULT_SITES.map((site) => ({ ...site }));
  const sites = Array.isArray(state.sites) ? state.sites : [];
  sites.forEach((site) => {
    const id = normalizeSiteId(site?.id);
    const name = String(site?.name ?? site?.id ?? "").trim() || id;
    if (!merged.some((item) => item.id === id)) {
      merged.push({ id, name });
    }
  });
  return merged.filter((site) => site.id && site.name);
}

function assistantSystemPrompt(source = "web") {
  return [
    "你是鱼房管理系统里的 AI 助手，只能基于用户提供的业务数据快照回答。",
    "回答使用中文，简洁、可执行，必要时列出订单号、缸位、日期或数量。",
    "不要编造数据；数据快照里没有的信息要明确说当前系统未提供。",
    "你不能直接修改库存、订单、客户或人员数据；涉及操作时给出建议步骤。",
    source === "feishu" ? "回复来自飞书机器人，适合短消息阅读。" : "回复来自系统内助手，可适当分点说明。",
  ].join("\n");
}

function assistantFallbackAnswer(message, snapshot) {
  return [
    "AI 服务尚未配置。请在后端环境变量里设置 AI_API_KEY（或 OPENAI_API_KEY）和 AI_MODEL 后重试。",
    "",
    `当前${snapshot.siteName}摘要：在缸鱼 ${snapshot.dashboard.inFishStock} 条，病鱼 ${snapshot.dashboard.inTankSick} 条，进行中订单 ${snapshot.dashboard.activeOrders} 单，待处理发货 ${snapshot.dashboard.pendingShipments} 单。`,
    message ? `你刚才的问题是：「${clampText(message, 120)}」。` : "",
  ].filter(Boolean).join("\n");
}

async function answerAssistantQuestion({ message, state, siteId = ALL_SITE_ID, source = "web" }) {
  const question = clampText(message, 2000);
  const snapshot = buildAssistantSnapshot(state, { siteId });
  if (!question) throw new Error("请输入要询问 AI 助手的问题");
  if (!aiReady()) {
    return {
      answer: assistantFallbackAnswer(question, snapshot),
      aiConfigured: false,
      model: null,
      snapshot,
    };
  }

  const payload = {
    model: aiConfig.model,
    temperature: aiConfig.temperature,
    messages: [
      { role: "system", content: assistantSystemPrompt(source) },
      {
        role: "user",
        content: [
          "业务数据快照如下：",
          JSON.stringify(snapshot, null, 2),
          "",
          `用户问题：${question}`,
        ].join("\n"),
      },
    ],
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), aiConfig.timeoutMs);
  try {
    const response = await fetch(`${aiConfig.apiBaseUrl}${aiConfig.chatPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${aiConfig.apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`AI request failed: HTTP ${response.status} ${clampText(raw, 500)}`);
    }
    const result = raw ? JSON.parse(raw) : {};
    const answer = String(result?.choices?.[0]?.message?.content ?? "").trim();
    if (!answer) throw new Error("AI response did not include an answer");
    return {
      answer,
      aiConfigured: true,
      model: aiConfig.model,
      usage: result?.usage ?? null,
      snapshot,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function feishuWebhookSign(timestamp) {
  const stringToSign = `${timestamp}\n${feishuConfig.webhookSecret}`;
  return createHmac("sha256", feishuConfig.webhookSecret)
    .update(stringToSign)
    .digest("base64");
}

async function sendFeishuWebhookText(text) {
  if (!feishuWebhookReady()) {
    return { ok: false, error: "FEISHU_WEBHOOK_URL is not configured" };
  }
  const body = {
    msg_type: "text",
    content: { text: clampText(text, 3900) },
  };
  if (feishuConfig.webhookSecret) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    body.timestamp = timestamp;
    body.sign = feishuWebhookSign(timestamp);
  }
  const response = await fetch(feishuConfig.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || (result.code !== undefined && result.code !== 0)) {
    return {
      ok: false,
      error: result.msg || result.message || `Feishu webhook failed: HTTP ${response.status}`,
    };
  }
  return { ok: true };
}

async function getFeishuTenantAccessToken() {
  if (!feishuAppReady()) throw new Error("FEISHU_APP_ID and FEISHU_APP_SECRET are not configured");
  if (feishuTenantTokenCache.token && feishuTenantTokenCache.expiresAt > Date.now() + 60_000) {
    return feishuTenantTokenCache.token;
  }
  const response = await fetch(`${feishuConfig.openApiBaseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: feishuConfig.appId,
      app_secret: feishuConfig.appSecret,
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0 || !result.tenant_access_token) {
    throw new Error(result.msg || result.message || `Failed to fetch Feishu tenant_access_token: HTTP ${response.status}`);
  }
  feishuTenantTokenCache = {
    token: result.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, Number(result.expire ?? 7200) - 120) * 1000,
  };
  return feishuTenantTokenCache.token;
}

async function replyFeishuMessage(messageId, text) {
  const token = await getFeishuTenantAccessToken();
  const response = await fetch(`${feishuConfig.openApiBaseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      msg_type: "text",
      content: JSON.stringify({ text: clampText(text, 3900) }),
    }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) {
    throw new Error(result.msg || result.message || `Failed to reply Feishu message: HTTP ${response.status}`);
  }
  return result;
}

function verifyFeishuEventToken(payload = {}) {
  if (!feishuConfig.verificationToken) return false;
  const token = payload?.header?.token ?? payload?.token ?? payload?.event?.token ?? "";
  return token === feishuConfig.verificationToken;
}

function feishuChallenge(payload = {}) {
  if (payload?.type === "url_verification" && payload?.challenge) return String(payload.challenge);
  if (payload?.header?.event_type === "url_verification" && payload?.challenge) return String(payload.challenge);
  if (payload?.challenge && !payload?.event?.message) return String(payload.challenge);
  return "";
}

function parseJsonText(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value ?? "{}"));
  } catch {
    return {};
  }
}

function extractFeishuTextEvent(payload = {}) {
  const event = payload?.event ?? {};
  const message = event?.message ?? {};
  const messageId = String(message?.message_id ?? event?.message_id ?? "");
  const messageType = String(message?.message_type ?? message?.msg_type ?? "");
  if (messageType && messageType !== "text") return { messageId, text: "", ignoredReason: "non-text message" };
  const content = parseJsonText(message?.content ?? event?.content);
  const rawText = String(content?.text ?? content?.content ?? "");
  const text = rawText
    .replace(/<at\s+[^>]*>.*?<\/at>/gi, "")
    .replace(/@_user_\d+/g, "")
    .trim();
  return { messageId, text, ignoredReason: text ? "" : "empty text" };
}

function assistantPublicConfig() {
  return {
    aiConfigured: aiReady(),
    aiModel: aiReady() ? aiConfig.model : null,
    feishuWebhookConfigured: feishuWebhookReady(),
    feishuAppConfigured: feishuAppReady(),
    feishuEventPath: "/api/assistant/feishu/events",
    defaultFeishuSiteId: feishuConfig.defaultSiteId,
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
  const tankSiteId = findSubTank(state, stockItem?.subTankId)?.group?.siteId;
  if (tankSiteId) return normalizeSiteId(tankSiteId);
  const explicit = String(stockItem?.siteId ?? "").trim();
  if (explicit) return normalizeSiteId(explicit);
  return normalizeSiteId();
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

const PAYMENT_TYPE_LABELS = {
  deposit: "定金",
  balance: "尾款",
  shipping_fee: "运费",
  refund: "退款",
  other: "其他",
};

function paymentTypeLabel(type = "") {
  return PAYMENT_TYPE_LABELS[type] || String(type || "资金记录");
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

function orderPermissionAllowedForAccount(account = {}, action = "update") {
  if (account?.accessRole === "admin") return true;
  return account?.permissions?.orders?.[action] !== false;
}

function requireOrderPermissionForAuth(req, action = "update") {
  if (!orderPermissionAllowedForAccount(req.auth?.account, action)) {
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

const ORDER_SOURCE_VALUES = new Set(["线下", "平台下单", "私域线上"]);

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
  const hasSourceInput = Object.prototype.hasOwnProperty.call(body, "source");
  const source = String(body.source ?? currentOrder?.source ?? "").trim();
  if (!source && (!currentOrder || hasSourceInput)) throw new Error("请选择订单来源");
  if (source && !ORDER_SOURCE_VALUES.has(source)) throw new Error("请选择有效订单来源");
  const shippingAddress = String(body.shippingAddress ?? currentOrder?.shippingAddress ?? "").trim();
  const plannedShipDate = String(body.plannedShipDate ?? currentOrder?.plannedShipDate ?? "").trim();
  if (!plannedShipDate) throw new Error("请选择预计发货日期");
  if (plannedShipDate && plannedShipDate < date) throw new Error("预计发货日期不能早于下单日期");
  const contactPerson = String(body.contactPerson ?? currentOrder?.contactPerson ?? "").trim();
  assertActivePersonnelName(state, contactPerson, "对接人", currentOrder?.contactPerson);
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
    source,
    shippingAddress,
    plannedShipDate,
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

function mapRecordsById(items = []) {
  return new Map((Array.isArray(items) ? items : [])
    .map((item) => [String(item?.id ?? ""), item])
    .filter(([id]) => id));
}

function paymentChangeAction(currentPayments = [], nextPayments = []) {
  const currentById = mapRecordsById(currentPayments);
  const nextById = mapRecordsById(nextPayments);
  if ([...nextById.keys()].some((id) => !currentById.has(id))) return "create";
  if ([...currentById.keys()].some((id) => !nextById.has(id))) return "delete";
  if ([...nextById.entries()].some(([id, payment]) => stableJson(currentById.get(id)) !== stableJson(payment))) return "update";
  return null;
}

function countsAsCompletionShipment(shipment = {}) {
  return shipment?.status !== "preparing" && !(shipment?.status === "damaged" && shipment?.damageResolution === "reship");
}

function validateOrderCanComplete(order = {}, shipments = []) {
  const financialState = getOrderFinancialStateForOrder(order, shipments);
  if (financialState.kind !== "paid") {
    throw new Error("订单资金未结清，不能标记完成");
  }
  const activeShipments = shipments.filter((shipment) =>
    String(shipment?.orderId ?? "") === String(order.id ?? "") && countsAsCompletionShipment(shipment)
  );
  const shippedIds = new Set(activeShipments.flatMap((shipment) =>
    Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds.map((id) => String(id)) : []
  ));
  const orderItems = Array.isArray(order.items) ? order.items : [];
  if (orderItems.length === 0 || !orderItems.every((item) => shippedIds.has(String(item?.stockItemId ?? "")))) {
    throw new Error("订单尚有商品未发货，不能标记完成");
  }
  const allShipmentsResolved = activeShipments.length > 0 && activeShipments.every((shipment) =>
    shipment?.status === "delivered" ||
    (shipment?.status === "damaged" && shipment?.damageResolution === "refund")
  );
  if (!allShipmentsResolved) {
    throw new Error("订单仍有未签收或未处理的发货，不能标记完成");
  }
}

function applyAutomaticOrderTransitions(state = {}) {
  const today = todayInChina();
  const outboundThreshold = addDaysToDateString(today, -3);
  const shippedThreshold = addDaysToDateString(today, -5);
  const deliveredThreshold = addDaysToDateString(today, -3);
  const now = nowDatetimeInChina();
  const shipments = Array.isArray(state.shipments) ? state.shipments : [];
  const orders = Array.isArray(state.orders) ? state.orders : [];
  let autoShippedCount = 0;
  let autoDeliveredCount = 0;

  const nextShipments = shipments.map((shipment) => {
    const status = String(shipment?.status ?? "");
    if (status === "outbound") {
      const outboundDate = datePart(shipment.outboundDate || shipment.createdAt || shipment.shipDate);
      if (isDateOnOrBefore(outboundDate, outboundThreshold)) {
        autoShippedCount += 1;
        return {
          ...shipment,
          status: "shipped",
          shippedAt: shipment.shippedAt || now,
          shipDate: today,
        };
      }
    }
    if (status === "shipped") {
      const shippedDate = datePart(shipment.shippedAt || shipment.shipDate || shipment.outboundDate || shipment.createdAt);
      if (isDateOnOrBefore(shippedDate, shippedThreshold)) {
        autoDeliveredCount += 1;
        return {
          ...shipment,
          status: "delivered",
          deliveredAt: shipment.deliveredAt || now,
        };
      }
    }
    return shipment;
  });

  let autoCompletedCount = 0;
  const nextOrders = orders.map((order) => {
    if (!order || ["completed", "cancelled", "damaged"].includes(String(order.status ?? ""))) return order;
    const orderShipments = nextShipments.filter((shipment) =>
      String(shipment?.orderId ?? "") === String(order.id ?? "") && countsAsCompletionShipment(shipment)
    );
    if (orderShipments.length === 0) return order;
    const deliveredShipments = orderShipments.filter((shipment) =>
      shipment?.status === "delivered" ||
      (shipment?.status === "damaged" && shipment?.damageResolution === "refund")
    );
    if (deliveredShipments.length !== orderShipments.length) return order;
    const latestDeliveredDate = deliveredShipments
      .map((shipment) => datePart(shipment.deliveredAt || shipment.shippedAt || shipment.shipDate || shipment.outboundDate || shipment.createdAt))
      .filter(Boolean)
      .sort()
      .at(-1);
    if (!latestDeliveredDate || !isDateOnOrBefore(latestDeliveredDate, deliveredThreshold)) return order;
    try {
      validateOrderCanComplete(order, nextShipments);
    } catch {
      return order;
    }
    autoCompletedCount += 1;
    return { ...order, status: "completed" };
  });

  const changed = autoShippedCount > 0 || autoDeliveredCount > 0 || autoCompletedCount > 0;
  if (!changed) {
    return {
      changed: false,
      state,
      summary: { autoShippedCount, autoDeliveredCount, autoCompletedCount },
    };
  }

  const details = [
    autoShippedCount > 0 ? `出库满 3 天自动确认发货 ${autoShippedCount} 单` : "",
    autoDeliveredCount > 0 ? `发货满 5 天自动签收 ${autoDeliveredCount} 单` : "",
    autoCompletedCount > 0 ? `签收满 3 天自动完成订单 ${autoCompletedCount} 单` : "",
  ].filter(Boolean).join("；");
  const operationLog = {
    id: uid("log"),
    time: new Date().toISOString(),
    operator: "system",
    module: "订单管理",
    action: "自动流转",
    detail: details,
  };

  return {
    changed: true,
    state: {
      ...state,
      shipments: nextShipments,
      orders: nextOrders,
      operationLogs: pushOperationLog(state.operationLogs, operationLog),
    },
    operationLog,
    summary: { autoShippedCount, autoDeliveredCount, autoCompletedCount },
  };
}

const ORDER_STATUS_VALUES = new Set(["pending", "shipped", "completed", "cancelled", "damaged"]);
const ORDER_MUTABLE_FIELD_KEYS = new Set([
  "siteId",
  "customerId",
  "date",
  "source",
  "shippingAddress",
  "plannedShipDate",
  "contactPerson",
  "items",
  "shippingFee",
  "packagingFee",
  "discount",
  "notes",
]);

function orderMutableFieldsComparable(order = {}) {
  return {
    siteId: normalizeSiteId(order.siteId),
    customerId: String(order.customerId ?? "").trim(),
    date: String(order.date ?? "").trim(),
    source: String(order.source ?? "").trim(),
    shippingAddress: String(order.shippingAddress ?? "").trim(),
    plannedShipDate: String(order.plannedShipDate ?? "").trim() || undefined,
    contactPerson: String(order.contactPerson ?? "").trim(),
    items: (Array.isArray(order.items) ? order.items : []).map((item) => ({
      stockItemId: String(item?.stockItemId ?? "").trim(),
      productId: String(item?.productId ?? "").trim(),
      price: normalizeMoney(item?.price, "Order item price"),
      commissionRate: normalizeCommissionRate(item?.commissionRate),
    })),
    shippingFee: normalizeMoney(order.shippingFee, "Shipping fee"),
    packagingFee: normalizeMoney(order.packagingFee, "Packaging fee"),
    discount: normalizeMoney(order.discount, "Discount"),
    notes: String(order.notes ?? ""),
  };
}

function orderProtectedFieldsComparable(order = {}) {
  return Object.fromEntries(
    Object.entries(order && typeof order === "object" ? order : {})
      .filter(([key]) => !ORDER_MUTABLE_FIELD_KEYS.has(key) && key !== "payments" && key !== "status")
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

function shipmentBlocksOrderItemRemoval(shipment = {}) {
  return shipmentBlocksInventory(shipment) && !(shipment?.status === "damaged" && shipment?.damageResolution === "reship");
}

function validateOrderBusinessFieldsForPatch(currentOrder = {}, nextOrder = {}, nextState = {}) {
  const normalized = normalizeOrderMutationInput(nextState, nextOrder, currentOrder);
  if (stableJson(normalized) !== stableJson(orderMutableFieldsComparable(nextOrder))) {
    throw new Error("订单字段必须符合订单专用接口的服务端校验结果");
  }
  if (stableJson(orderProtectedFieldsComparable(currentOrder)) !== stableJson(orderProtectedFieldsComparable(nextOrder))) {
    throw new Error("订单编号、创建时间等系统字段不能通过状态补丁修改");
  }

  const nextItemIds = new Set((Array.isArray(nextOrder.items) ? nextOrder.items : [])
    .map((item) => String(item?.stockItemId ?? ""))
    .filter(Boolean));
  const removedItemIds = (Array.isArray(currentOrder.items) ? currentOrder.items : [])
    .map((item) => String(item?.stockItemId ?? ""))
    .filter((id) => id && !nextItemIds.has(id));
  if (removedItemIds.length === 0) return;
  const blockedItemIds = new Set();
  for (const shipment of Array.isArray(nextState.shipments) ? nextState.shipments : []) {
    if (!shipmentBlocksOrderItemRemoval(shipment)) continue;
    for (const id of Array.isArray(shipment.itemStockIds) ? shipment.itemStockIds : []) {
      const stockId = String(id ?? "");
      if (stockId) blockedItemIds.add(stockId);
    }
  }
  if (removedItemIds.some((id) => blockedItemIds.has(id))) {
    throw new Error("已出库或发货的商品不能直接从订单中删除");
  }
}

function validateOrderStatusForPatch(req, currentOrder = {}, nextOrder = {}, nextShipments = []) {
  const currentStatus = String(currentOrder.status ?? "pending");
  const nextStatus = String(nextOrder.status ?? "pending");
  if (!ORDER_STATUS_VALUES.has(nextStatus)) throw new Error(`不支持的订单状态：${nextStatus || "unknown"}`);
  if (currentStatus === nextStatus) return;

  requireOrderPermissionForAuth(req, "update");
  if (nextStatus === "cancelled") {
    throw new Error("取消订单必须通过订单专用接口");
  }
  if (nextStatus === "completed") {
    validateOrderCanComplete(nextOrder, nextShipments);
    return;
  }

  const relatedShipments = nextShipments.filter((shipment) =>
    String(shipment?.orderId ?? "") === String(nextOrder.id ?? "") && shipmentBlocksInventory(shipment)
  );
  if (nextStatus === "pending") {
    if (relatedShipments.length > 0) throw new Error("订单仍有关联发货记录，不能直接改回待处理");
    return;
  }
  if (nextStatus === "shipped") {
    if (relatedShipments.length === 0) throw new Error("没有有效发货记录，不能直接改为已发货");
    const financialState = getOrderFinancialStateForOrder(nextOrder, nextShipments);
    if (financialState.kind !== "paid") throw new Error("订单未结清或存在待退款，不能改为已发货");
    return;
  }
  if (nextStatus === "damaged") {
    const hasDamagedShipment = relatedShipments.some((shipment) => shipment?.status === "damaged");
    if (!hasDamagedShipment) throw new Error("没有报损发货记录，不能直接改为报损");
  }
}

function validateShipmentPatchTransition(currentShipment = {}, nextShipment = {}) {
  const from = String(currentShipment.status ?? "");
  const to = String(nextShipment.status ?? "");
  const shipMethod = String(nextShipment.shipMethod ?? currentShipment.shipMethod ?? "express");
  const proof = Array.isArray(nextShipment.packingProof) ? nextShipment.packingProof : [];
  const allowed = new Set([
    "outbound:outbound",
    "outbound:shipped",
    "outbound:delivered",
    "shipped:shipped",
    "shipped:delivered",
    "shipped:damaged",
    "delivered:delivered",
    "damaged:damaged",
  ]);
  if (!allowed.has(`${from}:${to}`)) {
    throw new Error(`不允许的发货状态流转：${from || "unknown"} -> ${to || "unknown"}`);
  }
  if (to === "damaged" && !["refund", "reship"].includes(String(nextShipment.damageResolution ?? ""))) {
    throw new Error("发货报损必须选择退款或补发处理方式");
  }
  if (from === "outbound" && to === "delivered") {
    if (shipMethod !== "pickup") throw new Error("快递发货必须先确认发货，不能直接签收");
    if (proof.length < 2) throw new Error("确认自取完成必须上传至少 2 张打包凭证");
  }
  if (from !== "delivered" && to === "delivered" && proof.length < 2) {
    throw new Error("确认签收前必须已有至少 2 张打包凭证");
  }
  if (to === "shipped" && shipMethod !== "pickup") {
    if (proof.length < 2) throw new Error("确认发货必须上传至少 2 张打包凭证");
  }
}

function validateOrderStatePatch(req, current = {}, next = {}, changedKeys = []) {
  const changed = new Set(changedKeys);
  if (!changed.has("orders") && !changed.has("shipments") && !changed.has("stock")) return;

  const currentOrders = Array.isArray(current.orders) ? current.orders : [];
  const nextOrders = Array.isArray(next.orders) ? next.orders : [];
  const currentShipments = Array.isArray(current.shipments) ? current.shipments : [];
  const nextShipments = Array.isArray(next.shipments) ? next.shipments : [];
  const currentOrdersById = mapRecordsById(currentOrders);
  const nextOrdersById = mapRecordsById(nextOrders);
  const currentShipmentsById = mapRecordsById(currentShipments);
  const nextShipmentsById = mapRecordsById(nextShipments);

  for (const order of nextOrders) {
    for (const payment of Array.isArray(order?.payments) ? order.payments : []) {
      normalizePaymentRecord(payment);
    }
  }

  for (const [orderId, nextOrder] of nextOrdersById.entries()) {
    const currentOrder = currentOrdersById.get(orderId);
    if (!currentOrder) throw new Error("新建订单必须通过订单专用接口");
    if (stableJson(currentOrder) === stableJson(nextOrder)) continue;
    if (currentOrder.status === "completed") throw new Error("已完成订单不能再修改");
    if (currentOrder.status === "cancelled") throw new Error("已取消订单不能再修改");

    validateOrderBusinessFieldsForPatch(currentOrder, nextOrder, next);
    validateOrderStatusForPatch(req, currentOrder, nextOrder, nextShipments);

    const paymentAction = paymentChangeAction(currentOrder.payments ?? [], nextOrder.payments ?? []);
    if (paymentAction) {
      requireOrderPermissionForAuth(req, paymentAction);
      if (nextOrder.status === "completed" || nextOrder.status === "cancelled") {
        throw new Error("已完成或已取消订单不能修改资金记录");
      }
    }

    if (nextOrder.status === "completed" && currentOrder.status !== "completed") {
      requireOrderPermissionForAuth(req, "update");
      validateOrderCanComplete(nextOrder, nextShipments);
    }
  }

  for (const orderId of currentOrdersById.keys()) {
    if (!nextOrdersById.has(orderId)) throw new Error("删除订单必须通过订单专用接口");
  }

  for (const [shipmentId, nextShipment] of nextShipmentsById.entries()) {
    const currentShipment = currentShipmentsById.get(shipmentId);
    if (!currentShipment) throw new Error("新建发货单必须通过出库专用接口");
    if (stableJson(currentShipment) === stableJson(nextShipment)) continue;
    requireOrderPermissionForAuth(req, "update");
    const relatedOrder = nextOrdersById.get(String(nextShipment.orderId ?? ""));
    if (relatedOrder?.status === "completed" || relatedOrder?.status === "cancelled") {
      throw new Error("已完成或已取消订单不能修改发货状态");
    }
    validateShipmentPatchTransition(currentShipment, nextShipment);
  }

  for (const [shipmentId, currentShipment] of currentShipmentsById.entries()) {
    if (nextShipmentsById.has(shipmentId)) continue;
    requireOrderPermissionForAuth(req, "update");
    if (!["outbound", "shipped"].includes(String(currentShipment.status ?? ""))) {
      throw new Error("只能取消已出库或运输中的发货单");
    }
    const relatedOrder = nextOrdersById.get(String(currentShipment.orderId ?? ""));
    if (relatedOrder?.status === "completed" || relatedOrder?.status === "cancelled") {
      throw new Error("已完成或已取消订单不能取消发货");
    }
  }

  if (changed.has("stock")) {
    const activeOrderStockIds = new Set();
    for (const order of nextOrders) {
      if (!order || order.status === "cancelled") continue;
      for (const item of Array.isArray(order.items) ? order.items : []) {
        const stockId = String(item?.stockItemId ?? "");
        if (stockId) activeOrderStockIds.add(stockId);
      }
    }
    for (const stockItem of Array.isArray(next.stock) ? next.stock : []) {
      if (activeOrderStockIds.has(String(stockItem?.id ?? "")) && stockItem?.sold !== true) {
        throw new Error("订单关联库存不能被直接改回未售出");
      }
    }
  }
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

function sendCosObject(req, res, key, cacheControl = "private, max-age=3600") {
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
      "Cache-Control": cacheControl,
    });
    res.end(body);
  });
}

async function signedCosObjectUrl(key, queryString = "") {
  const client = getCosClient();
  if (!client) return "";
  return await new Promise((resolvePromise, rejectPromise) => {
    const params = {
      Bucket: cosConfig.bucket,
      Region: cosConfig.region,
      Key: key,
      Sign: true,
      Expires: 3600,
    };
    if (queryString) params.QueryString = queryString;
    client.getObjectUrl(params, (error, data = {}) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(typeof data === "string" ? data : (data.Url || data.url || ""));
    });
  });
}

function imagePreviewQuery(widthValue) {
  const width = Math.min(1200, Math.max(80, Number(widthValue) || 360));
  return `imageMogr2/thumbnail/${Math.round(width)}x/quality/70/ignore-error/1`;
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
  if (normalized === "image/heic") return ".heic";
  if (normalized === "image/heif") return ".heif";
  if (normalized === "video/mp4") return ".mp4";
  if (normalized === "video/webm") return ".webm";
  if (normalized === "video/quicktime") return ".mov";
  if (normalized === "video/x-m4v") return ".m4v";
  if (normalized === "video/3gpp") return ".3gp";
  if (normalized === "video/3gpp2") return ".3g2";
  return ".bin";
}

function mimeForExtension(ext) {
  const normalized = String(ext || "").toLowerCase();
  if (normalized === ".jpg" || normalized === ".jpeg") return "image/jpeg";
  if (normalized === ".png") return "image/png";
  if (normalized === ".webp") return "image/webp";
  if (normalized === ".gif") return "image/gif";
  if (normalized === ".heic") return "image/heic";
  if (normalized === ".heif") return "image/heif";
  if (normalized === ".mp4") return "video/mp4";
  if (normalized === ".webm") return "video/webm";
  if (normalized === ".mov") return "video/quicktime";
  if (normalized === ".m4v") return "video/x-m4v";
  if (normalized === ".3gp") return "video/3gpp";
  if (normalized === ".3g2") return "video/3gpp2";
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

function normalizeUploadMime(value, filename = "") {
  const mime = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mime && mime !== "application/octet-stream") return mime;
  const decodedName = decodeURIComponent(String(filename || ""));
  const inferred = mimeForExtension(extname(decodedName));
  return inferred === "application/octet-stream" ? mime : inferred;
}

async function uploadOriginalMedia(buffer, mime) {
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
  const ext = extensionForMime(mime);
  const typeFolder = mime.startsWith("video/") ? "videos" : "images";
  const fileName = `${hash}${ext}`;
  if (cosReady()) {
    const cosUrl = await uploadBufferToCos(
      buffer,
      mime,
      prefixedCosKey("original", typeFolder, fileName)
    );
    if (cosUrl) return cosUrl;
  }

  const folder = join(uploadDir, "original", typeFolder);
  const filePath = join(folder, fileName);
  await mkdir(folder, { recursive: true });
  if (!existsSync(filePath)) {
    await writeFile(filePath, buffer);
  }
  return `/uploads/original/${typeFolder}/${fileName}`;
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

async function readRawBody(req, maxBytes = Number.POSITIVE_INFINITY) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("上传文件过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readBody(req) {
  const buffer = await readRawBody(req);
  return buffer.toString("utf8");
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

async function backfillDefaultSites() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const state = rows[0]?.data;
    if (!state || typeof state !== "object") {
      await client.query("ROLLBACK");
      return;
    }

    const currentSites = Array.isArray(state.sites) ? state.sites : [];
    const nextSites = getSitesFromState(state);
    if (JSON.stringify(currentSites) === JSON.stringify(nextSites)) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      "UPDATE app_state SET data = jsonb_set(data, '{sites}', $2::jsonb, true), updated_at = now() WHERE id = $1",
      [stateId, JSON.stringify(nextSites)]
    );
    await client.query("COMMIT");
    console.log(`Backfilled default sites: ${nextSites.map((site) => site.name).join(", ")}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Failed to backfill default sites:", error);
  } finally {
    client.release();
  }
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
    await backfillDefaultSites();
    await rehashPlaintextPersonnelPasswords();
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

  if (url.pathname === "/api/assistant/feishu/events" && req.method === "POST") {
    try {
      const rawBody = await readBody(req);
      const payload = JSON.parse(rawBody || "{}");
      if (!verifyFeishuEventToken(payload)) {
        sendJson(req, res, 403, { ok: false, error: "Invalid Feishu verification token" });
        return;
      }

      const challenge = feishuChallenge(payload);
      if (challenge) {
        sendJson(req, res, 200, { challenge });
        return;
      }

      if (payload.encrypt) {
        sendJson(req, res, 400, {
          ok: false,
          error: "Encrypted Feishu callbacks are not supported. Disable callback encryption or add decryption support.",
        });
        return;
      }

      const event = extractFeishuTextEvent(payload);
      if (!event.text) {
        sendJson(req, res, 200, { ok: true, ignored: true, reason: event.ignoredReason || "No text message" });
        return;
      }

      await ensureSchema();
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const result = await answerAssistantQuestion({
        message: event.text,
        state: rows[0]?.data ?? {},
        siteId: feishuConfig.defaultSiteId,
        source: "feishu",
      });

      let replied = false;
      let replyError = null;
      if (event.messageId && feishuAppReady()) {
        try {
          await replyFeishuMessage(event.messageId, result.answer);
          replied = true;
        } catch (error) {
          replyError = error.message || "Failed to reply Feishu message";
        }
      } else if (!feishuAppReady()) {
        replyError = "FEISHU_APP_ID and FEISHU_APP_SECRET are not configured";
      }

      sendJson(req, res, 200, {
        ok: true,
        replied,
        replyError,
        aiConfigured: result.aiConfigured,
      });
    } catch (error) {
      sendJson(req, res, 400, { ok: false, error: error.message || "Failed to handle Feishu event" });
    }
    return;
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    sendJson(req, res, 200, { ok: true }, { "Set-Cookie": clearAuthCookieHeader() });
    return;
  }

  if (!isPublicApiRoute(req, url) && !bearerTokenFromRequest(req)) {
    sendJson(req, res, 401, { ok: false, error: "Authentication required" });
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
      assistant: assistantPublicConfig(),
    });
    return;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      if (!username || !password) {
        sendJson(req, res, 400, { ok: false, error: "用户名和密码不能为空" });
        return;
      }
      const accounts = await readAuthAccounts();
      const account = accounts.find((person) =>
        String(person?.username ?? "") === username &&
        verifyPassword(person?.password, password)
      );
      const user = account ? publicUserFromAccount(account) : null;
	      if (!user || (process.env.NODE_ENV === "production" && !allowDefaultCredentials && isDefaultCredential(username, password))) {
	        sendJson(req, res, 401, { ok: false, error: "用户名或密码错误" });
	        return;
	      }
	      if (passwordNeedsRehash(account.password)) {
	        await rehashStoredPasswordIfNeeded(username, password);
	      }
	      const session = createAuthToken(user);
      sendJson(req, res, 200, {
        ok: true,
        user,
        token: session.token,
        expiresAt: session.expiresAt,
      }, { "Set-Cookie": authCookieHeader(session.token, session.expiresAt) });
    } catch (error) {
      sendJson(req, res, 400, { ok: false, error: error.message || "登录失败" });
    }
    return;
  }

  if (!isPublicApiRoute(req, url)) {
    const auth = await authenticateApiRequest(req);
    if (!auth) {
      sendJson(req, res, 401, { ok: false, error: "Authentication required" });
      return;
    }
    req.auth = auth;
  }

  if (url.pathname === "/api/weather/forecast" && req.method === "GET") {
    try {
      const address = String(url.searchParams.get("address") ?? "").trim();
      const forecast = await weatherForecastForAddress(address);
      sendJson(req, res, 200, { ok: true, ...forecast });
    } catch (error) {
      sendJson(req, res, 502, { ok: false, error: error.message || "天气预报获取失败" });
    }
    return;
  }

  if (url.pathname === "/api/public/media/cos" && req.method === "GET") {
    try {
      const mediaUrl = String(url.searchParams.get("url") ?? "").trim();
      const key = cosKeyFromUrl(mediaUrl);
      if (!key) {
        sendJson(req, res, 400, { error: "Invalid COS media URL" });
        return;
      }
      const siteId = url.searchParams.get("siteId") ?? ALL_SITE_ID;
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const allowedUrls = publicCatalogAllowedMediaUrls(rows[0]?.data ?? {}, siteId);
      if (!allowedUrls.has(mediaUrl)) {
        sendJson(req, res, 403, { error: "COS media is not public catalog content" });
        return;
      }
      sendCosObject(req, res, key, "public, max-age=3600");
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message || "Failed to load public media" });
    }
    return;
  }

  if (url.pathname === "/api/public/catalog" && req.method === "GET") {
    try {
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      sendJson(req, res, 200, {
        ok: true,
        catalog: buildPublicCatalog(rows[0]?.data ?? {}, url.searchParams.get("siteId") ?? ALL_SITE_ID),
      });
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message || "Failed to load public catalog" });
    }
    return;
  }

  if (url.pathname === "/api/public/bio-records" && req.method === "GET") {
    try {
      const stockItemId = String(url.searchParams.get("stockItemId") ?? "").trim();
      if (!stockItemId) {
        sendJson(req, res, 400, { ok: false, error: "stockItemId is required" });
        return;
      }
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const bioRecords = buildPublicBioRecordsForStock(
        rows[0]?.data ?? {},
        url.searchParams.get("siteId") ?? ALL_SITE_ID,
        stockItemId
      );
      if (!bioRecords) {
        sendJson(req, res, 404, { ok: false, error: "Stock item is not public" });
        return;
      }
      sendJson(req, res, 200, { ok: true, bioRecords });
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message || "Failed to load public bio records" });
    }
    return;
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    sendJson(req, res, 200, { ok: true, user: req.auth.user });
    return;
  }

  if (url.pathname === "/api/personnel/save" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const incoming = body.personnel && typeof body.personnel === "object" ? body.personnel : body;
      const incomingId = String(incoming?.id ?? "").trim();
      requireModulePermissionForAuth(req, "accounts", incomingId ? "update" : "create");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const orders = Array.isArray(state.orders) ? state.orders : [];
      const existing = incomingId
        ? personnel.find((person) => String(person?.id ?? "") === incomingId)
        : null;
      if (incomingId && !existing) throw new Error("人员不存在或已被删除");
      const nextPerson = normalizePersonnelInput(incoming, existing, state);
      const duplicate = personnel.find((person) =>
        String(person?.id ?? "") !== nextPerson.id &&
        String(person?.username ?? "").trim() === nextPerson.username
      );
      if (duplicate) throw new Error("登录账号不能重复");
      if (existing?.username === req.auth.user.username && nextPerson.accessRole !== "admin") {
        throw new Error("不能把当前管理员改为店员");
      }
      if (existing?.accessRole === "admin" && nextPerson.accessRole !== "admin" && countAdmins(personnel, existing.id) === 0) {
        throw new Error("至少需要保留一个管理员账号");
      }

      const nextPersonnel = existing
        ? personnel.map((person) => String(person?.id ?? "") === nextPerson.id ? nextPerson : person)
        : [...personnel, nextPerson];
      const nextOrders = existing?.name && existing.name !== nextPerson.name
        ? orders.map((order) =>
            order?.contactPerson === existing.name ? { ...order, contactPerson: nextPerson.name } : order
          )
        : orders;
      const operationLog = createOperationLog(
        req,
        "人员管理",
        existing ? "修改记录" : "添加记录",
        `${existing ? "修改" : "新增"}人员账号「${nextPerson.name}」（${nextPerson.username}）`
      );
      const nextState = {
        ...state,
        personnel: nextPersonnel,
        orders: nextOrders,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        personnel: sanitizePersonnelForResponse(nextPersonnel, req),
        orders: nextOrders,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "保存人员失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/personnel/delete" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireModulePermissionForAuth(req, "accounts", "delete");
      const body = JSON.parse(await readBody(req) || "{}");
      const deleteId = String(body.id ?? body.deleteId ?? "").trim();
      if (!deleteId) throw new Error("缺少人员 ID");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const orders = Array.isArray(state.orders) ? state.orders : [];
      const target = personnel.find((person) => String(person?.id ?? "") === deleteId);
      if (!target) throw new Error("人员不存在或已被删除");
      if (target.username === req.auth.user.username) throw new Error("当前登录人员不能删除");
      if (target.accessRole === "admin" && countAdmins(personnel, target.id) === 0) {
        throw new Error("至少需要保留一个管理员账号");
      }
      if (orders.some((order) => order?.contactPerson === target.name)) {
        throw new Error("该人员已有订单关联，不能删除");
      }
      const nextPersonnel = personnel.filter((person) => String(person?.id ?? "") !== deleteId);
      const operationLog = createOperationLog(
        req,
        "人员管理",
        "删除记录",
        `删除人员账号「${target.name || target.username}」（${target.username}）`
      );
      const nextState = {
        ...state,
        personnel: nextPersonnel,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        personnel: sanitizePersonnelForResponse(nextPersonnel, req),
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "删除人员失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/personnel/resign" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireModulePermissionForAuth(req, "accounts", "update");
      const body = JSON.parse(await readBody(req) || "{}");
      const targetId = String(body.id ?? body.personnelId ?? "").trim();
      if (!targetId) throw new Error("缺少人员 ID");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const target = personnel.find((person) => String(person?.id ?? "") === targetId);
      if (!target) throw new Error("人员不存在或已被删除");
      if (isPersonnelResigned(target)) throw new Error("该人员已经离职");
      if (target.username === req.auth.user.username) throw new Error("当前登录人员不能设为离职");
      if (target.accessRole === "admin" && countAdmins(personnel, target.id) === 0) {
        throw new Error("至少需要保留一个在职管理员账号");
      }
      const resignedAt = nowDatetimeInChina();
      const nextPersonnel = personnel.map((person) =>
        String(person?.id ?? "") === targetId
          ? {
              ...person,
              accessRole: "staff",
              employmentStatus: "resigned",
              resignedAt,
              permissions: emptyPermissionsValue(),
            }
          : person
      );
      const operationLog = createOperationLog(
        req,
        "人员管理",
        "修改记录",
        `设置人员「${target.name || target.username}」（${target.username}）离职，并清空权限`
      );
      const nextState = {
        ...state,
        personnel: nextPersonnel,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        personnel: sanitizePersonnelForResponse(nextPersonnel, req),
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "离职操作失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/personnel/permissions" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireModulePermissionForAuth(req, "accounts", "update");
      const body = JSON.parse(await readBody(req) || "{}");
      const targetId = String(body.id ?? body.personnelId ?? "").trim();
      if (!targetId) throw new Error("缺少人员 ID");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const target = personnel.find((person) => String(person?.id ?? "") === targetId);
      if (!target) throw new Error("人员不存在或已被删除");
      if (isPersonnelResigned(target)) throw new Error("离职人员权限已清空，不能再授权");
      const nextPermissions = target.accessRole === "admin"
        ? fullPermissionsValue()
        : normalizePermissionsForStorage(body.permissions);
      const nextPersonnel = personnel.map((person) =>
        String(person?.id ?? "") === targetId ? { ...person, permissions: nextPermissions } : person
      );
      const operationLog = createOperationLog(
        req,
        "权限管理",
        "修改记录",
        `修改「${target.name || target.username}」的模块权限`
      );
      const nextState = {
        ...state,
        personnel: nextPersonnel,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        personnel: sanitizePersonnelForResponse(nextPersonnel, req),
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "保存权限失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/personnel/password" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const targetId = String(body.targetId ?? body.id ?? "").trim();
      const newPassword = String(body.newPassword ?? "");
      if (!newPassword) throw new Error("请输入新密码");
      if (newPassword.length < 6) throw new Error("新密码至少 6 位");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const target = targetId
        ? personnel.find((person) => String(person?.id ?? "") === targetId)
        : personnel.find((person) => String(person?.username ?? "") === req.auth.user.username);
      if (!target) throw new Error("人员不存在或已被删除");
      if (isPersonnelResigned(target)) throw new Error("离职人员不能修改登录密码");
      const adminReset = Boolean(targetId) && req.auth.account?.accessRole === "admin";
      if (adminReset) {
        requireModulePermissionForAuth(req, "accounts", "update");
      } else {
        if (target.username !== req.auth.user.username) throw new Error("只能修改自己的密码");
        if (!verifyPassword(target.password, String(body.oldPassword ?? ""))) throw new Error("原密码不正确");
      }
      const nextPersonnel = personnel.map((person) =>
        String(person?.id ?? "") === String(target.id ?? "")
          ? { ...person, password: hashPassword(newPassword) }
          : person
      );
      const operationLog = createOperationLog(
        req,
        "人员管理",
        "修改记录",
        adminReset
          ? `管理员重置「${target.name || target.username}」的登录密码`
          : `修改自己的登录密码`
      );
      const nextState = {
        ...state,
        personnel: nextPersonnel,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        personnel: sanitizePersonnelForResponse(nextPersonnel, req),
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "修改密码失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/assistant/config" && req.method === "GET") {
    sendJson(req, res, 200, assistantPublicConfig());
    return;
  }

  if (url.pathname === "/api/assistant/chat" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const message = String(body.message ?? "").trim();
      const siteId = normalizeSiteScope(body.siteId ?? ALL_SITE_ID);
      const operator = authenticatedOperator(req);
      const notifyFeishu = Boolean(body.notifyFeishu);
      if (!message) {
        sendJson(req, res, 400, { ok: false, error: "请输入要询问 AI 助手的问题" });
        return;
      }

      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const result = await answerAssistantQuestion({
        message,
        state: rows[0]?.data ?? {},
        siteId,
        source: "web",
      });

      let feishu = { ok: false, skipped: true };
      if (notifyFeishu) {
        feishu = await sendFeishuWebhookText([
          `鱼房 AI 助手（${operator}）`,
          `问题：${message}`,
          "",
          result.answer,
        ].join("\n"));
      }

      sendJson(req, res, 200, {
        ok: true,
        answer: result.answer,
        aiConfigured: result.aiConfigured,
        model: result.model,
        usage: result.usage ?? null,
        feishuNotified: Boolean(feishu.ok),
        feishuError: feishu.ok || feishu.skipped ? null : feishu.error,
      });
    } catch (error) {
      sendJson(req, res, 400, { ok: false, error: error.message || "AI assistant request failed" });
    }
    return;
  }

  if (url.pathname === "/api/media/upload" && req.method === "POST") {
    try {
      const mime = normalizeUploadMime(req.headers["content-type"], req.headers["x-file-name"]);
      const isImage = mime.startsWith("image/");
      const isVideo = mime.startsWith("video/");
      if (!isImage && !isVideo) {
        sendJson(req, res, 400, { ok: false, error: "只支持上传图片或视频文件" });
        return;
      }
      const maxBytes = isVideo ? MAX_VIDEO_UPLOAD_BYTES : MAX_IMAGE_UPLOAD_BYTES;
      const buffer = await readRawBody(req, maxBytes);
      if (buffer.length === 0) {
        sendJson(req, res, 400, { ok: false, error: "上传文件为空" });
        return;
      }
      const mediaUrl = await uploadOriginalMedia(buffer, mime);
      sendJson(req, res, 200, {
        ok: true,
        url: mediaUrl,
        mime,
        size: buffer.length,
        storage: cosReady() ? "cos" : "local",
      });
    } catch (error) {
      const status = error?.statusCode === 413 ? 413 : 500;
      sendJson(req, res, status, {
        ok: false,
        error: status === 413
          ? `上传文件过大，当前限制为图片 ${Math.round(MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024)}MB、视频 ${Math.round(MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024)}MB`
          : (error.message || "媒体上传失败"),
      });
    }
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
      const previewQuery = url.searchParams.get("preview") === "image"
        ? imagePreviewQuery(url.searchParams.get("width"))
        : "";
      const signedUrl = await signedCosObjectUrl(key, previewQuery);
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
    sendJson(req, res, 200, { personnel: sanitizePersonnelForLoginData(rows[0]?.personnel ?? [], req) });
    return;
  }

  if (url.pathname === "/api/dashboard-summary" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
    const data = siteVisibilityFilteredState(rows[0]?.data ?? {}, req.auth?.account);
    sendJson(req, res, 200, {
      summary: buildDashboardSummary(data, {
        financeDays: url.searchParams.get("financeDays") ?? url.searchParams.get("days"),
        siteId: url.searchParams.get("siteId") ?? ALL_SITE_ID,
      }),
    });
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
    sendJson(req, res, 200, { data: sanitizeStateForResponse(rows[0]?.data ?? null, req) });
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
      const data = sanitizeStateForResponse(rows[0]?.data ?? {}, req);
      sendJson(req, res, 200, {
        data: pickState(data, keys, { liteSpecies: lite.has("species") }),
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

  if (url.pathname === "/api/customers/create" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      requireModulePermissionForAuth(req, "customers", "create");
      const customer = normalizeCustomerInput(body.customer ?? body);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const customers = Array.isArray(state.customers) ? state.customers : [];
      const customerSources = Array.isArray(state.customerSources) ? state.customerSources : [];
      if (customers.some((item) => String(item?.id ?? "") === customer.id)) {
        throw new Error("客户已存在，请刷新后重试");
      }
      const nextCustomers = [...customers, customer];
      const nextCustomerSources = customer.source && !customerSources.includes(customer.source)
        ? [...customerSources, customer.source]
        : customerSources;
      const operationLog = createOperationLog(req, "客户管理", "添加记录", `新增客户「${customer.name}」`);
      const nextState = {
        ...state,
        customers: nextCustomers,
        customerSources: nextCustomerSources,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query(
        `INSERT INTO app_state (id, data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        customer,
        customers: nextCustomers,
        customerSources: nextCustomerSources,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "新增客户失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/create" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await externalizeDataUrls(JSON.parse(await readBody(req)));
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermissionForAuth(req, "create");
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
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermissionForAuth(req, "update");
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

  if (url.pathname === "/api/orders/payment" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await externalizeDataUrls(JSON.parse(await readBody(req)));
      const operator = authenticatedOperator(req);
      const action = String(body.action ?? "").trim();
      const permissionAction = action === "add" ? "create" : action === "update" ? "update" : action === "delete" ? "delete" : "";
      if (!permissionAction) throw new Error("不支持的资金记录操作");

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermissionForAuth(req, permissionAction);

      const orders = Array.isArray(state.orders) ? state.orders : [];
      const orderId = String(body.orderId ?? "");
      const currentOrder = orders.find((order) => String(order?.id ?? "") === orderId);
      if (!currentOrder) throw new Error("订单不存在，请刷新后重试");
      if (currentOrder.status === "completed") throw new Error("已完成订单不能再编辑资金记录");
      if (currentOrder.status === "cancelled") throw new Error("已取消订单不能再编辑资金记录");

      const currentPayments = Array.isArray(currentOrder.payments) ? currentOrder.payments : [];
      let nextPayments = currentPayments;
      let detail = "";

      if (action === "add") {
        const payment = normalizePaymentRecord(body.payment ?? {});
        if (currentPayments.some((item) => String(item?.id ?? "") === payment.id)) {
          throw new Error("资金记录已存在，请刷新后重试");
        }
        nextPayments = [...currentPayments, payment];
        detail = `订单「${currentOrder.orderNo}」新增${paymentTypeLabel(payment.type)} ¥${payment.amount.toFixed(2)}`;
      } else if (action === "update") {
        const payment = normalizePaymentRecord(body.payment ?? {});
        if (!currentPayments.some((item) => String(item?.id ?? "") === payment.id)) {
          throw new Error("资金记录不存在，请刷新后重试");
        }
        nextPayments = currentPayments.map((item) => String(item?.id ?? "") === payment.id ? payment : item);
        detail = `订单「${currentOrder.orderNo}」修改${paymentTypeLabel(payment.type)}记录 ¥${payment.amount.toFixed(2)}`;
      } else {
        const paymentId = String(body.paymentId ?? body.payment?.id ?? "");
        const deletingPayment = currentPayments.find((item) => String(item?.id ?? "") === paymentId);
        if (!deletingPayment) throw new Error("资金记录不存在，请刷新后重试");
        nextPayments = currentPayments.filter((item) => String(item?.id ?? "") !== paymentId);
        detail = `订单「${currentOrder.orderNo}」删除${paymentTypeLabel(deletingPayment.type)}记录 ¥${Number(deletingPayment.amount ?? 0).toFixed(2)}`;
      }

      const nextOrder = { ...currentOrder, payments: nextPayments };
      const nextOrders = orders.map((order) => String(order?.id ?? "") === orderId ? nextOrder : order);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: action === "add" ? "添加记录" : action === "update" ? "修改记录" : "删除记录",
        detail,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };

      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, order: nextOrder, orders: nextOrders, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/return-item" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await externalizeDataUrls(JSON.parse(await readBody(req)));
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermissionForAuth(req, "update");

      const orders = Array.isArray(state.orders) ? state.orders : [];
      const orderId = String(body.orderId ?? "");
      const stockItemId = String(body.stockItemId ?? "").trim();
      if (!orderId || !stockItemId) throw new Error("缺少订单或商品信息");

      const currentOrder = orders.find((order) => String(order?.id ?? "") === orderId);
      if (!currentOrder) throw new Error("订单不存在，请刷新后重试");
      if (currentOrder.status === "completed") throw new Error("已完成订单不能退商品");
      if (currentOrder.status === "cancelled") throw new Error("已取消订单不能退商品");

      const currentItems = Array.isArray(currentOrder.items) ? currentOrder.items : [];
      const returningItem = currentItems.find((item) => String(item?.stockItemId ?? "") === stockItemId);
      if (!returningItem) throw new Error("该商品已不在订单中，请刷新后重试");

      const activeShipment = (Array.isArray(state.shipments) ? state.shipments : []).find((shipment) =>
        String(shipment?.orderId ?? "") === orderId &&
        shipmentBlocksOrderItemRemoval(shipment) &&
        Array.isArray(shipment?.itemStockIds) &&
        shipment.itemStockIds.some((id) => String(id ?? "") === stockItemId)
      );
      if (activeShipment) throw new Error("该商品已出库或已发货，不能按未发货商品退款");

      let refundRecord = null;
      if (body.refund && typeof body.refund === "object") {
        refundRecord = normalizePaymentRecord(body.refund);
        if (refundRecord.type !== "refund") throw new Error("退商品只能写入退款记录");
        if (refundRecord.amount <= 0.005) refundRecord = null;
      }
      if (refundRecord) {
        requireOrderPermissionForAuth(req, "create");
        const maxRefund = Math.max(calcAmountPaidForOrder(currentOrder), 0);
        if (refundRecord.amount > maxRefund + 0.005) {
          throw new Error(`退款金额不能超过当前净已收款 ¥${maxRefund.toFixed(2)}`);
        }
        const currentPayments = Array.isArray(currentOrder.payments) ? currentOrder.payments : [];
        if (currentPayments.some((payment) => String(payment?.id ?? "") === refundRecord.id)) {
          throw new Error("退款记录已存在，请刷新后重试");
        }
      }

      const nextOrder = {
        ...currentOrder,
        items: currentItems.filter((item) => String(item?.stockItemId ?? "") !== stockItemId),
        payments: refundRecord
          ? [...(Array.isArray(currentOrder.payments) ? currentOrder.payments : []), refundRecord]
          : (Array.isArray(currentOrder.payments) ? currentOrder.payments : []),
      };
      const nextOrders = orders.map((order) => String(order?.id ?? "") === orderId ? nextOrder : order);
      const nextStock = setStockSoldForOrders(state, nextOrders);
      const product = (Array.isArray(state.products) ? state.products : [])
        .find((item) => String(item?.id ?? "") === String(returningItem?.productId ?? ""));
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: `订单「${currentOrder.orderNo}」退商品「${product?.name ?? returningItem.productId ?? stockItemId}」${refundRecord ? `，退款 ¥${refundRecord.amount.toFixed(2)}` : ""}`,
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
      sendJson(req, res, 400, { ok: false, error: error.message || "退商品失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/delete" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req));
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermissionForAuth(req, "delete");
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
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      requireOrderPermissionForAuth(req, "update");
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
      const isPickup = shipMethod === "pickup";
      const createdAt = nowDatetimeInChina();
      const shipment = {
        id: String(body.id || uid("ship")),
        siteId: normalizeSiteId(order.siteId),
        orderId: order.id,
        createdAt,
        outboundDate: shipDate,
        shipDate,
        carrier: isPickup ? "上门自取" : carrier,
        trackingNo: "",
        status: isPickup ? "delivered" : "outbound",
        notes: String(body.notes ?? ""),
        shipMethod,
        actualShippingFee: isPickup ? 0 : normalizeMoney(body.actualShippingFee, "Actual shipping fee"),
        itemStockIds: selectedItemIds,
        ...(isPickup ? { shippedAt: createdAt, deliveredAt: createdAt } : {}),
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
        detail: isPickup
          ? `订单「${order.orderNo}」上门自取签收 ${selectedItemIds.length} 条商品`
          : `订单「${order.orderNo}」出库 ${selectedItemIds.length} 条商品`,
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

  if (url.pathname === "/api/shipments/confirm" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const rawBody = JSON.parse(await readBody(req) || "{}");
      const body = await externalizeDataUrls(rawBody);
      const operator = authenticatedOperator(req);
      const shipmentId = String(body.shipmentId ?? "").trim();
      const packingProof = Array.isArray(body.packingProof)
        ? body.packingProof.map((item) => String(item ?? "")).filter(Boolean)
        : [];
      if (!shipmentId) throw new Error("缺少发货单信息，请刷新后重试");
      if (packingProof.length < 2) throw new Error("请至少上传 2 张打包凭证");

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      requireOrderPermissionForAuth(req, "update");

      const shipments = Array.isArray(state.shipments) ? state.shipments : [];
      const shipment = shipments.find((item) => String(item?.id ?? "") === shipmentId);
      if (!shipment) throw new Error("发货单不存在，请刷新后重试");
      if (shipment.status !== "outbound") throw new Error("只有已出库的发货单可以确认发货");

      const orders = Array.isArray(state.orders) ? state.orders : [];
      const order = orders.find((item) => String(item?.id ?? "") === String(shipment.orderId ?? ""));
      if (!order) throw new Error("订单不存在，请刷新后重试");
      if (order.status === "completed") throw new Error("已完成订单不能再确认发货");
      if (order.status === "cancelled") throw new Error("已取消订单不能再确认发货");

      const now = nowDatetimeInChina();
      const shipMethod = shipment.shipMethod === "pickup" ? "pickup" : "express";
      const updatedShipment = {
        ...shipment,
        status: shipMethod === "pickup" ? "delivered" : "shipped",
        packingProof,
        shippedAt: now,
        shipDate: todayInChina(),
        actualShippingFee: shipMethod === "pickup" ? 0 : shipment.actualShippingFee,
      };
      const nextShipments = shipments.map((item) =>
        String(item?.id ?? "") === shipmentId ? updatedShipment : item
      );
      const nextOrders = orders.map((item) =>
        String(item?.id ?? "") === String(order.id ?? "") &&
        item.status !== "cancelled" &&
        item.status !== "completed" &&
        item.status !== "damaged"
          ? { ...item, status: "shipped" }
          : item
      );
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: `订单「${order.orderNo}」确认发货 ${Array.isArray(shipment.itemStockIds) ? shipment.itemStockIds.length : 0} 条商品`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        shipments: nextShipments,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        shipment: updatedShipment,
        orders: nextOrders,
        shipments: nextShipments,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "确认发货失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/shipments/cancel" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      requireOrderPermissionForAuth(req, "update");

      const shipmentId = String(body.shipmentId ?? "").trim();
      if (!shipmentId) throw new Error("缺少发货单信息");
      const shipments = Array.isArray(state.shipments) ? state.shipments : [];
      const shipment = shipments.find((item) => String(item?.id ?? "") === shipmentId);
      if (!shipment) throw new Error("发货单不存在，请刷新后重试");
      if (shipment.status !== "outbound" && shipment.status !== "shipped") {
        throw new Error("只有已出库或运输中的发货单可以取消");
      }

      const orders = Array.isArray(state.orders) ? state.orders : [];
      const order = orders.find((item) => String(item?.id ?? "") === String(shipment.orderId ?? ""));
      if (!order) throw new Error("订单不存在，请刷新后重试");
      if (order.status === "completed") throw new Error("已完成订单不能取消发货");

      const nextShipments = shipments.filter((item) => String(item?.id ?? "") !== shipmentId);
      const remainingActiveShipments = nextShipments.filter((item) =>
        String(item?.orderId ?? "") === String(order.id ?? "") && countsAsCompletionShipment(item)
      );
      const nextOrders = orders.map((item) => {
        if (String(item?.id ?? "") !== String(order.id ?? "")) return item;
        if (item.status === "completed" || item.status === "cancelled" || item.status === "damaged") return item;
        return { ...item, status: remainingActiveShipments.length > 0 ? "shipped" : "pending" };
      });
      const nextStock = setStockSoldForOrders({ ...state, shipments: nextShipments }, nextOrders);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: `订单「${order.orderNo}」取消出库/发货 ${Array.isArray(shipment.itemStockIds) ? shipment.itemStockIds.length : 0} 条商品`,
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
      sendJson(req, res, 400, { ok: false, error: error.message || "取消出库失败" });
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
	      const rawPatch = parsed?.patch && typeof parsed.patch === "object" ? parsed.patch : {};
	      validateStatePatchAuthorization(req, rawPatch);
	      const basePatch = parsed?.basePatch && typeof parsed.basePatch === "object" ? parsed.basePatch : {};
	      const incomingLogs = sanitizeOperationLogsForAuth(parsed?.operationLogs, req);
	      await client.query("BEGIN");
	      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
	      const current = normalizePickupShipmentsForState(rows[0]?.data ?? {});
	      const validationState = buildStatePatch(current, rawPatch, basePatch, incomingLogs, req);

	      validateOrderStatePatch(req, current, validationState, Object.keys(rawPatch));
	      validateReferenceIntegrity(current, validationState, Object.keys(rawPatch));
	      const patch = await externalizeDataUrls(rawPatch);
	      const nextState = buildStatePatch(current, patch, basePatch, incomingLogs, req);

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
		      const rawChange = JSON.parse(body);
		      const rawUpsert = Array.isArray(rawChange?.upsert) ? rawChange.upsert : [];
		      const rawDeleteIds = Array.isArray(rawChange?.deleteIds) ? rawChange.deleteIds : [];
	      const operator = authenticatedOperator(req);
	      if (rawUpsert.length === 0 && rawDeleteIds.length === 0) {
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
	        const existingIds = new Set(stock.map((item) => String(item?.id ?? "")).filter(Boolean));
	        const rawUpsertIds = rawUpsert.map((item) => String(item?.id ?? "")).filter(Boolean);
	        const hasCreates = rawUpsert.some((item) => !existingIds.has(String(item?.id ?? "")));
	        const hasUpdates = rawUpsertIds.some((id) => existingIds.has(id));
	        if (rawDeleteIds.length > 0) requireModulePermissionForAuth(req, "stockIn", "delete");
	        if (hasCreates) requireModulePermissionForAuth(req, "stockIn", "create");
	        if (hasUpdates) requireModulePermissionForAuth(req, "stockIn", "update");
	        const {
	          upsert = [],
	          deleteIds = [],
	        } = await externalizeDataUrls(rawChange);
	        const upsertItems = Array.isArray(upsert) ? upsert.map(normalizeStockItem) : [];
	        const deleteIdSet = new Set(Array.isArray(deleteIds) ? deleteIds.map((id) => String(id)) : []);
	        const upsertById = new Map(upsertItems.map((item) => [item.id, item]));
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
          module: "库存明细",
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
		      const rawChange = JSON.parse(body);
		      const rawMode = String(rawChange?.mode ?? "");
		      if (rawMode === "record") requireModulePermissionForAuth(req, "daily", "create");
		      else if (rawMode === "move") requireModulePermissionForAuth(req, "daily", "update");
		      else if (rawMode === "loss") requireModulePermissionForAuth(req, "lossRecords", "create");
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
		      } = await externalizeDataUrls(rawChange);
	      const operator = authenticatedOperator(req);
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
	          const targetTank = findSubTank(state, targetId);
	          if (!targetTank) throw new Error("目标子缸不存在或已被删除");
	          const targetSiteId = normalizeSiteId(targetTank.group?.siteId);
	          const targetName = subTankDisplayName(state, targetId);
	          const requestedIds = Array.isArray(itemIds) ? itemIds.map((id) => String(id)) : [];
	          const idSet = new Set(requestedIds);
	          if (idSet.size === 0) throw new Error("请选择要移缸的鱼");
	          const shippedIds = shippedOutStockIds(state);
	          const movingItems = stock.filter((item) => idSet.has(item.id));
	          if (movingItems.length !== idSet.size) throw new Error("部分库存鱼不存在或已被删除");
	          const invalidItem = movingItems.find((item) => !isPhysicallyInTank(item, shippedIds));
	          if (invalidItem) throw new Error("已损耗或已发货的鱼不能移缸");
	          if (movingItems.every((item) => item.subTankId === targetId)) throw new Error("目标子缸与当前子缸相同");
	          const notes = String(moveNotes ?? "").trim();
	          const date = String(moveDate ?? new Date().toISOString().slice(0, 10)).trim();
	          const moveRecords = movingItems.map((item) => ({
	            id: uid("bio"),
	            siteId: targetSiteId,
	            stockItemId: item.id,
	            date,
	            text: `移缸：${subTankDisplayName(state, item.subTankId)} → ${targetName}${notes ? `。备注：${notes}` : ""}`,
	            photos: [],
	            videos: [],
	          }));
	          nextStock = stock.map((item) =>
	            idSet.has(item.id) ? { ...item, siteId: targetSiteId, subTankId: targetId } : item
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
		      const rawChange = JSON.parse(body);
		      const rawMode = String(rawChange?.mode ?? "");
	      const operator = authenticatedOperator(req);
	      if (!rawMode) {
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
	        if (rawMode === "deleteGroup" || rawMode === "deleteSubTank") {
	          requireModulePermissionForAuth(req, "tankGroups", "delete");
	        } else if (rawMode === "upsertGroup") {
	          const rawGroup = rawChange.group && typeof rawChange.group === "object" ? rawChange.group : {};
	          const groupExists = rawGroup.id && tankGroups.some((item) => String(item?.id ?? "") === String(rawGroup.id));
	          requireModulePermissionForAuth(req, "tankGroups", groupExists ? "update" : "create");
	        } else if (rawMode === "upsertSubTank") {
	          const targetGroupId = String(rawChange.groupId ?? "");
	          const targetGroup = tankGroups.find((item) => String(item?.id ?? "") === targetGroupId);
	          if (!targetGroup) throw new Error("缸组不存在或已被删除");
	          const rawSubTank = rawChange.subTank && typeof rawChange.subTank === "object" ? rawChange.subTank : {};
	          const subTankExists = rawSubTank.id && (Array.isArray(targetGroup.subTanks) ? targetGroup.subTanks : [])
	            .some((item) => String(item?.id ?? "") === String(rawSubTank.id));
	          requireModulePermissionForAuth(req, "tankGroups", subTankExists ? "update" : "create");
	        } else {
	          throw new Error("Unsupported tank group save mode");
	        }
	        const {
	          mode,
	          group,
	          groupId,
	          subTank,
	          subTankId,
	        } = await externalizeDataUrls(rawChange);
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
		      const rawChange = JSON.parse(body);
		      const { log, deleteId } = await externalizeDataUrls(rawChange);
		      const operator = authenticatedOperator(req);
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
		        if (deleteId) {
		          requireModulePermissionForAuth(req, "daily", "delete");
		        } else {
		          const logId = String(log?.id ?? "").trim();
		          const exists = logId && logs.some((item) => String(item?.id ?? "") === logId);
		          requireModulePermissionForAuth(req, "daily", exists ? "update" : "create");
		        }
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
		          normalizedLog.operator = operator;
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
      const { product } = JSON.parse(body);
      const operator = authenticatedOperator(req);
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
	        const productExists = products.some((item) => String(item?.id ?? "") === String(product.id ?? ""));
	        requireModulePermissionForAuth(req, "products", productExists ? "update" : "create");

	        const normalizedProduct = await externalizeDataUrls({
          ...product,
          name: String(product.name).trim(),
          size: String(product.size).trim(),
          origin: String(product.origin).trim(),
          imageUrl: String(product.imageUrl ?? ""),
          notes: String(product.notes ?? "").trim(),
          defaultPrice: Number(product.defaultPrice),
          publicVisible: product.publicVisible !== false,
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

let autoOrderTransitionTimer = null;
let autoOrderTransitionRunning = false;

async function runAutomaticOrderTransitions(reason = "scheduled") {
  if (autoOrderTransitionRunning) return;
  autoOrderTransitionRunning = true;
  let client = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const current = normalizePickupShipmentsForState(rows[0]?.data ?? {});
    const result = applyAutomaticOrderTransitions(current);
    if (!result.changed) {
      await client.query("ROLLBACK");
      console.log(`[auto-orders] ${reason}: no changes`);
      return;
    }
    await client.query(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [stateId, JSON.stringify(result.state)]
    );
    await client.query("COMMIT");
    console.log(
      `[auto-orders] ${reason}: shipped=${result.summary.autoShippedCount}, delivered=${result.summary.autoDeliveredCount}, completed=${result.summary.autoCompletedCount}`
    );
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => undefined);
    console.error("[auto-orders] failed:", error);
  } finally {
    client?.release();
    autoOrderTransitionRunning = false;
  }
}

function scheduleAutomaticOrderTransitions() {
  const delay = msUntilNextChinaTime(4, 0);
  const nextRunAt = new Date(Date.now() + delay).toISOString();
  autoOrderTransitionTimer = setTimeout(async () => {
    await runAutomaticOrderTransitions("daily-04:00");
    scheduleAutomaticOrderTransitions();
  }, delay);
  autoOrderTransitionTimer.unref?.();
  console.log(`[auto-orders] next run at ${nextRunAt} (04:00 Asia/Shanghai)`);
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
  scheduleAutomaticOrderTransitions();
});
