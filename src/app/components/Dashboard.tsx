import { useEffect, useMemo, useState } from "react";
import { Order, Product, PurchaseBatch, Shipment, Species, StockItem, StockLossRecord, useStore } from "../store";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";
import { Fish, PackageSearch, AlertTriangle, ShoppingBag, Truck, TrendingUp, Banknote, RotateCcw, Download } from "lucide-react";
import { getShippedOutStockIds, isPhysicallyInTank } from "../utils/inventory";
import { toast } from "sonner";
import { ALL_SITE_ID, getSites, matchesSite, normalizeSiteScope, siteName } from "../utils/sites";
import { authJsonHeaders } from "../utils/authSession";

function todayDateString(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function formatMoney(value: number): string {
  return `¥${value.toFixed(2)}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toLocalDateString(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function shortDateLabel(date: string): string {
  return date.slice(5).replace("-", "/");
}

function formatCompactMoney(value: number): string {
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(0);
}

function parseDateValue(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function diffDays(from?: string, to?: string): number | null {
  const start = parseDateValue(from);
  const end = parseDateValue(to);
  if (!start || !end) return null;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const FINANCE_DAY_OPTIONS = [14, 30, 90, 180, 365, 730] as const;
type FinanceDays = typeof FINANCE_DAY_OPTIONS[number];
const DEFAULT_FINANCE_DAYS: FinanceDays = 30;

function normalizeFinanceDays(value: number): FinanceDays {
  return FINANCE_DAY_OPTIONS.includes(value as FinanceDays) ? value as FinanceDays : DEFAULT_FINANCE_DAYS;
}

type DailyFinancePoint = {
  date: string;
  label: string;
  received: number;
  refunded: number;
};

type DailyLossDetail = {
  id: string;
  stockItemId: string;
  productName: string;
  speciesName: string;
  size: string;
  origin: string;
  tankName: string;
  batchNo: string;
  supplier: string;
  arrivalDate: string;
  reason: string;
  estimatedValue: number;
  code: string;
};

type DailyBatchArrival = {
  id: string;
  batchNo: string;
  supplier: string;
  arrivalDate: string;
  stockedCount: number;
  lossCount: number;
  bioFee: number;
  shippingFee: number;
};

type DailyLossPoint = {
  date: string;
  label: string;
  lostCount: number;
  stockBase: number;
  lossRate: number;
  estimatedValue: number;
  lossDetails?: DailyLossDetail[];
  batchArrivals?: DailyBatchArrival[];
};

type DashboardSummary = {
  siteId?: string;
  todayReceived: number;
  todayRefunded: number;
  todayShippedOut: number;
  inFishStock: number;
  sick: number;
  inTankSold: number;
  inTankSick: number;
  inTankNormal: number;
  tankGroupCount: number;
  subTankCount: number;
  activeOrders: number;
  totalRevenue: number;
  pendingShipments: number;
  financeDays?: number;
  dailyFinanceData: DailyFinancePoint[];
  dailyLossData?: DailyLossPoint[];
};

type FocusMode = "species" | "product";

type FocusData = {
  species: Species[];
  products: Product[];
  stock: StockItem[];
  orders: Order[];
  shipments: Shipment[];
  lossRecords: StockLossRecord[];
};

type FocusOption = {
  id: string;
  label: string;
  subLabel: string;
  searchText: string;
  inTankCount: number;
};

type FocusProductRow = {
  product: Product;
  species?: Species;
  inTank: number;
  sellable: number;
  soldInTank: number;
  sick: number;
  lost: number;
  salesCount: number;
  salesAmount: number;
};

function linePoints(data: DailyFinancePoint[], key: "received" | "refunded", maxValue: number): string {
  const width = 960;
  const height = 250;
  const left = 64;
  const right = 20;
  const top = 18;
  const bottom = 34;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const divisor = Math.max(data.length - 1, 1);
  return data.map((point, index) => {
    const x = left + (index / divisor) * chartWidth;
    const y = top + (1 - Number(point[key] || 0) / maxValue) * chartHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function metricLinePoints<T>(data: T[], valueForPoint: (point: T) => number, maxValue: number): string {
  const width = 960;
  const height = 250;
  const left = 64;
  const right = 20;
  const top = 18;
  const bottom = 34;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const divisor = Math.max(data.length - 1, 1);
  return data.map((point, index) => {
    const x = left + (index / divisor) * chartWidth;
    const y = top + (1 - Number(valueForPoint(point) || 0) / maxValue) * chartHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function chartX(index: number, total: number): number {
  return 64 + (index / Math.max(total - 1, 1)) * 876;
}

function chartY(value: number, maxValue: number): number {
  return 18 + (1 - Number(value || 0) / Math.max(maxValue, 1)) * 198;
}

function polarToCartesian(cx: number, cy: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees - 90) * Math.PI / 180;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function describeDonutSegment(cx: number, cy: number, outerRadius: number, innerRadius: number, startAngle: number, endAngle: number): string {
  const outerStart = polarToCartesian(cx, cy, outerRadius, endAngle);
  const outerEnd = polarToCartesian(cx, cy, outerRadius, startAngle);
  const innerStart = polarToCartesian(cx, cy, innerRadius, startAngle);
  const innerEnd = polarToCartesian(cx, cy, innerRadius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArcFlag} 0 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArcFlag} 1 ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function isFishCategory(category: string): boolean {
  if (/(活石|活性炭|吸附|滤材|耗材|器材|设备|材料|药|盐|饲料|鱼粮|试剂)/.test(category)) return false;
  if (category.includes("虾虎") || category.includes("鰕虎")) return true;
  return !/(虾|蟹|螺|贝|海胆|珊瑚|海星|海葵)/.test(category);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}

export function Dashboard() {
  const { state, activeSiteId } = useStore();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [financeDays, setFinanceDays] = useState<FinanceDays>(DEFAULT_FINANCE_DAYS);
  const [dashboardSiteId, setDashboardSiteId] = useState<string>(activeSiteId);
  const [hoveredFinanceIndex, setHoveredFinanceIndex] = useState<number | null>(null);
  const [hoveredLossIndex, setHoveredLossIndex] = useState<number | null>(null);
  const [selectedLossPoint, setSelectedLossPoint] = useState<DailyLossPoint | null>(null);
  const [exportingFishList, setExportingFishList] = useState(false);
  const [focusMode, setFocusMode] = useState<FocusMode>("species");
  const [focusSearch, setFocusSearch] = useState("");
  const [focusId, setFocusId] = useState("");
  const [focusData, setFocusData] = useState<FocusData | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const sites = getSites(state);
  useEffect(() => {
    setDashboardSiteId((current) => current === ALL_SITE_ID ? current : activeSiteId);
  }, [activeSiteId]);
  useEffect(() => {
    let cancelled = false;
    setHoveredFinanceIndex(null);
    setHoveredLossIndex(null);
    setSelectedLossPoint(null);
    fetch(`/api/dashboard-summary?financeDays=${financeDays}&siteId=${encodeURIComponent(dashboardSiteId)}`, { headers: authJsonHeaders() })
      .then((response) => response.json().then((result) => ({ response, result })))
      .then(({ response, result }) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        const nextSummary = result.summary ?? null;
        if (nextSummary?.financeDays) {
          setFinanceDays((current) => normalizeFinanceDays(Number(nextSummary.financeDays) || current));
        }
        setSummary(nextSummary);
      })
      .catch((error) => {
        if (!cancelled) console.error("Failed to load dashboard summary:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [financeDays, dashboardSiteId]);
  useEffect(() => {
    let cancelled = false;
    setFocusLoading(true);
    fetch("/api/state/slice?keys=species,products,stock,orders,shipments,lossRecords&lite=species", { headers: authJsonHeaders() })
      .then((response) => response.json().then((result) => ({ response, result })))
      .then(({ response, result }) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        const data = result.data ?? {};
        setFocusData({
          species: Array.isArray(data.species) ? data.species : [],
          products: Array.isArray(data.products) ? data.products : [],
          stock: Array.isArray(data.stock) ? data.stock : [],
          orders: Array.isArray(data.orders) ? data.orders : [],
          shipments: Array.isArray(data.shipments) ? data.shipments : [],
          lossRecords: Array.isArray(data.lossRecords) ? data.lossRecords : [],
        });
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load focus dashboard data:", error);
          setFocusData(null);
        }
      })
      .finally(() => {
        if (!cancelled) setFocusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const shippedOutStockIds = getShippedOutStockIds(state.shipments);
  const today = todayDateString();
  const todayDate = new Date(`${today}T00:00:00`);

  const productById = new Map(state.products.map((product) => [product.id, product]));
  const speciesById = new Map(state.species.map((species) => [species.id, species]));
  const batchById = new Map(state.batches.map((batch) => [batch.id, batch]));
  const subTankNameById = new Map<string, string>();
  for (const group of state.tankGroups) {
    for (const subTank of group.subTanks ?? []) {
      subTankNameById.set(subTank.id, `${group.name} / ${subTank.name}`);
    }
  }
  const tankNameForLoss = (record: StockLossRecord, stockItem?: StockItem): string => {
    if (record.tankName) return record.tankName;
    const snapshotName = [record.tankGroupName, record.subTankName].filter(Boolean).join(" / ");
    if (snapshotName) return snapshotName;
    return stockItem ? subTankNameById.get(stockItem.subTankId) ?? "未知缸位" : "未知缸位";
  };
  const inTankStock = state.stock.filter((s) => isPhysicallyInTank(s, shippedOutStockIds));
  const inTankFishStock = inTankStock.filter((stockItem) => {
    const product = productById.get(stockItem.productId);
    const species = product ? speciesById.get(product.speciesId) : undefined;
    return isFishCategory(species?.category ?? "");
  });
  let inFishStock = inTankFishStock.length;
  let sick = inTankFishStock.filter((s) => s.status === "sick").length;
  let inTankSold = inTankFishStock.filter((s) => s.sold).length;
  let inTankSick = inTankFishStock.filter((s) => !s.sold && s.status === "sick").length;
  let inTankNormal = inTankFishStock.filter((s) => !s.sold && s.status !== "sick").length;
  let tankGroupCount = state.tankGroups.length;
  let subTankCount = state.tankGroups.reduce((n, g) => n + g.subTanks.length, 0);
  const todayPayments = state.orders.flatMap((order) =>
    (order.payments ?? []).filter((payment) => String(payment.time ?? "").slice(0, 10) === today)
  );
  let todayReceived = todayPayments
    .filter((payment) => payment.type !== "refund")
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  let todayRefunded = todayPayments
    .filter((payment) => payment.type === "refund")
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  let todayShippedOut = state.shipments
    .filter((shipment) => shipment.shipDate === today && shipment.status !== "preparing")
    .reduce((sum, shipment) => sum + (shipment.itemStockIds?.length ?? 0), 0);

  let activeOrders = state.orders.filter((o) => !["cancelled", "completed", "damaged"].includes(o.status)).length;
  let totalRevenue = state.orders
    .filter((o) => o.status !== "cancelled" && o.status !== "damaged")
    .reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.price, 0), 0);
  let pendingShipments = state.shipments.filter((s) => s.status === "preparing" || s.status === "outbound" || s.status === "shipped").length;

  let dailyFinanceData = Array.from({ length: financeDays }, (_, index) => {
    const date = toLocalDateString(addDays(todayDate, index - financeDays + 1));
    const payments = state.orders.flatMap((order) =>
      (order.payments ?? []).filter((payment) => String(payment.time ?? "").slice(0, 10) === date)
    );
    return {
      date,
      label: shortDateLabel(date),
      received: payments
        .filter((payment) => payment.type !== "refund")
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      refunded: payments
        .filter((payment) => payment.type === "refund")
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
    };
  });
  const dailyDates = dailyFinanceData.map((point) => point.date);
  const stockById = new Map(state.stock.map((item) => [item.id, item]));
  const explicitLossIds = new Set((state.lossRecords ?? []).map((record) => record.stockItemId));
  const lossRows = [
    ...(state.lossRecords ?? []),
    ...state.stock
      .filter((item) => item.lost && !explicitLossIds.has(item.id))
      .map<StockLossRecord>((item) => ({
        id: `loss-${item.id}`,
        stockItemId: item.id,
        date: item.lossDate ?? item.inDate,
        reason: item.lossReason ?? "",
        proofPhotos: item.lossProof ?? [],
        operator: "",
      })),
  ].map((record) => {
    const stockItem = stockById.get(record.stockItemId);
    const product = stockItem ? productById.get(stockItem.productId) : undefined;
    const itemSpecies = product ? speciesById.get(product.speciesId) : undefined;
    return {
      record,
      stockItem,
      product,
      species: itemSpecies,
      date: String(record.date ?? stockItem?.lossDate ?? "").slice(0, 10),
      estimatedValue: Number(stockItem?.basePrice ?? product?.defaultPrice ?? 0),
      isFish: isFishCategory(itemSpecies?.category ?? ""),
    };
  }).filter((row) => row.date && row.stockItem && row.isFish);
  const lossDateByStockId = new Map<string, string>();
  for (const row of lossRows) {
    if (!row.stockItem) continue;
    const current = lossDateByStockId.get(row.stockItem.id);
    if (!current || row.date < current) lossDateByStockId.set(row.stockItem.id, row.date);
  }
  for (const item of state.stock) {
    const itemLossDate = String(item.lossDate ?? "").slice(0, 10);
    if (!itemLossDate) continue;
    const current = lossDateByStockId.get(item.id);
    if (!current || itemLossDate < current) lossDateByStockId.set(item.id, itemLossDate);
  }
  const shippedDateByStockId = new Map<string, string>();
  for (const shipment of state.shipments) {
    if (shipment.status === "preparing") continue;
    const date = String(shipment.shipDate ?? shipment.outboundDate ?? shipment.createdAt ?? "").slice(0, 10);
    if (!date) continue;
    for (const stockItemId of shipment.itemStockIds ?? []) {
      const current = shippedDateByStockId.get(stockItemId);
      if (!current || date < current) shippedDateByStockId.set(stockItemId, date);
    }
  }
  const fishStock = state.stock.filter((item) => {
    const product = productById.get(item.productId);
    const itemSpecies = product ? speciesById.get(product.speciesId) : undefined;
    return isFishCategory(itemSpecies?.category ?? "");
  });
  let dailyLossData: DailyLossPoint[] = dailyDates.map((date) => {
    const seenLossIds = new Set<string>();
    const rowsForDate = lossRows.filter((row) => {
      const stockItemId = row.stockItem?.id ?? "";
      if (row.date !== date || !stockItemId || seenLossIds.has(stockItemId)) return false;
      seenLossIds.add(stockItemId);
      return true;
    });
    const stockBase = fishStock.filter((item) => {
      const inDate = String(item.inDate ?? "").slice(0, 10);
      if (!inDate || inDate > date) return false;
      const lossDate = lossDateByStockId.get(item.id);
      if (lossDate && lossDate < date) return false;
      const shippedDate = shippedDateByStockId.get(item.id);
      if (shippedDate && shippedDate < date) return false;
      return true;
    }).length;
    const lostCount = rowsForDate.length;
    const lossDetails = rowsForDate.map((row) => {
      const stockItem = row.stockItem;
      const batch = stockItem ? batchById.get(stockItem.batchId) : undefined;
      return {
        id: String(row.record.id ?? stockItem?.id ?? ""),
        stockItemId: String(stockItem?.id ?? ""),
        productName: row.product?.name ?? "未命名商品",
        speciesName: row.species?.name ?? "",
        size: row.product?.size ?? "",
        origin: row.product?.origin ?? "",
        tankName: tankNameForLoss(row.record, stockItem),
        batchNo: batch?.batchNo ?? "",
        supplier: batch?.supplier ?? "",
        arrivalDate: batch?.arrivalDate ?? "",
        reason: row.record.reason ?? stockItem?.lossReason ?? "",
        estimatedValue: Number(row.estimatedValue || 0),
        code: stockItem?.code ?? "",
      };
    });
    const batchArrivals = state.batches
      .filter((batch) => String(batch.arrivalDate ?? "").slice(0, 10) === date)
      .map<DailyBatchArrival>((batch: PurchaseBatch) => {
        const batchStock = fishStock.filter((item) => item.batchId === batch.id);
        const lostStockIds = new Set(lossRows
          .filter((row) => row.stockItem?.batchId === batch.id)
          .map((row) => row.stockItem?.id)
          .filter(Boolean));
        return {
          id: batch.id,
          batchNo: batch.batchNo,
          supplier: batch.supplier,
          arrivalDate: batch.arrivalDate,
          stockedCount: Number(batch.stockedCount || 0) || batchStock.length,
          lossCount: Number(batch.lossCount || 0) || lostStockIds.size,
          bioFee: Number(batch.bioFee || 0),
          shippingFee: Number(batch.shippingFee || 0),
        };
      });
    return {
      date,
      label: shortDateLabel(date),
      lostCount,
      stockBase,
      lossRate: stockBase > 0 ? lostCount / stockBase * 100 : 0,
      estimatedValue: rowsForDate.reduce((sum, row) => sum + Number(row.estimatedValue || 0), 0),
      lossDetails,
      batchArrivals,
    };
  });
  if (summary) {
    todayReceived = summary.todayReceived;
    todayRefunded = summary.todayRefunded;
    todayShippedOut = summary.todayShippedOut;
    inFishStock = summary.inFishStock;
    sick = summary.sick;
    inTankSold = summary.inTankSold;
    inTankSick = summary.inTankSick;
    inTankNormal = summary.inTankNormal;
    tankGroupCount = summary.tankGroupCount;
    subTankCount = summary.subTankCount;
    activeOrders = summary.activeOrders;
    totalRevenue = summary.totalRevenue;
    pendingShipments = summary.pendingShipments;
    dailyFinanceData = summary.dailyFinanceData;
    dailyLossData = Array.isArray(summary.dailyLossData) ? summary.dailyLossData : dailyLossData;
  }
  const maxFinanceValue = Math.max(
    1,
    ...dailyFinanceData.flatMap((point) => [point.received, point.refunded])
  );
  const hoveredFinancePoint =
    hoveredFinanceIndex !== null && hoveredFinanceIndex < dailyFinanceData.length
      ? dailyFinanceData[hoveredFinanceIndex]
      : null;
  const hoveredFinanceX = hoveredFinanceIndex !== null
    ? 64 + (hoveredFinanceIndex / Math.max(dailyFinanceData.length - 1, 1)) * 876
    : 64;
  const hoveredFinanceTransform = hoveredFinanceIndex === 0
    ? "translateX(0)"
    : hoveredFinanceIndex === dailyFinanceData.length - 1
      ? "translateX(-100%)"
      : "translateX(-50%)";
  const maxLossCount = Math.max(1, ...dailyLossData.map((point) => point.lostCount));
  const maxLossRate = Math.max(1, ...dailyLossData.map((point) => point.lossRate));
  const maxLossValue = Math.max(1, ...dailyLossData.map((point) => point.estimatedValue));
  const hoveredLossPoint =
    hoveredLossIndex !== null && hoveredLossIndex < dailyLossData.length
      ? dailyLossData[hoveredLossIndex]
      : null;
  const hoveredLossX = hoveredLossIndex !== null
    ? chartX(hoveredLossIndex, dailyLossData.length)
    : 64;
  const hoveredLossTransform = hoveredLossIndex === 0
    ? "translateX(0)"
    : hoveredLossIndex === dailyLossData.length - 1
      ? "translateX(-100%)"
      : "translateX(-50%)";
  const lossLabelStep = Math.max(1, Math.ceil(dailyLossData.length / 8));
  const lossRangeTotal = dailyLossData.reduce((sum, point) => sum + point.lostCount, 0);
  const lossRangeValue = dailyLossData.reduce((sum, point) => sum + point.estimatedValue, 0);
  const lossRangeAvgRate = dailyLossData.length > 0
    ? dailyLossData.reduce((sum, point) => sum + point.lossRate, 0) / dailyLossData.length
    : 0;
  const lossRangeBatchCount = dailyLossData.reduce((sum, point) => sum + (point.batchArrivals?.length ?? 0), 0);
  const financeTicks = [1, 0.75, 0.5, 0.25, 0].map((ratio) => ({
    ratio,
    value: maxFinanceValue * ratio,
    y: 18 + (1 - ratio) * 198,
  }));
  const financeLabelStep = Math.max(1, Math.ceil(dailyFinanceData.length / 8));
  const stockStatusTotal = Math.max(inTankNormal + inTankSold + inTankSick, 1);
  const stockStatusSegments = [
    { key: "normal", label: "正常", value: inTankNormal, color: "bg-emerald-500", colorHex: "#10b981", textColor: "text-emerald-700", bgColor: "bg-emerald-50" },
    { key: "sold", label: "已售", value: inTankSold, color: "bg-amber-400", colorHex: "#f59e0b", textColor: "text-amber-700", bgColor: "bg-amber-50" },
    { key: "sick", label: "疾病", value: inTankSick, color: "bg-red-500", colorHex: "#ef4444", textColor: "text-red-700", bgColor: "bg-red-50" },
  ];
  let pieCursor = 0;
  const pieSegments = stockStatusSegments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const angle = segment.value / stockStatusTotal * 360;
      const startAngle = pieCursor;
      const endAngle = pieCursor + (angle >= 360 ? 359.99 : angle);
      pieCursor += angle;
      return { ...segment, startAngle, endAngle };
    });

  const focusSource = useMemo<FocusData>(() => {
    const source: FocusData = {
      species: focusData?.species ?? state.species,
      products: focusData?.products ?? state.products,
      stock: focusData?.stock ?? state.stock,
      orders: focusData?.orders ?? state.orders,
      shipments: focusData?.shipments ?? state.shipments,
      lossRecords: focusData?.lossRecords ?? state.lossRecords,
    };
    const scope = normalizeSiteScope(dashboardSiteId);
    if (scope === ALL_SITE_ID) return source;
    const orders = source.orders.filter((order) => matchesSite(order, scope));
    const orderIds = new Set(orders.map((order) => order.id));
    const stock = source.stock.filter((item) => matchesSite(item, scope));
    const stockIds = new Set(stock.map((item) => item.id));
    return {
      ...source,
      stock,
      orders,
      shipments: source.shipments.filter((shipment) => matchesSite(shipment, scope) || orderIds.has(shipment.orderId)),
      lossRecords: source.lossRecords.filter((record) => matchesSite(record, scope) || stockIds.has(record.stockItemId)),
    };
  }, [dashboardSiteId, focusData, state.species, state.products, state.stock, state.orders, state.shipments, state.lossRecords]);

  const focusAnalysis = useMemo(() => {
    const products = focusSource.products;
    const species = focusSource.species;
    const stock = focusSource.stock;
    const orders = focusSource.orders;
    const shipments = focusSource.shipments;
    const focusProductById = new Map(products.map((product) => [product.id, product]));
    const focusSpeciesById = new Map(species.map((item) => [item.id, item]));
    const shippedIds = getShippedOutStockIds(shipments);
    const physicalStock = stock.filter((item) => isPhysicallyInTank(item, shippedIds));
    const physicalCountByProduct = new Map<string, number>();
    for (const item of physicalStock) {
      physicalCountByProduct.set(item.productId, (physicalCountByProduct.get(item.productId) ?? 0) + 1);
    }

    const options: FocusOption[] = focusMode === "species"
      ? species.map((item) => {
          const productIds = new Set(products.filter((product) => product.speciesId === item.id).map((product) => product.id));
          const inTankCount = [...productIds].reduce((sum, productId) => sum + (physicalCountByProduct.get(productId) ?? 0), 0);
          return {
            id: item.id,
            label: item.name,
            subLabel: [item.category, item.commonNames?.join("、")].filter(Boolean).join(" · "),
            searchText: [item.name, item.scientificName, item.category, ...(item.commonNames ?? [])].join(" ").toLowerCase(),
            inTankCount,
          };
        })
      : products.map((product) => {
          const itemSpecies = focusSpeciesById.get(product.speciesId);
          return {
            id: product.id,
            label: product.name,
            subLabel: [itemSpecies?.name, product.size, product.origin].filter(Boolean).join(" · "),
            searchText: [product.name, product.size, product.origin, product.notes, itemSpecies?.name, ...(itemSpecies?.commonNames ?? [])].join(" ").toLowerCase(),
            inTankCount: physicalCountByProduct.get(product.id) ?? 0,
          };
        });
    options.sort((a, b) =>
      b.inTankCount - a.inTankCount ||
      a.label.localeCompare(b.label, "zh-Hans-CN")
    );

    const selectedOption = options.find((option) => option.id === focusId) ?? null;
    if (!selectedOption) {
      return { options, selectedOption, metrics: null, productRows: [] as FocusProductRow[] };
    }

    const productMatches = (productId: string) => {
      if (focusMode === "product") return productId === selectedOption.id;
      return focusProductById.get(productId)?.speciesId === selectedOption.id;
    };
    const targetProducts = products.filter((product) =>
      focusMode === "product" ? product.id === selectedOption.id : product.speciesId === selectedOption.id
    );
    const targetProductIds = new Set(targetProducts.map((product) => product.id));
    const targetStock = stock.filter((item) => targetProductIds.has(item.productId));
    const targetPhysicalStock = targetStock.filter((item) => isPhysicallyInTank(item, shippedIds));
    const sellableStock = targetPhysicalStock.filter((item) => !item.sold && item.status !== "sick");
    const sickStock = targetPhysicalStock.filter((item) => !item.sold && item.status === "sick");
    const soldInTankStock = targetPhysicalStock.filter((item) => item.sold);
    const lostStock = targetStock.filter((item) => item.lost);
    const validOrders = orders.filter((order) => order.status !== "cancelled");
    const saleEntries = validOrders.flatMap((order) =>
      (order.items ?? [])
        .filter((item) => productMatches(item.productId))
        .map((item) => ({
          order,
          item,
          stock: stock.find((entry) => entry.id === item.stockItemId),
        }))
    );
    const thirtyDaysAgo = addDays(todayDate, -29);
    const saleEntries30 = saleEntries.filter(({ order }) => {
      const date = parseDateValue(order.date);
      return !!date && date >= thirtyDaysAgo && date <= todayDate;
    });
    const turnoverDays = saleEntries
      .map(({ order, stock: stockItem }) => diffDays(stockItem?.inDate, order.date))
      .filter((value): value is number => value !== null);
    const currentAges = sellableStock
      .map((item) => diffDays(item.inDate, today))
      .filter((value): value is number => value !== null);
    const salesAmount = saleEntries.reduce((sum, entry) => sum + Number(entry.item.price || 0), 0);
    const salesAmount30 = saleEntries30.reduce((sum, entry) => sum + Number(entry.item.price || 0), 0);
    const dailySales30 = saleEntries30.length / 30;
    const estimatedClearDays = dailySales30 > 0 ? sellableStock.length / dailySales30 : null;
    const lossRate = targetStock.length > 0 ? lostStock.length / targetStock.length * 100 : 0;

    const productRows = targetProducts.map((product) => {
      const productStock = targetStock.filter((item) => item.productId === product.id);
      const productPhysical = productStock.filter((item) => isPhysicallyInTank(item, shippedIds));
      const productSales = saleEntries.filter((entry) => entry.item.productId === product.id);
      return {
        product,
        species: focusSpeciesById.get(product.speciesId),
        inTank: productPhysical.length,
        sellable: productPhysical.filter((item) => !item.sold && item.status !== "sick").length,
        soldInTank: productPhysical.filter((item) => item.sold).length,
        sick: productPhysical.filter((item) => !item.sold && item.status === "sick").length,
        lost: productStock.filter((item) => item.lost).length,
        salesCount: productSales.length,
        salesAmount: productSales.reduce((sum, entry) => sum + Number(entry.item.price || 0), 0),
      };
    }).sort((a, b) =>
      b.inTank - a.inTank ||
      b.salesAmount - a.salesAmount ||
      a.product.name.localeCompare(b.product.name, "zh-Hans-CN")
    );

    return {
      options,
      selectedOption,
      metrics: {
        salesCount: saleEntries.length,
        salesAmount,
        salesCount30: saleEntries30.length,
        salesAmount30,
        averageTurnoverDays: average(turnoverDays),
        turnoverSampleCount: turnoverDays.length,
        currentAverageAgeDays: average(currentAges),
        estimatedClearDays,
        inTank: targetPhysicalStock.length,
        sellable: sellableStock.length,
        soldInTank: soldInTankStock.length,
        sick: sickStock.length,
        lost: lostStock.length,
        totalStock: targetStock.length,
        lossRate,
      },
      productRows,
    };
  }, [focusSource, focusMode, focusId, today, todayDate]);

  useEffect(() => {
    if (focusAnalysis.options.length === 0) {
      if (focusId) setFocusId("");
      return;
    }
    if (!focusAnalysis.options.some((option) => option.id === focusId)) {
      setFocusId(focusAnalysis.options[0].id);
    }
  }, [focusAnalysis.options, focusId]);

  const visibleFocusOptions = useMemo(() => focusAnalysis.options
    .filter((option) => {
      const query = focusSearch.trim().toLowerCase();
      return !query || option.searchText.includes(query);
    }), [focusAnalysis.options, focusSearch]);

  useEffect(() => {
    if (visibleFocusOptions.length === 0) return;
    if (!visibleFocusOptions.some((option) => option.id === focusId)) {
      setFocusId(visibleFocusOptions[0].id);
    }
  }, [visibleFocusOptions, focusId]);

  const focusMetrics = focusAnalysis.metrics;

  const exportAvailableFishList = async () => {
    setExportingFishList(true);
    let exportData = {
      species: state.species,
      products: state.products,
      tankGroups: state.tankGroups,
      stock: state.stock,
      shipments: state.shipments,
    };
    try {
      const response = await fetch("/api/state/slice?keys=species,products,tankGroups,stock,shipments&lite=species", { headers: authJsonHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      const data = result.data ?? {};
      exportData = {
        species: Array.isArray(data.species) ? data.species : exportData.species,
        products: Array.isArray(data.products) ? data.products : exportData.products,
        tankGroups: Array.isArray(data.tankGroups) ? data.tankGroups : exportData.tankGroups,
        stock: Array.isArray(data.stock) ? data.stock : exportData.stock,
        shipments: Array.isArray(data.shipments) ? data.shipments : exportData.shipments,
      };
    } catch (error) {
      console.error("Failed to load available fish list data:", error);
      toast.error("读取鱼单数据失败，请刷新后重试");
      setExportingFishList(false);
      return;
    }
    const exportScope = normalizeSiteScope(dashboardSiteId);
    if (exportScope !== ALL_SITE_ID) {
      const tankGroups = exportData.tankGroups.filter((group) => matchesSite(group, exportScope));
      const subTankIds = new Set(tankGroups.flatMap((group) => group.subTanks.map((tank) => tank.id)));
      const shipments = exportData.shipments.filter((shipment) => matchesSite(shipment, exportScope));
      exportData = {
        ...exportData,
        tankGroups,
        stock: exportData.stock.filter((item) => matchesSite(item, exportScope) || subTankIds.has(item.subTankId)),
        shipments,
      };
    }

    const exportProductById = new Map(exportData.products.map((product) => [product.id, product]));
    const exportSpeciesById = new Map(exportData.species.map((species) => [species.id, species]));
    const exportShippedOutStockIds = getShippedOutStockIds(exportData.shipments);
    const exportTankName = (subTankId?: string) => {
      if (!subTankId) return "—";
      for (const group of exportData.tankGroups) {
        const tank = group.subTanks.find((entry) => entry.id === subTankId);
        if (tank) return `${group.name} / ${tank.name}`;
      }
      return "—";
    };

    const sellableRows = exportData.stock
      .filter((stock) => {
        if (stock.sold || stock.status === "sick") return false;
        if (!isPhysicallyInTank(stock, exportShippedOutStockIds)) return false;
        const product = exportProductById.get(stock.productId);
        const species = product ? exportSpeciesById.get(product.speciesId) : undefined;
        return isFishCategory(species?.category ?? "");
      })
      .map((stock) => {
        const product = exportProductById.get(stock.productId);
        const species = product ? exportSpeciesById.get(product.speciesId) : undefined;
        return {
          stock,
          product,
          species,
          speciesId: species?.id ?? product?.speciesId ?? "unknown",
          speciesName: species?.name ?? "未归类",
          statusLabel: stock.status === "feeding" ? "开口" : "正常",
          price: stock.basePrice || product?.defaultPrice || 0,
        };
      })
      .sort((a, b) =>
        a.speciesName.localeCompare(b.speciesName, "zh-Hans-CN") ||
        (a.product?.name ?? "").localeCompare(b.product?.name ?? "", "zh-Hans-CN") ||
        exportTankName(a.stock.subTankId).localeCompare(exportTankName(b.stock.subTankId), "zh-Hans-CN") ||
        String(a.stock.code ?? "").localeCompare(String(b.stock.code ?? ""), "zh-Hans-CN")
      );

    if (sellableRows.length === 0) {
      toast.error("当前没有可导出的可售鱼");
      setExportingFishList(false);
      return;
    }

    const speciesGroups = new Map<string, typeof sellableRows>();
    for (const row of sellableRows) {
      speciesGroups.set(row.speciesId, [...(speciesGroups.get(row.speciesId) ?? []), row]);
    }

    const pages = [...speciesGroups.entries()].map(([, rows], speciesIndex) => {
      const first = rows[0];
      const productCount = new Set(rows.map((row) => row.product?.id ?? row.stock.productId)).size;
      return `
        <section class="species-page ${speciesIndex > 0 ? "page-break" : ""}">
          <div class="species-head">
            <div>
              <h2>${escapeHtml(first.speciesName)}</h2>
              <div class="muted">
                ${first.species?.scientificName ? `中文学名：${escapeHtml(first.species.scientificName)} · ` : ""}
                ${first.species?.commonNames?.length ? `俗名：${escapeHtml(first.species.commonNames.join("、"))}` : ""}
              </div>
            </div>
            <div class="count-box">
              <div class="count">${rows.length}</div>
              <div class="muted">可售条数</div>
            </div>
          </div>
          <div class="summary">商品规格 ${productCount} 种 · 仅包含未售、未损耗、未出库、非疾病状态的鱼</div>
          <table>
            <thead>
              <tr>
                <th class="idx">#</th>
                <th>商品</th>
                <th class="size">尺寸</th>
                <th>产地</th>
                <th>缸位</th>
                <th>编号</th>
                <th>状态</th>
                <th class="price">售价</th>
                <th>备注</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((row, index) => `
                <tr>
                  <td class="idx">${index + 1}</td>
                  <td>${escapeHtml(row.product?.name ?? row.stock.productId)}</td>
                  <td class="size">${escapeHtml(row.product?.size || "—")}</td>
                  <td>${escapeHtml(row.product?.origin || "—")}</td>
                  <td>${escapeHtml(exportTankName(row.stock.subTankId))}</td>
                  <td>${escapeHtml(row.stock.code || "—")}</td>
                  <td>${escapeHtml(row.statusLabel)}</td>
                  <td class="price">¥${Number(row.price || 0).toFixed(2)}</td>
                  <td>${escapeHtml(row.stock.notes || row.product?.notes || "—")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </section>
      `;
    }).join("");

    const html = `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            @page { size: A4 portrait; margin: 12mm 10mm; }
            body { font-family: Arial, "Microsoft YaHei", sans-serif; color: #111827; font-size: 9.5pt; }
            h1 { margin: 0 0 4pt; font-size: 18pt; }
            h2 { margin: 0; font-size: 16pt; }
            .doc-head { margin-bottom: 12pt; border-bottom: 2px solid #0f70a8; padding-bottom: 8pt; }
            .muted { color: #64748b; font-size: 9pt; }
            .species-page { page-break-inside: avoid; break-inside: avoid; }
            .page-break { page-break-before: always; }
            .species-head { display: flex; justify-content: space-between; gap: 12pt; align-items: flex-start; margin-bottom: 6pt; }
            .count-box { min-width: 64pt; border: 1px solid #cbd5e1; background: #f8fafc; text-align: center; padding: 5pt 8pt; }
            .count { font-size: 18pt; font-weight: 700; color: #0f70a8; }
            .summary { margin-bottom: 8pt; color: #475569; font-size: 9pt; }
            table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-bottom: 8pt; }
            th, td { border: 1px solid #cbd5e1; padding: 5pt 5pt; vertical-align: top; word-break: break-word; }
            th { background: #eef6fb; font-weight: 700; text-align: left; }
            .idx { width: 20pt; text-align: center; }
            .size { width: 42pt; text-align: center; }
            .price { width: 48pt; text-align: right; white-space: nowrap; }
          </style>
        </head>
        <body>
          <div class="doc-head">
            <h1>可售鱼单</h1>
            <div class="muted">共 ${sellableRows.length} 条 · ${speciesGroups.size} 个物种 · 导出时间 ${new Date().toLocaleString("zh-CN", { hour12: false })}</div>
          </div>
          ${pages}
        </body>
      </html>`;

    const blob = new Blob(["\ufeff", html], { type: "application/msword;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFilename(today)}_可售鱼单.doc`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast.success(`已导出可售鱼单：${sellableRows.length} 条`);
    setExportingFishList(false);
  };

  const cards = [
    { label: "今日收款金额", value: formatMoney(todayReceived), icon: Banknote, color: "bg-emerald-500" },
    { label: "今日退款金额", value: formatMoney(todayRefunded), icon: RotateCcw, color: "bg-rose-500" },
    { label: "今日发货出库", value: `${todayShippedOut} 条`, icon: Truck, color: "bg-indigo-500" },
    { label: "在缸鱼类", value: inFishStock, icon: Fish, color: "bg-sky-500" },
    { label: "缸组/子缸", value: `${tankGroupCount} / ${subTankCount}`, icon: PackageSearch, color: "bg-emerald-500" },
    { label: "疾病观察中", value: sick, icon: AlertTriangle, color: "bg-red-500" },
    { label: "进行中订单", value: activeOrders, icon: ShoppingBag, color: "bg-orange-500" },
    { label: "待发/运输中", value: pendingShipments, icon: Truck, color: "bg-purple-500" },
    { label: "销售总额(¥)", value: totalRevenue.toFixed(0), icon: TrendingUp, color: "bg-teal-500" },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2>欢迎回来，{state.user?.username}</h2>
          <p className="text-sm text-muted-foreground">
            海水鱼房经营概览 · 当前看板：{dashboardSiteId === ALL_SITE_ID ? "全部场地" : siteName(state, dashboardSiteId)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 rounded-md border bg-white px-3 py-2 text-sm text-muted-foreground">
            <span>看板范围</span>
            <select
              value={dashboardSiteId}
              onChange={(event) => setDashboardSiteId(event.target.value)}
              className="bg-transparent font-medium text-foreground outline-none"
            >
              <option value={ALL_SITE_ID}>全部场地</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>{site.name}</option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" onClick={exportAvailableFishList} disabled={exportingFishList}>
            <Download className="size-4 mr-1.5" />
            {exportingFishList ? "导出中..." : "导出鱼单"}
          </Button>
        </div>
      </div>
      <div className="order-2 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label} className="p-5 flex items-center gap-4">
              <div className={`size-12 rounded-xl ${c.color} text-white flex items-center justify-center`}>
                <Icon className="size-6" />
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{c.label}</div>
                <div className="text-2xl font-semibold">{c.value}</div>
              </div>
            </Card>
          );
        })}
      </div>
      <Card className="order-3 p-5">
        <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h3 className="text-base font-semibold">关注商品 / 物种</h3>
            <p className="text-xs text-muted-foreground">
              查看单一商品或物种的销售、去化周期、损耗和在库情况
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="inline-flex rounded-lg border bg-muted/30 p-1">
              {(["species", "product"] as FocusMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setFocusMode(mode);
                    setFocusSearch("");
                    setFocusId("");
                  }}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    focusMode === mode
                      ? "bg-white text-sky-700 shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {mode === "species" ? "按物种" : "按商品"}
                </button>
              ))}
            </div>
            <input
              value={focusSearch}
              onChange={(event) => setFocusSearch(event.target.value)}
              placeholder={focusMode === "species" ? "搜索物种/俗名..." : "搜索商品/尺寸/产地..."}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none transition-colors focus:border-sky-400 sm:w-56"
            />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.65fr)]">
          <div className="overflow-hidden rounded-lg border bg-white">
            <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
              <div className="text-sm font-medium">{focusMode === "species" ? "物种列表" : "商品列表"}</div>
              <div className="text-xs text-muted-foreground">按在缸库存从多到少</div>
            </div>
            <div className="max-h-[34rem] overflow-y-auto">
              {visibleFocusOptions.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {focusLoading ? "数据加载中..." : "没有匹配结果"}
                </div>
              ) : visibleFocusOptions.map((option, index) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setFocusId(option.id)}
                  className={`flex w-full items-center gap-3 border-b px-3 py-3 text-left transition-colors last:border-b-0 ${
                    focusId === option.id
                      ? "bg-sky-50 text-sky-900"
                      : "hover:bg-muted/40"
                  }`}
                >
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    focusId === option.id ? "bg-sky-600 text-white" : "bg-muted text-muted-foreground"
                  }`}>
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{option.label}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {option.subLabel || (focusMode === "species" ? "暂无分类/俗名" : "暂无规格/产地")}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-lg font-semibold leading-none">{option.inTankCount}</span>
                    <span className="mt-1 block text-[10px] text-muted-foreground">在缸</span>
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="min-w-0">
            {!focusMetrics ? (
              <div className="rounded-lg border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                {focusLoading ? "正在加载关注看板数据..." : "请选择要关注的商品或物种"}
              </div>
            ) : (
              <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
              <div className="rounded-lg border bg-sky-50 px-3 py-3">
                <div className="text-xs text-sky-700">累计销售</div>
                <div className="mt-1 text-xl font-semibold">{focusMetrics.salesCount} 条</div>
                <div className="mt-1 text-xs text-sky-700">{formatMoney(focusMetrics.salesAmount)}</div>
              </div>
              <div className="rounded-lg border bg-emerald-50 px-3 py-3">
                <div className="text-xs text-emerald-700">近30天销售</div>
                <div className="mt-1 text-xl font-semibold">{focusMetrics.salesCount30} 条</div>
                <div className="mt-1 text-xs text-emerald-700">{formatMoney(focusMetrics.salesAmount30)}</div>
              </div>
              <div className="rounded-lg border bg-indigo-50 px-3 py-3">
                <div className="text-xs text-indigo-700">平均去化</div>
                <div className="mt-1 text-xl font-semibold">
                  {focusMetrics.turnoverSampleCount > 0 ? `${focusMetrics.averageTurnoverDays.toFixed(1)} 天` : "—"}
                </div>
                <div className="mt-1 text-xs text-indigo-700">按入库到下单计算</div>
              </div>
              <div className="rounded-lg border bg-amber-50 px-3 py-3">
                <div className="text-xs text-amber-700">预计去化</div>
                <div className="mt-1 text-xl font-semibold">
                  {focusMetrics.estimatedClearDays !== null ? `${Math.ceil(focusMetrics.estimatedClearDays)} 天` : "—"}
                </div>
                <div className="mt-1 text-xs text-amber-700">按近30天日均销量</div>
              </div>
              <div className="rounded-lg border bg-slate-50 px-3 py-3">
                <div className="text-xs text-slate-600">当前在缸</div>
                <div className="mt-1 text-xl font-semibold">{focusMetrics.inTank} 条</div>
                <div className="mt-1 text-xs text-slate-600">可售 {focusMetrics.sellable} / 已售 {focusMetrics.soldInTank} / 疾病 {focusMetrics.sick}</div>
              </div>
              <div className="rounded-lg border bg-red-50 px-3 py-3">
                <div className="text-xs text-red-700">损耗</div>
                <div className="mt-1 text-xl font-semibold">{focusMetrics.lost} 条</div>
                <div className="mt-1 text-xs text-red-700">损耗率 {focusMetrics.lossRate.toFixed(1)}%</div>
              </div>
            </div>

            <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
              <div className="overflow-hidden rounded-lg border">
                <div className="border-b bg-muted/30 px-3 py-2 text-sm font-medium">
                  {focusMode === "species" ? "商品规格明细" : "商品明细"}
                </div>
                <div className="max-h-72 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-muted/40">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2 font-medium">商品</th>
                        <th className="px-3 py-2 font-medium">规格/产地</th>
                        <th className="px-3 py-2 text-right font-medium">可售</th>
                        <th className="px-3 py-2 text-right font-medium">已售在缸</th>
                        <th className="px-3 py-2 text-right font-medium">疾病</th>
                        <th className="px-3 py-2 text-right font-medium">损耗</th>
                        <th className="px-3 py-2 text-right font-medium">销售额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {focusAnalysis.productRows.slice(0, 16).map((row) => (
                        <tr key={row.product.id} className="border-t">
                          <td className="px-3 py-2">
                            <div className="font-medium">{row.product.name}</div>
                            <div className="text-xs text-muted-foreground">{row.species?.name ?? "未关联物种"}</div>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {[row.product.size, row.product.origin].filter(Boolean).join(" / ") || "—"}
                          </td>
                          <td className="px-3 py-2 text-right font-medium">{row.sellable}</td>
                          <td className="px-3 py-2 text-right">{row.soldInTank}</td>
                          <td className="px-3 py-2 text-right text-red-600">{row.sick}</td>
                          <td className="px-3 py-2 text-right text-red-600">{row.lost}</td>
                          <td className="px-3 py-2 text-right text-sky-700">{formatMoney(row.salesAmount)}</td>
                        </tr>
                      ))}
                      {focusAnalysis.productRows.length === 0 && (
                        <tr>
                          <td colSpan={7} className="px-3 py-8 text-center text-sm text-muted-foreground">
                            暂无明细
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="rounded-lg border bg-muted/10 p-4">
                <div className="text-sm font-medium">口径说明</div>
                <div className="mt-3 flex flex-col gap-2 text-xs text-muted-foreground">
                  <p>销售：统计未取消订单中的对应商品金额和数量。</p>
                  <p>平均去化：按每条已售鱼的入库日期到订单下单日期计算。</p>
                  <p>预计去化：当前可售数量除以近 30 天日均销量；没有近 30 天销售时显示为空。</p>
                  <p>在缸：未损耗、未出库的实物；其中已售在缸表示客户已下单但还没出库。</p>
                  <p>损耗率：损耗数量 / 该关注对象历史入库数量。</p>
                  {focusMetrics.currentAverageAgeDays > 0 && (
                    <p className="rounded border bg-white px-2 py-1 text-slate-700">
                      当前可售鱼平均库龄：{focusMetrics.currentAverageAgeDays.toFixed(1)} 天
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
          </div>
        </div>
      </Card>
      <div className="order-1 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(360px,0.9fr)]">
        <Card className="p-5">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-base font-semibold">每日销售与退款</h3>
              <p className="text-xs text-muted-foreground">最近 {dailyFinanceData.length} 天收款金额和退款金额</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5 text-muted-foreground">
                <span>范围</span>
                <select
                  value={financeDays}
                  onChange={(event) => setFinanceDays(normalizeFinanceDays(Number(event.target.value)))}
                  className="h-8 rounded-md border bg-background px-2 text-xs text-foreground outline-none focus:border-sky-400"
                >
                  {FINANCE_DAY_OPTIONS.map((days) => (
                    <option key={days} value={days}>近 {days} 天</option>
                  ))}
                </select>
              </label>
              <span className="flex items-center gap-1.5 text-emerald-700">
                <span className="size-2.5 rounded-full bg-emerald-500" /> 收款
              </span>
              <span className="flex items-center gap-1.5 text-rose-700">
                <span className="size-2.5 rounded-full bg-rose-500" /> 退款
              </span>
            </div>
          </div>
          <div
            className="relative h-72"
            onMouseLeave={() => setHoveredFinanceIndex(null)}
          >
            {hoveredFinancePoint && (
              <div
                className="pointer-events-none absolute top-2 z-10 min-w-40 rounded-lg border bg-white/95 px-3 py-2 text-xs shadow-lg"
                style={{
                  left: `${(hoveredFinanceX / 960) * 100}%`,
                  transform: hoveredFinanceTransform,
                }}
              >
                <div className="mb-1 font-semibold text-slate-900">{hoveredFinancePoint.date}</div>
                <div className="flex items-center justify-between gap-5 text-emerald-700">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-emerald-500" />
                    收款
                  </span>
                  <span className="font-mono font-semibold">{formatMoney(hoveredFinancePoint.received)}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-5 text-rose-700">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-rose-500" />
                    退款
                  </span>
                  <span className="font-mono font-semibold">{formatMoney(hoveredFinancePoint.refunded)}</span>
                </div>
              </div>
            )}
            <svg viewBox="0 0 960 250" className="size-full" role="img" aria-label={`最近${dailyFinanceData.length}天收款和退款金额折线图`}>
              {financeTicks.map((tick) => (
                <g key={tick.ratio}>
                  <line x1="64" x2="940" y1={tick.y} y2={tick.y} stroke="#e5e7eb" strokeDasharray="4 4" />
                  <text x="10" y={tick.y + 4} fontSize="12" fill="#64748b">¥{formatCompactMoney(tick.value)}</text>
                </g>
              ))}
              <polyline
                points={linePoints(dailyFinanceData, "received", maxFinanceValue)}
                fill="none"
                stroke="#10b981"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points={linePoints(dailyFinanceData, "refunded", maxFinanceValue)}
                fill="none"
                stroke="#f43f5e"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {hoveredFinancePoint && (
                <g pointerEvents="none">
                  <line
                    x1={hoveredFinanceX}
                    x2={hoveredFinanceX}
                    y1="18"
                    y2="216"
                    stroke="#94a3b8"
                    strokeDasharray="4 4"
                  />
                  <circle
                    cx={hoveredFinanceX}
                    cy={18 + (1 - hoveredFinancePoint.received / maxFinanceValue) * 198}
                    r="5.5"
                    fill="#10b981"
                    stroke="#fff"
                    strokeWidth="2"
                  />
                  <circle
                    cx={hoveredFinanceX}
                    cy={18 + (1 - hoveredFinancePoint.refunded / maxFinanceValue) * 198}
                    r="5.5"
                    fill="#f43f5e"
                    stroke="#fff"
                    strokeWidth="2"
                  />
                </g>
              )}
              {dailyFinanceData.map((point, index) => {
                const divisor = Math.max(dailyFinanceData.length - 1, 1);
                const x = 64 + (index / divisor) * 876;
                const receivedY = 18 + (1 - point.received / maxFinanceValue) * 198;
                const refundedY = 18 + (1 - point.refunded / maxFinanceValue) * 198;
                return (
                  <g key={point.date}>
                    <circle cx={x} cy={receivedY} r="3.5" fill="#10b981">
                      <title>{`${point.date} 收款 ${formatMoney(point.received)}`}</title>
                    </circle>
                    <circle cx={x} cy={refundedY} r="3.5" fill="#f43f5e">
                      <title>{`${point.date} 退款 ${formatMoney(point.refunded)}`}</title>
                    </circle>
                    {(index % financeLabelStep === 0 || index === dailyFinanceData.length - 1) && (
                      <text x={x} y="246" textAnchor="middle" fontSize="12" fill="#64748b">{point.label}</text>
                    )}
                  </g>
                );
              })}
              {dailyFinanceData.map((point, index) => {
                const divisor = Math.max(dailyFinanceData.length - 1, 1);
                const bandWidth = 876 / divisor;
                const x = 64 + (index / divisor) * 876;
                const x1 = Math.max(64, x - bandWidth / 2);
                const x2 = Math.min(940, x + bandWidth / 2);
                return (
                  <rect
                    key={`hover-${point.date}`}
                    x={x1}
                    y="18"
                    width={Math.max(1, x2 - x1)}
                    height="228"
                    fill="transparent"
                    onMouseEnter={() => setHoveredFinanceIndex(index)}
                    onMouseMove={() => setHoveredFinanceIndex(index)}
                  >
                    <title>{`${point.date}\n收款 ${formatMoney(point.received)}\n退款 ${formatMoney(point.refunded)}`}</title>
                  </rect>
                );
              })}
            </svg>
          </div>
        </Card>

	        <Card className="p-5">
	          <div className="mb-4">
	            <h3 className="text-base font-semibold">鱼类状态构成</h3>
	            <p className="text-xs text-muted-foreground">仅统计鱼类，虾类等无脊椎生物不计入</p>
	          </div>
	          <div className="h-72">
	            <div className="flex h-full items-center justify-center gap-6 rounded-lg border bg-slate-50/60 px-5 py-4">
	              <svg viewBox="0 0 240 240" className="h-full max-h-60 min-w-0 flex-1" role="img" aria-label="在缸鱼数量状态饼状图">
	                <circle cx="120" cy="120" r="92" fill="#e2e8f0" />
	                {pieSegments.map((segment) => (
	                  <path
	                    key={segment.key}
	                    d={describeDonutSegment(120, 120, 92, 54, segment.startAngle, segment.endAngle)}
	                    fill={segment.colorHex}
	                    stroke="#f8fafc"
	                    strokeWidth="2"
	                  >
	                    <title>{`${segment.label} ${segment.value} 条，占 ${(segment.value / stockStatusTotal * 100).toFixed(1)}%`}</title>
	                  </path>
	                ))}
	                <circle cx="120" cy="120" r="52" fill="#ffffff" />
	                <text x="120" y="112" textAnchor="middle" fontSize="13" fill="#64748b">鱼类总数</text>
	                <text x="120" y="138" textAnchor="middle" fontSize="28" fontWeight="700" fill="#0f172a">{inFishStock}</text>
	              </svg>
	              <div className="flex min-w-28 flex-col gap-3 text-xs">
	                {stockStatusSegments.map((segment) => (
	                  <div key={segment.key} className="flex items-center justify-between gap-3">
	                    <span className="flex items-center gap-2">
	                      <span className={`size-3 rounded-full ${segment.color}`} />
	                      <span>{segment.label}</span>
	                    </span>
	                    <span className="font-semibold text-foreground">{segment.value}</span>
	                  </div>
	                ))}
	              </div>
	            </div>
	          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
            {stockStatusSegments.map((segment) => (
              <div key={segment.key} className={`rounded-md ${segment.bgColor} px-2 py-2 ${segment.textColor}`}>
                {segment.label} {segment.value} 条
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-base font-semibold">每日损耗趋势</h3>
              <p className="text-xs text-muted-foreground">
                最近 {dailyLossData.length} 天死鱼数量、库存占比和预计销售价值
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                合计 {lossRangeTotal} 条
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                预计价值 {formatMoney(lossRangeValue)}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                平均占比 {lossRangeAvgRate.toFixed(2)}%
              </span>
              <span className="rounded-full bg-indigo-50 px-2 py-1 text-indigo-700">
                到货 {lossRangeBatchCount} 批
              </span>
            </div>
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-4 text-xs">
            <span className="flex items-center gap-1.5 text-red-700">
              <span className="size-2.5 rounded-full bg-red-500" /> 死鱼数量
            </span>
            <span className="flex items-center gap-1.5 text-amber-700">
              <span className="size-2.5 rounded-full bg-amber-500" /> 库存占比
            </span>
            <span className="flex items-center gap-1.5 text-sky-700">
              <span className="size-2.5 rounded-full bg-sky-500" /> 预计销售价值
            </span>
            <span className="flex items-center gap-1.5 text-indigo-700">
              <span className="h-3 w-2 rounded-sm bg-indigo-500" /> 到货批次
            </span>
            <span className="text-muted-foreground">三条线独立缩放，悬停查看真实数值，点击日期查看明细</span>
          </div>
          <div
            className="relative h-72"
            onMouseLeave={() => setHoveredLossIndex(null)}
          >
            {hoveredLossPoint && (
              <div
                className="pointer-events-none absolute top-2 z-10 min-w-56 rounded-lg border bg-white/95 px-3 py-2 text-xs shadow-lg"
                style={{
                  left: `${(hoveredLossX / 960) * 100}%`,
                  transform: hoveredLossTransform,
                }}
              >
                <div className="mb-1 font-semibold text-slate-900">{hoveredLossPoint.date}</div>
                <div className="flex items-center justify-between gap-5 text-red-700">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-red-500" />
                    死鱼数量
                  </span>
                  <span className="font-mono font-semibold">{hoveredLossPoint.lostCount} 条</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-5 text-amber-700">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-amber-500" />
                    库存占比
                  </span>
                  <span className="font-mono font-semibold">{hoveredLossPoint.lossRate.toFixed(2)}%</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-5 text-sky-700">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-sky-500" />
                    预计价值
                  </span>
                  <span className="font-mono font-semibold">{formatMoney(hoveredLossPoint.estimatedValue)}</span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  当日库存基数：{hoveredLossPoint.stockBase} 条
                </div>
                {(hoveredLossPoint.batchArrivals?.length ?? 0) > 0 && (
                  <div className="mt-1 text-indigo-700">
                    当日到货：{hoveredLossPoint.batchArrivals?.length ?? 0} 批
                  </div>
                )}
              </div>
            )}
            <svg viewBox="0 0 960 250" className="size-full" role="img" aria-label={`最近${dailyLossData.length}天损耗指标折线图`}>
              {[18, 67.5, 117, 166.5, 216].map((y) => (
                <line key={y} x1="64" x2="940" y1={y} y2={y} stroke="#e5e7eb" strokeDasharray="4 4" />
              ))}
              {dailyLossData.map((point, index) => {
                const arrivals = point.batchArrivals ?? [];
                if (arrivals.length === 0) return null;
                const x = chartX(index, dailyLossData.length);
                return (
                  <g key={`loss-arrival-${point.date}`} pointerEvents="none">
                    <line
                      x1={x}
                      x2={x}
                      y1="18"
                      y2="216"
                      stroke="#6366f1"
                      strokeDasharray="3 5"
                      strokeWidth="1.5"
                      opacity="0.55"
                    />
                    <path d={`M ${x} 18 l -6 10 h 12 Z`} fill="#6366f1" opacity="0.9" />
                    {arrivals.length > 1 && (
                      <text x={x} y="43" textAnchor="middle" fontSize="11" fontWeight="700" fill="#4f46e5">
                        {arrivals.length}
                      </text>
                    )}
                    <title>{`${point.date} 到货 ${arrivals.length} 批`}</title>
                  </g>
                );
              })}
              <polyline
                points={metricLinePoints(dailyLossData, (point) => point.lostCount, maxLossCount)}
                fill="none"
                stroke="#ef4444"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points={metricLinePoints(dailyLossData, (point) => point.lossRate, maxLossRate)}
                fill="none"
                stroke="#f59e0b"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points={metricLinePoints(dailyLossData, (point) => point.estimatedValue, maxLossValue)}
                fill="none"
                stroke="#0ea5e9"
                strokeWidth="3.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {hoveredLossPoint && (
                <g pointerEvents="none">
                  <line
                    x1={hoveredLossX}
                    x2={hoveredLossX}
                    y1="18"
                    y2="216"
                    stroke="#94a3b8"
                    strokeDasharray="4 4"
                  />
                  <circle cx={hoveredLossX} cy={chartY(hoveredLossPoint.lostCount, maxLossCount)} r="5.5" fill="#ef4444" stroke="#fff" strokeWidth="2" />
                  <circle cx={hoveredLossX} cy={chartY(hoveredLossPoint.lossRate, maxLossRate)} r="5.5" fill="#f59e0b" stroke="#fff" strokeWidth="2" />
                  <circle cx={hoveredLossX} cy={chartY(hoveredLossPoint.estimatedValue, maxLossValue)} r="5.5" fill="#0ea5e9" stroke="#fff" strokeWidth="2" />
                </g>
              )}
              {dailyLossData.map((point, index) => {
                const x = chartX(index, dailyLossData.length);
                return (
                  <g key={point.date}>
                    <circle cx={x} cy={chartY(point.lostCount, maxLossCount)} r="3.5" fill="#ef4444">
                      <title>{`${point.date} 死鱼 ${point.lostCount} 条`}</title>
                    </circle>
                    <circle cx={x} cy={chartY(point.lossRate, maxLossRate)} r="3.5" fill="#f59e0b">
                      <title>{`${point.date} 库存占比 ${point.lossRate.toFixed(2)}%`}</title>
                    </circle>
                    <circle cx={x} cy={chartY(point.estimatedValue, maxLossValue)} r="3.5" fill="#0ea5e9">
                      <title>{`${point.date} 预计价值 ${formatMoney(point.estimatedValue)}`}</title>
                    </circle>
                    {(index % lossLabelStep === 0 || index === dailyLossData.length - 1) && (
                      <text x={x} y="246" textAnchor="middle" fontSize="12" fill="#64748b">{point.label}</text>
                    )}
                  </g>
                );
              })}
              {dailyLossData.map((point, index) => {
                const divisor = Math.max(dailyLossData.length - 1, 1);
                const bandWidth = 876 / divisor;
                const x = chartX(index, dailyLossData.length);
                const x1 = Math.max(64, x - bandWidth / 2);
                const x2 = Math.min(940, x + bandWidth / 2);
                return (
                  <rect
                    key={`loss-hover-${point.date}`}
                    x={x1}
                    y="18"
                    width={Math.max(1, x2 - x1)}
                    height="228"
                    fill="transparent"
                    onMouseEnter={() => setHoveredLossIndex(index)}
                    onMouseMove={() => setHoveredLossIndex(index)}
                    onClick={() => setSelectedLossPoint(point)}
                    cursor="pointer"
                  >
                    <title>{`${point.date}\n死鱼 ${point.lostCount} 条\n库存占比 ${point.lossRate.toFixed(2)}%\n预计价值 ${formatMoney(point.estimatedValue)}\n到货 ${(point.batchArrivals ?? []).length} 批`}</title>
                  </rect>
                );
              })}
            </svg>
          </div>
        </Card>
      </div>
      <Card className="order-4 p-6">
        <h3 className="mb-3">使用提示</h3>
        <ul className="text-sm text-muted-foreground flex flex-col gap-2 list-disc pl-5">
          <li>在「品名管理」中先维护物种和商品（带图片），再开始入库。</li>
          <li>「缸组管理」用大框表示缸组，小框表示子缸；可拖入新增子缸。</li>
          <li>「商品入库」按子缸可视化排布，每条鱼右上角显示状态标识。</li>
          <li>「日常管理」点击鱼图标打开<strong>生物详情</strong>：可查看时间轴、上传照片、添加观察记录，调整健康/疾病/开口状态。</li>
          <li>「订单管理」创建销售订单后，商品自动标记为已售，时间轴中记录销售时间。</li>
          <li>在「订单管理」的订单详情中记录发货、签收、报损和补发。</li>
        </ul>
      </Card>
      <Dialog
        open={Boolean(selectedLossPoint)}
        onOpenChange={(open) => {
          if (!open) setSelectedLossPoint(null);
        }}
      >
        <DialogContent aria-describedby={undefined} className="max-h-[85vh] max-w-3xl overflow-y-auto">
          {selectedLossPoint && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedLossPoint.date} 损耗与到货明细</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg border bg-red-50 px-3 py-2">
                  <div className="text-xs text-red-700">死鱼数量</div>
                  <div className="text-xl font-semibold text-red-700">{selectedLossPoint.lostCount} 条</div>
                </div>
                <div className="rounded-lg border bg-amber-50 px-3 py-2">
                  <div className="text-xs text-amber-700">库存占比</div>
                  <div className="text-xl font-semibold text-amber-700">{selectedLossPoint.lossRate.toFixed(2)}%</div>
                </div>
                <div className="rounded-lg border bg-sky-50 px-3 py-2">
                  <div className="text-xs text-sky-700">预计价值</div>
                  <div className="text-xl font-semibold text-sky-700">{formatMoney(selectedLossPoint.estimatedValue)}</div>
                </div>
                <div className="rounded-lg border bg-indigo-50 px-3 py-2">
                  <div className="text-xs text-indigo-700">到货批次</div>
                  <div className="text-xl font-semibold text-indigo-700">{selectedLossPoint.batchArrivals?.length ?? 0} 批</div>
                </div>
              </div>
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">当天到货批次</h4>
                {(selectedLossPoint.batchArrivals ?? []).length > 0 ? (
                  <div className="grid gap-2">
                    {(selectedLossPoint.batchArrivals ?? []).map((batch) => (
                      <div key={batch.id} className="rounded-lg border px-3 py-2 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold">{batch.batchNo || "未编号批次"}</span>
                          <span className="text-xs text-muted-foreground">{batch.arrivalDate}</span>
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          供应商：{batch.supplier || "未填写"} · 入库 {batch.stockedCount} 条 · 已损耗 {batch.lossCount} 条 · 费用 {formatMoney(batch.bioFee + batch.shippingFee)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
                    当天没有采购批次到货。
                  </div>
                )}
              </section>
              <section className="space-y-2">
                <h4 className="text-sm font-semibold">当天损耗记录</h4>
                {(selectedLossPoint.lossDetails ?? []).length > 0 ? (
                  <div className="overflow-hidden rounded-lg border">
                    <div className="grid grid-cols-[1.2fr_1fr_1fr_0.8fr] gap-3 bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
                      <span>商品</span>
                      <span>缸位</span>
                      <span>批次</span>
                      <span className="text-right">预计价值</span>
                    </div>
                    {(selectedLossPoint.lossDetails ?? []).map((detail) => (
                      <div key={`${detail.id}-${detail.stockItemId}`} className="grid grid-cols-[1.2fr_1fr_1fr_0.8fr] gap-3 border-t px-3 py-2 text-sm">
                        <div>
                          <div className="font-semibold">
                            {detail.productName}
                            {detail.code ? <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">编号 {detail.code}</span> : null}
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {[detail.speciesName, detail.size, detail.origin].filter(Boolean).join(" · ") || "商品信息未填写完整"}
                          </div>
                          {detail.reason ? <div className="mt-0.5 text-xs text-red-700">原因：{detail.reason}</div> : null}
                        </div>
                        <div className="text-muted-foreground">{detail.tankName || "未知缸位"}</div>
                        <div className="text-muted-foreground">
                          <div>{detail.batchNo || "未关联批次"}</div>
                          <div className="text-xs">{[detail.supplier, detail.arrivalDate].filter(Boolean).join(" · ")}</div>
                        </div>
                        <div className="text-right font-semibold">{formatMoney(detail.estimatedValue)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
                    当天没有损耗记录。
                  </div>
                )}
              </section>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
