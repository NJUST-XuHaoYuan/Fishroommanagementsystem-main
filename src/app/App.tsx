import { useState, useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { toast } from "sonner";
import { StoreContext, initialState, DEFAULT_FISH_LIST_FOOTER_TEXT, DEFAULT_ORDER_PACKAGING_FEE, DEFAULT_PAYMENT_METHOD_SETTINGS, DEFAULT_SHIPPING_CARRIER_SETTINGS, DEFAULT_WATER_QUALITY_PARAMETERS, BioRecordSaveChange, BioRecordSaveResult, DailyLog, MaintenanceSaveChange, MaintenanceSaveResult, OperationLog, PaymentRecord, PermissionSet, Personnel, Product, ProductDeleteResult, StockChangeRequest, StockChangeResult, StockItem, Store, TankGroup, SubTank, User, WaterQualityParameterSetting, WaterQualityRecord, WaterQualityTankGroupAssignment, isPersonnelAccountEnabled, normalizePaymentMethodSettings, normalizeShippingCarrierSettings, normalizeSpeciesCategoryMajorMap, normalizeWaterQualityParameters, waterQualityParameterIdsForGroup, uid } from "./store";
import type { AuthAccountPermissionSummary } from "./store";
import { Login } from "./components/Login";
import { PublicCatalogPage } from "./components/PublicCatalogPage";
import { LogoLoader } from "./components/LogoLoader";
import { Layout, ViewKey } from "./components/Layout";
import { Dashboard } from "./components/Dashboard";
import { SpeciesView } from "./components/SpeciesView";
import { ProductsView } from "./components/ProductsView";
import { TankGroupsView } from "./components/TankGroupsView";
import { BatchesView } from "./components/BatchesView";
import { StockInView } from "./components/StockInView";
import { DailyView } from "./components/DailyView";
import { LossRecordsView } from "./components/LossRecordsView";
import { OrdersView } from "./components/OrdersView";
import { CatalogManagementView } from "./components/CatalogManagementView";
import { CustomersView } from "./components/CustomersView";
import { FinanceView } from "./components/FinanceView";
import { PersonnelAdminView } from "./components/PersonnelAdminView";
import { OperationLogsView } from "./components/OperationLogsView";
import { PersonalCenterView } from "./components/PersonalCenterView";
import { PaymentMethodsView } from "./components/PaymentMethodsView";
import { ShippingCarriersView } from "./components/ShippingCarriersView";
import { WaterQualitySettingsView } from "./components/WaterQualitySettingsView";
import { CategorySettingsView } from "./components/CategorySettingsView";
import { NotificationCenterView } from "./components/NotificationCenter";
import { Toaster } from "./components/ui/sonner";
import { normalizePermissions } from "./utils/permissions";
import { resolveDashboardView } from "./utils/dashboardAccess";
import { buildLinkedOrderNavigation } from "./utils/linkedOrderNavigation";
import type { LinkedOrderSourceView } from "./utils/linkedOrderNavigation";
import { isViewStateReady } from "./utils/viewReadiness";
import type { LoadedViewState } from "./utils/viewReadiness";
import { authJsonHeaders, clearAuthSession, getAuthSessionExpiresAt, getValidAuthSession, saveAuthSession } from "./utils/authSession";
import { DEFAULT_SITE_ID, DEFAULT_SITES, canUserAccessSite, getSites, matchesSite, normalizeSiteId, normalizeVisibleSiteIds, visibleSitesForUser } from "./utils/sites";
import { changedObjectKeys, hasStateVersionChanged, isCurrentStateRequest, latestStateVersion, mapArrayCopyOnWrite } from "./utils/stateMutation";
import { maintenanceSaveFailure } from "./utils/maintenanceMutation";
import { copyPublicCatalogPolicy, normalizePublicCatalogPolicy } from "./utils/publicCatalogPolicy";

const API = "/api";
const MAX_OPERATION_LOGS = 10000;
const PUBLIC_CATALOG_POLICY_SCHEMA_VERSION = 1;

const AUDIT_COLLECTIONS: { key: keyof Store; module: string }[] = [
  { key: "systemSettings", module: "系统设置" },
  { key: "sites", module: "场地管理" },
  { key: "species", module: "物种管理" },
  { key: "speciesCategories", module: "分类管理" },
  { key: "speciesCategoryMajorMap", module: "分类管理" },
  { key: "publicCatalogPolicy", module: "鱼单管理" },
  { key: "products", module: "商品管理" },
  { key: "productOrigins", module: "商品产地" },
  { key: "tankGroups", module: "缸组管理" },
  { key: "batches", module: "采购批次" },
  { key: "stock", module: "库存明细" },
  { key: "lossRecords", module: "损耗记录" },
  { key: "logs", module: "日常管理" },
  { key: "waterQualityRecords", module: "水质记录" },
  { key: "checks", module: "盘库管理" },
  { key: "bioRecords", module: "生物记录" },
  { key: "customers", module: "客户管理" },
  { key: "customerSources", module: "客户来源" },
  { key: "orders", module: "订单管理" },
  { key: "shipments", module: "发货记录" },
  { key: "personnel", module: "人员管理" },
];

type PersistedStore = Omit<Store, "user">;
type PersistedKey = keyof PersistedStore;
type StateLoadOptions = { force?: boolean; showLoading?: boolean; liteSpecies?: boolean };
type SaveStatus = "idle" | "saving" | "saved" | "error";
type MutationSession = {
  generation: number;
  userKey: string;
  authSessionKey: string;
  statusSequence: number;
};
type BatchDetailRequest = { batchId: string; siteId: string };
type OpenOrderRequest = {
  orderId: string;
  requestId: number;
  returnView?: LinkedOrderSourceView;
  returnSiteId?: string;
};

const PERSISTED_KEYS = AUDIT_COLLECTIONS
  .map(({ key }) => key)
  .filter((key): key is PersistedKey =>
    key !== "user" && key !== "operationLogs" && key !== "tankGroups" && key !== "logs"
  );

const VIEW_STATE_KEYS: Record<ViewKey, PersistedKey[]> = {
  dashboard: ["sites", "systemSettings"],
  notifications: [],
  species: ["species", "speciesCategories", "speciesCategoryMajorMap", "products"],
  categorySettings: ["species", "speciesCategories", "speciesCategoryMajorMap"],
  products: ["species", "products", "productOrigins"],
  tankGroups: ["tankGroups", "stock", "shipments"],
  batches: ["batches"],
  stockIn: ["species", "products", "tankGroups", "batches", "stock", "orders", "shipments"],
  daily: ["systemSettings", "products", "tankGroups", "batches", "stock", "orders", "shipments", "logs", "waterQualityRecords", "personnel"],
  lossRecords: ["lossRecords", "stock", "products", "species", "batches", "tankGroups"],
  customers: ["customers", "customerSources", "orders", "shipments"],
  orders: ["systemSettings", "orders", "customers", "customerSources", "stock", "products", "species", "tankGroups", "shipments", "personnel"],
  catalogManagement: ["publicCatalogPolicy", "species", "speciesCategories", "speciesCategoryMajorMap", "products"],
  finance: ["sites", "systemSettings"],
  paymentMethods: ["systemSettings"],
  shippingCarriers: ["systemSettings"],
  waterQualitySettings: ["systemSettings", "tankGroups"],
  profile: [],
  permissions: ["personnel"],
  operationLogs: ["operationLogs"],
};

function withoutUser(state: Store): PersistedStore {
  const { user, ...persisted } = state;
  return persisted;
}

const EMPTY_PERSISTED_STATE: PersistedStore = {
  ...withoutUser(initialState),
  systemSettings: {
    fishListFooterText: DEFAULT_FISH_LIST_FOOTER_TEXT,
    financeDefaultCommissionRate: 1,
    paymentMethods: DEFAULT_PAYMENT_METHOD_SETTINGS.map((method) => ({ ...method })),
    shippingCarriers: DEFAULT_SHIPPING_CARRIER_SETTINGS.map((carrier) => ({ ...carrier })),
    orderPackagingFee: DEFAULT_ORDER_PACKAGING_FEE,
    waterQualityParameters: DEFAULT_WATER_QUALITY_PARAMETERS.map((parameter) => ({ ...parameter })),
  },
  sites: DEFAULT_SITES.map((site) => ({ ...site })),
  personnel: [],
  operationLogs: [],
  species: [],
  speciesCategories: [],
  speciesCategoryMajorMap: {},
  publicCatalogPolicy: copyPublicCatalogPolicy(undefined),
  products: [],
  productOrigins: [],
  tankGroups: [],
  batches: [],
  stock: [],
  lossRecords: [],
  logs: [],
  waterQualityRecords: [],
  checks: [],
  bioRecords: [],
  orders: [],
  shipments: [],
  customers: [],
  customerSources: [],
};

const SITE_SCOPED_KEYS = [
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
] as const;

function backfillSiteScopedData(data: any) {
  const next = { ...data };
  next.sites = getSites(next);
  SITE_SCOPED_KEYS.forEach((key) => {
    if (!Array.isArray(next[key])) return;
    next[key] = next[key].map((item: Record<string, unknown>) => ({
      ...item,
      siteId: normalizeSiteId(item.siteId),
    }));
  });
  return next;
}

function fillMissingSiteFields<T extends Partial<PersistedStore>>(data: T, siteId: string): T {
  const normalizedSiteId = normalizeSiteId(siteId);
  const next: any = { ...data };
  SITE_SCOPED_KEYS.forEach((key) => {
    if (!Array.isArray(next[key])) return;
    next[key] = mapArrayCopyOnWrite(next[key], (item: Record<string, unknown>) => {
      const nextSiteId = normalizeSiteId(item.siteId ?? normalizedSiteId);
      return item.siteId === nextSiteId ? item : { ...item, siteId: nextSiteId };
    });
  });
  return next;
}

function stockMatchesSite(state: Store, item: StockItem, siteId: string): boolean {
  const tankGroup = state.tankGroups.find((group) =>
    group.subTanks.some((tank) => tank.id === item.subTankId)
  );
  if (tankGroup) return normalizeSiteId(tankGroup.siteId) === siteId;
  return matchesSite(item, siteId);
}

function scopedStoreForSite(state: Store, siteId: string): Store {
  const normalizedSiteId = normalizeSiteId(siteId);
  const tankGroups = state.tankGroups.filter((item) => matchesSite(item, normalizedSiteId));
  const subTankIds = new Set(
    tankGroups.flatMap((group) => group.subTanks.map((tank) => tank.id))
  );
  const orders = state.orders.filter((item) => matchesSite(item, normalizedSiteId));
  const orderIds = new Set(orders.map((order) => order.id));
  const stock = state.stock.filter((item) => stockMatchesSite(state, item, normalizedSiteId));
  const stockIds = new Set(stock.map((item) => String(item.id).trim()));
  const inventoryProjection = {
    outStockIds: (state.inventoryProjection?.outStockIds ?? [])
      .map((id) => String(id ?? "").trim())
      .filter((id, index, ids) => id && stockIds.has(id) && ids.indexOf(id) === index),
    outDateByStockId: Object.fromEntries(
      Object.entries(state.inventoryProjection?.outDateByStockId ?? {})
        .filter(([id]) => stockIds.has(String(id).trim()))
    ),
  };
  return {
    ...state,
    inventoryProjection,
    sites: getSites(state),
    tankGroups,
    batches: state.batches.filter((item) => matchesSite(item, normalizedSiteId)),
    stock,
    logs: state.logs.filter((item) => matchesSite(item, normalizedSiteId) || subTankIds.has(item.subTankId ?? "")),
    waterQualityRecords: state.waterQualityRecords.filter((item) => matchesSite(item, normalizedSiteId) || tankGroups.some((group) => group.id === item.tankGroupId)),
    checks: state.checks.filter((item) => matchesSite(item, normalizedSiteId) || subTankIds.has(item.subTankId)),
    lossRecords: state.lossRecords.filter((item) => matchesSite(item, normalizedSiteId) || stockIds.has(item.stockItemId)),
    bioRecords: state.bioRecords.filter((item) => matchesSite(item, normalizedSiteId) || stockIds.has(item.stockItemId)),
    orders,
    shipments: state.shipments.filter((item) => matchesSite(item, normalizedSiteId) || orderIds.has(item.orderId)),
  };
}

function summarizeChange(before: unknown, after: unknown) {
  const beforeText = JSON.stringify(before ?? null);
  const afterText = JSON.stringify(after ?? null);
  if (beforeText === afterText) return null;
  const beforeCount = Array.isArray(before) ? before.length : undefined;
  const afterCount = Array.isArray(after) ? after.length : undefined;
  if (beforeCount !== undefined && afterCount !== undefined) {
    if (afterCount > beforeCount) return { action: "添加记录", detail: `数量 ${beforeCount} → ${afterCount}` };
    if (afterCount < beforeCount) return { action: "删除记录", detail: `数量 ${beforeCount} → ${afterCount}` };
  }
  return { action: "修改记录", detail: "数据内容已变更" };
}

function buildOperationLogs(prev: Store, next: Store, onlyKeys?: readonly (keyof Store)[]): OperationLog[] {
  if (!prev.user) return [];
  const operator = prev.user.username;
  const only = onlyKeys ? new Set<keyof Store>(onlyKeys) : null;
  return AUDIT_COLLECTIONS.flatMap(({ key, module }) => {
    if (only && !only.has(key)) return [];
    if (key === "operationLogs" || key === "user") return [];
    const summary = summarizeChange(prev[key], next[key]);
    if (!summary) return [];
    return [{
      id: uid(),
      time: new Date().toISOString(),
      operator,
      module,
      action: summary.action,
      detail: summary.detail,
    }];
  });
}

function mergeProductOrigins(origins: unknown, products: unknown): string[] {
  const merged: string[] = [];
  const add = (value: unknown) => {
    const origin = String(value ?? "").trim();
    if (origin && !merged.includes(origin)) merged.push(origin);
  };
  if (Array.isArray(origins)) origins.forEach(add);
  if (Array.isArray(products)) {
    products.forEach((product) => add((product as Record<string, unknown>).origin));
  }
  return merged;
}

function sameStringArray(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const leftItems = left ?? [];
  const rightItems = right ?? [];
  return leftItems.length === rightItems.length && leftItems.every((item, index) => item === rightItems[index]);
}

function normalizeAuthAccountPermissionSummary(
  value: unknown,
  expectedUsername: string
): AuthAccountPermissionSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const personnelId = String(source.personnelId ?? "").trim();
  const username = String(source.username ?? "").trim();
  if (!personnelId || !username || username !== expectedUsername) return undefined;
  const accessRole = source.accessRole === "admin" ? "admin" : source.accessRole === "staff" ? "staff" : null;
  if (!accessRole) return undefined;
  return {
    personnelId,
    username,
    accessRole,
    accountEnabled: source.accountEnabled === true,
    permissions: normalizePermissions(source.permissions as Partial<PermissionSet> | undefined),
  };
}

