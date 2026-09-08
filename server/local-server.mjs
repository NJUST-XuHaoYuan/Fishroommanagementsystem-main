import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { extname, join, normalize, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";
import pg from "pg";
import COS from "cos-nodejs-sdk-v5";
import {
  canFastRemuxWechatVideo,
  normalizeVideoTranscodePreset,
  selectWechatAudioStream,
} from "./video-upload-rules.mjs";
import { normalizeLegacyDouyinOrderRequest } from "./order-source-compat.mjs";
import {
  ORDER_SOURCE_VALUES,
  isPlatformOrderSource,
  isPlatformPaymentChannel,
  orderSourceLabel,
  platformOrderNoForOrder,
  platformOrderNoLabel,
  platformPaymentChannelForOrderSource,
} from "./order-source-rules.mjs";
import {
  DEFAULT_COMMISSION_RATE,
  calculateOrderCommission,
  calculateOrderFeeBreakdown,
  configuredOrderPackagingFee,
  normalizeCommissionRate,
  normalizeExternalOrderNo,
  normalizeShippingFeeMode,
  parseDouyinSettlementCsv,
} from "./finance-utils.mjs";
import {
  matchPaymentStatement,
  parsePaymentStatementCsv,
} from "./payment-statement-utils.mjs";
import {
  configuredPaymentMethod,
  isPaymentVerified,
  normalizePaymentChannel,
  paymentChannelLabel,
  paymentVerificationStatus,
  resolvePaymentMethodSnapshot,
  refundMethodForChannel,
  verifiedPaymentTotals,
} from "./payment-utils.mjs";
import {
  orderHasActuallyShipped,
  shipmentHasActuallyShipped,
} from "./order-refund-rules.mjs";
import {
  requiredShipMethodForOrderSource,
  shipmentHasPendingActualShippingFee,
  shipmentsHavePendingActualShippingFee,
} from "./shipment-rules.mjs";
import {
  ShipmentActualShippingFeeError,
  actualShippingFeeValuesDiffer,
  normalizeOutboundActualShippingFee,
  planActualShippingFeeUpdate,
  updateLockedAppState,
} from "./shipment-actual-shipping-fee-rules.mjs";
import { shipmentPaymentGate } from "./shipment-payment-rules.mjs";
import {
  ensureApprovalNotifications,
  ensureCreditSaleNotifications,
  ensurePersonnelProfileApprovalNotifications,
  markNotificationsRead,
  notificationsForRecipient,
  resolveApprovalNotifications,
  resolveCreditSaleNotifications,
  resolvePersonnelProfileApprovalNotifications,
} from "./station-notifications.mjs";
import {
  buildStockChangeSnapshot,
  classifyStockMutationForApproval,
  filterEffectiveStockMutation,
  preserveBatchCreationTimes,
  stockApprovalDetailsForResponse,
  stockApprovalReviewDetails,
  stockChangeAdjustmentSignature,
} from "./stock-approval-rules.mjs";
import {
  canApproveCreditSale,
  creditSaleEligibleApprovers,
  isCreditSaleOrderOwner,
} from "./credit-sale-approval-rules.mjs";
import {
  formatWaterQualityMeasurements,
  normalizeWaterQualityParameters,
  normalizeWaterQualityRecord,
  validateWaterQualityParameters,
  waterQualityParameterIdsForGroup,
} from "./water-quality-rules.mjs";
import { productDeleteDisposition } from "./product-delete-rules.mjs";
import { normalizeLocalDateTime } from "./local-datetime-utils.mjs";
import {
  normalizeDamageReplacementSelection,
  snapshotDamageReplacements,
} from "./shipment-damage-utils.mjs";
import {
  countsAsCompletionShipment,
  shipmentIsResolvedForCompletion,
} from "./shipment-completion-rules.mjs";
import {
  assertActiveShipmentInventoryAssignment,
  assertShipmentInventoryIdentityUnchanged,
  inventoryProjectionForStock,
  normalizeShipmentInventoryId,
  projectedShippedOutStockIds,
  shipmentPatchRequiresAssignmentValidation,
} from "./shipment-inventory-integrity.mjs";
import {
  buildDashboardFinanceSeries,
  buildDashboardFocusDetail,
  buildDashboardFocusOptions,
  buildDashboardLossSeries,
  buildDashboardSalespersonSeries,
  indexShipmentsByOrder,
} from "./dashboard-summary-aggregates.mjs";
import {
  healthyFishInventoryMetrics,
  isFishInventoryItem,
} from "./dashboard-healthy-fish-value.mjs";
import { buildBatchRevenueMetrics } from "./batch-revenue-metrics.mjs";
import { PUBLIC_SPECIMEN_HISTORY_SQL, publicSpecimenGroupKeys } from "./public-specimen-groups.mjs";
import { resolveAssistantSiteScope } from "./assistant-site-scope.mjs";
import {
  resolveShippingCarrier,
  validateShippingCarrierSettings,
} from "./shipping-carrier-utils.mjs";
import {
  orderMinimumReturnFloorTotal,
  sickMinimumReturnExemption,
} from "./order-pricing-rules.mjs";
import { isSupportedImageMime, validateImageUploadBuffer } from "./media-upload-rules.mjs";
import { createConcurrencyLimiter } from "./concurrency-limiter.mjs";
import { resolveCreateRecordId } from "./record-id-rules.mjs";
import {
  resolveUniqueOrderMutationTarget,
  resolveUniqueShipmentMutationTarget,
} from "./order-shipment-mutation-targets.mjs";
import { assertDailyLogSyncIdentity, planDailyLogSave } from "./daily-log-save-rules.mjs";
import {
  isSafePublicMediaMime,
  publicMediaCacheMaxAgeSeconds,
  publicMediaProxyPath,
  verifyPublicMediaUrlToken,
} from "./public-media-token.mjs";
import {
  VIDEO_DERIVATIVE_DIRECTORY,
  VIDEO_DERIVATIVE_KINDS,
  normalizeVideoDerivativeKind,
  publicVideoDerivativeProxyPath,
  verifyPublicVideoDerivativeToken,
  videoDerivativeCacheId,
  videoDerivativeFfmpegArgs,
  videoDerivativeRelativePath,
} from "./video-preview.mjs";
import {
  PUBLIC_CATALOG_MAJOR_CATEGORIES,
  describePublicCatalogPolicyChanges,
  migrateLegacyPublicCatalogVisibilityState,
  normalizePublicCatalogCategoryMajorMap,
  normalizePublicCatalogPolicy,
  prunePublicCatalogPolicyReferences,
  selectPublicCatalogStock,
  validatePublicCatalogPolicyWrite,
} from "./public-catalog-policy.mjs";
import {
  cosObjectDelivery,
  normalizeSingleByteRange,
  upstreamHeader,
} from "./media-range.mjs";
import {
  planGenericStatePatchReadKeys,
  planStateSliceDependencies,
} from "./state-slice-planner.mjs";
import {
  BioRecordConflictError,
  assertUniqueBioRecordIds,
  bioRecordRequiredActions,
  canAccessBioStockSite,
  findUniqueBioStockItem,
  maintenanceRequiredPermissions,
  planBioRecordSave,
} from "./bio-record-rules.mjs";
import { appendBioRecordsMutationSql } from "./bio-record-save-sql.mjs";
import {
  assertMaintenanceExpectedItems,
  findMaintenanceMutationLog,
  normalizeMaintenanceClientMutationId,
  prepareMaintenanceMutation,
  resolveMaintenanceDeltaByIds,
  withMaintenanceTransaction,
  withMaintenanceMutationMetadata,
} from "./maintenance-save-rules.mjs";
import {
  applyApprovedPersonnelSelfProfile,
  backfillOrderContactPersonnelIds,
  canViewPersonnelOperationLogs,
  hasPersonnelAccount,
  isPersonnelAccountEnabled,
  missingPersonnelRecordFields,
  normalizePersonnelGender,
  normalizePersonnelSensitiveFields,
  redactPersonnelForViewer,
  resolveActivePersonnelReference,
} from "./personnel-rules.mjs";
import {
  authoritativeStatePatchSiteId,
  assertStatePatchEntityScope,
  assertGenericStatePatchKeyAllowed,
  statePatchActionsForKey,
  statePatchEntityDiff,
  statePatchSiteBindingChanged,
  validateStatePatchShapes,
} from "./state-patch-permission-rules.mjs";
import {
  assertStockMutationExpectation,
  authoritativeStockMutationSiteId,
  buildStockMutationExpectation,
  validateStockMutationRelationships,
} from "./stock-mutation-relationships.mjs";
import {
  PERSONNEL_SENSITIVE_FIELDS,
  decryptPersonnelSensitiveFields,
  decryptPersonnelProfileProposalFields,
  encryptedPersonnelSensitiveValueKid,
  encryptPersonnelSensitiveFields,
  encryptPersonnelProfileProposalFields,
  parsePersonnelDataKeyring,
  rewrapPersonnelProfileProposalFields,
  rewrapPersonnelSensitiveFields,
} from "./personnel-sensitive-data.mjs";
import {
  PERSONNEL_PROFILE_ATTACHMENT_FIELDS,
  PERSONNEL_PROFILE_SENSITIVE_VALUE_FIELDS,
  PERSONNEL_SELF_PROFILE_FIELDS,
  assertPersonnelSelfProfileComplete,
  attachmentKindForPersonnelProfileField,
  changedPersonnelSelfProfileFields,
  isPersonnelProfileComplete,
  missingPersonnelProfileFields,
  normalizePersonnelSelfProfile,
  personnelProfileChangeDetails,
  personnelSelfProfileSnapshot,
  sanitizePersonnelAttachmentMetadata,
} from "./personnel-profile-rules.mjs";
import {
  PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY,
  assertPersonnelAttachmentReferenceAccess,
  decryptPersonnelAttachmentBuffer,
  encryptPersonnelAttachmentBuffer,
  isPersonnelPrivateAttachmentPath,
  normalizePersonnelAttachmentKind,
  personnelAttachmentCiphertextKid,
  privatePersonnelAttachmentPath,
  rewrapPersonnelAttachmentBuffer,
  sanitizeAttachmentFilename,
} from "./personnel-private-attachments.mjs";

const execFileAsync = promisify(execFile);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dataDir = join(root, ".data");
const legacyStateFile = join(dataDir, "fishroom-state.json");
const distDir = join(root, "dist");
const uploadDir = process.env.UPLOAD_DIR || join(root, "uploads");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || process.env.LOCAL_API_PORT || 8787);
const releaseRevision = String(process.env.RELEASE_REVISION || "development").trim();
const releaseBuiltAt = String(process.env.RELEASE_BUILT_AT || "").trim();
const stateId = "main";
const MAX_OPERATION_LOGS = 10000;
const STOCK_DUPLICATE_CONFIRMATION_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_FINANCE_DAYS = 30;
const MIN_FINANCE_DAYS = 7;
const MAX_FINANCE_DAYS = 730;
const MAX_IMAGE_UPLOAD_BYTES = numberFromEnv(process.env.MAX_IMAGE_UPLOAD_BYTES, 50 * 1024 * 1024);
const MAX_PERSONNEL_ATTACHMENT_BYTES = numberFromEnv(process.env.MAX_PERSONNEL_ATTACHMENT_BYTES, 15 * 1024 * 1024);
const PERSONNEL_ATTACHMENT_DRAFT_RETENTION_MS = numberFromEnv(
  process.env.PERSONNEL_ATTACHMENT_DRAFT_RETENTION_MS,
  30 * 24 * 60 * 60 * 1000
);
const PERSONNEL_ATTACHMENT_REJECTED_RETENTION_MS = numberFromEnv(
  process.env.PERSONNEL_ATTACHMENT_REJECTED_RETENTION_MS,
  30 * 24 * 60 * 60 * 1000
);
const MAX_VIDEO_UPLOAD_BYTES = numberFromEnv(process.env.MAX_VIDEO_UPLOAD_BYTES, 300 * 1024 * 1024);
const VIDEO_TRANSCODE_TIMEOUT_MS = numberFromEnv(process.env.VIDEO_TRANSCODE_TIMEOUT_MS, 5 * 60 * 1000);
const TRANSCODE_VIDEO_UPLOADS = process.env.TRANSCODE_VIDEO_UPLOADS !== "false";
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE_PATH = process.env.FFPROBE_PATH || "ffprobe";
const VIDEO_TRANSCODE_CONCURRENCY = Math.max(1, Math.floor(numberFromEnv(process.env.VIDEO_TRANSCODE_CONCURRENCY, 1)));
const VIDEO_TRANSCODE_MAX_PENDING = Math.max(0, Math.floor(numberFromEnv(process.env.VIDEO_TRANSCODE_MAX_PENDING, 2)));
const VIDEO_TRANSCODE_THREADS = Math.max(1, Math.floor(numberFromEnv(process.env.VIDEO_TRANSCODE_THREADS, 1)));
const VIDEO_TRANSCODE_MAX_EDGE = Math.max(720, Math.floor(numberFromEnv(process.env.VIDEO_TRANSCODE_MAX_EDGE, 1920)));
const VIDEO_TRANSCODE_PRESET = normalizeVideoTranscodePreset(process.env.VIDEO_TRANSCODE_PRESET);
const VIDEO_UPLOAD_CONCURRENCY = Math.max(1, Math.floor(numberFromEnv(process.env.VIDEO_UPLOAD_CONCURRENCY, 3)));
const VIDEO_UPLOAD_MAX_PENDING = Math.max(0, Math.floor(numberFromEnv(process.env.VIDEO_UPLOAD_MAX_PENDING, 6)));
const VIDEO_PREVIEW_CONCURRENCY = Math.max(1, Math.min(2, Math.floor(numberFromEnv(process.env.VIDEO_PREVIEW_CONCURRENCY, 1))));
const VIDEO_PREVIEW_MAX_PENDING = Math.max(0, Math.min(12, Math.floor(numberFromEnv(process.env.VIDEO_PREVIEW_MAX_PENDING, 4))));
const VIDEO_PREVIEW_TIMEOUT_MS = Math.min(
  3 * 60 * 1000,
  Math.max(30_000, Math.floor(numberFromEnv(process.env.VIDEO_PREVIEW_TIMEOUT_MS, 2 * 60 * 1000)))
);
const VIDEO_PREVIEW_DURATION_SECONDS = Math.min(4, Math.max(3, Math.floor(numberFromEnv(process.env.VIDEO_PREVIEW_DURATION_SECONDS, 4))));
const VIDEO_PREVIEW_MAX_EDGE = Math.min(480, Math.max(360, Math.floor(numberFromEnv(process.env.VIDEO_PREVIEW_MAX_EDGE, 480))));
const VIDEO_PREVIEW_FPS = Math.min(15, Math.max(12, Math.floor(numberFromEnv(process.env.VIDEO_PREVIEW_FPS, 12))));
const VIDEO_PREVIEW_BITRATE_KBPS = Math.min(600, Math.max(300, Math.floor(numberFromEnv(process.env.VIDEO_PREVIEW_BITRATE_KBPS, 450))));
const MAX_VIDEO_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_VIDEO_POSTER_BYTES = 1024 * 1024;
const VIDEO_DERIVATIVE_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const MAX_VIDEO_DERIVATIVE_FAILURES = 2_000;
const COS_REQUEST_TIMEOUT_MS = Math.min(
  120_000,
  Math.max(5_000, Math.floor(numberFromEnv(process.env.COS_REQUEST_TIMEOUT_MS, 30_000)))
);
const COS_UPLOAD_TIMEOUT_MS = Math.min(
  15 * 60 * 1000,
  Math.max(30_000, Math.floor(numberFromEnv(process.env.COS_UPLOAD_TIMEOUT_MS, 5 * 60 * 1000)))
);
const PUBLIC_MEDIA_LEASE_TIMEOUT_MS = COS_REQUEST_TIMEOUT_MS + 1_000;
const videoTranscodeLimiter = createConcurrencyLimiter({
  concurrency: VIDEO_TRANSCODE_CONCURRENCY,
  maxPending: VIDEO_TRANSCODE_MAX_PENDING,
  queueFullMessage: "已有多个视频正在处理，请稍后重试",
});
const videoUploadLimiter = createConcurrencyLimiter({
  concurrency: VIDEO_UPLOAD_CONCURRENCY,
  maxPending: VIDEO_UPLOAD_MAX_PENDING,
  queueFullMessage: "视频上传任务较多，请稍后重试",
});
const videoPreviewLimiter = createConcurrencyLimiter({
  concurrency: VIDEO_PREVIEW_CONCURRENCY,
  maxPending: VIDEO_PREVIEW_MAX_PENDING,
  queueFullMessage: "视频预览生成任务较多，请稍后重试",
});
const publicProjectionLimiter = createConcurrencyLimiter({
  concurrency: 2,
  maxPending: 16,
  queueFullMessage: "公开鱼单查询繁忙，请稍后重试",
});
const publicImageMediaLimiter = createConcurrencyLimiter({
  concurrency: 2,
  maxPending: 32,
  queueFullMessage: "公开图片加载繁忙，请稍后重试",
});
const publicVideoMediaLimiter = createConcurrencyLimiter({
  concurrency: 1,
  maxPending: 8,
  queueFullMessage: "公开视频加载繁忙，请稍后重试",
});
const PUBLIC_PROJECTION_CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_BIO_CACHE_MAX_ENTRIES = 2_000;
const publicCatalogCache = new Map();
const publicBioRecordsCache = new Map();
const videoDerivativeJobs = new Map();
const videoDerivativeFailures = new Map();
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
const configuredPersonnelDataKeyring = process.env.PERSONNEL_DATA_KEYRING_JSON || "";
if (process.env.NODE_ENV === "production" && !configuredPersonnelDataKeyring) {
  throw new Error("PERSONNEL_DATA_KEYRING_JSON must be set in production");
}
const personnelDataKeyring = parsePersonnelDataKeyring(configuredPersonnelDataKeyring);
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
  "finance",
  "accounts",
];
const PERMISSION_ACTIONS = ["create", "update", "delete"];
const STATE_PATCH_PERMISSION_MODULES = {
  systemSettings: "accounts",
  sites: "accounts",
  species: "species",
  speciesCategories: "accounts",
  speciesCategoryMajorMap: "accounts",
  publicCatalogPolicy: "accounts",
  products: "products",
  productOrigins: "products",
  tankGroups: "tankGroups",
  batches: "batches",
  stock: "stockIn",
  logs: "daily",
  waterQualityRecords: "daily",
  checks: "daily",
  bioRecords: "daily",
  lossRecords: "lossRecords",
  customers: "customers",
  customerSources: "customers",
  orders: "orders",
  shipments: "orders",
};
const STATE_PATCH_MODULE_LABELS = {
  systemSettings: "系统设置",
  sites: "场地管理",
  species: "物种管理",
  speciesCategories: "分类管理",
  speciesCategoryMajorMap: "分类管理",
  publicCatalogPolicy: "鱼单管理",
  products: "商品管理",
  productOrigins: "商品产地",
  tankGroups: "缸组管理",
  batches: "采购批次",
  stock: "库存明细",
  logs: "日常管理",
  waterQualityRecords: "水质记录",
  checks: "盘库管理",
  bioRecords: "生物记录",
  lossRecords: "损耗记录",
  customers: "客户管理",
  customerSources: "客户来源",
  orders: "订单管理",
  shipments: "发货管理",
};
const ADMIN_ONLY_STATE_PATCH_KEYS = new Set([
  "systemSettings",
  "sites",
  "speciesCategories",
  "speciesCategoryMajorMap",
  "publicCatalogPolicy",
]);
const PASSWORD_HASH_PREFIX = "scrypt$1$";
const cosConfig = {
  secretId: process.env.COS_SECRET_ID || "",
  secretKey: process.env.COS_SECRET_KEY || "",
  bucket: process.env.COS_BUCKET || "",
  region: process.env.COS_REGION || "",
  publicBaseUrl: String(process.env.COS_PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
  prefix: String(process.env.COS_PREFIX || "fishroom").replace(/^\/+|\/+$/g, ""),
};
let cosDownloadClient;
let cosUploadClient;

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
  "speciesCategoryMajorMap",
  "publicCatalogPolicy",
  "products",
  "productOrigins",
  "tankGroups",
  "batches",
  "stock",
  "lossRecords",
  "logs",
  "waterQualityRecords",
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
  res._logicalResponseBytes = payload.length;
  const startedAt = req?._requestStartedAt;
  const elapsedMs = typeof startedAt === "bigint"
    ? Number(process.hrtime.bigint() - startedAt) / 1_000_000
    : 0;
  const timingHeaders = elapsedMs > 0 ? {
    "Server-Timing": `app;dur=${elapsedMs.toFixed(1)}`,
    "X-Response-Bytes": String(payload.length),
  } : {};
  if (acceptsGzip(req) && payload.length > 1024) {
    res.writeHead(status, {
      ...jsonHeaders,
      ...timingHeaders,
      ...extraHeaders,
      "Content-Encoding": "gzip",
      "Vary": "Accept-Encoding",
    });
    const gzip = createGzip();
    gzip.pipe(res);
    gzip.end(payload);
    return;
  }

  res.writeHead(status, { ...jsonHeaders, ...timingHeaders, ...extraHeaders });
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
  return configuredIds;
}

function requireVisibleSiteForAuth(req, state = {}, siteId, message = "不能访问未授权场地的数据") {
  const normalized = String(siteId ?? "").trim();
  const siteMatches = (Array.isArray(state?.sites) ? state.sites : []).filter((site) =>
    String(site?.id ?? "").trim() === normalized
  );
  if (normalized && siteMatches.length === 1 &&
      visibleSiteIdsForAccount(req?.auth?.account, state).includes(normalized)) return normalized;
  const error = new Error(message);
  error.statusCode = 403;
  error.code = "SITE_FORBIDDEN";
  throw error;
}

// These helpers must only be called after the app_state row has been locked.
// They fail closed on duplicate IDs before applying the authoritative order
// site scope, so a visible duplicate can never authorize a hidden record.
function resolveAuthorizedLockedOrderTarget(req, state = {}, orderId) {
  const target = resolveUniqueOrderMutationTarget(state, orderId);
  requireVisibleSiteForAuth(req, state, target.siteId, "不能操作未授权场地的订单");
  return target;
}

function resolveAuthorizedLockedShipmentTarget(req, state = {}, shipmentId) {
  const target = resolveUniqueShipmentMutationTarget(state, shipmentId);
  requireVisibleSiteForAuth(req, state, target.siteId, "不能操作未授权场地的发货单");
  return target;
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

const trustedInventoryProjectionStates = new WeakSet();

function stateWithInventoryProjection(state = {}, stock = state?.stock, overrides = {}) {
  const next = {
    ...state,
    ...overrides,
    inventoryProjection: inventoryProjectionForStock(state, stock, {
      inheritProjection: trustedInventoryProjectionStates.has(state),
    }),
  };
  trustedInventoryProjectionStates.add(next);
  return next;
}

function siteFilteredState(state = {}, siteId = ALL_SITE_ID) {
  const scope = normalizeSiteScope(siteId);
  if (scope === ALL_SITE_ID) {
    return stateWithInventoryProjection(state);
  }
  const tankGroups = (Array.isArray(state.tankGroups) ? state.tankGroups : []).filter((item) => matchesSite(item, scope));
  const subTankIds = new Set(tankGroups.flatMap((group) =>
    (Array.isArray(group?.subTanks) ? group.subTanks : []).map((tank) => String(tank?.id ?? "")).filter(Boolean)
  ));
  const orders = (Array.isArray(state.orders) ? state.orders : []).filter((item) => matchesSite(item, scope));
  const orderIds = new Set(orders.map((order) => String(order?.id ?? "")).filter(Boolean));
  const stock = (Array.isArray(state.stock) ? state.stock : []).filter((item) => stockMatchesSite(state, item, scope));
  const stockIds = new Set(stock.map((item) => String(item?.id ?? "")).filter(Boolean));
  return stateWithInventoryProjection(state, stock, {
    tankGroups,
    batches: (Array.isArray(state.batches) ? state.batches : []).filter((item) => matchesSite(item, scope)),
    stock,
    logs: (Array.isArray(state.logs) ? state.logs : []).filter((item) =>
      matchesSite(item, scope) || subTankIds.has(String(item?.subTankId ?? ""))
    ),
    waterQualityRecords: (Array.isArray(state.waterQualityRecords) ? state.waterQualityRecords : []).filter((item) =>
      matchesSite(item, scope) || tankGroups.some((group) => String(group?.id ?? "") === String(item?.tankGroupId ?? ""))
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
  });
}

function siteVisibilityFilteredState(state = {}, account = {}) {
  if (!account || account.accessRole === "admin") {
    return stateWithInventoryProjection(state);
  }
  const visibleSiteIds = visibleSiteIdsForAccount(account, state);
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
  return stateWithInventoryProjection(state, stock, {
    tankGroups,
    batches: (Array.isArray(state.batches) ? state.batches : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds)
    ),
    stock,
    logs: (Array.isArray(state.logs) ? state.logs : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds) || subTankIds.has(String(item?.subTankId ?? ""))
    ),
    waterQualityRecords: (Array.isArray(state.waterQualityRecords) ? state.waterQualityRecords : []).filter((item) =>
      matchesAnyVisibleSite(item, visibleSiteIds) || tankGroups.some((group) => String(group?.id ?? "") === String(item?.tankGroupId ?? ""))
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
  });
}

function inventoryProjectionForResponse(state = {}, req = {}) {
  return siteVisibilityFilteredState(state, req?.auth?.account).inventoryProjection ?? {
    outStockIds: [],
    outDateByStockId: {},
  };
}

const GENERIC_PATCH_SITE_SCOPED_KEYS = new Set([
  "tankGroups",
  "batches",
  "stock",
  "lossRecords",
  "logs",
  "waterQualityRecords",
  "checks",
  "orders",
  "shipments",
]);

function genericPatchRecordSiteId(state = {}, key = "", record = {}) {
  const directSiteId = String(record?.siteId ?? "").trim();
  if (key === "tankGroups" || key === "batches" || key === "orders") {
    return authoritativeStatePatchSiteId(directSiteId, undefined);
  }
  if (key === "stock") {
    const subTankId = String(record?.subTankId ?? "").trim();
    const relationshipSites = subTankId
      ? (Array.isArray(state.tankGroups) ? state.tankGroups : []).flatMap((group) =>
          (Array.isArray(group?.subTanks) ? group.subTanks : [])
            .filter((tank) => String(tank?.id ?? "") === subTankId)
            .map(() => String(group?.siteId ?? "").trim())
        )
      : [];
    return authoritativeStatePatchSiteId(directSiteId, relationshipSites);
  }
  if (key === "shipments") {
    const orderId = String(record?.orderId ?? "").trim();
    const relationshipSites = orderId
      ? (Array.isArray(state.orders) ? state.orders : [])
          .filter((item) => String(item?.id ?? "") === orderId)
          .map((item) => String(item?.siteId ?? "").trim())
      : [];
    return authoritativeStatePatchSiteId(directSiteId, relationshipSites);
  }
  if (key === "lossRecords") {
    const stockItemId = String(record?.stockItemId ?? "").trim();
    const relationshipSites = stockItemId
      ? (Array.isArray(state.stock) ? state.stock : [])
          .filter((item) => String(item?.id ?? "") === stockItemId)
          .map((item) => genericPatchRecordSiteId(state, "stock", item))
      : [];
    return authoritativeStatePatchSiteId(directSiteId, relationshipSites);
  }
  if (key === "waterQualityRecords") {
    const tankGroupId = String(record?.tankGroupId ?? "").trim();
    const relationshipSites = tankGroupId
      ? (Array.isArray(state.tankGroups) ? state.tankGroups : [])
          .filter((item) => String(item?.id ?? "") === tankGroupId)
          .map((item) => String(item?.siteId ?? "").trim())
      : [];
    return authoritativeStatePatchSiteId(directSiteId, relationshipSites);
  }
  if (key === "logs" || key === "checks") {
    const groups = Array.isArray(state.tankGroups) ? state.tankGroups : [];
    const tankGroupId = String(record?.tankGroupId ?? "").trim();
    const subTankId = String(record?.subTankId ?? "").trim();
    if (key === "checks" && !subTankId) return "";
    const groupMatches = tankGroupId
      ? groups.filter((group) => String(group?.id ?? "") === tankGroupId)
      : [];
    const subTankMatches = subTankId
      ? groups.flatMap((group) =>
          (Array.isArray(group?.subTanks) ? group.subTanks : [])
            .filter((tank) => String(tank?.id ?? "") === subTankId)
            .map(() => group)
        )
      : [];
    let relationshipSites;
    if (tankGroupId && subTankId) {
      relationshipSites = groupMatches.length === 1 && subTankMatches.length === 1 && groupMatches[0] === subTankMatches[0]
        ? [String(groupMatches[0]?.siteId ?? "").trim()]
        : [];
    } else if (tankGroupId) {
      relationshipSites = groupMatches.map((group) => String(group?.siteId ?? "").trim());
    } else if (subTankId) {
      relationshipSites = subTankMatches.map((group) => String(group?.siteId ?? "").trim());
    }
    return authoritativeStatePatchSiteId(directSiteId, relationshipSites);
  }
  return authoritativeStatePatchSiteId(directSiteId, undefined);
}

function validateGenericStatePatchSiteScope(req, current = {}, next = {}, changedKeys = []) {
  const isAdmin = req?.auth?.account?.accessRole === "admin";
  const visibleSiteIds = isAdmin
    ? new Set()
    : new Set(visibleSiteIdsForAccount(req?.auth?.account, current).map(normalizeSiteId));
  for (const key of changedKeys) {
    if (!GENERIC_PATCH_SITE_SCOPED_KEYS.has(key)) continue;
    const diff = statePatchEntityDiff(
      Array.isArray(current[key]) ? current[key] : [],
      Array.isArray(next[key]) ? next[key] : [],
      key,
    );
    const nextById = new Map((Array.isArray(next[key]) ? next[key] : [])
      .map((record) => [String(record?.id ?? ""), record]));
    const recordSiteId = (record) => {
      const sourceState = nextById.get(String(record?.id ?? "")) === record ? next : current;
      return genericPatchRecordSiteId(sourceState, key, record);
    };
    const invalidRelationship =
      diff.created.some((record) => !recordSiteId(record)) ||
      diff.deleted.some((record) => !recordSiteId(record)) ||
      diff.updated.some(({ before, after }) => !recordSiteId(before) || !recordSiteId(after));
    if (invalidRelationship) {
      const error = new Error("场地记录的关联对象不存在、不唯一或与记录场地不一致");
      error.statusCode = 400;
      error.code = "STATE_PATCH_SITE_RELATION_INVALID";
      throw error;
    }
    if (diff.updated.some(({ before, after }) => statePatchSiteBindingChanged(key, before, after))) {
      const error = new Error("场地、缸位及关联对象不能通过通用状态补丁变更，请使用对应专用功能");
      error.statusCode = 400;
      error.code = "STATE_PATCH_SITE_BINDING_IMMUTABLE";
      throw error;
    }
    if (!isAdmin) {
      assertStatePatchEntityScope(diff, (record) => visibleSiteIds.has(normalizeSiteId(recordSiteId(record))));
    }
  }
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

function withoutLegacyProductVisibility(product) {
  if (!product || typeof product !== "object" || Array.isArray(product)) return product;
  const { publicVisible: _legacyPublicVisible, ...nextProduct } = product;
  return nextProduct;
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
  return projectedShippedOutStockIds({
    shipments: state.shipments,
    orders: state.orders,
    inventoryProjection: trustedInventoryProjectionStates.has(state) ? state.inventoryProjection : {},
  });
}

function isPhysicallyInTank(item, shippedIds) {
  return item && !item.lost && !shippedIds.has(normalizeShipmentInventoryId(item.id));
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
    ? publicMediaProxyPath(value, { secret: authTokenSecret })
    : value;
}

function publicCatalogMediaUrls(value, limit = 6) {
  return publicMediaUrls(value, limit).map(publicCatalogMediaUrl);
}

function videoDerivativeSourceDescriptor(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 4096 || raw.includes("\0")) return null;

  if (raw.startsWith("/uploads/")) {
    try {
      const parsed = new URL(raw, "http://fishroom.local");
      const canonicalUrl = parsed.pathname;
      const localPath = localUploadPathFromUrl(canonicalUrl);
      if (
        !localPath ||
        isPersonnelPrivateAttachmentPath(uploadDir, localPath) ||
        isVideoDerivativePath(uploadDir, localPath)
      ) return null;
      const relative = decodeURIComponent(canonicalUrl.replace(/^\/uploads\/?/, ""));
      if (
        relative === VIDEO_DERIVATIVE_DIRECTORY ||
        relative.startsWith(`${VIDEO_DERIVATIVE_DIRECTORY}/`)
      ) return null;
      if (!SUPPORTED_VIDEO_MIMES.has(mimeForExtension(extname(localPath)))) return null;
      return {
        type: "local",
        source: canonicalUrl,
        identity: `local:${relative}`,
        localPath,
      };
    } catch {
      return null;
    }
  }

  const cosKey = cosKeyFromUrl(raw);
  if (!cosKey || !SUPPORTED_VIDEO_MIMES.has(mimeForExtension(extname(cosKey)))) return null;
  return {
    type: "cos",
    source: objectUrlForKey(cosKey),
    identity: `cos:${cosKey}`,
    cosKey,
  };
}

function publicVideoDerivativeUrl(source, kind) {
  const descriptor = videoDerivativeSourceDescriptor(source);
  if (!descriptor) return "";
  try {
    return publicVideoDerivativeProxyPath(descriptor.source, kind, { secret: authTokenSecret });
  } catch {
    return "";
  }
}

function publicBioRecordText(value) {
  return clampText(String(value ?? "").replace(/[；。]?备注[:：].*$/u, ""), 220);
}

function publicBioRecordPayload(record = {}, media = {}) {
  const photos = media.photos ?? publicMediaUrls(record?.photos, 6);
  const videos = media.videos ?? publicMediaUrls(record?.videos, 3);
  // Keep these arrays index-aligned with `videos`: clients can use a tiny
  // preview/poster in list views while retaining the original for detail play.
  const videoPosters = videos.map((video) =>
    publicVideoDerivativeUrl(video, VIDEO_DERIVATIVE_KINDS.poster)
  );
  const videoPreviews = videos.map((video) =>
    publicVideoDerivativeUrl(video, VIDEO_DERIVATIVE_KINDS.preview)
  );
  return {
    id: String(record?.id ?? ""),
    stockItemId: String(record?.stockItemId ?? ""),
    date: String(record?.date ?? ""),
    text: publicBioRecordText(record?.text ?? ""),
    sourceType: String(record?.sourceType ?? ""),
    tankGroupName: String(record?.tankGroupName ?? ""),
    subTankName: String(record?.subTankName ?? ""),
    tankLocation: String(record?.tankLocation ?? ""),
    operator: String(record?.operator ?? ""),
    photoCount: photos.length,
    videoCount: videos.length,
    photos: photos.map(publicCatalogMediaUrl),
    videos: videos.map(publicCatalogMediaUrl),
    videoPosters,
    videoPreviews,
  };
}

function cachedPublicProjection(cache, key, revision, now = Date.now()) {
  const entry = cache.get(key);
  if (!entry || entry.revision !== String(revision ?? "") || entry.expiresAt <= now) {
    if (entry) cache.delete(key);
    return { hit: false, value: null };
  }
  // Refresh insertion order so the bounded map behaves as an LRU cache.
  cache.delete(key);
  cache.set(key, entry);
  return { hit: true, value: entry.value };
}

function storePublicProjection(cache, key, revision, value, maxEntries) {
  cache.delete(key);
  cache.set(key, {
    revision: String(revision ?? ""),
    expiresAt: Date.now() + PUBLIC_PROJECTION_CACHE_TTL_MS,
    value,
  });
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return value;
}

function publicCatalogProjectionFromRow(row = {}) {
  return {
    sites: Array.isArray(row.sites) ? row.sites : [],
    species: Array.isArray(row.species) ? row.species : [],
    speciesCategories: Array.isArray(row.species_categories) ? row.species_categories : [],
    speciesCategoryMajorMap: row.species_category_major_map && typeof row.species_category_major_map === "object"
      ? row.species_category_major_map
      : {},
    publicCatalogPolicy: normalizePublicCatalogPolicy(row.public_catalog_policy),
    products: Array.isArray(row.products) ? row.products : [],
    tankGroups: Array.isArray(row.tank_groups) ? row.tank_groups : [],
    stock: Array.isArray(row.stock) ? row.stock : [],
    orders: Array.isArray(row.orders) ? row.orders : [],
    shipments: Array.isArray(row.shipments) ? row.shipments : [],
    bioRecords: Array.isArray(row.bio_records) ? row.bio_records : [],
    specimenHistoryDigests: row.specimen_history_digests,
  };
}

function uniqueNonEmptyEntityIds(items = []) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id ?? "").trim();
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id));
}

function publicRecordDateSortValue(record = {}) {
  const text = String(record?.date ?? "").trim();
  const milliseconds = Date.parse(text);
  return { text, milliseconds: Number.isFinite(milliseconds) ? milliseconds : null };
}

function publicRecordIsLater(candidate = {}, current = {}) {
  const left = publicRecordDateSortValue(candidate);
  const right = publicRecordDateSortValue(current);
  if (left.milliseconds !== null && right.milliseconds !== null && left.milliseconds !== right.milliseconds) {
    return left.milliseconds > right.milliseconds;
  }
  if (left.milliseconds !== null && right.milliseconds === null) return true;
  if (left.milliseconds === null && right.milliseconds !== null) return false;
  return left.text.localeCompare(right.text) > 0;
}

function latestPublicMediaByStockId(records = [], allowedStockIds = new Set()) {
  const latest = new Map();
  const latestPhotos = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const stockItemId = String(record?.stockItemId ?? "").trim();
    if (!allowedStockIds.has(stockItemId)) continue;
    const photos = publicMediaUrls(record?.photos, 6);
    const videos = publicMediaUrls(record?.videos, 3);
    if (photos.length === 0 && videos.length === 0) continue;
    if (photos.length > 0) {
      const currentPhoto = latestPhotos.get(stockItemId);
      if (!currentPhoto || publicRecordIsLater(record, currentPhoto.record)) {
        latestPhotos.set(stockItemId, { record, photos });
      }
    }
    const current = latest.get(stockItemId);
    if (!current || publicRecordIsLater(record, current.record)) {
      latest.set(stockItemId, { record, photos, videos });
    }
  }
  // The catalog intentionally keeps one compact maintenance record per fish.
  // If the newest record is video-only, retain the newest real photo as its
  // static card fallback instead of forcing every list card to generate a
  // poster (or falling back to a generic product image).
  for (const [stockItemId, media] of latest) {
    if (media.photos.length > 0) continue;
    const photoMedia = latestPhotos.get(stockItemId);
    if (photoMedia) media.photos = photoMedia.photos;
  }
  return latest;
}

function buildGlobalPublicCatalogSelection(state = {}) {
  const normalizedState = normalizePickupShipmentsForState(state);
  const sourceStock = Array.isArray(normalizedState.stock) ? normalizedState.stock : [];
  const uniqueStockIds = uniqueNonEmptyEntityIds(sourceStock);
  const globalState = siteFilteredState({
    ...normalizedState,
    // A duplicated stock ID is ambiguous across sites. Exclude every copy from
    // the public catalog instead of letting array order choose one identity.
    stock: sourceStock.filter((item) => uniqueStockIds.has(String(item?.id ?? "").trim())),
  }, ALL_SITE_ID);
  const shippedIds = shippedOutStockIds(globalState);
  const activeOrderStockIds = orderActiveStockIds(globalState);
  const species = Array.isArray(globalState.species) ? globalState.species : [];
  const products = Array.isArray(globalState.products) ? globalState.products : [];
  const stock = Array.isArray(globalState.stock) ? globalState.stock : [];
  const bioRecords = Array.isArray(globalState.bioRecords) ? globalState.bioRecords : [];
  const knownProductIds = new Set(
    products
      .map((product) => String(product?.id ?? ""))
      .filter(Boolean)
  );
  const eligibleStock = stock.filter((item) =>
    !item?.sold &&
    item?.status !== "sick" &&
    !activeOrderStockIds.has(String(item?.id ?? "")) &&
    isPhysicallyInTank(item, shippedIds) &&
    knownProductIds.has(String(item?.productId ?? ""))
  );
  const eligibleStockIds = new Set(eligibleStock.map((item) => String(item?.id ?? "")).filter(Boolean));
  const latestMediaByStockId = latestPublicMediaByStockId(bioRecords, eligibleStockIds);
  const allSpeciesCategories = species
    .map((item) => String(item?.category ?? "").trim())
    .filter(Boolean);
  const completeCategoryMajorMap = normalizePublicCatalogCategoryMajorMap(
    allSpeciesCategories,
    globalState.speciesCategoryMajorMap
  );
  const selectedStock = selectPublicCatalogStock({
    stock: eligibleStock,
    products,
    species,
    speciesCategoryMajorMap: completeCategoryMajorMap,
    publicCatalogPolicy: globalState.publicCatalogPolicy,
    latestMediaAtByStockId: new Map(
      [...latestMediaByStockId].map(([stockItemId, media]) => [stockItemId, media.record?.date])
    ),
  });
  return {
    globalState,
    species,
    products,
    latestMediaByStockId,
    completeCategoryMajorMap,
    selectedStock,
  };
}

function buildPublicCatalog(state = {}, siteId = ALL_SITE_ID) {
  const selection = buildGlobalPublicCatalogSelection(state);
  const scopedState = siteFilteredState({
    ...selection.globalState,
    stock: selection.selectedStock,
  }, siteId);
  const species = selection.species;
  const products = selection.products;
  const latestMediaByStockId = selection.latestMediaByStockId;
  const completeCategoryMajorMap = selection.completeCategoryMajorMap;
  const sellableStock = Array.isArray(scopedState.stock) ? scopedState.stock : [];
  const specimenGroupKeys = publicSpecimenGroupKeys(
    sellableStock, state.specimenHistoryDigests, authTokenSecret
  );
  const sellableStockIds = new Set(sellableStock.map((item) => String(item?.id ?? "")).filter(Boolean));
  const sellableProductIds = new Set(sellableStock.map((item) => String(item?.productId ?? "")).filter(Boolean));
  const availableProducts = products.filter((product) =>
    sellableProductIds.has(String(product?.id ?? ""))
  );
  const productIds = new Set(availableProducts.map((product) => String(product?.id ?? "")).filter(Boolean));
  const speciesIds = new Set(availableProducts.map((product) => String(product?.speciesId ?? "")).filter(Boolean));
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
  const speciesCategoryMajorMap = normalizePublicCatalogCategoryMajorMap(
    speciesCategories,
    completeCategoryMajorMap
  );

  return {
    majorCategories: PUBLIC_CATALOG_MAJOR_CATEGORIES,
    speciesCategories,
    speciesCategoryMajorMap,
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
        notes: typeof item?.notes === "string" ? item.notes.trim() : "",
        specimenGroupKey: specimenGroupKeys.get(String(item?.id ?? "")) || "",
        status: item?.status === "feeding" ? "feeding" : "healthy",
        inDate: String(item?.inDate ?? ""),
        basePrice: Number(item?.basePrice ?? 0),
        tankGroupName: String(tank?.group?.name ?? ""),
        subTankName: String(tank?.subTank?.name ?? ""),
        tankLocation: String(tank?.group?.location ?? ""),
      };
    }),
    bioRecords: [...latestMediaByStockId]
      .filter(([stockItemId]) => sellableStockIds.has(stockItemId))
      .map(([, media]) => media)
      .sort((a, b) =>
        String(b?.record?.date ?? "").localeCompare(String(a?.record?.date ?? "")) ||
        String(a?.record?.id ?? "").localeCompare(String(b?.record?.id ?? ""))
      )
      .map((media) => publicBioRecordPayload(media.record, media)),
  };
}

function buildPublicBioRecordsForStock(state = {}, siteId = ALL_SITE_ID, stockItemId = "") {
  const selection = buildGlobalPublicCatalogSelection(state);
  const scopedState = siteFilteredState({
    ...selection.globalState,
    stock: selection.selectedStock,
  }, siteId);
  const targetId = String(stockItemId ?? "").trim();
  const selectedStockIds = new Set((Array.isArray(scopedState.stock) ? scopedState.stock : [])
    .map((item) => String(item?.id ?? "").trim())
    .filter(Boolean));
  if (!selectedStockIds.has(targetId)) return null;
  const records = Array.isArray(selection.globalState.bioRecords) ? selection.globalState.bioRecords : [];
  try {
    assertUniqueBioRecordIds(records.filter((record) => String(record?.stockItemId ?? "") === targetId));
  } catch (error) {
    if (error instanceof BioRecordConflictError) return null;
    throw error;
  }
  return records
    .filter((record) => String(record?.stockItemId ?? "") === targetId)
    .sort((a, b) =>
      String(a?.date ?? "").localeCompare(String(b?.date ?? "")) ||
      String(a?.id ?? "").localeCompare(String(b?.id ?? ""))
    )
    .map((record) => publicBioRecordPayload(record));
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
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
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

  const shippedDateByStockId = new Map(
    Object.entries(
      state?.inventoryProjection?.outDateByStockId && typeof state.inventoryProjection.outDateByStockId === "object"
        ? state.inventoryProjection.outDateByStockId
        : {}
    ).map(([id, date]) => [normalizeShipmentInventoryId(id), String(date ?? "").slice(0, 10)])
      .filter(([id, date]) => id && /^\d{4}-\d{2}-\d{2}$/.test(date))
  );
  for (const shipment of shipments) {
    if (!shipment || shipment.status === "preparing") continue;
    const date = String(shipment.outboundDate ?? shipment.shipDate ?? shipment.createdAt ?? "").slice(0, 10);
    if (!date) continue;
    for (const rawId of Array.isArray(shipment.itemStockIds) ? shipment.itemStockIds : []) {
      const stockId = normalizeShipmentInventoryId(rawId);
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

function isValidDashboardSalespersonOrder(order = {}) {
  // A damaged order remains attributable to its salesperson; the amount
  // helper already subtracts the damage refund/reship adjustment.
  return order?.status !== "cancelled";
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
  const personnel = Array.isArray(scopedState.personnel) ? scopedState.personnel : [];
  const customers = Array.isArray(scopedState.customers) ? scopedState.customers : [];
  const shipmentsByOrderId = indexShipmentsByOrder(shipments);
  const productById = new Map(products.map((product) => [product?.id, product]));
  const speciesById = new Map(species.map((item) => [item?.id, item]));
  const inTankFishStock = stock
    .filter((item) => isPhysicallyInTank(item, shippedIds))
    .filter((item) => {
      const product = productById.get(item?.productId);
      const itemSpecies = product ? speciesById.get(product.speciesId) : undefined;
      return isFishInventoryItem(product, itemSpecies);
    });
  const healthyFishInventory = healthyFishInventoryMetrics({
    stock,
    products,
    species,
    outStockIds: shippedIds,
  });
  const dailyDates = Array.from({ length: financeDays }, (_, index) =>
    addDaysToDateString(today, index - financeDays + 1)
  );
  const dailyFinanceData = buildDashboardFinanceSeries({
    dates: dailyDates,
    orders,
    shipments,
    shipmentsByOrderId,
    isPaymentVerified,
    amountForOrder: calcAmountDueForOrder,
    isPlatformOrderSource,
    isValidSalesOrder: isValidDashboardSalesOrder,
    isOfflinePickupOrder: isOfflinePickupDashboardOrder,
  });
  const dailyLossData = buildDashboardLossSeries({
    dates: dailyDates,
    stock,
    lossRecords: scopedState.lossRecords,
    shipments,
    batches: scopedState.batches,
    products,
    species,
    tankGroups,
    inventoryProjection: scopedState.inventoryProjection,
    isFishInventoryItem,
    normalizeInventoryId: normalizeShipmentInventoryId,
  });
  const salesperson = buildDashboardSalespersonSeries({
    dates: dailyDates,
    orders,
    shipmentsByOrderId,
    personnel,
    customers,
    amountForOrder: calcAmountDueForOrder,
    isPlatformOrderSource,
    isPersonnelResigned,
    isValidSalesOrder: isValidDashboardSalespersonOrder,
    platformOrderDisplayName: (order) => `${orderSourceLabel(order?.source) || "平台"}订单${platformOrderNoForOrder(order) ? ` ${platformOrderNoForOrder(order)}` : ""}`,
  });
  const focusOptions = buildDashboardFocusOptions({ species, products, stock, outStockIds: shippedIds });
  const defaultFocusOption = focusOptions.species[0] ?? focusOptions.product[0] ?? null;
  const defaultFocusMode = focusOptions.species[0] ? "species" : "product";
  const defaultFocus = defaultFocusOption
    ? buildDashboardFocusDetail({
        mode: defaultFocusMode,
        id: defaultFocusOption.id,
        today,
        species,
        products,
        stock,
        orders,
        outStockIds: shippedIds,
      })
    : null;
  const todayFinance = dailyFinanceData[dailyFinanceData.length - 1] ?? {
    received: 0,
    unshippedRefund: 0,
    shippedDamage: 0,
  };

  return {
    today,
    todayReceived: todayFinance.received,
    todayUnshippedRefund: todayFinance.unshippedRefund,
    todayShippedDamage: todayFinance.shippedDamage,
    todayRefunded: todayFinance.unshippedRefund,
    todayShippedOut: shipments
      .filter((shipment) => shipment?.shipDate === today && shipment?.status !== "preparing")
      .reduce((sum, shipment) => sum + (Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds.length : 0), 0),
    inFishStock: inTankFishStock.length,
    sick: inTankFishStock.filter((item) => item?.status === "sick").length,
    inTankSold: inTankFishStock.filter((item) => item?.sold).length,
    inTankSick: inTankFishStock.filter((item) => !item?.sold && item?.status === "sick").length,
    inTankNormal: inTankFishStock.filter((item) => !item?.sold && item?.status !== "sick").length,
    healthyFishStockValue: healthyFishInventory.value,
    healthyFishStockCount: healthyFishInventory.count,
    healthyFishUnpricedCount: healthyFishInventory.unpricedCount,
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
    dailySalespersonData: salesperson.dailySalespersonData,
    salespersonOptions: salesperson.salespersonOptions,
    focusOptions,
    defaultFocus,
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
  return Object.fromEntries(PERMISSION_MODULE_KEYS.map((module) => [
    module,
    Object.fromEntries(PERMISSION_ACTIONS.map((action) => [
      action,
      permissions?.[module]?.[action] === true,
    ])),
  ]));
}

function normalizeLegacyPermissionsForStorage(permissions) {
  const full = fullPermissionsValue();
  return Object.fromEntries(PERMISSION_MODULE_KEYS.map((module) => [
    module,
    Object.fromEntries(PERMISSION_ACTIONS.map((action) => [
      action,
      permissions?.[module]?.[action] ?? (module === "finance" ? false : full[module][action]),
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

function sessionVersionForAccount(account = {}) {
  const value = Number(account?.sessionVersion ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isDefaultCredential(username, password) {
  return DEFAULT_CREDENTIAL_DIGESTS.has(credentialDigest(username, password));
}

function publicUserFromAccount(account = {}, state = null) {
  if (!isPersonnelAccountEnabled(account)) return null;
  const username = String(account.username ?? "").trim();
  const role = account.accessRole === "admin" ? "admin" : "staff";
  if (!username) return null;
  if (role === "admin") return { username, role };
  const sites = state && Array.isArray(state.sites) ? getSitesFromState(state) : [];
  const visibleSiteIds = normalizeVisibleSiteIds(account.visibleSiteIds, sites);
  return visibleSiteIds.length > 0 ? { username, role, visibleSiteIds } : null;
}

function authAccountPermissionSummary(account = {}) {
  if (!isPersonnelAccountEnabled(account)) return null;
  const username = String(account.username ?? "").trim();
  if (!username) return null;
  const accessRole = account.accessRole === "admin" ? "admin" : "staff";
  const permissions = accessRole === "admin"
    ? fullPermissionsValue()
    : normalizePermissionsForStorage(account.permissions);
  if (accessRole !== "admin") permissions.accounts = emptyPermissionsValue().accounts;
  return {
    personnelId: String(account?.id ?? ""),
    username,
    accessRole,
    accountEnabled: true,
    permissions,
  };
}

function isPersonnelResigned(person = {}) {
  return person?.employmentStatus === "resigned" || Boolean(person?.resignedAt);
}

function sanitizePersonnelRecordForResponse(person = {}, req, options = {}) {
  if (!person || typeof person !== "object") return person;
  const username = String(person.username ?? "");
  const isAdmin = req?.auth?.account?.accessRole === "admin";
  const isCurrentUser = username && username === req?.auth?.user?.username;
  const { password, sessionVersion, ...safePerson } = person;
  safePerson.missingProfileFields = missingPersonnelRecordFields(person);
  safePerson.profileComplete = safePerson.missingProfileFields.length === 0;
  safePerson.accountEnabled = isPersonnelAccountEnabled(safePerson);
  if (safePerson.accessRole !== "admin" && safePerson.accessRole !== "staff") safePerson.accessRole = "staff";
  safePerson.visibleSiteIds = safePerson.accessRole === "admin"
    ? []
    : normalizeVisibleSiteIds(safePerson.visibleSiteIds, []);
  safePerson.employmentStatus = isPersonnelResigned(safePerson) ? "resigned" : "active";
  if (options.includePermissions || isAdmin || isCurrentUser) {
    safePerson.permissions = normalizePermissionsForStorage(safePerson.permissions);
  } else {
    delete safePerson.permissions;
  }
  return redactPersonnelForViewer(safePerson, {
    canViewPrivate: isAdmin || isCurrentUser,
    canViewAccount: isAdmin || isCurrentUser,
    // Identity and payroll fields are fetched one person at a time through the
    // audited administrator-only endpoint below. Never include them in lists.
    canViewSensitive: false,
  });
}

function sanitizePersonnelForResponse(personnel = [], req, options = {}) {
  return (Array.isArray(personnel) ? personnel : []).map((person) =>
    sanitizePersonnelRecordForResponse(person, req, options)
  );
}

function personnelSensitiveRevision(person = {}) {
  return createHash("sha256").update(JSON.stringify({
    personnelId: String(person?.id ?? ""),
    fields: PERSONNEL_SENSITIVE_FIELDS.map((field) => String(person?.[field] ?? "")),
    attachments: PERSONNEL_PROFILE_ATTACHMENT_FIELDS.map((field) =>
      publicPersonnelAttachmentMetadata(person?.[field])
    ),
  })).digest("hex");
}

function sanitizeStateForResponse(data = {}, req) {
  if (!data || typeof data !== "object") return data;
  const next = { ...siteVisibilityFilteredState(normalizePickupShipmentsForState(data), req?.auth?.account) };
  delete next.notifications;
  delete next.approvalRequests;
  delete next.personnelProfileRequests;
  delete next.personnelPrivateAttachments;
  delete next.retiredPersonnelUsernames;
  delete next.inventoryAdjustmentDrafts;
  delete next._personnelPrivateAttachmentEncryptionKid;
  if (!canViewPersonnelOperationLogs(req?.auth?.account)) delete next.operationLogs;
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

function createAuthToken(user, account = {}) {
  const expiresAt = Date.now() + AUTH_SESSION_TTL_MS;
  const payload = base64UrlJson({
    username: user.username,
    role: user.role,
    sessionVersion: sessionVersionForAccount(account),
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

function authenticatedOperatorName(req) {
  return String(req.auth?.account?.name ?? req.auth?.user?.username ?? "系统").trim() || "系统";
}

function sanitizeOperationLogsForAuth(logs = [], req) {
  const operator = authenticatedOperator(req);
  return (Array.isArray(logs) ? logs : []).map((log) =>
    log && typeof log === "object" ? { ...log, operator } : log
  );
}

function hasModulePermission(account = {}, module, action = "update") {
  if (!isPersonnelAccountEnabled(account)) return false;
  if (account?.accessRole === "admin") return true;
  if (module === "accounts") return false;
  if (!PERMISSION_MODULE_KEYS.includes(module) || !PERMISSION_ACTIONS.includes(action)) return false;
  return normalizePermissionsForStorage(account?.permissions)?.[module]?.[action] === true;
}

function requireModulePermissionForAuth(req, module, action = "update") {
  if (!hasModulePermission(req.auth?.account, module, action)) {
    throw new Error("当前账户没有执行该操作的权限");
  }
}

function requireFinanceAccessForAuth(req) {
  if (["create", "update", "delete"].some((action) =>
    hasModulePermission(req.auth?.account, "finance", action)
  )) return;
  throw new Error("当前账户没有财务模块权限");
}

function requireAdminForAuth(req, errorMessage = "仅管理员可以处理库存审批") {
  if (!isPersonnelAccountEnabled(req.auth?.account) || req.auth?.account?.accessRole !== "admin") {
    throw new Error(errorMessage);
  }
}

function validateStatePatchAuthorization(req, patch = {}) {
  for (const key of Object.keys(patch || {})) {
    if (!STATE_KEY_SET.has(key)) {
      throw new Error(`不支持的状态字段：${key}`);
    }
    assertGenericStatePatchKeyAllowed(key);
    if (key === "operationLogs") throw new Error("操作日志不能通过通用状态接口修改");
    if (ADMIN_ONLY_STATE_PATCH_KEYS.has(key)) {
      requireAdminForAuth(req, key === "speciesCategories" || key === "speciesCategoryMajorMap"
        ? "仅管理员可以修改商品分类"
        : "仅管理员可以修改系统配置");
      continue;
    }
  }
}

function validateStatePatchActions(req, current = {}, next = {}, patchedKeys = []) {
  for (const key of patchedKeys) {
    const actions = statePatchActionsForKey(key, current[key], next[key]);
    if (ADMIN_ONLY_STATE_PATCH_KEYS.has(key)) continue;
    const module = STATE_PATCH_PERMISSION_MODULES[key];
    if (!module) continue;
    for (const action of actions) {
      requireModulePermissionForAuth(req, module, action);
    }
  }
}

function statePatchOperationLogs(req, current = {}, next = {}, patchedKeys = []) {
  const actionLabels = { create: "添加记录", update: "修改记录", delete: "删除记录" };
  return patchedKeys.flatMap((key) => {
    const actions = statePatchActionsForKey(key, current[key], next[key]);
    if (actions.length === 0) return [];
    const moduleLabel = STATE_PATCH_MODULE_LABELS[key] ?? "系统数据";
    const detail = key === "publicCatalogPolicy"
      ? describePublicCatalogPolicyChanges(current[key], next[key], {
        products: next.products,
        species: next.species,
      })
      : `已通过服务端校验保存「${moduleLabel}」变更`;
    return [createOperationLog(
      req,
      moduleLabel,
      actions.map((action) => actionLabels[action]).join("、"),
      detail
    )];
  });
}

function normalizedPersonnelText(value, label, maxLength = 120) {
  const normalized = String(value ?? "").trim();
  if (normalized.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  return normalized;
}

function normalizedPersonnelDate(value, label, { allowFuture = true } = {}) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "";
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${label}格式不正确`);
  }
  if (!allowFuture && normalized > todayInChina()) throw new Error(`${label}不能晚于今天`);
  return normalized;
}

function nextPersonnelNo(personnel = []) {
  const used = new Set((Array.isArray(personnel) ? personnel : [])
    .map((person) => String(person?.personnelNo ?? "").trim()).filter(Boolean));
  let sequence = 1;
  while (used.has(`RY-${String(sequence).padStart(4, "0")}`)) sequence += 1;
  return `RY-${String(sequence).padStart(4, "0")}`;
}

function storedPersonnelSelfProfile(person = {}) {
  const sensitive = decryptPersonnelSensitiveFields(person, personnelDataKeyring);
  return personnelSelfProfileSnapshot({ ...person, ...sensitive });
}

function normalizePersonnelInput(input = {}, existing = null, state = {}) {
  const source = input && typeof input === "object" ? input : {};
  const id = String(source.id || existing?.id || uid("person"));
  const personnel = Array.isArray(state.personnel) ? state.personnel : [];
  const personnelNo = normalizedPersonnelText(
    source.personnelNo ?? existing?.personnelNo ?? nextPersonnelNo(personnel),
    "人员编号",
    32
  );
  // Once a personnel record exists, self-owned fields only change through the
  // approval workflow. The administrator save route remains responsible for
  // employment and account fields and cannot bypass that workflow.
  const selfProfile = existing
    ? storedPersonnelSelfProfile(existing)
    : {
        ...normalizePersonnelSelfProfile(source),
        idCardFrontAttachment: null,
        idCardBackAttachment: null,
        educationProofAttachment: null,
      };
  const name = normalizedPersonnelText(selfProfile.name, "人员姓名", 80);
  const requestedUsername = normalizedPersonnelText(source.username ?? existing?.username, "登录账号", 64);
  if (hasPersonnelAccount(existing) && !requestedUsername) throw new Error("已有登录账号不能删除，请改为停用账号");
  const username = requestedUsername;
  const hasAccount = Boolean(username);
  const resigned = isPersonnelResigned(existing);
  const accountEnabled = hasAccount && !resigned && (source.accountEnabled ?? existing?.accountEnabled ?? true) !== false;
  const accessRole = hasAccount && (source.accessRole ?? existing?.accessRole) === "admin" ? "admin" : "staff";
  const sites = getSitesFromState(state);
  const visibleSiteIds = accessRole === "admin"
    ? []
    : normalizeVisibleSiteIds(source.visibleSiteIds ?? existing?.visibleSiteIds, sites);
  const siteIds = normalizeVisibleSiteIds(source.siteIds ?? existing?.siteIds, sites);
  const department = normalizedPersonnelText(source.department ?? existing?.department, "部门", 80);
  const role = normalizedPersonnelText(source.role ?? existing?.role, "岗位", 80);
  const emergencyContact = normalizedPersonnelText(source.emergencyContact ?? existing?.emergencyContact, "紧急联系人", 80);
  const emergencyPhone = normalizedPersonnelText(source.emergencyPhone ?? existing?.emergencyPhone, "紧急联系电话", 32);
  const notes = normalizedPersonnelText(source.notes ?? existing?.notes, "备注", 500);
  const hireDate = normalizedPersonnelDate(source.hireDate ?? existing?.hireDate, "入职日期", { allowFuture: false });
  const normalizedSensitiveFields = normalizePersonnelSensitiveFields(selfProfile);
  const sensitiveFields = encryptPersonnelSensitiveFields(normalizedSensitiveFields, id, personnelDataKeyring);
  const plainPassword = String(source.password ?? "");
  if (!name) throw new Error("请填写人员姓名");
  if (!personnelNo) throw new Error("请填写人员编号");
  if (!department) throw new Error("请填写部门");
  if (!role) throw new Error("请填写职位 / 岗位");
  if (!hireDate) throw new Error("请填写入职日期");
  if (siteIds.length === 0) throw new Error("请至少选择一个所属工作区域");
  if (!resigned && !hasAccount) throw new Error("在职人员必须开通系统账号");
  if (plainPassword && !hasAccount) throw new Error("开通账号前请先填写登录账号");
  if (hasAccount && !String(existing?.password ?? "").trim() && !plainPassword) {
    throw new Error("首次开通账号或补全旧账号时必须设置登录密码");
  }
  if (accountEnabled && accessRole === "staff" && visibleSiteIds.length === 0) {
    throw new Error("启用普通账号时至少选择一个可见场地");
  }
  if (plainPassword && plainPassword.length < 6) throw new Error("登录密码至少 6 位");
  const sourcePermissions = source.permissions ?? existing?.permissions;
  const usernameChanged = Boolean(existing) && String(existing?.username ?? "") !== username;
  const securityStateChanged = Boolean(existing) && (
    Boolean(plainPassword) ||
    usernameChanged ||
    isPersonnelAccountEnabled(existing) !== accountEnabled ||
    existing?.accessRole !== accessRole
  );
  return {
    id,
    personnelNo,
    name,
    username,
    password: hasAccount ? (plainPassword ? hashPassword(plainPassword) : existing?.password) : undefined,
    sessionVersion: sessionVersionForAccount(existing) + (securityStateChanged ? 1 : 0),
    accountEnabled,
    accessRole,
    visibleSiteIds,
    employmentStatus: resigned ? "resigned" : "active",
    resignedAt: resigned ? existing?.resignedAt : undefined,
    permissions: !hasAccount
      ? emptyPermissionsValue()
      : accessRole === "admin"
      ? fullPermissionsValue()
      : sourcePermissions
      ? normalizePermissionsForStorage(sourcePermissions)
      : emptyPermissionsValue(),
    gender: selfProfile.gender,
    nativePlace: selfProfile.nativePlace,
    birthMonth: selfProfile.birthMonth,
    educationLevel: selfProfile.educationLevel,
    department,
    role,
    hireDate,
    siteIds,
    phone: selfProfile.phone,
    email: selfProfile.email,
    wechat: selfProfile.wechat,
    address: selfProfile.address,
    emergencyContact,
    emergencyPhone,
    ...sensitiveFields,
    idCardFrontAttachment: selfProfile.idCardFrontAttachment,
    idCardBackAttachment: selfProfile.idCardBackAttachment,
    educationProofAttachment: selfProfile.educationProofAttachment,
    profileRevision: Number.isSafeInteger(existing?.profileRevision) && existing.profileRevision >= 0
      ? existing.profileRevision
      : 0,
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
      isPersonnelAccountEnabled(person)
    )
    .length;
}

function activeAdminRecipients(state = {}) {
  return (Array.isArray(state.personnel) ? state.personnel : [])
    .filter((person) =>
      person?.accessRole === "admin" &&
      isPersonnelAccountEnabled(person)
    )
    .map((person) => ({
      username: String(person.username).trim(),
      name: String(person.name ?? person.username).trim(),
    }));
}

function personnelHasBusinessHistory(state = {}, person = {}) {
  const references = new Set([
    String(person?.id ?? "").trim(),
    String(person?.name ?? "").trim(),
    String(person?.username ?? "").trim(),
  ].filter(Boolean));
  const matches = (value) => references.has(String(value ?? "").trim());
  const collections = [
    [state.orders, ["contactPersonnelId", "contactPerson"]],
    [state.logs, ["personnelId", "operator"]],
    [state.waterQualityRecords, ["personnelId", "operator"]],
    [state.checks, ["personnelId", "operator"]],
    [state.lossRecords, ["personnelId", "operator"]],
    [state.bioRecords, ["personnelId", "operator"]],
    [state.inventoryAdjustmentDrafts, ["personnelId", "createdBy", "createdByName"]],
    [state.personnelProfileRequests, ["personnelId", "requesterUsername"]],
    [state.operationLogs, ["personnelId", "operator"]],
  ];
  return collections.some(([items, fields]) =>
    (Array.isArray(items) ? items : []).some((item) => fields.some((field) => matches(item?.[field])))
  );
}

function normalizeOrderContactPersonnel(state = {}, body = {}, currentOrder = null) {
  const personnelId = String(body.contactPersonnelId ?? currentOrder?.contactPersonnelId ?? "").trim();
  const reference = String(body.contactPerson ?? currentOrder?.contactPerson ?? "").trim();
  const resolved = resolveActivePersonnelReference(state.personnel, { personnelId, reference });
  if (resolved.status === "matched" && resolved.person) {
    return {
      contactPersonnelId: String(resolved.person.id ?? "").trim(),
      contactPerson: String(resolved.person.name ?? "").trim(),
    };
  }

  const historicalId = String(currentOrder?.contactPersonnelId ?? "").trim();
  const historicalReference = String(currentOrder?.contactPerson ?? "").trim();
  const unchangedHistoricalReference = Boolean(currentOrder) &&
    personnelId === historicalId && reference === historicalReference;
  if (unchangedHistoricalReference) {
    return {
      ...(historicalId ? { contactPersonnelId: historicalId } : {}),
      contactPerson: historicalReference,
    };
  }

  if (resolved.status === "ambiguous") throw new Error("订单负责人存在重名，请重新选择具体人员");
  if (resolved.status === "invalid-id") throw new Error("订单负责人不存在、已离职或人员 ID 已失效");
  if (resolved.status === "not-found") throw new Error("订单负责人必须是在职人员");
  throw new Error("请选择订单负责人");
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

function activePersonnelForReference(state = {}, value = "") {
  const reference = String(value ?? "").trim();
  if (!reference) return null;
  return (Array.isArray(state.personnel) ? state.personnel : []).find((person) =>
    !isPersonnelResigned(person) &&
    (String(person?.name ?? "").trim() === reference || String(person?.username ?? "").trim() === reference)
  ) ?? null;
}

function currentStationNotifications(state = {}) {
  return Array.isArray(state.notifications) ? state.notifications : [];
}

function currentPersonnelProfileRequests(state = {}) {
  return Array.isArray(state.personnelProfileRequests) ? state.personnelProfileRequests : [];
}

function currentPersonnelPrivateAttachments(state = {}) {
  return Array.isArray(state.personnelPrivateAttachments) ? state.personnelPrivateAttachments : [];
}

function personnelAttachmentExpiry(reference = {}, nowMs = Date.now()) {
  const status = String(reference?.status ?? "");
  if (!["draft", "rejected"].includes(status)) return "";
  const existing = Date.parse(String(reference?.expiresAt ?? ""));
  if (Number.isFinite(existing)) return new Date(existing).toISOString();
  const base = Date.parse(String(reference?.updatedAt ?? reference?.createdAt ?? ""));
  const retentionMs = status === "rejected"
    ? PERSONNEL_ATTACHMENT_REJECTED_RETENTION_MS
    : PERSONNEL_ATTACHMENT_DRAFT_RETENTION_MS;
  return new Date((Number.isFinite(base) ? base : nowMs) + retentionMs).toISOString();
}

function normalizePersonnelAttachmentLifecycle(reference = {}, now = new Date()) {
  const nowMs = now.getTime();
  const status = String(reference?.status ?? "");
  if (!["draft", "rejected"].includes(status)) return reference;
  const expiresAt = personnelAttachmentExpiry(reference, nowMs);
  if (Date.parse(expiresAt) <= nowMs) {
    return {
      ...reference,
      status: "expired",
      expiresAt,
      expiredAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
  }
  return String(reference?.expiresAt ?? "") === expiresAt
    ? reference
    : { ...reference, expiresAt };
}

function retireReplaceablePersonnelAttachmentDrafts(
  references = [],
  { personnelId = "", kind = "", replacementId = "", now = new Date() } = {}
) {
  return (Array.isArray(references) ? references : []).map((rawReference) => {
    const reference = normalizePersonnelAttachmentLifecycle(rawReference, now);
    if (String(reference?.personnelId ?? "") !== String(personnelId) ||
        String(reference?.kind ?? "") !== String(kind) ||
        String(reference?.id ?? "") === String(replacementId) ||
        !["draft", "rejected"].includes(String(reference?.status ?? "")) ||
        String(reference?.profileRequestId ?? "") && reference.status === "pending") {
      return reference;
    }
    return {
      ...reference,
      status: "superseded",
      supersededAt: now.toISOString(),
      replacedByAttachmentId: String(replacementId ?? ""),
      updatedAt: now.toISOString(),
    };
  });
}

function terminalPersonnelAttachmentIds(before = [], after = []) {
  const beforeById = new Map((Array.isArray(before) ? before : [])
    .map((reference) => [String(reference?.id ?? ""), String(reference?.status ?? "")])
    .filter(([id]) => id));
  const terminal = new Set(["expired", "retired", "superseded", "orphaned"]);
  return (Array.isArray(after) ? after : [])
    .filter((reference) => terminal.has(String(reference?.status ?? "")) &&
      !terminal.has(beforeById.get(String(reference?.id ?? ""))))
    .map((reference) => String(reference?.id ?? ""))
    .filter(Boolean);
}

async function removePersonnelAttachmentFiles(attachmentIds = []) {
  await Promise.all([...new Set(attachmentIds.map((id) => String(id ?? "")).filter(Boolean))]
    .map((attachmentId) => rm(privatePersonnelAttachmentPath(uploadDir, attachmentId), { force: true })
      .catch((error) => console.warn(`Failed to delete retired personnel attachment ${attachmentId}: ${error.message}`))));
}

function profileRevisionForPersonnel(person = {}) {
  const value = Number(person?.profileRevision ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function activeAdministratorRecipients(personnel = []) {
  return (Array.isArray(personnel) ? personnel : [])
    .filter((person) => person?.accessRole === "admin" && isPersonnelAccountEnabled(person))
    .map((person) => ({
      personnelId: String(person?.id ?? ""),
      username: String(person?.username ?? "").trim(),
      name: String(person?.name ?? person?.username ?? "").trim(),
    }))
    .filter((person) => person.personnelId && person.username);
}

function ensurePendingPersonnelProfileApprovalFanout(
  notifications = [],
  requests = [],
  personnel = []
) {
  let nextNotifications = Array.isArray(notifications) ? notifications : [];
  const activeAdministrators = activeAdministratorRecipients(personnel);
  for (const request of Array.isArray(requests) ? requests : []) {
    if (request?.status !== "pending") continue;
    const subjectId = String(request?.personnelId ?? "");
    const subject = (Array.isArray(personnel) ? personnel : [])
      .find((person) => String(person?.id ?? "") === subjectId);
    const otherAdministrators = activeAdministrators
      .filter((recipient) => recipient.personnelId !== subjectId);
    const selfAdministrator = activeAdministrators
      .filter((recipient) => recipient.personnelId === subjectId);
    const recipients = otherAdministrators.length > 0
      ? otherAdministrators
      : selfAdministrator;
    if (recipients.length === 0) continue;
    const ensured = ensurePersonnelProfileApprovalNotifications(nextNotifications, {
      profileRequestId: String(request?.id ?? ""),
      notificationIds: recipients.map(() => uid("notice")),
      requesterNotificationId: uid("notice"),
      recipients,
      requester: {
        username: String(subject?.username ?? request?.requesterUsername ?? ""),
        name: String(subject?.name ?? request?.requesterName ?? ""),
      },
      createdAt: String(request?.createdAt ?? new Date().toISOString()),
      createdBy: String(request?.requesterUsername ?? subject?.username ?? ""),
      createdByName: String(request?.requesterName ?? subject?.name ?? ""),
      changedFieldCount: Array.isArray(request?.changedFields) ? request.changedFields.length : 0,
    });
    nextNotifications = ensured.notifications;
  }
  return nextNotifications;
}

function personnelForAuthenticatedAccount(state = {}, req) {
  const personnelId = String(req?.auth?.account?.id ?? "").trim();
  if (!personnelId) throw new Error("当前系统账号未绑定人员档案");
  const person = (Array.isArray(state.personnel) ? state.personnel : [])
    .find((item) => String(item?.id ?? "") === personnelId);
  if (!person || !isPersonnelAccountEnabled(person)) throw new Error("当前人员档案不存在、已离职或账号已停用");
  return person;
}

function publicPersonnelAttachmentMetadata(reference) {
  if (!reference) return null;
  return sanitizePersonnelAttachmentMetadata(reference, reference?.kind);
}

function personnelProfileRequestSummary(request = {}) {
  if (!request || typeof request !== "object") return null;
  return {
    id: String(request.id ?? ""),
    status: String(request.status ?? ""),
    changedFields: Array.isArray(request.changedFields) ? [...request.changedFields] : [],
    createdAt: String(request.createdAt ?? ""),
    resolvedAt: String(request.resolvedAt ?? ""),
    resolvedBy: String(request.resolvedBy ?? ""),
    resolutionNote: String(request.resolutionNote ?? ""),
    baseProfileRevision: Number(request.baseProfileRevision ?? 0),
  };
}

function findPersonnelAttachmentReference(state = {}, attachmentId = "") {
  const id = String(attachmentId ?? "").trim();
  if (!id) return null;
  return currentPersonnelPrivateAttachments(state)
    .find((reference) => String(reference?.id ?? "") === id) ?? null;
}

function resolveSelfProfileAttachment(state = {}, person = {}, field, suppliedValue) {
  const expectedKind = attachmentKindForPersonnelProfileField(field);
  const attachmentId = String(suppliedValue?.id ?? "").trim();
  if (!attachmentId) return null;
  const storedReference = findPersonnelAttachmentReference(state, attachmentId);
  if (!storedReference) throw new Error("人员资料附件不存在或已失效，请重新上传");
  const reference = normalizePersonnelAttachmentLifecycle(storedReference);
  if (String(reference.personnelId ?? "") !== String(person.id ?? "") || reference.kind !== expectedKind) {
    throw new Error("人员资料附件不属于当前人员或类型不匹配");
  }
  const currentAttachmentId = String(person?.[field]?.id ?? "");
  const isCurrentApprovedAttachment = reference.status === "approved" && attachmentId === currentAttachmentId;
  const isOwnedDraft = ["draft", "rejected"].includes(reference.status) &&
    String(reference.uploadedByPersonnelId ?? "") === String(person.id ?? "");
  if (!isCurrentApprovedAttachment && !isOwnedDraft) {
    throw new Error("人员资料附件当前不可用于新的资料申请");
  }
  return publicPersonnelAttachmentMetadata(reference);
}

function normalizeSubmittedSelfProfile(state = {}, person = {}, input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const allowed = new Set(PERSONNEL_SELF_PROFILE_FIELDS);
  const unsupported = Object.keys(source).filter((field) => !allowed.has(field));
  if (unsupported.length > 0) throw new Error(`本人资料申请包含不允许修改的字段：${unsupported.join("、")}`);
  const withCanonicalAttachments = { ...source };
  for (const field of PERSONNEL_PROFILE_ATTACHMENT_FIELDS) {
    withCanonicalAttachments[field] = resolveSelfProfileAttachment(state, person, field, source[field]);
  }
  const normalized = normalizePersonnelSelfProfile(withCanonicalAttachments, { requireComplete: true });
  // Keep the existing dedicated validators as a second, shared boundary for
  // identity and payroll values used by administrator saves.
  Object.assign(normalized, normalizePersonnelSensitiveFields(normalized));
  assertPersonnelSelfProfileComplete(normalized);
  return normalized;
}

function updateProfileAttachmentRequestStatuses(
  references = [],
  profile = {},
  requestId = "",
  status = "pending",
  now = new Date()
) {
  const ids = new Set(PERSONNEL_PROFILE_ATTACHMENT_FIELDS
    .map((field) => String(profile?.[field]?.id ?? ""))
    .filter(Boolean));
  return (Array.isArray(references) ? references : []).map((rawReference) => {
    const reference = normalizePersonnelAttachmentLifecycle(rawReference, now);
    if (!ids.has(String(reference?.id ?? ""))) return reference;
    if (status === "pending" && reference?.status === "approved") return reference;
    if (status !== "pending" && String(reference?.profileRequestId ?? "") !== String(requestId ?? "")) return reference;
    const { expiresAt: _expiresAt, expiredAt: _expiredAt, ...retained } = reference;
    return {
      ...retained,
      status,
      profileRequestId: String(requestId ?? ""),
      ...(status === "rejected" ? {
        expiresAt: new Date(now.getTime() + PERSONNEL_ATTACHMENT_REJECTED_RETENTION_MS).toISOString(),
      } : {}),
      updatedAt: now.toISOString(),
    };
  });
}

function finalizeApprovedProfileAttachments(
  references = [],
  beforeProfile = {},
  afterProfile = {},
  requestId = "",
  now = new Date()
) {
  const approved = updateProfileAttachmentRequestStatuses(references, afterProfile, requestId, "approved", now);
  const replacements = new Map(PERSONNEL_PROFILE_ATTACHMENT_FIELDS.flatMap((field) => {
    const beforeId = String(beforeProfile?.[field]?.id ?? "");
    const afterId = String(afterProfile?.[field]?.id ?? "");
    return beforeId && beforeId !== afterId ? [[beforeId, afterId]] : [];
  }));
  return approved.map((reference) => {
    const replacementId = replacements.get(String(reference?.id ?? ""));
    if (!replacementId || reference?.status !== "approved") return reference;
    return {
      ...reference,
      status: "superseded",
      supersededAt: now.toISOString(),
      replacedByAttachmentId: replacementId,
      updatedAt: now.toISOString(),
    };
  });
}

function selfProfileResponseForPersonnel(state = {}, person = {}) {
  const profile = storedPersonnelSelfProfile(person);
  const pending = currentPersonnelProfileRequests(state)
    .filter((request) => request?.status === "pending" && String(request?.personnelId ?? "") === String(person?.id ?? ""))
    .sort((left, right) => String(right?.createdAt ?? "").localeCompare(String(left?.createdAt ?? "")))[0] ?? null;
  const latest = currentPersonnelProfileRequests(state)
    .filter((request) => String(request?.personnelId ?? "") === String(person?.id ?? ""))
    .sort((left, right) => String(right?.createdAt ?? "").localeCompare(String(left?.createdAt ?? "")))[0] ?? null;
  const editableRequest = pending ?? (!pending && latest?.status === "rejected" ? latest : null);
  const draftProfile = editableRequest
    ? decryptPersonnelProfileProposalFields(editableRequest.proposedProfile, person.id, personnelDataKeyring)
    : null;
  const fullRecordForCompleteness = { ...person, ...profile };
  const missingProfileFields = missingPersonnelRecordFields(fullRecordForCompleteness);
  const employment = {
    department: String(person?.department ?? ""),
    role: String(person?.role ?? ""),
    hireDate: String(person?.hireDate ?? ""),
    siteIds: Array.isArray(person?.siteIds) ? [...person.siteIds] : [],
  };
  const account = {
    personnelId: String(person?.id ?? ""),
    username: String(person?.username ?? ""),
    accountEnabled: isPersonnelAccountEnabled(person),
    accessRole: person?.accessRole === "admin" ? "admin" : "staff",
  };
  const profileComplete = missingProfileFields.length === 0;
  return {
    profile: {
      ...profile,
      personnelNo: String(person?.personnelNo ?? ""),
      employment,
      account,
      profileRevision: profileRevisionForPersonnel(person),
      profileComplete,
      missingFields: missingProfileFields,
      missingProfileFields,
    },
    employment,
    account,
    profileRevision: profileRevisionForPersonnel(person),
    profileComplete,
    missingProfileFields,
    missingSelfProfileFields: missingPersonnelProfileFields(profile),
    pendingRequest: personnelProfileRequestSummary(pending),
    latestRequest: personnelProfileRequestSummary(latest),
    draftProfile,
  };
}

const STATION_NOTIFICATION_LIST_FIELDS = Object.freeze([
  "id", "type", "status", "resolution", "title", "message", "createdAt", "createdBy", "createdByName",
  "updatedAt", "readAt", "recipientUsername", "recipientName", "orderId", "orderNo", "siteId",
  "requiredOutstandingAmount", "creditSaleRequestId", "approvalRequestId", "approvalAction", "notificationRole",
  "profileRequestId", "resolvedAt", "resolvedBy", "resolvedByName", "resolutionNote",
]);

function stationNotificationListRecord(notification = {}) {
  return Object.fromEntries(STATION_NOTIFICATION_LIST_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(notification, field))
    .map((field) => [field, notification[field]]));
}

const stationNotificationStateProjection = `jsonb_build_object(
  'notifications', COALESCE(data->'notifications', '[]'::jsonb),
  'approvalRequests', COALESCE(data->'approvalRequests', '[]'::jsonb),
  'personnelProfileRequests', COALESCE(data->'personnelProfileRequests', '[]'::jsonb),
  'orders', COALESCE(data->'orders', '[]'::jsonb),
  'personnel', COALESCE(data->'personnel', '[]'::jsonb),
  'sites', COALESCE(data->'sites', '[]'::jsonb)
)`;

async function readStationNotificationState(queryable = pool, { forUpdate = false } = {}) {
  const lockClause = forUpdate ? " FOR UPDATE" : "";
  const { rows } = await queryable.query(
    `SELECT ${stationNotificationStateProjection} AS data FROM app_state WHERE id = $1${lockClause}`,
    [stateId]
  );
  return rows[0]?.data ?? {};
}

function visibleOrdersForNotificationAuth(state = {}, account = {}) {
  const orders = Array.isArray(state.orders) ? state.orders : [];
  if (!account || account.accessRole === "admin") return orders;
  const sites = getSitesFromState(state);
  const visibleSiteIds = visibleSiteIdsForAccount(account, state);
  if (visibleSiteIds.length >= sites.length) return orders;
  return orders.filter((order) => matchesAnyVisibleSite(order, visibleSiteIds));
}

function stationNotificationForAuth(state = {}, req, notification = {}, options = {}) {
  const safeNotification = stationNotificationListRecord(notification);
  const includeStockDetails = options.includeStockDetails === true;
  if (notification?.type === "credit_sale_confirmation") {
    const ordersById = options.ordersById instanceof Map
      ? options.ordersById
      : new Map(visibleOrdersForNotificationAuth(state, req.auth?.account)
        .map((item) => [String(item?.id ?? ""), item]));
    const order = ordersById.get(String(notification?.orderId ?? ""));
    return {
      ...safeNotification,
      canApprove: notification?.status === "pending" &&
        Boolean(order) &&
        canApproveCreditSale(state.personnel, order, String(req.auth?.user?.username ?? "")),
    };
  }
  if (notification?.type === "stock_approval") {
    const approvalRequestsById = options.approvalRequestsById instanceof Map
      ? options.approvalRequestsById
      : new Map(currentApprovalRequests(state)
        .map((request) => [String(request?.id ?? ""), request])
        .filter(([id]) => id));
    const approvalRequest = approvalRequestsById.get(String(notification?.approvalRequestId ?? ""));
    return {
      ...safeNotification,
      canApprove: notification?.notificationRole !== "requester" &&
        notification?.status === "pending" &&
        approvalRequest?.status === "pending" &&
        req.auth?.account?.accessRole === "admin",
      ...(includeStockDetails ? { stockDetails: stockApprovalDetailsForRequest(state, approvalRequest) } : {}),
    };
  }
  if (notification?.type === "personnel_profile_approval") {
    const profileRequestsById = options.profileRequestsById instanceof Map
      ? options.profileRequestsById
      : new Map(currentPersonnelProfileRequests(state)
        .map((request) => [String(request?.id ?? ""), request])
        .filter(([id]) => id));
    const profileRequest = profileRequestsById.get(String(notification?.profileRequestId ?? ""));
    const requesterIsSubject = String(req.auth?.account?.id ?? "") &&
      String(req.auth?.account?.id ?? "") === String(profileRequest?.personnelId ?? "");
    const otherActiveAdministrators = requesterIsSubject
      ? activeAdministratorRecipients(state.personnel)
        .filter((recipient) => recipient.personnelId !== String(profileRequest?.personnelId ?? ""))
      : [];
    const soleAdministratorSelfReview = requesterIsSubject &&
      otherActiveAdministrators.length === 0 &&
      activeAdministratorRecipients(state.personnel)
        .some((recipient) => recipient.personnelId === String(profileRequest?.personnelId ?? ""));
    const canApprove = (notification?.notificationRole === "approver" ||
        (notification?.notificationRole === "requester" && soleAdministratorSelfReview)) &&
      notification?.status === "pending" &&
      profileRequest?.status === "pending" &&
      req.auth?.account?.accessRole === "admin" &&
      isPersonnelAccountEnabled(req.auth?.account) &&
      (!requesterIsSubject || otherActiveAdministrators.length === 0);
    let profileChanges;
    const requesterCanViewOwnChanges = notification?.notificationRole === "requester" &&
      String(notification?.recipientUsername ?? "") === String(req.auth?.user?.username ?? "") &&
      requesterIsSubject;
    if (options.includeProfileDetails === true &&
        (req.auth?.account?.accessRole === "admin" || requesterCanViewOwnChanges) &&
        profileRequest) {
      const before = decryptPersonnelProfileProposalFields(
        profileRequest.beforeProfile,
        profileRequest.personnelId,
        personnelDataKeyring
      );
      const after = decryptPersonnelProfileProposalFields(
        profileRequest.proposedProfile,
        profileRequest.personnelId,
        personnelDataKeyring
      );
      profileChanges = personnelProfileChangeDetails(before, after, profileRequest.changedFields);
    }
    return {
      ...safeNotification,
      canApprove,
      ...(profileChanges ? { profileChanges } : {}),
    };
  }
  return safeNotification;
}

function stationNotificationPayloadForAuth(state = {}, req, requestedLimit = 100, options = {}) {
  const username = String(req.auth?.user?.username ?? "").trim();
  const allNotifications = notificationsForRecipient(currentStationNotifications(state), username);
  const limit = Math.min(500, Math.max(1, Number(requestedLimit) || 100));
  const ordersById = new Map(visibleOrdersForNotificationAuth(state, req.auth?.account)
    .map((order) => [String(order?.id ?? ""), order]));
  const approvalRequestsById = new Map(currentApprovalRequests(state)
    .map((request) => [String(request?.id ?? ""), request])
    .filter(([id]) => id));
  const profileRequestsById = new Map(currentPersonnelProfileRequests(state)
    .map((request) => [String(request?.id ?? ""), request])
    .filter(([id]) => id));
  const notifications = allNotifications.slice(0, limit)
    .map((notification) => stationNotificationForAuth(state, req, notification, {
      ...options,
      ordersById,
      approvalRequestsById,
      profileRequestsById,
    }));
  return {
    notifications,
    totalCount: allNotifications.length,
    unreadCount: allNotifications.filter((notification) => !notification?.readAt).length,
  };
}

function pendingCreditSaleRecipients(state = {}, orderId = "") {
  return currentStationNotifications(state)
    .filter((notification) =>
      notification?.type === "credit_sale_confirmation" &&
      notification?.status === "pending" &&
      String(notification?.orderId ?? "") === String(orderId ?? "")
    )
    .map((notification) => String(notification?.recipientUsername ?? "").trim())
    .filter((username, index, all) => username && all.indexOf(username) === index);
}

function ensureOrderCreditSaleNotifications(
  state = {},
  order = {},
  gate = {},
  createdBy = "system",
  recipients = creditSaleEligibleApprovers(state.personnel, order)
) {
  const creditSaleRequestId = uid("credit");
  return ensureCreditSaleNotifications(currentStationNotifications(state), {
    creditSaleRequestId,
    notificationIds: recipients.map(() => uid("notice")),
    orderId: String(order?.id ?? ""),
    orderNo: String(order?.orderNo ?? ""),
    siteId: normalizeSiteId(order?.siteId),
    recipients,
    requiredOutstandingAmount: gate.outstandingAmount,
    createdAt: new Date().toISOString(),
    createdBy,
    createdByName: activePersonnelForReference(state, createdBy)?.name ?? createdBy,
  });
}

async function commitShipmentPaymentBlock(client, req, state = {}, order = {}, gate = {}) {
  const operator = authenticatedOperator(req);
  const eligibleApprovers = creditSaleEligibleApprovers(state.personnel, order);
  const selectedApproverUsernames = pendingCreditSaleRecipients(state, order?.id);
  const requesterIsOrderOwner = isCreditSaleOrderOwner(state.personnel, order, operator);
  await client.query("COMMIT");
  return {
    orderId: String(order?.id ?? ""),
    orderNo: String(order?.orderNo ?? ""),
    outstandingAmount: Number(gate.outstandingAmount ?? 0),
    eligibleApprovers,
    selectedApproverUsernames,
    requesterIsOrderOwner,
    error: eligibleApprovers.length > 0
      ? requesterIsOrderOwner
        ? `订单尚有 ¥${Number(gate.outstandingAmount ?? 0).toFixed(2)} 未经财务核销；你是订单负责人，确认申请后将自动通过赊销`
        : `订单尚有 ¥${Number(gate.outstandingAmount ?? 0).toFixed(2)} 未经财务核销，请选择管理员或订单负责人发起赊销审批；任一被选审批人同意后可继续发货`
      : "当前没有可处理赊销审批的在职管理员或订单负责人，请先维护人员账号",
  };
}

function approveCreditSaleInState(
  req,
  state = {},
  currentOrder = {},
  gate = {},
  { pendingNotification = null, note = "", autoApproved = false } = {}
) {
  const orders = Array.isArray(state.orders) ? state.orders : [];
  const notifications = currentStationNotifications(state);
  const operator = authenticatedOperator(req);
  const operatorName = String(req.auth?.account?.name ?? operator);
  const approver = creditSaleEligibleApprovers(state.personnel, currentOrder)
    .find((recipient) => recipient.username === operator);
  if (!approver) throw new Error("只有管理员或该订单的负责人可以审批赊销");

  const approvedAmount = Math.max(
    Number(gate.outstandingAmount ?? 0),
    Number(pendingNotification?.requiredOutstandingAmount ?? 0)
  );
  const confirmedAt = new Date().toISOString();
  const notificationRequestId = String(pendingNotification?.creditSaleRequestId ?? "");
  const creditSaleRequestId = notificationRequestId || uid("credit");
  const requestNotifications = notificationRequestId
    ? notifications.filter((notification) =>
        notification?.type === "credit_sale_confirmation" &&
        notification?.status === "pending" &&
        String(notification?.orderId ?? "") === String(currentOrder?.id ?? "") &&
        String(notification?.creditSaleRequestId ?? "") === notificationRequestId
      )
    : [];
  const approvalNote = String(note ?? "").trim() || (autoApproved ? "订单负责人本人申请，系统自动通过" : "");
  const approverUsernames = requestNotifications.length > 0
    ? requestNotifications
        .map((notification) => String(notification?.recipientUsername ?? "").trim())
        .filter((username, index, all) => username && all.indexOf(username) === index)
    : [operator];
  const nextOrder = {
    ...currentOrder,
    creditSaleApproval: {
      amount: Number(approvedAmount.toFixed(2)),
      confirmedAt,
      confirmedBy: operator,
      confirmedByName: operatorName,
      note: approvalNote,
      requestId: creditSaleRequestId,
      requestedBy: String(pendingNotification?.createdBy ?? operator),
      requestedByName: String(pendingNotification?.createdByName ?? operatorName),
      approverUsernames,
    },
  };
  const nextOrders = orders.map((order) =>
    String(order?.id ?? "") === String(currentOrder?.id ?? "") ? nextOrder : order
  );
  const resolved = resolveCreditSaleNotifications(
    notifications,
    currentOrder?.id,
    "credit_confirmed",
    operator,
    confirmedAt,
    operatorName,
    approvalNote,
    notificationRequestId
  );
  const approverRole = approver.isOrderOwner ? "订单负责人" : "管理员";
  const operationLog = createOperationLog(
    req,
    "订单管理",
    autoApproved ? "自动通过赊销" : "确认赊销",
    autoApproved
      ? `订单「${currentOrder.orderNo}」由订单负责人 ${operatorName} 申请并自动通过赊销 ¥${approvedAmount.toFixed(2)}`
      : `订单「${currentOrder.orderNo}」由${approverRole} ${operatorName} 同意赊销 ¥${approvedAmount.toFixed(2)}${approvalNote ? `，备注：${approvalNote}` : ""}`
  );
  return {
    nextOrder,
    nextOrders,
    creditSaleRequestId,
    operationLog,
    nextState: {
      ...state,
      orders: nextOrders,
      notifications: resolved.notifications,
      operationLogs: pushOperationLog(state.operationLogs, operationLog),
    },
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
  if (!user || user.role !== payload.role ||
      sessionVersionForAccount(account) !== sessionVersionForAccount(payload)) return null;
  return { user, account };
}

function isPublicApiRoute(req, url) {
  if (req.method === "OPTIONS") return true;
  if (url.pathname === "/api/health" && req.method === "GET") return true;
  if (url.pathname === "/api/version" && req.method === "GET") return true;
  if (url.pathname === "/api/public/catalog" && req.method === "GET") return true;
  if (url.pathname === "/api/public/bio-records" && req.method === "GET") return true;
  if (url.pathname === "/api/public/media/cos" && ["GET", "HEAD"].includes(req.method)) return true;
  if (url.pathname === "/api/public/media/video-derivative" && ["GET", "HEAD"].includes(req.method)) return true;
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
      todayUnshippedRefund: summary.todayUnshippedRefund,
      todayShippedDamage: summary.todayShippedDamage,
      todayRefunded: summary.todayUnshippedRefund,
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
    waterQualityParameterIds: Array.isArray(group?.waterQualityParameterIds)
      ? [...new Set(group.waterQualityParameterIds.map(String).filter(Boolean))]
      : undefined,
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

function pushOperationLog(operationLogs, operationLog) {
  return [operationLog, ...(Array.isArray(operationLogs) ? operationLogs : [])].slice(0, MAX_OPERATION_LOGS);
}

function normalizeStockItem(item) {
  const requestedId = String(item?.id ?? "").trim();
  const normalized = {
    ...item,
    id: requestedId || uid("stock"),
    siteId: normalizeSiteId(item.siteId),
    productId: String(item.productId ?? "").trim(),
    batchId: String(item.batchId ?? "").trim(),
    subTankId: String(item.subTankId ?? "").trim(),
    status: ["healthy", "feeding", "sick"].includes(item.status) ? item.status : "healthy",
    inDate: String(item.inDate ?? "").trim(),
    basePrice: Number(item.basePrice ?? 0),
    commissionRate: 0,
    code: String(item.code ?? "").trim(),
    notes: String(item.notes ?? "").trim(),
    lossDate: String(item.lossDate ?? "").trim(),
    lossReason: String(item.lossReason ?? "").trim(),
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

function applyStockMutationToState(state = {}, change = {}, operator = "system", options = {}) {
  const stock = Array.isArray(state.stock) ? state.stock : [];
  const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
  const upsertItems = (Array.isArray(change?.upsert) ? change.upsert : []).map(normalizeStockItem);
  const deleteIds = (Array.isArray(change?.deleteIds) ? change.deleteIds : [])
    .map((id) => String(id ?? "").trim());
  if (upsertItems.length === 0 && deleteIds.length === 0) throw new Error("No stock changes provided");
  validateStockMutationRelationships(state, { upsert: upsertItems, deleteIds }, {
    visibleSiteIds: options.visibleSiteIds,
  });

  const upsertIds = upsertItems.map((item) => item.id);
  if (new Set(upsertIds).size !== upsertIds.length) throw new Error("入库记录编号重复，请刷新后重试");
  const deleteIdSet = new Set(deleteIds);
  const existingIds = new Set(stock.map((item) => String(item?.id ?? "").trim()).filter(Boolean));
  const existingDeleteIds = new Set(
    stock
      .map((item) => String(item?.id ?? "").trim())
      .filter((id) => id && deleteIdSet.has(id))
  );
  if (deleteIdSet.size > 0 && existingDeleteIds.size !== deleteIdSet.size) {
    throw new Error("部分库存记录已不存在，请刷新后重试");
  }

  const batches = Array.isArray(state.batches) ? state.batches : [];
  const batchById = new Map(batches.map((batch) => [String(batch?.id ?? ""), batch]));
  for (const item of upsertItems) {
    if (!batchById.has(item.batchId)) throw new Error("采购批次不存在，请刷新后重试");
  }

  const shipments = Array.isArray(state.shipments) ? state.shipments : [];
  const blockingShipment = shipments.find((shipment) =>
    shipmentBlocksInventory(shipment) &&
    (Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds : [])
      .some((id) => existingDeleteIds.has(String(id ?? "")))
  );
  if (blockingShipment) throw new Error("所选库存已出库或发货，不能删除");

  const orders = Array.isArray(state.orders) ? state.orders : [];
  const protectedOrder = orders.find((order) =>
    !["cancelled", "pending", "confirmed"].includes(String(order?.status ?? "")) &&
    (Array.isArray(order?.items) ? order.items : []).some((item) =>
      orderItemKeepsInventory(item) && existingDeleteIds.has(String(item?.stockItemId ?? ""))
    )
  );
  if (protectedOrder) {
    throw new Error(`库存已进入订单「${protectedOrder.orderNo || protectedOrder.id}」的完成或异常流程，不能删除`);
  }

  const removedAt = new Date().toISOString();
  const stockById = new Map(stock.map((item) => [String(item?.id ?? "").trim(), item]));
  const affectedOrderIds = new Set();
  const nextOrders = orders.map((order) => {
    if (!["pending", "confirmed"].includes(String(order?.status ?? ""))) return order;
    let changed = false;
    const items = (Array.isArray(order.items) ? order.items : []).map((item) => {
      if (!orderItemKeepsInventory(item) || !existingDeleteIds.has(String(item?.stockItemId ?? ""))) {
        return item;
      }
      changed = true;
      const fishCode = String(item?.fishCode ?? stockById.get(String(item?.stockItemId ?? ""))?.code ?? "").trim();
      return {
        ...item,
        ...(fishCode ? { fishCode } : {}),
        inventoryRemovedAt: removedAt,
        inventoryRemovedBy: operator,
      };
    });
    if (!changed) return order;
    affectedOrderIds.add(String(order.id ?? ""));
    return { ...order, items };
  });
  const nextShipments = shipments.map((shipment) => {
    if (shipment?.status !== "preparing") return shipment;
    const currentItemIds = Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds : [];
    const itemStockIds = currentItemIds.filter((id) => !existingDeleteIds.has(String(id ?? "")));
    if (itemStockIds.length === currentItemIds.length) return shipment;
    return {
      ...shipment,
      itemStockIds,
      damageItemStockIds: Array.isArray(shipment?.damageItemStockIds)
        ? shipment.damageItemStockIds.filter((id) => !existingDeleteIds.has(String(id ?? "")))
        : shipment.damageItemStockIds,
    };
  });
  const orderUpdates = nextOrders.filter((order) => affectedOrderIds.has(String(order?.id ?? "")));
  const shipmentUpdates = nextShipments.filter((shipment, index) =>
    stableJson(shipment) !== stableJson(shipments[index])
  );
  const upsertById = new Map(upsertItems.map((item) => [item.id, item]));
  const changedStock = stock
    .filter((item) => !deleteIdSet.has(String(item?.id ?? "").trim()))
    .map((item) => upsertById.get(String(item?.id ?? "").trim()) ?? item);
  for (const item of upsertItems) {
    if (!existingIds.has(item.id)) changedStock.push(item);
  }
  const nextStock = setStockSoldForOrders({ ...state, stock: changedStock }, nextOrders);
  const nextBatches = refreshBatchStockCounts(batches, nextStock);
  const upsertIdSet = new Set(upsertItems.map((item) => String(item?.id ?? "")));
  const stockUpdates = nextStock.filter((item) => upsertIdSet.has(String(item?.id ?? "")));
  const previousBatchById = new Map(batches.map((batch) => [String(batch?.id ?? ""), batch]));
  const batchUpdates = nextBatches.filter((batch) =>
    stableJson(batch) !== stableJson(previousBatchById.get(String(batch?.id ?? "")))
  );
  const defaultAction = deleteIdSet.size > 0
    ? "删除记录"
    : upsertItems.some((item) => existingIds.has(item.id))
      ? "修改记录"
      : "添加记录";
  const defaultDetail = deleteIdSet.size > 0
    ? `删除入库记录 ${deleteIdSet.size} 条${affectedOrderIds.size > 0 ? `，保留并标记未出库订单 ${affectedOrderIds.size} 个` : ""}`
    : `保存入库记录 ${upsertItems.length} 条`;
  const operationLog = options.operationLog === null
    ? null
    : options.operationLog ?? {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "库存明细",
        action: defaultAction,
        detail: defaultDetail,
      };
  const nextState = {
    ...state,
    stock: nextStock,
    batches: nextBatches,
    orders: nextOrders,
    shipments: nextShipments,
    operationLogs: operationLog ? pushOperationLog(operationLogs, operationLog) : operationLogs,
  };
  return {
    nextState,
    stock: nextStock,
    batches: nextBatches,
    orders: nextOrders,
    shipments: nextShipments,
    orderUpdates,
    shipmentUpdates,
    stockUpdates,
    batchUpdates,
    affectedOrderCount: affectedOrderIds.size,
    operationLog,
    upsertItems,
    deleteIds,
    existingIds,
    defaultAction,
    defaultDetail,
  };
}

function currentApprovalRequests(state = {}) {
  return Array.isArray(state.approvalRequests) ? state.approvalRequests : [];
}

function currentInventoryAdjustmentDrafts(state = {}) {
  return Array.isArray(state.inventoryAdjustmentDrafts) ? state.inventoryAdjustmentDrafts : [];
}

function inventoryAdjustmentDraftForUser(state = {}, username = "") {
  const owner = String(username ?? "").trim();
  return currentInventoryAdjustmentDrafts(state)
    .find((draft) => String(draft?.createdBy ?? "") === owner) ?? null;
}

function normalizeInventoryAdjustmentDraft(state = {}, input = {}, req, existingDraft = null) {
  const siteId = normalizeSiteId(input?.siteId);
  if (!siteId || siteId === ALL_SITE_ID) throw new Error("盘库草稿必须选择具体场地");
  const visibleSiteIds = visibleSiteIdsForAccount(req.auth?.account, state);
  if (!visibleSiteIds.includes(siteId)) throw new Error("无权盘点该场地库存");
  const productIds = new Set((Array.isArray(state.products) ? state.products : [])
    .map((product) => String(product?.id ?? "")).filter(Boolean));
  const siteBatches = (Array.isArray(state.batches) ? state.batches : [])
    .filter((batch) => matchesSite(batch, siteId));
  const batchById = new Map(siteBatches
    .map((batch) => [String(batch?.id ?? ""), batch]).filter(([id]) => Boolean(id)));
  const batchIds = new Set(batchById.keys());
  const tankIds = new Set((Array.isArray(state.tankGroups) ? state.tankGroups : [])
    .filter((group) => matchesSite(group, siteId))
    .flatMap((group) => (Array.isArray(group?.subTanks) ? group.subTanks : []))
    .map((tank) => String(tank?.id ?? "")).filter(Boolean));
  const hasExactDraftShape = Array.isArray(input?.removeStockIds) || Array.isArray(input?.additions);
  const legacyLines = !hasExactDraftShape
    ? (Array.isArray(input?.lines) ? input.lines : []).slice(0, 500).map((line) => {
        const quantity = Number(line?.quantity ?? 0);
        const normalized = {
          id: String(line?.id || uid("adjust-line")),
          subTankId: String(line?.subTankId ?? "").trim(),
          productId: String(line?.productId ?? "").trim(),
          batchId: String(line?.batchId ?? "").trim(),
          direction: line?.direction === "remove" ? "remove" : "add",
          quantity,
        };
        if (!tankIds.has(normalized.subTankId)) throw new Error("盘库草稿中存在无效缸位");
        if (!productIds.has(normalized.productId)) throw new Error("盘库草稿中存在无效商品");
        if (!batchIds.has(normalized.batchId)) throw new Error("盘库草稿中存在无效采购批次");
        if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000) {
          throw new Error("盘库调整数量必须是 1 至 1000 的整数");
        }
        return normalized;
      })
    : [];

  const rawRemoveStockIds = Array.isArray(input?.removeStockIds) ? input.removeStockIds : [];
  if (rawRemoveStockIds.length > 5000) throw new Error("单张盘库草稿最多减少 5000 条库存");
  const removeStockIds = [...new Set(rawRemoveStockIds
    .map((id) => String(id ?? "").trim())
    .filter(Boolean))];
  const stockById = new Map((Array.isArray(state.stock) ? state.stock : [])
    .map((item) => [String(item?.id ?? ""), item]).filter(([id]) => Boolean(id)));
  for (const stockId of removeStockIds) {
    const item = stockById.get(stockId);
    if (!item || !matchesSite(item, siteId)) throw new Error("盘库草稿中的部分库存已不存在，请刷新后重试");
    if (item?.lost) throw new Error("已损耗库存不能加入盘库减少项");
  }

  const today = new Date().toISOString().slice(0, 10);
  const rawAdditions = Array.isArray(input?.additions) ? input.additions : [];
  if (rawAdditions.length > 500) throw new Error("单张盘库草稿最多登记 500 组增加项");
  const additions = rawAdditions.map((addition) => {
    const quantity = Number(addition?.quantity ?? 0);
    const normalized = {
      id: String(addition?.id || uid("adjust-add")),
      subTankId: String(addition?.subTankId ?? "").trim(),
      productId: String(addition?.productId ?? "").trim(),
      batchId: String(addition?.batchId ?? "").trim(),
      quantity,
      status: ["healthy", "feeding", "sick"].includes(addition?.status) ? addition.status : "healthy",
      inDate: String(addition?.inDate ?? "").trim(),
      basePrice: Number(addition?.basePrice ?? 0),
      code: String(addition?.code ?? "").trim().slice(0, 100),
      notes: String(addition?.notes ?? "").trim().slice(0, 500),
    };
    if (!tankIds.has(normalized.subTankId)) throw new Error("盘库草稿中存在无效缸位");
    if (!productIds.has(normalized.productId)) throw new Error("盘库草稿中存在无效商品");
    if (!batchIds.has(normalized.batchId)) throw new Error("盘库草稿中存在无效采购批次");
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000) {
      throw new Error("盘库增加数量必须是 1 至 1000 的整数");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized.inDate)) throw new Error("盘库增加项必须填写有效入库日期");
    if (normalized.inDate > today) throw new Error("盘库增加项的入库日期不能晚于今天");
    const batchArrivalDate = String(batchById.get(normalized.batchId)?.arrivalDate ?? "");
    if (batchArrivalDate && normalized.inDate < batchArrivalDate) {
      throw new Error("盘库增加项的入库日期不能早于采购批次到货日期");
    }
    if (!Number.isFinite(normalized.basePrice) || normalized.basePrice <= 0) {
      throw new Error("盘库增加项的单条售价必须大于 0");
    }
    if (quantity > 1) normalized.code = "";
    return normalized;
  });
  if (new Set(additions.map((item) => item.id)).size !== additions.length) {
    throw new Error("盘库增加项编号重复，请刷新后重试");
  }
  const totalAdditionCount = additions.reduce((sum, item) => sum + item.quantity, 0);
  if (totalAdditionCount > 5000) throw new Error("单张盘库草稿最多增加 5000 条库存");

  if (legacyLines.some((line) => line.direction === "add") || additions.length > 0) {
    requireModulePermissionForAuth(req, "stockIn", "create");
  }
  if (legacyLines.some((line) => line.direction === "remove") || removeStockIds.length > 0) {
    requireModulePermissionForAuth(req, "stockIn", "delete");
  }
  const now = new Date().toISOString();
  const activeSubTankId = String(input?.activeSubTankId ?? "").trim();
  return {
    id: String(existingDraft?.id ?? input?.id ?? uid("adjustment-draft")),
    siteId,
    removeStockIds,
    additions,
    ...(tankIds.has(activeSubTankId) ? { activeSubTankId } : {}),
    ...(!hasExactDraftShape && legacyLines.length > 0 ? { lines: legacyLines } : {}),
    notes: String(input?.notes ?? "").trim().slice(0, 1000),
    createdAt: String(existingDraft?.createdAt ?? now),
    updatedAt: now,
    createdBy: authenticatedOperator(req),
    createdByName: authenticatedOperatorName(req),
  };
}

function replaceInventoryAdjustmentDraft(state = {}, draft = {}) {
  const owner = String(draft?.createdBy ?? "");
  return [draft, ...currentInventoryAdjustmentDrafts(state)
    .filter((item) => String(item?.createdBy ?? "") !== owner)]
    .slice(0, 500);
}

function clearInventoryAdjustmentDraft(state = {}, username = "", draftId = "") {
  const owner = String(username ?? "").trim();
  const expectedId = String(draftId ?? "").trim();
  if (!owner || !expectedId) return currentInventoryAdjustmentDrafts(state);
  return currentInventoryAdjustmentDrafts(state).filter((draft) =>
    !(String(draft?.createdBy ?? "") === owner && String(draft?.id ?? "") === expectedId)
  );
}

function stockApprovalDetailsForRequest(state = {}, approvalRequest = {}) {
  const review = stockApprovalReviewDetails(approvalRequest, state);
  return stockApprovalDetailsForResponse(review.stockDetails);
}

function stockApprovalPlan(state = {}, mutation = {}, req, adjustmentContext = null) {
  const isInventoryAdjustment = adjustmentContext?.kind === "inventory_adjustment";
  const effectiveChange = filterEffectiveStockMutation({
    stock: state.stock,
    upsertItems: mutation.upsertItems,
    deleteIds: mutation.deleteIds,
  });
  if (effectiveChange.upsertItems.length === 0 && effectiveChange.deleteIds.length === 0) {
    const error = new Error("库存内容没有发生变化，无需保存或提交审批");
    error.statusCode = 409;
    error.code = "NO_STOCK_CHANGES";
    throw error;
  }
  const effectiveUpsertItems = effectiveChange.upsertItems;
  const effectiveDeleteIds = effectiveChange.deleteIds;
  const batchById = new Map((Array.isArray(state.batches) ? state.batches : [])
    .map((batch) => [String(batch?.id ?? ""), batch]));
  const classification = classifyStockMutationForApproval({
    isAdmin: req.auth?.account?.accessRole === "admin",
    existingIds: mutation.existingIds,
    upsertItems: effectiveUpsertItems,
    deleteIds: effectiveDeleteIds,
    stock: state.stock,
    batches: Array.isArray(state.batches) ? state.batches : [],
  });
  const adjustmentRequiresApproval = isInventoryAdjustment && req.auth?.account?.accessRole !== "admin";
  if (!classification.requiresApproval && !adjustmentRequiresApproval) return null;
  const { updatedItems, lateItems, hasDeletes } = classification;

  const stockById = new Map((Array.isArray(state.stock) ? state.stock : [])
    .map((item) => [String(item?.id ?? ""), item]));
  const lateBatchIds = [...new Set(lateItems.map((item) => item.batchId))];
  const lateBatchLabels = lateBatchIds
    .map((id) => String(batchById.get(id)?.batchNo ?? id))
    .filter(Boolean);
  const deletedCodes = effectiveDeleteIds
    .map((id) => String(stockById.get(id)?.code ?? id).trim())
    .filter(Boolean);
  const updatedCodes = updatedItems
    .map((item) => String(stockById.get(String(item?.id ?? ""))?.code ?? item?.code ?? item?.id ?? "").trim())
    .filter(Boolean);
  const actionCount = Number(hasDeletes) + Number(updatedItems.length > 0) + Number(lateItems.length > 0);
  const approvalAction = isInventoryAdjustment
    ? "inventory_adjustment"
    : actionCount > 1
    ? "mixed_stock_change"
    : hasDeletes
      ? "delete_stock"
      : updatedItems.length > 0
        ? "update_stock"
        : "add_stock_to_old_batch";
  const title = isInventoryAdjustment
    ? "盘库调整待审批"
    : approvalAction === "delete_stock"
    ? "库存删除待审批"
    : approvalAction === "update_stock"
      ? "库存修改待审批"
      : approvalAction === "add_stock_to_old_batch"
        ? "超时批次入库待审批"
        : "库存变更待审批";
  const details = [];
  if (hasDeletes) {
    const codeSummary = deletedCodes.slice(0, 6).join("、");
    details.push(`申请删除 ${effectiveDeleteIds.length} 条库存${codeSummary ? `（${codeSummary}${deletedCodes.length > 6 ? "等" : ""}）` : ""}`);
  }
  if (updatedItems.length > 0) {
    const codeSummary = updatedCodes.slice(0, 6).join("、");
    details.push(`申请修改 ${updatedItems.length} 条库存${codeSummary ? `（${codeSummary}${updatedCodes.length > 6 ? "等" : ""}）` : ""}`);
  }
  if (lateItems.length > 0) {
    details.push(`申请向创建已超过 48 小时的批次「${lateBatchLabels.join("、")}」补录 ${lateItems.length} 条库存`);
  }
  const expectation = buildStockMutationExpectation(state, {
    upsert: effectiveUpsertItems,
    deleteIds: effectiveDeleteIds,
  });
  const changedItems = [
    ...effectiveUpsertItems,
    ...effectiveDeleteIds.map((stockId) => stockById.get(String(stockId ?? ""))).filter(Boolean),
  ];
  const changedSiteIds = [...new Set(changedItems.map((item) => authoritativeStockMutationSiteId(state, item)))];
  if (changedSiteIds.length !== 1) {
    const error = new Error("一次库存审批只能涉及一个场地，请按场地分别提交");
    error.statusCode = 400;
    error.code = "STOCK_APPROVAL_SITE_MIXED";
    throw error;
  }
  const payload = {
    upsert: effectiveUpsertItems,
    deleteIds: effectiveDeleteIds,
    siteId: changedSiteIds[0],
    ...expectation,
  };
  const stockDetails = buildStockChangeSnapshot({
    upsertItems: effectiveUpsertItems,
    deleteIds: effectiveDeleteIds,
    stock: state.stock,
    products: state.products,
    species: state.species,
    batches: state.batches,
    tankGroups: state.tankGroups,
    orders: state.orders,
  });
  if (isInventoryAdjustment) {
    const { addCount, removeCount, updateCount } = stockDetails.totals;
    details.length = 0;
    details.push(
      `申请盘库调整 ${stockDetails.tanks.length} 个缸位` +
      `（增加 ${addCount} 条、减少 ${removeCount} 条${updateCount > 0 ? `、修改 ${updateCount} 条` : ""}）`
    );
  }
  const createdBy = authenticatedOperator(req);
  const adjustmentSignature = isInventoryAdjustment
    ? stockChangeAdjustmentSignature(stockDetails)
    : null;
  const requestKey = createHash("sha256")
    .update(`${createdBy}\0${approvalAction}\0${stableJson(adjustmentSignature ?? stockDetails.signature)}`)
    .digest("hex");
  return {
    approvalAction,
    title,
    message: `${details.join("；")}。批准后才会统一执行。`,
    responseMessage: isInventoryAdjustment
      ? "盘库调整申请已提交管理员审批，批准前库存不会变更"
      : approvalAction === "delete_stock"
        ? "删除申请已提交管理员审批，批准前库存不会删除"
        : approvalAction === "update_stock"
        ? "修改申请已提交管理员审批，批准前库存不会变更"
        : approvalAction === "add_stock_to_old_batch"
          ? "该批次创建已超过 48 小时，入库申请已提交管理员审批"
          : "库存变更已提交管理员审批，批准前不会执行",
    payload,
    stockDetails,
    requestKey,
    siteId: changedSiteIds[0],
  };
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

function orderItemKeepsInventory(item = {}) {
  return !String(item?.inventoryRemovedAt ?? "").trim();
}

function findActiveOrderForStock(state = {}, stockItemId) {
  return (Array.isArray(state.orders) ? state.orders : []).find((order) =>
    order?.status !== "cancelled" &&
    Array.isArray(order.items) &&
    order.items.some((item) => item?.stockItemId === stockItemId && orderItemKeepsInventory(item))
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
      if (!orderItemKeepsInventory(item)) continue;
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
      const stockId = normalizeShipmentInventoryId(id);
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

function normalizeMinReturnPrice(value) {
  return normalizeMoney(value, "Minimum return price");
}

function findProductById(state = {}, productId = "") {
  const id = String(productId ?? "").trim();
  return (Array.isArray(state.products) ? state.products : [])
    .find((product) => String(product?.id ?? "") === id);
}

function normalizePaymentRecord(record = {}) {
  const type = String(record.type ?? "");
  if (!["deposit", "balance", "shipping_fee", "refund", "other"].includes(type)) {
    throw new Error("Invalid payment type");
  }
  const channel = normalizePaymentChannel(record.channel);
  if (record.channel && !channel) throw new Error("Invalid payment channel");
  const verificationStatus = paymentVerificationStatus(record);
  const recordSource = ["order", "finance", "platform", "statement"].includes(String(record.recordSource ?? ""))
    ? String(record.recordSource)
    : "finance";
  const refundMethod = type === "refund"
    ? ["platform", "account"].includes(String(record.refundMethod ?? ""))
      ? String(record.refundMethod)
      : refundMethodForChannel(channel)
    : undefined;
  return {
    id: String(record.id || uid("pay")),
    time: String(record.time || nowDatetimeInChina()),
    type,
    amount: normalizeMoney(record.amount, "Payment amount"),
    paymentMethodId: String(record.paymentMethodId ?? "").trim(),
    paymentMethodName: String(record.paymentMethodName ?? "").trim(),
    ...(channel ? { channel } : {}),
    account: String(record.account ?? "").trim(),
    externalTransactionNo: String(record.externalTransactionNo ?? "").trim(),
    statementId: String(record.statementId ?? "").trim(),
    ...(record.statementOriginal && typeof record.statementOriginal === "object"
      ? {
        statementOriginal: {
          time: String(record.statementOriginal.time ?? ""),
          externalTransactionNo: String(record.statementOriginal.externalTransactionNo ?? ""),
          recordSource: String(record.statementOriginal.recordSource ?? "order"),
          notes: String(record.statementOriginal.notes ?? ""),
        },
      }
      : {}),
    matchMethod: ["auto", "owner", "finance"].includes(String(record.matchMethod ?? ""))
      ? String(record.matchMethod)
      : "",
    verificationStatus,
    recordSource,
    ...(refundMethod ? { refundMethod } : {}),
    recordedBy: String(record.recordedBy ?? "").trim(),
    verifiedAt: verificationStatus === "verified" ? String(record.verifiedAt ?? "").trim() : "",
    verifiedBy: verificationStatus === "verified" ? String(record.verifiedBy ?? "").trim() : "",
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
  const mode = normalizeShippingFeeMode(order?.shippingFeeMode, order?.source);
  if (mode === "collect") return 0;
  const activeShipments = shipments.filter((shipment) =>
    shipment?.orderId === order.id && shipmentBlocksInventory(shipment)
  );
  if (activeShipments.length === 0) return Number(order.shippingFee ?? 0);
  if (shipmentsHavePendingActualShippingFee(mode, activeShipments)) {
    return Number(order.shippingFee ?? 0);
  }
  return activeShipments.reduce((sum, shipment) => sum + Number(shipment.actualShippingFee ?? 0), 0);
}

function calcAmountRefundedForOrder(order = {}) {
  return (Array.isArray(order.payments) ? order.payments : [])
    .filter((payment) => payment?.type === "refund" && isPaymentVerified(payment))
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
  return calculateOrderFeeBreakdown(order, {
    billableShippingFee: getBillableShippingFeeForOrder(order, shipments),
    damageRefundAdjustment: calcDamageRefundAdjustmentForOrder(order, shipments),
  }).calculatedReceivable;
}

function calcAmountPaidForOrder(order = {}) {
  return Number((Array.isArray(order.payments) ? order.payments : [])
    .filter(isPaymentVerified)
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

function shipmentPaymentGateForOrder(order = {}, shipments = []) {
  return shipmentPaymentGate(order, calcAmountDueForOrder(order, shipments));
}

function resolveShipmentGateNotifications(notifications = [], orderId = "", gate = {}, operator = "system") {
  const resolution = {
    verified: "finance_verified",
    platform_exempt: "platform_exempt",
    offline_credit: "offline_credit",
    credit_approved: "credit_confirmed",
  }[gate?.status];
  if (!resolution) return notifications;
  const resolved = resolveCreditSaleNotifications(
    notifications,
    orderId,
    resolution,
    operator,
    new Date().toISOString()
  );
  return resolved.changed ? resolved.notifications : notifications;
}

function creditApprovalSensitiveSnapshot(order = {}) {
  return stableJson({
    source: String(order?.source ?? ""),
    paymentMethodId: String(order?.paymentMethodId ?? ""),
    paymentChannel: String(order?.paymentChannel ?? ""),
    paymentAccount: String(order?.paymentAccount ?? ""),
    contactPersonnelId: String(order?.contactPersonnelId ?? ""),
    contactPerson: String(order?.contactPerson ?? ""),
    items: Array.isArray(order?.items) ? order.items : [],
    shippingFee: Number(order?.shippingFee ?? 0),
    packagingFee: Number(order?.packagingFee ?? 0),
    discount: Number(order?.discount ?? 0),
  });
}

function roundFinance(value) {
  return Number(Number(value || 0).toFixed(2));
}

function financeDefaultCommissionRate(state = {}) {
  return normalizeCommissionRate(
    state?.systemSettings?.financeDefaultCommissionRate,
    DEFAULT_COMMISSION_RATE
  );
}

function financePaymentTotals(order = {}) {
  return verifiedPaymentTotals(order?.payments);
}

function orderLogisticsStatusForFinance(order = {}, shipments = []) {
  if (order?.status === "cancelled") return "已取消";
  if (order?.status === "completed") return "已完成";
  if (order?.status === "damaged") return "已报损";
  const related = shipments.filter((shipment) =>
    String(shipment?.orderId ?? "") === String(order?.id ?? "") && shipment?.status !== "preparing"
  );
  if (related.some((shipment) => shipment?.status === "damaged")) return "已报损";
  if (related.length === 0) return "待出库";
  if (related.every((shipment) => shipment?.status === "delivered")) return "已签收";
  if (related.some((shipment) => shipment?.status === "shipped")) return "运输中";
  if (related.some((shipment) => shipment?.status === "outbound")) return "已出库";
  return "待发货";
}

function financeStatusLabel(order = {}, balance = 0, received = 0, hasPlatformSettlement = false, pendingCount = 0) {
  if (order?.status === "cancelled") return "已取消";
  if (pendingCount > 0) return "待核对";
  if (hasPlatformSettlement) return Math.abs(balance) <= 0.01 ? "已核销" : "有差异";
  if (balance < -0.01) return "待退款";
  if (balance <= 0.01) return "已核销";
  if (received > 0.01) return "部分收款";
  return "未核销";
}

function settlementRecordFromRow(row = {}) {
  const data = row?.data && typeof row.data === "object" ? row.data : {};
  return {
    ...data,
    batchId: String(row?.batch_id ?? data.batchId ?? ""),
    importedAt: row?.created_at ? new Date(row.created_at).toISOString() : "",
  };
}

function financeTransferFromRow(row = {}) {
  const expectedAmount = roundFinance(row?.expected_amount);
  const actualAmount = roundFinance(row?.actual_amount);
  return {
    id: String(row?.id ?? ""),
    siteId: String(row?.site_id ?? ""),
    channel: normalizePaymentChannel(row?.channel),
    sourceAccount: String(row?.source_account ?? ""),
    targetAccount: String(row?.target_account ?? ""),
    expectedAmount,
    actualAmount,
    difference: roundFinance(actualAmount - expectedAmount),
    transferredAt: String(row?.transferred_at ?? ""),
    transactionNo: String(row?.transaction_no ?? ""),
    status: row?.status === "verified" ? "verified" : "pending",
    importBatchIds: Array.isArray(row?.import_batch_ids) ? row.import_batch_ids.map(String) : [],
    proof: Array.isArray(row?.proof) ? row.proof : [],
    notes: String(row?.notes ?? ""),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : "",
    createdBy: String(row?.created_by ?? ""),
    verifiedAt: row?.verified_at ? new Date(row.verified_at).toISOString() : "",
    verifiedBy: String(row?.verified_by ?? ""),
  };
}

function paymentStatementFromRow(row = {}) {
  return {
    id: String(row?.id ?? ""),
    siteId: String(row?.site_id ?? ""),
    batchId: String(row?.batch_id ?? ""),
    paymentMethodId: String(row?.payment_method_id ?? ""),
    paymentMethodName: String(row?.payment_method_name ?? ""),
    channel: normalizePaymentChannel(row?.channel),
    account: String(row?.account ?? ""),
    externalTransactionNo: String(row?.external_transaction_no ?? ""),
    occurredAt: String(row?.occurred_at ?? ""),
    amount: roundFinance(row?.amount),
    direction: row?.direction === "expense" ? "expense" : "income",
    payerName: String(row?.payer_name ?? ""),
    notes: String(row?.notes ?? ""),
    rawData: row?.raw_data && typeof row.raw_data === "object" ? row.raw_data : {},
    candidates: Array.isArray(row?.candidate_orders) ? row.candidate_orders : [],
    matchStatus: ["matched", "verified"].includes(String(row?.match_status ?? ""))
      ? String(row.match_status)
      : "unmatched",
    matchReason: String(row?.match_reason ?? ""),
    matchedOrderId: String(row?.matched_order_id ?? ""),
    matchedPaymentId: String(row?.matched_payment_id ?? ""),
    matchMethod: ["auto", "owner", "finance"].includes(String(row?.match_method ?? ""))
      ? String(row.match_method)
      : "",
    matchedAt: row?.matched_at ? new Date(row.matched_at).toISOString() : "",
    matchedBy: String(row?.matched_by ?? ""),
    verifiedAt: row?.verified_at ? new Date(row.verified_at).toISOString() : "",
    verifiedBy: String(row?.verified_by ?? ""),
    createdAt: row?.created_at ? new Date(row.created_at).toISOString() : "",
  };
}

function statementImportBatchFromRow(row = {}) {
  return {
    id: String(row?.id ?? ""),
    siteId: String(row?.site_id ?? ""),
    paymentMethodId: String(row?.payment_method_id ?? ""),
    paymentMethodName: String(row?.payment_method_name ?? ""),
    channel: normalizePaymentChannel(row?.channel),
    account: String(row?.account ?? ""),
    fileName: String(row?.file_name ?? ""),
    importedAt: row?.imported_at ? new Date(row.imported_at).toISOString() : "",
    importedBy: String(row?.imported_by ?? ""),
    rowCount: Number(row?.row_count ?? 0),
    matchedCount: Number(row?.matched_count ?? 0),
    unmatchedCount: Number(row?.unmatched_count ?? 0),
    duplicateCount: Number(row?.duplicate_count ?? 0),
    totals: row?.totals && typeof row.totals === "object" ? row.totals : {},
  };
}

function financeMatchingOrderProfiles(state = {}) {
  const customers = new Map((Array.isArray(state.customers) ? state.customers : [])
    .map((customer) => [String(customer?.id ?? ""), customer]));
  const shipments = Array.isArray(state.shipments) ? state.shipments : [];
  return (Array.isArray(state.orders) ? state.orders : [])
    .filter((order) => !isPlatformOrderSource(order?.source))
    .map((order) => {
      const receivable = order?.status === "cancelled" ? 0 : calcAmountDueForOrder(order, shipments);
      const totals = financePaymentTotals(order);
      const matchingOutstanding = roundFinance(
        receivable - totals.received + totals.refunded - totals.pendingReceived + totals.pendingRefunded
      );
      return {
        id: String(order?.id ?? ""),
        orderNo: String(order?.orderNo ?? ""),
        customerName: String(customers.get(String(order?.customerId ?? ""))?.name ?? ""),
        contactPerson: String(order?.contactPerson ?? ""),
        paymentChannel: normalizePaymentChannel(order?.paymentChannel),
        paymentAccount: String(order?.paymentAccount ?? ""),
        receivable: roundFinance(receivable),
        matchingOutstanding,
        date: String(order?.date ?? ""),
        createdAt: String(order?.createdAt ?? ""),
        status: String(order?.status ?? ""),
        pendingRefunds: (Array.isArray(order?.payments) ? order.payments : []).filter((payment) =>
          payment?.type === "refund" &&
          paymentVerificationStatus(payment) === "pending" &&
          !String(payment?.statementId ?? "").trim() &&
          normalizePaymentChannel(payment?.channel ?? order?.paymentChannel) === normalizePaymentChannel(order?.paymentChannel) &&
          String(payment?.account ?? order?.paymentAccount ?? "").trim() === String(order?.paymentAccount ?? "").trim()
        ).map((payment) => ({ id: String(payment?.id ?? ""), amount: roundFinance(payment?.amount) })),
      };
    });
}

function statementPaymentRecord(statement = {}, order = {}, method = "finance", actor = "system") {
  return normalizePaymentRecord({
    id: uid("pay"),
    time: String(statement?.occurredAt ?? nowDatetimeInChina()),
    type: "balance",
    amount: statement?.amount,
    paymentMethodId: String(statement?.paymentMethodId ?? order?.paymentMethodId ?? ""),
    paymentMethodName: String(statement?.paymentMethodName ?? order?.paymentMethodName ?? ""),
    channel: statement?.channel,
    account: statement?.account,
    externalTransactionNo: statement?.externalTransactionNo,
    statementId: String(statement?.id ?? ""),
    matchMethod: method,
    verificationStatus: "pending",
    recordSource: "statement",
    recordedBy: actor,
    notes: [
      statement?.payerName ? `付款方：${statement.payerName}` : "",
      statement?.notes,
      method === "auto" ? "账单自动匹配" : method === "owner" ? "订单负责人认领" : "财务关联",
    ].filter(Boolean).join("；"),
    proof: [],
  });
}

function linkStatementToStateOrder(state = {}, statement = {}, orderId = "", method = "finance", actor = "system") {
  if (!['income', 'expense'].includes(String(statement?.direction ?? ""))) throw new Error("无法识别账单流水方向");
  const orders = Array.isArray(state.orders) ? state.orders : [];
  const currentOrder = orders.find((order) => String(order?.id ?? "") === String(orderId ?? ""));
  if (!currentOrder) throw new Error("系统订单不存在，请刷新后重试");
  if (currentOrder.status === "cancelled") throw new Error("已取消订单不能认领收款");
  if (isPlatformOrderSource(currentOrder.source)) throw new Error("平台订单应通过平台订单编号对账");
  if (normalizePaymentChannel(currentOrder.paymentChannel) !== normalizePaymentChannel(statement.channel) ||
      String(currentOrder.paymentAccount ?? "").trim() !== String(statement.account ?? "").trim()) {
    throw new Error("该流水与订单付款渠道或收款账户不一致");
  }
  const duplicate = orders.some((order) => (Array.isArray(order?.payments) ? order.payments : [])
    .some((payment) => String(payment?.statementId ?? "") === String(statement?.id ?? "")));
  if (duplicate) throw new Error("该账单流水已经关联订单");
  if (statement.direction === "expense") {
    const refund = (Array.isArray(currentOrder.payments) ? currentOrder.payments : []).find((payment) =>
      payment?.type === "refund" &&
      paymentVerificationStatus(payment) === "pending" &&
      !String(payment?.statementId ?? "").trim() &&
      Math.abs(Number(payment?.amount ?? 0) - Number(statement?.amount ?? 0)) <= 0.01 &&
      normalizePaymentChannel(payment?.channel ?? currentOrder.paymentChannel) === normalizePaymentChannel(statement.channel) &&
      String(payment?.account ?? currentOrder.paymentAccount ?? "").trim() === String(statement.account ?? "").trim()
    );
    if (!refund) throw new Error("该订单没有同渠道、同账户、同金额的待核销退款");
    const payment = normalizePaymentRecord({
      ...refund,
      statementOriginal: {
        time: refund.time,
        externalTransactionNo: refund.externalTransactionNo,
        recordSource: refund.recordSource,
        notes: refund.notes,
      },
      time: String(statement?.occurredAt ?? refund.time),
      externalTransactionNo: String(statement?.externalTransactionNo ?? ""),
      statementId: String(statement?.id ?? ""),
      matchMethod: method,
      recordSource: "statement",
      notes: [refund.notes, statement?.notes, method === "auto" ? "退款账单自动匹配" : "财务关联退款流水"].filter(Boolean).join("；"),
    });
    const nextOrder = {
      ...currentOrder,
      payments: (Array.isArray(currentOrder.payments) ? currentOrder.payments : [])
        .map((item) => String(item?.id ?? "") === payment.id ? payment : item),
    };
    return {
      order: nextOrder,
      payment,
      state: {
        ...state,
        orders: orders.map((order) => String(order?.id ?? "") === String(orderId ?? "") ? nextOrder : order),
      },
    };
  }
  const payment = statementPaymentRecord(statement, currentOrder, method, actor);
  const nextOrder = {
    ...currentOrder,
    payments: [...(Array.isArray(currentOrder.payments) ? currentOrder.payments : []), payment],
  };
  return {
    order: nextOrder,
    payment,
    state: {
      ...state,
      orders: orders.map((order) => String(order?.id ?? "") === String(orderId ?? "") ? nextOrder : order),
    },
  };
}

function financeOrderLookup(orders = []) {
  const lookup = new Map();
  for (const order of orders) {
    if (String(order?.source ?? "").trim() !== "平台下单") continue;
    const externalOrderNo = normalizeExternalOrderNo(order?.douyinOrderNo);
    if (externalOrderNo && !lookup.has(externalOrderNo)) lookup.set(externalOrderNo, order);
  }
  return lookup;
}

async function refreshFinanceBatchMatchCounts(client, state = {}, siteId = DEFAULT_SITE_ID) {
  const scopedOrders = siteFilteredState(state, siteId).orders ?? [];
  const orderLookup = financeOrderLookup(scopedOrders);
  const { rows } = await client.query(
    `SELECT batch_id, external_order_no
     FROM finance_platform_settlements
     WHERE state_id = $1 AND site_id = $2 AND platform = 'douyin'`,
    [stateId, siteId]
  );
  const counts = new Map();
  for (const row of rows) {
    const batchId = String(row?.batch_id ?? "");
    if (!batchId) continue;
    const current = counts.get(batchId) ?? { total: 0, matched: 0 };
    current.total += 1;
    if (orderLookup.has(normalizeExternalOrderNo(row?.external_order_no))) current.matched += 1;
    counts.set(batchId, current);
  }
  for (const [batchId, count] of counts.entries()) {
    await client.query(
      `UPDATE finance_import_batches
       SET matched_count = $3, unmatched_count = $4
       WHERE id = $1 AND state_id = $2`,
      [batchId, stateId, count.matched, Math.max(0, count.total - count.matched)]
    );
  }
}

async function refreshStatementBatchMatchCounts(client, batchId = "") {
  const id = String(batchId ?? "").trim();
  if (!id) return;
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE match_status IN ('matched', 'verified'))::int AS matched
     FROM finance_payment_statements
     WHERE state_id = $1 AND batch_id = $2`,
    [stateId, id]
  );
  const total = Number(rows[0]?.total ?? 0);
  const matched = Number(rows[0]?.matched ?? 0);
  await client.query(
    `UPDATE finance_statement_import_batches
     SET matched_count = $3, unmatched_count = $4
     WHERE id = $1 AND state_id = $2`,
    [id, stateId, matched, Math.max(0, total - matched)]
  );
}

function buildFinanceOverview(
  state = {},
  settlementRows = [],
  batchRows = [],
  transferRows = [],
  statementRows = [],
  statementBatchRows = [],
) {
  const orders = Array.isArray(state.orders) ? state.orders : [];
  const shipments = Array.isArray(state.shipments) ? state.shipments : [];
  const customers = new Map((Array.isArray(state.customers) ? state.customers : [])
    .map((customer) => [String(customer?.id ?? ""), customer]));
  const products = new Map((Array.isArray(state.products) ? state.products : [])
    .map((product) => [String(product?.id ?? ""), product]));
  const stockItems = new Map((Array.isArray(state.stock) ? state.stock : [])
    .map((item) => [String(item?.id ?? ""), item]));
  const defaultCommissionRate = financeDefaultCommissionRate(state);
  const settlements = settlementRows.map(settlementRecordFromRow);
  const settlementsByExternalOrderNo = new Map();
  for (const settlement of settlements) {
    const key = normalizeExternalOrderNo(settlement.externalOrderNo);
    if (!key) continue;
    settlementsByExternalOrderNo.set(key, [
      ...(settlementsByExternalOrderNo.get(key) ?? []),
      settlement,
    ]);
  }

  const orderRows = orders.map((order) => {
    const platformOrderNo = platformOrderNoForOrder(order);
    const externalOrderNo = String(order?.source ?? "").trim() === "平台下单"
      ? normalizeExternalOrderNo(order?.douyinOrderNo)
      : "";
    const platformSettlements = externalOrderNo
      ? settlementsByExternalOrderNo.get(externalOrderNo) ?? []
      : [];
    const paymentTotals = financePaymentTotals(order);
    const platformIncome = roundFinance(platformSettlements.reduce(
      (sum, settlement) => sum + Number(settlement?.incomeTotal ?? 0),
      0
    ));
    const platformRefund = roundFinance(platformSettlements.reduce(
      (sum, settlement) => sum + Math.abs(Number(settlement?.preSettlementRefund ?? 0)),
      0
    ));
    const platformFees = roundFinance(platformSettlements.reduce(
      (sum, settlement) => sum + Math.abs(Number(settlement?.expenseTotal ?? 0)),
      0
    ));
    const netSettlement = roundFinance(platformSettlements.reduce(
      (sum, settlement) => sum + Number(settlement?.settlementAmount ?? 0),
      0
    ));
    const hasPlatformSettlement = platformSettlements.length > 0;
    const received = hasPlatformSettlement ? platformIncome : roundFinance(paymentTotals.received);
    const refunded = hasPlatformSettlement ? platformRefund : roundFinance(paymentTotals.refunded);
    const recognizedNet = hasPlatformSettlement
      ? platformIncome
      : roundFinance(paymentTotals.received - paymentTotals.refunded);
    const feeBreakdown = calculateOrderFeeBreakdown(order, {
      billableShippingFee: getBillableShippingFeeForOrder(order, shipments),
      damageRefundAdjustment: calcDamageRefundAdjustmentForOrder(order, shipments),
    });
    const cancellationAdjustment = order?.status === "cancelled"
      ? roundFinance(-feeBreakdown.calculatedReceivable)
      : 0;
    const receivable = order?.status === "cancelled" ? 0 : feeBreakdown.calculatedReceivable;
    const balance = roundFinance(receivable - recognizedNet);
    const commission = calculateOrderCommission(order, defaultCommissionRate);
    const customer = customers.get(String(order?.customerId ?? ""));
    const items = (Array.isArray(order?.items) ? order.items : []).map((item) => {
      const stockItem = stockItems.get(String(item?.stockItemId ?? ""));
      const product = products.get(String(item?.productId ?? stockItem?.productId ?? ""));
      return {
        stockItemId: String(item?.stockItemId ?? ""),
        fishCode: String(item?.fishCode ?? stockItem?.code ?? ""),
        productName: String(product?.name ?? "商品已删除"),
        size: String(product?.size ?? ""),
        origin: String(product?.origin ?? ""),
        price: roundFinance(item?.price),
        minReturnPrice: roundFinance(item?.minReturnPrice),
        minReturnPriceExempt: item?.minReturnPriceExempt === true,
        inventoryRemoved: Boolean(item?.inventoryRemovedAt) || !stockItem,
      };
    });
    return {
      id: String(order?.id ?? ""),
      siteId: normalizeSiteId(order?.siteId),
      orderNo: String(order?.orderNo ?? ""),
      douyinOrderNo: externalOrderNo,
      platformOrderNo,
      date: String(order?.date ?? ""),
      orderStatus: String(order?.status ?? ""),
      source: String(order?.source ?? ""),
      customerName: String(customer?.name ?? (platformOrderNo ? `${orderSourceLabel(order?.source)}客户` : "未关联客户")),
      contactPerson: String(order?.contactPerson ?? ""),
      logisticsStatus: orderLogisticsStatusForFinance(order, shipments),
      financeStatus: financeStatusLabel(order, balance, received, hasPlatformSettlement, paymentTotals.pendingCount),
      paymentMethodId: String(order?.paymentMethodId ?? ""),
      paymentMethodName: String(order?.paymentMethodName ?? ""),
      paymentChannel: normalizePaymentChannel(order?.paymentChannel),
      paymentAccount: String(order?.paymentAccount ?? ""),
      paymentReference: String(order?.paymentReference ?? ""),
      receivable,
      ...feeBreakdown,
      cancellationAdjustment,
      received,
      refunded,
      pendingReceived: roundFinance(paymentTotals.pendingReceived),
      pendingRefunded: roundFinance(paymentTotals.pendingRefunded),
      pendingPaymentCount: paymentTotals.pendingCount,
      balance,
      platformIncome,
      platformFees,
      netSettlement,
      settlementCount: platformSettlements.length,
      ...commission,
      items,
      payments: (Array.isArray(order?.payments) ? order.payments : []).map((payment) => ({
        id: String(payment?.id ?? ""),
        time: String(payment?.time ?? ""),
        type: String(payment?.type ?? "other"),
        amount: roundFinance(payment?.amount),
        paymentMethodId: String(payment?.paymentMethodId ?? ""),
        paymentMethodName: String(payment?.paymentMethodName ?? ""),
        channel: normalizePaymentChannel(payment?.channel),
        account: String(payment?.account ?? ""),
        externalTransactionNo: String(payment?.externalTransactionNo ?? ""),
        statementId: String(payment?.statementId ?? ""),
        matchMethod: ["auto", "owner", "finance"].includes(String(payment?.matchMethod ?? ""))
          ? String(payment.matchMethod)
          : "",
        verificationStatus: paymentVerificationStatus(payment),
        recordSource: ["order", "finance", "platform", "statement"].includes(String(payment?.recordSource ?? ""))
          ? String(payment.recordSource)
          : "finance",
        refundMethod: payment?.type === "refund"
          ? ["platform", "account"].includes(String(payment?.refundMethod ?? ""))
            ? String(payment.refundMethod)
            : refundMethodForChannel(payment?.channel)
          : undefined,
        recordedBy: String(payment?.recordedBy ?? ""),
        verifiedAt: String(payment?.verifiedAt ?? ""),
        verifiedBy: String(payment?.verifiedBy ?? ""),
        proof: Array.isArray(payment?.proof) ? payment.proof : [],
        notes: String(payment?.notes ?? ""),
      })),
    };
  });

  const orderLookup = financeOrderLookup(orders);
  const reconciliationRows = [...settlementsByExternalOrderNo.entries()]
    .map(([externalOrderNo, records]) => {
      const matchedOrder = orderLookup.get(externalOrderNo);
      const incomeTotal = roundFinance(records.reduce((sum, item) => sum + Number(item?.incomeTotal ?? 0), 0));
      const orderTotal = roundFinance(records.reduce((sum, item) => sum + Number(item?.orderTotal ?? 0), 0));
      const refundTotal = roundFinance(records.reduce(
        (sum, item) => sum + Math.abs(Number(item?.preSettlementRefund ?? 0)),
        0
      ));
      const platformFees = roundFinance(records.reduce(
        (sum, item) => sum + Math.abs(Number(item?.expenseTotal ?? 0)),
        0
      ));
      const settlementAmount = roundFinance(records.reduce(
        (sum, item) => sum + Number(item?.settlementAmount ?? 0),
        0
      ));
      const systemReceivable = matchedOrder
        ? matchedOrder?.status === "cancelled"
          ? 0
          : calcAmountDueForOrder(matchedOrder, shipments)
        : null;
      const difference = systemReceivable == null ? null : roundFinance(systemReceivable - incomeTotal);
      return {
        externalOrderNo,
        internalOrderId: matchedOrder ? String(matchedOrder.id ?? "") : "",
        internalOrderNo: matchedOrder ? String(matchedOrder.orderNo ?? "") : "",
        contactPerson: matchedOrder ? String(matchedOrder.contactPerson ?? "") : "",
        settlementTime: records.map((item) => String(item?.settlementTime ?? "")).sort().at(-1) ?? "",
        productName: [...new Set(records.map((item) => String(item?.productName ?? "")).filter(Boolean))].join("、"),
        settlementCount: records.length,
        orderTotal,
        incomeTotal,
        refundTotal,
        platformFees,
        settlementAmount,
        systemReceivable,
        difference,
        status: !matchedOrder ? "未匹配" : Math.abs(difference ?? 0) <= 0.01 ? "已匹配" : "有差异",
        formulaMatches: records.every((item) => item?.formulaMatches !== false),
      };
    })
    .sort((left, right) => String(right.settlementTime).localeCompare(String(left.settlementTime)));

  const transactions = orderRows.flatMap((order) =>
    order.payments.map((payment) => ({
      ...payment,
      orderId: order.id,
      orderNo: order.orderNo,
      customerName: order.customerName,
      contactPerson: order.contactPerson,
      source: order.source,
    }))
  ).sort((left, right) => String(right.time).localeCompare(String(left.time)));
  const orderRowsById = new Map(orderRows.map((order) => [order.id, order]));
  const statements = statementRows.map(paymentStatementFromRow).map((statement) => {
    const matchedOrder = orderRowsById.get(statement.matchedOrderId);
    return {
      ...statement,
      matchedOrderNo: matchedOrder?.orderNo ?? "",
      matchedCustomerName: matchedOrder?.customerName ?? "",
      matchedContactPerson: matchedOrder?.contactPerson ?? "",
      candidates: statement.candidates.map((candidate) => {
        const order = orderRowsById.get(String(candidate?.orderId ?? ""));
        return {
          ...candidate,
          orderNo: order?.orderNo ?? String(candidate?.orderNo ?? ""),
          customerName: order?.customerName ?? String(candidate?.customerName ?? ""),
          contactPerson: order?.contactPerson ?? String(candidate?.contactPerson ?? ""),
        };
      }),
    };
  });

  const settlementTotal = roundFinance(settlements.reduce(
    (sum, settlement) => sum + Number(settlement?.settlementAmount ?? 0),
    0
  ));
  const unmatchedSettlementCount = reconciliationRows.filter((row) => row.status === "未匹配").length;
  const manualActualInflow = roundFinance(orderRows
    .filter((order) => order.settlementCount === 0)
    .reduce((sum, order) => sum + order.received, 0));
  const manualRefunded = roundFinance(orderRows
    .filter((order) => order.settlementCount === 0)
    .reduce((sum, order) => sum + order.refunded, 0));
  const platformRefunded = roundFinance(settlements.reduce(
    (sum, settlement) => sum + Math.abs(Number(settlement?.preSettlementRefund ?? 0)),
    0
  ));
  const summary = {
    receivable: roundFinance(orderRows.reduce((sum, order) => sum + order.receivable, 0)),
    actualInflow: roundFinance(manualActualInflow + settlementTotal),
    refunded: roundFinance(manualRefunded + platformRefunded),
    platformFees: roundFinance(settlements.reduce(
      (sum, settlement) => sum + Math.abs(Number(settlement?.expenseTotal ?? 0)),
      0
    )),
    netSettlement: roundFinance(manualActualInflow - manualRefunded + settlementTotal),
    unreconciledOrders: orderRows.filter((order) =>
      order.financeStatus !== "已核销" && order.financeStatus !== "已取消"
    ).length,
    commissionTotal: roundFinance(orderRows.reduce((sum, order) => sum + order.commissionAmount, 0)),
    unmatchedSettlementCount,
    unmatchedStatementCount: statements.filter((statement) => statement.matchStatus === "unmatched").length,
  };

  return {
    settings: { defaultCommissionRate },
    summary,
    orders: orderRows.sort((left, right) =>
      String(right.date).localeCompare(String(left.date)) || String(right.orderNo).localeCompare(String(left.orderNo))
    ),
    transactions,
    reconciliations: reconciliationRows,
    importBatches: batchRows.map((row) => ({
      id: String(row?.id ?? ""),
      siteId: String(row?.site_id ?? ""),
      fileName: String(row?.file_name ?? ""),
      fileHash: String(row?.file_hash ?? ""),
      importedAt: row?.imported_at ? new Date(row.imported_at).toISOString() : "",
      importedBy: String(row?.imported_by ?? ""),
      rowCount: Number(row?.row_count ?? 0),
      matchedCount: Number(row?.matched_count ?? 0),
      unmatchedCount: Number(row?.unmatched_count ?? 0),
      duplicateCount: Number(row?.duplicate_count ?? 0),
      totals: row?.totals && typeof row.totals === "object" ? row.totals : {},
    })),
    transfers: transferRows.map(financeTransferFromRow),
    statements,
    statementImportBatches: statementBatchRows.map(statementImportBatchFromRow),
  };
}

function financeSiteScope(state = {}, account = {}, requestedSiteId = ALL_SITE_ID) {
  const visibleSiteIds = visibleSiteIdsForAccount(account, state);
  const requested = normalizeSiteScope(requestedSiteId || ALL_SITE_ID);
  if (requested !== ALL_SITE_ID && !visibleSiteIds.includes(requested)) {
    throw new Error("当前账户无权查看该场地财务数据");
  }
  const scopedState = requested === ALL_SITE_ID
    ? siteVisibilityFilteredState(state, account)
    : siteFilteredState(state, requested);
  return {
    requested,
    visibleSiteIds,
    siteIds: requested === ALL_SITE_ID ? visibleSiteIds : [requested],
    state: scopedState,
  };
}

function orderPermissionAllowedForAccount(account = {}, action = "update") {
  return hasModulePermission(account, "orders", action);
}

function requireOrderPermissionForAuth(req, action = "update") {
  if (!orderPermissionAllowedForAccount(req.auth?.account, action)) {
    throw new Error("当前账号没有订单模块的操作权限");
  }
}

function normalizeStockLookupCode(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[－–—]/g, "-")
    .replace(/\s+/g, "")
    .replace(/[-_]/g, "");
}

function stockMatchesLookupCode(stockItem = {}, lookupCode = "") {
  const code = normalizeStockLookupCode(lookupCode);
  if (!code) return false;
  return [stockItem?.code, stockItem?.id]
    .map(normalizeStockLookupCode)
    .filter(Boolean)
    .some((token) => token === code);
}

function findOrderStockItemByInput(state = {}, input = {}, expectedSiteId = DEFAULT_SITE_ID) {
  const rawStockId = String(input.stockItemId ?? "").trim();
  const rawLookupCode = String(input.fishCode ?? input.code ?? rawStockId).trim();
  if (!rawStockId && !rawLookupCode) throw new Error("Order item stockItemId is required");

  const stock = Array.isArray(state.stock) ? state.stock : [];
  const byId = rawStockId
    ? stock.find((item) => String(item?.id ?? "") === rawStockId)
    : undefined;
  if (byId) return byId;

  const codeMatches = rawLookupCode
    ? stock.filter((item) => stockMatchesLookupCode(item, rawLookupCode))
    : [];
  if (codeMatches.length === 0) {
    throw new Error(`库存鱼不存在或已被删除：${rawLookupCode || rawStockId}`);
  }

  const siteMatches = codeMatches.filter((item) => stockSiteId(state, item) === expectedSiteId);
  if (siteMatches.length === 1) return siteMatches[0];
  if (siteMatches.length > 1) {
    throw new Error(`鱼编号「${rawLookupCode}」对应 ${siteMatches.length} 条库存鱼，请从搜索结果中点选具体鱼`);
  }
  throw new Error("不能跨场地选择库存鱼");
}

function normalizeOrderItemInput(state = {}, input = {}, options = {}) {
  const expectedSiteId = normalizeSiteId(options.siteId);
  const stockItem = findOrderStockItemByInput(state, input, expectedSiteId);
  const stockId = String(stockItem?.id ?? "").trim();
  if (stockSiteId(state, stockItem) !== expectedSiteId) {
    throw new Error("不能跨场地选择库存鱼");
  }
  const stockInOtherOrders = options.activeOrderIds ?? orderActiveStockIds(state, options.excludeOrderId);
  const stockInShipments = options.activeShipmentIds ?? shipmentActiveStockIds(state, options.excludeShipmentId);
  if (stockInOtherOrders.has(stockId)) throw new Error("所选鱼已被其他订单占用，请刷新后重选");
  if (stockInShipments.has(stockId)) throw new Error("所选鱼已出库或发货，不能再次加入订单");
  if (!isPhysicallyInTank(stockItem, shippedOutStockIds(state))) throw new Error("所选鱼已不在缸内，不能加入订单");

  const productId = String(stockItem.productId ?? input.productId ?? "").trim();
  const product = findProductById(state, productId);
  const price = normalizeMoney(input.price ?? stockItem.basePrice, "Order item price");
  const minReturnPriceExempt = sickMinimumReturnExemption(stockItem);
  return {
    stockItemId: stockId,
    fishCode: String(stockItem?.code ?? "").trim(),
    productId,
    price,
    minReturnPrice: normalizeMinReturnPrice(input.minReturnPrice ?? product?.minReturnPrice ?? 0),
    ...(minReturnPriceExempt ? {
      minReturnPriceExempt: true,
      minReturnPriceExemptReason: "sick",
    } : {}),
    commissionRate: 0,
  };
}

function paymentMethodAllowedForOrderSource(method, source) {
  const requiredPlatformChannel = platformPaymentChannelForOrderSource(source);
  return requiredPlatformChannel
    ? method?.channel === requiredPlatformChannel
    : !isPlatformPaymentChannel(method?.channel);
}

function normalizeOrderMutationInput(state = {}, body = {}, currentOrder = null) {
  const incomingSiteId = body.siteId === ALL_SITE_ID ? DEFAULT_SITE_ID : body.siteId;
  const siteId = normalizeSiteId(incomingSiteId ?? currentOrder?.siteId);
  if (currentOrder && siteId !== normalizeSiteId(currentOrder.siteId)) {
    throw new Error("订单所属场地不能修改；如需调整，请取消原订单后在正确场地重新创建");
  }
  const date = String(body.date ?? currentOrder?.date ?? "").trim();
  if (!date) throw new Error("下单日期不能为空");
  if (date > todayInChina()) throw new Error("下单日期不能晚于今天");
  const hasSourceInput = Object.prototype.hasOwnProperty.call(body, "source");
  const source = String(body.source ?? currentOrder?.source ?? "").trim();
  if (!source && (!currentOrder || hasSourceInput)) throw new Error("请选择订单来源");
  if (source && !ORDER_SOURCE_VALUES.has(source)) throw new Error("请选择有效订单来源");
  const isPlatformOrder = isPlatformOrderSource(source);
  const isPickupOrder = source === "线下";
  const requestedCustomerId = String(body.customerId ?? currentOrder?.customerId ?? "").trim();
  const customerExists = (Array.isArray(state.customers) ? state.customers : [])
    .some((customer) => String(customer?.id ?? "") === requestedCustomerId);
  if (!isPlatformOrder && (!requestedCustomerId || !customerExists)) throw new Error("请选择有效客户");
  const customerId = isPlatformOrder ? "" : requestedCustomerId;
  const platformOrderNo = isPlatformOrder
    ? String(body.platformOrderNo ?? body.douyinOrderNo ?? platformOrderNoForOrder(currentOrder)).trim()
    : "";
  if (isPlatformOrder && !platformOrderNo) throw new Error(`请填写${platformOrderNoLabel(source)}`);
  if (isPlatformOrder) {
    const duplicateOrder = (Array.isArray(state.orders) ? state.orders : []).find((order) =>
      String(order?.id ?? "") !== String(currentOrder?.id ?? "") &&
      String(order?.source ?? "").trim() === source &&
      platformOrderNoForOrder(order).toLowerCase() === platformOrderNo.toLowerCase()
    );
    if (duplicateOrder) throw new Error(`${platformOrderNoLabel(source)}已存在：${platformOrderNo}`);
  }
  const sourceChanged = Boolean(currentOrder) && String(currentOrder?.source ?? "").trim() !== source;
  const requestedPaymentMethodId = String(body.paymentMethodId ?? "").trim();
  const requestedPaymentChannel = isPlatformOrder
    ? platformPaymentChannelForOrderSource(source)
    : normalizePaymentChannel(body.paymentChannel ?? currentOrder?.paymentChannel);
  if ((body.paymentChannel ?? currentOrder?.paymentChannel) && !requestedPaymentChannel) {
    throw new Error("请选择有效付款方式");
  }
  if (!requestedPaymentMethodId && !requestedPaymentChannel) throw new Error("请选择付款方式");
  const currentPaymentMethodId = String(currentOrder?.paymentMethodId ?? "").trim();
  const currentPaymentMethodName = String(currentOrder?.paymentMethodName ?? "").trim();
  const currentPaymentChannel = normalizePaymentChannel(currentOrder?.paymentChannel);
  const currentPaymentAccount = String(currentOrder?.paymentAccount ?? "").trim();
  const preserveCurrentPayment = Boolean(currentOrder) &&
    !sourceChanged &&
    Boolean(currentPaymentChannel) &&
    Boolean(currentPaymentAccount) &&
    currentPaymentChannel === requestedPaymentChannel &&
    (!requestedPaymentMethodId || requestedPaymentMethodId === currentPaymentMethodId);
  const paymentMethod = preserveCurrentPayment
    ? null
    : configuredPaymentMethod(state.systemSettings, requestedPaymentMethodId || requestedPaymentChannel);
  if (!preserveCurrentPayment && !paymentMethod) {
    const selectorLabel = requestedPaymentChannel ? paymentChannelLabel(requestedPaymentChannel) : requestedPaymentMethodId;
    throw new Error(`付款方式「${selectorLabel}」未启用或未配置收款账户，请联系管理员处理`);
  }
  const paymentChannel = preserveCurrentPayment ? currentPaymentChannel : paymentMethod.channel;
  if (!paymentMethodAllowedForOrderSource({ channel: paymentChannel }, source)) {
    throw new Error(isPlatformOrder
      ? `${orderSourceLabel(source)}订单只能选择${orderSourceLabel(source)}付款方式`
      : "非平台订单不能选择平台付款方式");
  }
  const paymentMethodId = preserveCurrentPayment ? currentPaymentMethodId : paymentMethod.id;
  const paymentMethodName = preserveCurrentPayment
    ? currentPaymentMethodName || paymentChannelLabel(currentPaymentChannel)
    : paymentMethod.name;
  const paymentAccount = preserveCurrentPayment ? currentPaymentAccount : paymentMethod.account;
  const paymentReference = String(currentOrder?.paymentReference ?? "").trim();
  const shippingAddress = source === "私域线上"
    ? String(body.shippingAddress ?? currentOrder?.shippingAddress ?? "").trim()
    : "";
  const plannedShipDate = isPickupOrder
    ? ""
    : String(body.plannedShipDate ?? currentOrder?.plannedShipDate ?? "").trim();
  if (!isPickupOrder && !plannedShipDate) throw new Error("请选择预计发货日期");
  if (plannedShipDate && plannedShipDate < date) throw new Error("预计发货日期不能早于下单日期");
  const contact = normalizeOrderContactPersonnel(state, body, currentOrder);
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
    const matchingStock = (Array.isArray(state.stock) ? state.stock : [])
      .filter((stock) => String(stock?.id ?? "") === stockId);
    if (matchingStock.length > 1) throw new Error(`库存鱼 ID 不唯一，订单暂不能修改：${stockId}`);
    const stockItem = matchingStock[0];
    const existingItem = (Array.isArray(currentOrder?.items) ? currentOrder.items : [])
      .find((orderItem) => String(orderItem?.stockItemId ?? "") === stockId);
    if (!stockItem && !existingItem) throw new Error(`库存鱼不存在或已被删除：${stockId}`);
    if (stockItem && stockSiteId(state, stockItem) !== siteId) {
      throw new Error("订单商品与所属场地不一致，请先移除错误场地的商品");
    }
    const productId = String(stockItem?.productId ?? existingItem?.productId ?? item?.productId ?? "").trim();
    const product = findProductById(state, productId);
    const inventoryRemovedAt = String(existingItem?.inventoryRemovedAt ?? "").trim();
    const inventoryRemovedBy = String(existingItem?.inventoryRemovedBy ?? "").trim();
    const fishCode = String(stockItem?.code ?? existingItem?.fishCode ?? item?.fishCode ?? "").trim();
    const minReturnPriceExempt = sickMinimumReturnExemption(stockItem, existingItem);
    return {
      stockItemId: stockId,
      ...(fishCode ? { fishCode } : {}),
      productId,
      price: normalizeMoney(item.price ?? existingItem?.price, "Order item price"),
      minReturnPrice: normalizeMinReturnPrice(item.minReturnPrice ?? existingItem?.minReturnPrice ?? product?.minReturnPrice ?? 0),
      ...(minReturnPriceExempt ? {
        minReturnPriceExempt: true,
        minReturnPriceExemptReason: "sick",
      } : {}),
      commissionRate: 0,
      ...(inventoryRemovedAt ? { inventoryRemovedAt } : {}),
      ...(inventoryRemovedBy ? { inventoryRemovedBy } : {}),
    };
  });
  const normalizedItemIds = items.map((item) => String(item?.stockItemId ?? "")).filter(Boolean);
  if (new Set(normalizedItemIds).size !== normalizedItemIds.length) {
    throw new Error("订单内不能重复选择同一条鱼");
  }
  const requestedShippingFeeMode = body.shippingFeeMode ?? currentOrder?.shippingFeeMode;
  if (!isPickupOrder && requestedShippingFeeMode != null && !["collect", "prepaid", "free"].includes(String(requestedShippingFeeMode))) {
    throw new Error("请选择有效运费方式");
  }
  const shippingFeeMode = normalizeShippingFeeMode(requestedShippingFeeMode, source);
  if (
    currentOrder &&
    shippingFeeMode !== normalizeShippingFeeMode(currentOrder.shippingFeeMode, currentOrder.source) &&
    (Array.isArray(state.shipments) ? state.shipments : []).some((shipment) =>
      String(shipment?.orderId ?? "") === String(currentOrder.id ?? "") && shipmentBlocksInventory(shipment)
    )
  ) {
    throw new Error("订单已经出库，不能再修改运费方式");
  }
  const shippingFee = shippingFeeMode === "collect"
    ? 0
    : normalizeMoney(body.shippingFee ?? currentOrder?.shippingFee, "Shipping fee");
  const packagingFee = currentOrder
    ? normalizeMoney(currentOrder.packagingFee ?? configuredOrderPackagingFee(state.systemSettings), "Packaging fee")
    : configuredOrderPackagingFee(state.systemSettings);
  const discount = normalizeMoney(body.discount ?? currentOrder?.discount, "Discount");
  const itemsTotal = items.reduce((sum, item) => sum + item.price, 0);
  const minimumReturnTotal = orderMinimumReturnFloorTotal(items);
  const goodsNetTotal = Number((itemsTotal - discount).toFixed(2));
  const customerShippingFee = shippingFeeMode === "prepaid" ? shippingFee : 0;
  if (itemsTotal + customerShippingFee + packagingFee - discount < -0.005) {
    throw new Error("折扣过大，应付金额不能为负数");
  }
  if (goodsNetTotal <= minimumReturnTotal + 0.005) {
    throw new Error(`商品折后金额必须高于最低回厂价合计 ¥${minimumReturnTotal.toFixed(2)}`);
  }
  return {
    siteId,
    customerId,
    date,
    source,
    platformOrderNo: platformOrderNo || undefined,
    douyinOrderNo: source === "平台下单" ? platformOrderNo : "",
    paymentMethodId: paymentMethodId || undefined,
    paymentMethodName,
    paymentChannel: paymentChannel || undefined,
    paymentAccount,
    paymentReference,
    shippingAddress,
    plannedShipDate: plannedShipDate || undefined,
    ...contact,
    items,
    shippingFeeMode,
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
      if (!orderItemKeepsInventory(item)) continue;
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

function validateOrderShippingFeesRecorded(order = {}, shipments = []) {
  const mode = normalizeShippingFeeMode(order?.shippingFeeMode, order?.source);
  const relatedShipments = (Array.isArray(shipments) ? shipments : []).filter((shipment) =>
    String(shipment?.orderId ?? "") === String(order?.id ?? "") && countsAsCompletionShipment(shipment)
  );
  if (shipmentsHavePendingActualShippingFee(mode, relatedShipments)) {
    throw new Error(`${mode === "free" ? "包邮" : "寄付"}订单尚有发货单未填写实际运费，不能完成订单`);
  }
}

function validateOrderCanComplete(order = {}, shipments = []) {
  const activeShipments = shipments.filter((shipment) =>
    String(shipment?.orderId ?? "") === String(order.id ?? "") && countsAsCompletionShipment(shipment)
  );
  const shippedIds = new Set(activeShipments.flatMap((shipment) =>
    Array.isArray(shipment?.itemStockIds) ? shipment.itemStockIds.map((id) => String(id)) : []
  ));
  const orderItems = (Array.isArray(order.items) ? order.items : []).filter(orderItemKeepsInventory);
  if (orderItems.length === 0 || !orderItems.every((item) => shippedIds.has(String(item?.stockItemId ?? "")))) {
    throw new Error("订单尚有商品未发货，不能标记完成");
  }
  const allShipmentsResolved = activeShipments.length > 0 && activeShipments.every(shipmentIsResolvedForCompletion);
  if (!allShipmentsResolved) {
    throw new Error("订单仍有未签收或未处理的发货，不能标记完成");
  }
  validateOrderShippingFeesRecorded(order, shipments);
  const paymentGate = shipmentPaymentGateForOrder(order, shipments);
  if (!paymentGate.canShip) {
    throw new Error(`订单尚有 ¥${paymentGate.outstandingAmount.toFixed(2)} 未核销，不能标记完成`);
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
  let paymentBlockedCount = 0;
  let notificationCount = 0;
  let nextNotifications = currentStationNotifications(state);

  const nextShipments = shipments.map((shipment) => {
    const status = String(shipment?.status ?? "");
    if (status === "outbound") {
      const outboundDate = datePart(shipment.outboundDate || shipment.createdAt || shipment.shipDate);
      if (isDateOnOrBefore(outboundDate, outboundThreshold)) {
        const order = orders.find((item) => String(item?.id ?? "") === String(shipment?.orderId ?? ""));
        const gate = order ? shipmentPaymentGateForOrder(order, shipments) : null;
        if (gate && !gate.canShip) {
          paymentBlockedCount += 1;
          try {
            const ensured = ensureOrderCreditSaleNotifications(
              { ...state, notifications: nextNotifications },
              order,
              gate,
              "system"
            );
            nextNotifications = ensured.notifications;
            if (ensured.changed) notificationCount += 1;
          } catch (error) {
            console.warn(`[auto-orders] failed to notify order ${order?.orderNo ?? order?.id}: ${error.message}`);
          }
          return shipment;
        }
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
        const order = orders.find((item) => String(item?.id ?? "") === String(shipment?.orderId ?? ""));
        const mode = normalizeShippingFeeMode(order?.shippingFeeMode, order?.source);
        if (order && shipmentHasPendingActualShippingFee(mode, shipment)) {
          return shipment;
        }
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
    const deliveredShipments = orderShipments.filter(shipmentIsResolvedForCompletion);
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

  const changed = autoShippedCount > 0 || autoDeliveredCount > 0 || autoCompletedCount > 0 || notificationCount > 0;
  if (!changed) {
    return {
      changed: false,
      state,
      summary: { autoShippedCount, autoDeliveredCount, autoCompletedCount, paymentBlockedCount, notificationCount },
    };
  }

  const details = [
    autoShippedCount > 0 ? `出库满 3 天自动确认发货 ${autoShippedCount} 单` : "",
    autoDeliveredCount > 0 ? `发货满 5 天自动签收 ${autoDeliveredCount} 单` : "",
    autoCompletedCount > 0 ? `签收满 3 天自动完成订单 ${autoCompletedCount} 单` : "",
    notificationCount > 0 ? `未核销订单发送赊销确认站内信 ${notificationCount} 条` : "",
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
      notifications: nextNotifications,
      operationLogs: pushOperationLog(state.operationLogs, operationLog),
    },
    operationLog,
    summary: { autoShippedCount, autoDeliveredCount, autoCompletedCount, paymentBlockedCount, notificationCount },
  };
}

const ORDER_STATUS_VALUES = new Set(["pending", "shipped", "completed", "cancelled", "damaged"]);
const ORDER_MUTABLE_FIELD_KEYS = new Set([
  "siteId",
  "customerId",
  "date",
  "source",
  "platformOrderNo",
  "douyinOrderNo",
  "paymentMethodId",
  "paymentMethodName",
  "paymentChannel",
  "paymentAccount",
  "paymentReference",
  "shippingAddress",
  "plannedShipDate",
  "contactPersonnelId",
  "contactPerson",
  "items",
  "shippingFeeMode",
  "shippingFee",
  "packagingFee",
  "discount",
  "notes",
]);

function orderMutableFieldsComparable(order = {}, state = {}, currentOrder = null) {
  return {
    siteId: normalizeSiteId(order.siteId),
    customerId: String(order.customerId ?? "").trim(),
    date: String(order.date ?? "").trim(),
    source: String(order.source ?? "").trim(),
    platformOrderNo: platformOrderNoForOrder(order),
    douyinOrderNo: String(order.douyinOrderNo ?? "").trim(),
    paymentMethodId: String(order.paymentMethodId ?? "").trim() || undefined,
    paymentMethodName: String(order.paymentMethodName ?? "").trim(),
    paymentChannel: normalizePaymentChannel(order.paymentChannel) || undefined,
    paymentAccount: String(order.paymentAccount ?? "").trim(),
    paymentReference: String(order.paymentReference ?? "").trim(),
    shippingAddress: String(order.shippingAddress ?? "").trim(),
    plannedShipDate: String(order.plannedShipDate ?? "").trim() || undefined,
    contactPersonnelId: String(order.contactPersonnelId ?? "").trim() || undefined,
    contactPerson: String(order.contactPerson ?? "").trim(),
    items: (Array.isArray(order.items) ? order.items : []).map((item) => {
      const stockItemId = String(item?.stockItemId ?? "").trim();
      const productId = String(item?.productId ?? "").trim();
      const existingItem = (Array.isArray(currentOrder?.items) ? currentOrder.items : [])
        .find((orderItem) => String(orderItem?.stockItemId ?? "") === stockItemId);
      const product = findProductById(state, productId || existingItem?.productId);
      const inventoryRemovedAt = String(existingItem?.inventoryRemovedAt ?? item?.inventoryRemovedAt ?? "").trim();
      const inventoryRemovedBy = String(existingItem?.inventoryRemovedBy ?? item?.inventoryRemovedBy ?? "").trim();
      const stockItem = (Array.isArray(state.stock) ? state.stock : [])
        .find((stock) => String(stock?.id ?? "") === stockItemId);
      const fishCode = String(stockItem?.code ?? existingItem?.fishCode ?? item?.fishCode ?? "").trim();
      const minReturnPriceExempt = sickMinimumReturnExemption(stockItem, existingItem);
      return {
        stockItemId,
        ...(fishCode ? { fishCode } : {}),
        productId,
        price: normalizeMoney(item?.price, "Order item price"),
        minReturnPrice: normalizeMinReturnPrice(item?.minReturnPrice ?? existingItem?.minReturnPrice ?? product?.minReturnPrice ?? 0),
        ...(minReturnPriceExempt ? {
          minReturnPriceExempt: true,
          minReturnPriceExemptReason: "sick",
        } : {}),
        commissionRate: 0,
        ...(inventoryRemovedAt ? { inventoryRemovedAt } : {}),
        ...(inventoryRemovedBy ? { inventoryRemovedBy } : {}),
      };
    }),
    shippingFeeMode: normalizeShippingFeeMode(order.shippingFeeMode, order.source),
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
  if (stableJson(normalized) !== stableJson(orderMutableFieldsComparable(nextOrder, nextState, currentOrder))) {
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
  if (from !== "delivered" && from !== "shipped" && to === "delivered" && proof.length < 2) {
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
      requireModulePermissionForAuth(req, "finance", paymentAction);
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
    const relatedOrder = nextOrdersById.get(String(nextShipment.orderId ?? ""));
    assertShipmentInventoryIdentityUnchanged(currentShipment, nextShipment, {
      expectedSiteId: relatedOrder?.siteId,
    });
    const validateAssignment = shipmentPatchRequiresAssignmentValidation(
      currentShipment,
      nextShipment,
      {
        orders: currentOrders,
        stock: current.stock,
      },
    );
    if (validateAssignment) {
      assertActiveShipmentInventoryAssignment(nextShipment, {
        orders: nextOrders,
        stock: next.stock,
      });
    }
    if (actualShippingFeeValuesDiffer(currentShipment.actualShippingFee, nextShipment.actualShippingFee)) {
      throw new Error("实际运费必须通过补录运费专用接口修改");
    }
    requireOrderPermissionForAuth(req, "update");
    if (relatedOrder?.status === "completed" || relatedOrder?.status === "cancelled") {
      throw new Error("已完成或已取消订单不能修改发货状态");
    }
    if (String(nextShipment.shipMethod ?? "express") === "express") {
      const nextCarrier = String(nextShipment.carrier ?? "").trim();
      const resolvedCarrier = resolveShippingCarrier(
        next.systemSettings,
        nextCarrier,
        currentShipment.carrier
      );
      if (resolvedCarrier !== nextCarrier) throw new Error("快递公司必须从后台启用项中选择");
    }
    validateShipmentPatchTransition(currentShipment, nextShipment);
    const relatedShippingFeeMode = relatedOrder
      ? normalizeShippingFeeMode(relatedOrder.shippingFeeMode, relatedOrder.source)
      : "collect";
    if (
      String(nextShipment.status ?? "") === "delivered" &&
      relatedOrder &&
      shipmentHasPendingActualShippingFee(relatedShippingFeeMode, nextShipment)
    ) {
      throw new Error(`${relatedShippingFeeMode === "free" ? "包邮" : "寄付"}订单确认签收前必须补录实际运费`);
    }
    if (
      String(currentShipment.status ?? "") === "outbound" &&
      ["shipped", "delivered"].includes(String(nextShipment.status ?? "")) &&
      relatedOrder
    ) {
      const gate = shipmentPaymentGateForOrder(relatedOrder, nextShipments);
      if (!gate.canShip) throw new Error(`订单尚有 ¥${gate.outstandingAmount.toFixed(2)} 未核销，不能确认发货`);
    }
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
        if (!orderItemKeepsInventory(item)) continue;
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

function getCosClient(purpose = "download") {
  if (!cosReady()) return null;
  if (purpose === "upload") {
    cosUploadClient ??= new COS({
      SecretId: cosConfig.secretId,
      SecretKey: cosConfig.secretKey,
      Timeout: COS_UPLOAD_TIMEOUT_MS,
    });
    return cosUploadClient;
  }
  cosDownloadClient ??= new COS({
    SecretId: cosConfig.secretId,
    SecretKey: cosConfig.secretKey,
    Timeout: COS_REQUEST_TIMEOUT_MS,
  });
  return cosDownloadClient;
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

async function sendCosObject(req, res, key, cacheControl = "private, max-age=3600", options = {}) {
  const client = getCosClient("download");
  if (!client) {
    sendJson(req, res, 503, { error: "COS is not configured" });
    return;
  }
  const requestedRange = normalizeSingleByteRange(options.wechatVideo ? "" : req.headers.range);
  if (!requestedRange.valid) {
    res.writeHead(416, {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }
  let releaseTranscodeSlot = null;
  let releasePublicMediaSlot = null;
  let mediaOperationExpired = false;
  const acquisitionAbort = new AbortController();
  const abortAcquisition = () => acquisitionAbort.abort();
  let abortListenersAttached = true;
  const removeAbortListeners = () => {
    if (!abortListenersAttached) return;
    abortListenersAttached = false;
    req.removeListener("aborted", abortAcquisition);
    res.removeListener("close", abortAcquisition);
  };
  const releaseSlots = () => {
    removeAbortListeners();
    releaseTranscodeSlot?.();
    releasePublicMediaSlot?.();
  };
  const expireMediaOperation = (reason) => {
    const firstExpiration = !mediaOperationExpired;
    mediaOperationExpired = true;
    if (!acquisitionAbort.signal.aborted) acquisitionAbort.abort();
    releaseSlots();
    if (
      firstExpiration && reason === "timeout" &&
      !req.aborted && !res.destroyed && !res.headersSent
    ) {
      sendJson(req, res, 504, { error: "COS media request timed out" });
    }
  };
  req.once("aborted", abortAcquisition);
  res.once("close", abortAcquisition);
  try {
    if (options.publicMedia) {
      const inferredMime = String(mimeForExtension(extname(key)) ?? "");
      const limiter = inferredMime.startsWith("video/")
        ? publicVideoMediaLimiter
        : publicImageMediaLimiter;
      releasePublicMediaSlot = await limiter.acquire({
        signal: acquisitionAbort.signal,
        leaseTimeoutMs: PUBLIC_MEDIA_LEASE_TIMEOUT_MS,
        onLeaseExpired: expireMediaOperation,
      });
    }
    if (options.wechatVideo) {
      releaseTranscodeSlot = await videoTranscodeLimiter.acquire({
        signal: acquisitionAbort.signal,
        onLeaseExpired: expireMediaOperation,
      });
    }
  } catch (error) {
    releaseSlots();
    if (error?.name === "AbortError" || req.aborted || res.destroyed) return;
    sendJson(req, res, error?.statusCode || 503, {
      error: error.message || (options.publicMedia ? "公开媒体加载繁忙，请稍后重试" : "视频处理中，请稍后重试"),
    });
    return;
  }
  if (req.aborted || res.destroyed) {
    mediaOperationExpired = true;
    releaseSlots();
    return;
  }
  const isHeadRequest = req.method === "HEAD";
  const requestParams = {
    Bucket: cosConfig.bucket,
    Region: cosConfig.region,
    Key: key,
    ...(!isHeadRequest && requestedRange.present ? { Range: requestedRange.value } : {}),
  };
  const objectMethod = isHeadRequest ? "headObject" : "getObject";
  client[objectMethod](requestParams, (error, data = {}) => {
    if (mediaOperationExpired || req.aborted || res.destroyed) {
      releaseSlots();
      return;
    }
    if (error) {
      releaseSlots();
      const status = Number(error.statusCode || error.status) || 502;
      if (status === 416) {
        const contentRange = upstreamHeader(error.headers, "content-range");
        res.writeHead(416, {
          "Accept-Ranges": "bytes",
          "Cache-Control": cacheControl,
          ...(contentRange ? { "Content-Range": contentRange } : {}),
        });
        res.end();
        return;
      }
      sendJson(req, res, status === 404 ? 404 : 502, { error: "Failed to load COS object" });
      return;
    }
    const body = isHeadRequest ? Buffer.alloc(0) : (data.Body ?? Buffer.alloc(0));
    let contentType = data.ContentType || upstreamHeader(data.headers, "content-type") || mimeForExtension(extname(key));
    if (options.publicMedia) {
      contentType = safePublicMediaContentType(contentType, key);
      if (!contentType) {
        releaseSlots();
        sendJson(req, res, 415, { error: "Unsupported public media type" }, {
          "X-Content-Type-Options": "nosniff",
        });
        return;
      }
    }
    const safeHeaders = options.publicMedia ? { "X-Content-Type-Options": "nosniff" } : {};
    if (options.wechatVideo && String(contentType).startsWith("video/")) {
      transcodeVideoToWechatMp4(body, contentType, { slotAcquired: true })
        .then((mp4Buffer) => {
          if (mediaOperationExpired || req.aborted || res.destroyed) return;
          res._logicalResponseBytes = mp4Buffer.length;
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Content-Disposition": "inline; filename=\"wechat-video.mp4\"",
            "Cache-Control": cacheControl,
            ...safeHeaders,
          });
          res.end(mp4Buffer);
        })
        .catch((transcodeError) => {
          if (mediaOperationExpired || req.aborted || res.destroyed) return;
          console.warn(`Failed to transcode COS video ${key}: ${transcodeError.message}`);
          sendJson(req, res, 502, { error: "视频转码失败，请稍后重试" });
        })
        .finally(() => {
          releaseSlots();
        });
      return;
    }
    const delivery = cosObjectDelivery({
      bodyLength: Buffer.byteLength(body),
      cacheControl,
      contentLength: isHeadRequest
        ? (data.ContentLength || upstreamHeader(data.headers, "content-length"))
        : Buffer.byteLength(body),
      contentType,
      extraHeaders: safeHeaders,
      range: requestedRange.value,
      upstreamHeaders: data.headers,
      upstreamStatusCode: data.statusCode,
    });
    res._logicalResponseBytes = Buffer.byteLength(body);
    res.writeHead(delivery.statusCode, delivery.headers);
    if (isHeadRequest) {
      res.end(releaseSlots);
      return;
    }
    res.end(body, releaseSlots);
  });
}

async function signedCosObjectUrl(key, options = {}) {
  const client = getCosClient();
  if (!client) return "";
  const normalizedOptions = typeof options === "string"
    ? { queryString: options }
    : (options && typeof options === "object" ? options : {});
  return await new Promise((resolvePromise, rejectPromise) => {
    const params = {
      Bucket: cosConfig.bucket,
      Region: cosConfig.region,
      Key: key,
      Sign: true,
      Expires: Math.min(3600, Math.max(60, Number(normalizedOptions.expires) || 3600)),
    };
    if (normalizedOptions.queryString) params.QueryString = normalizedOptions.queryString;
    if (normalizedOptions.query && typeof normalizedOptions.query === "object") {
      params.Query = normalizedOptions.query;
    }
    client.getObjectUrl(params, (error, data = {}) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise(typeof data === "string" ? data : (data.Url || data.url || ""));
    });
  });
}

function mediaAttachmentDisposition(filename, fallbackExtension = ".bin") {
  const safeName = sanitizeAttachmentFilename(filename || `fishroom-media${fallbackExtension}`);
  const safeExtension = /^\.[a-z0-9]{1,8}$/i.test(extname(safeName))
    ? extname(safeName).toLowerCase()
    : fallbackExtension;
  return `attachment; filename="fishroom-media${safeExtension}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function httpError(statusCode, message, code = "") {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

async function requireBioRecordMediaDownloadAccess(req, {
  stockItemId,
  recordId,
  mediaUrl,
  mediaType,
}) {
  const { rows } = await pool.query(
    `WITH source AS MATERIALIZED (
       SELECT data
       FROM app_state
       WHERE id = $1
     ),
     target_stock AS MATERIALIZED (
       SELECT stock_item
       FROM source,
         LATERAL jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS stock_rows(stock_item)
       WHERE btrim(COALESCE(stock_item ->> 'id', '')) = $2
     ),
     target_record AS MATERIALIZED (
       SELECT record_item
       FROM source,
         LATERAL jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb)) AS record_rows(record_item)
       WHERE btrim(COALESCE(record_item ->> 'id', '')) = $3
         AND btrim(COALESCE(record_item ->> 'stockItemId', '')) = $2
     )
     SELECT
       data -> 'sites' AS sites,
       data -> 'tankGroups' AS tank_groups,
       (SELECT count(*)::int FROM target_stock) AS stock_item_count,
       (SELECT stock_item FROM target_stock LIMIT 1) AS stock_item,
       (SELECT count(*)::int FROM target_record) AS record_count,
       (SELECT record_item FROM target_record LIMIT 1) AS record_item
     FROM source`,
    [stateId, stockItemId, recordId]
  );
  const row = rows[0] ?? {};
  const stockItemCount = Number(row.stock_item_count ?? 0);
  const recordCount = Number(row.record_count ?? 0);
  if (stockItemCount > 1 || recordCount > 1) {
    throw httpError(409, "媒体关联记录不唯一，无法安全下载", "BIO_MEDIA_REFERENCE_CONFLICT");
  }
  const stockItem = row.stock_item && typeof row.stock_item === "object" ? row.stock_item : null;
  const record = row.record_item && typeof row.record_item === "object" ? row.record_item : null;
  if (!stockItem || !record) throw httpError(404, "媒体不存在或无权下载");

  const state = {
    sites: Array.isArray(row.sites) ? row.sites : [],
    tankGroups: Array.isArray(row.tank_groups) ? row.tank_groups : [],
    stock: [stockItem],
  };
  const stockSubTankId = String(stockItem.subTankId ?? "").trim();
  const matchingTankGroups = stockSubTankId
    ? state.tankGroups.filter((group) =>
        (Array.isArray(group?.subTanks) ? group.subTanks : [])
          .some((tank) => String(tank?.id ?? "").trim() === stockSubTankId)
      )
    : [];
  if (matchingTankGroups.length > 1) {
    throw httpError(409, "库存鱼缸位关联不唯一，无法安全下载", "BIO_MEDIA_SITE_CONFLICT");
  }
  const directSiteId = String(stockItem.siteId ?? "").trim();
  const tankSiteId = String(matchingTankGroups[0]?.siteId ?? "").trim();
  if (tankSiteId && directSiteId && tankSiteId !== directSiteId) {
    throw httpError(409, "库存鱼场地关联不一致，无法安全下载", "BIO_MEDIA_SITE_CONFLICT");
  }
  const stockSiteId = tankSiteId || directSiteId;
  const matchingSites = state.sites.filter((site) => String(site?.id ?? "").trim() === stockSiteId);
  if (!stockSiteId || matchingSites.length !== 1) {
    throw httpError(404, "媒体不存在或无权下载");
  }
  const visibleSiteIds = visibleSiteIdsForAccount(req.auth?.account, state);
  if (!canAccessBioStockSite({ account: req.auth?.account, visibleSiteIds, stockSiteId })) {
    throw httpError(404, "媒体不存在或无权下载");
  }

  const field = mediaType === "image" ? "photos" : "videos";
  const referenced = Array.isArray(record[field]) && record[field].some((value) => String(value ?? "") === mediaUrl);
  if (!referenced) throw httpError(404, "媒体不存在或无权下载");
}

function imagePreviewQuery(widthValue) {
  const width = Math.min(1200, Math.max(80, Number(widthValue) || 360));
  return `imageMogr2/thumbnail/${Math.round(width)}x/quality/70/ignore-error/1`;
}

const SUPPORTED_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-m4v",
  "video/3gpp",
  "video/3gpp2",
]);

function normalizeMediaMime(value) {
  return String(value ?? "").split(";", 1)[0].trim().toLowerCase();
}

function safePublicMediaContentType(contentType, key = "") {
  const supplied = normalizeMediaMime(contentType);
  if (isSafePublicMediaMime(supplied)) return supplied;
  const inferred = normalizeMediaMime(mimeForExtension(extname(key)));
  return isSafePublicMediaMime(inferred) ? inferred : "";
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

async function probeVideoFile(inputPath) {
  const { stdout } = await execFileAsync(FFPROBE_PATH, [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    inputPath,
  ], {
    timeout: Math.min(VIDEO_TRANSCODE_TIMEOUT_MS, 30_000),
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout || "{}");
}

async function prepareWechatVideoFile(inputPath, outputPath) {
  let fastRemux = false;
  let probeSucceeded = false;
  let selectedAudio = null;
  try {
    const probe = await probeVideoFile(inputPath);
    probeSucceeded = true;
    selectedAudio = selectWechatAudioStream(probe);
    fastRemux = canFastRemuxWechatVideo(probe, VIDEO_TRANSCODE_MAX_EDGE);
  } catch (error) {
    console.warn(`Video probe failed; falling back to transcoding: ${error.message}`);
  }

  const audioMapArgs = ({ withoutAudio = false } = {}) => {
    if (withoutAudio || (probeSucceeded && !selectedAudio)) return ["-an"];
    if (selectedAudio) return ["-map", `0:${selectedAudio.index}`];
    // ffprobe failure should not reject an otherwise valid upload. Try the
    // first audio stream, then fall back to a video-only transcode below.
    return ["-map", "0:a:0?"];
  };

  if (fastRemux) {
    try {
      await execFileAsync(FFMPEG_PATH, [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-map",
        "0:v:0",
        ...audioMapArgs(),
        "-c:v",
        "copy",
        ...(selectedAudio ? ["-c:a", "copy"] : []),
        "-movflags",
        "+faststart",
        outputPath,
      ], {
        timeout: VIDEO_TRANSCODE_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      return { outputPath, mode: "remux" };
    } catch (error) {
      console.warn(`Fast video remux failed; falling back to transcoding: ${error.message}`);
      await rm(outputPath, { force: true }).catch(() => undefined);
    }
  }

  const transcodeArgs = ({ withoutAudio = false } = {}) => [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-filter_threads",
      String(VIDEO_TRANSCODE_THREADS),
      "-filter_complex_threads",
      String(VIDEO_TRANSCODE_THREADS),
      "-i",
      inputPath,
      "-map",
      "0:v:0",
      ...audioMapArgs({ withoutAudio }),
      "-c:v",
      "libx264",
      "-threads:v",
      String(VIDEO_TRANSCODE_THREADS),
      "-preset",
      VIDEO_TRANSCODE_PRESET,
      "-crf",
      "23",
      "-vf",
      `scale='min(${VIDEO_TRANSCODE_MAX_EDGE},iw)':'min(${VIDEO_TRANSCODE_MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      "-pix_fmt",
      "yuv420p",
      "-profile:v",
      "main",
      "-level",
      "4.0",
      ...(!withoutAudio && (selectedAudio || !probeSucceeded)
        ? ["-c:a", "aac", "-b:a", "128k"]
        : []),
      "-movflags",
      "+faststart",
      outputPath,
  ];
  const execOptions = {
    timeout: VIDEO_TRANSCODE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  };
  try {
    await execFileAsync(FFMPEG_PATH, transcodeArgs(), execOptions);
    return { outputPath, mode: "transcode" };
  } catch (error) {
    const attemptedAudio = Boolean(selectedAudio) || !probeSucceeded;
    if (!attemptedAudio) throw error;
    console.warn(`Video audio transcode failed; retrying without audio: ${error.message}`);
    await rm(outputPath, { force: true }).catch(() => undefined);
    await execFileAsync(FFMPEG_PATH, transcodeArgs({ withoutAudio: true }), execOptions);
    return { outputPath, mode: "transcode-no-audio" };
  }
}

async function transcodeVideoToWechatMp4(buffer, sourceMime = "video/mp4", options = {}) {
  const releaseTranscodeSlot = options.slotAcquired ? null : await videoTranscodeLimiter.acquire();
  let tempDir = "";
  try {
    tempDir = await mkdtemp(join(tmpdir(), "fishroom-video-"));
    const inputPath = join(tempDir, `input${extensionForMime(sourceMime)}`);
    const outputPath = join(tempDir, "wechat.mp4");
    await writeFile(inputPath, buffer);
    await prepareWechatVideoFile(inputPath, outputPath);
    return await readFile(outputPath);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    releaseTranscodeSlot?.();
  }
}

async function uploadBufferToCos(buffer, mime, key) {
  const client = getCosClient("upload");
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

async function uploadFileToCos(filePath, mime, key) {
  const client = getCosClient("upload");
  if (!client) return null;
  const info = await stat(filePath);
  await new Promise((resolvePromise, rejectPromise) => {
    client.putObject({
      Bucket: cosConfig.bucket,
      Region: cosConfig.region,
      Key: key,
      Body: createReadStream(filePath),
      ContentLength: info.size,
      ContentType: mime || "application/octet-stream",
    }, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  });
  return objectUrlForKey(key);
}

async function shortFileHash(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex").slice(0, 24);
}

async function storeOriginalMediaFile(filePath, mime) {
  const hash = await shortFileHash(filePath);
  const ext = extensionForMime(mime);
  const typeFolder = mime.startsWith("video/") ? "videos" : "images";
  const fileName = `${hash}${ext}`;
  if (cosReady()) {
    const cosUrl = await uploadFileToCos(
      filePath,
      mime,
      prefixedCosKey("original", typeFolder, fileName)
    );
    if (cosUrl) return cosUrl;
  }

  const folder = join(uploadDir, "original", typeFolder);
  const targetPath = join(folder, fileName);
  await mkdir(folder, { recursive: true });
  if (!existsSync(targetPath)) await copyFile(filePath, targetPath);
  return `/uploads/original/${typeFolder}/${fileName}`;
}

function localUploadPathFromUrl(value) {
  if (typeof value !== "string" || !value.startsWith("/uploads/")) return "";
  const relative = decodeURIComponent(value.replace(/^\/uploads\/?/, ""));
  const candidate = normalize(join(uploadDir, relative));
  return candidate === uploadDir || candidate.startsWith(`${uploadDir}/`) ? candidate : "";
}

function isVideoDerivativePath(baseDirectory, candidatePath) {
  const derivativeRoot = normalize(join(baseDirectory, VIDEO_DERIVATIVE_DIRECTORY));
  const candidate = normalize(String(candidatePath ?? ""));
  return candidate === derivativeRoot || candidate.startsWith(`${derivativeRoot}${sep}`);
}

function videoDerivativePaths(descriptor) {
  const cacheId = videoDerivativeCacheId(descriptor.identity);
  return {
    cacheId,
    posterPath: join(uploadDir, videoDerivativeRelativePath(cacheId, VIDEO_DERIVATIVE_KINDS.poster)),
    previewPath: join(uploadDir, videoDerivativeRelativePath(cacheId, VIDEO_DERIVATIVE_KINDS.preview)),
  };
}

async function videoDerivativeFileReady(filePath, kind) {
  let handle = null;
  try {
    const info = await stat(filePath);
    const maximum = kind === VIDEO_DERIVATIVE_KINDS.poster
      ? MAX_VIDEO_POSTER_BYTES
      : MAX_VIDEO_PREVIEW_BYTES;
    if (!info.isFile() || info.size < 12 || info.size > maximum) return false;
    handle = await open(filePath, "r");
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 8) return false;
    if (kind === VIDEO_DERIVATIVE_KINDS.poster) {
      return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
    }
    return header.subarray(4, 8).toString("ascii") === "ftyp";
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function videoDerivativesReady(paths) {
  const [posterReady, previewReady] = await Promise.all([
    videoDerivativeFileReady(paths.posterPath, VIDEO_DERIVATIVE_KINDS.poster),
    videoDerivativeFileReady(paths.previewPath, VIDEO_DERIVATIVE_KINDS.preview),
  ]);
  return posterReady && previewReady;
}

async function assertVideoDerivativeSourceFile(filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    const error = new Error("视频源文件不存在");
    error.statusCode = 404;
    throw error;
  }
  if (!info.isFile() || info.size <= 0) {
    const error = new Error("视频源文件不存在");
    error.statusCode = 404;
    throw error;
  }
  if (info.size > MAX_VIDEO_UPLOAD_BYTES) {
    const error = new Error("视频源文件超过处理上限");
    error.statusCode = 413;
    throw error;
  }
  return info;
}

async function cosObjectMetadata(key) {
  const client = getCosClient("download");
  if (!client) {
    const error = new Error("COS is not configured");
    error.statusCode = 503;
    throw error;
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    client.headObject({
      Bucket: cosConfig.bucket,
      Region: cosConfig.region,
      Key: key,
    }, (error, data = {}) => {
      if (error) {
        const next = new Error(Number(error.statusCode || error.status) === 404
          ? "视频源文件不存在"
          : "视频源文件读取失败");
        next.statusCode = Number(error.statusCode || error.status) === 404 ? 404 : 502;
        rejectPromise(next);
        return;
      }
      const contentLength = Number(
        data.ContentLength || upstreamHeader(data.headers, "content-length")
      );
      const contentType = normalizeMediaMime(
        data.ContentType || upstreamHeader(data.headers, "content-type")
      );
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        const next = new Error("视频源文件大小无效");
        next.statusCode = 502;
        rejectPromise(next);
        return;
      }
      if (contentLength > MAX_VIDEO_UPLOAD_BYTES) {
        const next = new Error("视频源文件超过处理上限");
        next.statusCode = 413;
        rejectPromise(next);
        return;
      }
      if (contentType && !SUPPORTED_VIDEO_MIMES.has(contentType)) {
        const next = new Error("视频源文件类型无效");
        next.statusCode = 415;
        rejectPromise(next);
        return;
      }
      resolvePromise({ contentLength, contentType });
    });
  });
}

async function downloadCosVideoSourceToFile(key, filePath) {
  const metadata = await cosObjectMetadata(key);
  const client = getCosClient("download");
  const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  await new Promise((resolvePromise, rejectPromise) => {
    let callbackFinished = false;
    let streamFinished = false;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      if (error) {
        settled = true;
        output.destroy();
        rejectPromise(error);
        return;
      }
      if (!callbackFinished || !streamFinished) return;
      settled = true;
      resolvePromise();
    };
    output.once("finish", () => {
      streamFinished = true;
      finish();
    });
    output.once("error", (error) => finish(error));
    client.getObject({
      Bucket: cosConfig.bucket,
      Region: cosConfig.region,
      Key: key,
      Headers: {},
      Output: output,
    }, (error) => {
      if (error) {
        const next = new Error("视频源文件下载失败");
        next.statusCode = Number(error.statusCode || error.status) === 404 ? 404 : 502;
        finish(next);
        return;
      }
      callbackFinished = true;
      finish();
    });
  });
  const downloaded = await assertVideoDerivativeSourceFile(filePath);
  if (downloaded.size !== metadata.contentLength) {
    const error = new Error("视频源文件下载不完整");
    error.statusCode = 502;
    throw error;
  }
}

async function generateVideoDerivatives(descriptor, paths, options = {}) {
  const derivativeRoot = join(uploadDir, VIDEO_DERIVATIVE_DIRECTORY);
  await mkdir(derivativeRoot, { recursive: true });
  const tempDir = await mkdtemp(join(derivativeRoot, ".job-"));
  const tempPreviewPath = join(tempDir, "preview.mp4");
  const tempPosterPath = join(tempDir, "poster.jpg");
  let inputPath = String(options.sourcePath ?? "").trim();
  try {
    if (inputPath) {
      await assertVideoDerivativeSourceFile(inputPath);
    } else if (descriptor.type === "local") {
      inputPath = descriptor.localPath;
      await assertVideoDerivativeSourceFile(inputPath);
    } else if (descriptor.type === "cos") {
      inputPath = join(tempDir, `source${extname(descriptor.cosKey) || ".mp4"}`);
      await downloadCosVideoSourceToFile(descriptor.cosKey, inputPath);
    } else {
      const error = new Error("视频源地址无效");
      error.statusCode = 400;
      throw error;
    }

    try {
      await execFileAsync(FFMPEG_PATH, videoDerivativeFfmpegArgs(
        inputPath,
        tempPreviewPath,
        tempPosterPath,
        {
          durationSeconds: VIDEO_PREVIEW_DURATION_SECONDS,
          maxEdge: VIDEO_PREVIEW_MAX_EDGE,
          framesPerSecond: VIDEO_PREVIEW_FPS,
          bitrateKbps: VIDEO_PREVIEW_BITRATE_KBPS,
          threads: VIDEO_TRANSCODE_THREADS,
        },
      ), {
        timeout: VIDEO_PREVIEW_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
    } catch (cause) {
      console.warn(`Video derivative ffmpeg failed for cache ${paths.cacheId}: ${cause.message}`);
      const error = new Error("视频预览生成失败");
      error.statusCode = 502;
      throw error;
    }

    const generated = {
      posterPath: tempPosterPath,
      previewPath: tempPreviewPath,
    };
    if (!await videoDerivativesReady(generated)) {
      const error = new Error("视频预览生成结果无效");
      error.statusCode = 502;
      throw error;
    }

    await Promise.all([
      mkdir(join(uploadDir, VIDEO_DERIVATIVE_DIRECTORY, "posters"), { recursive: true }),
      mkdir(join(uploadDir, VIDEO_DERIVATIVE_DIRECTORY, "previews"), { recursive: true }),
    ]);
    await rename(tempPosterPath, paths.posterPath);
    await rename(tempPreviewPath, paths.previewPath);
    return paths;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensureVideoDerivatives(sourceValue, options = {}) {
  const descriptor = videoDerivativeSourceDescriptor(sourceValue);
  if (!descriptor) {
    const error = new Error("视频预览来源无效");
    error.statusCode = 400;
    throw error;
  }
  const paths = videoDerivativePaths(descriptor);
  if (await videoDerivativesReady(paths)) return paths;

  const recentFailure = videoDerivativeFailures.get(paths.cacheId);
  if (recentFailure && recentFailure.retryAfter > Date.now()) {
    const error = new Error("视频预览正在等待重试");
    error.statusCode = 503;
    throw error;
  }
  if (recentFailure) videoDerivativeFailures.delete(paths.cacheId);

  const existingJob = videoDerivativeJobs.get(paths.cacheId);
  if (existingJob) return await existingJob;

  const job = (async () => {
    const release = await videoPreviewLimiter.acquire();
    try {
      // A queued sibling process may have finished while this task waited.
      if (await videoDerivativesReady(paths)) return paths;
      const generated = await generateVideoDerivatives(descriptor, paths, options);
      videoDerivativeFailures.delete(paths.cacheId);
      return generated;
    } catch (error) {
      videoDerivativeFailures.delete(paths.cacheId);
      videoDerivativeFailures.set(paths.cacheId, {
        retryAfter: Date.now() + VIDEO_DERIVATIVE_FAILURE_BACKOFF_MS,
      });
      while (videoDerivativeFailures.size > MAX_VIDEO_DERIVATIVE_FAILURES) {
        const oldestKey = videoDerivativeFailures.keys().next().value;
        if (oldestKey === undefined) break;
        videoDerivativeFailures.delete(oldestKey);
      }
      throw error;
    } finally {
      release();
    }
  })();
  videoDerivativeJobs.set(paths.cacheId, job);
  job.then(
    () => videoDerivativeJobs.delete(paths.cacheId),
    () => videoDerivativeJobs.delete(paths.cacheId),
  );
  return await job;
}

function scheduleVideoDerivativeGeneration(source, sourcePath, cleanupDir = "") {
  setImmediate(() => {
    void ensureVideoDerivatives(source, { sourcePath })
      .catch((error) => {
        console.warn(`Video preview generation deferred: ${error.message}`);
      })
      .finally(() => {
        if (cleanupDir) {
          void rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
        }
      });
  });
}

async function sendVideoDerivativeFile(req, res, filePath, kind, cacheControl) {
  const info = await stat(filePath);
  const requestedRange = normalizeSingleByteRange(req.headers.range);
  if (!requestedRange.valid) {
    res.writeHead(416, {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${info.size}`,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  let start = 0;
  let end = info.size - 1;
  let statusCode = 200;
  if (requestedRange.present) {
    const match = requestedRange.value.match(/^bytes=(\d*)-(\d*)$/);
    if (match?.[1]) start = Number(match[1]);
    if (match?.[2]) end = Number(match[2]);
    if (!match?.[1] && match?.[2]) {
      const suffixLength = Number(match[2]);
      start = Math.max(0, info.size - suffixLength);
      end = info.size - 1;
    }
    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || start >= info.size
    ) {
      res.writeHead(416, {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${info.size}`,
        "Cache-Control": "no-store",
      });
      res.end();
      return;
    }
    end = Math.min(end, info.size - 1);
    statusCode = 206;
  }

  const contentLength = Math.max(0, end - start + 1);
  res._logicalResponseBytes = req.method === "HEAD" ? 0 : contentLength;
  res.writeHead(statusCode, {
    "Content-Type": kind === VIDEO_DERIVATIVE_KINDS.poster ? "image/jpeg" : "video/mp4",
    "Content-Length": String(contentLength),
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    ...(statusCode === 206 ? { "Content-Range": `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (req.method === "HEAD" || contentLength === 0) {
    res.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(res);
}

async function externalizeDataUrl(value) {
  const match = typeof value === "string"
    ? value.match(/^data:([^;,]+);base64,(.+)$/)
    : null;
  if (!match) return value;

  const [, rawMime, encoded] = match;
  const mime = normalizeMediaMime(rawMime);
  const buffer = Buffer.from(encoded, "base64");
  if (isSupportedImageMime(mime)) {
    validateImageUploadBuffer(buffer, mime);
  } else if (!SUPPORTED_VIDEO_MIMES.has(mime)) {
    const error = new Error("仅支持安全的图片或视频格式");
    error.statusCode = 400;
    throw error;
  }
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

async function uploadOriginalMedia(buffer, mime, options = {}) {
  let mediaBuffer = buffer;
  let mediaMime = mime;
  if (TRANSCODE_VIDEO_UPLOADS && String(mime).startsWith("video/")) {
    mediaBuffer = await transcodeVideoToWechatMp4(buffer, mime, options);
    mediaMime = "video/mp4";
  }
  const hash = createHash("sha256").update(mediaBuffer).digest("hex").slice(0, 24);
  const ext = extensionForMime(mediaMime);
  const typeFolder = mediaMime.startsWith("video/") ? "videos" : "images";
  const fileName = `${hash}${ext}`;
  if (cosReady()) {
    const cosUrl = await uploadBufferToCos(
      mediaBuffer,
      mediaMime,
      prefixedCosKey("original", typeFolder, fileName)
    );
    if (cosUrl) return cosUrl;
  }

  const folder = join(uploadDir, "original", typeFolder);
  const filePath = join(folder, fileName);
  await mkdir(folder, { recursive: true });
  if (!existsSync(filePath)) {
    await writeFile(filePath, mediaBuffer);
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

async function readRawBodyToFile(req, filePath, maxBytes = Number.POSITIVE_INFINITY) {
  const declaredLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    const error = new Error("上传文件过大");
    error.statusCode = 413;
    throw error;
  }

  const handle = await open(filePath, "wx", 0o600);
  let total = 0;
  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxBytes) {
        const error = new Error("上传文件过大");
        error.statusCode = 413;
        throw error;
      }
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (bytesWritten <= 0) throw new Error("上传文件写入失败");
        offset += bytesWritten;
      }
    }
    await handle.sync();
    return total;
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(filePath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readBody(req, maxBytes = Number.POSITIVE_INFINITY) {
  const buffer = await readRawBody(req, maxBytes);
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

async function migrateLegacyPublicCatalogVisibility() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const currentState = rows[0]?.data;
    const migration = migrateLegacyPublicCatalogVisibilityState(currentState);
    if (!migration.changed) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
      [stateId, JSON.stringify(migration.state)]
    );
    await client.query("COMMIT");
    console.log(`Migrated legacy public product visibility into fish-list policy: ${migration.migratedProductIds.length}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Failed to migrate legacy public product visibility:", error);
    throw error;
  } finally {
    client.release();
  }
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
    const siteSchemaVersion = Number(state._siteSchemaVersion ?? 0);
    const withLegacyDefaultSite = (records) => (Array.isArray(records) ? records : []).map((record) =>
      String(record?.siteId ?? "").trim()
        ? record
        : { ...record, siteId: DEFAULT_SITE_ID }
    );
    const nextTankGroups = siteSchemaVersion >= 4
      ? state.tankGroups
      : withLegacyDefaultSite(state.tankGroups);
    const nextBatches = siteSchemaVersion >= 4
      ? state.batches
      : withLegacyDefaultSite(state.batches);
    const knownSiteIds = new Set(nextSites.map((site) => String(site?.id ?? "").trim()).filter(Boolean));
    const nextOrders = siteSchemaVersion >= 4
      ? state.orders
      : (Array.isArray(state.orders) ? state.orders : []).map((order) => {
          if (String(order?.siteId ?? "").trim()) return order;
          const relatedShipmentSites = new Set((Array.isArray(state.shipments) ? state.shipments : [])
            .filter((shipment) => String(shipment?.orderId ?? "").trim() === String(order?.id ?? "").trim())
            .map((shipment) => String(shipment?.siteId ?? "").trim())
            .filter((siteId) => knownSiteIds.has(siteId)));
          const relatedSiteId = relatedShipmentSites.size === 1 ? [...relatedShipmentSites][0] : "";
          return { ...order, siteId: relatedSiteId || DEFAULT_SITE_ID };
        });
    const nextStock = siteSchemaVersion >= 4
      ? state.stock
      : (Array.isArray(state.stock) ? state.stock : []).map((item) => {
          if (String(item?.siteId ?? "").trim()) return item;
          const groupMatches = (Array.isArray(nextTankGroups) ? nextTankGroups : []).filter((group) =>
            (Array.isArray(group?.subTanks) ? group.subTanks : [])
              .some((tank) => String(tank?.id ?? "") === String(item?.subTankId ?? ""))
          );
          const batchMatches = (Array.isArray(nextBatches) ? nextBatches : []).filter((batch) =>
            String(batch?.id ?? "") === String(item?.batchId ?? "")
          );
          const groupSiteId = groupMatches.length === 1 ? String(groupMatches[0]?.siteId ?? "").trim() : "";
          const batchSiteId = batchMatches.length === 1 ? String(batchMatches[0]?.siteId ?? "").trim() : "";
          const siteId = knownSiteIds.has(groupSiteId)
            ? groupSiteId
            : knownSiteIds.has(batchSiteId)
              ? batchSiteId
              : DEFAULT_SITE_ID;
          return { ...item, siteId };
        });
    const nextShipments = siteSchemaVersion >= 4
      ? state.shipments
      : (Array.isArray(state.shipments) ? state.shipments : []).map((shipment) => {
          if (String(shipment?.siteId ?? "").trim()) return shipment;
          const orderMatches = (Array.isArray(nextOrders) ? nextOrders : []).filter((order) =>
            String(order?.id ?? "").trim() === String(shipment?.orderId ?? "").trim()
          );
          const orderSiteId = orderMatches.length === 1 ? String(orderMatches[0]?.siteId ?? "").trim() : "";
          return { ...shipment, siteId: orderSiteId || DEFAULT_SITE_ID };
        });
    const sitesChanged = JSON.stringify(currentSites) !== JSON.stringify(nextSites);
    const scopedRecordsChanged = siteSchemaVersion < 4 && (
      JSON.stringify(state.tankGroups ?? []) !== JSON.stringify(nextTankGroups ?? []) ||
      JSON.stringify(state.batches ?? []) !== JSON.stringify(nextBatches ?? []) ||
      JSON.stringify(state.orders ?? []) !== JSON.stringify(nextOrders ?? []) ||
      JSON.stringify(state.stock ?? []) !== JSON.stringify(nextStock ?? []) ||
      JSON.stringify(state.shipments ?? []) !== JSON.stringify(nextShipments ?? [])
    );
    if (!sitesChanged && !scopedRecordsChanged && siteSchemaVersion >= 4) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query(
      `UPDATE app_state
       SET data = jsonb_set(
         jsonb_set(
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   jsonb_set(data, '{sites}', $2::jsonb, true),
                   '{tankGroups}', $3::jsonb, true
                 ),
                 '{batches}', $4::jsonb, true
               ),
               '{orders}', $5::jsonb, true
             ),
             '{stock}', $6::jsonb, true
           ),
           '{shipments}', $7::jsonb, true
         ),
         '{_siteSchemaVersion}', '4'::jsonb, true
       ), updated_at = now()
       WHERE id = $1`,
      [
        stateId,
        JSON.stringify(nextSites),
        JSON.stringify(nextTankGroups ?? []),
        JSON.stringify(nextBatches ?? []),
        JSON.stringify(nextOrders ?? []),
        JSON.stringify(nextStock ?? []),
        JSON.stringify(nextShipments ?? []),
      ]
    );
    await client.query("COMMIT");
    console.log(`Backfilled default sites and legacy site ownership: ${nextSites.map((site) => site.name).join(", ")}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error("Failed to backfill default sites:", error);
    throw error;
  } finally {
    client.release();
  }
}

async function backfillPersonnelProfiles() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const state = rows[0]?.data;
    if (!state || typeof state !== "object" || !Array.isArray(state.personnel)) {
      await client.query("ROLLBACK");
      return;
    }
    if (Number(state._personnelSchemaVersion ?? 0) >= 3) {
      await client.query("ROLLBACK");
      return;
    }

    const sites = getSitesFromState(state);
    const allSiteIds = sites.map((site) => site.id);
    const usedPersonnelNos = new Set(state.personnel
      .map((person) => String(person?.personnelNo ?? "").trim()).filter(Boolean));
    const claimedPersonnelNos = new Set();
    let sequence = 1;
    const allocatePersonnelNo = () => {
      while (usedPersonnelNos.has(`RY-${String(sequence).padStart(4, "0")}`)) sequence += 1;
      const value = `RY-${String(sequence).padStart(4, "0")}`;
      usedPersonnelNos.add(value);
      sequence += 1;
      return value;
    };

    const nextPersonnel = state.personnel.map((person) => {
      if (!person || typeof person !== "object") return person;
      const { birthDate: legacyBirthDate, ...legacyPerson } = person;
      const username = String(person.username ?? "").trim();
      const resigned = isPersonnelResigned(person);
      const accountEnabled = Boolean(username) && !resigned && person.accountEnabled !== false;
      const accessRole = username && person.accessRole === "admin" ? "admin" : "staff";
      let visibleSiteIds = accessRole === "admin" ? [] : normalizeVisibleSiteIds(person.visibleSiteIds, sites);
      // Before this migration an empty staff scope meant all sites. Persist that legacy
      // meaning explicitly so all future empty scopes can safely fail closed.
      if (accountEnabled && accessRole === "staff" && visibleSiteIds.length === 0) {
        visibleSiteIds = [...allSiteIds];
      }
      const existingPersonnelNo = String(person.personnelNo ?? "").trim();
      const personnelNo = existingPersonnelNo && !claimedPersonnelNos.has(existingPersonnelNo)
        ? existingPersonnelNo
        : allocatePersonnelNo();
      claimedPersonnelNos.add(personnelNo);
      return {
        ...legacyPerson,
        personnelNo,
        username,
        sessionVersion: sessionVersionForAccount(person),
        accountEnabled,
        accessRole,
        visibleSiteIds,
        siteIds: normalizeVisibleSiteIds(person.siteIds, sites),
        employmentStatus: resigned ? "resigned" : "active",
        nativePlace: String(person.nativePlace ?? ""),
        birthMonth: String(person.birthMonth ?? legacyBirthDate ?? "").slice(0, 7),
        educationLevel: String(person.educationLevel ?? ""),
        idCardFrontAttachment: person.idCardFrontAttachment ?? null,
        idCardBackAttachment: person.idCardBackAttachment ?? null,
        educationProofAttachment: person.educationProofAttachment ?? null,
        profileRevision: profileRevisionForPersonnel(person),
        permissions: !username
          ? emptyPermissionsValue()
          : accessRole === "admin"
          ? fullPermissionsValue()
          : normalizeLegacyPermissionsForStorage(person.permissions),
      };
    });
    const nextOrders = backfillOrderContactPersonnelIds(nextPersonnel, state.orders);
    await client.query(
      "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
      [stateId, JSON.stringify({
        ...state,
        personnel: nextPersonnel,
        orders: nextOrders,
        personnelProfileRequests: currentPersonnelProfileRequests(state),
        personnelPrivateAttachments: currentPersonnelPrivateAttachments(state),
        retiredPersonnelUsernames: Array.isArray(state.retiredPersonnelUsernames) ? state.retiredPersonnelUsernames : [],
        _personnelSchemaVersion: 3,
      })]
    );
    await client.query("COMMIT");
    const linkedOrderCount = nextOrders.filter((order, index) =>
      String(order?.contactPersonnelId ?? "") !== String(state.orders?.[index]?.contactPersonnelId ?? "")
    ).length;
    console.log(`Backfilled ${nextPersonnel.length} personnel profile(s) to schema v3 and linked ${linkedOrderCount} order owner(s)`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function ensurePersonnelSensitiveDataEncryption() {
  if (!personnelDataKeyring) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const state = rows[0]?.data;
    if (!state || typeof state !== "object" || !Array.isArray(state.personnel)) {
      await client.query("ROLLBACK");
      return;
    }
    let changed = state._personnelSensitiveEncryptionKid !== personnelDataKeyring.activeKid;
    const nextPersonnel = state.personnel.map((person) => {
      if (!person || typeof person !== "object" || !String(person.id ?? "").trim()) return person;
      const nextPerson = rewrapPersonnelSensitiveFields(person, personnelDataKeyring);
      if (!changed && ["idCardNo", "bankAccountName", "bankAccountNo", "bankName"].some(
        (field) => String(nextPerson[field] ?? "") !== String(person[field] ?? "")
      )) changed = true;
      return nextPerson;
    });
    const nextPersonnelProfileRequests = currentPersonnelProfileRequests(state).map((request) => {
      if (!request || typeof request !== "object" || !String(request.personnelId ?? "").trim()) return request;
      const proposalValues = [request.beforeProfile, request.proposedProfile];
      const needsRewrap = proposalValues.some((profile) =>
        PERSONNEL_PROFILE_SENSITIVE_VALUE_FIELDS.some((field) => {
          const value = String(profile?.[field] ?? "");
          return value && encryptedPersonnelSensitiveValueKid(value) !== personnelDataKeyring.activeKid;
        })
      );
      if (!needsRewrap) return request;
      changed = true;
      return {
        ...request,
        beforeProfile: rewrapPersonnelProfileProposalFields(
          request.beforeProfile,
          request.personnelId,
          personnelDataKeyring
        ),
        proposedProfile: rewrapPersonnelProfileProposalFields(
          request.proposedProfile,
          request.personnelId,
          personnelDataKeyring
        ),
      };
    });
    if (!changed) {
      await client.query("ROLLBACK");
      return;
    }
    await client.query(
      "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
      [stateId, JSON.stringify({
        ...state,
        personnel: nextPersonnel,
        personnelProfileRequests: nextPersonnelProfileRequests,
        _personnelSensitiveEncryptionKid: personnelDataKeyring.activeKid,
      })]
    );
    await client.query("COMMIT");
    console.log(`Protected personnel identity and payroll fields with key ${personnelDataKeyring.activeKid}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function atomicallyReplacePersonnelAttachment(filePath, encryptedBuffer) {
  const temporaryPath = `${filePath}.${randomBytes(12).toString("hex")}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(encryptedBuffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function referencedPersonnelAttachmentIds(state = {}) {
  const current = new Map();
  for (const person of Array.isArray(state.personnel) ? state.personnel : []) {
    for (const field of PERSONNEL_PROFILE_ATTACHMENT_FIELDS) {
      const id = String(person?.[field]?.id ?? "").trim();
      if (id) current.set(id, {
        personnelId: String(person?.id ?? ""),
        kind: attachmentKindForPersonnelProfileField(field),
      });
    }
  }
  const requests = new Map();
  for (const request of currentPersonnelProfileRequests(state)) {
    if (!["pending", "rejected"].includes(String(request?.status ?? ""))) continue;
    const profile = decryptPersonnelProfileProposalFields(
      request.proposedProfile,
      request.personnelId,
      personnelDataKeyring
    );
    for (const field of PERSONNEL_PROFILE_ATTACHMENT_FIELDS) {
      const id = String(profile?.[field]?.id ?? "").trim();
      if (id) requests.set(`${String(request?.id ?? "")}\0${id}`, {
        requestId: String(request?.id ?? ""),
        requestStatus: String(request?.status ?? ""),
        personnelId: String(request?.personnelId ?? ""),
        kind: attachmentKindForPersonnelProfileField(field),
      });
    }
  }
  return { current, requests };
}

async function ensurePersonnelPrivateAttachmentLifecycleAndEncryption() {
  const client = await pool.connect();
  let removedIds = [];
  try {
    await mkdir(join(uploadDir, PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY), { recursive: true });
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
    const state = rows[0]?.data;
    if (!state || typeof state !== "object") {
      await client.query("ROLLBACK");
      return;
    }
    const now = new Date();
    const personnelIds = new Set((Array.isArray(state.personnel) ? state.personnel : [])
      .map((person) => String(person?.id ?? "")).filter(Boolean));
    const referenced = referencedPersonnelAttachmentIds(state);
    const retained = [];
    for (const rawReference of currentPersonnelPrivateAttachments(state)) {
      const reference = normalizePersonnelAttachmentLifecycle(rawReference, now);
      const id = String(reference?.id ?? "").trim();
      const personnelId = String(reference?.personnelId ?? "").trim();
      const kind = String(reference?.kind ?? "").trim();
      const status = String(reference?.status ?? "").trim();
      const currentReference = referenced.current.get(id);
      const requestReference = referenced.requests.get(`${String(reference?.profileRequestId ?? "")}\0${id}`);
      const validCurrent = status === "approved" &&
        currentReference?.personnelId === personnelId && currentReference?.kind === kind;
      const validPending = status === "pending" &&
        requestReference?.requestStatus === "pending" &&
        requestReference?.personnelId === personnelId && requestReference?.kind === kind &&
        requestReference?.requestId === String(reference?.profileRequestId ?? "");
      const validRejected = status === "rejected" &&
        requestReference?.requestStatus === "rejected" &&
        requestReference?.personnelId === personnelId && requestReference?.kind === kind &&
        requestReference?.requestId === String(reference?.profileRequestId ?? "");
      const validDraft = status === "draft" &&
        String(reference?.uploadedByPersonnelId ?? "") === personnelId;
      if (!id || !personnelIds.has(personnelId) || (!validCurrent && !validPending && !validRejected && !validDraft)) {
        continue;
      }
      retained.push(reference);
    }
    const retainedIds = new Set(retained.map((reference) => String(reference.id)));
    removedIds = currentPersonnelPrivateAttachments(state)
      .map((reference) => String(reference?.id ?? ""))
      .filter((id) => id && !retainedIds.has(id));
    if (retained.length > 0 && !personnelDataKeyring) {
      throw new Error("存在人员私密附件，但人员敏感信息加密密钥未配置");
    }
    for (const reference of retained) {
      const filePath = privatePersonnelAttachmentPath(uploadDir, reference.id);
      const encrypted = await readFile(filePath);
      if (personnelAttachmentCiphertextKid(encrypted) === personnelDataKeyring.activeKid) {
        decryptPersonnelAttachmentBuffer(encrypted, {
          attachmentId: reference.id,
          personnelId: reference.personnelId,
          kind: reference.kind,
          keyring: personnelDataKeyring,
        });
        continue;
      }
      const rewrapped = rewrapPersonnelAttachmentBuffer(encrypted, {
        attachmentId: reference.id,
        personnelId: reference.personnelId,
        kind: reference.kind,
        keyring: personnelDataKeyring,
      });
      await atomicallyReplacePersonnelAttachment(filePath, rewrapped);
    }
    const nextState = {
      ...state,
      personnelPrivateAttachments: retained,
      _personnelPrivateAttachmentEncryptionKid: personnelDataKeyring?.activeKid ?? "",
    };
    await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
      stateId,
      JSON.stringify(nextState),
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  // Only remove IDs that were present and proven unreferenced while holding the
  // row lock. Never sweep unknown files here: another instance may have written
  // a new encrypted file and still be waiting to commit its registry record.
  await removePersonnelAttachmentFiles(removedIds);
}

async function ensureSchema() {
  schemaReady ??= (async () => {
    const revisionMigrationClient = await pool.connect();
    try {
      await revisionMigrationClient.query("BEGIN");
      // Serialize concurrent new instances and hold the table exclusively from
      // ALTER through trigger installation. Existing instances may finish an
      // in-flight write before this lock, but no write can slip through the
      // revision-less migration window or race the sequence alignment.
      await revisionMigrationClient.query(
        "SELECT pg_advisory_xact_lock(hashtext('fishroom'), hashtext('app_state_revision_v1'))"
      );
      await revisionMigrationClient.query("CREATE SEQUENCE IF NOT EXISTS app_state_revision_seq");
      await revisionMigrationClient.query(`
        CREATE TABLE IF NOT EXISTS app_state (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          revision BIGINT NOT NULL DEFAULT nextval('app_state_revision_seq'),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await revisionMigrationClient.query(`
        ALTER TABLE app_state
        ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT nextval('app_state_revision_seq')
      `);
      await revisionMigrationClient.query("LOCK TABLE app_state IN ACCESS EXCLUSIVE MODE");
      await revisionMigrationClient.query("DROP TRIGGER IF EXISTS app_state_revision_trigger ON app_state");
      await revisionMigrationClient.query(`
        CREATE OR REPLACE FUNCTION bump_app_state_revision()
        RETURNS trigger AS $$
        BEGIN
          IF TG_OP = 'UPDATE' OR NEW.revision IS NULL OR NEW.revision <= 0 THEN
            NEW.revision := nextval('app_state_revision_seq');
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await revisionMigrationClient.query(`
        SELECT setval(
          'app_state_revision_seq',
          GREATEST(
            (SELECT COALESCE(MAX(revision), 0) FROM app_state),
            (SELECT last_value FROM app_state_revision_seq),
            1
          ),
          true
        )
      `);
      // Allocate a fresh marker while the table is locked so clients can
      // reliably observe the completed migration even on an existing row.
      await revisionMigrationClient.query(`
        UPDATE app_state
        SET revision = nextval('app_state_revision_seq')
      `);
      await revisionMigrationClient.query(`
        SELECT setval(
          'app_state_revision_seq',
          GREATEST(
            (SELECT COALESCE(MAX(revision), 0) FROM app_state),
            (SELECT last_value FROM app_state_revision_seq),
            1
          ),
          true
        )
      `);
      await revisionMigrationClient.query(`
        CREATE TRIGGER app_state_revision_trigger
        BEFORE INSERT OR UPDATE ON app_state
        FOR EACH ROW EXECUTE FUNCTION bump_app_state_revision()
      `);
      await revisionMigrationClient.query("COMMIT");
    } catch (error) {
      await revisionMigrationClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      revisionMigrationClient.release();
    }
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_import_batches (
        id TEXT PRIMARY KEY,
        state_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        imported_by TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        matched_count INTEGER NOT NULL DEFAULT 0,
        unmatched_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        totals JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (state_id, site_id, platform, file_hash)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_platform_settlements (
        id TEXT PRIMARY KEY,
        state_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        external_order_no TEXT NOT NULL,
        sub_order_no TEXT NOT NULL DEFAULT '',
        settlement_time TEXT NOT NULL DEFAULT '',
        order_time TEXT NOT NULL DEFAULT '',
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (state_id, site_id, platform, fingerprint)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS finance_platform_settlements_order_idx
      ON finance_platform_settlements (state_id, site_id, platform, external_order_no)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_account_transfers (
        id TEXT PRIMARY KEY,
        state_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        source_account TEXT NOT NULL,
        target_account TEXT NOT NULL,
        expected_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        actual_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
        transferred_at TEXT NOT NULL,
        transaction_no TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        import_batch_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        proof JSONB NOT NULL DEFAULT '[]'::jsonb,
        notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_by TEXT NOT NULL,
        verified_at TIMESTAMPTZ,
        verified_by TEXT NOT NULL DEFAULT ''
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS finance_account_transfers_site_idx
      ON finance_account_transfers (state_id, site_id, transferred_at DESC)
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_statement_import_batches (
        id TEXT PRIMARY KEY,
        state_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        payment_method_id TEXT NOT NULL,
        payment_method_name TEXT NOT NULL,
        channel TEXT NOT NULL,
        account TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        imported_by TEXT NOT NULL,
        row_count INTEGER NOT NULL DEFAULT 0,
        matched_count INTEGER NOT NULL DEFAULT 0,
        unmatched_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        totals JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (state_id, site_id, payment_method_id, file_hash)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS finance_payment_statements (
        id TEXT PRIMARY KEY,
        state_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        payment_method_id TEXT NOT NULL,
        payment_method_name TEXT NOT NULL,
        channel TEXT NOT NULL,
        account TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        external_transaction_no TEXT NOT NULL DEFAULT '',
        occurred_at TEXT NOT NULL,
        amount NUMERIC(14, 2) NOT NULL,
        direction TEXT NOT NULL,
        payer_name TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
        candidate_orders JSONB NOT NULL DEFAULT '[]'::jsonb,
        match_status TEXT NOT NULL DEFAULT 'unmatched',
        match_reason TEXT NOT NULL DEFAULT '',
        matched_order_id TEXT NOT NULL DEFAULT '',
        matched_payment_id TEXT NOT NULL DEFAULT '',
        match_method TEXT NOT NULL DEFAULT '',
        matched_at TIMESTAMPTZ,
        matched_by TEXT NOT NULL DEFAULT '',
        verified_at TIMESTAMPTZ,
        verified_by TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (state_id, site_id, payment_method_id, fingerprint)
      )
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS finance_payment_statements_site_idx
      ON finance_payment_statements (state_id, site_id, occurred_at DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS finance_payment_statements_match_idx
      ON finance_payment_statements (state_id, matched_order_id, match_status)
    `);
    await importLegacyStateIfPresent();
    await migrateLegacyPublicCatalogVisibility();
    await backfillDefaultSites();
    await backfillPersonnelProfiles();
    await ensurePersonnelSensitiveDataEncryption();
    await ensurePersonnelPrivateAttachmentLifecycleAndEncryption();
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

  if (url.pathname === "/api/version" && req.method === "GET") {
    sendJson(req, res, 200, {
      product: "fishroom-management-system",
      revision: releaseRevision,
      buildTime: releaseBuiltAt || null,
    }, { "Cache-Control": "no-store" });
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
      const session = createAuthToken(user, account);
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

  if (url.pathname === "/api/public/media/cos" && ["GET", "HEAD"].includes(req.method)) {
    try {
      const mediaUrl = String(url.searchParams.get("url") ?? "").trim();
      const key = cosKeyFromUrl(mediaUrl);
      if (!key) {
        sendJson(req, res, 400, { error: "Invalid COS media URL" });
        return;
      }
      const now = Date.now();
      const expiresAt = url.searchParams.get("expires");
      const validToken = verifyPublicMediaUrlToken({
        mediaUrl,
        expiresAt,
        signature: url.searchParams.get("signature"),
        secret: authTokenSecret,
        now,
      });
      if (!validToken) {
        sendJson(req, res, 403, { error: "Public media link is invalid or expired" });
        return;
      }
      const maxAge = publicMediaCacheMaxAgeSeconds(expiresAt, { now });
      sendCosObject(req, res, key, `public, max-age=${maxAge}`, { publicMedia: true });
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message || "Failed to load public media" });
    }
    return;
  }

  if (url.pathname === "/api/public/media/video-derivative" && ["GET", "HEAD"].includes(req.method)) {
    try {
      const source = String(url.searchParams.get("url") ?? "").trim();
      const kind = normalizeVideoDerivativeKind(url.searchParams.get("kind"));
      const now = Date.now();
      const expiresAt = url.searchParams.get("expires");
      const validToken = verifyPublicVideoDerivativeToken({
        source,
        kind,
        expiresAt,
        signature: url.searchParams.get("signature"),
        secret: authTokenSecret,
        now,
      });
      if (!validToken) {
        sendJson(req, res, 403, { error: "Public video preview link is invalid or expired" }, {
          "Cache-Control": "no-store",
        });
        return;
      }
      if (!videoDerivativeSourceDescriptor(source)) {
        sendJson(req, res, 400, { error: "Invalid video preview source" }, {
          "Cache-Control": "no-store",
        });
        return;
      }

      const paths = await ensureVideoDerivatives(source);
      if (req.aborted || res.destroyed) return;
      const filePath = kind === VIDEO_DERIVATIVE_KINDS.poster
        ? paths.posterPath
        : paths.previewPath;
      const maxAge = publicMediaCacheMaxAgeSeconds(expiresAt, { now });
      await sendVideoDerivativeFile(req, res, filePath, kind, `public, max-age=${maxAge}`);
    } catch (error) {
      if (req.aborted || res.destroyed) return;
      const candidateStatus = Number(error?.statusCode ?? 0);
      const status = [400, 404, 413, 415, 503].includes(candidateStatus) ? candidateStatus : 502;
      sendJson(req, res, status, {
        error: status === 503
          ? "视频预览生成任务较多，请稍后重试"
          : status === 404
            ? "视频预览源文件不存在"
            : status === 413
              ? "视频源文件超过处理上限"
              : status === 415
                ? "视频源文件类型无效"
                : "视频预览生成失败，请稍后重试",
      }, { "Cache-Control": "no-store" });
    }
    return;
  }

  if (url.pathname === "/api/public/catalog" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    let releaseProjectionSlot = null;
    try {
      const requestedSiteId = normalizeSiteScope(url.searchParams.get("siteId") ?? ALL_SITE_ID);
      const versionResult = await pool.query(
        "SELECT revision::text AS version FROM app_state WHERE id = $1",
        [stateId]
      );
      const observedRevision = String(versionResult.rows[0]?.version ?? "");
      const cacheKey = requestedSiteId;
      const cached = cachedPublicProjection(publicCatalogCache, cacheKey, observedRevision);
      if (cached.hit) {
        sendJson(req, res, 200, { ok: true, catalog: cached.value });
        return;
      }

      releaseProjectionSlot = await publicProjectionLimiter.acquire();
      const cachedAfterWait = cachedPublicProjection(publicCatalogCache, cacheKey, observedRevision);
      if (cachedAfterWait.hit) {
        sendJson(req, res, 200, { ok: true, catalog: cachedAfterWait.value });
        return;
      }

      const { rows } = await pool.query(
        `WITH source AS MATERIALIZED (
           SELECT data, revision::text AS version
           FROM app_state
           WHERE id = $1
         )
         SELECT
           version,
           data -> 'sites' AS sites,
           data -> 'species' AS species,
           data -> 'speciesCategories' AS species_categories,
           data -> 'speciesCategoryMajorMap' AS species_category_major_map,
           data -> 'publicCatalogPolicy' AS public_catalog_policy,
           data -> 'products' AS products,
           data -> 'tankGroups' AS tank_groups,
           data -> 'stock' AS stock,
           data -> 'orders' AS orders,
           data -> 'shipments' AS shipments,
           ${PUBLIC_SPECIMEN_HISTORY_SQL} AS specimen_history_digests,
           COALESCE((
             SELECT jsonb_agg(record_item)
             FROM jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb)) AS records(record_item)
             WHERE
               CASE WHEN jsonb_typeof(record_item -> 'photos') = 'array'
                 THEN jsonb_array_length(record_item -> 'photos') ELSE 0 END > 0
               OR
               CASE WHEN jsonb_typeof(record_item -> 'videos') = 'array'
                 THEN jsonb_array_length(record_item -> 'videos') ELSE 0 END > 0
           ), '[]'::jsonb) AS bio_records
         FROM source`,
        [stateId]
      );
      const row = rows[0] ?? {};
      const catalog = buildPublicCatalog(
        publicCatalogProjectionFromRow(row),
        requestedSiteId
      );
      storePublicProjection(
        publicCatalogCache,
        cacheKey,
        row.version,
        catalog,
        Math.max(8, getSitesFromState(publicCatalogProjectionFromRow(row)).length * 2)
      );
      sendJson(req, res, 200, {
        ok: true,
        catalog,
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode ?? 500), {
        ok: false,
        error: error.message || "Failed to load public catalog",
      });
    } finally {
      releaseProjectionSlot?.();
    }
    return;
  }

  if (url.pathname === "/api/public/bio-records" && req.method === "GET") {
    res.setHeader("Cache-Control", "no-store");
    let releaseProjectionSlot = null;
    try {
      const stockItemId = String(url.searchParams.get("stockItemId") ?? "").trim();
      if (!stockItemId) {
        sendJson(req, res, 400, { ok: false, error: "stockItemId is required" });
        return;
      }
      const requestedSiteId = normalizeSiteScope(url.searchParams.get("siteId") ?? ALL_SITE_ID);
      const versionResult = await pool.query(
        "SELECT revision::text AS version FROM app_state WHERE id = $1",
        [stateId]
      );
      const observedRevision = String(versionResult.rows[0]?.version ?? "");
      const cacheKey = `${requestedSiteId}:${stockItemId}`;
      const cached = cachedPublicProjection(publicBioRecordsCache, cacheKey, observedRevision);
      if (cached.hit) {
        if (!cached.value) {
          sendJson(req, res, 404, { ok: false, error: "Stock item is not public" });
        } else {
          sendJson(req, res, 200, { ok: true, bioRecords: cached.value });
        }
        return;
      }

      releaseProjectionSlot = await publicProjectionLimiter.acquire();
      const cachedAfterWait = cachedPublicProjection(publicBioRecordsCache, cacheKey, observedRevision);
      if (cachedAfterWait.hit) {
        if (!cachedAfterWait.value) {
          sendJson(req, res, 404, { ok: false, error: "Stock item is not public" });
        } else {
          sendJson(req, res, 200, { ok: true, bioRecords: cachedAfterWait.value });
        }
        return;
      }

      const { rows } = await pool.query(
        `WITH source AS MATERIALIZED (
           SELECT data, revision::text AS version
           FROM app_state
           WHERE id = $1
         ),
         target_stock AS MATERIALIZED (
           SELECT stock_item
           FROM source,
             LATERAL jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS stock_rows(stock_item)
           WHERE stock_item ->> 'id' = $2
         ),
         candidate_stock AS MATERIALIZED (
           SELECT candidate_item AS stock_item, candidate_ordinality AS inventory_ordinality
           FROM source,
             LATERAL jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb))
               WITH ORDINALITY AS stock_rows(candidate_item, candidate_ordinality)
           WHERE candidate_item ->> 'productId' = (
             SELECT stock_item ->> 'productId' FROM target_stock LIMIT 1
           )
         ),
         candidate_stock_ids AS MATERIALIZED (
           SELECT stock_item ->> 'id' AS stock_item_id
           FROM candidate_stock
           WHERE COALESCE(stock_item ->> 'id', '') <> ''
         ),
         relevant_orders AS MATERIALIZED (
           SELECT order_item
           FROM source,
             LATERAL jsonb_array_elements(COALESCE(data -> 'orders', '[]'::jsonb)) AS order_rows(order_item)
           WHERE EXISTS (
             SELECT 1
             FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(order_item -> 'items') = 'array'
                 THEN order_item -> 'items' ELSE '[]'::jsonb END
             ) AS order_items(item)
             WHERE item ->> 'stockItemId' IN (
               SELECT stock_item_id FROM candidate_stock_ids
             )
           )
         )
         SELECT
           version,
           data -> 'sites' AS sites,
           data -> 'speciesCategoryMajorMap' AS species_category_major_map,
           data -> 'publicCatalogPolicy' AS public_catalog_policy,
           COALESCE((
             SELECT jsonb_agg(group_item)
             FROM jsonb_array_elements(COALESCE(data -> 'tankGroups', '[]'::jsonb)) AS groups(group_item)
             WHERE EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(group_item -> 'subTanks') = 'array'
                 THEN group_item -> 'subTanks' ELSE '[]'::jsonb END
               ) AS sub_tanks(sub_tank)
               WHERE sub_tank ->> 'id' IN (
                 SELECT stock_item ->> 'subTankId' FROM candidate_stock
               )
             )
           ), '[]'::jsonb) AS tank_groups,
           COALESCE((
             SELECT jsonb_agg(product_item)
             FROM jsonb_array_elements(COALESCE(data -> 'products', '[]'::jsonb)) AS product_rows(product_item)
             WHERE product_item ->> 'id' = (
               SELECT stock_item ->> 'productId' FROM target_stock LIMIT 1
             )
           ), '[]'::jsonb) AS products,
           COALESCE((
             SELECT jsonb_agg(species_item)
             FROM jsonb_array_elements(COALESCE(data -> 'species', '[]'::jsonb)) AS species_rows(species_item)
             WHERE species_item ->> 'id' = (
               SELECT product_item ->> 'speciesId'
               FROM jsonb_array_elements(COALESCE(data -> 'products', '[]'::jsonb)) AS product_rows(product_item)
               WHERE product_item ->> 'id' = (
                 SELECT stock_item ->> 'productId' FROM target_stock LIMIT 1
               )
               LIMIT 1
             )
           ), '[]'::jsonb) AS species,
           COALESCE((SELECT jsonb_agg(order_item) FROM relevant_orders), '[]'::jsonb) AS orders,
           COALESCE((
             SELECT jsonb_agg(shipment_item)
             FROM jsonb_array_elements(COALESCE(data -> 'shipments', '[]'::jsonb)) AS shipment_rows(shipment_item)
             WHERE shipment_item ->> 'orderId' IN (
               SELECT order_item ->> 'id' FROM relevant_orders
             ) OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements_text(
                 CASE WHEN jsonb_typeof(shipment_item -> 'itemStockIds') = 'array'
                   THEN shipment_item -> 'itemStockIds' ELSE '[]'::jsonb END
               ) AS shipment_stock_ids(stock_id)
               WHERE stock_id IN (
                 SELECT stock_item_id FROM candidate_stock_ids
               )
             )
           ), '[]'::jsonb) AS shipments,
           (SELECT count(*)::int FROM target_stock) AS stock_item_count,
           COALESCE((
             SELECT jsonb_agg(stock_item ORDER BY inventory_ordinality)
             FROM candidate_stock
           ), '[]'::jsonb) AS stock,
           COALESCE((
             SELECT jsonb_agg(record_item)
             FROM jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb)) AS bio_rows(record_item)
             WHERE record_item ->> 'stockItemId' = $2
               OR (
                 record_item ->> 'stockItemId' IN (
                   SELECT stock_item_id FROM candidate_stock_ids
                 )
                 AND (
                   CASE WHEN jsonb_typeof(record_item -> 'photos') = 'array'
                     THEN jsonb_array_length(record_item -> 'photos') ELSE 0 END > 0
                   OR
                   CASE WHEN jsonb_typeof(record_item -> 'videos') = 'array'
                     THEN jsonb_array_length(record_item -> 'videos') ELSE 0 END > 0
                 )
               )
           ), '[]'::jsonb) AS bio_records
         FROM source`,
        [stateId, stockItemId]
      );
      const stockItemCount = Number(rows[0]?.stock_item_count ?? 0);
      const projectedState = {
        sites: Array.isArray(rows[0]?.sites) ? rows[0].sites : [],
        species: Array.isArray(rows[0]?.species) ? rows[0].species : [],
        speciesCategoryMajorMap: rows[0]?.species_category_major_map &&
          typeof rows[0].species_category_major_map === "object"
          ? rows[0].species_category_major_map
          : {},
        publicCatalogPolicy: normalizePublicCatalogPolicy(rows[0]?.public_catalog_policy),
        tankGroups: Array.isArray(rows[0]?.tank_groups) ? rows[0].tank_groups : [],
        products: Array.isArray(rows[0]?.products) ? rows[0].products : [],
        orders: Array.isArray(rows[0]?.orders) ? rows[0].orders : [],
        shipments: Array.isArray(rows[0]?.shipments) ? rows[0].shipments : [],
        stock: Array.isArray(rows[0]?.stock) ? rows[0].stock : [],
        bioRecords: Array.isArray(rows[0]?.bio_records) ? rows[0].bio_records : [],
      };
      const bioRecords = stockItemCount === 1
        ? buildPublicBioRecordsForStock(projectedState, requestedSiteId, stockItemId)
        : null;
      storePublicProjection(
        publicBioRecordsCache,
        cacheKey,
        rows[0]?.version,
        bioRecords,
        PUBLIC_BIO_CACHE_MAX_ENTRIES
      );
      if (!bioRecords) {
        sendJson(req, res, 404, { ok: false, error: "Stock item is not public" });
        return;
      }
      sendJson(req, res, 200, { ok: true, bioRecords });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode ?? 500), {
        ok: false,
        error: error.message || "Failed to load public bio records",
      });
    } finally {
      releaseProjectionSlot?.();
    }
    return;
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      user: req.auth.user,
      account: authAccountPermissionSummary(req.auth.account),
    });
    return;
  }

  if (url.pathname === "/api/personnel/self-profile" && req.method === "GET") {
    try {
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const state = rows[0]?.data ?? {};
      const person = personnelForAuthenticatedAccount(state, req);
      sendJson(req, res, 200, {
        ok: true,
        ...selfProfileResponseForPersonnel(state, person),
      }, { "Cache-Control": "no-store, private" });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode ?? 400), {
        ok: false,
        error: error.message || "本人资料加载失败",
      }, { "Cache-Control": "no-store, private" });
    }
    return;
  }

  if (url.pathname === "/api/personnel/self-profile/attachment" && req.method === "POST") {
    let filePath = "";
    let persisted = false;
    let retiredAttachmentIds = [];
    const client = await pool.connect();
    try {
      const kind = normalizePersonnelAttachmentKind(url.searchParams.get("kind"));
      const requesterPersonnelId = String(req.auth?.account?.id ?? "").trim();
      if (!requesterPersonnelId) throw new Error("当前系统账号未绑定人员档案");
      const targetPersonnelId = requesterPersonnelId;
      const mime = normalizeUploadMime(req.headers["content-type"], req.headers["x-file-name"]);
      if (!String(mime).startsWith("image/")) throw new Error("人员资料附件仅支持图片");
      const buffer = await readRawBody(req, Math.min(MAX_IMAGE_UPLOAD_BYTES, MAX_PERSONNEL_ATTACHMENT_BYTES));
      if (buffer.length === 0) throw new Error("上传文件为空");
      validateImageUploadBuffer(buffer, mime);
      let decodedFilename = String(req.headers["x-file-name"] ?? "");
      try {
        decodedFilename = decodeURIComponent(decodedFilename);
      } catch {
        // The sanitizer below still handles a malformed, unescaped header safely.
      }
      const originalName = sanitizeAttachmentFilename(decodedFilename || `人员资料${extensionForMime(mime)}`);
      const attachmentId = `pa-${randomBytes(18).toString("base64url")}`;
      const encrypted = encryptPersonnelAttachmentBuffer(buffer, {
        attachmentId,
        personnelId: targetPersonnelId,
        kind,
        keyring: personnelDataKeyring,
      });
      filePath = privatePersonnelAttachmentPath(uploadDir, attachmentId);
      await mkdir(join(uploadDir, PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY), { recursive: true });
      await writeFile(filePath, encrypted, { flag: "wx", mode: 0o600 });

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const target = (Array.isArray(state.personnel) ? state.personnel : [])
        .find((person) => String(person?.id ?? "") === targetPersonnelId);
      if (!target || isPersonnelResigned(target)) throw new Error("目标人员不存在或已离职");
      const createdAt = new Date().toISOString();
      const lifecycleNow = new Date(createdAt);
      const currentAttachments = currentPersonnelPrivateAttachments(state);
      const retainedAttachments = retireReplaceablePersonnelAttachmentDrafts(currentAttachments, {
        personnelId: targetPersonnelId,
        kind,
        replacementId: attachmentId,
        now: lifecycleNow,
      });
      retiredAttachmentIds = terminalPersonnelAttachmentIds(currentAttachments, retainedAttachments);
      const activeAttachmentCount = retainedAttachments
        .filter((reference) =>
          String(reference?.personnelId ?? "") === targetPersonnelId &&
          ["draft", "pending"].includes(reference?.status)
        ).length;
      if (activeAttachmentCount >= 20) throw new Error("当前人员待处理附件过多，请完成或驳回现有资料申请后再上传");
      const reference = {
        id: attachmentId,
        kind,
        originalName,
        mime,
        size: buffer.length,
        personnelId: targetPersonnelId,
        ownerPersonnelId: targetPersonnelId,
        uploadedByPersonnelId: requesterPersonnelId,
        uploadedBy: authenticatedOperator(req),
        status: "draft",
        createdAt,
        updatedAt: createdAt,
        expiresAt: new Date(lifecycleNow.getTime() + PERSONNEL_ATTACHMENT_DRAFT_RETENTION_MS).toISOString(),
      };
      const operationLog = createOperationLog(
        req,
        "人员管理",
        "上传私密附件",
        `为人员「${target.name || target.personnelNo}」上传${kind === "id_card_front" ? "身份证正面" : kind === "id_card_back" ? "身份证反面" : "学历证明"}`
      );
      const nextState = {
        ...state,
        personnelPrivateAttachments: [reference, ...retainedAttachments],
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      persisted = true;
      await removePersonnelAttachmentFiles(retiredAttachmentIds);
      sendJson(req, res, 200, {
        ok: true,
        attachment: publicPersonnelAttachmentMetadata(reference),
      }, { "Cache-Control": "no-store, private" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (filePath && !persisted) await rm(filePath, { force: true }).catch(() => undefined);
      sendJson(req, res, Number(error?.statusCode ?? 400), {
        ok: false,
        error: error.message || "人员资料附件上传失败",
      }, { "Cache-Control": "no-store, private" });
    } finally {
      client.release();
    }
    return;
  }

  const personnelAttachmentRoute = url.pathname.match(/^\/api\/personnel\/attachments\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
  if (personnelAttachmentRoute && req.method === "GET") {
    const client = await pool.connect();
    try {
      const attachmentId = personnelAttachmentRoute[1];
      const requesterPersonnelId = String(req.auth?.account?.id ?? "").trim();
      const isAdmin = req.auth?.account?.accessRole === "admin" && isPersonnelAccountEnabled(req.auth?.account);
      const download = url.searchParams.get("download") === "1";
      if (download && !isAdmin) {
        const error = new Error("仅管理员可以下载人员私密附件");
        error.statusCode = 403;
        throw error;
      }
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const reference = findPersonnelAttachmentReference(state, attachmentId);
      assertPersonnelAttachmentReferenceAccess(reference, {
        requesterPersonnelId,
        isAdmin,
        allowOwnerPreview: true,
      });
      const encrypted = await readFile(privatePersonnelAttachmentPath(uploadDir, attachmentId));
      const buffer = decryptPersonnelAttachmentBuffer(encrypted, {
        attachmentId,
        personnelId: reference.personnelId,
        kind: reference.kind,
        keyring: personnelDataKeyring,
      });
      if (isAdmin) {
        const target = (Array.isArray(state.personnel) ? state.personnel : [])
          .find((person) => String(person?.id ?? "") === String(reference.personnelId ?? ""));
        const operationLog = createOperationLog(
          req,
          "人员管理",
          download ? "下载私密附件" : "查看私密附件",
          `${download ? "下载" : "查看"}人员「${target?.name || target?.personnelNo || reference.personnelId}」的${reference.kind === "id_card_front" ? "身份证正面" : reference.kind === "id_card_back" ? "身份证反面" : "学历证明"}`
        );
        await client.query("UPDATE app_state SET data = jsonb_set(data, '{operationLogs}', $2::jsonb, true), updated_at = now() WHERE id = $1", [
          stateId,
          JSON.stringify(pushOperationLog(state.operationLogs, operationLog)),
        ]);
      }
      await client.query("COMMIT");
      const originalName = sanitizeAttachmentFilename(reference.originalName);
      const disposition = download ? "attachment" : "inline";
      res.writeHead(200, {
        "Content-Type": String(reference.mime || "application/octet-stream"),
        "Content-Length": String(buffer.length),
        "Content-Disposition": `${disposition}; filename="personnel-attachment${extensionForMime(reference.mime)}"; filename*=UTF-8''${encodeURIComponent(originalName)}`,
        "Cache-Control": "no-store, private",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
      });
      res.end(buffer);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const status = Number(error?.statusCode ?? (error?.code === "ENOENT" ? 404 : 400));
      sendJson(req, res, status, {
        ok: false,
        error: status === 404 ? "人员资料附件不存在" : (error.message || "人员资料附件读取失败"),
      }, { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/personnel/self-profile/submit" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const input = body.profile && typeof body.profile === "object" && !Array.isArray(body.profile)
        ? body.profile
        : {};
      if (!Object.prototype.hasOwnProperty.call(body, "baseProfileRevision") ||
          body.baseProfileRevision === "" || body.baseProfileRevision == null) {
        throw new Error("缺少人员资料版本，请刷新后重试");
      }
      const baseProfileRevision = Number(body.baseProfileRevision);
      if (!Number.isSafeInteger(baseProfileRevision) || baseProfileRevision < 0) {
        throw new Error("人员资料版本不正确，请刷新后重试");
      }
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const person = personnelForAuthenticatedAccount(state, req);
      const currentRevision = profileRevisionForPersonnel(person);
      if (baseProfileRevision !== currentRevision) {
        const error = new Error("正式人员资料已发生变化，请刷新后重新提交");
        error.statusCode = 409;
        throw error;
      }
      const existingPending = currentPersonnelProfileRequests(state)
        .find((request) => request?.status === "pending" && String(request?.personnelId ?? "") === String(person.id));
      if (existingPending) {
        const error = new Error("已有一份人员资料申请等待审批，请勿重复提交");
        error.statusCode = 409;
        throw error;
      }
      const beforeProfile = storedPersonnelSelfProfile(person);
      const proposedProfile = normalizeSubmittedSelfProfile(state, person, input);
      const changedFields = changedPersonnelSelfProfileFields(beforeProfile, proposedProfile);
      if (changedFields.length === 0) {
        const error = new Error("人员资料没有发生变化，无需重复提交");
        error.statusCode = 409;
        throw error;
      }
      const requestId = uid("profile-request");
      const createdAt = new Date().toISOString();
      const request = {
        id: requestId,
        personnelId: String(person.id),
        requesterUsername: String(person.username),
        requesterName: String(person.name),
        status: "pending",
        baseProfileRevision: currentRevision,
        changedFields,
        beforeProfile: encryptPersonnelProfileProposalFields(beforeProfile, person.id, personnelDataKeyring),
        proposedProfile: encryptPersonnelProfileProposalFields(proposedProfile, person.id, personnelDataKeyring),
        createdAt,
      };
      const allAdministrators = activeAdministratorRecipients(state.personnel);
      const otherAdministrators = allAdministrators.filter((recipient) => recipient.personnelId !== String(person.id));
      const uniqueAdministratorSelfReview = otherAdministrators.length === 0 &&
        allAdministrators.length === 1 &&
        allAdministrators[0].personnelId === String(person.id);
      const approvers = otherAdministrators.length > 0 ? otherAdministrators : (uniqueAdministratorSelfReview ? allAdministrators : []);
      if (approvers.length === 0) throw new Error("当前没有可审批人员资料的启用管理员，请先配置管理员账号");
      const ensured = ensurePersonnelProfileApprovalNotifications(currentStationNotifications(state), {
        profileRequestId: requestId,
        notificationIds: approvers.map(() => uid("notice")),
        requesterNotificationId: uid("notice"),
        recipients: approvers,
        requester: { username: person.username, name: person.name },
        createdAt,
        createdBy: person.username,
        createdByName: person.name,
        changedFieldCount: changedFields.length,
      });
      const operationLog = createOperationLog(
        req,
        "人员管理",
        "提交资料审批",
        `人员「${person.name}」（${person.personnelNo || person.id}）提交 ${changedFields.length} 项本人资料修改${uniqueAdministratorSelfReview ? "；当前仅有该管理员账号，允许唯一管理员自审" : ""}`
      );
      const nextState = {
        ...state,
        personnelProfileRequests: [request, ...currentPersonnelProfileRequests(state)].slice(0, 5000),
        personnelPrivateAttachments: updateProfileAttachmentRequestStatuses(
          currentPersonnelPrivateAttachments(state),
          proposedProfile,
          requestId,
          "pending"
        ),
        notifications: ensured.notifications,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        request: personnelProfileRequestSummary(request),
        ...stationNotificationPayloadForAuth(nextState, req, 100),
        message: "人员资料修改申请已提交，等待管理员审批",
      }, { "Cache-Control": "no-store, private" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, Number(error?.statusCode ?? 400), {
        ok: false,
        error: error.message || "人员资料申请提交失败",
      }, { "Cache-Control": "no-store, private" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/stock/adjustment-draft" && req.method === "GET") {
    try {
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const state = rows[0]?.data ?? {};
      sendJson(req, res, 200, {
        ok: true,
        draft: inventoryAdjustmentDraftForUser(state, authenticatedOperator(req)),
      });
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message || "盘库草稿加载失败" });
    }
    return;
  }

  if (url.pathname === "/api/stock/adjustment-draft" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const username = authenticatedOperator(req);
      const existingDraft = inventoryAdjustmentDraftForUser(state, username);
      let draft = null;
      let inventoryAdjustmentDrafts;
      if (body.action === "delete") {
        inventoryAdjustmentDrafts = currentInventoryAdjustmentDrafts(state)
          .filter((item) => String(item?.createdBy ?? "") !== username);
      } else {
        draft = normalizeInventoryAdjustmentDraft(state, body.draft ?? body, req, existingDraft);
        inventoryAdjustmentDrafts = replaceInventoryAdjustmentDraft(state, draft);
      }
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify({ ...state, inventoryAdjustmentDrafts }),
      ]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, draft });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "盘库草稿保存失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/notifications" && req.method === "GET") {
    try {
      const state = await readStationNotificationState();
      const requestedLimit = Number.parseInt(String(url.searchParams.get("limit") ?? "100"), 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(500, Math.max(1, requestedLimit))
        : 100;
      sendJson(req, res, 200, {
        ok: true,
        ...stationNotificationPayloadForAuth(state, req, limit),
      });
    } catch (error) {
      sendJson(req, res, 500, { ok: false, error: error.message || "站内信加载失败" });
    }
    return;
  }

  if (url.pathname === "/api/notifications/detail" && req.method === "GET") {
    let auditClient;
    let auditTransactionOpen = false;
    let auditOperationLogs = [];
    try {
      const notificationId = String(url.searchParams.get("id") ?? "").trim();
      if (!notificationId) throw new Error("缺少站内信编号");
      let state = await readStationNotificationState();
      let notification = notificationsForRecipient(
        currentStationNotifications(state),
        req.auth?.user?.username
      ).find((item) => String(item?.id ?? "") === notificationId);
      if (!notification) {
        sendJson(req, res, 404, { ok: false, error: "站内信不存在或无权查看" });
        return;
      }
      if (notification.type === "stock_approval") {
        const approvalRequest = currentApprovalRequests(state)
          .find((request) => String(request?.id ?? "") === String(notification.approvalRequestId ?? ""));
        const preliminaryReview = stockApprovalReviewDetails(approvalRequest, state);
        if (preliminaryReview.reviewComplete && preliminaryReview.rebuiltFromPayload) {
          const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
          state = rows[0]?.data ?? state;
        }
      }
      let projectionRequest = req;
      const administratorProfileDetail = notification.type === "personnel_profile_approval" &&
        req.auth?.account?.accessRole === "admin";
      if (administratorProfileDetail) {
        auditClient = await pool.connect();
        await auditClient.query("BEGIN");
        auditTransactionOpen = true;
        state = await readStationNotificationState(auditClient, { forUpdate: true });
        const { rows: operationLogRows } = await auditClient.query(
          "SELECT COALESCE(data->'operationLogs', '[]'::jsonb) AS operation_logs FROM app_state WHERE id = $1",
          [stateId]
        );
        auditOperationLogs = Array.isArray(operationLogRows[0]?.operation_logs)
          ? operationLogRows[0].operation_logs
          : [];
        notification = notificationsForRecipient(
          currentStationNotifications(state),
          req.auth?.user?.username
        ).find((item) => String(item?.id ?? "") === notificationId);
        if (!notification || notification.type !== "personnel_profile_approval") {
          const error = new Error("站内信不存在或无权查看");
          error.statusCode = 404;
          throw error;
        }
        const lockedAccount = (Array.isArray(state.personnel) ? state.personnel : [])
          .find((person) => String(person?.id ?? "") === String(req.auth?.account?.id ?? ""));
        if (!lockedAccount || lockedAccount.accessRole !== "admin" || !isPersonnelAccountEnabled(lockedAccount)) {
          const error = new Error("仅启用中的管理员可以查看人员资料审批明细");
          error.statusCode = 403;
          throw error;
        }
        const profileRequest = currentPersonnelProfileRequests(state)
          .find((request) => String(request?.id ?? "") === String(notification.profileRequestId ?? ""));
        if (!profileRequest) {
          const error = new Error("人员资料申请不存在");
          error.statusCode = 404;
          throw error;
        }
        projectionRequest = {
          auth: {
            ...req.auth,
            account: lockedAccount,
          },
        };
      }
      const requesterOwnProfileNotification = notification.type === "personnel_profile_approval" &&
        notification.notificationRole === "requester" &&
        String(notification.recipientUsername ?? "") === String(req.auth?.user?.username ?? "");
      if (notification.type === "personnel_profile_approval" &&
          req.auth?.account?.accessRole !== "admin" &&
          !requesterOwnProfileNotification) {
        sendJson(req, res, 403, { ok: false, error: "仅管理员可以查看人员资料审批明细" }, {
          "Cache-Control": "no-store, private",
        });
        return;
      }
      const projectedNotification = stationNotificationForAuth(state, projectionRequest, notification, {
        includeStockDetails: true,
        includeProfileDetails: notification.type === "personnel_profile_approval",
      });
      if (administratorProfileDetail) {
        const target = (Array.isArray(state.personnel) ? state.personnel : [])
          .find((person) => String(person?.id ?? "") === String(
            currentPersonnelProfileRequests(state)
              .find((request) => String(request?.id ?? "") === String(notification.profileRequestId ?? ""))?.personnelId ?? ""
          ));
        const operationLog = createOperationLog(
          projectionRequest,
          "人员管理",
          "查看审批敏感明细",
          `查看人员「${target?.name || target?.personnelNo || "未知人员"}」的资料审批变更明细（申请 ${notification.profileRequestId}）`
        );
        await auditClient.query(
          "UPDATE app_state SET data = jsonb_set(data, '{operationLogs}', $2::jsonb, true), updated_at = now() WHERE id = $1",
          [stateId, JSON.stringify(pushOperationLog(auditOperationLogs, operationLog))]
        );
        await auditClient.query("COMMIT");
        auditTransactionOpen = false;
      }
      sendJson(req, res, 200, {
        ok: true,
        notification: projectedNotification,
      }, notification.type === "personnel_profile_approval" ? { "Cache-Control": "no-store, private" } : {});
    } catch (error) {
      if (auditTransactionOpen) await auditClient.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, Number(error?.statusCode ?? 400), {
        ok: false,
        error: error.message || "站内信明细加载失败",
      }, { "Cache-Control": "no-store, private" });
    } finally {
      auditClient?.release();
    }
    return;
  }

  if (url.pathname === "/api/notifications/read" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const ids = body.all === true
        ? []
        : Array.isArray(body.ids)
          ? body.ids
          : body.id
            ? [body.id]
            : [];
      if (body.all !== true && ids.length === 0) throw new Error("请选择要标记的站内信");
      await client.query("BEGIN");
      const state = await readStationNotificationState(client, { forUpdate: true });
      const marked = markNotificationsRead(
        currentStationNotifications(state),
        req.auth?.user?.username,
        ids
      );
      if (marked.changed) {
        await client.query("UPDATE app_state SET data = jsonb_set(data, '{notifications}', $2::jsonb, true), updated_at = now() WHERE id = $1", [
          stateId,
          JSON.stringify(marked.notifications),
        ]);
      }
      await client.query("COMMIT");
      const visibleNotifications = notificationsForRecipient(marked.notifications, req.auth?.user?.username);
      sendJson(req, res, 200, {
        ok: true,
        unreadCount: visibleNotifications.filter((notification) => !notification?.readAt).length,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "站内信状态更新失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/finance/overview" && req.method === "GET") {
    try {
      requireFinanceAccessForAuth(req);
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      const scope = financeSiteScope(
        state,
        req.auth?.account,
        url.searchParams.get("siteId") ?? ALL_SITE_ID
      );
      const [settlementResult, batchResult, transferResult, statementResult, statementBatchResult] = await Promise.all([
        pool.query(
          `SELECT data, batch_id, created_at
           FROM finance_platform_settlements
           WHERE state_id = $1 AND site_id = ANY($2::text[])
           ORDER BY settlement_time DESC, created_at DESC`,
          [stateId, scope.siteIds]
        ),
        pool.query(
          `SELECT id, site_id, file_name, file_hash, imported_at, imported_by,
                  row_count, matched_count, unmatched_count, duplicate_count, totals
           FROM finance_import_batches
           WHERE state_id = $1 AND site_id = ANY($2::text[])
           ORDER BY imported_at DESC
           LIMIT 100`,
          [stateId, scope.siteIds]
        ),
        pool.query(
          `SELECT id, site_id, channel, source_account, target_account,
                  expected_amount, actual_amount, transferred_at, transaction_no,
                  status, import_batch_ids, proof, notes, created_at, created_by,
                  verified_at, verified_by
           FROM finance_account_transfers
           WHERE state_id = $1 AND site_id = ANY($2::text[])
           ORDER BY transferred_at DESC, created_at DESC
           LIMIT 300`,
          [stateId, scope.siteIds]
        ),
        pool.query(
          `SELECT *
           FROM finance_payment_statements
           WHERE state_id = $1 AND site_id = ANY($2::text[])
           ORDER BY occurred_at DESC, created_at DESC
           LIMIT 1000`,
          [stateId, scope.siteIds]
        ),
        pool.query(
          `SELECT *
           FROM finance_statement_import_batches
           WHERE state_id = $1 AND site_id = ANY($2::text[])
           ORDER BY imported_at DESC
           LIMIT 100`,
          [stateId, scope.siteIds]
        ),
      ]);
      sendJson(req, res, 200, {
        ok: true,
        siteId: scope.requested,
        ...buildFinanceOverview(
          scope.state,
          settlementResult.rows,
          batchResult.rows,
          transferResult.rows,
          statementResult.rows,
          statementBatchResult.rows,
        ),
      });
    } catch (error) {
      sendJson(req, res, 403, { ok: false, error: error.message || "财务数据加载失败" });
    }
    return;
  }

  if (url.pathname === "/api/finance/statements/preview" && req.method === "POST") {
    try {
      requireModulePermissionForAuth(req, "finance", "create");
      const body = JSON.parse(await readBody(req) || "{}");
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const state = rows[0]?.data ?? {};
      const scope = financeSiteScope(state, req.auth?.account, body.siteId ?? DEFAULT_SITE_ID);
      if (scope.requested === ALL_SITE_ID) throw new Error("导入收款账单前请选择具体场地");
      const paymentMethod = configuredPaymentMethod(state.systemSettings, body.paymentMethodId);
      if (!paymentMethod) throw new Error("所选付款方式未启用或未配置收款账户");
      if (isPlatformPaymentChannel(paymentMethod.channel) || paymentMethod.channel === "cash") {
        throw new Error("平台和现金不通过收款账单导入；平台使用平台结算，现金由订单负责人登记");
      }
      const parsed = parsePaymentStatementCsv(body.csvText, paymentMethod);
      const existing = await pool.query(
        `SELECT fingerprint FROM finance_payment_statements
         WHERE state_id = $1 AND site_id = $2 AND payment_method_id = $3`,
        [stateId, scope.requested, paymentMethod.id]
      );
      const existingFingerprints = new Set(existing.rows.map((row) => String(row?.fingerprint ?? "")));
      const profiles = financeMatchingOrderProfiles(scope.state);
      const previewRows = parsed.records.map((record) => {
        const duplicate = existingFingerprints.has(record.fingerprint);
        const match = duplicate ? { matchedOrderId: "", candidates: [], reason: "该流水已经导入" }
          : matchPaymentStatement(record, profiles);
        const matched = profiles.find((order) => order.id === match.matchedOrderId);
        return {
          rowNumber: record.rowNumber,
          externalTransactionNo: record.externalTransactionNo,
          occurredAt: record.occurredAt,
          amount: record.amount,
          direction: record.direction,
          payerName: record.payerName,
          notes: record.notes,
          duplicate,
          matchedOrderId: match.matchedOrderId,
          matchedOrderNo: matched?.orderNo ?? "",
          matchReason: match.reason,
          candidateCount: match.candidates.length,
        };
      });
      sendJson(req, res, 200, {
        ok: true,
        rowCount: parsed.records.length,
        matchedCount: previewRows.filter((row) => row.matchedOrderId).length,
        unmatchedCount: previewRows.filter((row) => !row.duplicate && !row.matchedOrderId).length,
        duplicateCount: previewRows.filter((row) => row.duplicate).length,
        errors: parsed.errors,
        totals: parsed.totals,
        rows: previewRows.slice(0, 200),
      });
    } catch (error) {
      sendJson(req, res, 400, { ok: false, error: error.message || "收款账单解析失败" });
    }
    return;
  }

  if (url.pathname === "/api/finance/statements/import" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireModulePermissionForAuth(req, "finance", "create");
      const body = JSON.parse(await readBody(req) || "{}");
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const scope = financeSiteScope(state, req.auth?.account, body.siteId ?? DEFAULT_SITE_ID);
      if (scope.requested === ALL_SITE_ID) throw new Error("导入收款账单前请选择具体场地");
      const paymentMethod = configuredPaymentMethod(state.systemSettings, body.paymentMethodId);
      if (!paymentMethod) throw new Error("所选付款方式未启用或未配置收款账户");
      if (isPlatformPaymentChannel(paymentMethod.channel) || paymentMethod.channel === "cash") {
        throw new Error("平台和现金不通过收款账单导入");
      }
      const parsed = parsePaymentStatementCsv(body.csvText, paymentMethod);
      const duplicateBatch = await client.query(
        `SELECT id, row_count, matched_count, unmatched_count, duplicate_count
         FROM finance_statement_import_batches
         WHERE state_id = $1 AND site_id = $2 AND payment_method_id = $3 AND file_hash = $4`,
        [stateId, scope.requested, paymentMethod.id, parsed.fileHash]
      );
      if (duplicateBatch.rowCount > 0) {
        await client.query("ROLLBACK");
        const batch = duplicateBatch.rows[0];
        sendJson(req, res, 200, {
          ok: true,
          duplicateFile: true,
          batchId: String(batch.id),
          rowCount: Number(batch.row_count),
          matchedCount: Number(batch.matched_count),
          unmatchedCount: Number(batch.unmatched_count),
          duplicateCount: Number(batch.duplicate_count),
        });
        return;
      }

      const existing = await client.query(
        `SELECT fingerprint FROM finance_payment_statements
         WHERE state_id = $1 AND site_id = $2 AND payment_method_id = $3`,
        [stateId, scope.requested, paymentMethod.id]
      );
      const existingFingerprints = new Set(existing.rows.map((row) => String(row?.fingerprint ?? "")));
      const batchId = uid("statement-batch");
      let nextState = state;
      let matchedCount = 0;
      let unmatchedCount = 0;
      let duplicateCount = 0;

      for (const record of parsed.records) {
        if (existingFingerprints.has(record.fingerprint)) {
          duplicateCount += 1;
          continue;
        }
        existingFingerprints.add(record.fingerprint);
        const profiles = financeMatchingOrderProfiles(siteFilteredState(nextState, scope.requested));
        const match = matchPaymentStatement(record, profiles);
        const statementId = uid("statement");
        const statement = { ...record, id: statementId, siteId: scope.requested };
        let matchedPaymentId = "";
        if (match.matchedOrderId) {
          const linked = linkStatementToStateOrder(nextState, statement, match.matchedOrderId, "auto", "system");
          nextState = linked.state;
          matchedPaymentId = linked.payment.id;
          matchedCount += 1;
        } else {
          unmatchedCount += 1;
        }
        await client.query(
          `INSERT INTO finance_payment_statements (
             id, state_id, site_id, batch_id, payment_method_id, payment_method_name,
             channel, account, fingerprint, external_transaction_no, occurred_at,
             amount, direction, payer_name, notes, raw_data, candidate_orders,
             match_status, match_reason, matched_order_id, matched_payment_id,
             match_method, matched_at, matched_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12, $13, $14, $15, $16::jsonb, $17::jsonb,
             $18, $19, $20, $21, $22, $23::timestamptz, $24
           )`,
          [
            statementId, stateId, scope.requested, batchId, paymentMethod.id, paymentMethod.name,
            paymentMethod.channel, paymentMethod.account, record.fingerprint, record.externalTransactionNo,
            record.occurredAt, record.amount, record.direction, record.payerName, record.notes,
            JSON.stringify(record.rawData), JSON.stringify(match.candidates),
            match.matchedOrderId ? "matched" : "unmatched", match.reason, match.matchedOrderId,
            matchedPaymentId, match.matchedOrderId ? "auto" : "",
            match.matchedOrderId ? new Date().toISOString() : null,
            match.matchedOrderId ? "system" : "",
          ]
        );
      }

      await client.query(
        `INSERT INTO finance_statement_import_batches (
           id, state_id, site_id, payment_method_id, payment_method_name, channel,
           account, file_name, file_hash, imported_by, row_count, matched_count,
           unmatched_count, duplicate_count, totals
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)`,
        [
          batchId, stateId, scope.requested, paymentMethod.id, paymentMethod.name, paymentMethod.channel,
          paymentMethod.account, String(body.fileName ?? "收款账单.csv"), parsed.fileHash, operator,
          parsed.records.length, matchedCount, unmatchedCount, duplicateCount, JSON.stringify(parsed.totals),
        ]
      );
      const operationLog = createOperationLog(
        req,
        "财务管理",
        "导入收款账单",
        `${paymentMethod.name}「${paymentMethod.account}」导入 ${parsed.records.length} 条，自动匹配 ${matchedCount} 条，待认领 ${unmatchedCount} 条，重复 ${duplicateCount} 条`
      );
      nextState = {
        ...nextState,
        operationLogs: pushOperationLog(nextState.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        duplicateFile: false,
        batchId,
        rowCount: parsed.records.length,
        matchedCount,
        unmatchedCount,
        duplicateCount,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "收款账单导入失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/finance/statements/link" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const action = String(body.action ?? "link");
      if (!['link', 'unlink'].includes(action)) throw new Error("不支持的账单关联操作");
      const operator = authenticatedOperator(req);
      const financeActor = hasModulePermission(req.auth?.account, "finance", "update");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const statementResult = await client.query(
        `SELECT * FROM finance_payment_statements WHERE id = $1 AND state_id = $2 FOR UPDATE`,
        [String(body.statementId ?? ""), stateId]
      );
      if (statementResult.rowCount === 0) throw new Error("账单流水不存在，请刷新后重试");
      const statementRow = statementResult.rows[0];
      const statement = paymentStatementFromRow(statementRow);
      if (!visibleSiteIdsForAccount(req.auth?.account, state).includes(statement.siteId)) {
        throw new Error("当前账户无权查看该场地账单");
      }

      let nextState = state;
      let detail = "";
      let linkedOrder = null;
      if (action === "unlink") {
        if (!financeActor) throw new Error("只有财务可以解除账单关联");
        if (statement.matchStatus === "verified") throw new Error("已核销流水不能解除关联");
        const currentOrder = (Array.isArray(state.orders) ? state.orders : [])
          .find((order) => String(order?.id ?? "") === statement.matchedOrderId);
        if (!currentOrder) throw new Error("已关联订单不存在，请刷新后重试");
        const payment = (Array.isArray(currentOrder.payments) ? currentOrder.payments : [])
          .find((item) => String(item?.id ?? "") === statement.matchedPaymentId);
        if (payment && isPaymentVerified(payment)) throw new Error("已核销资金记录不能解除关联");
        const nextPayments = statement.direction === "expense" && payment
          ? (Array.isArray(currentOrder.payments) ? currentOrder.payments : []).map((item) => {
            if (String(item?.id ?? "") !== statement.matchedPaymentId) return item;
            const original = item?.statementOriginal && typeof item.statementOriginal === "object"
              ? item.statementOriginal
              : {};
            return normalizePaymentRecord({
              ...item,
              time: original.time || item.time,
              externalTransactionNo: original.externalTransactionNo || "",
              recordSource: original.recordSource || "order",
              notes: original.notes || item.notes,
              statementId: "",
              matchMethod: "",
              statementOriginal: null,
            });
          })
          : (Array.isArray(currentOrder.payments) ? currentOrder.payments : [])
            .filter((item) => String(item?.id ?? "") !== statement.matchedPaymentId);
        linkedOrder = { ...currentOrder, payments: nextPayments };
        nextState = {
          ...state,
          orders: (Array.isArray(state.orders) ? state.orders : []).map((order) =>
            String(order?.id ?? "") === linkedOrder.id ? linkedOrder : order
          ),
        };
        await client.query(
          `UPDATE finance_payment_statements
           SET match_status = 'unmatched', matched_order_id = '', matched_payment_id = '',
               match_method = '', matched_at = NULL, matched_by = '', verified_at = NULL, verified_by = ''
           WHERE id = $1 AND state_id = $2`,
          [statement.id, stateId]
        );
        detail = `流水「${statement.externalTransactionNo || statement.id}」解除与订单「${currentOrder.orderNo}」的关联`;
      } else {
        if (statement.matchStatus !== "unmatched") throw new Error("该流水已经关联订单");
        const orderId = String(body.orderId ?? "").trim();
        const currentOrder = (Array.isArray(state.orders) ? state.orders : [])
          .find((order) => String(order?.id ?? "") === orderId);
        if (!currentOrder) throw new Error("系统订单不存在，请刷新后重试");
        if (!financeActor) {
          requireOrderPermissionForAuth(req, "update");
          if (!isCreditSaleOrderOwner(state.personnel, currentOrder, operator)) {
            throw new Error("只有该订单负责人可以认领这笔流水");
          }
          const candidateIds = new Set(statement.candidates.map((candidate) => String(candidate?.orderId ?? "")));
          if (!candidateIds.has(orderId)) throw new Error("该流水不是此订单的候选收款，请联系财务处理");
        }
        const method = financeActor ? "finance" : "owner";
        const linked = linkStatementToStateOrder(state, statement, orderId, method, operator);
        nextState = linked.state;
        linkedOrder = linked.order;
        await client.query(
          `UPDATE finance_payment_statements
           SET match_status = 'matched', matched_order_id = $3, matched_payment_id = $4,
               match_method = $5, matched_at = now(), matched_by = $6
           WHERE id = $1 AND state_id = $2`,
          [statement.id, stateId, orderId, linked.payment.id, method, operator]
        );
        detail = `流水「${statement.externalTransactionNo || statement.id}」关联订单「${linked.order.orderNo}」，待财务核销`;
      }

      const operationLog = createOperationLog(
        req,
        financeActor ? "财务管理" : "订单管理",
        action === "unlink" ? "解除收款关联" : financeActor ? "关联收款流水" : "认领收款流水",
        detail
      );
      nextState = {
        ...nextState,
        operationLogs: pushOperationLog(nextState.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await refreshStatementBatchMatchCounts(client, statement.batchId);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, order: linkedOrder, orders: nextState.orders, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "账单关联失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/finance/transfers" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await externalizeDataUrls(JSON.parse(await readBody(req) || "{}"));
      const action = String(body.action ?? "").trim();
      const permissionAction = action === "add"
        ? "create"
        : action === "update" || action === "verify"
          ? "update"
          : action === "delete"
            ? "delete"
            : "";
      if (!permissionAction) throw new Error("不支持的到账批次操作");
      requireModulePermissionForAuth(req, "finance", permissionAction);
      const operator = authenticatedOperator(req);

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const transferId = String(body.id ?? body.transfer?.id ?? "").trim();
      const existingResult = transferId
        ? await client.query(
          `SELECT * FROM finance_account_transfers WHERE id = $1 AND state_id = $2 FOR UPDATE`,
          [transferId, stateId]
        )
        : { rows: [], rowCount: 0 };
      const existing = existingResult.rows[0];

      if (action !== "add" && !existing) throw new Error("到账批次不存在，请刷新后重试");
      const requestedSiteId = action === "add"
        ? body.siteId
        : existing.site_id;
      const scope = financeSiteScope(state, req.auth?.account, requestedSiteId ?? DEFAULT_SITE_ID);
      if (scope.requested === ALL_SITE_ID) throw new Error("登记到账前请选择具体场地");

      let detail = "";
      let savedTransfer = null;
      if (action === "delete") {
        if (existing.status === "verified") throw new Error("已核销到账批次不能删除");
        await client.query("DELETE FROM finance_account_transfers WHERE id = $1 AND state_id = $2", [transferId, stateId]);
        detail = `删除到账批次「${existing.transaction_no || transferId}」¥${Number(existing.actual_amount ?? 0).toFixed(2)}`;
      } else if (action === "verify") {
        if (existing.status === "verified") throw new Error("该到账批次已经核销");
        const verified = await client.query(
          `UPDATE finance_account_transfers
           SET status = 'verified', verified_at = now(), verified_by = $3
           WHERE id = $1 AND state_id = $2
           RETURNING *`,
          [transferId, stateId, operator]
        );
        savedTransfer = financeTransferFromRow(verified.rows[0]);
        detail = `核销到账批次「${existing.transaction_no || transferId}」¥${Number(existing.actual_amount ?? 0).toFixed(2)}`;
      } else {
        if (existing?.status === "verified") throw new Error("已核销到账批次不能修改");
        const input = body.transfer && typeof body.transfer === "object" ? body.transfer : body;
        const channel = normalizePaymentChannel(input.channel ?? existing?.channel);
        if (!channel) throw new Error("请选择资金渠道");
        const sourceAccount = String(input.sourceAccount ?? existing?.source_account ?? "").trim();
        const targetAccount = String(input.targetAccount ?? existing?.target_account ?? "").trim();
        if (!sourceAccount || !targetAccount) throw new Error("请填写转出账户和对公到账账户");
        const actualAmount = normalizeMoney(input.actualAmount ?? existing?.actual_amount, "Actual transfer amount");
        if (actualAmount <= 0) throw new Error("实际到账金额必须大于 0");
        const transferredAt = String(input.transferredAt ?? existing?.transferred_at ?? "").trim();
        if (!transferredAt) throw new Error("请选择到账时间");
        const importBatchIds = [...new Set((Array.isArray(input.importBatchIds)
          ? input.importBatchIds
          : Array.isArray(existing?.import_batch_ids) ? existing.import_batch_ids : [])
          .map(String)
          .filter(Boolean))];
        let expectedAmount = normalizeMoney(input.expectedAmount ?? existing?.expected_amount, "Expected transfer amount");
        if (importBatchIds.length > 0) {
          const batches = await client.query(
            `SELECT id, totals FROM finance_import_batches
             WHERE state_id = $1 AND site_id = $2 AND id = ANY($3::text[])`,
            [stateId, scope.requested, importBatchIds]
          );
          if (batches.rowCount !== importBatchIds.length) throw new Error("所选抖店结算批次不存在或不属于当前场地");
          expectedAmount = roundFinance(batches.rows.reduce(
            (sum, batch) => sum + Number(batch?.totals?.settlementAmount ?? 0),
            0
          ));
          const usedTransfers = await client.query(
            `SELECT id, import_batch_ids FROM finance_account_transfers
             WHERE state_id = $1 AND site_id = $2 AND id <> $3`,
            [stateId, scope.requested, transferId || "__new__"]
          );
          const usedBatchIds = new Set(usedTransfers.rows.flatMap((row) =>
            Array.isArray(row?.import_batch_ids) ? row.import_batch_ids.map(String) : []
          ));
          const duplicateBatch = importBatchIds.find((batchId) => usedBatchIds.has(batchId));
          if (duplicateBatch) throw new Error("所选结算批次已经登记过到账，请勿重复关联");
        }
        const transactionNo = String(input.transactionNo ?? existing?.transaction_no ?? "").trim();
        const proof = Array.isArray(input.proof) ? input.proof : Array.isArray(existing?.proof) ? existing.proof : [];
        const notes = String(input.notes ?? existing?.notes ?? "");
        if (action === "add") {
          const id = String(input.id || uid("finance-transfer"));
          const inserted = await client.query(
            `INSERT INTO finance_account_transfers (
               id, state_id, site_id, channel, source_account, target_account,
               expected_amount, actual_amount, transferred_at, transaction_no,
               status, import_batch_ids, proof, notes, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11::jsonb, $12::jsonb, $13, $14)
             RETURNING *`,
            [id, stateId, scope.requested, channel, sourceAccount, targetAccount, expectedAmount,
              actualAmount, transferredAt, transactionNo, JSON.stringify(importBatchIds), JSON.stringify(proof), notes, operator]
          );
          savedTransfer = financeTransferFromRow(inserted.rows[0]);
          detail = `登记${paymentChannelLabel(channel)}到账批次 ¥${actualAmount.toFixed(2)}，待核销`;
        } else {
          const updated = await client.query(
            `UPDATE finance_account_transfers
             SET channel = $3, source_account = $4, target_account = $5,
                 expected_amount = $6, actual_amount = $7, transferred_at = $8,
                 transaction_no = $9, import_batch_ids = $10::jsonb,
                 proof = $11::jsonb, notes = $12
             WHERE id = $1 AND state_id = $2
             RETURNING *`,
            [transferId, stateId, channel, sourceAccount, targetAccount, expectedAmount,
              actualAmount, transferredAt, transactionNo, JSON.stringify(importBatchIds), JSON.stringify(proof), notes]
          );
          savedTransfer = financeTransferFromRow(updated.rows[0]);
          detail = `修改${paymentChannelLabel(channel)}到账批次 ¥${actualAmount.toFixed(2)}`;
        }
      }

      const operationLog = createOperationLog(
        req,
        "财务管理",
        action === "add" ? "添加记录" : action === "update" ? "修改记录" : action === "verify" ? "核销记录" : "删除记录",
        detail
      );
      const nextState = {
        ...state,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, transfer: savedTransfer, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "到账批次保存失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/finance/settings" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireModulePermissionForAuth(req, "finance", "update");
      const body = JSON.parse(await readBody(req) || "{}");
      const rawRate = Number(body.defaultCommissionRate);
      if (!Number.isFinite(rawRate) || rawRate < 0 || rawRate > 100) {
        throw new Error("默认提成比例必须在 0% 到 100% 之间");
      }
      const defaultCommissionRate = normalizeCommissionRate(rawRate);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const operationLog = createOperationLog(
        req,
        "财务管理",
        "修改记录",
        `默认订单负责人提成比例调整为 ${defaultCommissionRate}%`
      );
      const nextState = {
        ...state,
        systemSettings: {
          ...(state.systemSettings && typeof state.systemSettings === "object" ? state.systemSettings : {}),
          financeDefaultCommissionRate: defaultCommissionRate,
        },
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, defaultCommissionRate, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "提成设置保存失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/finance/order-commission" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireModulePermissionForAuth(req, "finance", "update");
      const body = JSON.parse(await readBody(req) || "{}");
      const orderId = String(body.orderId ?? "").trim();
      const rawRate = Number(body.commissionRate);
      if (!orderId) throw new Error("缺少订单信息");
      if (!Number.isFinite(rawRate) || rawRate < 0 || rawRate > 100) {
        throw new Error("订单提成比例必须在 0% 到 100% 之间");
      }
      const commissionRate = normalizeCommissionRate(rawRate);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const scope = financeSiteScope(state, req.auth?.account, ALL_SITE_ID);
      const order = (Array.isArray(scope.state.orders) ? scope.state.orders : [])
        .find((item) => String(item?.id ?? "") === orderId);
      if (!order) throw new Error("订单不存在或当前账户不可见");
      const orders = (Array.isArray(state.orders) ? state.orders : []).map((item) =>
        String(item?.id ?? "") === orderId ? { ...item, commissionRate } : item
      );
      const operationLog = createOperationLog(
        req,
        "财务管理",
        "修改记录",
        `订单「${order.orderNo}」负责人提成比例调整为 ${commissionRate}%`
      );
      const nextState = {
        ...state,
        orders,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, order: { ...order, commissionRate }, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "订单提成比例保存失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/finance/douyin/link" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireModulePermissionForAuth(req, "finance", "update");
      const body = JSON.parse(await readBody(req) || "{}");
      const externalOrderNo = normalizeExternalOrderNo(body.externalOrderNo);
      const orderId = String(body.orderId ?? "").trim();
      if (!externalOrderNo || !orderId) throw new Error("缺少抖音订单或系统订单信息");

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const scope = financeSiteScope(state, req.auth?.account, body.siteId ?? DEFAULT_SITE_ID);
      if (scope.requested === ALL_SITE_ID) throw new Error("关联订单前请选择具体场地");
      const settlement = await client.query(
        `SELECT id FROM finance_platform_settlements
         WHERE state_id = $1 AND site_id = $2 AND platform = 'douyin' AND external_order_no = $3
         LIMIT 1`,
        [stateId, scope.requested, externalOrderNo]
      );
      if (settlement.rowCount === 0) throw new Error("未找到该抖店结算记录，请刷新后重试");

      const currentOrder = (scope.state.orders ?? []).find((order) => String(order?.id ?? "") === orderId);
      if (!currentOrder) throw new Error("系统订单不存在或当前账户不可见");
      if (isPlatformOrderSource(currentOrder.source) && String(currentOrder.source ?? "").trim() !== "平台下单") {
        throw new Error(`${orderSourceLabel(currentOrder.source)}订单不能关联抖店结算`);
      }
      const existingExternalOrderNo = normalizeExternalOrderNo(currentOrder?.douyinOrderNo);
      if (existingExternalOrderNo && existingExternalOrderNo !== externalOrderNo) {
        throw new Error(`该系统订单已关联抖音订单 ${existingExternalOrderNo}`);
      }
      const conflict = (Array.isArray(state.orders) ? state.orders : []).find((order) =>
        String(order?.id ?? "") !== orderId &&
        String(order?.source ?? "").trim() === "平台下单" &&
        normalizeExternalOrderNo(order?.douyinOrderNo) === externalOrderNo
      );
      if (conflict) throw new Error(`抖音订单已关联到 ${conflict.orderNo || "其他系统订单"}`);
      const configuredDouyinMethod = configuredPaymentMethod(state.systemSettings, "douyin");
      const existingDouyinAccount = normalizePaymentChannel(currentOrder.paymentChannel) === "douyin"
        ? String(currentOrder.paymentAccount ?? "").trim()
        : "";
      const douyinAccount = existingDouyinAccount || configuredDouyinMethod?.account || "";
      if (!douyinAccount) throw new Error("抖音付款方式尚未配置收款账户");
      const preserveDouyinSnapshot = Boolean(existingDouyinAccount);

      const nextOrder = {
        ...currentOrder,
        platformOrderNo: externalOrderNo,
        douyinOrderNo: externalOrderNo,
        paymentMethodId: preserveDouyinSnapshot
          ? String(currentOrder.paymentMethodId ?? "").trim() || undefined
          : configuredDouyinMethod.id,
        paymentMethodName: preserveDouyinSnapshot
          ? String(currentOrder.paymentMethodName ?? "").trim() || paymentChannelLabel("douyin")
          : configuredDouyinMethod.name,
        paymentChannel: "douyin",
        paymentAccount: douyinAccount,
        paymentReference: externalOrderNo,
      };
      const nextOrders = (Array.isArray(state.orders) ? state.orders : []).map((order) =>
        String(order?.id ?? "") === orderId ? nextOrder : order
      );
      const operationLog = createOperationLog(
        req,
        "财务管理",
        "关联订单",
        `抖音订单「${externalOrderNo}」关联到系统订单「${currentOrder.orderNo}」`
      );
      const nextState = {
        ...state,
        orders: nextOrders,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await refreshFinanceBatchMatchCounts(client, nextState, scope.requested);
      await client.query("COMMIT");
      sendJson(req, res, 200, { ok: true, order: nextOrder, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "订单关联失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/finance/douyin/preview" && req.method === "POST") {
    try {
      requireFinanceAccessForAuth(req);
      const body = JSON.parse(await readBody(req) || "{}");
      const fileName = String(body.fileName ?? "抖店结算.csv").trim() || "抖店结算.csv";
      const parsed = parseDouyinSettlementCsv(body.csvText);
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const state = rows[0]?.data ?? {};
      const scope = financeSiteScope(state, req.auth?.account, body.siteId ?? DEFAULT_SITE_ID);
      if (scope.requested === ALL_SITE_ID) throw new Error("导入抖店账单前请选择具体场地");
      const orderLookup = financeOrderLookup(scope.state.orders ?? []);
      const [existingBatch, existingRows] = await Promise.all([
        pool.query(
          `SELECT id FROM finance_import_batches
           WHERE state_id = $1 AND site_id = $2 AND platform = 'douyin' AND file_hash = $3
           LIMIT 1`,
          [stateId, scope.requested, parsed.fileHash]
        ),
        pool.query(
          `SELECT fingerprint FROM finance_platform_settlements
           WHERE state_id = $1 AND site_id = $2 AND platform = 'douyin'
             AND fingerprint = ANY($3::text[])`,
          [stateId, scope.requested, parsed.records.map((record) => record.fingerprint)]
        ),
      ]);
      const duplicateFingerprints = new Set(existingRows.rows.map((row) => String(row.fingerprint)));
      const previewRows = parsed.records.map((record) => {
        const matchedOrder = orderLookup.get(record.externalOrderNo);
        return {
          rowNumber: record.rowNumber,
          externalOrderNo: record.externalOrderNo,
          settlementTime: record.settlementTime,
          productName: record.productName,
          orderTotal: record.orderTotal,
          incomeTotal: record.incomeTotal,
          refundTotal: Math.abs(record.preSettlementRefund),
          platformFees: Math.abs(record.expenseTotal),
          settlementAmount: record.settlementAmount,
          matchedOrderId: matchedOrder ? String(matchedOrder.id ?? "") : "",
          matchedOrderNo: matchedOrder ? String(matchedOrder.orderNo ?? "") : "",
          duplicate: duplicateFingerprints.has(record.fingerprint),
          formulaMatches: record.formulaMatches,
        };
      });
      sendJson(req, res, 200, {
        ok: true,
        fileName,
        fileHash: parsed.fileHash,
        rowCount: parsed.records.length,
        matchedCount: previewRows.filter((row) => row.matchedOrderId).length,
        unmatchedCount: previewRows.filter((row) => !row.matchedOrderId).length,
        duplicateCount: previewRows.filter((row) => row.duplicate).length,
        formulaMismatchCount: previewRows.filter((row) => !row.formulaMatches).length,
        duplicateFile: existingBatch.rowCount > 0,
        errors: parsed.errors,
        totals: parsed.totals,
        rows: previewRows.slice(0, 500),
      });
    } catch (error) {
      sendJson(req, res, 400, { ok: false, error: error.message || "抖店账单解析失败" });
    }
    return;
  }

  if (url.pathname === "/api/finance/douyin/import" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireModulePermissionForAuth(req, "finance", "create");
      const body = JSON.parse(await readBody(req) || "{}");
      const fileName = String(body.fileName ?? "抖店结算.csv").trim() || "抖店结算.csv";
      const parsed = parseDouyinSettlementCsv(body.csvText);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const scope = financeSiteScope(state, req.auth?.account, body.siteId ?? DEFAULT_SITE_ID);
      if (scope.requested === ALL_SITE_ID) throw new Error("导入抖店账单前请选择具体场地");
      const duplicateBatch = await client.query(
        `SELECT id, row_count, matched_count, unmatched_count, duplicate_count, totals
         FROM finance_import_batches
         WHERE state_id = $1 AND site_id = $2 AND platform = 'douyin' AND file_hash = $3
         LIMIT 1`,
        [stateId, scope.requested, parsed.fileHash]
      );
      if (duplicateBatch.rowCount > 0) {
        await client.query("ROLLBACK");
        const batch = duplicateBatch.rows[0];
        sendJson(req, res, 200, {
          ok: true,
          duplicateFile: true,
          batchId: String(batch.id),
          rowCount: Number(batch.row_count ?? 0),
          matchedCount: Number(batch.matched_count ?? 0),
          unmatchedCount: Number(batch.unmatched_count ?? 0),
          duplicateCount: Number(batch.duplicate_count ?? 0),
          totals: batch.totals ?? {},
        });
        return;
      }

      const existingRows = await client.query(
        `SELECT fingerprint FROM finance_platform_settlements
         WHERE state_id = $1 AND site_id = $2 AND platform = 'douyin'
           AND fingerprint = ANY($3::text[])`,
        [stateId, scope.requested, parsed.records.map((record) => record.fingerprint)]
      );
      const duplicateFingerprints = new Set(existingRows.rows.map((row) => String(row.fingerprint)));
      const records = parsed.records.filter((record) => !duplicateFingerprints.has(record.fingerprint));
      const orderLookup = financeOrderLookup(scope.state.orders ?? []);
      const matchedCount = records.filter((record) => orderLookup.has(record.externalOrderNo)).length;
      const unmatchedCount = records.length - matchedCount;
      const batchId = uid("finance-batch");
      const operator = authenticatedOperator(req);

      await client.query(
        `INSERT INTO finance_import_batches (
           id, state_id, site_id, platform, file_name, file_hash, imported_by,
           row_count, matched_count, unmatched_count, duplicate_count, totals
         ) VALUES ($1, $2, $3, 'douyin', $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [
          batchId,
          stateId,
          scope.requested,
          fileName,
          parsed.fileHash,
          operator,
          records.length,
          matchedCount,
          unmatchedCount,
          parsed.records.length - records.length,
          JSON.stringify(parsed.totals),
        ]
      );
      for (const record of records) {
        await client.query(
          `INSERT INTO finance_platform_settlements (
             id, state_id, site_id, batch_id, platform, fingerprint,
             external_order_no, sub_order_no, settlement_time, order_time, data
           ) VALUES ($1, $2, $3, $4, 'douyin', $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            uid("finance-row"),
            stateId,
            scope.requested,
            batchId,
            record.fingerprint,
            record.externalOrderNo,
            record.subOrderNo,
            record.settlementTime,
            record.orderTime,
            JSON.stringify(record),
          ]
        );
      }
      const operationLog = createOperationLog(
        req,
        "财务管理",
        "导入记录",
        `导入抖店结算文件「${fileName}」${records.length} 条，匹配 ${matchedCount} 条，未匹配 ${unmatchedCount} 条`
      );
      const nextState = {
        ...state,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        duplicateFile: false,
        batchId,
        rowCount: records.length,
        matchedCount,
        unmatchedCount,
        duplicateCount: parsed.records.length - records.length,
        totals: parsed.totals,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "抖店账单导入失败" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/personnel/profile-requests/decision" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireAdminForAuth(req, "仅管理员可以审批人员资料");
      const body = JSON.parse(await readBody(req) || "{}");
      const requestId = String(body.requestId ?? body.profileRequestId ?? "").trim();
      const decision = String(body.decision ?? "").trim();
      const note = normalizedPersonnelText(body.note, "处理说明", 500);
      if (!requestId) throw new Error("缺少人员资料申请编号");
      if (!['approve', 'reject'].includes(decision)) throw new Error("人员资料审批决定不正确");
      if (decision === "reject" && !note) throw new Error("驳回人员资料时请填写处理说明");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const requests = currentPersonnelProfileRequests(state);
      const request = requests.find((item) => String(item?.id ?? "") === requestId);
      if (!request) {
        const error = new Error("人员资料申请不存在");
        error.statusCode = 404;
        throw error;
      }
      if (request.status !== "pending") {
        const error = new Error("该人员资料申请已被处理，请勿重复操作");
        error.statusCode = 409;
        throw error;
      }
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const target = personnel.find((person) => String(person?.id ?? "") === String(request.personnelId ?? ""));
      const approverPersonnelId = String(req.auth?.account?.id ?? "");
      const selfReview = approverPersonnelId && approverPersonnelId === String(request.personnelId ?? "");
      if (selfReview) {
        const otherActiveAdministrators = activeAdministratorRecipients(personnel)
          .filter((recipient) => recipient.personnelId !== approverPersonnelId);
        if (otherActiveAdministrators.length > 0) {
          const error = new Error("存在其他启用管理员时，不能审批自己的人员资料");
          error.statusCode = 403;
          throw error;
        }
        if (req.auth?.account?.accessRole !== "admin") {
          const error = new Error("只有唯一启用管理员才可自审人员资料");
          error.statusCode = 403;
          throw error;
        }
      }

      const resolvedAt = new Date().toISOString();
      let nextPersonnel = personnel;
      let nextOrders = Array.isArray(state.orders) ? state.orders : [];
      let nextAttachments = currentPersonnelPrivateAttachments(state);
      let retiredAttachmentIds = [];
      let resolvedRequest;
      if (decision === "approve") {
        if (!target || isPersonnelResigned(target)) throw new Error("目标人员不存在或已离职，不能批准资料变更");
        if (profileRevisionForPersonnel(target) !== Number(request.baseProfileRevision ?? 0)) {
          const error = new Error("正式人员资料版本已变化，不能覆盖更新后的资料；请驳回后让申请人重新提交");
          error.statusCode = 409;
          throw error;
        }
        const decryptedProposal = decryptPersonnelProfileProposalFields(
          request.proposedProfile,
          request.personnelId,
          personnelDataKeyring
        );
        const canonicalProposal = { ...decryptedProposal };
        for (const field of PERSONNEL_PROFILE_ATTACHMENT_FIELDS) {
          const attachmentId = String(decryptedProposal?.[field]?.id ?? "");
          const reference = findPersonnelAttachmentReference(state, attachmentId);
          if (!reference ||
              String(reference.personnelId ?? "") !== String(target.id) ||
              reference.kind !== attachmentKindForPersonnelProfileField(field)) {
            throw new Error("人员资料附件不存在、归属错误或类型不匹配");
          }
          const currentAttachmentId = String(target?.[field]?.id ?? "");
          const requestOwnsPendingReference = reference.status === "pending" &&
            String(reference.profileRequestId ?? "") === requestId;
          const unchangedApprovedReference = reference.status === "approved" && attachmentId === currentAttachmentId;
          if (!requestOwnsPendingReference && !unchangedApprovedReference) {
            throw new Error("人员资料附件状态已变化，请驳回后重新提交");
          }
          canonicalProposal[field] = publicPersonnelAttachmentMetadata(reference);
        }
        const normalizedProposal = normalizePersonnelSelfProfile(canonicalProposal, { requireComplete: true });
        Object.assign(normalizedProposal, normalizePersonnelSensitiveFields(normalizedProposal));
        assertPersonnelSelfProfileComplete(normalizedProposal);
        // This approval only applies fields owned by the employee. Employment
        // and account fields belong to the administrator workflow, so their
        // completeness must not block an otherwise valid self-profile change.
        const encryptedSensitive = encryptPersonnelSensitiveFields(normalizedProposal, target.id, personnelDataKeyring);
        const nextPerson = applyApprovedPersonnelSelfProfile(target, normalizedProposal, encryptedSensitive);
        nextPersonnel = personnel.map((person) => String(person?.id ?? "") === String(target.id) ? nextPerson : person);
        if (String(nextPerson.name ?? "") !== String(target.name ?? "")) {
          nextOrders = nextOrders.map((order) => {
            const linkedPersonnelId = String(order?.contactPersonnelId ?? "").trim();
            if (linkedPersonnelId === String(target.id)) return { ...order, contactPerson: nextPerson.name };
            if (linkedPersonnelId) return order;
            const reference = String(order?.contactPerson ?? "").trim();
            if (!reference) return order;
            const matches = personnel.filter((person) =>
              String(person?.name ?? "").trim() === reference ||
              String(person?.username ?? "").trim() === reference
            );
            if (matches.length !== 1 || String(matches[0]?.id ?? "") !== String(target.id)) return order;
            return { ...order, contactPersonnelId: String(target.id), contactPerson: nextPerson.name };
          });
        }
        const attachmentsBeforeApproval = nextAttachments;
        nextAttachments = finalizeApprovedProfileAttachments(
          nextAttachments,
          storedPersonnelSelfProfile(target),
          normalizedProposal,
          requestId,
          new Date(resolvedAt)
        );
        retiredAttachmentIds = terminalPersonnelAttachmentIds(attachmentsBeforeApproval, nextAttachments);
        resolvedRequest = {
          ...request,
          status: "approved",
          resolvedAt,
          resolvedBy: authenticatedOperator(req),
          resolvedByPersonnelId: approverPersonnelId,
          resolutionNote: note,
          appliedProfileRevision: nextPerson.profileRevision,
        };
      } else {
        nextAttachments = updateProfileAttachmentRequestStatuses(
          nextAttachments,
          decryptPersonnelProfileProposalFields(request.proposedProfile, request.personnelId, personnelDataKeyring),
          requestId,
          "rejected"
        );
        resolvedRequest = {
          ...request,
          status: "rejected",
          resolvedAt,
          resolvedBy: authenticatedOperator(req),
          resolvedByPersonnelId: approverPersonnelId,
          resolutionNote: note,
        };
      }
      const resolvedNotifications = resolvePersonnelProfileApprovalNotifications(
        currentStationNotifications(state),
        requestId,
        {
          resolution: decision === "approve" ? "approved" : "rejected",
          resolvedAt,
          resolvedBy: authenticatedOperator(req),
          resolvedByName: authenticatedOperatorName(req),
          resolutionNote: note,
        }
      );
      const targetLabel = target?.name || request.requesterName || request.personnelId;
      const operationLog = createOperationLog(
        req,
        "人员管理",
        decision === "approve" ? "批准资料修改" : "驳回资料修改",
        `${decision === "approve" ? "批准" : "驳回"}人员「${targetLabel}」的资料修改申请${selfReview ? "（唯一启用管理员自审）" : ""}${note ? "；审批说明已保存在受控申请记录中" : ""}`
      );
      const nextState = {
        ...state,
        personnel: nextPersonnel,
        orders: nextOrders,
        personnelPrivateAttachments: nextAttachments,
        personnelProfileRequests: requests.map((item) => item === request ? resolvedRequest : item),
        notifications: resolvedNotifications.notifications,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      await removePersonnelAttachmentFiles(retiredAttachmentIds);
      sendJson(req, res, 200, {
        ok: true,
        ...stationNotificationPayloadForAuth(nextState, req, 100),
        personnel: sanitizePersonnelForResponse(nextPersonnel, req),
        operationLog,
        message: decision === "approve" ? "人员资料已批准并生效" : "人员资料申请已驳回",
      }, { "Cache-Control": "no-store, private" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, Number(error?.statusCode ?? 400), {
        ok: false,
        error: error.message || "人员资料审批处理失败",
      }, { "Cache-Control": "no-store, private" });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/personnel/sensitive" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireAdminForAuth(req, "仅管理员可以查看证件与工资账户信息");
      const body = JSON.parse(await readBody(req) || "{}");
      const personnelId = String(body.id ?? body.personnelId ?? "").trim();
      if (!personnelId) throw new Error("缺少人员 ID");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const target = personnel.find((person) => String(person?.id ?? "") === personnelId);
      if (!target) throw new Error("人员不存在或已被删除");
      const sensitive = {
        ...decryptPersonnelSensitiveFields(target, personnelDataKeyring),
        idCardFrontAttachment: publicPersonnelAttachmentMetadata(target.idCardFrontAttachment),
        idCardBackAttachment: publicPersonnelAttachmentMetadata(target.idCardBackAttachment),
        educationProofAttachment: publicPersonnelAttachmentMetadata(target.educationProofAttachment),
      };
      const operationLog = createOperationLog(
        req,
        "人员管理",
        "查看敏感档案",
        `查看人员「${target.name || target.personnelNo}」（${target.personnelNo || target.id}）的证件与工资账户信息`
      );
      const nextState = {
        ...state,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query(
        "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        personnelId,
        sensitive,
        sensitiveRevision: personnelSensitiveRevision(target),
        operationLog,
      }, { "Cache-Control": "no-store, private" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, 400, { ok: false, error: error.message || "读取人员敏感档案失败" }, {
        "Cache-Control": "no-store, private",
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/personnel/save" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const incoming = body.personnel && typeof body.personnel === "object" ? body.personnel : body;
      const incomingId = String(incoming?.id ?? "").trim();
      requireAdminForAuth(req, "仅管理员可以维护人员档案和登录账号");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const orders = Array.isArray(state.orders) ? state.orders : [];
      const existing = incomingId
        ? personnel.find((person) => String(person?.id ?? "") === incomingId)
        : null;
      if (incomingId && !existing) throw new Error("人员不存在或已被删除");
      if (existing && String(incoming?.sensitiveRevision ?? "").trim() !== personnelSensitiveRevision(existing)) {
        throw new Error("敏感档案已发生变化或尚未完整加载，请重新打开人员档案后再保存");
      }
      const nextPerson = normalizePersonnelInput(incoming, existing, state);
      const retiredPersonnelUsernames = Array.isArray(state.retiredPersonnelUsernames)
        ? state.retiredPersonnelUsernames.map((value) => String(value ?? "").trim()).filter(Boolean)
        : [];
      if (nextPerson.username && retiredPersonnelUsernames.includes(nextPerson.username) &&
          nextPerson.username !== String(existing?.username ?? "")) {
        throw new Error("该登录账号曾被其他人员使用，为防止接管历史数据不能重复启用");
      }
      const duplicate = nextPerson.username && personnel.find((person) =>
        String(person?.id ?? "") !== nextPerson.id &&
        String(person?.username ?? "").trim() === nextPerson.username
      );
      if (duplicate) throw new Error("登录账号不能重复");
      const duplicatePersonnelNo = personnel.find((person) =>
        String(person?.id ?? "") !== nextPerson.id &&
        String(person?.personnelNo ?? "").trim() === nextPerson.personnelNo
      );
      if (duplicatePersonnelNo) throw new Error("人员编号不能重复");
      if (existing?.username === req.auth.user.username &&
          (nextPerson.accessRole !== "admin" || !nextPerson.accountEnabled)) {
        throw new Error("不能停用当前管理员或把当前管理员改为普通账号");
      }
      if (existing?.accessRole === "admin" && isPersonnelAccountEnabled(existing) &&
          (nextPerson.accessRole !== "admin" || !nextPerson.accountEnabled) &&
          countAdmins(personnel, existing.id) === 0) {
        throw new Error("至少需要保留一个管理员账号");
      }

      const nextPersonnel = existing
        ? personnel.map((person) => String(person?.id ?? "") === nextPerson.id ? nextPerson : person)
        : [...personnel, nextPerson];
      const previousUsername = String(existing?.username ?? "").trim();
      const usernameChanged = Boolean(existing) && previousUsername !== nextPerson.username;
      const migratedNotifications = usernameChanged
        ? currentStationNotifications(state).map((notification) =>
            String(notification?.recipientUsername ?? "") === previousUsername
              ? {
                  ...notification,
                  recipientUsername: nextPerson.username,
                  recipientName: nextPerson.name,
                }
              : notification
          )
        : currentStationNotifications(state);
      const nextInventoryAdjustmentDrafts = usernameChanged
        ? currentInventoryAdjustmentDrafts(state).map((draft) =>
            String(draft?.createdBy ?? "") === previousUsername
              ? { ...draft, createdBy: nextPerson.username, createdByName: nextPerson.name }
              : draft
          )
        : currentInventoryAdjustmentDrafts(state);
      const nextPersonnelProfileRequests = usernameChanged
        ? currentPersonnelProfileRequests(state).map((request) =>
            String(request?.personnelId ?? "") === String(nextPerson.id)
              ? { ...request, requesterUsername: nextPerson.username, requesterName: nextPerson.name }
              : request
          )
        : currentPersonnelProfileRequests(state);
      const nextNotifications = ensurePendingPersonnelProfileApprovalFanout(
        migratedNotifications,
        nextPersonnelProfileRequests,
        nextPersonnel
      );
      const nextRetiredPersonnelUsernames = usernameChanged && previousUsername
        ? [...new Set([...retiredPersonnelUsernames, previousUsername])]
        : retiredPersonnelUsernames;
      const nextOrders = existing
        ? orders.map((order) => {
            const linkedPersonnelId = String(order?.contactPersonnelId ?? "").trim();
            if (linkedPersonnelId === String(existing.id ?? "")) {
              return { ...order, contactPerson: nextPerson.name };
            }
            if (linkedPersonnelId) return order;
            const reference = String(order?.contactPerson ?? "").trim();
            if (!reference) return order;
            const matches = personnel.filter((person) =>
              String(person?.name ?? "").trim() === reference ||
              String(person?.username ?? "").trim() === reference
            );
            if (matches.length !== 1 || String(matches[0]?.id ?? "") !== String(existing.id ?? "")) return order;
            return {
              ...order,
              contactPersonnelId: String(existing.id),
              contactPerson: nextPerson.name,
            };
          })
        : orders;
      const operationLog = createOperationLog(
        req,
        "人员管理",
        existing ? "修改记录" : "添加记录",
        `${existing ? "修改" : "新增"}人员档案「${nextPerson.name}」（${nextPerson.personnelNo}）${nextPerson.username ? `，账号 ${nextPerson.username}` : "，未开通账号"}`
      );
      const nextState = {
        ...state,
        personnel: nextPersonnel,
        orders: nextOrders,
        notifications: nextNotifications,
        inventoryAdjustmentDrafts: nextInventoryAdjustmentDrafts,
        personnelProfileRequests: nextPersonnelProfileRequests,
        retiredPersonnelUsernames: nextRetiredPersonnelUsernames,
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
      const currentUserChanged = Boolean(existing) && previousUsername === String(req.auth?.user?.username ?? "");
      const replacementUser = currentUserChanged ? publicUserFromAccount(nextPerson, nextState) : null;
      const replacementSession = replacementUser ? createAuthToken(replacementUser, nextPerson) : null;
      sendJson(req, res, 200, {
        ok: true,
        personnel: sanitizePersonnelForResponse(nextPersonnel, req),
        orders: nextOrders,
        operationLog,
        ...(replacementSession ? {
          user: replacementUser,
          token: replacementSession.token,
          expiresAt: replacementSession.expiresAt,
        } : {}),
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
      requireAdminForAuth(req, "仅管理员可以删除误录的人员档案");
      const body = JSON.parse(await readBody(req) || "{}");
      const deleteId = String(body.id ?? body.deleteId ?? "").trim();
      if (!deleteId) throw new Error("缺少人员 ID");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const target = personnel.find((person) => String(person?.id ?? "") === deleteId);
      if (!target) throw new Error("人员不存在或已被删除");
      if (target.username === req.auth.user.username) throw new Error("当前登录人员不能删除");
      if (target.accessRole === "admin" && isPersonnelAccountEnabled(target) && countAdmins(personnel, target.id) === 0) {
        throw new Error("至少需要保留一个管理员账号");
      }
      if (personnelHasBusinessHistory(state, target)) {
        throw new Error("该人员已有业务或操作历史，不能彻底删除，请改为办理离职");
      }
      const nextPersonnel = personnel.filter((person) => String(person?.id ?? "") !== deleteId);
      const operationLog = createOperationLog(
        req,
        "人员管理",
        "删除记录",
        `删除人员档案「${target.name || target.username}」（${target.personnelNo || target.username}）`
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
      requireAdminForAuth(req, "仅管理员可以办理人员离职");
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
      if (target.accessRole === "admin" && isPersonnelAccountEnabled(target) && countAdmins(personnel, target.id) === 0) {
        throw new Error("至少需要保留一个在职管理员账号");
      }
      const resignedAt = nowDatetimeInChina();
      const nextPersonnel = personnel.map((person) =>
        String(person?.id ?? "") === targetId
          ? {
              ...person,
              accountEnabled: false,
              sessionVersion: sessionVersionForAccount(person) + 1,
              employmentStatus: "resigned",
              resignedAt,
            }
          : person
      );
      const operationLog = createOperationLog(
        req,
        "人员管理",
        "修改记录",
        `办理人员「${target.name || target.username}」（${target.personnelNo || target.username}）离职，并停用登录账号`
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
      requireAdminForAuth(req, "仅管理员可以配置账号权限");
      const body = JSON.parse(await readBody(req) || "{}");
      const targetId = String(body.id ?? body.personnelId ?? "").trim();
      if (!targetId) throw new Error("缺少人员 ID");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const personnel = Array.isArray(state.personnel) ? state.personnel : [];
      const target = personnel.find((person) => String(person?.id ?? "") === targetId);
      if (!target) throw new Error("人员不存在或已被删除");
      if (!hasPersonnelAccount(target)) throw new Error("该人员尚未开通登录账号");
      if (isPersonnelResigned(target)) throw new Error("离职账号不能修改权限");
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
      if (!hasPersonnelAccount(target)) throw new Error("该人员尚未开通登录账号");
      const adminReset = Boolean(targetId) && req.auth.account?.accessRole === "admin";
      if (isPersonnelResigned(target)) throw new Error("离职账号不能修改登录密码");
      if (!isPersonnelAccountEnabled(target) && !adminReset) throw new Error("停用账号不能自行修改登录密码");
      if (adminReset) {
        requireAdminForAuth(req, "仅管理员可以重置其他账号的密码");
      } else {
        if (target.username !== req.auth.user.username) throw new Error("只能修改自己的密码");
        if (!verifyPassword(target.password, String(body.oldPassword ?? ""))) throw new Error("原密码不正确");
      }
      const nextPersonnel = personnel.map((person) =>
        String(person?.id ?? "") === String(target.id ?? "")
          ? {
              ...person,
              password: hashPassword(newPassword),
              sessionVersion: sessionVersionForAccount(person) + 1,
            }
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
      const updatedTarget = nextPersonnel.find((person) => String(person?.id ?? "") === String(target.id ?? ""));
      const currentUserChanged = updatedTarget?.username === req.auth.user.username;
      const replacementUser = currentUserChanged ? publicUserFromAccount(updatedTarget) : null;
      const replacementSession = replacementUser ? createAuthToken(replacementUser, updatedTarget) : null;
      sendJson(req, res, 200, {
        ok: true,
        personnel: sanitizePersonnelForResponse(nextPersonnel, req),
        operationLog,
        ...(replacementSession ? {
          user: replacementUser,
          token: replacementSession.token,
          expiresAt: replacementSession.expiresAt,
        } : {}),
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
      const requestedSiteId = normalizeSiteScope(body.siteId ?? ALL_SITE_ID);
      const operator = authenticatedOperator(req);
      const notifyFeishu = Boolean(body.notifyFeishu);
      if (!message) {
        sendJson(req, res, 400, { ok: false, error: "请输入要询问 AI 助手的问题" });
        return;
      }

      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const rawState = rows[0]?.data ?? {};
      const account = req.auth?.account ?? {};
      const siteId = resolveAssistantSiteScope({
        requestedSiteId,
        accessRole: account.accessRole,
        visibleSiteIds: visibleSiteIdsForAccount(account, rawState),
      });
      const visibleState = siteVisibilityFilteredState(rawState, account);
      const result = await answerAssistantQuestion({
        message,
        state: visibleState,
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
    let releaseTranscodeSlot = null;
    let releaseVideoUploadSlot = null;
    let videoTempDir = "";
    let videoDerivativeSourcePath = "";
    let mediaKind = "media";
    try {
      const startedAt = Date.now();
      const mime = normalizeUploadMime(req.headers["content-type"], req.headers["x-file-name"]);
      const isImage = isSupportedImageMime(mime);
      const isVideo = SUPPORTED_VIDEO_MIMES.has(mime);
      mediaKind = isVideo ? "video" : (isImage ? "image" : "media");
      if (!isImage && !isVideo) {
        sendJson(req, res, 400, { ok: false, error: "只支持上传图片或视频文件" });
        return;
      }
      const maxBytes = isVideo ? MAX_VIDEO_UPLOAD_BYTES : MAX_IMAGE_UPLOAD_BYTES;
      let receivedBytes = 0;
      let mediaUrl = "";
      let storedMime = mime;
      let storedBytes = 0;
      let processingMode = "original";
      let receiveFinishedAt = startedAt;
      let processFinishedAt = startedAt;

      if (isVideo) {
        releaseVideoUploadSlot = await videoUploadLimiter.acquire();
        videoTempDir = await mkdtemp(join(tmpdir(), "fishroom-video-upload-"));
        const inputPath = join(videoTempDir, `input${extensionForMime(mime)}`);
        receivedBytes = await readRawBodyToFile(req, inputPath, maxBytes);
        receiveFinishedAt = Date.now();
        if (receivedBytes > 0 && TRANSCODE_VIDEO_UPLOADS) {
          releaseTranscodeSlot = await videoTranscodeLimiter.acquire();
          const processed = await prepareWechatVideoFile(inputPath, join(videoTempDir, "wechat.mp4"));
          storedMime = "video/mp4";
          processingMode = processed.mode;
          processFinishedAt = Date.now();
          storedBytes = (await stat(processed.outputPath)).size;
          mediaUrl = await storeOriginalMediaFile(processed.outputPath, storedMime);
          videoDerivativeSourcePath = processed.outputPath;
        } else if (receivedBytes > 0) {
          processFinishedAt = Date.now();
          storedBytes = receivedBytes;
          mediaUrl = await storeOriginalMediaFile(inputPath, storedMime);
          videoDerivativeSourcePath = inputPath;
        }
      } else {
        const buffer = await readRawBody(req, maxBytes);
        receivedBytes = buffer.length;
        receiveFinishedAt = Date.now();
        if (receivedBytes > 0) validateImageUploadBuffer(buffer, mime);
        mediaUrl = receivedBytes > 0 ? await uploadOriginalMedia(buffer, mime) : "";
        storedBytes = receivedBytes;
        processFinishedAt = receiveFinishedAt;
      }

      if (receivedBytes === 0) {
        sendJson(req, res, 400, { ok: false, error: "上传文件为空" });
        return;
      }
      const finishedAt = Date.now();
      const uploadTimingHeader = [
          `receive;dur=${Math.max(0, receiveFinishedAt - startedAt)}`,
          `process;dur=${Math.max(0, processFinishedAt - receiveFinishedAt)}`,
          `store;dur=${Math.max(0, finishedAt - processFinishedAt)}`,
          `total;dur=${Math.max(0, finishedAt - startedAt)}`,
        ].join(", ");
      const posterUrl = isVideo && mediaUrl
        ? publicVideoDerivativeUrl(mediaUrl, VIDEO_DERIVATIVE_KINDS.poster)
        : "";
      const previewUrl = isVideo && mediaUrl
        ? publicVideoDerivativeUrl(mediaUrl, VIDEO_DERIVATIVE_KINDS.preview)
        : "";
      sendJson(req, res, 200, {
        ok: true,
        url: mediaUrl,
        mime: storedMime,
        size: receivedBytes,
        storedSize: storedBytes,
        processingMode,
        storage: cosReady() ? "cos" : "local",
        ...(isVideo ? {
          derivativeStatus: posterUrl && previewUrl ? "processing" : "unavailable",
          posterUrl,
          previewUrl,
        } : {}),
      }, { "Server-Timing": uploadTimingHeader });
      if (isVideo && mediaUrl && videoDerivativeSourcePath) {
        // The original upload is already complete. Transfer temporary-file
        // cleanup to a detached, bounded preview task so response latency does
        // not include poster/preview encoding.
        const cleanupDir = videoTempDir;
        videoTempDir = "";
        scheduleVideoDerivativeGeneration(mediaUrl, videoDerivativeSourcePath, cleanupDir);
      }
    } catch (error) {
      const status = [400, 413, 503].includes(error?.statusCode) ? error.statusCode : 500;
      console.error(`Media upload failed (${mediaKind}):`, error);
      sendJson(req, res, status, {
        ok: false,
        error: status === 413
          ? `上传文件过大，当前限制为图片 ${Math.round(MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024)}MB、视频 ${Math.round(MAX_VIDEO_UPLOAD_BYTES / 1024 / 1024)}MB`
          : (status === 500
              ? (mediaKind === "video" ? "视频上传失败，请稍后重试" : "媒体上传失败，请稍后重试")
              : (error.message || "媒体上传失败")),
      });
    } finally {
      releaseTranscodeSlot?.();
      releaseVideoUploadSlot?.();
      if (videoTempDir) await rm(videoTempDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return;
  }

  if (url.pathname === "/api/media/cos" && req.method === "GET") {
    const key = cosKeyFromUrl(url.searchParams.get("url") ?? "");
    if (!key) {
      sendJson(req, res, 400, { error: "Invalid COS media URL" });
      return;
    }
    void sendCosObject(req, res, key, "private, max-age=3600", {
      wechatVideo: url.searchParams.get("wechatVideo") === "1",
    });
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

  if (url.pathname === "/api/bio-records/media-download-url" && req.method === "GET") {
    try {
      const stockItemId = String(url.searchParams.get("stockItemId") ?? "").trim();
      const recordId = String(url.searchParams.get("recordId") ?? "").trim();
      const mediaUrl = String(url.searchParams.get("url") ?? "").trim();
      const mediaType = url.searchParams.get("mediaType") === "image" ? "image" : "video";
      if (!stockItemId || !recordId || !mediaUrl) {
        throw httpError(400, "下载参数不完整");
      }
      await requireBioRecordMediaDownloadAccess(req, {
        stockItemId,
        recordId,
        mediaUrl,
        mediaType,
      });

      const requestedName = sanitizeAttachmentFilename(
        url.searchParams.get("filename") || (mediaType === "image" ? "fishroom-photo.jpg" : "fishroom-video.mp4")
      );
      const cosKey = cosKeyFromUrl(mediaUrl);
      let downloadUrl = "";
      let expiresIn = 0;
      if (cosKey) {
        downloadUrl = await signedCosObjectUrl(cosKey, {
          expires: 5 * 60,
          query: {
            "response-content-disposition": mediaAttachmentDisposition(
              requestedName,
              mediaType === "image" ? ".jpg" : ".mp4"
            ),
          },
        });
        expiresIn = 5 * 60;
      } else {
        const localPath = localUploadPathFromUrl(mediaUrl);
        if (!localPath) throw httpError(404, "媒体不存在或无权下载");
        const localInfo = await stat(localPath).catch(() => null);
        if (!localInfo?.isFile()) throw httpError(404, "媒体不存在或无权下载");
        const params = new URLSearchParams({ download: "1", filename: requestedName });
        downloadUrl = `${mediaUrl.split("?", 1)[0]}?${params.toString()}`;
      }
      if (!downloadUrl) throw httpError(503, "下载地址生成失败，请稍后重试");
      sendJson(req, res, 200, { ok: true, url: downloadUrl, expiresIn }, {
        "Cache-Control": "no-store, private",
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode ?? 400), {
        ok: false,
        error: error.message || "下载地址生成失败",
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return;
  }

  if (url.pathname === "/api/login-data" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data -> 'personnel' AS personnel FROM app_state WHERE id = $1", [stateId]);
    sendJson(req, res, 200, { personnel: sanitizePersonnelForLoginData(rows[0]?.personnel ?? [], req) });
    return;
  }

  if (url.pathname === "/api/batches/revenue-metrics" && req.method === "GET") {
    const requestedSiteId = String(url.searchParams.get("siteId") ?? "").trim();
    if (!requestedSiteId || requestedSiteId === ALL_SITE_ID) {
      sendJson(req, res, 400, {
        ok: false,
        error: "查看采购批次回款前请选择具体场地",
      }, { "Cache-Control": "no-store, private" });
      return;
    }
    try {
      const { rows } = await pool.query(
        `SELECT revision::text AS version,
                data -> 'sites' AS sites,
                data -> 'tankGroups' AS tank_groups,
                data -> 'batches' AS batches,
                data -> 'stock' AS stock,
                data -> 'orders' AS orders,
                data -> 'shipments' AS shipments
         FROM app_state
         WHERE id = $1`,
        [stateId]
      );
      const row = rows[0] ?? {};
      const state = normalizePickupShipmentsForState({
        sites: Array.isArray(row.sites) ? row.sites : [],
        tankGroups: Array.isArray(row.tank_groups) ? row.tank_groups : [],
        batches: Array.isArray(row.batches) ? row.batches : [],
        stock: Array.isArray(row.stock) ? row.stock : [],
        orders: Array.isArray(row.orders) ? row.orders : [],
        shipments: Array.isArray(row.shipments) ? row.shipments : [],
      });
      const siteId = requireVisibleSiteForAuth(
        req,
        state,
        requestedSiteId,
        "不能查看未授权场地的采购批次"
      );
      const scopedState = siteFilteredState(state, siteId);
      const settlementResult = await pool.query(
        `SELECT external_order_no,
                COUNT(*)::int AS row_count,
                COALESCE(SUM(
                  CASE
                    WHEN jsonb_typeof(data -> 'incomeTotal') = 'number'
                    THEN (data ->> 'incomeTotal')::numeric
                    ELSE 0
                  END
                ), 0)::text AS income_total
         FROM finance_platform_settlements
         WHERE state_id = $1 AND site_id = $2 AND platform = 'douyin'
         GROUP BY external_order_no`,
        [stateId, siteId]
      );
      const result = buildBatchRevenueMetrics({
        batches: scopedState.batches,
        stock: scopedState.stock,
        orders: scopedState.orders,
        shipments: scopedState.shipments,
        platformSettlements: settlementResult.rows,
      });
      sendJson(req, res, 200, {
        ok: true,
        siteId,
        version: row.version ?? null,
        ...result,
      }, { "Cache-Control": "no-store, private" });
    } catch (error) {
      const statusCode = Number(error?.statusCode ?? 500);
      if (statusCode >= 500) console.error("Failed to load batch revenue metrics:", error);
      sendJson(req, res, statusCode, {
        ok: false,
        error: statusCode >= 500 ? "采购批次回款加载失败" : error?.message || "采购批次回款加载失败",
      }, { "Cache-Control": "no-store, private" });
    }
    return;
  }

  if (url.pathname === "/api/dashboard-summary" && req.method === "GET") {
    const { rows } = await pool.query(
      `SELECT
         data -> 'sites' AS sites,
         data -> 'species' AS species,
         data -> 'products' AS products,
         data -> 'tankGroups' AS tank_groups,
         data -> 'batches' AS batches,
         data -> 'stock' AS stock,
         data -> 'lossRecords' AS loss_records,
         data -> 'orders' AS orders,
         data -> 'shipments' AS shipments,
         data -> 'customers' AS customers,
         data -> 'personnel' AS personnel
       FROM app_state
       WHERE id = $1`,
      [stateId]
    );
    const row = rows[0] ?? {};
    const data = siteVisibilityFilteredState({
      sites: Array.isArray(row.sites) ? row.sites : [],
      species: Array.isArray(row.species) ? row.species : [],
      products: Array.isArray(row.products) ? row.products : [],
      tankGroups: Array.isArray(row.tank_groups) ? row.tank_groups : [],
      batches: Array.isArray(row.batches) ? row.batches : [],
      stock: Array.isArray(row.stock) ? row.stock : [],
      lossRecords: Array.isArray(row.loss_records) ? row.loss_records : [],
      orders: Array.isArray(row.orders) ? row.orders : [],
      shipments: Array.isArray(row.shipments) ? row.shipments : [],
      customers: Array.isArray(row.customers) ? row.customers : [],
      personnel: Array.isArray(row.personnel) ? row.personnel : [],
    }, req.auth?.account);
    sendJson(req, res, 200, {
      summary: buildDashboardSummary(data, {
        financeDays: url.searchParams.get("financeDays") ?? url.searchParams.get("days"),
        siteId: url.searchParams.get("siteId") ?? ALL_SITE_ID,
      }),
    });
    return;
  }

  if (url.pathname === "/api/dashboard-focus" && req.method === "GET") {
    const mode = url.searchParams.get("mode") === "product" ? "product" : "species";
    const focusId = String(url.searchParams.get("id") ?? "").trim();
    if (!focusId) {
      sendJson(req, res, 400, { error: "Missing dashboard focus id" });
      return;
    }
    const { rows } = await pool.query(
      `SELECT
         data -> 'sites' AS sites,
         data -> 'species' AS species,
         data -> 'products' AS products,
         data -> 'tankGroups' AS tank_groups,
         data -> 'stock' AS stock,
         data -> 'orders' AS orders,
         data -> 'shipments' AS shipments
       FROM app_state
       WHERE id = $1`,
      [stateId]
    );
    const row = rows[0] ?? {};
    const visibleState = siteVisibilityFilteredState({
      sites: Array.isArray(row.sites) ? row.sites : [],
      species: Array.isArray(row.species) ? row.species : [],
      products: Array.isArray(row.products) ? row.products : [],
      tankGroups: Array.isArray(row.tank_groups) ? row.tank_groups : [],
      stock: Array.isArray(row.stock) ? row.stock : [],
      orders: Array.isArray(row.orders) ? row.orders : [],
      shipments: Array.isArray(row.shipments) ? row.shipments : [],
    }, req.auth?.account);
    const scopedState = siteFilteredState(
      visibleState,
      url.searchParams.get("siteId") ?? ALL_SITE_ID
    );
    const focus = buildDashboardFocusDetail({
      mode,
      id: focusId,
      today: todayInChina(),
      species: scopedState.species,
      products: scopedState.products,
      stock: scopedState.stock,
      orders: scopedState.orders,
      outStockIds: shippedOutStockIds(scopedState),
    });
    if (!focus) {
      sendJson(req, res, 404, { error: "Dashboard focus item not found" });
      return;
    }
    sendJson(req, res, 200, { focus });
    return;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
    sendJson(req, res, 200, { data: sanitizeStateForResponse(rows[0]?.data ?? null, req) });
    return;
  }

  if (url.pathname === "/api/state/version" && req.method === "GET") {
    const { rows } = await pool.query("SELECT revision::text AS version FROM app_state WHERE id = $1", [stateId]);
    sendJson(req, res, 200, {
      version: rows[0]?.version ?? null,
    }, { "Cache-Control": "no-store, private" });
    return;
  }

  if (url.pathname === "/api/state/slice" && req.method === "GET") {
    try {
      const keys = parseStateKeys(url.searchParams.get("keys") ?? "");
      if (keys.length === 0) {
        sendJson(req, res, 400, { error: "Missing state slice keys" });
        return;
      }
      const plan = planStateSliceDependencies(keys);
      const columns = plan.queryKeys
        .map((key) => `data -> '${key}' AS "${key}"`)
        .join(",\n           ");
      const { rows } = await pool.query(
        `SELECT revision::text AS version,\n           ${columns}\n         FROM app_state\n         WHERE id = $1`,
        [stateId]
      );
      const lite = new Set(String(url.searchParams.get("lite") ?? "").split(",").map((item) => item.trim()).filter(Boolean));
      const row = rows[0] ?? {};
      const projectedState = Object.fromEntries(plan.queryKeys.map((key) => [key, row[key] ?? null]));
      const data = sanitizeStateForResponse(projectedState, req);
      const picked = pickState(data, plan.requestedKeys, { liteSpecies: lite.has("species") });
      if (keys.includes("stock")) picked.inventoryProjection = data.inventoryProjection;
      sendJson(req, res, 200, {
        data: picked,
        version: row.version ?? null,
      });
    } catch (error) {
      sendJson(req, res, 400, { error: error.message });
    }
    return;
  }

  if (url.pathname === "/api/bio-records" && req.method === "GET") {
    try {
      const stockItemId = String(url.searchParams.get("stockItemId") ?? "").trim();
      if (!stockItemId) throw new Error("缺少库存鱼编号");
      const { rows } = await pool.query(
        `WITH source AS MATERIALIZED (
           SELECT data
           FROM app_state
           WHERE id = $1
         ),
         target_stock AS MATERIALIZED (
           SELECT stock_item
           FROM source,
             LATERAL jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb)) AS stock_rows(stock_item)
           WHERE stock_item ->> 'id' = $2
         )
         SELECT
           data -> 'sites' AS sites,
           data -> 'tankGroups' AS tank_groups,
           (SELECT count(*)::int FROM target_stock) AS stock_item_count,
           (SELECT stock_item FROM target_stock LIMIT 1) AS stock_item,
           COALESCE((
             SELECT jsonb_agg(record_item)
             FROM jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb)) AS bio_rows(record_item)
             WHERE record_item ->> 'stockItemId' = $2
           ), '[]'::jsonb) AS bio_records
         FROM source`,
        [stateId, stockItemId]
      );
      const stockItemCount = Number(rows[0]?.stock_item_count ?? 0);
      if (stockItemCount > 1) {
        throw new BioRecordConflictError("库存鱼 ID 不唯一，无法安全查看", {
          code: "BIO_STOCK_ID_CONFLICT",
        });
      }
      const stockItem = rows[0]?.stock_item && typeof rows[0].stock_item === "object"
        ? rows[0].stock_item
        : null;
      const state = {
        sites: Array.isArray(rows[0]?.sites) ? rows[0].sites : [],
        tankGroups: Array.isArray(rows[0]?.tank_groups) ? rows[0].tank_groups : [],
        bioRecords: Array.isArray(rows[0]?.bio_records) ? rows[0].bio_records : [],
        stock: stockItem ? [stockItem] : [],
      };
      const visibleSiteIds = visibleSiteIdsForAccount(req.auth?.account, state);
      const stockSiteId = stockItem ? normalizeSiteId(
        findSubTank(state, stockItem.subTankId)?.group?.siteId ?? stockItem.siteId
      ) : "";
      const canAccessStock = stockItem && canAccessBioStockSite({
        account: req.auth?.account,
        visibleSiteIds,
        stockSiteId,
      });
      if (!stockItem || !canAccessStock) {
        sendJson(req, res, 404, { ok: false, error: "生物不存在或无权查看" });
        return;
      }
      assertUniqueBioRecordIds(state.bioRecords);
      sendJson(req, res, 200, {
        ok: true,
        bioRecords: state.bioRecords,
        stockItem,
      });
    } catch (error) {
      sendJson(req, res, Number(error?.statusCode ?? 400), {
        ok: false,
        error: error.message || "养殖记录加载失败",
        ...(error?.code ? { code: error.code } : {}),
      });
    }
    return;
  }

  if (url.pathname === "/api/bio-records/save" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const rawBody = JSON.parse(await readBody(req, 2 * 1024 * 1024) || "{}");
      const action = String(rawBody?.action ?? "").trim();
      for (const requiredAction of bioRecordRequiredActions(action, { includesRecord: Boolean(rawBody?.record) })) {
        requireModulePermissionForAuth(req, "daily", requiredAction);
      }

      const body = {
        ...rawBody,
        ...(rawBody?.record ? { record: await externalizeDataUrls(rawBody.record) } : {}),
      };
      const stockItemId = String(body?.stockItemId ?? "").trim();
      if (!stockItemId) throw new Error("缺少库存鱼编号");
      const targetRecordId = String(
        action === "create" || (action === "saveDetails" && body?.record)
          ? body?.record?.id
          : body?.recordId
      ).trim();

      await client.query("BEGIN");
      await client.query("SELECT 1 FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const { rows } = await client.query(
        `SELECT
           data -> 'sites' AS sites,
           data -> 'tankGroups' AS tank_groups,
           stock_target.stock_item_count,
           stock_target.stock_item,
           record_target.bio_records,
           ($4::boolean AND (
             EXISTS (
               SELECT 1
               FROM jsonb_array_elements(COALESCE(data -> 'shipments', '[]'::jsonb)) AS shipment_rows(shipment_item)
               WHERE COALESCE(shipment_item ->> 'status', '') <> 'preparing'
                 AND EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements_text(COALESCE(shipment_item -> 'itemStockIds', '[]'::jsonb)) AS shipment_stock(stock_id)
                   WHERE btrim(shipment_stock.stock_id) = $2
                 )
             )
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(COALESCE(data -> 'orders', '[]'::jsonb)) AS order_rows(order_item)
               WHERE order_item ->> 'status' = 'completed'
                 AND EXISTS (
                   SELECT 1
                   FROM jsonb_array_elements(COALESCE(order_item -> 'items', '[]'::jsonb)) AS order_stock(order_stock_item)
                   WHERE btrim(COALESCE(order_stock_item ->> 'stockItemId', '')) = $2
                     AND btrim(COALESCE(order_stock_item ->> 'inventoryRemovedAt', '')) = ''
                 )
             )
           )) AS stock_is_out
         FROM app_state
         CROSS JOIN LATERAL (
           SELECT
             count(*)::int AS stock_item_count,
             (jsonb_agg(stock_row.stock_item ORDER BY stock_row.ordinality) -> 0) AS stock_item
           FROM jsonb_array_elements(COALESCE(app_state.data -> 'stock', '[]'::jsonb))
             WITH ORDINALITY AS stock_row(stock_item, ordinality)
           WHERE btrim(COALESCE(stock_row.stock_item ->> 'id', '')) = $2
         ) AS stock_target
         CROSS JOIN LATERAL (
           SELECT COALESCE(jsonb_agg(record_row.record_item ORDER BY record_row.ordinality), '[]'::jsonb) AS bio_records
           FROM jsonb_array_elements(COALESCE(app_state.data -> 'bioRecords', '[]'::jsonb))
             WITH ORDINALITY AS record_row(record_item, ordinality)
           WHERE $3 <> '' AND btrim(COALESCE(record_row.record_item ->> 'id', '')) = $3
         ) AS record_target
         WHERE id = $1`,
        [stateId, stockItemId, targetRecordId, ["create", "saveDetails"].includes(action)]
      );
      const stockItemCount = Number(rows[0]?.stock_item_count ?? 0);
      if (stockItemCount > 1) {
        throw new BioRecordConflictError("库存鱼 ID 不唯一，无法安全处理", {
          code: "BIO_STOCK_ID_CONFLICT",
        });
      }
      const projectedStockItem = rows[0]?.stock_item && typeof rows[0].stock_item === "object"
        ? rows[0].stock_item
        : null;
      const state = {
        sites: Array.isArray(rows[0]?.sites) ? rows[0].sites : [],
        tankGroups: Array.isArray(rows[0]?.tank_groups) ? rows[0].tank_groups : [],
        stock: projectedStockItem ? [projectedStockItem] : [],
        bioRecords: Array.isArray(rows[0]?.bio_records) ? rows[0].bio_records : [],
      };
      const storedStockItem = findUniqueBioStockItem(state.stock, stockItemId);
      const visibleSiteIds = visibleSiteIdsForAccount(req.auth?.account, state);
      const storedStockSiteId = storedStockItem ? normalizeSiteId(
        findSubTank(state, storedStockItem.subTankId)?.group?.siteId ?? storedStockItem.siteId
      ) : "";
      const canAccessStock = storedStockItem && canAccessBioStockSite({
        account: req.auth?.account,
        visibleSiteIds,
        stockSiteId: storedStockSiteId,
      });
      if (!storedStockItem || !canAccessStock) {
        const error = new Error("生物不存在或无权操作");
        error.statusCode = 404;
        throw error;
      }
      const authoritativeSiteId = normalizeSiteId(
        findSubTank(state, storedStockItem.subTankId)?.group?.siteId ?? storedStockItem.siteId
      );
      const stockItem = { ...storedStockItem, siteId: authoritativeSiteId };
      const plan = planBioRecordSave({
        action,
        stockItem,
        records: state.bioRecords,
        record: body?.record,
        recordId: body?.recordId,
        expectedRecord: body?.expectedRecord,
        details: body?.details,
        expectedDetails: body?.expectedDetails,
        operator: authenticatedOperator(req),
        now: nowDatetimeInChina(),
      });

      if (["create", "saveDetails"].includes(action) && !plan.idempotent &&
          (storedStockItem.lost || Boolean(rows[0]?.stock_is_out))) {
        throw new Error("已损耗或已发货的鱼不能新增记录或修改信息");
      }

      if (plan.idempotent) {
        await client.query("COMMIT");
        sendJson(req, res, 200, {
          ok: true,
          idempotent: true,
          ...(action === "saveDetails" ? { stockItem: plan.stockItem } : {}),
          ...(plan.record ? { bioRecord: plan.record } : {}),
        });
        return;
      }

      const operationParts = [];
      if (plan.changedKeys.includes("stock")) operationParts.push("修改鱼的信息");
      if (action === "create" || (action === "saveDetails" && plan.record)) operationParts.push("新增观察/治疗记录");
      if (action === "updateTime") operationParts.push("修改观察/治疗记录时间");
      if (action === "delete") operationParts.push("删除观察/治疗记录");
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator: authenticatedOperator(req),
        module: "日常管理",
        action: action === "delete" ? "删除记录" : action === "create" ? "添加记录" : "修改记录",
        detail: `${operationParts.join("并")}（库存鱼 ${stockItemId}${plan.record?.date ? `，${plan.record.date}` : ""}）`,
      };
      let dataExpression = "data";
      const updateValues = [stateId];
      const bindValue = (value) => {
        updateValues.push(value);
        return `$${updateValues.length}`;
      };
      if (plan.changedKeys.includes("stock")) {
        const stockIdParam = bindValue(stockItemId);
        const stockItemParam = bindValue(JSON.stringify(plan.stockItem));
        dataExpression = `jsonb_set(
          ${dataExpression},
          '{stock}',
          (
            SELECT COALESCE(jsonb_agg(
              CASE WHEN btrim(COALESCE(stock_row.stock_item ->> 'id', '')) = ${stockIdParam} THEN ${stockItemParam}::jsonb ELSE stock_row.stock_item END
              ORDER BY stock_row.ordinality
            ), '[]'::jsonb)
            FROM jsonb_array_elements(COALESCE(data -> 'stock', '[]'::jsonb))
              WITH ORDINALITY AS stock_row(stock_item, ordinality)
          ),
          true
        )`;
      }
      if (plan.changedKeys.includes("bioRecords")) {
        dataExpression = appendBioRecordsMutationSql({
          dataExpression,
          action,
          targetRecordId,
          record: plan.record,
          bindValue,
        });
      }
      const operationLogParam = bindValue(JSON.stringify(operationLog));
      const maxExistingOperationLogsParam = bindValue(Math.max(0, MAX_OPERATION_LOGS - 1));
      dataExpression = `jsonb_set(
        ${dataExpression},
        '{operationLogs}',
        (
          SELECT COALESCE(jsonb_agg(entries.entry ORDER BY entries.position), '[]'::jsonb)
          FROM (
            SELECT ${operationLogParam}::jsonb AS entry, 0::bigint AS position
            UNION ALL
            SELECT operation_row.operation_item, operation_row.ordinality
            FROM jsonb_array_elements(COALESCE(data -> 'operationLogs', '[]'::jsonb))
              WITH ORDINALITY AS operation_row(operation_item, ordinality)
            WHERE operation_row.ordinality <= ${maxExistingOperationLogsParam}
          ) AS entries
        ),
        true
      )`;
      await client.query(
        `UPDATE app_state
         SET data = ${dataExpression}, updated_at = now()
         WHERE id = $1`,
        updateValues
      );
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        ...(plan.changedKeys.includes("stock") ? { stockItem: plan.stockItem } : {}),
        ...(plan.record ? { bioRecord: plan.record } : {}),
        ...(plan.deletedRecordId ? { deletedRecordId: plan.deletedRecordId } : {}),
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      const databaseError = /^[0-9A-Z]{5}$/.test(String(error?.code ?? ""));
      if (databaseError) console.error("Failed to save bio record:", error);
      const status = Number(error?.statusCode ?? (error instanceof BioRecordConflictError ? 409 : databaseError ? 500 : 400));
      sendJson(req, res, status, {
        ok: false,
        error: databaseError ? "记录保存失败，请稍后重试" : (error.message || "生物记录保存失败"),
        ...(!databaseError && error?.code ? { code: error.code } : {}),
      });
    } finally {
      client.release();
    }
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

  if (url.pathname === "/api/orders/credit-sale/request" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const orderId = String(body.orderId ?? "").trim();
      const requestedUsernames = [...new Set((Array.isArray(body.recipientUsernames) ? body.recipientUsernames : [])
        .map((username) => String(username ?? "").trim())
        .filter(Boolean))];
      const requestedOutstandingAmount = Number(body.outstandingAmount ?? 0);
      if (!orderId) throw new Error("缺少订单信息，请刷新后重试");
      if (!Number.isFinite(requestedOutstandingAmount) || requestedOutstandingAmount <= 0) {
        throw new Error("赊销审批金额无效，请重新发起发货检查");
      }
      requireOrderPermissionForAuth(req, "update");

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      const { order: currentOrder, orders } = resolveAuthorizedLockedOrderTarget(req, state, orderId);
      if (["completed", "cancelled"].includes(String(currentOrder.status ?? ""))) {
        throw new Error("该订单当前状态不能申请赊销审批");
      }

      const currentGate = shipmentPaymentGateForOrder(currentOrder, state.shipments);
      const requiredOutstandingAmount = Number(Math.max(
        Number(currentGate.outstandingAmount ?? 0),
        requestedOutstandingAmount
      ).toFixed(2));
      const existingApprovedAmount = currentOrder.creditSaleApproval?.confirmedAt && currentOrder.creditSaleApproval?.confirmedBy
        ? Math.max(0, Number(currentOrder.creditSaleApproval.amount ?? 0))
        : 0;
      if (
        ["platform_exempt", "offline_credit"].includes(currentGate.status) ||
        existingApprovedAmount + 0.005 >= requiredOutstandingAmount
      ) {
        await client.query("COMMIT");
        const visibleState = siteVisibilityFilteredState(state, req.auth?.account);
        sendJson(req, res, 200, { ok: true, alreadyAllowed: true, order: currentOrder, orders: visibleState.orders });
        return;
      }
      const approvalGate = {
        ...currentGate,
        status: "confirmation_required",
        canShip: false,
        outstandingAmount: requiredOutstandingAmount,
      };

      const operator = authenticatedOperator(req);
      if (isCreditSaleOrderOwner(state.personnel, currentOrder, operator)) {
        const approved = approveCreditSaleInState(req, state, currentOrder, approvalGate, { autoApproved: true });
        await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
          stateId,
          JSON.stringify(approved.nextState),
        ]);
        await client.query("COMMIT");
        const visibleNextState = siteVisibilityFilteredState(approved.nextState, req.auth?.account);
        sendJson(req, res, 200, {
          ok: true,
          autoApproved: true,
          creditSaleRequestId: approved.creditSaleRequestId,
          outstandingAmount: requiredOutstandingAmount,
          order: approved.nextOrder,
          orders: visibleNextState.orders,
          operationLog: approved.operationLog,
          message: "你是订单负责人，本次赊销申请已自动通过，可以继续发货",
        });
        return;
      }

      if (requestedUsernames.length === 0) throw new Error("请至少选择一位管理员或订单负责人");
      const eligibleApprovers = creditSaleEligibleApprovers(state.personnel, currentOrder);
      const eligibleByUsername = new Map(eligibleApprovers.map((recipient) => [recipient.username, recipient]));
      const invalidUsernames = requestedUsernames.filter((username) => !eligibleByUsername.has(username));
      if (invalidUsernames.length > 0) {
        throw new Error("所选审批人已离职、账号无效，或不再是管理员/订单负责人，请刷新后重选");
      }
      const recipients = requestedUsernames.map((username) => eligibleByUsername.get(username));
      const ensured = ensureOrderCreditSaleNotifications(state, currentOrder, approvalGate, operator, recipients);
      const recipientNames = recipients.map((recipient) => recipient.name || recipient.username);
      const operationLog = ensured.changed
        ? createOperationLog(
            req,
            "订单管理",
            "申请赊销",
            `订单「${currentOrder.orderNo}」申请赊销 ¥${requiredOutstandingAmount.toFixed(2)}，审批人：${recipientNames.join("、")}`
          )
        : null;
      if (ensured.changed) {
        const nextState = {
          ...state,
          notifications: ensured.notifications,
          operationLogs: pushOperationLog(state.operationLogs, operationLog),
        };
        await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
          stateId,
          JSON.stringify(nextState),
        ]);
      }
      await client.query("COMMIT");
      sendJson(req, res, 200, {
        ok: true,
        changed: ensured.changed,
        creditSaleRequestId: ensured.creditSaleRequestId,
        recipients,
        outstandingAmount: requiredOutstandingAmount,
        operationLog,
        message: ensured.changed
          ? `已向 ${recipientNames.join("、")} 发送赊销审批`
          : `赊销审批已发送给 ${recipientNames.join("、")}，无需重复提交`,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "发起赊销审批失败",
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/credit-sale/confirm" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const orderId = String(body.orderId ?? "").trim();
      const note = String(body.note ?? "").trim().slice(0, 500);
      if (!orderId) throw new Error("缺少订单信息，请刷新后重试");

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      const { order: currentOrder, orders } = resolveAuthorizedLockedOrderTarget(req, state, orderId);
      if (["completed", "cancelled"].includes(String(currentOrder.status ?? ""))) {
        throw new Error("该订单当前状态不能确认赊销");
      }

      const operator = authenticatedOperator(req);
      if (!canApproveCreditSale(state.personnel, currentOrder, operator)) {
        throw new Error("只有管理员或该订单的负责人可以审批赊销");
      }

      const gate = shipmentPaymentGateForOrder(currentOrder, state.shipments);
      const notifications = currentStationNotifications(state);
      if (gate.status === "platform_exempt" || gate.status === "offline_credit") {
        const resolvedNotifications = resolveShipmentGateNotifications(
          notifications,
          orderId,
          gate,
          operator
        );
        const nextState = resolvedNotifications !== notifications
          ? { ...state, notifications: resolvedNotifications }
          : state;
        if (resolvedNotifications !== notifications) {
          await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
            stateId,
            JSON.stringify(nextState),
          ]);
        }
        await client.query("COMMIT");
        const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
        sendJson(req, res, 200, {
          ok: true,
          alreadyAllowed: true,
          allowance: gate.status,
          order: currentOrder,
          orders: visibleNextState.orders,
          ...stationNotificationPayloadForAuth(nextState, req, 500),
        });
        return;
      }

      const pendingNotification = notifications
        .filter((notification) =>
          notification?.type === "credit_sale_confirmation" &&
          notification?.status === "pending" &&
          String(notification?.orderId ?? "") === orderId &&
          String(notification?.recipientUsername ?? "") === operator
        )
        .sort((left, right) => Number(right?.requiredOutstandingAmount ?? 0) - Number(left?.requiredOutstandingAmount ?? 0))[0];

      if (gate.status === "verified") {
        const resolved = resolveCreditSaleNotifications(
          notifications,
          orderId,
          "finance_verified",
          operator,
          new Date().toISOString()
        );
        const nextState = resolved.changed ? { ...state, notifications: resolved.notifications } : state;
        if (resolved.changed) {
          await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
            stateId,
            JSON.stringify(nextState),
          ]);
        }
        await client.query("COMMIT");
        const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
        sendJson(req, res, 200, {
          ok: true,
          alreadyVerified: true,
          order: currentOrder,
          orders: visibleNextState.orders,
          ...stationNotificationPayloadForAuth(nextState, req, 500),
        });
        return;
      }
      if (!pendingNotification) throw new Error("你不在本次赊销审批人名单中，或该申请已被其他审批人处理");

      const approved = approveCreditSaleInState(req, state, currentOrder, gate, { pendingNotification, note });
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(approved.nextState),
      ]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(approved.nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        order: approved.nextOrder,
        orders: visibleNextState.orders,
        ...stationNotificationPayloadForAuth(approved.nextState, req, 500),
        operationLog: approved.operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "确认赊销失败",
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/create" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = normalizeLegacyDouyinOrderRequest(
        await externalizeDataUrls(JSON.parse(await readBody(req)))
      );
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermissionForAuth(req, "create");
      const orderInput = normalizeOrderMutationInput(state, body);
      requireVisibleSiteForAuth(req, state, orderInput.siteId, "不能在未授权场地创建订单");
      const orderId = resolveCreateRecordId({
        records: state.orders,
        requestedId: body.id,
        createId: () => uid("order"),
        label: "订单",
        conflictCode: "ORDER_ID_CONFLICT",
      });
      const order = {
        id: orderId,
        orderNo: nextOrderNo(state),
        createdAt: nowDatetimeInChina(),
        ...orderInput,
        status: "pending",
        payments: [],
      };
      const nextOrders = [...(Array.isArray(state.orders) ? state.orders : []), order];
      const nextStock = setStockSoldForOrders(state, nextOrders);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "添加记录",
        detail: `创建订单「${order.orderNo}」${platformOrderNoForOrder(order) ? `，${platformOrderNoLabel(order.source)} ${platformOrderNoForOrder(order)}` : ""}，商品 ${order.items.length} 条`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        stock: nextStock,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        order,
        orders: visibleNextState.orders,
        stock: visibleNextState.stock,
        inventoryProjection: visibleNextState.inventoryProjection,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.warn(`[orders/create] ${error.message}`);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message,
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/update" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = normalizeLegacyDouyinOrderRequest(
        await externalizeDataUrls(JSON.parse(await readBody(req)))
      );
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermissionForAuth(req, "update");
      const orders = Array.isArray(state.orders) ? state.orders : [];
      const orderId = String(body.orderId ?? body.id ?? "");
      const orderMatches = orders.filter((order) => String(order?.id ?? "") === orderId);
      if (orderMatches.length > 1) {
        const error = new Error("订单 ID 不唯一，请先修复数据后再操作");
        error.statusCode = 409;
        error.code = "ORDER_ID_NOT_UNIQUE";
        throw error;
      }
      const currentOrder = orderMatches[0];
      if (!currentOrder) throw new Error("订单不存在，请刷新后重试");
      if (currentOrder.status === "completed") throw new Error("已完成订单不能再编辑");
      requireVisibleSiteForAuth(req, state, currentOrder.siteId, "不能修改未授权场地的订单");

      const nextOrderInput = normalizeOrderMutationInput(state, body, currentOrder);
      const nextItemIds = new Set(nextOrderInput.items.map((item) => item.stockItemId));
      const removedItemIds = (Array.isArray(currentOrder.items) ? currentOrder.items : [])
        .map((item) => String(item?.stockItemId ?? ""))
        .filter((id) => id && !nextItemIds.has(id));
      const blockingShipmentIds = shipmentActiveStockIds(state);
      const removedShippedIds = removedItemIds.filter((id) => blockingShipmentIds.has(id));
      if (removedShippedIds.length > 0) throw new Error("已出库或发货的商品不能直接从订单中删除");

      let nextOrder = {
        ...currentOrder,
        ...nextOrderInput,
      };
      let nextNotifications = currentStationNotifications(state);
      let creditApprovalCleared = false;
      const creditTermsChanged = creditApprovalSensitiveSnapshot(currentOrder) !== creditApprovalSensitiveSnapshot(nextOrder);
      if (creditTermsChanged) {
        if (currentOrder.creditSaleApproval) {
          const { creditSaleApproval: _removedApproval, ...orderWithoutApproval } = nextOrder;
          nextOrder = orderWithoutApproval;
          creditApprovalCleared = true;
        }
        nextNotifications = resolveCreditSaleNotifications(
          nextNotifications,
          orderId,
          "order_updated",
          operator,
          new Date().toISOString()
        ).notifications;
      }
      const nextOrders = orders.map((order) => String(order?.id ?? "") === orderId ? nextOrder : order);
      const nextStock = setStockSoldForOrders(state, nextOrders);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: `修改订单「${nextOrder.orderNo}」${creditApprovalCleared ? "，原赊销确认已失效" : ""}`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        stock: nextStock,
        notifications: nextNotifications,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        order: nextOrder,
        orders: visibleNextState.orders,
        stock: visibleNextState.stock,
        inventoryProjection: visibleNextState.inventoryProjection,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      console.warn(`[orders/update] ${error.message}`);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message,
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/payment-candidates" && req.method === "GET") {
    try {
      requireOrderPermissionForAuth(req, "update");
      const { rows } = await pool.query("SELECT data FROM app_state WHERE id = $1", [stateId]);
      const state = rows[0]?.data ?? {};
      const visibleState = siteVisibilityFilteredState(state, req.auth?.account);
      const requestedSiteId = normalizeSiteScope(url.searchParams.get("siteId") ?? ALL_SITE_ID);
      const visibleOrders = requestedSiteId === ALL_SITE_ID
        ? (visibleState.orders ?? [])
        : (siteFilteredState(visibleState, requestedSiteId).orders ?? []);
      const operator = authenticatedOperator(req);
      const admin = req.auth?.account?.accessRole === "admin";
      const ownedOrders = visibleOrders.filter((order) => admin || isCreditSaleOrderOwner(state.personnel, order, operator));
      const ownedById = new Map(ownedOrders.map((order) => [String(order?.id ?? ""), order]));
      const siteIds = requestedSiteId === ALL_SITE_ID
        ? visibleSiteIdsForAccount(req.auth?.account, state)
        : [requestedSiteId];
      const statementResult = await pool.query(
        `SELECT * FROM finance_payment_statements
         WHERE state_id = $1 AND site_id = ANY($2::text[]) AND match_status = 'unmatched' AND direction = 'income'
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT 300`,
        [stateId, siteIds]
      );
      const candidates = statementResult.rows.flatMap((row) => {
        const statement = paymentStatementFromRow(row);
        const relevantCandidates = statement.candidates.filter((candidate) => ownedById.has(String(candidate?.orderId ?? "")));
        if (relevantCandidates.length === 0) return [];
        return [{
          id: statement.id,
          siteId: statement.siteId,
          paymentMethodName: statement.paymentMethodName,
          channel: statement.channel,
          account: statement.account,
          externalTransactionNo: statement.externalTransactionNo,
          occurredAt: statement.occurredAt,
          amount: statement.amount,
          payerName: statement.payerName,
          notes: statement.notes,
          matchReason: statement.matchReason,
          candidates: relevantCandidates.map((candidate) => {
            const order = ownedById.get(String(candidate?.orderId ?? ""));
            return {
              ...candidate,
              orderNo: String(order?.orderNo ?? candidate?.orderNo ?? ""),
              contactPerson: String(order?.contactPerson ?? candidate?.contactPerson ?? ""),
            };
          }),
        }];
      });
      const cashOrders = ownedOrders.flatMap((order) => {
        if (normalizePaymentChannel(order?.paymentChannel) !== "cash" || order?.status === "cancelled") return [];
        const profile = financeMatchingOrderProfiles({ ...visibleState, orders: [order] })[0];
        if (!profile || profile.matchingOutstanding <= 0.005) return [];
        return [{
          orderId: profile.id,
          orderNo: profile.orderNo,
          contactPerson: profile.contactPerson,
          outstanding: profile.matchingOutstanding,
        }];
      });
      sendJson(req, res, 200, { ok: true, candidates, cashOrders });
    } catch (error) {
      sendJson(req, res, 403, { ok: false, error: error.message || "待认领收款加载失败" });
    }
    return;
  }

  if (url.pathname === "/api/orders/payment-claim" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const operator = authenticatedOperator(req);
      requireOrderPermissionForAuth(req, "update");
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      const { order: currentOrder, orders } = resolveAuthorizedLockedOrderTarget(req, state, body.orderId);
      if (req.auth?.account?.accessRole !== "admin" && !isCreditSaleOrderOwner(state.personnel, currentOrder, operator)) {
        throw new Error("只有订单负责人可以登记本单现金收款");
      }
      if (normalizePaymentChannel(currentOrder.paymentChannel) !== "cash") throw new Error("只有现金订单需要人工登记收款");
      const profile = financeMatchingOrderProfiles({ ...state, orders: [currentOrder] })[0];
      const amount = normalizeMoney(body.amount, "Cash payment amount");
      if (amount <= 0) throw new Error("现金收款金额必须大于 0");
      if (!profile || amount - profile.matchingOutstanding > 0.01) {
        throw new Error(`登记金额不能超过待收余额 ¥${Number(profile?.matchingOutstanding ?? 0).toFixed(2)}`);
      }
      const payment = normalizePaymentRecord({
        id: uid("pay"),
        time: body.time || nowDatetimeInChina(),
        type: "balance",
        amount,
        paymentMethodId: currentOrder.paymentMethodId,
        paymentMethodName: currentOrder.paymentMethodName || paymentChannelLabel("cash"),
        channel: "cash",
        account: currentOrder.paymentAccount || "现金",
        verificationStatus: "pending",
        recordSource: "order",
        recordedBy: operator,
        notes: String(body.notes ?? "").trim() || "订单负责人登记现金收款",
        proof: [],
      });
      const nextOrder = {
        ...currentOrder,
        payments: [...(Array.isArray(currentOrder.payments) ? currentOrder.payments : []), payment],
      };
      const operationLog = createOperationLog(
        req,
        "订单管理",
        "登记现金收款",
        `订单「${currentOrder.orderNo}」登记现金收款 ¥${amount.toFixed(2)}，待财务核销`
      );
      const nextState = {
        ...state,
        orders: orders.map((order) => order.id === currentOrder.id ? nextOrder : order),
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, { ok: true, order: nextOrder, orders: visibleNextState.orders, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "现金收款登记失败",
      });
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
      const permissionAction = action === "add"
        ? "create"
        : action === "update" || action === "verify"
          ? "update"
          : action === "delete"
            ? "delete"
            : "";
      if (!permissionAction) throw new Error("不支持的资金记录操作");

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireModulePermissionForAuth(req, "finance", permissionAction);

      const { order: currentOrder, orders } = resolveAuthorizedLockedOrderTarget(req, state, body.orderId);
      const orderId = String(currentOrder.id ?? "");

      const currentPayments = Array.isArray(currentOrder.payments) ? currentOrder.payments : [];
      let nextPayments = currentPayments;
      let detail = "";

      if (action === "add") {
        const incomingPayment = normalizePaymentRecord({
          ...(body.payment ?? {}),
          verificationStatus: "pending",
          recordSource: "finance",
          recordedBy: operator,
          verifiedAt: "",
          verifiedBy: "",
        });
        const paymentMethodSnapshot = resolvePaymentMethodSnapshot(state.systemSettings, incomingPayment, {
          paymentMethodId: currentOrder.paymentMethodId,
          paymentMethodName: currentOrder.paymentMethodName,
          channel: currentOrder.paymentChannel,
          account: currentOrder.paymentAccount,
        });
        const payment = normalizePaymentRecord({
          ...incomingPayment,
          ...paymentMethodSnapshot,
        });
        if (currentPayments.some((item) => String(item?.id ?? "") === payment.id)) {
          throw new Error("资金记录已存在，请刷新后重试");
        }
        nextPayments = [...currentPayments, payment];
        detail = `订单「${currentOrder.orderNo}」补录${paymentTypeLabel(payment.type)} ¥${payment.amount.toFixed(2)}，待核销`;
      } else if (action === "update") {
        const incomingId = String(body.payment?.id ?? "");
        const currentPayment = currentPayments.find((item) => String(item?.id ?? "") === incomingId);
        if (!currentPayment) {
          throw new Error("资金记录不存在，请刷新后重试");
        }
        if (currentPayment?.recordSource === "statement" || currentPayment?.statementId) {
          throw new Error("账单导入的资金记录不能手工修改，请先解除流水关联");
        }
        const incomingPayment = normalizePaymentRecord({
          ...currentPayment,
          ...(body.payment ?? {}),
          verificationStatus: paymentVerificationStatus(currentPayment),
          recordSource: currentPayment?.recordSource || "finance",
          recordedBy: currentPayment?.recordedBy || operator,
          verifiedAt: currentPayment?.verifiedAt || "",
          verifiedBy: currentPayment?.verifiedBy || "",
        });
        const paymentMethodSnapshot = resolvePaymentMethodSnapshot(state.systemSettings, incomingPayment, currentPayment);
        const payment = normalizePaymentRecord({
          ...incomingPayment,
          ...paymentMethodSnapshot,
        });
        nextPayments = currentPayments.map((item) => String(item?.id ?? "") === payment.id ? payment : item);
        detail = `订单「${currentOrder.orderNo}」修改${paymentTypeLabel(payment.type)}记录 ¥${payment.amount.toFixed(2)}`;
      } else if (action === "verify") {
        const paymentId = String(body.paymentId ?? body.payment?.id ?? "");
        const currentPayment = currentPayments.find((item) => String(item?.id ?? "") === paymentId);
        if (!currentPayment) throw new Error("资金记录不存在，请刷新后重试");
        if (isPaymentVerified(currentPayment)) throw new Error("该资金记录已经核销");
        const payment = normalizePaymentRecord({
          ...currentPayment,
          verificationStatus: "verified",
          verifiedAt: nowDatetimeInChina(),
          verifiedBy: operator,
        });
        nextPayments = currentPayments.map((item) => String(item?.id ?? "") === payment.id ? payment : item);
        detail = `订单「${currentOrder.orderNo}」核销${paymentTypeLabel(payment.type)} ¥${payment.amount.toFixed(2)}（${paymentChannelLabel(payment.channel)}）`;
      } else {
        const paymentId = String(body.paymentId ?? body.payment?.id ?? "");
        const deletingPayment = currentPayments.find((item) => String(item?.id ?? "") === paymentId);
        if (!deletingPayment) throw new Error("资金记录不存在，请刷新后重试");
        if (deletingPayment?.recordSource === "statement" || deletingPayment?.statementId) {
          throw new Error("账单导入的资金记录不能直接删除，请使用解除流水关联");
        }
        nextPayments = currentPayments.filter((item) => String(item?.id ?? "") !== paymentId);
        detail = `订单「${currentOrder.orderNo}」删除${paymentTypeLabel(deletingPayment.type)}记录 ¥${Number(deletingPayment.amount ?? 0).toFixed(2)}`;
      }

      const nextOrder = { ...currentOrder, payments: nextPayments };
      const nextOrders = orders.map((order) => String(order?.id ?? "") === orderId ? nextOrder : order);
      let nextNotifications = currentStationNotifications(state);
      const nextGate = shipmentPaymentGateForOrder(nextOrder, state.shipments);
      if (nextGate.status === "verified" || nextGate.status === "platform_exempt") {
        nextNotifications = resolveCreditSaleNotifications(
          nextNotifications,
          orderId,
          nextGate.status === "verified" ? "finance_verified" : "platform_exempt",
          operator,
          new Date().toISOString()
        ).notifications;
      }
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "财务管理",
        action: action === "add" ? "添加记录" : action === "update" ? "修改记录" : action === "verify" ? "核销记录" : "删除记录",
        detail,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        notifications: nextNotifications,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };

      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      if (action === "verify") {
        const verifiedPayment = nextPayments.find((payment) => String(payment?.id ?? "") === String(body.paymentId ?? body.payment?.id ?? ""));
        if (verifiedPayment?.statementId) {
          const updatedStatement = await client.query(
            `UPDATE finance_payment_statements
             SET match_status = 'verified', verified_at = now(), verified_by = $3
             WHERE id = $1 AND state_id = $2 AND matched_payment_id = $4
             RETURNING batch_id`,
            [verifiedPayment.statementId, stateId, operator, verifiedPayment.id]
          );
          if (updatedStatement.rowCount === 0) throw new Error("关联账单流水不存在，不能完成核销");
          await refreshStatementBatchMatchCounts(client, updatedStatement.rows[0]?.batch_id);
        }
      }
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        order: nextOrder,
        orders: visibleNextState.orders,
        inventoryProjection: visibleNextState.inventoryProjection,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message,
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/refund" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = await externalizeDataUrls(JSON.parse(await readBody(req)));
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = rows[0]?.data ?? {};
      requireOrderPermissionForAuth(req, "update");

      const { order: currentOrder, orders } = resolveAuthorizedLockedOrderTarget(req, state, body.orderId);
      const orderId = String(currentOrder.id ?? "");
      if (orderHasActuallyShipped(state.shipments, currentOrder.id)) {
        throw new Error("订单已经发货，不能登记普通退款，请在对应发货单使用报损退款");
      }

      const channel = normalizePaymentChannel(currentOrder.paymentChannel);
      if (!channel) throw new Error("请选择退款渠道");
      const account = String(currentOrder.paymentAccount ?? "").trim() ||
        configuredPaymentMethod(state.systemSettings, currentOrder.paymentMethodId || channel)?.account || "";
      if (!account) throw new Error("该订单的付款方式尚未配置收款账户，请联系管理员处理");
      const amount = normalizeMoney(body.amount, "Refund amount");
      if (amount <= 0) throw new Error("退款金额必须大于 0");
      const payment = normalizePaymentRecord({
        id: body.id || uid("pay"),
        time: body.time || nowDatetimeInChina(),
        type: "refund",
        amount,
        paymentMethodId: currentOrder.paymentMethodId,
        paymentMethodName: currentOrder.paymentMethodName || paymentChannelLabel(channel),
        channel,
        account,
        externalTransactionNo: "",
        verificationStatus: "pending",
        recordSource: "order",
        refundMethod: refundMethodForChannel(channel),
        recordedBy: operator,
        proof: body.proof,
        notes: body.notes,
      });
      const currentPayments = Array.isArray(currentOrder.payments) ? currentOrder.payments : [];
      if (currentPayments.some((item) => String(item?.id ?? "") === payment.id)) {
        throw new Error("退款记录已存在，请刷新后重试");
      }
      const nextOrder = { ...currentOrder, payments: [...currentPayments, payment] };
      const nextOrders = orders.map((order) => String(order?.id ?? "") === orderId ? nextOrder : order);
      const refundPath = payment.refundMethod === "platform" ? "平台退款冲减" : "账户退款出账";
      const operationLog = createOperationLog(
        req,
        "订单管理",
        "登记退款",
        `订单「${currentOrder.orderNo}」登记${refundPath} ¥${amount.toFixed(2)}，渠道 ${paymentChannelLabel(channel)}，待财务核销`
      );
      const nextState = {
        ...state,
        orders: nextOrders,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [
        stateId,
        JSON.stringify(nextState),
      ]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, { ok: true, order: nextOrder, orders: visibleNextState.orders, operationLog });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "退款登记失败",
      });
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

      const requestedOrderId = String(body.orderId ?? "").trim();
      const stockItemId = String(body.stockItemId ?? "").trim();
      if (!requestedOrderId || !stockItemId) throw new Error("缺少订单或商品信息");

      const { order: currentOrder, orders } = resolveAuthorizedLockedOrderTarget(req, state, requestedOrderId);
      const orderId = String(currentOrder.id ?? "");
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
        const channel = normalizePaymentChannel(currentOrder.paymentChannel);
        const account = String(currentOrder.paymentAccount ?? "").trim() ||
          configuredPaymentMethod(state.systemSettings, currentOrder.paymentMethodId || channel)?.account || "";
        if (!channel || !account) throw new Error("该订单的付款方式尚未配置收款账户，请联系管理员处理");
        refundRecord = normalizePaymentRecord({
          ...body.refund,
          paymentMethodId: currentOrder.paymentMethodId,
          paymentMethodName: currentOrder.paymentMethodName || paymentChannelLabel(channel),
          channel,
          account,
          externalTransactionNo: "",
          verificationStatus: "pending",
          recordSource: "order",
          refundMethod: refundMethodForChannel(channel),
          recordedBy: operator,
        });
        if (refundRecord.type !== "refund") throw new Error("退商品只能写入退款记录");
        if (refundRecord.amount <= 0.005) refundRecord = null;
      }
      if (refundRecord) {
        requireOrderPermissionForAuth(req, "create");
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
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        order: nextOrder,
        orders: visibleNextState.orders,
        stock: visibleNextState.stock,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "退商品失败",
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/orders/complete" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      requireOrderPermissionForAuth(req, "update");

      const requestedOrderId = String(body.orderId ?? "").trim();
      const { order: currentOrder, orders } = resolveAuthorizedLockedOrderTarget(req, state, requestedOrderId);
      const orderId = String(currentOrder.id ?? "");
      if (currentOrder.status === "completed") {
        await client.query("ROLLBACK");
        const visibleState = siteVisibilityFilteredState(state, req.auth?.account);
        sendJson(req, res, 200, {
          ok: true,
          order: currentOrder,
          orders: visibleState.orders,
          inventoryProjection: visibleState.inventoryProjection,
        });
        return;
      }
      if (currentOrder.status === "cancelled") throw new Error("已取消订单不能标记完成");
      validateOrderShippingFeesRecorded(currentOrder, state.shipments);
      const paymentGate = shipmentPaymentGateForOrder(currentOrder, state.shipments);
      if (!paymentGate.canShip) {
        const blocked = await commitShipmentPaymentBlock(client, req, state, currentOrder, paymentGate);
        sendJson(req, res, 409, {
          ok: false,
          code: "CREDIT_SALE_CONFIRMATION_REQUIRED",
          ...blocked,
        });
        return;
      }
      validateOrderCanComplete(currentOrder, state.shipments);

      const nextOrder = { ...currentOrder, status: "completed" };
      const nextOrders = orders.map((order) => String(order?.id ?? "") === orderId ? nextOrder : order);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: `订单「${currentOrder.orderNo}」标记完成`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        order: nextOrder,
        orders: visibleNextState.orders,
        inventoryProjection: visibleNextState.inventoryProjection,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "完成订单失败",
      });
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
      const requestedOrderId = String(body.orderId ?? "").trim();
      const { order, orders } = resolveAuthorizedLockedOrderTarget(req, state, requestedOrderId);
      const orderId = String(order.id ?? "");
      if (Array.isArray(order.payments) && order.payments.length > 0) throw new Error("该订单已有收款记录，不能删除");

      const nextOrders = orders.filter((item) => String(item?.id ?? "") !== orderId);
      const nextShipments = (Array.isArray(state.shipments) ? state.shipments : [])
        .filter((shipment) => String(shipment?.orderId ?? "") !== orderId);
      const nextStock = setStockSoldForOrders({ ...state, shipments: nextShipments }, nextOrders);
      const nextNotifications = resolveCreditSaleNotifications(
        currentStationNotifications(state),
        orderId,
        "order_deleted",
        operator,
        new Date().toISOString()
      ).notifications;
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
        notifications: nextNotifications,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        orders: visibleNextState.orders,
        shipments: visibleNextState.shipments,
        stock: visibleNextState.stock,
        inventoryProjection: visibleNextState.inventoryProjection,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message,
      });
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
      const shipments = Array.isArray(state.shipments) ? state.shipments : [];
      const requestedOrderId = String(body.orderId ?? "").trim();
      const { order, orders } = resolveAuthorizedLockedOrderTarget(req, state, requestedOrderId);
      const orderId = String(order.id ?? "");
      if (order.status === "completed" || order.status === "cancelled") throw new Error("该订单当前状态不能出库");
      const shipmentId = resolveCreateRecordId({
        records: shipments,
        requestedId: body.id,
        createId: () => uid("ship"),
        label: "发货单",
        conflictCode: "SHIPMENT_ID_CONFLICT",
      });
      const selectedItemIds = Array.isArray(body.selectedItemIds)
        ? body.selectedItemIds.map((id) => String(id ?? "").trim()).filter(Boolean)
        : [];
      if (selectedItemIds.length === 0) throw new Error("请选择要出库的商品");
      if (new Set(selectedItemIds).size !== selectedItemIds.length) throw new Error("同一条鱼不能重复出库");
      const orderItemIds = new Set((Array.isArray(order.items) ? order.items : [])
        .filter(orderItemKeepsInventory)
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
      const requiredShipMethod = requiredShipMethodForOrderSource(order.source);
      if (requiredShipMethod === "pickup" && shipMethod !== "pickup") {
        throw new Error("线下自提订单不需要快递发货，请使用上门自取");
      }
      if (requiredShipMethod === "express" && shipMethod !== "express") {
        throw new Error("只有线下自提订单可以使用上门自取，当前订单只能物流发货");
      }
      const carrier = shipMethod === "express"
        ? resolveShippingCarrier(state.systemSettings, body.carrier)
        : "上门自取";
      const shipDate = String(body.shipDate ?? "").trim();
      if (!shipDate) throw new Error("请选择出库日期");
      const isPickup = shipMethod === "pickup";
      const shippingFeeMode = normalizeShippingFeeMode(order.shippingFeeMode, order.source);
      const actualShippingFee = isPickup || shippingFeeMode === "collect"
        ? 0
        : normalizeOutboundActualShippingFee(body.actualShippingFee, shippingFeeMode);
      const createdAt = nowDatetimeInChina();
      const shipment = {
        id: shipmentId,
        siteId: normalizeSiteId(order.siteId),
        orderId: order.id,
        createdAt,
        outboundDate: shipDate,
        shipDate,
        carrier,
        trackingNo: "",
        status: isPickup ? "delivered" : "outbound",
        notes: String(body.notes ?? ""),
        shipMethod,
        actualShippingFee,
        itemStockIds: selectedItemIds,
        ...(isPickup ? { shippedAt: createdAt, deliveredAt: createdAt } : {}),
      };
      assertActiveShipmentInventoryAssignment(shipment, {
        orders,
        stock: state.stock,
      });
      const paymentGate = shipmentPaymentGateForOrder(order, [
        ...shipments,
        shipment,
      ]);
      if (!paymentGate.canShip) {
        const blocked = await commitShipmentPaymentBlock(client, req, state, order, paymentGate);
        sendJson(req, res, 409, {
          ok: false,
          code: "CREDIT_SALE_CONFIRMATION_REQUIRED",
          ...blocked,
        });
        return;
      }
      const nextShipments = [...shipments, shipment];
      const nextOrders = orders.map((item) =>
        String(item?.id ?? "") === order.id
          ? { ...item, status: item.status === "damaged" ? "damaged" : "shipped" }
          : item
      );
      const nextNotifications = resolveShipmentGateNotifications(
        currentStationNotifications(state),
        order.id,
        paymentGate,
        operator
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
        notifications: nextNotifications,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        shipment,
        orders: visibleNextState.orders,
        shipments: visibleNextState.shipments,
        inventoryProjection: visibleNextState.inventoryProjection,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message,
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/shipments/actual-shipping-fee" && req.method === "POST") {
    const client = await pool.connect();
    try {
      let body;
      try {
        body = JSON.parse(await readBody(req) || "{}");
      } catch {
        throw new ShipmentActualShippingFeeError("请求 JSON 格式不正确");
      }
      const result = await updateLockedAppState(client, stateId, (state) => {
        const planned = planActualShippingFeeUpdate({
          state,
          request: body,
          hasOrderUpdatePermission: orderPermissionAllowedForAccount(req.auth?.account, "update"),
          visibleSiteIds: visibleSiteIdsForAccount(req.auth?.account, state),
        });
        const previousFee = Number(planned.shipment.actualShippingFee ?? 0);
        const operationLog = createOperationLog(
          req,
          "订单管理",
          "修改记录",
          `订单「${planned.order.orderNo || planned.order.id}」发货单「${planned.updatedShipment.id}」实际运费 ¥${previousFee.toFixed(2)} → ¥${planned.updatedShipment.actualShippingFee.toFixed(2)}`
        );
        return {
          nextState: {
            ...state,
            shipments: planned.shipments,
            operationLogs: pushOperationLog(state.operationLogs, operationLog),
          },
          shipment: planned.updatedShipment,
          operationLog,
        };
      });
      sendJson(req, res, 200, {
        ok: true,
        shipment: result.shipment,
        operationLog: result.operationLog,
      });
    } catch (error) {
      const knownError = error instanceof ShipmentActualShippingFeeError;
      if (!knownError) console.error("Failed to save actual shipping fee:", error);
      sendJson(req, res, knownError ? error.statusCode : 500, {
        ok: false,
        ...(knownError && error.code ? { code: error.code } : {}),
        error: knownError ? error.message : "补录实际运费失败，请稍后重试",
      });
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
      const requestedShipmentId = String(body.shipmentId ?? "").trim();
      const packingProof = Array.isArray(body.packingProof)
        ? body.packingProof.map((item) => String(item ?? "")).filter(Boolean)
        : [];
      if (!requestedShipmentId) throw new Error("缺少发货单信息，请刷新后重试");
      if (packingProof.length < 2) throw new Error("请至少上传 2 张打包凭证");

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      requireOrderPermissionForAuth(req, "update");

      const { shipment, shipments, order, orders } = resolveAuthorizedLockedShipmentTarget(req, state, requestedShipmentId);
      const shipmentId = String(shipment.id ?? "");
      if (shipment.status !== "outbound") throw new Error("只有已出库的发货单可以确认发货");

      if (order.status === "completed") throw new Error("已完成订单不能再确认发货");
      if (order.status === "cancelled") throw new Error("已取消订单不能再确认发货");

      const paymentGate = shipmentPaymentGateForOrder(order, shipments);
      if (!paymentGate.canShip) {
        const blocked = await commitShipmentPaymentBlock(client, req, state, order, paymentGate);
        sendJson(req, res, 409, {
          ok: false,
          code: "CREDIT_SALE_CONFIRMATION_REQUIRED",
          ...blocked,
        });
        return;
      }

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
      const nextNotifications = resolveShipmentGateNotifications(
        currentStationNotifications(state),
        order.id,
        paymentGate,
        operator
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
        notifications: nextNotifications,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        shipment: updatedShipment,
        orders: visibleNextState.orders,
        shipments: visibleNextState.shipments,
        inventoryProjection: visibleNextState.inventoryProjection,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "确认发货失败",
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/shipments/deliver" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      requireOrderPermissionForAuth(req, "update");

      const requestedShipmentId = String(body.shipmentId ?? "").trim();
      const { shipment, shipments, order, orders } = resolveAuthorizedLockedShipmentTarget(req, state, requestedShipmentId);
      const shipmentId = String(shipment.id ?? "");
      if (order.status === "completed") throw new Error("已完成订单不能再确认签收");
      if (order.status === "cancelled") throw new Error("已取消订单不能再确认签收");
      if (shipment.status === "delivered") {
        await client.query("ROLLBACK");
        const visibleState = siteVisibilityFilteredState(state, req.auth?.account);
        sendJson(req, res, 200, {
          ok: true,
          shipment,
          orders: visibleState.orders,
          shipments: visibleState.shipments,
        });
        return;
      }
      const shippingFeeMode = normalizeShippingFeeMode(order.shippingFeeMode, order.source);
      if (shipmentHasPendingActualShippingFee(shippingFeeMode, shipment)) {
        throw new Error(`${shippingFeeMode === "free" ? "包邮" : "寄付"}订单确认签收前必须补录实际运费`);
      }
      const nextShipment = {
        ...shipment,
        status: "delivered",
        deliveredAt: shipment.deliveredAt || nowDatetimeInChina(),
      };
      validateShipmentPatchTransition(shipment, nextShipment);

      const nextShipments = shipments.map((item) => String(item?.id ?? "") === shipmentId ? nextShipment : item);
      const nextOrders = orders.map((item) =>
        String(item?.id ?? "") === String(order.id ?? "")
          ? { ...item, status: item.status === "damaged" ? "damaged" : "shipped" }
          : item
      );
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: `订单「${order.orderNo}」确认签收`,
      };
      const nextState = {
        ...state,
        orders: nextOrders,
        shipments: nextShipments,
        operationLogs: pushOperationLog(state.operationLogs, operationLog),
      };
      await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1", [stateId, JSON.stringify(nextState)]);
      await client.query("COMMIT");
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        shipment: nextShipment,
        orders: visibleNextState.orders,
        shipments: visibleNextState.shipments,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "确认签收失败",
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/shipments/damage" && req.method === "POST") {
    const client = await pool.connect();
    try {
      const rawBody = JSON.parse(await readBody(req) || "{}");
      const body = await externalizeDataUrls(rawBody);
      const operator = authenticatedOperator(req);
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      requireOrderPermissionForAuth(req, "update");

      const requestedShipmentId = String(body.shipmentId ?? "").trim();
      const resolution = String(body.resolution ?? "").trim();
      if (!["refund", "reship"].includes(resolution)) throw new Error("发货报损必须选择退款或补发处理方式");
      const { shipment, shipments, order, orders } = resolveAuthorizedLockedShipmentTarget(req, state, requestedShipmentId);
      const shipmentId = String(shipment.id ?? "");
      if (shipment.shipMethod === "pickup") throw new Error("上门自取订单不可报损");
      if (!shipmentHasActuallyShipped(shipment)) {
        throw new Error("发货单尚未确认发货，不能报损退款或补发");
      }
      if (order.status === "completed") throw new Error("已完成订单不能再报损");
      if (order.status === "cancelled") throw new Error("已取消订单不能再报损");

      const shippedItemIds = (Array.isArray(shipment.itemStockIds) ? shipment.itemStockIds : [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean);
      const shippedItemIdSet = new Set(shippedItemIds);
      const orderItems = Array.isArray(order.items) ? order.items : [];
      let nextShipment = {
        ...shipment,
        status: "damaged",
        damageResolution: resolution,
        damagedAt: nowDatetimeInChina(),
        notes: String(body.notes ?? shipment.notes ?? ""),
      };
      let nextOrder = order;
      let nextStock = Array.isArray(state.stock) ? state.stock : [];

      if (resolution === "refund") {
        const damagedItemStockIds = Array.isArray(body.damagedItemStockIds)
          ? body.damagedItemStockIds.map((id) => String(id ?? "").trim()).filter(Boolean)
          : [];
        if (damagedItemStockIds.length === 0) throw new Error("请选择实际需要退款的商品");
        if (new Set(damagedItemStockIds).size !== damagedItemStockIds.length) throw new Error("同一条商品不能重复报损");
        if (damagedItemStockIds.some((id) => !shippedItemIdSet.has(id))) {
          throw new Error("报损商品不属于当前发货单，请刷新后重试");
        }
        const refundAmount = normalizeMoney(body.refundAmount, "Damage refund amount");
        if (refundAmount <= 0.005) throw new Error("请输入有效待退款金额");
        const selectedSubtotal = orderItems
          .filter((item) => damagedItemStockIds.includes(String(item?.stockItemId ?? "")))
          .reduce((sum, item) => sum + Number(item?.price ?? 0), 0);
        const maxRefund = selectedSubtotal;
        if (refundAmount > maxRefund + 0.005) {
          throw new Error(`应收调减金额不能超过已选商品售价 ¥${maxRefund.toFixed(2)}`);
        }
        nextShipment = {
          ...nextShipment,
          damageItemStockIds: damagedItemStockIds,
          damageAmount: refundAmount,
          damageRefundAmount: refundAmount,
          damageProof: Array.isArray(body.proof) ? body.proof.map((item) => String(item ?? "")).filter(Boolean) : [],
        };
        nextOrder = { ...order, status: "damaged" };
      } else {
        const replacements = normalizeDamageReplacementSelection(body.replacements, shippedItemIds);
        const replacementMap = new Map(replacements.map((item) => [
          item.originalStockItemId,
          item.replacementStockItemId,
        ]));
        const replacementIds = [...replacementMap.values()];
        const blockedShipmentIds = shipmentActiveStockIds(state, shipment.id);
        const shippedIds = shippedOutStockIds(state);
        for (const replacementStockItemId of replacementIds) {
          const stockItem = nextStock.find((item) => String(item?.id ?? "") === replacementStockItemId);
          if (!stockItem) throw new Error("补发库存不存在，请刷新后重试");
          if (stockItem.sold) throw new Error("补发库存已被订单占用，请刷新后重试");
          if (stockItem.lost) throw new Error("已损耗商品不能补发");
          if (blockedShipmentIds.has(replacementStockItemId)) throw new Error("补发库存已经出库或发货，请刷新后重试");
          if (!isPhysicallyInTank(stockItem, shippedIds)) throw new Error("补发库存已不在缸内，不能补发");
          if (stockSiteId(state, stockItem) !== normalizeSiteId(order.siteId)) throw new Error("不能跨场地选择补发库存鱼");
        }
        const damageReplacements = snapshotDamageReplacements({
          replacements: [...replacementMap.entries()].map(([originalStockItemId, replacementStockItemId]) => ({
            originalStockItemId,
            replacementStockItemId,
          })),
          stock: nextStock,
          products: state.products,
          tankGroups: state.tankGroups,
        });
        nextShipment = {
          ...nextShipment,
          damageItemStockIds: [...replacementMap.keys()],
          damageAmount: Number(orderItems
            .filter((item) => replacementMap.has(String(item?.stockItemId ?? "")))
            .reduce((sum, item) => sum + Number(item?.price ?? 0), 0)
            .toFixed(2)),
          damageReplacements,
        };
        nextStock = nextStock.map((stockItem) =>
          replacementIds.includes(String(stockItem?.id ?? ""))
            ? { ...stockItem, sold: true }
            : stockItem
        );
        nextOrder = {
          ...order,
          status: "shipped",
          items: orderItems.map((orderItem) => {
            const replacementStockItemId = replacementMap.get(String(orderItem?.stockItemId ?? ""));
            if (!replacementStockItemId) return orderItem;
            const replacementStock = nextStock.find((stockItem) => String(stockItem?.id ?? "") === replacementStockItemId);
            return {
              ...orderItem,
              stockItemId: replacementStockItemId,
              productId: replacementStock?.productId ?? orderItem.productId,
              fishCode: String(replacementStock?.code ?? "").trim() || undefined,
            };
          }),
        };
      }

      validateShipmentPatchTransition(shipment, nextShipment);
      const nextShipments = shipments.map((item) => String(item?.id ?? "") === shipmentId ? nextShipment : item);
      const nextOrders = orders.map((item) => String(item?.id ?? "") === String(order.id ?? "") ? nextOrder : item);
      const operationLog = {
        id: uid("log"),
        time: new Date().toISOString(),
        operator,
        module: "订单管理",
        action: "修改记录",
        detail: resolution === "refund"
          ? `订单「${order.orderNo}」登记发货报损退款，订单应收调减 ¥${Number(nextShipment.damageRefundAmount ?? 0).toFixed(2)}，待财务核销`
          : `订单「${order.orderNo}」发货报损，补发关系：${(nextShipment.damageReplacements ?? []).map((item) =>
              `${item.originalProductName || "原鱼"}${item.originalFishCode ? `(${item.originalFishCode})` : ""}` +
              ` → ${item.replacementProductName || "补发鱼"}${item.replacementFishCode ? `(${item.replacementFishCode})` : ""}`
            ).join("、")}`,
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
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        shipment: nextShipment,
        order: nextOrder,
        orders: visibleNextState.orders,
        shipments: visibleNextState.shipments,
        stock: visibleNextState.stock,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "发货报损失败",
      });
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

      const requestedShipmentId = String(body.shipmentId ?? "").trim();
      const { shipment, shipments, order, orders } = resolveAuthorizedLockedShipmentTarget(req, state, requestedShipmentId);
      const shipmentId = String(shipment.id ?? "");
      if (shipment.status !== "outbound" && shipment.status !== "shipped") {
        throw new Error("只有已出库或运输中的发货单可以取消");
      }

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
      const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
      sendJson(req, res, 200, {
        ok: true,
        orders: visibleNextState.orders,
        shipments: visibleNextState.shipments,
        stock: visibleNextState.stock,
        inventoryProjection: visibleNextState.inventoryProjection,
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, error?.statusCode || 400, {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "取消出库失败",
      });
    } finally {
      client.release();
    }
    return;
  }

  if (url.pathname === "/api/state/patch" && req.method === "POST") {
    let client = null;
    try {
      const body = await readBody(req, 16 * 1024 * 1024);
	      const parsed = JSON.parse(body);
	      const rawPatch = parsed?.patch && typeof parsed.patch === "object" ? parsed.patch : {};
	      validateStatePatchAuthorization(req, rawPatch);
	      validateStatePatchShapes(rawPatch);
	      if (
	        rawPatch.systemSettings &&
	        typeof rawPatch.systemSettings === "object" &&
	        Object.prototype.hasOwnProperty.call(rawPatch.systemSettings, "orderPackagingFee")
	      ) {
	        const orderPackagingFee = Number(rawPatch.systemSettings.orderPackagingFee);
	        if (!Number.isFinite(orderPackagingFee) || orderPackagingFee < 0 || orderPackagingFee > 100000) {
	          throw new Error("统一包装费必须是 0 至 100000 之间的金额");
	        }
	        rawPatch.systemSettings = {
	          ...rawPatch.systemSettings,
	          orderPackagingFee: Number(orderPackagingFee.toFixed(2)),
	        };
	      }
	      if (
	        rawPatch.systemSettings &&
	        typeof rawPatch.systemSettings === "object" &&
	        Object.prototype.hasOwnProperty.call(rawPatch.systemSettings, "shippingCarriers")
	      ) {
	        rawPatch.systemSettings = {
	          ...rawPatch.systemSettings,
	          shippingCarriers: validateShippingCarrierSettings(rawPatch.systemSettings.shippingCarriers),
	        };
	      }
	      const basePatch = parsed?.basePatch && typeof parsed.basePatch === "object" ? parsed.basePatch : {};
	      validateStatePatchShapes(basePatch);
	      if (Array.isArray(rawPatch.products)) {
	        rawPatch.products = rawPatch.products.map(withoutLegacyProductVisibility);
	      }
	      if (Array.isArray(basePatch.products)) {
	        basePatch.products = basePatch.products.map(withoutLegacyProductVisibility);
	      }
	      if (Array.isArray(parsed?.operationLogs) && parsed.operationLogs.length > 0) {
	        throw new Error("操作日志只能由服务端生成");
	      }
	      client = await pool.connect();
	      await client.query("BEGIN");
	      const projectedKeys = planGenericStatePatchReadKeys(Object.keys(rawPatch));
	      const projectedColumns = projectedKeys
	        .map((key) => `data -> '${key}' AS "${key}"`)
	        .join(",\n                 ");
	      const { rows } = await client.query(
	        `SELECT ${projectedColumns}
	         FROM app_state
	         WHERE id = $1
	         FOR UPDATE`,
	        [stateId]
	      );
	      if (!rows[0]) throw new Error("系统状态不存在");
	      const persistedCurrent = Object.fromEntries(projectedKeys.map((key) => [key, rows[0][key]]));
	      const current = normalizePickupShipmentsForState(persistedCurrent);
	      if (projectedKeys.includes("products") && Array.isArray(current.products)) {
	        current.products = current.products.map(withoutLegacyProductVisibility);
	      }
	      if (projectedKeys.includes("publicCatalogPolicy")) {
	        current.publicCatalogPolicy = normalizePublicCatalogPolicy(current.publicCatalogPolicy);
	      }
	      if (Object.prototype.hasOwnProperty.call(rawPatch, "publicCatalogPolicy")) {
	        if (!Object.prototype.hasOwnProperty.call(basePatch, "publicCatalogPolicy") ||
	            stableJson(normalizePublicCatalogPolicy(basePatch.publicCatalogPolicy)) !== stableJson(current.publicCatalogPolicy)) {
	          const error = new Error("鱼单展示设置已被其他管理员修改，请刷新后重试");
	          error.statusCode = 409;
	          error.code = "PUBLIC_CATALOG_POLICY_CONFLICT";
	          throw error;
	        }
	        rawPatch.publicCatalogPolicy = validatePublicCatalogPolicyWrite(rawPatch.publicCatalogPolicy, {
	          products: current.products,
	          species: current.species,
	        });
	      }
	      if (Array.isArray(rawPatch.shipments)) {
	        const currentShipments = new Map((Array.isArray(current.shipments) ? current.shipments : [])
	          .map((shipment) => [String(shipment?.id ?? ""), shipment]));
	        const orders = new Map((Array.isArray(current.orders) ? current.orders : [])
	          .map((order) => [String(order?.id ?? ""), order]));
	        rawPatch.shipments = rawPatch.shipments.map((shipment) => {
	          const previous = currentShipments.get(String(shipment?.id ?? ""));
	          if (previous && stableJson(previous) === stableJson(shipment)) return shipment;
	          if (shipment?.shipMethod === "pickup") return { ...shipment, actualShippingFee: 0 };
	          const order = orders.get(String(shipment?.orderId ?? ""));
	          const mode = normalizeShippingFeeMode(order?.shippingFeeMode, order?.source);
	          if (mode === "collect") return { ...shipment, actualShippingFee: 0 };
	          const actualShippingFee = shipment?.status === "preparing"
	            ? normalizeOutboundActualShippingFee(shipment?.actualShippingFee, "prepaid")
	            : normalizeOutboundActualShippingFee(shipment?.actualShippingFee, mode);
	          return { ...shipment, actualShippingFee };
	        });
	      }
	      const validationState = buildStatePatch(current, rawPatch, basePatch, [], req);

	      validateStatePatchActions(req, current, validationState, Object.keys(rawPatch));
	      validateOrderStatePatch(req, current, validationState, Object.keys(rawPatch));
	      validateReferenceIntegrity(current, validationState, Object.keys(rawPatch));
	      validateGenericStatePatchSiteScope(req, current, validationState, Object.keys(rawPatch));
	      const patch = await externalizeDataUrls(rawPatch);
	      if (Object.prototype.hasOwnProperty.call(patch, "batches") && Array.isArray(patch.batches)) {
	        patch.batches = preserveBatchCreationTimes(current.batches, patch.batches);
	      }
	      const stateWithoutLogs = buildStatePatch(current, patch, basePatch, [], req);
	      if (Array.isArray(stateWithoutLogs.products)) {
	        stateWithoutLogs.products = stateWithoutLogs.products.map(withoutLegacyProductVisibility);
	      }
	      if (Object.keys(patch).some((key) => key === "products" || key === "species")) {
	        stateWithoutLogs.publicCatalogPolicy = prunePublicCatalogPolicyReferences(
	          stateWithoutLogs.publicCatalogPolicy,
	          { products: stateWithoutLogs.products, species: stateWithoutLogs.species }
	        );
	      }
	      const appliedOperationLogs = statePatchOperationLogs(req, current, stateWithoutLogs, Object.keys(patch));
	      // Audit history is deliberately not selected into Node for every small
	      // generic edit. Append the new server-generated entries in PostgreSQL
	      // below, while keeping the in-memory candidate limited to validation
	      // dependencies and actually patched fields.
	      const nextState = { ...stateWithoutLogs };
	      delete nextState.operationLogs;

      const persistedKeys = STATE_KEYS.filter((key) =>
        key !== "operationLogs" &&
        Object.prototype.hasOwnProperty.call(nextState, key) &&
        stableJson(persistedCurrent[key]) !== stableJson(nextState[key])
      );
      if (persistedKeys.length > 0 || appliedOperationLogs.length > 0) {
        let dataExpression = "data";
        const updateValues = [stateId];
        for (const key of persistedKeys) {
          updateValues.push(JSON.stringify(nextState[key] ?? null));
          dataExpression = `jsonb_set(${dataExpression}, '{${key}}', $${updateValues.length}::jsonb, true)`;
        }
        if (appliedOperationLogs.length > 0) {
          updateValues.push(JSON.stringify(appliedOperationLogs));
          const operationLogsParameter = `$${updateValues.length}`;
          dataExpression = `jsonb_set(
            ${dataExpression},
            '{operationLogs}',
            COALESCE((
              SELECT jsonb_agg(entry.value ORDER BY entry.ordinality)
              FROM (
                SELECT value, ordinality
                FROM jsonb_array_elements(
                  ${operationLogsParameter}::jsonb || COALESCE(data -> 'operationLogs', '[]'::jsonb)
                ) WITH ORDINALITY
                LIMIT ${MAX_OPERATION_LOGS}
              ) AS entry
            ), '[]'::jsonb),
            true
          )`;
        }
        await client.query(
          `UPDATE app_state
           SET data = ${dataExpression}, updated_at = now()
           WHERE id = $1`,
          updateValues
        );
      }
      await client.query("COMMIT");
      const projectionChanged = Object.keys(patch).some((key) => key === "orders" || key === "shipments");
      sendJson(req, res, 200, {
        ok: true,
        appliedOperationLogs,
        ...(projectionChanged ? { inventoryProjection: inventoryProjectionForResponse(nextState, req) } : {}),
      });
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, Number(error?.statusCode ?? 400), { error: `Failed to patch PostgreSQL state: ${error.message}` });
    } finally {
      client?.release();
    }
    return;
  }

  if (url.pathname === "/api/approvals/stock" && req.method === "POST") {
    const client = await pool.connect();
    try {
      requireAdminForAuth(req);
      const body = JSON.parse(await readBody(req) || "{}");
      const compactResponse = body.responseMode === "compact";
      const requestId = String(body.requestId ?? "").trim();
      const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : "";
      const note = String(body.note ?? "").trim().slice(0, 500);
      if (!requestId || !decision) throw new Error("请选择有效的审批操作");
      if (decision === "rejected" && !note) {
        const error = new Error("驳回库存审批时请填写处理说明");
        error.code = "STOCK_APPROVAL_REJECTION_NOTE_REQUIRED";
        throw error;
      }

      await client.query("BEGIN");
      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
      const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
      const requests = currentApprovalRequests(state);
      const approvalRequest = requests.find((request) => String(request?.id ?? "") === requestId);
      if (!approvalRequest) throw new Error("审批记录不存在，请刷新后重试");
      if (approvalRequest.status !== "pending") throw new Error("该审批已由其他管理员处理");
      if (approvalRequest.type !== "stock_change") throw new Error("不支持的审批类型");

      const resolvedAt = new Date().toISOString();
      const resolvedBy = authenticatedOperator(req);
      const resolvedByName = authenticatedOperatorName(req);
      let mutation = null;
      let stateAfterMutation = state;
      if (decision === "approved") {
        const payload = approvalRequest.payload && typeof approvalRequest.payload === "object"
          ? approvalRequest.payload
          : {};
        const approvalReview = stockApprovalReviewDetails(approvalRequest, state);
        if (!approvalReview.reviewComplete) {
          const error = new Error("库存审批明细不完整或无法安全重建，请填写原因后驳回并让发起人重新提交");
          error.statusCode = 409;
          error.code = "STOCK_APPROVAL_REVIEW_INCOMPLETE";
          throw error;
        }
        assertStockMutationExpectation(state, payload);
        const creatorUsername = String(approvalRequest.createdBy ?? "").trim();
        const creatorMatches = (Array.isArray(state.personnel) ? state.personnel : []).filter((person) =>
          String(person?.username ?? "").trim() === creatorUsername
        );
        if (creatorMatches.length !== 1 || isPersonnelResigned(creatorMatches[0]) ||
            !isPersonnelAccountEnabled(creatorMatches[0])) {
          const error = new Error("申请人的账号已停用、离职或身份不唯一，请驳回该申请");
          error.statusCode = 409;
          error.code = "STOCK_APPROVAL_CREATOR_INACTIVE";
          throw error;
        }
        const creator = creatorMatches[0];
        const expectedOperations = Object.values(payload.expectedOperations ?? {});
        for (const action of ["create", "update", "delete"]) {
          if (expectedOperations.includes(action) && !hasModulePermission(creator, "stockIn", action)) {
            const error = new Error("申请人的库存权限已被撤销，请驳回该申请");
            error.statusCode = 409;
            error.code = "STOCK_APPROVAL_PERMISSION_REVOKED";
            throw error;
          }
        }
        const approvalSiteId = String(approvalRequest.siteId ?? "").trim();
        if (!approvalSiteId || approvalSiteId !== String(payload.siteId ?? "").trim() ||
            (Array.isArray(state.sites) ? state.sites : []).filter((site) =>
              String(site?.id ?? "").trim() === approvalSiteId
            ).length !== 1) {
          const error = new Error("审批关联的场地已变化或不存在，请驳回后重新提交");
          error.statusCode = 409;
          error.code = "STOCK_APPROVAL_SITE_STALE";
          throw error;
        }
        const creatorVisibleSiteIds = visibleSiteIdsForAccount(creator, state);
        if (!creatorVisibleSiteIds.includes(approvalSiteId)) {
          const error = new Error("申请人已无权操作该场地，请驳回该申请");
          error.statusCode = 409;
          error.code = "STOCK_APPROVAL_SITE_REVOKED";
          throw error;
        }
        mutation = applyStockMutationToState(state, payload, resolvedBy, {
          operationLog: null,
          visibleSiteIds: creatorVisibleSiteIds,
        });
        stateAfterMutation = mutation.nextState;
      }

      const actionLabel = approvalRequest.approvalAction === "delete_stock"
        ? "库存删除"
        : approvalRequest.approvalAction === "update_stock"
          ? "库存修改"
        : approvalRequest.approvalAction === "inventory_adjustment"
          ? "盘库调整"
        : approvalRequest.approvalAction === "add_stock_to_old_batch"
          ? "超时批次入库"
          : "库存变更";
      const resolutionLabel = decision === "approved" ? "批准并执行" : "驳回";
      const operationLog = {
        id: uid("log"),
        time: resolvedAt,
        operator: resolvedBy,
        module: "库存明细",
        action: decision === "approved" ? "批准审批" : "驳回审批",
        detail: `${resolutionLabel}${approvalRequest.createdByName || approvalRequest.createdBy}提交的${actionLabel}申请${note ? `；说明：${note}` : ""}`,
      };
      const resolvedRequest = {
        ...approvalRequest,
        status: decision,
        resolvedAt,
        resolvedBy,
        resolvedByName,
        resolutionNote: note,
      };
      const ensuredNotifications = ensureApprovalNotifications(
        currentStationNotifications(stateAfterMutation),
        {
          approvalRequestId: requestId,
          approvalAction: approvalRequest.approvalAction,
          title: approvalRequest.title,
          message: approvalRequest.message,
          siteId: approvalRequest.siteId,
          createdAt: approvalRequest.createdAt,
          createdBy: approvalRequest.createdBy,
          createdByName: approvalRequest.createdByName,
          recipients: activeAdminRecipients(stateAfterMutation),
          requester: {
            username: approvalRequest.createdBy,
            name: approvalRequest.createdByName,
          },
          requesterNotificationId: uid("notice"),
        }
      );
      const resultMessage = `${actionLabel}申请已由 ${resolvedByName} ${resolutionLabel}${note ? `。说明：${note}` : "。"}`;
      const resolvedNotifications = resolveApprovalNotifications(
        ensuredNotifications.notifications,
        requestId,
        {
          resolution: decision,
          resolvedAt,
          resolvedBy,
          resolvedByName,
          resolutionNote: note,
          resultTitle: `${actionLabel}${decision === "approved" ? "已批准" : "已驳回"}`,
          resultMessage,
        }
      );
      const nextState = {
        ...stateAfterMutation,
        approvalRequests: requests.map((request) => request === approvalRequest ? resolvedRequest : request),
        notifications: resolvedNotifications.notifications,
        operationLogs: pushOperationLog(stateAfterMutation.operationLogs, operationLog),
      };
      await client.query(
        "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
        [stateId, JSON.stringify(nextState)]
      );
      await client.query("COMMIT");
      const mutationDelta = mutation
        ? {
            stockUpserts: mutation.stockUpdates,
            stockDeleteIds: mutation.deleteIds,
            batchUpdates: mutation.batchUpdates,
            orderUpdates: mutation.orderUpdates,
            shipmentUpdates: mutation.shipmentUpdates,
          }
        : null;
      sendJson(req, res, 200, {
        ok: true,
        decision,
        message: resultMessage,
        mutation: mutationDelta,
        ...stationNotificationPayloadForAuth(nextState, req, 500),
        ...(!compactResponse && mutation ? {
          stock: mutation.stock,
          batches: mutation.batches,
          orders: mutation.orders,
          shipments: mutation.shipments,
        } : {}),
        operationLog,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      sendJson(req, res, Number(error?.statusCode ?? 400), {
        ok: false,
        ...(error?.code ? { code: error.code } : {}),
        error: error.message || "库存审批处理失败",
      });
    } finally {
      client.release();
    }
    return;
  }

			  if (url.pathname === "/api/stock/save" && req.method === "POST") {
			    try {
			      const rawChange = JSON.parse(await readBody(req) || "{}");
		      if (!rawChange?.expectedOperations || typeof rawChange.expectedOperations !== "object" ||
		          Array.isArray(rawChange.expectedOperations) ||
		          !rawChange?.expectedBefore || typeof rawChange.expectedBefore !== "object" ||
		          Array.isArray(rawChange.expectedBefore)) {
		        const error = new Error("页面版本已更新，请刷新页面后重新操作库存");
		        error.statusCode = 409;
		        error.code = "CLIENT_REFRESH_REQUIRED";
		        throw error;
		      }
		      const rawUpsert = Array.isArray(rawChange?.upsert) ? rawChange.upsert : [];
		      const rawDeleteIds = Array.isArray(rawChange?.deleteIds) ? rawChange.deleteIds : [];
	      const adjustmentContext = rawChange?.adjustmentContext?.kind === "inventory_adjustment"
	        ? {
	            kind: "inventory_adjustment",
	            draftId: String(rawChange.adjustmentContext?.draftId ?? "").trim(),
	            siteId: normalizeSiteId(rawChange.adjustmentContext?.siteId),
	            hasExactSelection: Array.isArray(rawChange.adjustmentContext?.removeStockIds) ||
	              Array.isArray(rawChange.adjustmentContext?.additionStockIds),
	            removeStockIds: [...new Set((Array.isArray(rawChange.adjustmentContext?.removeStockIds)
	              ? rawChange.adjustmentContext.removeStockIds
	              : []).map((id) => String(id ?? "").trim()).filter(Boolean))],
	            additionStockIds: [...new Set((Array.isArray(rawChange.adjustmentContext?.additionStockIds)
	              ? rawChange.adjustmentContext.additionStockIds
	              : []).map((id) => String(id ?? "").trim()).filter(Boolean))],
	            lines: (Array.isArray(rawChange.adjustmentContext?.lines) ? rawChange.adjustmentContext.lines : [])
	              .slice(0, 500)
		              .map((line) => ({
		                subTankId: String(line?.subTankId ?? "").trim(),
		                productId: String(line?.productId ?? "").trim(),
		                batchId: String(line?.batchId ?? "").trim(),
		                direction: line?.direction === "remove" ? "remove" : "add",
		                quantity: Number(line?.quantity ?? 0),
		              }))
		              .filter((line) => line.subTankId && line.productId && line.batchId && Number.isInteger(line.quantity) && line.quantity > 0),
		          }
		        : null;
	      const operator = authenticatedOperator(req);
	      if (rawUpsert.length === 0 && rawDeleteIds.length === 0) {
	        sendJson(req, res, 400, { error: "No stock changes provided" });
	        return;
	      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
	        const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
	        const state = normalizePickupShipmentsForState(rows[0]?.data ?? {});
	        const stock = Array.isArray(state.stock) ? state.stock : [];
	        if (rawUpsert.some((item) => !String(item?.id ?? "").trim())) {
	          const error = new Error("库存记录必须包含明确且非空的编号");
	          error.statusCode = 400;
	          error.code = "STOCK_ID_REQUIRED";
	          throw error;
	        }
	        if (rawUpsert.some((item) => !String(item?.siteId ?? "").trim())) {
	          const error = new Error("库存记录必须明确选择场地");
	          error.statusCode = 400;
	          error.code = "STOCK_SITE_REQUIRED";
	          throw error;
	        }
	        const existingIds = new Set(stock.map((item) => String(item?.id ?? "").trim()).filter(Boolean));
	        const rawUpsertIds = rawUpsert.map((item) => String(item?.id ?? "").trim()).filter(Boolean);
	        if (adjustmentContext?.hasExactSelection) {
	          if (!adjustmentContext.siteId || adjustmentContext.siteId === ALL_SITE_ID) {
	            throw new Error("盘库调整必须选择具体场地");
	          }
	          if (!visibleSiteIdsForAccount(req.auth?.account, state).includes(adjustmentContext.siteId)) {
	            throw new Error("无权调整该场地库存");
	          }
	          const rawRemovalIds = rawDeleteIds.map((id) => String(id ?? "").trim()).filter(Boolean);
	          if (rawRemovalIds.length !== new Set(rawRemovalIds).size) {
	            throw new Error("盘库减少项存在重复库存，请刷新后重试");
	          }
	          const sameIds = (left, right) => stableJson([...left].sort()) === stableJson([...right].sort());
	          if (!sameIds(rawRemovalIds, adjustmentContext.removeStockIds)) {
	            throw new Error("盘库减少明细与提交内容不一致，请刷新后重试");
	          }
	          if (rawUpsertIds.length !== rawUpsert.length ||
	              rawUpsertIds.length !== new Set(rawUpsertIds).size ||
	              !sameIds(rawUpsertIds, adjustmentContext.additionStockIds)) {
	            throw new Error("盘库增加明细与提交内容不一致，请刷新后重试");
	          }
	          if (rawUpsertIds.some((id) => existingIds.has(id))) {
	            throw new Error("盘库增加项不能修改已有库存，请刷新后重试");
	          }
	          const stockById = new Map(stock.map((item) => [String(item?.id ?? ""), item]));
	          const invalidRemoval = rawRemovalIds.find((id) => {
	            const item = stockById.get(id);
	            return !item || item?.lost || !matchesSite(item, adjustmentContext.siteId);
	          });
	          if (invalidRemoval) throw new Error("所选减少库存已变化，请重新打开盘库工作台核对");
	          const productIds = new Set((Array.isArray(state.products) ? state.products : [])
	            .map((product) => String(product?.id ?? "")).filter(Boolean));
	          const batchIds = new Set((Array.isArray(state.batches) ? state.batches : [])
	            .filter((batch) => matchesSite(batch, adjustmentContext.siteId))
	            .map((batch) => String(batch?.id ?? "")).filter(Boolean));
	          const tankIds = new Set((Array.isArray(state.tankGroups) ? state.tankGroups : [])
	            .filter((group) => matchesSite(group, adjustmentContext.siteId))
	            .flatMap((group) => Array.isArray(group?.subTanks) ? group.subTanks : [])
	            .map((tank) => String(tank?.id ?? "")).filter(Boolean));
	          const invalidAddition = rawUpsert.find((item) =>
	            !matchesSite(item, adjustmentContext.siteId) ||
	            !productIds.has(String(item?.productId ?? "")) ||
	            !batchIds.has(String(item?.batchId ?? "")) ||
	            !tankIds.has(String(item?.subTankId ?? ""))
	          );
	          if (invalidAddition) throw new Error("盘库增加项中的场地、缸位、商品或批次已变化，请重新核对");
	        }
	        const hasCreates = rawUpsert.some((item) => {
	          const requestedId = String(item?.id ?? "").trim();
	          return !requestedId || !existingIds.has(requestedId);
	        });
	        const hasUpdates = rawUpsertIds.some((id) => existingIds.has(id));
	        if (rawDeleteIds.length > 0) requireModulePermissionForAuth(req, "stockIn", "delete");
	        if (hasCreates) requireModulePermissionForAuth(req, "stockIn", "create");
	        if (hasUpdates) requireModulePermissionForAuth(req, "stockIn", "update");

	        const externalizedChange = await externalizeDataUrls(rawChange);
	        assertStockMutationExpectation(state, externalizedChange);
	        const mutationVisibleSiteIds = visibleSiteIdsForAccount(req.auth?.account, state);
	        const candidateMutation = applyStockMutationToState(state, externalizedChange, operator, {
            operationLog: null,
            visibleSiteIds: mutationVisibleSiteIds,
          });
	        const effectiveChange = filterEffectiveStockMutation({
	          stock: state.stock,
	          upsertItems: candidateMutation.upsertItems,
	          deleteIds: candidateMutation.deleteIds,
	        });
	        if (effectiveChange.upsertItems.length === 0 && effectiveChange.deleteIds.length === 0) {
	          const error = new Error("库存内容没有发生变化，无需保存或提交审批");
	          error.statusCode = 409;
	          error.code = "NO_STOCK_CHANGES";
	          throw error;
	        }
	        const mutation = effectiveChange.upsertItems.length === candidateMutation.upsertItems.length
	          ? candidateMutation
	          : applyStockMutationToState(state, {
	              upsert: effectiveChange.upsertItems,
	              deleteIds: effectiveChange.deleteIds,
	            }, operator, {
	              operationLog: null,
	              visibleSiteIds: mutationVisibleSiteIds,
	            });
	        const approvalPlan = stockApprovalPlan(state, mutation, req, adjustmentContext);
		        if (approvalPlan) {
	          const recipients = activeAdminRecipients(state);
	          if (recipients.length === 0) throw new Error("当前没有可处理审批的在职管理员");
		          const requests = currentApprovalRequests(state);
		          const duplicateRequest = adjustmentContext ? requests.find((request) => {
		            const submittedAt = Date.parse(String(request?.createdAt ?? ""));
		            return String(request?.requestKey ?? "") === approvalPlan.requestKey &&
		              String(request?.createdBy ?? "") === operator &&
		              Number.isFinite(submittedAt) &&
		              Date.now() - submittedAt <= STOCK_DUPLICATE_CONFIRMATION_WINDOW_MS;
		          }) : null;
		          if (duplicateRequest && rawChange.confirmDuplicate !== true) {
		            await client.query("ROLLBACK");
		            sendJson(req, res, 409, {
		              ok: false,
		              duplicateConfirmationRequired: true,
		              duplicate: {
		                requestId: String(duplicateRequest.id ?? ""),
		                createdAt: String(duplicateRequest.createdAt ?? ""),
		                status: String(duplicateRequest.status ?? "pending"),
		                title: String(duplicateRequest.title ?? approvalPlan.title),
		              },
		              error: "短时间内已提交过相同的库存调整，请确认是否继续",
		            });
		            return;
		          }
		          const existingRequest = requests.find((request) =>
	            request?.status === "pending" &&
	            String(request?.requestKey ?? "") === approvalPlan.requestKey &&
	            String(request?.createdBy ?? "") === operator
	          );
	          const createdAt = new Date().toISOString();
	          const approvalRequest = existingRequest
	            ? {
	                ...existingRequest,
	                stockDetails: existingRequest.stockDetails ?? approvalPlan.stockDetails,
	              }
	            : {
	                id: uid("approval"),
	                type: "stock_change",
	                status: "pending",
	                approvalAction: approvalPlan.approvalAction,
	                title: approvalPlan.title,
	                message: approvalPlan.message,
	                siteId: approvalPlan.siteId,
	                requestKey: approvalPlan.requestKey,
		                payload: approvalPlan.payload,
		                stockDetails: approvalPlan.stockDetails,
		                adjustmentContext,
	                createdAt,
	                createdBy: operator,
	                createdByName: authenticatedOperatorName(req),
	              };
	          const ensured = ensureApprovalNotifications(currentStationNotifications(state), {
	            approvalRequestId: approvalRequest.id,
	            approvalAction: approvalRequest.approvalAction,
	            title: approvalRequest.title,
	            message: approvalRequest.message,
	            siteId: approvalRequest.siteId,
	            createdAt: approvalRequest.createdAt,
	            createdBy: approvalRequest.createdBy,
	            createdByName: approvalRequest.createdByName,
		            recipients,
		            notificationIds: recipients.map(() => uid("notice")),
		            requester: {
		              username: approvalRequest.createdBy,
		              name: approvalRequest.createdByName,
		            },
		            requesterNotificationId: uid("notice"),
		          });
	          const operationLog = existingRequest
	            ? null
	            : {
	                id: uid("log"),
	                time: createdAt,
	                operator,
	                module: "库存明细",
	                action: "提交审批",
	                detail: approvalPlan.message,
	              };
	          const nextRequests = existingRequest
	            ? requests.map((request) => request === existingRequest ? approvalRequest : request)
	            : [approvalRequest, ...requests].slice(0, 2000);
	          const nextState = {
	            ...state,
	            approvalRequests: nextRequests,
		            notifications: ensured.notifications,
		            inventoryAdjustmentDrafts: adjustmentContext?.draftId
		              ? clearInventoryAdjustmentDraft(state, operator, adjustmentContext.draftId)
		              : currentInventoryAdjustmentDrafts(state),
	            operationLogs: operationLog
	              ? pushOperationLog(state.operationLogs, operationLog)
	              : state.operationLogs,
	          };
	          await client.query(
	            "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
	            [stateId, JSON.stringify(nextState)]
	          );
	          await client.query("COMMIT");
	          sendJson(req, res, 200, {
	            ok: true,
	            pendingApproval: true,
	            approvalRequestId: approvalRequest.id,
	            message: approvalPlan.responseMessage,
	            operationLog,
	          });
	          return;
	        }

		        const directAdjustmentDetails = adjustmentContext
		          ? buildStockChangeSnapshot({
		              upsertItems: mutation.upsertItems,
		              deleteIds: mutation.deleteIds,
		              stock: state.stock,
		              products: state.products,
		              species: state.species,
		              batches: state.batches,
		              tankGroups: state.tankGroups,
		              orders: state.orders,
		            })
		          : null;
		        const operationLog = {
		          id: uid("log"),
		          time: new Date().toISOString(),
		          operator,
		          module: "库存明细",
		          action: adjustmentContext ? "盘库调整" : mutation.defaultAction,
		          detail: directAdjustmentDetails
		            ? `统一调整 ${directAdjustmentDetails.tanks.length} 个缸位，增加 ${directAdjustmentDetails.totals.addCount} 条，减少 ${directAdjustmentDetails.totals.removeCount} 条`
		            : mutation.defaultDetail,
		        };
		        const nextState = {
		          ...mutation.nextState,
		          inventoryAdjustmentDrafts: adjustmentContext?.draftId
		            ? clearInventoryAdjustmentDraft(state, operator, adjustmentContext.draftId)
		            : currentInventoryAdjustmentDrafts(state),
	          operationLogs: pushOperationLog(state.operationLogs, operationLog),
	        };
        await client.query(
          "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
          [stateId, JSON.stringify(nextState)]
        );
        await client.query("COMMIT");
        const visibleNextState = siteVisibilityFilteredState(nextState, req.auth?.account);
        const visibleOrderIds = new Set((Array.isArray(visibleNextState.orders) ? visibleNextState.orders : [])
          .map((order) => String(order?.id ?? "")));
        const visibleShipmentIds = new Set((Array.isArray(visibleNextState.shipments) ? visibleNextState.shipments : [])
          .map((shipment) => String(shipment?.id ?? "")));
        const visibleOrderUpdates = mutation.orderUpdates
          .filter((order) => visibleOrderIds.has(String(order?.id ?? "")));
        const visibleShipmentUpdates = mutation.shipmentUpdates
          .filter((shipment) => visibleShipmentIds.has(String(shipment?.id ?? "")));
        sendJson(req, res, 200, {
          ok: true,
          stock: visibleNextState.stock,
          batches: visibleNextState.batches,
          orderUpdates: visibleOrderUpdates,
          shipmentUpdates: visibleShipmentUpdates,
          affectedOrderCount: visibleOrderUpdates.length,
          operationLog,
        });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
	      sendJson(req, res, Number(error?.statusCode ?? 400), {
	        ...(error?.code ? { code: error.code } : {}),
	        error: error.message,
	      });
	    }
	    return;
	  }

		  if (url.pathname === "/api/maintenance/save" && req.method === "POST") {
		    try {
			      const body = await readBody(req, 4 * 1024 * 1024);
			      const rawChange = JSON.parse(body);
			      const rawMode = String(rawChange?.mode ?? "");
			      for (const permission of maintenanceRequiredPermissions(rawMode)) {
			        requireModulePermissionForAuth(req, permission.module, permission.action);
			      }
			      normalizeMaintenanceClientMutationId(rawChange?.clientMutationId);
			      const externalizedChange = await externalizeDataUrls(rawChange);
			      const preparedMutation = prepareMaintenanceMutation(externalizedChange);
		      const {
		        mode,
	        itemIds = [],
	        expectedItems = [],
	        targetSubTankId,
	        targetStatus,
	        moveDate,
	        moveNotes = "",
	        recordDate,
	        recordText = "",
	        recordPhotos = [],
	        recordVideos = [],
	        lossDate,
	        lossReason = "",
	        lossProof = [],
		      } = preparedMutation.change;
	      const operator = authenticatedOperator(req);

	      const client = await pool.connect();
	      try {
	        const responseBody = await withMaintenanceTransaction(client, async () => {
	        const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
	        const state = rows[0]?.data ?? {};
	        const stock = Array.isArray(state.stock) ? state.stock : [];
	        const bioRecords = Array.isArray(state.bioRecords) ? state.bioRecords : [];
	        const lossRecords = Array.isArray(state.lossRecords) ? state.lossRecords : [];
		        const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
		        const visibleSiteIds = visibleSiteIdsForAccount(req.auth?.account, state);
		        const canAccessSite = (siteId) => canAccessBioStockSite({
		          account: req.auth?.account,
		          visibleSiteIds,
		          stockSiteId: normalizeSiteId(siteId),
		        });
		        const stockSiteId = (item) => normalizeSiteId(
		          findSubTank(state, item?.subTankId)?.group?.siteId ?? item?.siteId
		        );
		        const requireVisibleStockItems = (items) => {
		          if ((Array.isArray(items) ? items : []).every((item) => canAccessSite(stockSiteId(item)))) return;
		          const error = new Error("不能操作未授权场地的库存鱼");
		          error.statusCode = 403;
		          throw error;
		        };
		        const requestedIdSet = new Set(itemIds.map((id) => String(id)));
		        const requestedItems = stock.filter((item) => requestedIdSet.has(String(item?.id ?? "")));
		        if (requestedItems.length !== requestedIdSet.size) {
		          const error = new Error("部分库存鱼不存在或已被删除，请刷新后重试");
		          error.statusCode = mode === "record" ? 400 : 409;
		          error.code = mode === "record" ? "MAINTENANCE_ITEM_NOT_FOUND" : "MAINTENANCE_STALE";
		          throw error;
		        }
		        requireVisibleStockItems(requestedItems);

		        // The row lock serializes concurrent double-clicks. Idempotency is
		        // checked before CAS because an exact retry necessarily observes the
		        // state already changed by its first committed attempt.
		        const priorMutation = findMaintenanceMutationLog({
		          operationLogs,
		          operator,
		          clientMutationId: preparedMutation.clientMutationId,
		          digest: preparedMutation.digest,
		        });
		        if (priorMutation) {
		          const priorDelta = resolveMaintenanceDeltaByIds(state, priorMutation.deltaIds);
		          return {
		            ok: true,
		            idempotent: true,
		            ...priorDelta,
		            operationLog: priorMutation.operationLog,
		          };
		        }

		        assertMaintenanceExpectedItems({
		          mode,
		          itemIds,
		          expectedItems,
		          currentItems: stock,
		        });
		        let nextStock = stock;
		        let nextBioRecords = bioRecords;
		        let nextLossRecords = lossRecords;
		        let nextBatches = state.batches;
		        let operationLog;
		        let stockUpdates = [];
		        let batchUpdates = [];
		        let bioRecordUpdates = [];
		        let lossRecordUpdates = [];

	        if (mode === "record") {
	          const requestedIds = Array.isArray(itemIds) ? itemIds.map((id) => String(id)) : [];
	          const idSet = new Set(requestedIds);
	          if (idSet.size === 0) throw new Error("请选择要维护记录的鱼");
		          const targetItems = stock.filter((item) => idSet.has(String(item.id)));
		          if (targetItems.length !== idSet.size) throw new Error("部分库存鱼不存在或已被删除");
		          requireVisibleStockItems(targetItems);
	          const shippedIds = shippedOutStockIds(state);
	          const invalidItem = targetItems.find((item) => !isPhysicallyInTank(item, shippedIds));
	          if (invalidItem) throw new Error("已损耗或已发货的鱼不能添加维护记录");
	          const date = normalizeLocalDateTime(recordDate);
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
		            siteId: stockSiteId(item),
	            stockItemId: item.id,
	            date,
	            text,
	            photos,
	            videos,
	            sourceType: "manual",
	            operator,
	          }));
		          nextBioRecords = [...bioRecords, ...records];
		          bioRecordUpdates = records;
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
		          if (!canAccessSite(targetSiteId)) {
		            const error = new Error("不能移入未授权场地的缸位");
		            error.statusCode = 403;
		            throw error;
		          }
	          const targetName = subTankDisplayName(state, targetId);
	          const requestedIds = Array.isArray(itemIds) ? itemIds.map((id) => String(id)) : [];
	          const idSet = new Set(requestedIds);
	          if (idSet.size === 0) throw new Error("请选择要移缸的鱼");
	          const shippedIds = shippedOutStockIds(state);
		          const movingItems = stock.filter((item) => idSet.has(item.id));
		          if (movingItems.length !== idSet.size) throw new Error("部分库存鱼不存在或已被删除");
		          requireVisibleStockItems(movingItems);
	          const invalidItem = movingItems.find((item) => !isPhysicallyInTank(item, shippedIds));
	          if (invalidItem) throw new Error("已损耗或已发货的鱼不能移缸");
	          if (movingItems.every((item) => item.subTankId === targetId)) throw new Error("目标子缸与当前子缸相同");
	          const notes = String(moveNotes ?? "").trim();
	          const date = String(moveDate || todayInChina()).trim();
	          const moveRecords = movingItems.map((item) => ({
	            id: uid("bio"),
	            siteId: targetSiteId,
	            stockItemId: item.id,
	            date,
		            text: `移缸：${subTankDisplayName(state, item.subTankId)} → ${targetName}${notes ? `。备注：${notes}` : ""}`,
		            photos: [],
		            videos: [],
		            sourceType: "manual",
		            operator,
	          }));
	          nextStock = stock.map((item) =>
	            idSet.has(item.id) ? { ...item, siteId: targetSiteId, subTankId: targetId } : item
	          );
		          nextBioRecords = [...bioRecords, ...moveRecords];
		          stockUpdates = nextStock.filter((item) => idSet.has(String(item.id)));
		          bioRecordUpdates = moveRecords;
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "日常管理",
	            action: "修改记录",
	            detail: `移缸 ${movingItems.length} 条至「${targetName}」`,
	          };
	        } else if (mode === "status") {
	          const requestedIds = Array.isArray(itemIds) ? itemIds.map((id) => String(id)) : [];
	          const idSet = new Set(requestedIds);
	          if (idSet.size === 0) throw new Error("请选择要设置状态的鱼");
		          const targetItems = stock.filter((item) => idSet.has(String(item.id)));
		          if (targetItems.length !== idSet.size) throw new Error("部分库存鱼不存在或已被删除");
		          requireVisibleStockItems(targetItems);
	          const shippedIds = shippedOutStockIds(state);
	          const invalidItem = targetItems.find((item) => !isPhysicallyInTank(item, shippedIds));
	          if (invalidItem) throw new Error("已损耗或已发货的鱼不能设置状态");
	          const nextStatus = String(targetStatus ?? "").trim();
	          const statusLabels = { healthy: "正常", feeding: "开口", sick: "疾病" };
	          if (!Object.prototype.hasOwnProperty.call(statusLabels, nextStatus)) throw new Error("请选择目标状态");
	          const changedItems = targetItems.filter((item) => item.status !== nextStatus);
	          if (changedItems.length === 0) throw new Error(`所选鱼已经全部是${statusLabels[nextStatus]}状态`);
	          const date = todayInChina();
	          const statusRecords = changedItems.map((item) => ({
	            id: uid("bio"),
		            siteId: stockSiteId(item),
	            stockItemId: item.id,
	            date,
	            text: `状态调整：${statusLabels[item.status] ?? item.status ?? "未知"} → ${statusLabels[nextStatus]}`,
	            photos: [],
	            videos: [],
	            sourceType: "manual",
	            operator,
	          }));
	          nextStock = stock.map((item) =>
	            idSet.has(String(item.id)) ? { ...item, status: nextStatus } : item
	          );
		          nextBioRecords = [...bioRecords, ...statusRecords];
		          const changedIdSet = new Set(changedItems.map((item) => String(item.id)));
		          stockUpdates = nextStock.filter((item) => changedIdSet.has(String(item.id)));
		          bioRecordUpdates = statusRecords;
	          operationLog = {
	            id: uid("log"),
	            time: new Date().toISOString(),
	            operator,
	            module: "日常管理",
	            action: "修改记录",
	            detail: `批量设置状态 ${targetItems.length} 条为「${statusLabels[nextStatus]}」`,
	          };
	        } else if (mode === "loss") {
	          const requestedLossIds = itemIds.map((id) => String(id));
	          const idSet = new Set(requestedLossIds);
	          if (idSet.size === 0) throw new Error("请选择要损耗的鱼");
		          const losingItems = stock.filter((item) => idSet.has(String(item.id)));
		          if (losingItems.length !== idSet.size) throw new Error("部分库存鱼不存在或已被删除");
		          requireVisibleStockItems(losingItems);
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
		            return { id: uid("bio"), siteId: stockSiteId(item), stockItemId: item.id, date, text, photos: proof, videos: [], sourceType: "manual", operator };
	          });
	          const lossRecordRows = losingItems.map((item) => {
	            const sourceTank = findSubTank(state, item.subTankId);
	            const sourceTankName = sourceTank
	              ? `${sourceTank.group.name} / ${sourceTank.subTank.name}`
	              : `已删除缸位（${item.subTankId || "无缸位ID"}）`;
	            return {
	              id: uid("loss"),
		              siteId: stockSiteId(item),
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
		          stockUpdates = nextStock.filter((item) => idSet.has(String(item.id)));
		          const affectedBatchIds = new Set(losingItems.map((item) => String(item.batchId ?? "")));
		          batchUpdates = (Array.isArray(nextBatches) ? nextBatches : [])
		            .filter((batch) => affectedBatchIds.has(String(batch?.id ?? "")));
		          bioRecordUpdates = lossBioRecords;
		          lossRecordUpdates = lossRecordRows;
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

		        operationLog = withMaintenanceMutationMetadata(operationLog, {
		          clientMutationId: preparedMutation.clientMutationId,
		          digest: preparedMutation.digest,
		          delta: {
		            stockUpdates,
		            batchUpdates,
		            bioRecordUpdates,
		            lossRecordUpdates,
		          },
		        });
		        const nextOperationLogs = pushOperationLog(operationLogs, operationLog);
		        let dataExpression = "data";
		        const updateValues = [stateId];
		        const setJsonKey = (key, value) => {
		          updateValues.push(JSON.stringify(value));
		          dataExpression = `jsonb_set(${dataExpression}, '{${key}}', $${updateValues.length}::jsonb, true)`;
		        };
		        if (stockUpdates.length > 0) setJsonKey("stock", nextStock);
		        if (batchUpdates.length > 0) setJsonKey("batches", nextBatches);
		        if (bioRecordUpdates.length > 0) setJsonKey("bioRecords", nextBioRecords);
		        if (lossRecordUpdates.length > 0) setJsonKey("lossRecords", nextLossRecords);
		        setJsonKey("operationLogs", nextOperationLogs);
		        await client.query(
		          `UPDATE app_state
		           SET data = ${dataExpression}, updated_at = now()
		           WHERE id = $1`,
		          updateValues
		        );
		        return {
		          ok: true,
		          idempotent: false,
		          stockUpdates,
		          batchUpdates,
		          bioRecordUpdates,
		          lossRecordUpdates,
		          operationLog,
		        };
	        });
	        sendJson(req, res, 200, responseBody);
	      } finally {
	        client.release();
	      }
		    } catch (error) {
		      sendJson(req, res, Number(error?.statusCode ?? 400), {
		        ok: false,
		        code: String(error?.code ?? "MAINTENANCE_SAVE_FAILED"),
		        error: `Failed to save maintenance action: ${error.message}`,
		      });
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
        const client = await pool.connect();
        try {
          const rawChange = await externalizeDataUrls(JSON.parse(await readBody(req) || "{}"));
          const preparedChange = rawChange?.log && typeof rawChange.log === "object"
            ? { ...rawChange, log: { ...rawChange.log, id: String(rawChange.log.id ?? "").trim() || uid("daily") } }
            : rawChange;
          const targetId = String(preparedChange?.deleteId ?? preparedChange?.log?.id ?? "").trim();
          if (!targetId) throw new Error("缺少养护日志编号");

          await client.query("BEGIN");
          const { rows } = await client.query(
            `SELECT
               data -> 'sites' AS sites,
               data -> 'tankGroups' AS tank_groups,
               COALESCE((
                 SELECT jsonb_agg(log_row.log_item ORDER BY log_row.ordinality)
                 FROM jsonb_array_elements(COALESCE(app_state.data -> 'logs', '[]'::jsonb))
                   WITH ORDINALITY AS log_row(log_item, ordinality)
                 WHERE btrim(COALESCE(log_row.log_item ->> 'id', '')) = $2
               ), '[]'::jsonb) AS matching_logs
             FROM app_state
             WHERE id = $1
             FOR UPDATE`,
            [stateId, targetId]
          );
          const projectedState = {
            sites: Array.isArray(rows[0]?.sites) ? rows[0].sites : [],
            tankGroups: Array.isArray(rows[0]?.tank_groups) ? rows[0].tank_groups : [],
          };
          const plan = planDailyLogSave({
            change: preparedChange,
            matchingLogs: Array.isArray(rows[0]?.matching_logs) ? rows[0].matching_logs : [],
            tankGroups: projectedState.tankGroups,
            operator: authenticatedOperator(req),
            now: nowDatetimeInChina(),
          });
          requireModulePermissionForAuth(req, "daily", plan.mode === "delete" ? "delete" : plan.mode === "update" ? "update" : "create");
          if (plan.current) {
            requireVisibleSiteForAuth(req, projectedState, plan.currentSiteId, "不能修改未授权场地的养护日志");
          }
          requireVisibleSiteForAuth(req, projectedState, plan.siteId, "不能修改未授权场地的养护日志");
          if (plan.mode === "update" && plan.currentSiteId !== plan.siteId) {
            const error = new Error("不能通过修改养护日志变更所属场地");
            error.statusCode = 409;
            error.code = "DAILY_LOG_SITE_CHANGE_FORBIDDEN";
            throw error;
          }

          const currentGroupId = plan.current ? dailyLogGroupId(projectedState, plan.current) : "";
          const groupChanged = Boolean(plan.current && currentGroupId !== String(plan.log?.tankGroupId ?? ""));
          const preserveSyncedStockIds = Boolean(
            plan.mode === "update" && !groupChanged && Array.isArray(plan.current?.syncedStockItemIds)
          );
          const preservedStockIds = preserveSyncedStockIds
            ? plan.current.syncedStockItemIds.map((id) => String(id ?? "").trim()).filter(Boolean)
            : [];
          const targetGroup = plan.log
            ? projectedState.tankGroups.find((group) => String(group?.id ?? "").trim() === String(plan.log.tankGroupId ?? "").trim())
            : null;
          const targetSubTankIds = Array.isArray(targetGroup?.subTanks)
            ? targetGroup.subTanks.map((tank) => String(tank?.id ?? "").trim()).filter(Boolean)
            : [];
          if (plan.log) {
            const targetSubTankIdSet = new Set(targetSubTankIds);
            const ambiguousTargetSubTank = targetSubTankIds.some((subTankId) => {
              let matches = 0;
              for (const group of projectedState.tankGroups) {
                matches += (Array.isArray(group?.subTanks) ? group.subTanks : [])
                  .filter((tank) => String(tank?.id ?? "").trim() === subTankId)
                  .length;
              }
              return matches !== 1;
            });
            if (targetSubTankIdSet.size !== targetSubTankIds.length || ambiguousTargetSubTank) {
              const error = new Error("缸位 ID 不唯一，无法安全同步养护日志");
              error.statusCode = 409;
              error.code = "DAILY_LOG_SYNC_ID_CONFLICT";
              throw error;
            }
          }
          const { rows: syncRows } = await client.query(
            `WITH outbound_stock_ids AS MATERIALIZED (
               SELECT DISTINCT btrim(stock_id.value) AS stock_id
               FROM app_state source,
                    jsonb_array_elements(COALESCE(source.data -> 'shipments', '[]'::jsonb)) AS shipment(item),
                    jsonb_array_elements_text(COALESCE(shipment.item -> 'itemStockIds', '[]'::jsonb)) AS stock_id(value)
               WHERE source.id = $1
                 AND COALESCE(shipment.item ->> 'status', '') <> 'preparing'
                 AND btrim(stock_id.value) <> ''
               UNION
               SELECT DISTINCT btrim(order_item.item ->> 'stockItemId') AS stock_id
               FROM app_state source,
                    jsonb_array_elements(COALESCE(source.data -> 'orders', '[]'::jsonb)) AS order_row(item),
                    jsonb_array_elements(COALESCE(order_row.item -> 'items', '[]'::jsonb)) AS order_item(item)
               WHERE source.id = $1
                 AND COALESCE(order_row.item ->> 'status', '') = 'completed'
                 AND btrim(COALESCE(order_item.item ->> 'inventoryRemovedAt', '')) = ''
                 AND btrim(COALESCE(order_item.item ->> 'stockItemId', '')) <> ''
             )
             SELECT
               COALESCE((
                 SELECT jsonb_agg(stock_row.item ORDER BY stock_row.ordinality)
                 FROM app_state source,
                      jsonb_array_elements(COALESCE(source.data -> 'stock', '[]'::jsonb))
                        WITH ORDINALITY AS stock_row(item, ordinality)
                 WHERE source.id = $1
                   AND (
                     ($3::boolean AND btrim(COALESCE(stock_row.item ->> 'id', '')) = ANY($4::text[]))
                     OR
                     (NOT $3::boolean
                       AND btrim(COALESCE(stock_row.item ->> 'subTankId', '')) = ANY($5::text[])
                       AND lower(COALESCE(stock_row.item ->> 'lost', 'false')) <> 'true'
                       AND NOT EXISTS (
                         SELECT 1 FROM outbound_stock_ids outbound
                         WHERE outbound.stock_id = btrim(COALESCE(stock_row.item ->> 'id', ''))
                       )
                     )
                   )
               ), '[]'::jsonb) AS target_stock,
               COALESCE((
                 SELECT jsonb_agg(bio_row.item ORDER BY bio_row.ordinality)
                 FROM app_state source,
                      jsonb_array_elements(COALESCE(source.data -> 'bioRecords', '[]'::jsonb))
                        WITH ORDINALITY AS bio_row(item, ordinality)
                 WHERE source.id = $1
                   AND COALESCE(bio_row.item ->> 'sourceType', '') = 'dailyLog'
                   AND btrim(COALESCE(bio_row.item ->> 'sourceLogId', '')) = $2
               ), '[]'::jsonb) AS existing_bio_records`,
            [stateId, targetId, preserveSyncedStockIds, preservedStockIds, targetSubTankIds]
          );
          const targetStock = Array.isArray(syncRows[0]?.target_stock) ? syncRows[0].target_stock : [];
          const existingBioRecords = Array.isArray(syncRows[0]?.existing_bio_records) ? syncRows[0].existing_bio_records : [];
          const existingBioByStockId = new Map(existingBioRecords.map((record) => [String(record?.stockItemId ?? ""), record]));
          const bioRecordUpdates = plan.log
            ? targetStock.map((item) => syncedDailyLogRecord(
                { ...projectedState, stock: targetStock },
                plan.log,
                item,
                existingBioByStockId.get(String(item?.id ?? "")) ?? null,
                groupChanged
              ))
            : [];
          const deletedBioRecordIds = existingBioRecords
            .map((record) => String(record?.id ?? "").trim())
            .filter(Boolean);
          const storedLog = plan.log
            ? {
                ...plan.log,
                syncedStockItemIds: targetStock.map((item) => String(item?.id ?? "").trim()).filter(Boolean),
                syncedAt: new Date().toISOString(),
              }
            : null;
          const checkedStockIds = targetStock.map((item) => String(item?.id ?? "").trim()).filter(Boolean);
          const checkedBioIds = [...new Set([
            ...existingBioRecords.map((record) => String(record?.id ?? "").trim()),
            ...bioRecordUpdates.map((record) => String(record?.id ?? "").trim()),
          ].filter(Boolean))];
          const { rows: identityRows } = await client.query(
            `SELECT
               COALESCE((
                 SELECT jsonb_object_agg(stock_id, stock_count)
                 FROM (
                   SELECT btrim(COALESCE(stock_row.item ->> 'id', '')) AS stock_id, count(*)::int AS stock_count
                   FROM app_state source,
                        jsonb_array_elements(COALESCE(source.data -> 'stock', '[]'::jsonb)) AS stock_row(item)
                   WHERE source.id = $1
                     AND btrim(COALESCE(stock_row.item ->> 'id', '')) = ANY($2::text[])
                   GROUP BY btrim(COALESCE(stock_row.item ->> 'id', ''))
                 ) counts
               ), '{}'::jsonb) AS stock_id_counts,
               COALESCE((
                 SELECT jsonb_agg(bio_row.item)
                 FROM app_state source,
                      jsonb_array_elements(COALESCE(source.data -> 'bioRecords', '[]'::jsonb)) AS bio_row(item)
                 WHERE source.id = $1
                   AND btrim(COALESCE(bio_row.item ->> 'id', '')) = ANY($3::text[])
               ), '[]'::jsonb) AS global_bio_records`,
            [stateId, checkedStockIds, checkedBioIds]
          );
          assertDailyLogSyncIdentity({
            targetStock,
            existingBioRecords,
            bioRecordUpdates,
            globalStockIdCounts: identityRows[0]?.stock_id_counts ?? {},
            globalBioRecords: identityRows[0]?.global_bio_records ?? [],
          });

          const operationLog = {
            id: uid("log"),
            time: new Date().toISOString(),
            operator: authenticatedOperator(req),
            module: "日常管理",
            action: plan.mode === "delete" ? "删除记录" : plan.mode === "update" ? "修改记录" : "添加记录",
            detail: `${plan.operationDetail}${plan.log ? `，同步 ${bioRecordUpdates.length} 条鱼` : ""}`,
          };
          await client.query(
            `UPDATE app_state
             SET data = jsonb_set(
               jsonb_set(
                 jsonb_set(
                   data,
                   '{logs}',
                   CASE $6::text
                   WHEN 'create' THEN COALESCE(data -> 'logs', '[]'::jsonb) || jsonb_build_array($3::jsonb)
                   WHEN 'update' THEN (
                     SELECT COALESCE(jsonb_agg(
                       CASE WHEN btrim(COALESCE(log_row.log_item ->> 'id', '')) = $2 THEN $3::jsonb ELSE log_row.log_item END
                       ORDER BY log_row.ordinality
                     ), '[]'::jsonb)
                     FROM jsonb_array_elements(COALESCE(data -> 'logs', '[]'::jsonb))
                       WITH ORDINALITY AS log_row(log_item, ordinality)
                   )
                   ELSE (
                     SELECT COALESCE(jsonb_agg(log_row.log_item ORDER BY log_row.ordinality), '[]'::jsonb)
                     FROM jsonb_array_elements(COALESCE(data -> 'logs', '[]'::jsonb))
                       WITH ORDINALITY AS log_row(log_item, ordinality)
                     WHERE btrim(COALESCE(log_row.log_item ->> 'id', '')) <> $2
                   )
                   END,
                   true
                 ),
                 '{bioRecords}',
                 COALESCE((
                   SELECT jsonb_agg(bio_row.item ORDER BY bio_row.ordinality)
                   FROM jsonb_array_elements(COALESCE(data -> 'bioRecords', '[]'::jsonb))
                     WITH ORDINALITY AS bio_row(item, ordinality)
                   WHERE NOT (
                     COALESCE(bio_row.item ->> 'sourceType', '') = 'dailyLog'
                     AND btrim(COALESCE(bio_row.item ->> 'sourceLogId', '')) = $2
                   )
                 ), '[]'::jsonb) || $7::jsonb,
                 true
               ),
               '{operationLogs}',
               (
                 SELECT COALESCE(jsonb_agg(entries.entry ORDER BY entries.position), '[]'::jsonb)
                 FROM (
                   SELECT $4::jsonb AS entry, 0::bigint AS position
                   UNION ALL
                   SELECT operation_row.operation_item, operation_row.ordinality
                   FROM jsonb_array_elements(COALESCE(data -> 'operationLogs', '[]'::jsonb))
                     WITH ORDINALITY AS operation_row(operation_item, ordinality)
                   WHERE operation_row.ordinality <= $5
                 ) AS entries
               ),
               true
             ),
             updated_at = now()
             WHERE id = $1`,
            [
              stateId,
              targetId,
              JSON.stringify(storedLog),
              JSON.stringify(operationLog),
              Math.max(0, MAX_OPERATION_LOGS - 1),
              plan.mode,
              JSON.stringify(bioRecordUpdates),
            ]
          );
          await client.query("COMMIT");
          sendJson(req, res, 200, {
            ok: true,
            ...(storedLog ? { changedLog: storedLog } : {}),
            ...(plan.deletedLogId ? { deletedLogId: plan.deletedLogId } : {}),
            bioRecordUpdates,
            deletedBioRecordIds,
            operationLog,
          });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          sendJson(req, res, Number(error?.statusCode ?? 400), {
            ok: false,
            error: error.message || "养护日志保存失败",
            ...(error?.code ? { code: error.code } : {}),
          });
        } finally {
          client.release();
        }
        return;
      }

      if (url.pathname === "/api/water-quality/settings/save" && req.method === "POST") {
        const client = await pool.connect();
        try {
          requireAdminForAuth(req, "仅管理员可以修改水质参数配置");
          const body = JSON.parse(await readBody(req) || "{}");
          const parameters = validateWaterQualityParameters(body.parameters);
          const assignments = Array.isArray(body.assignments) ? body.assignments : [];
          const assignmentByGroupId = new Map(assignments.map((assignment) => [
            String(assignment?.groupId ?? "").trim(),
            [...new Set((Array.isArray(assignment?.parameterIds) ? assignment.parameterIds : []).map(String).filter(Boolean))],
          ]));
          if ([...assignmentByGroupId.keys()].some((groupId) => !groupId)) {
            throw new Error("缸组关注项配置缺少缸组编号");
          }

          await client.query("BEGIN");
          const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
          const state = rows[0]?.data ?? {};
          const tankGroups = Array.isArray(state.tankGroups) ? state.tankGroups : [];
          const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
          const previousParameters = normalizeWaterQualityParameters(state.systemSettings?.waterQualityParameters);
          const validParameterIds = new Set(parameters.map((parameter) => parameter.id));
          for (const [groupId, parameterIds] of assignmentByGroupId) {
            if (!tankGroups.some((group) => String(group?.id ?? "") === groupId)) {
              throw new Error(`缸组不存在或已被删除：${groupId}`);
            }
            const invalidIds = parameterIds.filter((id) => !validParameterIds.has(id));
            if (invalidIds.length > 0) throw new Error(`缸组关注项包含无效参数：${invalidIds.join("、")}`);
          }

          const nextTankGroups = tankGroups.map((group) => {
            const groupId = String(group?.id ?? "");
            const selectedIds = assignmentByGroupId.has(groupId)
              ? assignmentByGroupId.get(groupId)
              : waterQualityParameterIdsForGroup(group, previousParameters);
            return {
              ...group,
              waterQualityParameterIds: selectedIds.filter((id) => validParameterIds.has(id)),
            };
          });
          const nextSystemSettings = {
            ...(state.systemSettings && typeof state.systemSettings === "object" ? state.systemSettings : {}),
            waterQualityParameters: parameters,
          };
          const operationLog = {
            id: uid("log"),
            time: new Date().toISOString(),
            operator: authenticatedOperator(req),
            module: "后台管理",
            action: "修改记录",
            detail: `保存水质参数 ${parameters.length} 项，并更新 ${assignmentByGroupId.size} 个缸组的关注项`,
          };
          const nextState = {
            ...state,
            systemSettings: nextSystemSettings,
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
            systemSettings: nextSystemSettings,
            tankGroups: nextTankGroups,
            operationLog,
          });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          sendJson(req, res, 400, { error: `Failed to save water quality settings: ${error.message}` });
        } finally {
          client.release();
        }
        return;
      }

      if (url.pathname === "/api/water-quality-records/save" && req.method === "POST") {
        const client = await pool.connect();
        try {
          const body = JSON.parse(await readBody(req) || "{}");
          const inputRecord = body.record && typeof body.record === "object" ? body.record : null;
          const deleteId = String(body.deleteId ?? "").trim();
          if (!inputRecord && !deleteId) throw new Error("No water quality record change provided");

          await client.query("BEGIN");
          const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
          const state = rows[0]?.data ?? {};
          const records = Array.isArray(state.waterQualityRecords) ? state.waterQualityRecords : [];
          const tankGroups = Array.isArray(state.tankGroups) ? state.tankGroups : [];
          const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
          const visibleSiteIds = visibleSiteIdsForAccount(req.auth?.account, state);
          let nextRecords = records;
          let operationLog;

          if (deleteId) {
            requireModulePermissionForAuth(req, "daily", "delete");
            const target = records.find((record) => String(record?.id ?? "") === deleteId);
            if (!target) throw new Error("水质记录不存在或已被删除");
            const targetGroup = tankGroups.find((group) => String(group?.id ?? "") === String(target?.tankGroupId ?? ""));
            const targetSiteId = normalizeSiteId(target?.siteId ?? targetGroup?.siteId);
            if (!visibleSiteIds.includes(targetSiteId)) throw new Error("无权删除该场地的水质记录");
            nextRecords = records.filter((record) => String(record?.id ?? "") !== deleteId);
            operationLog = {
              id: uid("log"),
              time: new Date().toISOString(),
              operator: authenticatedOperator(req),
              module: "日常管理",
              action: "删除记录",
              detail: `删除水质记录（${target.measuredAt}，缸组：${targetGroup?.name ?? "已删除缸组"}/${target.tankGroupId}，${formatWaterQualityMeasurements(target.values)}）`,
            };
          } else {
            const existingRecord = records.find((record) => String(record?.id ?? "") === String(inputRecord.id ?? "")) ?? null;
            requireModulePermissionForAuth(req, "daily", existingRecord ? "update" : "create");
            if (existingRecord) {
              const existingGroup = tankGroups.find((group) => String(group?.id ?? "") === String(existingRecord.tankGroupId ?? ""));
              const existingSiteId = normalizeSiteId(existingRecord.siteId ?? existingGroup?.siteId);
              if (!visibleSiteIds.includes(existingSiteId)) throw new Error("无权修改该场地的水质记录");
              if (String(inputRecord.tankGroupId ?? "") !== String(existingRecord.tankGroupId ?? "")) {
                throw new Error("不能修改水质记录所属缸组");
              }
            }
            const tankGroup = tankGroups.find((group) => String(group?.id ?? "") === String(inputRecord.tankGroupId ?? ""));
            if (!tankGroup) throw new Error("缸组不存在或已被删除");
            const siteId = normalizeSiteId(tankGroup.siteId);
            if (!visibleSiteIds.includes(siteId)) throw new Error("无权记录该场地的水质数据");
            const parameters = normalizeWaterQualityParameters(state.systemSettings?.waterQualityParameters);
            const normalizedRecord = normalizeWaterQualityRecord(inputRecord, {
              parameters,
              group: tankGroup,
              existingRecord,
              operator: authenticatedOperator(req),
              siteId,
              createId: () => uid("water"),
            });
            nextRecords = existingRecord
              ? records.map((record) => String(record?.id ?? "") === normalizedRecord.id ? normalizedRecord : record)
              : [...records, normalizedRecord];
            operationLog = {
              id: uid("log"),
              time: new Date().toISOString(),
              operator: authenticatedOperator(req),
              module: "日常管理",
              action: existingRecord ? "修改记录" : "添加记录",
              detail: `${existingRecord ? "修改" : "新增"}水质记录（${normalizedRecord.measuredAt}，缸组：${tankGroup.name}/${tankGroup.id}，${formatWaterQualityMeasurements(normalizedRecord.values)}）`,
            };
          }

          const nextState = {
            ...state,
            waterQualityRecords: nextRecords,
            operationLogs: pushOperationLog(operationLogs, operationLog),
          };
          await client.query(
            "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
            [stateId, JSON.stringify(nextState)]
          );
          await client.query("COMMIT");
          sendJson(req, res, 200, { ok: true, waterQualityRecords: nextRecords, operationLog });
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          sendJson(req, res, 400, { error: `Failed to save water quality record: ${error.message}` });
        } finally {
          client.release();
        }
        return;
      }

	  if (url.pathname === "/api/products/delete" && req.method === "POST") {
	    const client = await pool.connect();
	    try {
	      const body = JSON.parse(await readBody(req) || "{}");
	      const productId = String(body.productId ?? "").trim();
	      if (!productId) throw new Error("请选择要删除的商品");
	      requireModulePermissionForAuth(req, "products", "delete");

	      await client.query("BEGIN");
	      const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
	      const state = rows[0]?.data ?? {};
	      const products = (Array.isArray(state.products) ? state.products : [])
	        .map(withoutLegacyProductVisibility);
	      const product = products.find((item) => String(item?.id ?? "") === productId);
	      if (!product) {
	        await client.query("ROLLBACK");
	        sendJson(req, res, 404, { ok: false, error: "商品不存在或已被删除，请刷新后重试" });
	        return;
	      }

	      const operator = authenticatedOperator(req);
	      const disposition = productDeleteDisposition(state, productId, product.name);
	      const archivedAt = new Date().toISOString();
	      const nextProducts = disposition.mode === "archived"
	        ? products.map((item) => String(item?.id ?? "") === productId
	          ? { ...withoutLegacyProductVisibility(item), archivedAt, archivedBy: operator }
	          : item)
	        : products.filter((item) => String(item?.id ?? "") !== productId);
	      const nextOrigins = mergeProductOrigins(state.productOrigins, nextProducts);
	      const nextPublicCatalogPolicy = disposition.mode === "hard"
	        ? prunePublicCatalogPolicyReferences(state.publicCatalogPolicy, {
	          products: nextProducts,
	          species: state.species,
	        })
	        : normalizePublicCatalogPolicy(state.publicCatalogPolicy);
	      const operationLog = {
	        id: uid("log"),
	        time: archivedAt,
	        operator,
	        module: "商品管理",
	        action: disposition.mode === "archived" ? "修改记录" : "删除记录",
	        detail: disposition.mode === "archived"
	          ? `停用商品「${String(product.name ?? productId)}」（关联库存 ${disposition.references.stockCount} 条，订单 ${disposition.references.orderCount} 个）`
	          : `删除商品「${String(product.name ?? productId)}」`,
	      };
	      const nextState = {
	        ...state,
	        products: nextProducts,
	        productOrigins: nextOrigins,
	        publicCatalogPolicy: nextPublicCatalogPolicy,
	        operationLogs: pushOperationLog(state.operationLogs, operationLog),
	      };

	      await client.query(
	        "UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1",
	        [stateId, JSON.stringify(nextState)]
	      );
	      await client.query("COMMIT");
	      sendJson(req, res, 200, {
	        ok: true,
	        products: nextProducts,
	        productOrigins: nextOrigins,
	        publicCatalogPolicy: nextPublicCatalogPolicy,
	        operationLog,
	        mode: disposition.mode,
	        message: disposition.message,
	        references: disposition.references,
	      });
	    } catch (error) {
	      await client.query("ROLLBACK").catch(() => undefined);
	      sendJson(req, res, 400, { ok: false, error: error.message || "删除商品失败" });
	    } finally {
	      client.release();
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
      const minReturnPriceInput = Number(product.minReturnPrice ?? 0);
      if (!Number.isFinite(minReturnPriceInput) || minReturnPriceInput < 0) {
        sendJson(req, res, 400, { error: "Product minReturnPrice must be a non-negative number" });
        return;
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT data FROM app_state WHERE id = $1 FOR UPDATE", [stateId]);
	        const state = rows[0]?.data ?? {};
	        const products = (Array.isArray(state.products) ? state.products : [])
	          .map(withoutLegacyProductVisibility);
	        const productOrigins = Array.isArray(state.productOrigins) ? state.productOrigins : [];
	        const operationLogs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
	        const productExists = products.some((item) => String(item?.id ?? "") === String(product.id ?? ""));
	        requireModulePermissionForAuth(req, "products", productExists ? "update" : "create");

	        const normalizedProduct = await externalizeDataUrls({
          ...withoutLegacyProductVisibility(product),
          name: String(product.name).trim(),
          size: String(product.size).trim(),
          origin: String(product.origin).trim(),
          imageUrl: String(product.imageUrl ?? ""),
          notes: String(product.notes ?? "").trim(),
          defaultPrice: Number(product.defaultPrice),
          minReturnPrice: normalizeMinReturnPrice(minReturnPriceInput),
          commissionRate: 0,
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
  if (
    relative === PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY ||
    relative.startsWith(`${PERSONNEL_PRIVATE_ATTACHMENT_DIRECTORY}/`) ||
    relative === VIDEO_DERIVATIVE_DIRECTORY ||
    relative.startsWith(`${VIDEO_DERIVATIVE_DIRECTORY}/`)
  ) {
    sendJson(req, res, 404, { error: "Upload file not found" });
    return;
  }
  const candidate = normalize(join(uploadDir, relative));
  if (
    isPersonnelPrivateAttachmentPath(uploadDir, candidate) ||
    isVideoDerivativePath(uploadDir, candidate)
  ) {
    sendJson(req, res, 404, { error: "Upload file not found" });
    return;
  }
  const finalPath = candidate === uploadDir || candidate.startsWith(`${uploadDir}/`) ? candidate : "";
  if (!finalPath) {
    sendJson(req, res, 404, { error: "Upload file not found" });
    return;
  }

  try {
    const fileStat = await stat(finalPath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const contentType = safePublicMediaContentType(
      mimeTypes[extname(finalPath)] || mimeForExtension(extname(finalPath)),
      finalPath
    );
    if (!contentType) {
      sendJson(req, res, 415, { error: "Unsupported upload media type" }, {
        "X-Content-Type-Options": "nosniff",
      });
      return;
    }
    if (url.searchParams.get("wechatVideo") === "1" && contentType.startsWith("video/")) {
      let releaseTranscodeSlot = null;
      try {
        releaseTranscodeSlot = await videoTranscodeLimiter.acquire();
        const mp4Buffer = await transcodeVideoToWechatMp4(await readFile(finalPath), contentType, { slotAcquired: true });
        res._logicalResponseBytes = mp4Buffer.length;
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Disposition": "inline; filename=\"wechat-video.mp4\"",
          "Cache-Control": "public, max-age=3600",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(mp4Buffer);
      } catch (error) {
        console.warn(`Failed to transcode local video ${finalPath}: ${error.message}`);
        sendJson(req, res, error?.statusCode || 502, { error: error.message || "视频转码失败，请稍后重试" });
      } finally {
        releaseTranscodeSlot?.();
      }
      return;
    }
    const download = url.searchParams.get("download") === "1";
    const requestedName = download
      ? sanitizeAttachmentFilename(url.searchParams.get("filename") || `fishroom-media${extname(finalPath)}`)
      : "";
    const rangeHeader = String(req.headers.range ?? "").trim();
    let start = 0;
    let end = fileStat.size - 1;
    let status = 200;
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
      if (!match) {
        res.writeHead(416, { "Content-Range": `bytes */${fileStat.size}`, "Accept-Ranges": "bytes" });
        res.end();
        return;
      }
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      if (!match[1] && match[2]) {
        const suffixLength = Number(match[2]);
        start = Math.max(0, fileStat.size - suffixLength);
        end = fileStat.size - 1;
      }
      if (
        !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start || start >= fileStat.size
      ) {
        res.writeHead(416, { "Content-Range": `bytes */${fileStat.size}`, "Accept-Ranges": "bytes" });
        res.end();
        return;
      }
      end = Math.min(end, fileStat.size - 1);
      status = 206;
    }
    const contentLength = Math.max(0, end - start + 1);
    res._logicalResponseBytes = req.method === "HEAD" ? 0 : contentLength;
    res.writeHead(status, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=600",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Length": String(contentLength),
      ...(status === 206 ? { "Content-Range": `bytes ${start}-${end}/${fileStat.size}` } : {}),
      ...(download ? {
        "Content-Disposition": mediaAttachmentDisposition(requestedName, extname(finalPath) || ".bin"),
      } : {}),
    });
    if (req.method === "HEAD" || contentLength === 0) {
      res.end();
      return;
    }
    createReadStream(finalPath, { start, end }).pipe(res);
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
      `[auto-orders] ${reason}: shipped=${result.summary.autoShippedCount}, delivered=${result.summary.autoDeliveredCount}, completed=${result.summary.autoCompletedCount}, paymentBlocked=${result.summary.paymentBlockedCount ?? 0}, notifications=${result.summary.notificationCount ?? 0}`
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
  req._requestStartedAt = process.hrtime.bigint();
  const socketBytesAtStart = Number(res.socket?.bytesWritten ?? 0);
  res.once("finish", () => {
    if (req._slowRequestLogged || typeof req._requestStartedAt !== "bigint") return;
    const elapsedMs = Number(process.hrtime.bigint() - req._requestStartedAt) / 1_000_000;
    if (elapsedMs < 750) return;
    req._slowRequestLogged = true;
    const path = String(req.url ?? "").split("?", 1)[0];
    const requestBytes = Number(req.headers?.["content-length"] ?? 0);
    const logicalResponseBytes = Number(res._logicalResponseBytes);
    const responseBytes = Number.isFinite(logicalResponseBytes)
      ? Math.max(0, logicalResponseBytes)
      : Math.max(0, Number(res.socket?.bytesWritten ?? 0) - socketBytesAtStart);
    console.warn(
      `[slow-api] method=${req.method ?? ""} path=${path} status=${res.statusCode} ` +
      `durationMs=${elapsedMs.toFixed(1)} requestBytes=${Number.isFinite(requestBytes) ? requestBytes : 0} ` +
      `responseBytes=${responseBytes}`
    );
  });
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
