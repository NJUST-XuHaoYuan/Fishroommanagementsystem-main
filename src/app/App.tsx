import { useState, useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { StoreContext, initialState, DEFAULT_FISH_LIST_FOOTER_TEXT, DEFAULT_ORDER_PACKAGING_FEE, DEFAULT_PAYMENT_METHOD_SETTINGS, DEFAULT_SHIPPING_CARRIER_SETTINGS, DEFAULT_WATER_QUALITY_PARAMETERS, DailyLog, OperationLog, PaymentRecord, PermissionSet, Personnel, Product, ProductDeleteResult, StockChangeRequest, StockChangeResult, StockItem, StockStatus, Store, TankGroup, SubTank, User, WaterQualityParameterSetting, WaterQualityRecord, WaterQualityTankGroupAssignment, isPersonnelAccountEnabled, normalizePaymentMethodSettings, normalizeShippingCarrierSettings, normalizeSpeciesCategoryMajorMap, normalizeWaterQualityParameters, waterQualityParameterIdsForGroup, uid } from "./store";
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
import { authJsonHeaders, clearAuthSession, getAuthSessionExpiresAt, getValidAuthSession, saveAuthSession } from "./utils/authSession";
import { DEFAULT_SITE_ID, DEFAULT_SITES, canUserAccessSite, getSites, matchesSite, normalizeSiteId, normalizeVisibleSiteIds, visibleSitesForUser } from "./utils/sites";

const API = "/api";
const MAX_OPERATION_LOGS = 10000;

const AUDIT_COLLECTIONS: { key: keyof Store; module: string }[] = [
  { key: "systemSettings", module: "系统设置" },
  { key: "sites", module: "场地管理" },
  { key: "species", module: "物种管理" },
  { key: "speciesCategories", module: "分类管理" },
  { key: "speciesCategoryMajorMap", module: "分类管理" },
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
type LinkedOrderSourceView = Extract<ViewKey, "stockIn" | "daily" | "notifications">;
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
  batches: ["batches", "stock", "orders", "shipments"],
  stockIn: ["species", "products", "tankGroups", "batches", "stock", "orders", "shipments"],
  daily: ["systemSettings", "products", "tankGroups", "batches", "stock", "orders", "shipments", "logs", "waterQualityRecords", "bioRecords", "personnel"],
  lossRecords: ["lossRecords", "stock", "products", "species", "batches", "tankGroups"],
  customers: ["customers", "customerSources", "orders", "shipments"],
  orders: ["systemSettings", "orders", "customers", "customerSources", "stock", "products", "species", "tankGroups", "shipments", "bioRecords", "personnel"],
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
    next[key] = next[key].map((item: Record<string, unknown>) => ({
      ...item,
      siteId: normalizeSiteId(item.siteId ?? normalizedSiteId),
    }));
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
  const stockIds = new Set(stock.map((item) => item.id));
  return {
    ...state,
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
  const migratedProducts = Array.isArray(migratedData.products)
    ? migratedData.products.map((product: Record<string, unknown>) => ({
        ...product,
        publicVisible: product.publicVisible !== false,
        notes: String(product.notes ?? ""),
      }))
    : migratedData.products;
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

function findChangedKeys(before: PersistedStore, after: PersistedStore): PersistedKey[] {
  return PERSISTED_KEYS.filter((key) =>
    JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)
  );
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
  const [view, setView] = useState<ViewKey>("dashboard");
  const [loading, setLoading] = useState(true);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [stateLoading, setStateLoading] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [loadedKeys, setLoadedKeys] = useState<Set<PersistedKey>>(() => new Set());
  const [openOrderRequest, setOpenOrderRequest] = useState<OpenOrderRequest | null>(null);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [activeSiteId, setActiveSiteIdBase] = useState(() => {
    try {
      return normalizeSiteId(window.localStorage.getItem("fishroom-active-site"));
    } catch {
      return DEFAULT_SITE_ID;
    }
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const saveAbort = useRef<AbortController | null>(null);
  const stateLoadStarted = useRef(false);
  const lastSavedState = useRef<PersistedStore | null>(null);
  const persistQueue = useRef<Promise<void>>(Promise.resolve());
  const stateRef = useRef(state);
  const saveStatusRef = useRef(saveStatus);
  const refreshInProgress = useRef(false);
  const orderRequestSequence = useRef(0);
  const loadedKeysRef = useRef<Set<PersistedKey>>(new Set());
  const viewRef = useRef(view);
  const currentUserKey = userDependencyKey(state.user);
  const permissionSummaryReady = !state.user || state.user.role === "admin" || Boolean(
    state.user.account?.accountEnabled &&
    state.user.account.username === state.user.username &&
    state.user.account.accessRole === state.user.role
  );

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
    if (!stateRef.current.user) return false;

    if (options.showLoading) setViewLoading(true);
    try {
      const query = encodeURIComponent(keysToFetch.join(","));
      const lite = options.liteSpecies && keysToFetch.includes("species") ? "&lite=species" : "";
      const response = await fetch(`${API}/state/slice?keys=${query}${lite}`, { headers: authJsonHeaders() });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(result.error || `HTTP ${response.status}`);
        (error as Error & { status?: number }).status = response.status;
        throw error;
      }
      const data = result.data ?? {};
      setStateBase((current) => {
        if (!current.user) return current;
        const normalized = normalizePersistedState(
          { ...withoutUser(current), ...data },
          current.user
        );
        lastSavedState.current = withoutUser(normalized);
        return normalized;
      });
      setLoadedKeys((current) => {
        const next = new Set(current);
        keysToFetch.forEach((key) => next.add(key));
        loadedKeysRef.current = next;
        return next;
      });
      return true;
    } catch (error) {
      console.error("Failed to load state slice:", error);
      if ((error as Error & { status?: number })?.status === 401) {
        clearAuthSession();
        stateLoadStarted.current = false;
        lastSavedState.current = null;
        loadedKeysRef.current = new Set<PersistedKey>();
        setLoadedKeys(new Set<PersistedKey>());
        setStateLoaded(false);
        setStateBase(() => normalizePersistedState(EMPTY_PERSISTED_STATE, null));
      }
      return false;
    } finally {
      if (options.showLoading) setViewLoading(false);
    }
  };

  const loadViewState = (targetView: ViewKey, options: StateLoadOptions = {}) =>
    loadStateKeys(VIEW_STATE_KEYS[targetView] ?? [], {
      ...options,
      liteSpecies: options.liteSpecies ?? !["species", "products"].includes(targetView),
    });

  const postStatePatch = async (
    patch: Partial<PersistedStore>,
    _operationLogs: OperationLog[] = [],
    basePatch: Partial<PersistedStore> = {}
  ): Promise<{ appliedOperationLogs?: OperationLog[] }> => {
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

    setSaveStatus("saving");
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
      lastSavedState.current = {
        ...(lastSavedState.current ?? currentStateToSave),
        ...patch,
        operationLogs: currentStateToSave.operationLogs,
      };
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (error) {
      console.error("Failed to save manual change:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
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

    setSaveStatus("saving");
    try {
      const { operationLogs: patchLogs, ...statePatch } = patch;
      const scopedStatePatch = fillMissingSiteFields(statePatch, activeSiteId);
      const basePatch = Object.keys(statePatch).reduce<Partial<PersistedStore>>((acc, key) => {
        (acc as any)[key] = (withoutUser(stateRef.current) as any)[key];
        return acc;
      }, {});
      const result = await postStatePatch(scopedStatePatch, Array.isArray(patchLogs) ? patchLogs : [], basePatch);
      setStateBase((current) => {
        const next = normalizePersistedState(
          {
            ...withoutUser(current),
            ...scopedStatePatch,
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
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      console.error("Failed to save patch:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
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

    setSaveStatus("saving");
    try {
      const currentPersisted = withoutUser(stateRef.current);
      const transformed = fillMissingSiteFields(transform(currentPersisted), activeSiteId);
      const changedKeys = findChangedKeys(currentPersisted, transformed);
      const previousWithUser = { ...currentPersisted, user: stateRef.current.user } as Store;
      const nextWithUser = { ...transformed, user: state.user } as Store;
      const logs = buildOperationLogs(previousWithUser, nextWithUser, changedKeys);
      if (changedKeys.length === 0 && logs.length === 0) {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
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

      setStateBase((current) => {
        const appliedLogs = result.appliedOperationLogs ?? logs;
        const next = normalizePersistedState(
          {
            ...withoutUser(current),
            ...patch,
            operationLogs: [...appliedLogs, ...(current.operationLogs ?? [])]
              .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
              .slice(0, MAX_OPERATION_LOGS),
          },
          current.user
        );
        lastSavedState.current = withoutUser(next);
        return next;
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      console.error("Failed to save transformed state:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
      return false;
    }
  };

  const saveProduct = async (product: Product): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    setSaveStatus("saving");
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
      setStateBase((current) => {
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
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      console.error("Failed to save product:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
      return false;
    }
  };

	  const deleteProduct = async (productId: string): Promise<ProductDeleteResult> => {
	    clearTimeout(saveTimer.current);
	    setSaveStatus("saving");
	    try {
	      const response = await fetch(`${API}/products/delete`, {
	        method: "POST",
	        headers: authJsonHeaders(),
	        body: JSON.stringify({ productId }),
	      });
	      const result = await response.json().catch(() => ({}));
	      if (!response.ok || !result.ok) {
	        setSaveStatus("error");
	        setTimeout(() => setSaveStatus("idle"), 3000);
	        return {
	          ok: false,
	          error: result.error || `HTTP ${response.status}`,
	          references: result.references,
	        };
	      }

	      setStateBase((current) => {
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
	      setSaveStatus("saved");
	      setTimeout(() => setSaveStatus("idle"), 2000);
	      return {
	        ok: true,
	        mode: result.mode,
	        message: result.message,
	        references: result.references,
	      };
	    } catch (error) {
	      console.error("Failed to delete product:", error);
	      setSaveStatus("error");
	      setTimeout(() => setSaveStatus("idle"), 3000);
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

    setSaveStatus("saving");
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
        setSaveStatus("idle");
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
      setStateBase((current) => {
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
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return {
        ok: true,
        pendingApproval: result.pendingApproval === true,
        approvalRequestId: String(result.approvalRequestId ?? "") || undefined,
        message: String(result.message ?? "") || undefined,
      };
    } catch (error) {
      console.error("Failed to save stock:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
	      const message = error instanceof Error ? error.message : "保存失败，请重试";
	      return {
	        ok: false,
	        error: message.replace(/^Failed to save stock:\s*/i, "") || "保存失败，请重试",
	      };
	    }
	  };

	  const saveMaintenanceAction = async (change:
	    | { mode: "record"; itemIds: string[]; recordDate: string; recordText?: string; recordPhotos: string[]; recordVideos: string[] }
	    | { mode: "move"; itemIds: string[]; targetSubTankId: string; moveDate?: string; moveNotes?: string }
	    | { mode: "status"; itemIds: string[]; targetStatus: StockStatus }
	    | { mode: "loss"; stockItemId?: string; itemIds?: string[]; lossDate: string; lossReason?: string; lossProof: string[] }
	  ): Promise<boolean> => {
	    clearTimeout(saveTimer.current);
	    if (saveAbort.current) {
	      saveAbort.current.abort();
	      saveAbort.current = null;
	    }

	    setSaveStatus("saving");
	    try {
	      const response = await fetch(`${API}/maintenance/save`, {
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

	      setStateBase((current) => {
	        const next = {
	          ...current,
	          stock: Array.isArray(result.stock) ? result.stock : current.stock,
	          batches: Array.isArray(result.batches) ? result.batches : current.batches,
	          bioRecords: Array.isArray(result.bioRecords) ? result.bioRecords : current.bioRecords,
	          lossRecords: Array.isArray(result.lossRecords) ? result.lossRecords : current.lossRecords,
	          operationLogs: result.operationLog
	            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
	                arr.findIndex((item) => item.id === log.id) === idx
	              ).slice(0, MAX_OPERATION_LOGS)
	            : current.operationLogs,
	        };
	        lastSavedState.current = withoutUser(next);
	        return next;
	      });
	      setSaveStatus("saved");
	      setTimeout(() => setSaveStatus("idle"), 2000);
	      return true;
	    } catch (error) {
	      console.error("Failed to save maintenance action:", error);
	      setSaveStatus("error");
	      setTimeout(() => setSaveStatus("idle"), 3000);
	      return false;
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

	    setSaveStatus("saving");
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

	      setStateBase((current) => {
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
	      setSaveStatus("saved");
	      setTimeout(() => setSaveStatus("idle"), 2000);
	      return true;
	    } catch (error) {
	      console.error("Failed to save tank groups:", error);
	      setSaveStatus("error");
	      setTimeout(() => setSaveStatus("idle"), 3000);
	      return false;
	    }
	  };

		  const saveDailyLog = async (change: { log?: DailyLog; deleteId?: string }): Promise<boolean> => {
		    clearTimeout(saveTimer.current);
		    if (saveAbort.current) {
		      saveAbort.current.abort();
	      saveAbort.current = null;
	    }

	    setSaveStatus("saving");
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

	      setStateBase((current) => {
	        const next = {
	          ...current,
	          logs: Array.isArray(result.logs) ? result.logs : current.logs,
	          bioRecords: Array.isArray(result.bioRecords) ? result.bioRecords : current.bioRecords,
	          operationLogs: result.operationLog
	            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
	                arr.findIndex((item) => item.id === log.id) === idx
	              ).slice(0, MAX_OPERATION_LOGS)
	            : current.operationLogs,
	        };
	        lastSavedState.current = withoutUser(next);
	        return next;
	      });
	      setSaveStatus("saved");
	      setTimeout(() => setSaveStatus("idle"), 2000);
	      return true;
	    } catch (error) {
	      console.error("Failed to save daily logs:", error);
	      setSaveStatus("error");
	      setTimeout(() => setSaveStatus("idle"), 3000);
		      return false;
			    }
			  };

  const saveWaterQualitySettings = async (change: {
    parameters: WaterQualityParameterSetting[];
    assignments: WaterQualityTankGroupAssignment[];
  }): Promise<boolean> => {
    setSaveStatus("saving");
    try {
      const response = await fetch(`${API}/water-quality/settings/save`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify(change),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setStateBase((current) => {
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
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      console.error("Failed to save water quality settings:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
      return false;
    }
  };

  const saveWaterQualityRecord = async (change: {
    record?: WaterQualityRecord;
    deleteId?: string;
  }): Promise<boolean> => {
    setSaveStatus("saving");
    try {
      const response = await fetch(`${API}/water-quality-records/save`, {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify(change),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setStateBase((current) => {
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
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      console.error("Failed to save water quality record:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
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

    setSaveStatus("saving");
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

      setStateBase((current) => {
        const next = {
          ...current,
          orders: Array.isArray(result.orders) ? result.orders : current.orders,
          shipments: Array.isArray(result.shipments) ? result.shipments : current.shipments,
          operationLogs: result.operationLog
            ? [result.operationLog, ...(current.operationLogs ?? [])].filter((log, idx, arr) =>
                arr.findIndex((item) => item.id === log.id) === idx
              ).slice(0, MAX_OPERATION_LOGS)
            : current.operationLogs,
        };
        lastSavedState.current = withoutUser(next);
        return next;
      });
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      console.error("Failed to save outbound shipment:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
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

    setSaveStatus("saving");
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

      setStateBase((current) => {
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
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      console.error("Failed to save order payment:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
      return false;
    }
  };

  const postPersonnelMutation = async (path: string, body: unknown): Promise<boolean> => {
    clearTimeout(saveTimer.current);
    if (saveAbort.current) {
      saveAbort.current.abort();
      saveAbort.current = null;
    }

    setSaveStatus("saving");
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
      }

      setStateBase((current) => {
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
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (error) {
      console.error("Failed to save personnel mutation:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
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
    if (state.user) return;
    stateLoadStarted.current = false;
    lastSavedState.current = null;
    loadedKeysRef.current = new Set<PersistedKey>();
    setLoadedKeys(new Set<PersistedKey>());
    setStateLoaded(false);
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
    stateLoadStarted.current = true;
    setStateLoading(true);
    loadViewState(view, { force: true })
      .then((ok) => {
        if (!ok) throw new Error("Failed to load initial view state");
        setStateLoaded(true);
      })
      .catch((e) => {
        console.error("Failed to load state:", e);
        setStateLoaded(true);
      })
      .finally(() => setStateLoading(false));
  }, [currentUserKey, permissionSummaryReady, stateLoaded]);

  useEffect(() => {
    if (!state.user || !stateLoaded) return;
    if (saveStatusRef.current === "saving") return;
    void loadViewState(view, { force: true, showLoading: true });
  }, [view, currentUserKey, stateLoaded]);

  useEffect(() => {
    if (!state.user || !stateLoaded) return;
    let lastRefreshAt = 0;
    const refreshIfDue = () => {
      const now = Date.now();
      if (now - lastRefreshAt < 5000) return;
      lastRefreshAt = now;
      void refreshBusinessState();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshIfDue();
    };
    window.addEventListener("focus", refreshIfDue);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    const interval = window.setInterval(refreshIfDue, 60_000);
    return () => {
      window.removeEventListener("focus", refreshIfDue);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.clearInterval(interval);
    };
  }, [currentUserKey, stateLoaded]);

  const setState: Dispatch<SetStateAction<Store>> = (value) => {
    setStateBase((prev) => {
      const next = typeof value === "function" ? (value as (s: Store) => Store)(prev) : value;
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
      case "batches":    return <BatchesView />;
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
      case "finance":    return <FinanceView />;
      case "paymentMethods": return <PaymentMethodsView />;
      case "shippingCarriers": return <ShippingCarriersView />;
      case "waterQualitySettings": return <WaterQualitySettingsView />;
      case "categorySettings": return <CategorySettingsView />;
      case "profile":    return <PersonalCenterView />;
      case "permissions": return <PersonnelAdminView />;
      case "operationLogs": return <OperationLogsView />;
      default:           return <Dashboard />;
    }
  };

  function requestOpenOrder(orderId: string) {
    const sourceView = viewRef.current;
    const returnView = sourceView === "stockIn" || sourceView === "daily" || sourceView === "notifications"
      ? sourceView
      : undefined;
    const returnSiteId = activeSiteId;
    const targetOrder = stateRef.current.orders.find((order) => order.id === orderId);
    const targetSiteId = targetOrder ? normalizeSiteId(targetOrder.siteId) : activeSiteId;
    if (
      targetOrder &&
      targetSiteId !== activeSiteId &&
      canUserAccessSite(stateRef.current.user, stateRef.current, targetSiteId)
    ) {
      setActiveSiteId(targetSiteId);
    }
    orderRequestSequence.current += 1;
    setOpenOrderRequest({ orderId, requestId: orderRequestSequence.current, returnView, returnSiteId });
    setView("orders");
  }

  function finishOpenOrderRequest() {
    const returnView = openOrderRequest?.returnView;
    const returnSiteId = openOrderRequest?.returnSiteId;
    setOpenOrderRequest(null);
    if (returnSiteId && returnSiteId !== activeSiteId) setActiveSiteId(returnSiteId);
    if (returnView) setView(returnView);
  }

  const handleSetView = (nextView: ViewKey) => {
    if (nextView !== "orders") setOpenOrderRequest(null);
    if (nextView === viewRef.current) {
      void loadViewState(nextView, { force: true, showLoading: true });
      return;
    }
    setView(nextView);
  };

  const loadingView = viewLoading || Boolean(
    state.user && (!permissionSummaryReady || stateLoading || !stateLoaded)
  );
  const viewContent = loadingView ? (
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
			    <StoreContext.Provider value={{ state: visibleState, activeSiteId, setActiveSiteId, setState, savePatch, saveProduct, deleteProduct, saveStockChange, saveMaintenanceAction, saveTankGroupChange, saveDailyLog, saveWaterQualitySettings, saveWaterQualityRecord, saveShipmentOutbound, saveOrderPaymentChange, savePersonnelAccount, resignPersonnelAccount, deletePersonnelAccount, savePersonnelPermissions, changePersonnelPassword, saveStateTransform }}>
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