function userFromAuthMeResponse(result: any, fallbackUser: User): User {
  if (!result?.user) return null;
  const username = String(result.user.username ?? fallbackUser?.username ?? "").trim();
  if (!username) return null;
  const role = result.user.role === "admin" ? "admin" : "staff";
  const visibleSiteIds = Array.isArray(result.user.visibleSiteIds)
    ? result.user.visibleSiteIds.map((item: unknown) => String(item ?? "").trim()).filter(Boolean)
    : fallbackUser?.visibleSiteIds;
  const normalizedAccount = normalizeAuthAccountPermissionSummary(result.account, username);
  const account = normalizedAccount?.accountEnabled && normalizedAccount.accessRole === role
    ? normalizedAccount
    : undefined;
  return {
    username,
    role,
    ...(visibleSiteIds?.length ? { visibleSiteIds } : {}),
    ...(account ? { account } : {}),
  };
}

function fetchAuthMeWithRetry(attempt = 0): Promise<Response> {
  return fetch(`${API}/auth/me`, { headers: authJsonHeaders() }).catch((error) => {
    if (attempt >= 3) throw error;
    return new Promise<Response>((resolve, reject) => {
      window.setTimeout(
        () => fetchAuthMeWithRetry(attempt + 1).then(resolve, reject),
        1000 * (attempt + 1)
      );
    });
  });
}

function normalizeUserWithSiteScope(currentUser: User, personnel: Personnel[], sites: { id: string }[]): User {
  if (!currentUser) return null;
  const username = String(currentUser.username ?? "").trim();
  if (!username) return null;
  const account = currentUser.account?.username === username ? currentUser.account : undefined;
  if (currentUser.account && (!account || !account.accountEnabled)) return null;
  const matchedPerson = personnel.find((person) =>
    person.username === username && isPersonnelAccountEnabled(person)
  );
  const role = account?.accessRole ?? matchedPerson?.accessRole ?? currentUser.role;
  if (role === "admin") {
    return currentUser.username === username && currentUser.role === role && !currentUser.visibleSiteIds?.length
      ? currentUser
      : { username, role, ...(account ? { account } : {}) };
  }
  const visibleSiteIds = normalizeVisibleSiteIds(currentUser.visibleSiteIds ?? matchedPerson?.visibleSiteIds, sites);
  if (visibleSiteIds.length === 0) return null;
  const nextUser: NonNullable<User> = { username, role, visibleSiteIds, ...(account ? { account } : {}) };
  return currentUser.username === nextUser.username &&
    currentUser.role === nextUser.role &&
    sameStringArray(currentUser.visibleSiteIds, nextUser.visibleSiteIds) &&
    currentUser.account === nextUser.account
    ? currentUser
    : nextUser;
}

