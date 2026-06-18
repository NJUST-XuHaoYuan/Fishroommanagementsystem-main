import { useState, useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { StoreContext, initialState, DEFAULT_FISH_LIST_FOOTER_TEXT, DailyLog, OperationLog, PaymentRecord, PermissionSet, Personnel, Product, StockItem, Store, TankGroup, SubTank, User, uid } from "./store";
import { Login } from "./components/Login";
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
import { PersonnelView } from "./components/PersonnelView";
import { PermissionsView } from "./components/PermissionsView";
import { OperationLogsView } from "./components/OperationLogsView";
import { PersonalCenterView } from "./components/PersonalCenterView";
import { Toaster } from "./components/ui/sonner";
import { normalizePermissions } from "./utils/permissions";
import { authJsonHeaders, clearAuthSession, getAuthSessionExpiresAt, getValidAuthSession } from "./utils/authSession";
import { DEFAULT_SITE_ID, DEFAULT_SITES, getSites, matchesSite, normalizeSiteId } from "./utils/sites";

const API = "/api";
const MAX_OPERATION_LOGS = 10000;

const AUDIT_COLLECTIONS: { key: keyof Store; module: string }[] = [
  { key: "systemSettings", module: "系统设置" },
  { key: "sites", module: "场地管理" },
  { key: "species", module: "物种管理" },
  { key: "speciesCategories", module: "物种分类" },
  { key: "products", module: "商品管理" },
  { key: "productOrigins", module: "商品产地" },
  { key: "tankGroups", module: "缸组管理" },
  { key: "batches", module: "采购批次" },
  { key: "stock", module: "库存明细" },
  { key: "lossRecords", module: "损耗记录" },
  { key: "logs", module: "日常管理" },
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

const PERSISTED_KEYS = AUDIT_COLLECTIONS
  .map(({ key }) => key)
  .filter((key): key is PersistedKey =>
    key !== "user" && key !== "operationLogs" && key !== "tankGroups" && key !== "logs"
  );

const VIEW_STATE_KEYS: Record<ViewKey, PersistedKey[]> = {
  dashboard: ["sites", "systemSettings"],
  species: ["species", "speciesCategories", "products"],
  products: ["species", "products", "productOrigins"],
  tankGroups: ["tankGroups", "stock", "shipments"],
  batches: ["batches", "stock", "orders", "shipments"],
  stockIn: ["products", "tankGroups", "batches", "stock", "shipments"],
  daily: ["products", "tankGroups", "batches", "stock", "orders", "shipments", "logs", "personnel"],
  lossRecords: ["lossRecords", "stock", "products", "species", "batches", "tankGroups"],
  customers: ["customers", "customerSources", "orders", "shipments"],
  orders: ["orders", "customers", "stock", "products", "species", "tankGroups", "shipments", "personnel"],
  profile: ["personnel", "orders", "customers", "shipments"],
  accounts: ["personnel"],
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
  },
  sites: DEFAULT_SITES.map((site) => ({ ...site })),
  personnel: [],
  operationLogs: [],
  species: [],
  speciesCategories: [],
  products: [],
  productOrigins: [],
  tankGroups: [],
  batches: [],
  stock: [],
  lossRecords: [],
  logs: [],
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

function normalizePersistedState(data: any, currentUser: User): Store {
  if (!data) return { ...initialState, user: currentUser };
  const migratedData = backfillSiteScopedData(data);

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
        notes: String(product.notes ?? ""),
      }))
    : migratedData.products;
  const migratedProductOrigins = mergeProductOrigins(migratedData.productOrigins, migratedProducts ?? migratedData.products);
  const migratedPersonnel = Array.isArray(migratedData.personnel)
    ? migratedData.personnel.map((person: Record<string, unknown>, index: number) => {
        const name = String(person.name ?? person.username ?? "");
        const username = String(person.username ?? name);
        return {
          id: String(person.id ?? `person-${index + 1}`),
          name,
          username,
          password: typeof person.password === "string" ? person.password : "",
          accessRole: person.accessRole === "admin" || person.accessRole === "staff"
            ? person.accessRole
            : username === "admin" ? "admin" : "staff",
          permissions: normalizePermissions((person as any).permissions),
          role: String(person.role ?? ""),
          phone: String(person.phone ?? ""),
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

  return {
    ...initialState,
    ...migratedData,
    systemSettings: migratedSystemSettings,
    sites: getSites(migratedData),
    personnel: migratedPersonnel,
    operationLogs: Array.isArray(migratedData.operationLogs) ? migratedData.operationLogs : [],
    products: migratedProducts ?? migratedData.products,
    productOrigins: migratedProductOrigins,
    lossRecords: Array.isArray(migratedData.lossRecords) ? migratedData.lossRecords : [],
    stock: migratedStock ?? migratedData.stock,
    shipments: migratedShipments ?? migratedData.shipments,
    user: currentUser,
  };
}

function restoreUserFromSession(): User {
  const session = getValidAuthSession();
  if (!session) return null;
  return { username: session.username, role: session.role };
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

export default function App() {
  const [state, setStateBase] = useState<Store>(initialState);
  const [view, setView] = useState<ViewKey>("dashboard");
  const [loading, setLoading] = useState(true);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [stateLoading, setStateLoading] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [loadedKeys, setLoadedKeys] = useState<Set<PersistedKey>>(() => new Set());
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
  const loadedKeysRef = useRef<Set<PersistedKey>>(new Set());
  const viewRef = useRef(view);

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
    operationLogs: OperationLog[] = [],
    basePatch: Partial<PersistedStore> = {}
  ): Promise<{ appliedOperationLogs?: OperationLog[] }> => {
    const response = await fetch(`${API}/state/patch`, {
      method: "POST",
      headers: authJsonHeaders(),
      body: JSON.stringify({ patch, basePatch, operationLogs }),
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

	  const saveStockChange = async (change: { upsert?: StockItem[]; deleteIds?: string[] }): Promise<boolean> => {
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
      if (!response.ok || !result.ok) {
        throw new Error(result.error || `HTTP ${response.status}`);
      }

      setStateBase((current) => {
        const next = {
          ...current,
          stock: Array.isArray(result.stock) ? result.stock : current.stock,
          batches: Array.isArray(result.batches) ? result.batches : current.batches,
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
      console.error("Failed to save stock:", error);
      setSaveStatus("error");
      setTimeout(() => setSaveStatus("idle"), 3000);
	      return false;
	    }
	  };

	  const saveMaintenanceAction = async (change:
	    | { mode: "record"; itemIds: string[]; recordDate: string; recordText?: string; recordPhotos: string[]; recordVideos: string[] }
	    | { mode: "move"; itemIds: string[]; targetSubTankId: string; moveDate?: string; moveNotes?: string }
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

      setStateBase((current) => {
        const next = normalizePersistedState(
          {
            ...withoutUser(current),
            personnel: Array.isArray(result.personnel) ? result.personnel : current.personnel,
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
    const sessionUser = restoreUserFromSession();
    if (!sessionUser) {
      setStateBase(() => normalizePersistedState(EMPTY_PERSISTED_STATE, null));
      setLoadedKeys(new Set<PersistedKey>());
      setLoading(false);
      return;
    }

    const fetchWithRetry = (attempt = 0): Promise<Response> =>
      fetch(`${API}/auth/me`, { headers: authJsonHeaders() }).catch((err) => {
        if (attempt < 3) {
          return new Promise<Response>((resolve, reject) =>
            setTimeout(() => fetchWithRetry(attempt + 1).then(resolve, reject), 1000 * (attempt + 1))
          );
        }
        throw err;
      });

    fetchWithRetry()
      .then(async (r) => {
        const result = await r.json().catch(() => ({}));
        if (!r.ok || !result.user) throw new Error(result.error || `HTTP ${r.status}`);
        return result.user;
      })
      .then((userResult) => {
        const restoredUser: User = {
          username: String(userResult.username ?? sessionUser.username),
          role: userResult.role === "admin" ? "admin" : "staff",
        };
        setStateBase((s) => {
          return normalizePersistedState(EMPTY_PERSISTED_STATE, s.user ?? restoredUser);
        });
        setLoadedKeys(new Set<PersistedKey>());
      })
      .catch((e) => {
        console.error("Failed to validate auth session:", e);
        clearAuthSession();
        setStateBase(() => normalizePersistedState(EMPTY_PERSISTED_STATE, null));
        setLoadedKeys(new Set<PersistedKey>());
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (state.user) return;
    stateLoadStarted.current = false;
    lastSavedState.current = null;
    loadedKeysRef.current = new Set<PersistedKey>();
    setLoadedKeys(new Set<PersistedKey>());
    setStateLoaded(false);
  }, [state.user]);

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
  }, [state.user]);

  // ── Load only the current page's business data after a successful login. ──
  useEffect(() => {
    if (!state.user || stateLoaded || stateLoadStarted.current) return;
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
  }, [state.user, stateLoaded]);

  useEffect(() => {
    if (!state.user || !stateLoaded) return;
    if (saveStatusRef.current === "saving") return;
    void loadViewState(view, { force: true, showLoading: true });
  }, [view, state.user, stateLoaded]);

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
  }, [state.user, stateLoaded]);

  const setState: Dispatch<SetStateAction<Store>> = (value) => {
    setStateBase((prev) => {
      const next = typeof value === "function" ? (value as (s: Store) => Store)(prev) : value;
      return next;
    });
  };

  const visibleState = useMemo(
    () => state.user ? scopedStoreForSite(state, activeSiteId) : state,
    [state, activeSiteId]
  );

  const renderView = () => {
    switch (view) {
      case "dashboard":  return <Dashboard />;
      case "species":    return <SpeciesView />;
      case "products":   return <ProductsView />;
      case "tankGroups": return <TankGroupsView />;
      case "batches":    return <BatchesView />;
      case "stockIn":    return <StockInView />;
      case "daily":      return <DailyView allTankGroups={state.tankGroups} />;
      case "lossRecords": return <LossRecordsView />;
      case "customers":  return <CustomersView />;
      case "orders":     return <OrdersView />;
      case "profile":    return <PersonalCenterView />;
      case "accounts":   return <PersonnelView />;
      case "permissions": return <PermissionsView />;
      case "operationLogs": return <OperationLogsView />;
      default:           return <Dashboard />;
    }
  };

  const handleSetView = (nextView: ViewKey) => {
    if (nextView === viewRef.current) {
      void loadViewState(nextView, { force: true, showLoading: true });
      return;
    }
    setView(nextView);
  };

  const loadingView = viewLoading;
  const viewContent = loadingView ? (
    <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
      正在加载当前页面数据…
    </div>
  ) : renderView();

  if (loading || (state.user && (stateLoading || !stateLoaded))) {
    return (
      <div className="size-full min-h-screen flex items-center justify-center bg-slate-50">
        <LogoLoader label={loading ? "正在加载登录信息…" : "正在加载业务数据…"} />
      </div>
    );
  }

	  return (
			    <StoreContext.Provider value={{ state: visibleState, activeSiteId, setActiveSiteId, setState, savePatch, saveProduct, saveStockChange, saveMaintenanceAction, saveTankGroupChange, saveDailyLog, saveShipmentOutbound, saveOrderPaymentChange, savePersonnelAccount, deletePersonnelAccount, savePersonnelPermissions, changePersonnelPassword, saveStateTransform }}>
      {!state.user ? (
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