function normalizePersistedState(data: any, currentUser: User): Store {
  if (!data) return { ...initialState, user: currentUser };
  const migratedData = backfillSiteScopedData(data);
  const migratedSites = getSites(migratedData);

  // 迁移：旧格式 status === "sold" → sold: true, status: "healthy"
  const migratedStock = Array.isArray(migratedData.stock)
    ? migratedData.stock.map((item: Record<string, unknown>) => {
        const { cost, ...rest } = item;
        return {
          ...rest,
	          status: item.status === "sold" ? "healthy" : item.status,
	          sold: item.status === "sold" ? true : item.sold,
	          basePrice: Number(item.basePrice ?? cost ?? 0),
	          code: String(item.code ?? ""),
	          lossProof: Array.isArray(item.lossProof) ? item.lossProof : [],
	        };
    })
    : migratedData.stock;
  const legacyHiddenProductIds: string[] = [];
  const legacyCatalogMigrationCompleted = Number(
    migratedData._publicCatalogPolicySchemaVersion ?? 0
  ) >= PUBLIC_CATALOG_POLICY_SCHEMA_VERSION;
  const migratedProducts = Array.isArray(migratedData.products)
    ? migratedData.products.map((product: Record<string, unknown>) => {
        const { publicVisible: legacyPublicVisible, ...currentProduct } = product;
        const productId = String(product.id ?? "").trim();
        if (
          !legacyCatalogMigrationCompleted &&
          legacyPublicVisible === false &&
          productId &&
          !product.archivedAt
        ) {
          legacyHiddenProductIds.push(productId);
        }
        return {
          ...currentProduct,
          notes: String(product.notes ?? ""),
        };
      })
    : migratedData.products;
  const normalizedPublicCatalogPolicy = normalizePublicCatalogPolicy(migratedData.publicCatalogPolicy);
  const migratedPublicCatalogPolicy = legacyHiddenProductIds.length === 0
    ? normalizedPublicCatalogPolicy
    : {
        ...normalizedPublicCatalogPolicy,
        hiddenProductIds: Array.from(new Set([
          ...normalizedPublicCatalogPolicy.hiddenProductIds,
          ...legacyHiddenProductIds,
        ])),
      };
  const migratedProductOrigins = mergeProductOrigins(migratedData.productOrigins, migratedProducts ?? migratedData.products);
  const migratedSpecies = Array.isArray(migratedData.species) ? migratedData.species : [];
  const migratedSpeciesCategories = Array.from(new Set([
    ...(Array.isArray(migratedData.speciesCategories) ? migratedData.speciesCategories : []),
    ...migratedSpecies.map((species: { category?: unknown }) => species?.category),
  ].map((category) => String(category ?? "").trim()).filter(Boolean)));
  const migratedSpeciesCategoryMajorMap = normalizeSpeciesCategoryMajorMap(
    migratedSpeciesCategories,
    migratedData.speciesCategoryMajorMap
  );
  const migratedPersonnel = Array.isArray(migratedData.personnel)
    ? migratedData.personnel.map((person: Record<string, unknown>, index: number) => {
        const name = String(person.name ?? person.username ?? "");
        const username = String(person.username ?? "");
        const resigned = person.employmentStatus === "resigned" || Boolean(person.resignedAt);
        const accessRole = person.accessRole === "admin" || person.accessRole === "staff"
          ? person.accessRole
          : username === "admin" ? "admin" : "staff";
        return {
          id: String(person.id ?? `person-${index + 1}`),
          personnelNo: String(person.personnelNo ?? `RY-${String(index + 1).padStart(4, "0")}`),
          name,
          username,
          password: typeof person.password === "string" ? person.password : "",
          accountEnabled: Boolean(username) && !resigned && person.accountEnabled !== false,
          accessRole,
          visibleSiteIds: accessRole === "admin"
            ? []
            : normalizeVisibleSiteIds((person as any).visibleSiteIds, migratedSites),
          permissions: normalizePermissions((person as any).permissions),
          employmentStatus: resigned ? "resigned" : "active",
          resignedAt: typeof person.resignedAt === "string" ? person.resignedAt : undefined,
          gender: person.gender === "male" || person.gender === "female" || person.gender === "other" ? person.gender : "",
          nativePlace: String(person.nativePlace ?? ""),
          birthMonth: String(person.birthMonth ?? person.birthDate ?? "").slice(0, 7),
          educationLevel: ["high_school_or_below", "college", "bachelor", "master", "doctorate"]
            .includes(String(person.educationLevel ?? ""))
            ? String(person.educationLevel) as Personnel["educationLevel"]
            : "",
          profileComplete: person.profileComplete === true,
          missingProfileFields: Array.isArray(person.missingProfileFields)
            ? person.missingProfileFields
                .map((field) => String(field ?? "").trim())
                .filter((field, fieldIndex, fields) => field && fields.indexOf(field) === fieldIndex)
            : [],
          birthDate: String(person.birthDate ?? ""),
          department: String(person.department ?? ""),
          role: String(person.role ?? ""),
          hireDate: String(person.hireDate ?? ""),
          siteIds: normalizeVisibleSiteIds((person as any).siteIds, migratedSites),
          phone: String(person.phone ?? ""),
          email: String(person.email ?? ""),
          wechat: String(person.wechat ?? ""),
          address: String(person.address ?? ""),
          emergencyContact: String(person.emergencyContact ?? ""),
          emergencyPhone: String(person.emergencyPhone ?? ""),
          notes: String(person.notes ?? ""),
        };
      })
    : initialState.personnel;
  const migratedShipments = Array.isArray(migratedData.shipments)
    ? migratedData.shipments.map((shipment: Record<string, unknown>) =>
        shipment.shipMethod === "pickup"
          ? { ...shipment, status: "delivered", actualShippingFee: 0 }
          : shipment
      )
    : migratedData.shipments;
  const migratedSystemSettings = {
    ...initialState.systemSettings,
    ...(migratedData.systemSettings && typeof migratedData.systemSettings === "object" ? migratedData.systemSettings : {}),
  };
  migratedSystemSettings.paymentMethods = normalizePaymentMethodSettings(migratedSystemSettings);
  migratedSystemSettings.shippingCarriers = normalizeShippingCarrierSettings(migratedSystemSettings);
  migratedSystemSettings.waterQualityParameters = normalizeWaterQualityParameters(migratedSystemSettings);
  const migratedTankGroups = Array.isArray(migratedData.tankGroups)
    ? migratedData.tankGroups.map((group: TankGroup) => ({
        ...group,
        waterQualityParameterIds: waterQualityParameterIdsForGroup(
          group,
          migratedSystemSettings.waterQualityParameters
        ),
      }))
    : [];
  const migratedWaterQualityRecords = Array.isArray(migratedData.waterQualityRecords)
    ? migratedData.waterQualityRecords.map((record: WaterQualityRecord) => ({
        ...record,
        id: String(record?.id ?? ""),
        measuredAt: String(record?.measuredAt ?? ""),
        tankGroupId: String(record?.tankGroupId ?? ""),
        operator: String(record?.operator ?? ""),
        notes: String(record?.notes ?? ""),
        values: Array.isArray(record?.values) ? record.values : [],
      }))
    : [];

  return {
    ...initialState,
    ...migratedData,
    systemSettings: migratedSystemSettings,
    sites: migratedSites,
    personnel: migratedPersonnel,
    operationLogs: Array.isArray(migratedData.operationLogs) ? migratedData.operationLogs : [],
    species: migratedSpecies,
    speciesCategories: migratedSpeciesCategories,
    speciesCategoryMajorMap: migratedSpeciesCategoryMajorMap,
    publicCatalogPolicy: migratedPublicCatalogPolicy,
    products: migratedProducts ?? migratedData.products,
    productOrigins: migratedProductOrigins,
    tankGroups: migratedTankGroups,
    lossRecords: Array.isArray(migratedData.lossRecords) ? migratedData.lossRecords : [],
    waterQualityRecords: migratedWaterQualityRecords,
    stock: migratedStock ?? migratedData.stock,
    shipments: migratedShipments ?? migratedData.shipments,
    user: normalizeUserWithSiteScope(currentUser, migratedPersonnel, migratedSites),
  };
}

function restoreUserFromSession(): User {
  const session = getValidAuthSession();
  if (!session) return null;
  return session.visibleSiteIds?.length
    ? { username: session.username, role: session.role, visibleSiteIds: session.visibleSiteIds }
    : { username: session.username, role: session.role };
}

function userDependencyKey(user: User): string {
  if (!user) return "";
  return [user.username, user.role, ...(user.visibleSiteIds ?? [])].join("|");
}

function authSessionDependencyKey(): string {
  const session = getValidAuthSession();
  if (!session) return "";
  return [session.username, session.role, session.expiresAt, session.token ?? ""].join("\0");
}

function findChangedKeys(before: PersistedStore, after: PersistedStore): PersistedKey[] {
  return changedObjectKeys(before, after, PERSISTED_KEYS);
}

function mergeOperationLogs(
  latestLogs: OperationLog[] = [],
  currentLogs: OperationLog[] = [],
  baselineLogs: OperationLog[] = []
): OperationLog[] {
  const baselineIds = new Set(baselineLogs.map((log) => log.id));
  const localNewLogs = currentLogs.filter((log) => !baselineIds.has(log.id));
  const seen = new Set<string>();
  return [...localNewLogs, ...latestLogs]
    .filter((log) => {
      if (seen.has(log.id)) return false;
      seen.add(log.id);
      return true;
    })
    .slice(0, MAX_OPERATION_LOGS);
}

function mergeIdUpdates<T extends { id: string }>(current: T[], updates: unknown): T[] {
  if (!Array.isArray(updates) || updates.length === 0) return current;
  const normalizedUpdates = updates.filter((item): item is T =>
    Boolean(item && typeof item === "object" && String((item as { id?: unknown }).id ?? "").trim())
  );
  if (normalizedUpdates.length === 0) return current;
  const updateById = new Map(normalizedUpdates.map((item) => [String(item.id), item]));
  const existingIds = new Set(current.map((item) => String(item.id)));
  const merged = mapArrayCopyOnWrite(current, (item) => updateById.get(String(item.id)) ?? item);
  const additions = normalizedUpdates.filter((item) => !existingIds.has(String(item.id)));
  return additions.length > 0 ? [...merged, ...additions] : merged;
}

function withServerOperationLog(log: OperationLog | undefined, currentLogs: OperationLog[] = []): OperationLog[] {
  return log
    ? [log, ...currentLogs]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
        .slice(0, MAX_OPERATION_LOGS)
    : currentLogs;
}

function hasActiveEditingSurface(): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const tag = active.tagName.toLowerCase();
    if (["input", "textarea", "select"].includes(tag) || active.isContentEditable) return true;
    if (active.closest("[role='dialog'], [data-radix-popper-content-wrapper]")) return true;
  }
  return Boolean(document.querySelector("[role='dialog'], [data-radix-popper-content-wrapper]"));
}

function isPublicSiteHost(): boolean {
  try {
    return window.location.port === "10000";
  } catch {
    return false;
  }
}

function AdminApp() {
  const [isPublicSite] = useState(() => isPublicSiteHost());
  const [state, setStateBase] = useState<Store>(initialState);
  const [requestedView, setView] = useState<ViewKey>("dashboard");
  // Resolve during render, before either page rendering or page-data effects run.
  // This also closes the first-frame gap when restoring or switching accounts.
  const view = resolveDashboardView(requestedView, state.user);
  const [loading, setLoading] = useState(true);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [loadedViewState, setLoadedViewState] = useState<LoadedViewState | null>(null);
  const [stateLoading, setStateLoading] = useState(false);
  const [stateLoadError, setStateLoadError] = useState("");
  const [stateLoadAttempt, setStateLoadAttempt] = useState(0);
  const [viewLoading, setViewLoading] = useState(false);
  const [loadedKeys, setLoadedKeys] = useState<Set<PersistedKey>>(() => new Set());
  const [openOrderRequest, setOpenOrderRequest] = useState<OpenOrderRequest | null>(null);
  const [batchDetailRequest, setBatchDetailRequest] = useState<{
    userKey: string;
    request: BatchDetailRequest;
  } | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [activeSiteId, setActiveSiteIdBase] = useState(() => {
    try {
      return normalizeSiteId(window.localStorage.getItem("fishroom-active-site"));
    } catch {
      return DEFAULT_SITE_ID;
    }
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const saveStatusTimerRef = useRef<number | null>(null);
  const saveAbort = useRef<AbortController | null>(null);
  const bioSaveInFlight = useRef(false);
  const stateLoadStarted = useRef(false);
  const lastSavedState = useRef<PersistedStore | null>(null);
  const persistQueue = useRef<Promise<void>>(Promise.resolve());
  const stateRef = useRef(state);
  const saveStatusRef = useRef(saveStatus);
  const refreshInProgress = useRef(false);
  const versionCheckInProgress = useRef(false);
  const stateVersionRef = useRef("");
  const stateRequestEpochRef = useRef(0);
  const stateRequestSequenceRef = useRef(0);
  const stateKeyRequestSequenceRef = useRef<Map<PersistedKey, number>>(new Map());
  const stateRequestControllersRef = useRef<Set<AbortController>>(new Set());
  const viewLoadingRequestRef = useRef(0);
  const pageLoadRequestRef = useRef(0);
  const mutationSessionGenerationRef = useRef(0);
  const mutationStatusSequenceRef = useRef(0);
  const loadedViewRef = useRef<ViewKey | null>(null);
  const orderRequestSequence = useRef(0);
  const loadedKeysRef = useRef<Set<PersistedKey>>(new Set());
  const viewRef = useRef(view);
  const currentUserKey = userDependencyKey(state.user);
  const currentUserKeyRef = useRef(currentUserKey);
  const previousUserKeyRef = useRef(currentUserKey);
  currentUserKeyRef.current = currentUserKey;
  const permissionSummaryReady = !state.user || state.user.role === "admin" || Boolean(
    state.user.account?.accountEnabled &&
    state.user.account.username === state.user.username &&
    state.user.account.accessRole === state.user.role
  );

  const invalidateStateReadRequests = () => {
    stateRequestEpochRef.current += 1;
    stateRequestControllersRef.current.forEach((controller) => controller.abort());
    stateRequestControllersRef.current.clear();
    stateKeyRequestSequenceRef.current.clear();
    versionCheckInProgress.current = false;
    viewLoadingRequestRef.current = 0;
    setViewLoading(false);
  };

  const beginMutation = (): MutationSession => {
    mutationStatusSequenceRef.current += 1;
    if (saveStatusTimerRef.current !== null) {
      window.clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
    const mutationSession = {
      generation: mutationSessionGenerationRef.current,
      userKey: currentUserKeyRef.current,
      authSessionKey: authSessionDependencyKey(),
      statusSequence: mutationStatusSequenceRef.current,
    };
    invalidateStateReadRequests();
    saveStatusRef.current = "saving";
    setSaveStatus("saving");
    return mutationSession;
  };

  const isMutationSessionCurrent = (session: MutationSession, user = stateRef.current.user) =>
    isCurrentStateRequest(
      session.userKey,
      userDependencyKey(user),
      session.generation,
      mutationSessionGenerationRef.current,
    ) && Boolean(session.authSessionKey) && session.authSessionKey === authSessionDependencyKey() &&
    session.statusSequence === mutationStatusSequenceRef.current;

  const settleMutation = (
    session: MutationSession,
    status: Exclude<SaveStatus, "saving">,
    idleAfterMs = 0,
  ) => {
    if (!isMutationSessionCurrent(session)) return false;
    if (saveStatusTimerRef.current !== null) {
      window.clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
    saveStatusRef.current = status;
    setSaveStatus(status);
    if (idleAfterMs > 0) {
      saveStatusTimerRef.current = window.setTimeout(() => {
        if (!isMutationSessionCurrent(session)) return;
        saveStatusTimerRef.current = null;
        saveStatusRef.current = "idle";
        setSaveStatus("idle");
      }, idleAfterMs);
    }
    return true;
  };

  const setStateForMutation = (
    session: MutationSession,
    updater: (current: Store) => Store,
  ) => {
    setStateBase((current) => isMutationSessionCurrent(session, current.user)
      ? updater(current)
      : current);
  };

  const setActiveSiteId: Dispatch<SetStateAction<string>> = (value) => {
    setActiveSiteIdBase((current) => {
      const next = normalizeSiteId(typeof value === "function" ? (value as (siteId: string) => string)(current) : value);
      try {
        window.localStorage.setItem("fishroom-active-site", next);
      } catch {
        // localStorage can be unavailable in private contexts.
      }
      return next;
    });
  };

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    saveStatusRef.current = saveStatus;
  }, [saveStatus]);

  useEffect(() => {
    loadedKeysRef.current = loadedKeys;
  }, [loadedKeys]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  const hasLoadedKeys = (keys: PersistedKey[]) =>
    keys.every((key) => loadedKeys.has(key));

  const loadStateKeys = async (
    keys: PersistedKey[],
    options: StateLoadOptions = {}
  ): Promise<boolean> => {
    const uniqueKeys = [...new Set(keys)];
    const keysToFetch = options.force
      ? uniqueKeys
      : uniqueKeys.filter((key) => !loadedKeysRef.current.has(key));
    if (keysToFetch.length === 0) return true;
    const requestedUserKey = currentUserKeyRef.current;
    if (!requestedUserKey || !stateRef.current.user) return false;

    const requestEpoch = stateRequestEpochRef.current;
    const requestSequence = ++stateRequestSequenceRef.current;
    const controller = new AbortController();
    stateRequestControllersRef.current.add(controller);
    keysToFetch.forEach((key) => stateKeyRequestSequenceRef.current.set(key, requestSequence));

    if (options.showLoading) {
      viewLoadingRequestRef.current = requestSequence;
      setViewLoading(true);
    }
    try {
      const query = encodeURIComponent(keysToFetch.join(","));
      const lite = options.liteSpecies && keysToFetch.includes("species") ? "&lite=species" : "";
      const response = await fetch(`${API}/state/slice?keys=${query}${lite}`, {
        headers: authJsonHeaders(),
        signal: controller.signal,
      });
      const result = await response.json();
      const requestIsCurrent = () => isCurrentStateRequest(
        requestedUserKey,
        currentUserKeyRef.current,
        requestEpoch,
        stateRequestEpochRef.current
      );
      if (!requestIsCurrent()) return false;
      if (!response.ok) {
        const error = new Error(result.error || `HTTP ${response.status}`);
        (error as Error & { status?: number }).status = response.status;
        throw error;
      }
      const currentKeys = keysToFetch.filter((key) =>
        stateKeyRequestSequenceRef.current.get(key) === requestSequence
      );
      if (currentKeys.length === 0) return false;
      const responseData = result.data ?? {};
      stateVersionRef.current = latestStateVersion(stateVersionRef.current, result.version);
      setStateBase((current) => {
        const keysStillCurrent = currentKeys.filter((key) =>
          stateKeyRequestSequenceRef.current.get(key) === requestSequence
        );
        if (
          !requestIsCurrent() ||
          keysStillCurrent.length === 0 ||
          !current.user ||
          userDependencyKey(current.user) !== requestedUserKey
        ) return current;
        const data = Object.fromEntries(keysStillCurrent.map((key) => [key, responseData[key]]));
        if (keysStillCurrent.includes("stock") && responseData.inventoryProjection) {
          data.inventoryProjection = responseData.inventoryProjection;
        }
        const normalized = normalizePersistedState(
          { ...withoutUser(current), ...data },
          current.user
        );
        lastSavedState.current = withoutUser(normalized);
        return normalized;
      });
      setLoadedKeys((current) => {
        if (!requestIsCurrent()) return current;
        const keysStillCurrent = currentKeys.filter((key) =>
          stateKeyRequestSequenceRef.current.get(key) === requestSequence
        );
        if (keysStillCurrent.length === 0) return current;
        const next = new Set(current);
        keysStillCurrent.forEach((key) => next.add(key));
        loadedKeysRef.current = next;
        return next;
      });
      return true;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return false;
      console.error("Failed to load state slice:", error);
      if (
        (error as Error & { status?: number })?.status === 401 &&
        isCurrentStateRequest(
          requestedUserKey,
          currentUserKeyRef.current,
          requestEpoch,
          stateRequestEpochRef.current
        )
      ) {
        clearAuthSession();
        invalidateStateReadRequests();
        stateLoadStarted.current = false;
        lastSavedState.current = null;
        loadedKeysRef.current = new Set<PersistedKey>();
        setLoadedKeys(new Set<PersistedKey>());
        setStateLoaded(false);
        setStateBase(() => normalizePersistedState(EMPTY_PERSISTED_STATE, null));
      }
      return false;
    } finally {
      stateRequestControllersRef.current.delete(controller);
      if (options.showLoading && viewLoadingRequestRef.current === requestSequence) {
        viewLoadingRequestRef.current = 0;
        setViewLoading(false);
      }
    }
  };

  const loadViewState = (targetView: ViewKey, options: StateLoadOptions = {}) => {
    const allowedView = resolveDashboardView(targetView, stateRef.current.user);
    return loadStateKeys(VIEW_STATE_KEYS[allowedView] ?? [], {
      ...options,
      liteSpecies: options.liteSpecies ?? !["species", "products"].includes(allowedView),
    });
  };

  const postStatePatch = async (
    patch: Partial<PersistedStore>,
    _operationLogs: OperationLog[] = [],
    basePatch: Partial<PersistedStore> = {}
  ): Promise<{
    appliedOperationLogs?: OperationLog[];
    inventoryProjection?: Store["inventoryProjection"];
  }> => {
    const response = await fetch(`${API}/state/patch`, {
      method: "POST",
      headers: authJsonHeaders(),
      body: JSON.stringify({ patch, basePatch }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      throw new Error(result.error || `HTTP ${response.status}`);
    }
    return result;
  };

  const persistManualChange = async (
    currentStateToSave: PersistedStore,
    baseline: PersistedStore | null,
    changedKeys: PersistedKey[]
  ) => {
    const hasNewLogs = baseline
      ? mergeOperationLogs([], currentStateToSave.operationLogs, baseline.operationLogs).length > 0
      : currentStateToSave.operationLogs.length > 0;
    if (changedKeys.length === 0 && !hasNewLogs) return;

    const mutationSession = beginMutation();
    try {
      const patch = changedKeys.reduce<Partial<PersistedStore>>((acc, key) => {
        (acc as any)[key] = currentStateToSave[key];
        return acc;
      }, {});
      const basePatch = changedKeys.reduce<Partial<PersistedStore>>((acc, key) => {
        if (baseline) (acc as any)[key] = baseline[key];
        return acc;
      }, {});
      const logs = baseline
        ? mergeOperationLogs([], currentStateToSave.operationLogs, baseline.operationLogs)
        : currentStateToSave.operationLogs;
      const result = await postStatePatch(patch, logs, basePatch);
      if (!isMutationSessionCurrent(mutationSession)) return;
      lastSavedState.current = {
        ...(lastSavedState.current ?? currentStateToSave),
        ...patch,
        inventoryProjection: result.inventoryProjection ?? currentStateToSave.inventoryProjection,
        operationLogs: currentStateToSave.operationLogs,
      };
      if (result.inventoryProjection) {
        setStateForMutation(mutationSession, (current) => ({
          ...current,
          inventoryProjection: result.inventoryProjection,
        }));
      }
      settleMutation(mutationSession, "saved", 2000);
    } catch (error) {
      console.error("Failed to save manual change:", error);
      settleMutation(mutationSession, "error", 3000);
    }
  };

  const queueManualPersist = (
    currentStateToSave: PersistedStore,
    baseline: PersistedStore | null,
    changedKeys: PersistedKey[]
  ) => {
    persistQueue.current = persistQueue.current
      .catch(() => undefined)
      .then(() => persistManualChange(currentStateToSave, baseline, changedKeys));
  };

  const savePatch = async (patch: Partial<PersistedStore>): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    const mutationSession = beginMutation();
    try {
      const { operationLogs: patchLogs, ...statePatch } = patch;
      const scopedStatePatch = fillMissingSiteFields(statePatch, activeSiteId);
      const basePatch = Object.keys(statePatch).reduce<Partial<PersistedStore>>((acc, key) => {
        (acc as any)[key] = (withoutUser(stateRef.current) as any)[key];
        return acc;
      }, {});
      const result = await postStatePatch(scopedStatePatch, Array.isArray(patchLogs) ? patchLogs : [], basePatch);
      setStateForMutation(mutationSession, (current) => {
        const next = normalizePersistedState(
          {
            ...withoutUser(current),
            ...scopedStatePatch,
            inventoryProjection: result.inventoryProjection ?? current.inventoryProjection,
            operationLogs: [
              ...(result.appliedOperationLogs ?? (Array.isArray(patchLogs) ? patchLogs : [])),
              ...(current.operationLogs ?? []),
            ].filter((log, index, all) =>
              all.findIndex((item) => item.id === log.id) === index
            ).slice(0, MAX_OPERATION_LOGS),
          },
          current.user
        );
        lastSavedState.current = withoutUser(next);
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return true;
    } catch (error) {
      console.error("Failed to save patch:", error);
      settleMutation(mutationSession, "error", 3000);
      return false;
    }
  };

  const saveStateTransform = async (
    transform: (latest: PersistedStore) => PersistedStore
  ): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    const mutationSession = beginMutation();
    try {
      const currentPersisted = withoutUser(stateRef.current);
      const transformed = fillMissingSiteFields(transform(currentPersisted), activeSiteId);
      const changedKeys = findChangedKeys(currentPersisted, transformed);
      const previousWithUser = { ...currentPersisted, user: stateRef.current.user } as Store;
      const nextWithUser = { ...transformed, user: state.user } as Store;
      const logs = buildOperationLogs(previousWithUser, nextWithUser, changedKeys);
      if (changedKeys.length === 0 && logs.length === 0) {
        settleMutation(mutationSession, "saved", 2000);
        return true;
      }

      const patch = changedKeys.reduce<Partial<PersistedStore>>((acc, key) => {
        (acc as any)[key] = transformed[key];
        return acc;
      }, {});
      const basePatch = changedKeys.reduce<Partial<PersistedStore>>((acc, key) => {
        (acc as any)[key] = currentPersisted[key];
        return acc;
      }, {});
      const result = await postStatePatch(patch, logs, basePatch);

      setStateForMutation(mutationSession, (current) => {
        const appliedLogs = result.appliedOperationLogs ?? logs;
        const next = normalizePersistedState(
          {
            ...withoutUser(current),
            ...patch,
            inventoryProjection: result.inventoryProjection ?? current.inventoryProjection,
            operationLogs: [...appliedLogs, ...(current.operationLogs ?? [])]
              .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
              .slice(0, MAX_OPERATION_LOGS),
          },
          current.user
        );
        lastSavedState.current = withoutUser(next);
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return true;
    } catch (error) {
      console.error("Failed to save transformed state:", error);
      settleMutation(mutationSession, "error", 3000);
      return false;
    }
  };

  const saveProduct = async (product: Product): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    const mutationSession = beginMutation();
    try {
      const response = await fetch(`${API}/products/upsert`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          product,
          operator: state.user?.username ?? "system",
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      setStateForMutation(mutationSession, (current) => {
        const next = {
          ...current,
          products: Array.isArray(result.products) ? result.products : current.products,
          productOrigins: Array.isArray(result.productOrigins) ? result.productOrigins : current.productOrigins,
	          operationLogs: result.operationLog
	            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
	                arr.findIndex((item) => item.id === log.id) === idx
	              ).slice(0, MAX_OPERATION_LOGS)
	            : current.operationLogs,
        };
        lastSavedState.current = withoutUser(next);
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return true;
    } catch (error) {
      console.error("Failed to save product:", error);
      settleMutation(mutationSession, "error", 3000);
      return false;
    }
  };

	  const deleteProduct = async (productId: string): Promise<ProductDeleteResult> => {
	    clearTimeout(saveTimer.current);
	    const mutationSession = beginMutation();
	    try {
	      const response = await fetch(`${API}/products/delete`, {
	        method: "POST",
	        headers: authJsonHeaders(),
	        body: JSON.stringify({ productId }),
	      });
	      const result = await response.json().catch(() => ({}));
	      if (!response.ok || !result.ok) {
	        settleMutation(mutationSession, "error", 3000);
	        return {
	          ok: false,
	          error: result.error || `HTTP ${response.status}`,
	          references: result.references,
	        };
	      }

	      setStateForMutation(mutationSession, (current) => {
	        const next = {
	          ...current,
	          products: Array.isArray(result.products) ? result.products : current.products,
	          productOrigins: Array.isArray(result.productOrigins) ? result.productOrigins : current.productOrigins,
	          operationLogs: result.operationLog
	            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
	                arr.findIndex((item) => item.id === log.id) === idx
	              ).slice(0, MAX_OPERATION_LOGS)
	            : current.operationLogs,
	        };
	        lastSavedState.current = withoutUser(next);
	        return next;
	      });
	      settleMutation(mutationSession, "saved", 2000);
	      return {
	        ok: true,
	        mode: result.mode,
	        message: result.message,
	        references: result.references,
	      };
	    } catch (error) {
	      console.error("Failed to delete product:", error);
	      settleMutation(mutationSession, "error", 3000);
	      return { ok: false, error: error instanceof Error ? error.message : "删除商品失败，请重试" };
	    }
	  };

	  const saveStockChange = async (
	    change: StockChangeRequest
	  ): Promise<StockChangeResult> => {
	    clearTimeout(saveTimer.current);
	    if (saveAbort.current) {
	      saveAbort.current.abort();
      saveAbort.current = null;
    }

    const mutationSession = beginMutation();
    try {
      const response = await fetch(`${API}/stock/save`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          ...change,
          upsert: Array.isArray(change.upsert)
            ? change.upsert.map((item) => ({ ...item, siteId: normalizeSiteId(item.siteId ?? activeSiteId) }))
            : change.upsert,
          operator: state.user?.username ?? "system",
        }),
      });
      const result = await response.json();
      if (result.duplicateConfirmationRequired === true) {
        settleMutation(mutationSession, "idle");
        return {
          ok: false,
          error: String(result.error ?? "短时间内已提交过相同调整"),
          duplicateConfirmationRequired: true,
          duplicate: result.duplicate && typeof result.duplicate === "object" ? result.duplicate : undefined,
        };
      }
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      setStateForMutation(mutationSession, (current) => {
        const orderUpdates = new Map<string, Store["orders"][number]>(
          (Array.isArray(result.orderUpdates) ? result.orderUpdates : [])
            .map((order: Store["orders"][number]) => [order.id, order] as const)
        );
        const shipmentUpdates = new Map<string, Store["shipments"][number]>(
          (Array.isArray(result.shipmentUpdates) ? result.shipmentUpdates : [])
            .map((shipment: Store["shipments"][number]) => [shipment.id, shipment] as const)
        );
        const next = {
          ...current,
          stock: Array.isArray(result.stock) ? result.stock : current.stock,
          batches: Array.isArray(result.batches) ? result.batches : current.batches,
          orders: Array.isArray(result.orders)
            ? result.orders
            : orderUpdates.size > 0
              ? current.orders.map((order) => orderUpdates.get(order.id) ?? order)
              : current.orders,
          shipments: Array.isArray(result.shipments)
            ? result.shipments
            : shipmentUpdates.size > 0
              ? current.shipments.map((shipment) => shipmentUpdates.get(shipment.id) ?? shipment)
              : current.shipments,
	          operationLogs: result.operationLog
	            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
	                arr.findIndex((item) => item.id === log.id) === idx
	              ).slice(0, MAX_OPERATION_LOGS)
	            : current.operationLogs,
        };
        lastSavedState.current = withoutUser(next);
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return {
        ok: true,
        pendingApproval: result.pendingApproval === true,
        approvalRequestId: String(result.approvalRequestId ?? "") || undefined,
        message: String(result.message ?? "") || undefined,
      };
    } catch (error) {
      console.error("Failed to save stock:", error);
      settleMutation(mutationSession, "error", 3000);
	      const message = error instanceof Error ? error.message : "保存失败，请重试";
	      return {
	        ok: false,
	        error: message.replace(/^Failed to save stock:\s*/i, "") || "保存失败，请重试",
	      };
	    }
	  };

		  const saveMaintenanceAction = async (change: MaintenanceSaveChange): Promise<MaintenanceSaveResult> => {
	    clearTimeout(saveTimer.current);
	    if (saveAbort.current) {
	      saveAbort.current.abort();
	      saveAbort.current = null;
	    }

	    const mutationSession = beginMutation();
	    try {
	      const response = await fetch(`${API}/maintenance/save`, {
	        method: "POST",
	        headers: authJsonHeaders(),
	        body: JSON.stringify({
	          ...change,
	          operator: state.user?.username ?? "system",
	        }),
	      });
		      const result = await response.json().catch(() => ({}));
		      if (!response.ok || !result.ok) {
		        const failure = maintenanceSaveFailure(
		          result.error || `HTTP ${response.status}`,
		          response.status,
		          result.code,
		        );
		        console.error("Failed to save maintenance action:", failure.error);
		        settleMutation(mutationSession, "error", 3000);
		        return failure;
		      }

	      setStateForMutation(mutationSession, (current) => {
	        const next = {
	          ...current,
	          stock: Array.isArray(result.stockUpdates)
	            ? mergeIdUpdates(current.stock, result.stockUpdates)
	            : Array.isArray(result.stock) ? result.stock : current.stock,
	          batches: Array.isArray(result.batchUpdates)
	            ? mergeIdUpdates(current.batches, result.batchUpdates)
	            : Array.isArray(result.batches) ? result.batches : current.batches,
	          bioRecords: Array.isArray(result.bioRecordUpdates)
	            ? mergeIdUpdates(current.bioRecords, result.bioRecordUpdates)
	            : Array.isArray(result.bioRecords) ? result.bioRecords : current.bioRecords,
	          lossRecords: Array.isArray(result.lossRecordUpdates)
	            ? mergeIdUpdates(current.lossRecords, result.lossRecordUpdates)
	            : Array.isArray(result.lossRecords) ? result.lossRecords : current.lossRecords,
	          operationLogs: result.operationLog
	            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
	                arr.findIndex((item) => item.id === log.id) === idx
	              ).slice(0, MAX_OPERATION_LOGS)
	            : current.operationLogs,
	        };
	        lastSavedState.current = withoutUser(next);
	        return next;
	      });
	      settleMutation(mutationSession, "saved", 2000);
		      return { ok: true };
		    } catch (error) {
		      console.error("Failed to save maintenance action:", error);
		      settleMutation(mutationSession, "error", 3000);
		      return maintenanceSaveFailure(
		        error instanceof Error ? error.message : "维护保存失败，请重试",
		      );
		    }
	  };

  const saveBioRecordChange = async (change: BioRecordSaveChange): Promise<BioRecordSaveResult> => {
    if (bioSaveInFlight.current) {
      return { ok: false, error: "生物记录正在保存，请稍候", conflict: true };
    }
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    bioSaveInFlight.current = true;
    const mutationSession = beginMutation();
    try {
      const response = await fetch(`${API}/bio-records/save`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify(change),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        const error = new Error(result.error || `HTTP ${response.status}`) as Error & { conflict?: boolean };
        error.conflict = response.status === 409;
        throw error;
      }

      setStateForMutation(mutationSession, (current) => {
        const changedStockItem = result.stockItem && typeof result.stockItem === "object"
          ? result.stockItem as StockItem
          : null;
        const changedBioRecord = result.bioRecord && typeof result.bioRecord === "object"
          ? result.bioRecord
          : null;
        const deletedRecordId = String(result.deletedRecordId ?? "").trim();
        let nextBioRecords = current.bioRecords;
        if (changedBioRecord?.id) {
          const exists = current.bioRecords.some((record) => record.id === changedBioRecord.id);
          nextBioRecords = exists
            ? current.bioRecords.map((record) => record.id === changedBioRecord.id ? changedBioRecord : record)
            : [...current.bioRecords, changedBioRecord];
        } else if (deletedRecordId) {
          nextBioRecords = current.bioRecords.filter((record) => record.id !== deletedRecordId);
        }
        const next = {
          ...current,
          stock: changedStockItem
            ? current.stock.map((item) => item.id === changedStockItem.id ? changedStockItem : item)
            : current.stock,
          bioRecords: nextBioRecords,
          operationLogs: result.operationLog
            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, index, all) =>
                all.findIndex((item) => item.id === log.id) === index
              ).slice(0, MAX_OPERATION_LOGS)
            : current.operationLogs,
        };
        lastSavedState.current = withoutUser(next);
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return { ok: true };
    } catch (error) {
      console.error("Failed to save bio record:", error);
      settleMutation(mutationSession, "error", 3000);
      return {
        ok: false,
        error: error instanceof Error ? error.message : "生物记录保存失败，请重试",
        conflict: Boolean((error as Error & { conflict?: boolean })?.conflict),
      };
    } finally {
      bioSaveInFlight.current = false;
    }
  };

	  const saveTankGroupChange = async (change: {
	    mode: "upsertGroup" | "deleteGroup" | "upsertSubTank" | "deleteSubTank";
	    group?: TankGroup;
	    groupId?: string;
	    subTank?: SubTank;
	    subTankId?: string;
	  }): Promise<boolean> => {
	    clearTimeout(saveTimer.current);
	    if (saveAbort.current) {
	      saveAbort.current.abort();
	      saveAbort.current = null;
	    }

	    const mutationSession = beginMutation();
	    try {
	      const response = await fetch(`${API}/tank-groups/save`, {
	        method: "POST",
	        headers: authJsonHeaders(),
	        body: JSON.stringify({
	          ...change,
	          group: change.group ? { ...change.group, siteId: normalizeSiteId(change.group.siteId ?? activeSiteId) } : change.group,
	          operator: state.user?.username ?? "system",
	        }),
	      });
	      const result = await response.json();
	      if (!response.ok || !result.ok) {
	        throw new Error(result.error || `HTTP ${response.status}`);
	      }

	      setStateForMutation(mutationSession, (current) => {
	        const next = {
	          ...current,
	          tankGroups: Array.isArray(result.tankGroups) ? result.tankGroups : current.tankGroups,
	          operationLogs: result.operationLog
	            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
	                arr.findIndex((item) => item.id === log.id) === idx
	              ).slice(0, MAX_OPERATION_LOGS)
	            : current.operationLogs,
	        };
	        lastSavedState.current = withoutUser(next);
	        return next;
	      });
	      settleMutation(mutationSession, "saved", 2000);
	      return true;
	    } catch (error) {
	      console.error("Failed to save tank groups:", error);
	      settleMutation(mutationSession, "error", 3000);
	      return false;
	    }
	  };

		  const saveDailyLog = async (change: { log?: DailyLog; deleteId?: string }): Promise<boolean> => {
		    clearTimeout(saveTimer.current);
		    if (saveAbort.current) {
		      saveAbort.current.abort();
	      saveAbort.current = null;
	    }

	    const mutationSession = beginMutation();
	    try {
	      const response = await fetch(`${API}/daily-logs/save`, {
	        method: "POST",
	        headers: authJsonHeaders(),
	        body: JSON.stringify({
	          ...change,
	          operator: state.user?.username ?? "system",
	        }),
	      });
	      const result = await response.json();
	      if (!response.ok || !result.ok) {
	        throw new Error(result.error || `HTTP ${response.status}`);
	      }

		      setStateForMutation(mutationSession, (current) => {
		        const changedLog = result.changedLog && typeof result.changedLog === "object"
		          ? result.changedLog as DailyLog
		          : null;
		        const deletedLogId = String(result.deletedLogId ?? "").trim();
		        let nextLogs = current.logs;
		        if (changedLog?.id) {
		          nextLogs = current.logs.some((item) => item.id === changedLog.id)
		            ? current.logs.map((item) => item.id === changedLog.id ? changedLog : item)
		            : [...current.logs, changedLog];
		        } else if (deletedLogId) {
		          nextLogs = current.logs.filter((item) => item.id !== deletedLogId);
		        }
		        const deletedBioRecordIds = new Set(
		          (Array.isArray(result.deletedBioRecordIds) ? result.deletedBioRecordIds : [])
		            .map((id: unknown) => String(id ?? "").trim())
		            .filter(Boolean)
		        );
		        const remainingBioRecords = current.bioRecords.filter((record) => !deletedBioRecordIds.has(record.id));
		        const nextBioRecords = Array.isArray(result.bioRecordUpdates)
		          ? mergeIdUpdates(remainingBioRecords, result.bioRecordUpdates)
		          : remainingBioRecords;
		        const next = {
		          ...current,
		          logs: nextLogs,
		          bioRecords: nextBioRecords,
	          operationLogs: result.operationLog
	            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
	                arr.findIndex((item) => item.id === log.id) === idx
	              ).slice(0, MAX_OPERATION_LOGS)
	            : current.operationLogs,
	        };
	        lastSavedState.current = withoutUser(next);
	        return next;
	      });
	      settleMutation(mutationSession, "saved", 2000);
	      return true;
	    } catch (error) {
	      console.error("Failed to save daily logs:", error);
	      settleMutation(mutationSession, "error", 3000);
		      return false;
			    }
			  };

  const saveWaterQualitySettings = async (change: {
    parameters: WaterQualityParameterSetting[];
    assignments: WaterQualityTankGroupAssignment[];
  }): Promise<boolean> => {
    const mutationSession = beginMutation();
    try {
      const response = await fetch(`${API}/water-quality/settings/save`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify(change),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setStateForMutation(mutationSession, (current) => {
        const next = {
          ...current,
          systemSettings: result.systemSettings && typeof result.systemSettings === "object"
            ? { ...current.systemSettings, ...result.systemSettings }
            : current.systemSettings,
          tankGroups: Array.isArray(result.tankGroups) ? result.tankGroups : current.tankGroups,
          operationLogs: result.operationLog
            ? withServerOperationLog(result.operationLog, current.operationLogs)
            : current.operationLogs,
        };
        lastSavedState.current = withoutUser(next);
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return true;
    } catch (error) {
      console.error("Failed to save water quality settings:", error);
      settleMutation(mutationSession, "error", 3000);
      return false;
    }
  };

  const saveWaterQualityRecord = async (change: {
    record?: WaterQualityRecord;
    deleteId?: string;
  }): Promise<boolean> => {
    const mutationSession = beginMutation();
    try {
      const response = await fetch(`${API}/water-quality-records/save`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify(change),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setStateForMutation(mutationSession, (current) => {
        const next = {
          ...current,
          waterQualityRecords: Array.isArray(result.waterQualityRecords)
            ? result.waterQualityRecords
            : current.waterQualityRecords,
          operationLogs: result.operationLog
            ? withServerOperationLog(result.operationLog, current.operationLogs)
            : current.operationLogs,
        };
        lastSavedState.current = withoutUser(next);
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return true;
    } catch (error) {
      console.error("Failed to save water quality record:", error);
      settleMutation(mutationSession, "error", 3000);
      return false;
    }
  };

  const saveShipmentOutbound = async (change: {
    orderId: string;
    selectedItemIds: string[];
    shipMethod: "express" | "pickup";
    carrier?: string;
    shipDate: string;
    actualShippingFee?: number;
    notes?: string;
  }): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    const mutationSession = beginMutation();
    try {
      const response = await fetch(`${API}/shipments/outbound`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          ...change,
          operator: state.user?.username ?? "system",
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      setStateForMutation(mutationSession, (current) => {
        const next = {
          ...current,
          orders: Array.isArray(result.orders) ? result.orders : current.orders,
          shipments: Array.isArray(result.shipments) ? result.shipments : current.shipments,
          inventoryProjection: result.inventoryProjection ?? current.inventoryProjection,
          operationLogs: result.operationLog
            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
                arr.findIndex((item) => item.id === log.id) === idx
              ).slice(0, MAX_OPERATION_LOGS)
            : current.operationLogs,
        };
        lastSavedState.current = withoutUser(next);
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return true;
    } catch (error) {
      console.error("Failed to save outbound shipment:", error);
      settleMutation(mutationSession, "error", 3000);
      return false;
    }
  };

  const saveOrderPaymentChange = async (change: {
    orderId: string;
    action: "add" | "update" | "delete";
    payment?: PaymentRecord;
    paymentId?: string;
  }): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    const mutationSession = beginMutation();
    try {
      const response = await fetch(`${API}/orders/payment`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify(change),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      if (!isMutationSessionCurrent(mutationSession)) return false;

      setStateForMutation(mutationSession, (current) => {
        const next = normalizePersistedState(
          {
            ...withoutUser(current),
            orders: Array.isArray(result.orders) ? result.orders : current.orders,
            operationLogs: withServerOperationLog(result.operationLog, current.operationLogs),
          },
          current.user
        );
        lastSavedState.current = withoutUser(next);
        return next;
      });
      setLoadedKeys((current) => {
        const next = new Set(current);
        next.add("orders");
        loadedKeysRef.current = next;
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return true;
    } catch (error) {
      console.error("Failed to save order payment:", error);
      settleMutation(mutationSession, "error", 3000);
      return false;
    }
  };

  const postPersonnelMutation = async (path: string, body: unknown): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    const mutationSession = beginMutation();
    try {
      const response = await fetch(`${API}${path}`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }
      if (!isMutationSessionCurrent(mutationSession)) return false;
      let replacementUser: User = null;
      if (result.token && result.user) {
        const currentUser = stateRef.current.user;
        const returnedUsername = String(result.user.username ?? "").trim();
        const returnedRole = result.user.role === "admin" ? "admin" : "staff";
        const retainedAccount = currentUser?.account && returnedUsername
          ? {
              ...currentUser.account,
              username: returnedUsername,
              accessRole: returnedRole,
              accountEnabled: true,
            }
          : undefined;
        replacementUser = userFromAuthMeResponse({
          ...result,
          account: result.account ?? retainedAccount,
        }, currentUser);
        if (!replacementUser) throw new Error("登录身份更新失败，请重新登录");
        saveAuthSession(replacementUser, result.token, result.expiresAt);
        mutationSession.authSessionKey = authSessionDependencyKey();
      }

      setStateForMutation(mutationSession, (current) => {
        const next = normalizePersistedState(
          {
            ...withoutUser(current),
            personnel: Array.isArray(result.personnel) ? result.personnel : current.personnel,
            orders: Array.isArray(result.orders) ? result.orders : current.orders,
            operationLogs: withServerOperationLog(result.operationLog, current.operationLogs),
          },
          replacementUser ?? current.user
        );
        lastSavedState.current = withoutUser(next);
        return next;
      });
      setLoadedKeys((current) => {
        const next = new Set(current);
        next.add("personnel");
        if (Array.isArray((result as any).orders)) next.add("orders");
        loadedKeysRef.current = next;
        return next;
      });
      settleMutation(mutationSession, "saved", 2000);
      return true;
    } catch (error) {
      console.error("Failed to save personnel mutation:", error);
      settleMutation(mutationSession, "error", 3000);
      return false;
    }
  };

  const savePersonnelAccount = (personnel: Personnel): Promise<boolean> =>
    postPersonnelMutation("/personnel/save", { personnel });

  const resignPersonnelAccount = (id: string): Promise<boolean> =>
    postPersonnelMutation("/personnel/resign", { id });

  const deletePersonnelAccount = (id: string): Promise<boolean> =>
    postPersonnelMutation("/personnel/delete", { id });

  const savePersonnelPermissions = (id: string, permissions: PermissionSet): Promise<boolean> =>
    postPersonnelMutation("/personnel/permissions", { id, permissions });

  const changePersonnelPassword = (change: { targetId?: string; oldPassword?: string; newPassword: string }): Promise<boolean> =>
    postPersonnelMutation("/personnel/password", change);

  const refreshBusinessState = async () => {
    const currentUser = stateRef.current.user;
    if (
      !currentUser ||
      refreshInProgress.current ||
      saveStatusRef.current === "saving" ||
      hasActiveEditingSurface()
    ) return;
    refreshInProgress.current = true;
    try {
      await loadViewState(viewRef.current, { force: true });
    } catch (error) {
      console.error("Failed to refresh business state:", error);
    } finally {
      refreshInProgress.current = false;
    }
  };

  const refreshIfStateChanged = async () => {
    if (
      !stateRef.current.user ||
      versionCheckInProgress.current ||
      saveStatusRef.current === "saving" ||
      hasActiveEditingSurface()
    ) return;
    const requestedUserKey = currentUserKeyRef.current;
    const requestEpoch = stateRequestEpochRef.current;
    if (!requestedUserKey) return;
    const controller = new AbortController();
    stateRequestControllersRef.current.add(controller);
    versionCheckInProgress.current = true;
    try {
      const response = await fetch(`${API}/state/version`, {
        headers: authJsonHeaders(),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({}));
      const requestIsCurrent = isCurrentStateRequest(
        requestedUserKey,
        currentUserKeyRef.current,
        requestEpoch,
        stateRequestEpochRef.current
      );
      if (!requestIsCurrent) return;
      if (!response.ok) {
        if (response.status === 401) {
          clearAuthSession();
          invalidateStateReadRequests();
          setStateBase((current) => userDependencyKey(current.user) === requestedUserKey
            ? normalizePersistedState(EMPTY_PERSISTED_STATE, null)
            : current);
        }
        return;
      }
      const version = String(result.version ?? "");
      if (!hasStateVersionChanged(stateVersionRef.current, version)) return;
      await refreshBusinessState();
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      console.error("Failed to check state version:", error);
    } finally {
      stateRequestControllersRef.current.delete(controller);
      if (
        isCurrentStateRequest(
          requestedUserKey,
          currentUserKeyRef.current,
          requestEpoch,
          stateRequestEpochRef.current
        )
      ) {
        versionCheckInProgress.current = false;
      }
    }
  };

  // ── Validate the saved backend session on mount; login credentials are checked by the server. ──
  useEffect(() => {
    if (isPublicSite) {
      setStateBase(() => normalizePersistedState(EMPTY_PERSISTED_STATE, null));
      setLoadedKeys(new Set<PersistedKey>());
      setLoading(false);
      return;
    }

    const sessionUser = restoreUserFromSession();
    if (!sessionUser) {
      setStateBase(() => normalizePersistedState(EMPTY_PERSISTED_STATE, null));
      setLoadedKeys(new Set<PersistedKey>());
      setLoading(false);
      return;
    }

    fetchAuthMeWithRetry()
      .then(async (r) => {
        const result = await r.json().catch(() => ({}));
        if (!r.ok || !result.user) throw new Error(result.error || `HTTP ${r.status}`);
        return result;
      })
      .then((result) => {
        const restoredUser = userFromAuthMeResponse(result, sessionUser);
        if (!restoredUser || (restoredUser.role === "staff" && !restoredUser.account?.accountEnabled)) {
          throw new Error("Authenticated account permission summary is missing");
        }
        setStateBase(() => normalizePersistedState(EMPTY_PERSISTED_STATE, restoredUser));
        setLoadedKeys(new Set<PersistedKey>());
      })
      .catch((e) => {
        console.error("Failed to validate auth session:", e);
        clearAuthSession();
        setStateBase(() => normalizePersistedState(EMPTY_PERSISTED_STATE, null));
        setLoadedKeys(new Set<PersistedKey>());
      })
      .finally(() => setLoading(false));
  }, [isPublicSite]);

  // Fresh logins first receive a token and public user identity. Hydrate the
  // account permission summary independently instead of loading personnel.
  useEffect(() => {
    if (isPublicSite || loading || !state.user || state.user.account) return;
    const requestedUserKey = currentUserKey;
    const requestedRole = state.user.role;
    let cancelled = false;

    fetchAuthMeWithRetry()
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.user) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
      })
      .then((result) => {
        if (cancelled) return;
        const hydratedUser = userFromAuthMeResponse(result, stateRef.current.user);
        if (!hydratedUser || !hydratedUser.account?.accountEnabled ||
            hydratedUser.account.accessRole !== hydratedUser.role) {
          throw new Error("Authenticated account permission summary is missing");
        }
        setStateBase((current) => {
          if (userDependencyKey(current.user) !== requestedUserKey) return current;
          return {
            ...current,
            user: normalizeUserWithSiteScope(hydratedUser, current.personnel, getSites(current)),
          };
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load authenticated account permissions:", error);
        if (requestedRole === "staff") {
          clearAuthSession();
          setStateBase((current) => userDependencyKey(current.user) === requestedUserKey
            ? { ...current, user: null }
            : current);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isPublicSite, loading, currentUserKey, state.user?.account?.username]);

  useEffect(() => {
    const previousUserKey = previousUserKeyRef.current;
    previousUserKeyRef.current = currentUserKey;
    mutationSessionGenerationRef.current += 1;
    mutationStatusSequenceRef.current += 1;
    if (saveStatusTimerRef.current !== null) {
      window.clearTimeout(saveStatusTimerRef.current);
      saveStatusTimerRef.current = null;
    }
    saveStatusRef.current = "idle";
    setSaveStatus("idle");
    pageLoadRequestRef.current += 1;
    invalidateStateReadRequests();
    stateLoadStarted.current = false;
    loadedViewRef.current = null;
    setLoadedViewState(null);
    stateVersionRef.current = "";
    lastSavedState.current = null;
    loadedKeysRef.current = new Set<PersistedKey>();
    setLoadedKeys(new Set<PersistedKey>());
    setStateLoaded(false);
    setStateLoadError("");
    setOpenOrderRequest(null);
    setBatchDetailRequest(null);
    if (!state.user) {
      setStateBase((current) => current.user
        ? current
        : normalizePersistedState(EMPTY_PERSISTED_STATE, null));
    } else if (previousUserKey && previousUserKey !== currentUserKey) {
      setStateBase((current) => userDependencyKey(current.user) === currentUserKey
        ? normalizePersistedState(EMPTY_PERSISTED_STATE, current.user)
        : current);
    }
  }, [currentUserKey]);

  useEffect(() => {
    if (!state.user) return;
    const expiresAt = getAuthSessionExpiresAt();
    if (!expiresAt) return;
    const timeoutMs = expiresAt - Date.now();
    if (timeoutMs <= 0) {
      clearAuthSession();
      setStateBase((s) => ({ ...s, user: null }));
      return;
    }
    const timer = window.setTimeout(() => {
      clearAuthSession();
      setStateBase((s) => ({ ...s, user: null }));
    }, timeoutMs);
    return () => window.clearTimeout(timer);
  }, [currentUserKey]);

  // ── Load only the current page's business data after a successful login. ──
  useEffect(() => {
    if (!state.user || !permissionSummaryReady || stateLoaded || stateLoadStarted.current) return;
    const requestedUserKey = currentUserKeyRef.current;
    const requestEpoch = stateRequestEpochRef.current;
    const requestId = ++pageLoadRequestRef.current;
    let cancelled = false;
    const requestIsCurrent = () => !cancelled &&
      pageLoadRequestRef.current === requestId &&
      isCurrentStateRequest(
        requestedUserKey,
        currentUserKeyRef.current,
        requestEpoch,
        stateRequestEpochRef.current,
      );
    stateLoadStarted.current = true;
    setStateLoading(true);
    setStateLoadError("");
    loadViewState(view, { force: true })
      .then((ok) => {
        if (!requestIsCurrent()) return;
        if (!ok) throw new Error("Failed to load initial view state");
        loadedViewRef.current = view;
        setLoadedViewState({ view, userKey: requestedUserKey });
        setStateLoaded(true);
      })
      .catch((e) => {
        if (!requestIsCurrent()) return;
        console.error("Failed to load state:", e);
        loadedViewRef.current = null;
        setStateLoadError("当前页面数据加载失败，请检查网络后重试。");
      })
      .finally(() => {
        if (requestIsCurrent()) setStateLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentUserKey, permissionSummaryReady, stateLoaded, stateLoadAttempt]);

  useEffect(() => {
    if (!state.user || !stateLoaded) return;
    if (saveStatusRef.current === "saving") return;
    if (loadedViewRef.current === view) return;
    const requestedView = view;
    const requestedUserKey = currentUserKeyRef.current;
    const requestEpoch = stateRequestEpochRef.current;
    const requestId = ++pageLoadRequestRef.current;
    let cancelled = false;
    const requestIsCurrent = () => !cancelled &&
      pageLoadRequestRef.current === requestId &&
      viewRef.current === requestedView &&
      isCurrentStateRequest(
        requestedUserKey,
        currentUserKeyRef.current,
        requestEpoch,
        stateRequestEpochRef.current,
      );
    setStateLoadError("");
    void loadViewState(requestedView, { force: true, showLoading: true })
      .then((ok) => {
        if (!requestIsCurrent()) return;
        if (!ok) throw new Error("Failed to load view state");
        loadedViewRef.current = requestedView;
        setLoadedViewState({ view: requestedView, userKey: requestedUserKey });
      })
      .catch((error) => {
        if (!requestIsCurrent()) return;
        console.error("Failed to load view state:", error);
        setStateLoadError("当前页面数据加载失败，请检查网络后重试。");
      });
    return () => {
      cancelled = true;
    };
  }, [view, currentUserKey, stateLoaded, stateLoadAttempt, saveStatus]);

  useEffect(() => {
    if (!state.user || !stateLoaded) return;
    let lastRefreshAt = 0;
    let refreshTimer = 0;
    const refreshIfDue = () => {
      const now = Date.now();
      if (now - lastRefreshAt < 5000) return;
      lastRefreshAt = now;
      void refreshIfStateChanged();
    };
    const scheduleRefresh = () => {
      refreshTimer = window.setTimeout(async () => {
        await refreshIfStateChanged();
        scheduleRefresh();
      }, 55_000 + Math.floor(Math.random() * 10_001));
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshIfDue();
    };
    window.addEventListener("focus", refreshIfDue);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleRefresh();
    return () => {
      window.removeEventListener("focus", refreshIfDue);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearTimeout(refreshTimer);
    };
  }, [currentUserKey, stateLoaded]);

  const setState: Dispatch<SetStateAction<Store>> = (value) => {
    invalidateStateReadRequests();
    setStateBase((prev) => {
      const next = typeof value === "function" ? (value as (s: Store) => Store)(prev) : value;
      if (!next.user) return normalizePersistedState(EMPTY_PERSISTED_STATE, null);
      if (userDependencyKey(prev.user) !== userDependencyKey(next.user)) {
        return normalizePersistedState(EMPTY_PERSISTED_STATE, next.user);
      }
      return next;
    });
  };

  const accessibleSiteIds = useMemo(
    () => visibleSitesForUser(state.user, state).map((site) => site.id),
    [currentUserKey, state.sites]
  );

  useEffect(() => {
    if (!state.user) return;
    if (canUserAccessSite(state.user, state, activeSiteId)) return;
    setActiveSiteId(accessibleSiteIds[0] ?? DEFAULT_SITE_ID);
  }, [currentUserKey, state.sites, activeSiteId, accessibleSiteIds, setActiveSiteId]);

  const scopedSiteId = state.user && !canUserAccessSite(state.user, state, activeSiteId)
    ? accessibleSiteIds[0] ?? DEFAULT_SITE_ID
    : activeSiteId;

  const visibleState = useMemo(
    () => state.user ? scopedStoreForSite(state, scopedSiteId) : state,
    [state, scopedSiteId]
  );

  const renderView = () => {
    switch (view) {
      case "dashboard":  return <Dashboard />;
      case "notifications": return <NotificationCenterView onOpenOrder={requestOpenOrder} />;
      case "species":    return <SpeciesView />;
      case "products":   return <ProductsView />;
      case "tankGroups": return <TankGroupsView />;
      case "batches":    return (
        <BatchesView
          onOpenOrder={requestOpenOrder}
          detailRequest={batchDetailRequest?.userKey === currentUserKey ? batchDetailRequest.request : null}
          onDetailRequestChange={(request: BatchDetailRequest | null) => {
            setBatchDetailRequest(request ? { userKey: currentUserKey, request } : null);
          }}
        />
      );
      case "stockIn":    return <StockInView allOrders={state.orders} onOpenOrder={requestOpenOrder} />;
      case "daily":      return (
        <DailyView
          allTankGroups={state.tankGroups}
          allOrders={state.orders}
          allShipments={state.shipments}
          onOpenOrder={requestOpenOrder}
        />
      );
      case "lossRecords": return <LossRecordsView />;
      case "customers":  return <CustomersView />;
      case "orders":     return (
        <OrdersView
          allStock={state.stock}
          allTankGroups={state.tankGroups}
          openOrderRequest={openOrderRequest}
          onOpenOrderRequestHandled={finishOpenOrderRequest}
        />
      );
      case "catalogManagement": return <CatalogManagementView />;
      case "finance":    return <FinanceView />;
      case "paymentMethods": return <PaymentMethodsView />;
      case "shippingCarriers": return <ShippingCarriersView />;
      case "waterQualitySettings": return <WaterQualitySettingsView />;
      case "categorySettings": return <CategorySettingsView />;
      case "profile":    return <PersonalCenterView />;
      case "permissions": return <PersonnelAdminView />;
      case "operationLogs": return <OperationLogsView />;
      default:           return <PersonalCenterView />;
    }
  };

  function requestOpenOrder(orderId: string, siteId?: string) {
    const current = stateRef.current;
    if (!current.user) return;
    const targetOrder = current.orders.find((order) => order.id === orderId);
    const navigation = buildLinkedOrderNavigation({
      orderId,
      requestedSiteId: siteId,
      cachedOrderSiteId: targetOrder ? normalizeSiteId(targetOrder.siteId) : undefined,
      activeSiteId,
      sourceView: viewRef.current,
      canAccessSite: (targetSiteId) => canUserAccessSite(current.user, current, targetSiteId),
    });
    if (!navigation) {
      toast.error("订单不存在或无权查看所属场地");
      return;
    }
    const { targetSiteId, ...request } = navigation;
    if (targetSiteId !== activeSiteId) setActiveSiteId(targetSiteId);
    orderRequestSequence.current += 1;
    setOpenOrderRequest({ ...request, requestId: orderRequestSequence.current });
    setView("orders");
  }

  function finishOpenOrderRequest() {
    const returnView = openOrderRequest?.returnView;
    const returnSiteId = openOrderRequest?.returnSiteId;
    setOpenOrderRequest(null);
    const current = stateRef.current;
    if (!current.user) return;
    if (returnSiteId && returnSiteId !== activeSiteId &&
        canUserAccessSite(current.user, current, returnSiteId)) setActiveSiteId(returnSiteId);
    if (returnView) setView(returnView);
  }

  const handleSetView = (nextView: ViewKey) => {
    const allowedView = resolveDashboardView(nextView, state.user);
    if (allowedView !== "orders") setOpenOrderRequest(null);
    if (allowedView === viewRef.current) {
      loadedViewRef.current = null;
      setLoadedViewState(null);
      setStateLoadError("");
      setStateLoadAttempt((attempt) => attempt + 1);
      return;
    }
    setView(allowedView);
  };

  const loadingView = viewLoading || Boolean(
    state.user && (!permissionSummaryReady || stateLoading || !stateLoaded ||
      !isViewStateReady(loadedViewState, view, currentUserKey))
  );
  const viewContent = stateLoadError ? (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-4 text-center">
      <div className="text-sm text-red-600">{stateLoadError}</div>
      <button
        type="button"
        className="rounded-md border bg-white px-4 py-2 text-sm font-medium shadow-sm hover:bg-slate-50"
        onClick={() => {
          stateLoadStarted.current = false;
          setStateLoadError("");
          setStateLoadAttempt((attempt) => attempt + 1);
        }}
      >
        重新加载
      </button>
    </div>
  ) : loadingView ? (
    <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
      正在加载当前页面数据…
    </div>
  ) : renderView();

  if (loading) {
    return (
      <div className="size-full min-h-screen flex items-center justify-center bg-slate-50">
        <LogoLoader label="正在加载登录信息…" />
      </div>
    );
  }

	  return (
			    <StoreContext.Provider value={{ state: visibleState, activeSiteId, setActiveSiteId, setState, savePatch, saveProduct, deleteProduct, saveStockChange, saveMaintenanceAction, saveBioRecordChange, saveTankGroupChange, saveDailyLog, saveWaterQualitySettings, saveWaterQualityRecord, saveShipmentOutbound, saveOrderPaymentChange, savePersonnelAccount, resignPersonnelAccount, deletePersonnelAccount, savePersonnelPermissions, changePersonnelPassword, saveStateTransform }}>
      {isPublicSite ? (
        <PublicCatalogPage />
      ) : !state.user ? (
        <Login />
      ) : (
        <Layout view={view} setView={handleSetView} saveStatus={saveStatus}>
          <div key={`${activeSiteId}:${view}`}>{viewContent}</div>
        </Layout>
      )}
      <Toaster position="top-center" />
    </StoreContext.Provider>
  );
}

export default function App() {
  return <AdminApp />;
}
