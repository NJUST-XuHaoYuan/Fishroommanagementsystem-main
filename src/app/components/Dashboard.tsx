import { useEffect, useMemo, useState } from "react";
import { configuredOrderPackagingFee, DEFAULT_FISH_LIST_FOOTER_TEXT, Customer, isPaymentVerified, isPersonnelResigned, Order, Personnel, Product, PurchaseBatch, Shipment, Species, StockItem, StockLossRecord, TankGroup, useStore } from "../store";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { Fish, PackageSearch, AlertTriangle, ShoppingBag, Truck, TrendingUp, Banknote, RotateCcw, Download, Settings2, CircleAlert, BadgeDollarSign } from "lucide-react";
import { getInventoryOutStockIds, isPhysicallyInTank, normalizeInventoryId } from "../utils/inventory";
import { toast } from "sonner";
import { ALL_SITE_ID, getSites, matchesSite, normalizeSiteScope, siteName, stockMatchesSite } from "../utils/sites";
import { authJsonHeaders } from "../utils/authSession";
import { buildStockPriceBaselines, isStockSpecialPrice, stockSalePrice } from "../utils/stockPricing";
import { isPlatformOrderSource, platformOrderDisplayName } from "../utils/orderSources";
import { getBillableShippingFee } from "../utils/orderFees";
import { dashboardOrderAdjustmentTotals } from "../../../server/dashboard-sales-metrics.mjs";
import { healthyFishInventoryMetrics } from "../../../server/dashboard-healthy-fish-value.mjs";
import { resolveDashboardDateRange } from "../../../server/dashboard-date-range.mjs";
import { DashboardDateFilter, DashboardSalespersonFilter, type DashboardDateRange } from "./DashboardFilters";
import { dashboardSalespersonSelection, rankDashboardSalespeople } from "../utils/dashboardSalespeople";
import { canAccessDashboard } from "../utils/dashboardAccess";

function todayDateString(): string {
  // Dashboard business days follow China time, including when viewed overseas.
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
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

type DailyFinancePoint = {
  date: string;
  label: string;
  received: number;
  refunded?: number;
  unshippedRefund: number;
  shippedDamage: number;
  orderAmount: number;
  platformAmount: number;
  offlinePickupAmount: number;
  privateDomainAmount: number;
};

type DailyFinanceMetricKey = "received" | "unshippedRefund" | "shippedDamage" | "orderAmount";

const FINANCE_SERIES: Array<{ key: DailyFinanceMetricKey; label: string; color: string }> = [
  { key: "received", label: "实际收款", color: "#10b981" },
  { key: "unshippedRefund", label: "退单金额", color: "#f43f5e" },
  { key: "shippedDamage", label: "报损金额", color: "#f59e0b" },
  { key: "orderAmount", label: "订单金额", color: "#0ea5e9" },
];

type DailyLossDetail = {
  id: string;
  stockItemId: string;
  productName: string;
  speciesName: string;
  size: string;
  origin: string;
  tankName: string;
  siteId?: string;
  siteName?: string;
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

type DailySalespersonOrderDetail = {
  orderId: string;
  orderNo: string;
  customerName: string;
  contactPerson: string;
  amount: number;
  itemCount: number;
  status: string;
  notes: string;
};

type DailySalespersonBreakdown = {
  salesperson: string;
  amount: number;
  orderCount: number;
  itemCount: number;
  orders: DailySalespersonOrderDetail[];
};

type DailySalespersonPoint = {
  date: string;
  label: string;
  total: number;
  orderCount: number;
  itemCount: number;
  breakdowns: DailySalespersonBreakdown[];
};

type DashboardSummary = {
  siteId?: string;
  todayReceived: number;
  todayUnshippedRefund: number;
  todayShippedDamage: number;
  todayRefunded?: number;
  todayShippedOut: number;
  inFishStock: number;
  sick: number;
  inTankSold: number;
  inTankSick: number;
  inTankNormal: number;
  healthyFishStockValue?: number;
  healthyFishStockCount?: number;
  healthyFishUnpricedCount?: number;
  tankGroupCount: number;
  subTankCount: number;
  activeOrders: number;
  totalRevenue: number;
  pendingShipments: number;
  financeDays?: number;
  startDate?: string;
  endDate?: string;
  dailyFinanceData: DailyFinancePoint[];
  dailyLossData?: DailyLossPoint[];
  dailySalespersonData?: DailySalespersonPoint[];
  salespersonOptions?: Array<{ name: string; orderCount: number; amount: number }>;
  focusOptions?: Record<FocusMode, FocusOption[]>;
  defaultFocus?: FocusDetail | null;
};

type FocusMode = "species" | "product";

type FocusData = {
  species: Species[];
  products: Product[];
  tankGroups: TankGroup[];
  stock: StockItem[];
  orders: Order[];
  shipments: Shipment[];
  lossRecords: StockLossRecord[];
  customers: Customer[];
  personnel: Personnel[];
  inventoryProjection?: {
    outStockIds: string[];
    outDateByStockId?: Record<string, string>;
  };
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

type FocusMetrics = {
  salesCount: number;
  salesAmount: number;
  salesCount30: number;
  salesAmount30: number;
  averageTurnoverDays: number;
  turnoverSampleCount: number;
  currentAverageAgeDays: number;
  estimatedClearDays: number | null;
  inTank: number;
  sellable: number;
  soldInTank: number;
  sick: number;
  lost: number;
  totalStock: number;
  lossRate: number;
};

type FocusDetail = {
  mode: FocusMode;
  id: string;
  metrics: FocusMetrics;
  productRows: FocusProductRow[];
};

function financeMetricValue(point: DailyFinancePoint, key: DailyFinanceMetricKey): number {
  return Number(point[key] || 0);
}

function normalizeDailyFinancePoint(point: Partial<DailyFinancePoint>): DailyFinancePoint {
  const date = String(point.date ?? "");
  return {
    date,
    label: String(point.label ?? shortDateLabel(date)),
    received: Number(point.received || 0),
    unshippedRefund: Number(point.unshippedRefund ?? point.refunded ?? 0),
    shippedDamage: Number(point.shippedDamage || 0),
    orderAmount: Number(point.orderAmount || 0),
    platformAmount: Number(point.platformAmount || 0),
    offlinePickupAmount: Number(point.offlinePickupAmount || 0),
    privateDomainAmount: Number(point.privateDomainAmount || 0),
  };
}

function linePoints(data: DailyFinancePoint[], key: DailyFinanceMetricKey, maxValue: number): string {
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
    const y = top + (1 - financeMetricValue(point, key) / maxValue) * chartHeight;
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

const SALESPERSON_COLORS = [
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#14b8a6",
  "#f97316",
  "#64748b",
  "#ec4899",
  "#22c55e",
];

const ORDER_STATUS_TEXT: Record<string, string> = {
  pending: "未完成",
  confirmed: "已确认",
  shipped: "发货中",
  completed: "已完成",
  cancelled: "已取消",
  damaged: "已报损",
};

function normalizeSalespersonName(value?: string): string {
  return String(value ?? "").trim() || "未指定";
}

function calcAmountRefundedForOrder(order: Order): number {
  return (order.payments ?? [])
    .filter((payment) => payment.type === "refund" && isPaymentVerified(payment))
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
}

function calcDamageRefundAdjustmentForOrder(order: Order, shipments: Shipment[]): number {
  const orderShipments = shipments.filter((shipment) => shipment.orderId === order.id);
  const explicitAdjustment = orderShipments.reduce((sum, shipment) => {
    if (shipment.status !== "damaged" || shipment.damageResolution !== "refund") return sum;
    return sum + Number(shipment.damageRefundAmount || 0);
  }, 0);
  if (explicitAdjustment > 0.005) return explicitAdjustment;
  const hasLegacyDamageRefund = orderShipments.some((shipment) =>
    shipment.status === "damaged" &&
    shipment.damageResolution === "refund" &&
    shipment.damageRefundAmount == null
  );
  return hasLegacyDamageRefund ? calcAmountRefundedForOrder(order) : 0;
}

function calcOrderDealAmount(order: Order, shipments: Shipment[]): number {
  const itemTotal = (order.items ?? []).reduce((sum, item) => sum + Number(item.price || 0), 0);
  return Number(Math.max(0,
    itemTotal +
    getBillableShippingFee(order, shipments) +
    Number(order.packagingFee || 0) -
    Number(order.discount || 0) -
    calcDamageRefundAdjustmentForOrder(order, shipments)
  ).toFixed(2));
}

function isValidSalesOrder(order: Order): boolean {
  return order.status !== "cancelled" && order.status !== "damaged";
}

function orderShipmentsFor(order: Order, shipments: Shipment[]): Shipment[] {
  return shipments.filter((shipment) => shipment.orderId === order.id);
}

function isOfflinePickupOrder(order: Order, orderShipments: Shipment[]): boolean {
  const source = String(order.source ?? "").trim();
  return source === "线下" || source === "线下自提" || (!source && orderShipments.some((shipment) => shipment.shipMethod === "pickup"));
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

function isFishInventoryItem(product?: Product, species?: Species): boolean {
  const text = [
    species?.category,
    species?.name,
    species?.scientificName,
    ...(Array.isArray(species?.commonNames) ? species.commonNames : []),
    product?.name,
    product?.size,
    product?.origin,
    product?.notes,
  ].filter(Boolean).join(" ");
  if (/(耗材|活石|活石头|珊瑚|活性炭|吸附|滤材|器材|设备|材料|药|盐|饲料|鱼粮|试剂)/.test(text)) return false;
  return isFishCategory(String(species?.category ?? text));
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

const FISH_LIST_CATEGORY_ORDER = [
  "吊类",
  "盖刺鱼科",
  "蝶类",
  "狐狸鱼",
  "隆头类",
  "海金鱼",
  "雀鲷科",
  "其他",
  "一物一价",
];

function fishListCategoryName(category?: string, speciesName?: string): string {
  const text = `${category ?? ""} ${speciesName ?? ""}`;
  if (/(吊|刺尾|Acanthur|Zebrasoma|Paracanthurus)/i.test(text)) return "吊类";
  if (/(盖刺|神仙|棘蝶|Pomacanth)/i.test(text)) return "盖刺鱼科";
  if (/(蝶|蝴蝶|Chaetodont)/i.test(text)) return "蝶类";
  if (/(狐狸|篮子|兔子|Sigan)/i.test(text)) return "狐狸鱼";
  if (/(隆头|龙|鹦鹉|飘飘|Labr|Halichoeres|Cirrhilabrus)/i.test(text)) return "隆头类";
  if (/(海金鱼|宝石|紫罗兰|Anthias|Pseudanthias)/i.test(text)) return "海金鱼";
  if (/(雀鲷|小丑|Pomacentr|Amphiprion)/i.test(text)) return "雀鲷科";
  return "其他";
}

function fishListCategoryRank(category: string): number {
  const index = FISH_LIST_CATEGORY_ORDER.indexOf(category);
  return index >= 0 ? index : FISH_LIST_CATEGORY_ORDER.length;
}

function formatFishListDate(dateString: string): string {
  const [, , month = "", day = ""] = dateString.match(/^(\d{4})-(\d{2})-(\d{2})$/) ?? [];
  return `${Number(month)} 月 ${Number(day)} 日`;
}

function formatFishListPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "一物一价";
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function uniqueText(parts: Array<unknown>): string {
  const seen = new Set<string>();
  const values = parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .filter((part) => {
      if (part === "—" || seen.has(part)) return false;
      seen.add(part);
      return true;
    });
  return values.length ? values.join("；") : "";
}

function normalizeFishListGroupText(value: unknown, fallback = "—"): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function normalizeFishListGroupPrice(value: unknown): number {
  const price = Number(value ?? 0);
  return Number.isFinite(price) ? Number(price.toFixed(2)) : 0;
}

function fishListStatusNote(stocks: StockItem[]): string {
  const feeding = stocks.filter((stock) => stock.status === "feeding").length;
  if (feeding === stocks.length && stocks.length > 0) return "开口颗粒";
  if (feeding > 0) return "部分颗粒";
  return "";
}

type FishListItemRow = {
  type: "item";
  categoryName: string;
  productName: string;
  size: string;
  origin: string;
  stockCount: number;
  priceText: string;
  priceValue: number;
  notes: string;
  special?: boolean;
};
type FishListDisplayRow = FishListItemRow | { type: "category"; categoryName: string };

const FISH_LIST_TEMPLATE_URL = "/assets/fish-list-template-bg.png";
const FISH_LIST_PDF_WIDTH = 595;
const FISH_LIST_PDF_HEIGHT = 842;
const FISH_LIST_TABLE = {
  x: 48,
  y: 171,
  width: 499,
  height: 558,
  headerHeight: 48,
  rowHeight: 31,
  columns: [92, 96, 60, 85, 166],
};

function loadFishListImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`无法加载鱼单模板：${src}`));
    image.src = src;
  });
}

function fitFontSize(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, startSize: number, minSize: number): number {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `800 ${size}px "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 1;
  }
  return minSize;
}

function splitTextByWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const normalized = String(text || "—").replace(/\s+/g, " ").trim();
  const lines: string[] = [];
  let current = "";
  for (const char of normalized) {
    const next = `${current}${char}`;
    if (ctx.measureText(next).width <= maxWidth || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = char;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) return lines.slice(0, maxLines);
  if (lines.length === maxLines && ctx.measureText(lines[lines.length - 1]).width > maxWidth) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

function wrapTextByWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  const lines: string[] = [];
  let current = "";
  for (const char of normalized) {
    const next = `${current}${char}`;
    if (ctx.measureText(next).width <= maxWidth || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = char;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawCenteredText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, width: number, fontSize: number, color = "#ffffff") {
  const size = fitFontSize(ctx, text, width, fontSize, Math.max(10, fontSize - 5));
  ctx.font = `800 ${size}px "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + width / 2, y);
}

function drawWrappedCellText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  centerY: number,
  width: number,
  options: { align?: CanvasTextAlign; fontSize?: number; maxLines?: number; color?: string } = {},
) {
  const fontSize = options.fontSize ?? 15;
  const maxLines = options.maxLines ?? 2;
  ctx.font = `800 ${fontSize}px "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
  ctx.fillStyle = options.color ?? "#ffffff";
  ctx.textAlign = options.align ?? "center";
  ctx.textBaseline = "middle";
  const lines = splitTextByWidth(ctx, text, width, maxLines);
  const lineHeight = fontSize * 1.15;
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    const tx = options.align === "left" ? x : x + width / 2;
    ctx.fillText(line, tx, startY + index * lineHeight);
  });
}

function drawFishListNameCell(ctx: CanvasRenderingContext2D, row: FishListItemRow, x: number, centerY: number, width: number) {
  const lines = splitTextByWidth(ctx, row.productName, width, 2);
  const fontSize = 15;
  const lineHeight = fontSize * 1.16;
  const startY = centerY - ((lines.length - 1) * lineHeight) / 2;
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  lines.slice(0, 2).forEach((line, index) => {
    const size = fitFontSize(ctx, line, width, fontSize, 10);
    ctx.font = `800 ${size}px "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
    ctx.fillText(line, x, startY + index * lineHeight);
  });
}

function coverTemplateDateAndPage(ctx: CanvasRenderingContext2D, dateLabel: string, pageNumber: number) {
  ctx.fillStyle = "#120626";
  ctx.fillRect(228, 40, 142, 55);
  drawCenteredText(ctx, dateLabel, 228, 68, 142, 22);
  ctx.fillStyle = "#07031a";
  ctx.fillRect(280, 775, 35, 22);
  ctx.font = '400 12px Georgia, "Times New Roman", serif';
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(pageNumber), FISH_LIST_PDF_WIDTH / 2, 784);
}

function createFishListPageCanvas(template: HTMLImageElement, dateLabel: string, pageNumber: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = template.naturalWidth || 1190;
  canvas.height = template.naturalHeight || 1684;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持 Canvas 导出");
  ctx.drawImage(template, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(canvas.width / FISH_LIST_PDF_WIDTH, 0, 0, canvas.height / FISH_LIST_PDF_HEIGHT, 0, 0);
  coverTemplateDateAndPage(ctx, dateLabel, pageNumber);
  return ctx;
}

function drawFishListTable(ctx: CanvasRenderingContext2D, rows: FishListDisplayRow[]) {
  const table = FISH_LIST_TABLE;
  const [nameW, sizeW, countW, priceW, notesW] = table.columns;
  const x1 = table.x + nameW;
  const x2 = x1 + sizeW;
  const x3 = x2 + countW;
  const x4 = x3 + priceW;
  const bodyY = table.y + table.headerHeight;

  ctx.save();
  ctx.fillStyle = "#08031d";
  ctx.fillRect(table.x, table.y, table.width, table.height);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.strokeRect(table.x, table.y, table.width, table.height);

  ctx.fillStyle = "#b8cae8";
  ctx.fillRect(table.x + 2, table.y + 2, table.width - 4, table.headerHeight - 2);
  ctx.strokeStyle = "rgba(43, 59, 86, 0.38)";
  ctx.lineWidth = 0.7;
  [x1, x2, x3, x4].forEach((x) => {
    ctx.beginPath();
    ctx.moveTo(x, table.y + 2);
    ctx.lineTo(x, bodyY);
    ctx.stroke();
  });

  ctx.fillStyle = "#000000";
  ctx.font = '800 18px "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("尺寸（cm）", x1 + sizeW / 2, table.y + table.headerHeight / 2);
  ctx.fillText("库存", x2 + countW / 2, table.y + table.headerHeight / 2);
  ctx.fillText("价格", x3 + priceW / 2, table.y + table.headerHeight / 2);
  ctx.fillText("备注", x4 + notesW / 2, table.y + table.headerHeight / 2);

  let y = bodyY + 16;
  for (const row of rows) {
    if (row.type === "category") {
      drawCenteredText(ctx, row.categoryName, table.x, y, table.width, 15);
      y += table.rowHeight;
      continue;
    }
    const centerY = y;
    drawFishListNameCell(ctx, row, table.x + 25, centerY, nameW - 34);
    drawWrappedCellText(ctx, row.size, x1, centerY, sizeW, { fontSize: 15, maxLines: 1 });
    drawWrappedCellText(ctx, String(row.stockCount), x2, centerY, countW, { fontSize: 15, maxLines: 1 });
    drawWrappedCellText(ctx, row.priceText, x3, centerY, priceW, { fontSize: 15, maxLines: 1 });
    drawWrappedCellText(ctx, row.notes || "—", x4 + 10, centerY, notesW - 20, { fontSize: 14, maxLines: 2 });
    y += table.rowHeight;
  }
  ctx.restore();
}

function drawFishListRules(ctx: CanvasRenderingContext2D, footerText: string) {
  ctx.save();
  ctx.fillStyle = "#08031d";
  ctx.fillRect(58, 170, 479, 570);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  let y = 208;
  const center = FISH_LIST_PDF_WIDTH / 2;
  const centered = (text: string, size = 17, gap = 24) => {
    ctx.font = `800 ${size}px "PingFang SC", "Microsoft YaHei", Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(text, center, y);
    y += gap;
  };

  const paragraphs = footerText.split(/\r?\n/);
  for (const rawParagraph of paragraphs) {
    if (y > 720) break;
    const paragraph = rawParagraph.trim();
    if (!paragraph) {
      y += 10;
      continue;
    }
    const isHeading = /^【[^】]+】$/.test(paragraph);
    const isShortCentered = !isHeading && y < 300 && paragraph.length <= 24 && !/[，。；：]/.test(paragraph);
    if (isHeading || isShortCentered) {
      centered(paragraph, isHeading ? 17 : 16, isHeading ? 24 : 20);
      continue;
    }
    ctx.textAlign = "left";
    ctx.font = '800 13px "PingFang SC", "Microsoft YaHei", Arial, sans-serif';
    const lines = wrapTextByWidth(ctx, paragraph, 430);
    for (const line of lines) {
      if (y > 720) {
        ctx.fillText("……", 82, y);
        break;
      }
      ctx.fillText(line, 82, y);
      y += 19;
    }
    y += 8;
  }
  ctx.restore();
}

function canvasToJpegBytes(canvas: HTMLCanvasElement): Uint8Array {
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function writeUint16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, true);
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function buildZip(files: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  const { time, date } = dosDateTime();
  let offset = 0;

  for (const file of files) {
    const pathBytes = utf8Bytes(file.path);
    const checksum = crc32(file.data);

    const localHeader = new Uint8Array(30 + pathBytes.length);
    const localView = new DataView(localHeader.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, time);
    writeUint16(localView, 12, date);
    writeUint32(localView, 14, checksum);
    writeUint32(localView, 18, file.data.length);
    writeUint32(localView, 22, file.data.length);
    writeUint16(localView, 26, pathBytes.length);
    writeUint16(localView, 28, 0);
    localHeader.set(pathBytes, 30);
    localChunks.push(localHeader, file.data);

    const centralHeader = new Uint8Array(46 + pathBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, time);
    writeUint16(centralView, 14, date);
    writeUint32(centralView, 16, checksum);
    writeUint32(centralView, 20, file.data.length);
    writeUint32(centralView, 24, file.data.length);
    writeUint16(centralView, 28, pathBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    centralHeader.set(pathBytes, 46);
    centralChunks.push(centralHeader);

    offset += localHeader.length + file.data.length;
  }

  const centralDirectory = concatBytes(centralChunks);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 4, 0);
  writeUint16(endView, 6, 0);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralDirectory.length);
  writeUint32(endView, 16, offset);
  writeUint16(endView, 20, 0);

  return concatBytes([...localChunks, centralDirectory, endRecord]);
}

function fishListDocxImageXml(index: number, title: string): string {
  const relId = `rIdImage${index + 1}`;
  const docPrId = index + 1;
  const name = xmlEscape(`${title} 第${index + 1}页`);
  const cx = Math.round(FISH_LIST_PDF_WIDTH * 12700);
  const cy = Math.round(FISH_LIST_PDF_HEIGHT * 12700);
  return `<w:p><w:pPr><w:spacing w:before="0" w:after="0"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${name}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${name}.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function buildDocxFromJpegs(images: Array<{ bytes: Uint8Array; width: number; height: number }>, title: string): Blob {
  const pageWidthTwips = Math.round(FISH_LIST_PDF_WIDTH * 20);
  const pageHeightTwips = Math.round(FISH_LIST_PDF_HEIGHT * 20);
  const bodyXml = images.map((_, index) => {
    const page = fishListDocxImageXml(index, title);
    return index === images.length - 1 ? page : `${page}<w:p><w:r><w:br w:type="page"/></w:r></w:p>`;
  }).join("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${bodyXml}<w:sectPr><w:pgSz w:w="${pageWidthTwips}" w:h="${pageHeightTwips}"/><w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${images.map((_, index) => `<Relationship Id="rIdImage${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/fish-list-page-${index + 1}.jpg"/>`).join("")}</Relationships>`;
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDocument" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rIdCore" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rIdApp" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const now = new Date().toISOString();
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>fishroom-management</dc:creator><cp:lastModifiedBy>fishroom-management</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>fishroom-management</Application><Pages>${images.length}</Pages></Properties>`;

  const zip = buildZip([
    { path: "[Content_Types].xml", data: utf8Bytes(contentTypesXml) },
    { path: "_rels/.rels", data: utf8Bytes(rootRelsXml) },
    { path: "docProps/core.xml", data: utf8Bytes(coreXml) },
    { path: "docProps/app.xml", data: utf8Bytes(appXml) },
    { path: "word/document.xml", data: utf8Bytes(documentXml) },
    { path: "word/_rels/document.xml.rels", data: utf8Bytes(relsXml) },
    ...images.map((image, index) => ({ path: `word/media/fish-list-page-${index + 1}.jpg`, data: image.bytes })),
  ]);
  return new Blob([zip], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

export function Dashboard() {
  const { state } = useStore();
  return canAccessDashboard(state.user) ? <AdminDashboard /> : null;
}

function AdminDashboard() {
  const { state, activeSiteId, saveStateTransform } = useStore();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [financeRange, setFinanceRange] = useState<DashboardDateRange>(() => {
    const range = resolveDashboardDateRange({}, todayDateString());
    return { startDate: range.startDate, endDate: range.endDate };
  });
  const financeDates: string[] = useMemo(() => resolveDashboardDateRange(financeRange).dates, [financeRange.startDate, financeRange.endDate]);
  const financeRangeLabel = `${financeRange.startDate} 至 ${financeRange.endDate}`;
  const [dashboardSiteId, setDashboardSiteId] = useState<string>(activeSiteId);
  const [hoveredFinanceIndex, setHoveredFinanceIndex] = useState<number | null>(null);
  const [hoveredSalespersonIndex, setHoveredSalespersonIndex] = useState<number | null>(null);
  const [selectedSalespersonPoint, setSelectedSalespersonPoint] = useState<DailySalespersonPoint | null>(null);
  const [selectedSalespeople, setSelectedSalespeople] = useState<Set<string> | null>(null);
  const [hoveredLossIndex, setHoveredLossIndex] = useState<number | null>(null);
  const [selectedLossPoint, setSelectedLossPoint] = useState<DailyLossPoint | null>(null);
  const [exportingFishList, setExportingFishList] = useState(false);
  const [fishListSettingsOpen, setFishListSettingsOpen] = useState(false);
  const [fishListFooterDraft, setFishListFooterDraft] = useState("");
  const [savingFishListSettings, setSavingFishListSettings] = useState(false);
  const [focusMode, setFocusMode] = useState<FocusMode>("species");
  const [focusSearch, setFocusSearch] = useState("");
  const [focusId, setFocusId] = useState("");
  const [focusDetail, setFocusDetail] = useState<FocusDetail | null>(null);
  const [focusLoading, setFocusLoading] = useState(false);
  const [focusError, setFocusError] = useState("");
  const [focusRetry, setFocusRetry] = useState(0);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryError, setSummaryError] = useState("");
  const [summaryRetry, setSummaryRetry] = useState(0);
  const sites = getSites(state);
  const configuredFishListFooterText = typeof state.systemSettings?.fishListFooterText === "string"
    ? state.systemSettings.fishListFooterText
    : DEFAULT_FISH_LIST_FOOTER_TEXT;
  const fishListFooterText = configuredFishListFooterText.replace(
    /包装费统一\s*\d+(?:\.\d+)?\s*元/,
    `包装费统一 ${configuredOrderPackagingFee(state.systemSettings)} 元`
  );
  useEffect(() => {
    setDashboardSiteId((current) => current === ALL_SITE_ID ? current : activeSiteId);
  }, [activeSiteId]);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSummaryLoading(true);
    setSummaryError("");
    setSummary(null);
    setFocusDetail(null);
    setHoveredFinanceIndex(null);
    setHoveredSalespersonIndex(null);
    setSelectedSalespersonPoint(null);
    setSelectedSalespeople(null);
    setHoveredLossIndex(null);
    setSelectedLossPoint(null);
    const params = new URLSearchParams({ ...financeRange, siteId: dashboardSiteId });
    fetch(`/api/dashboard-summary?${params}`, { headers: authJsonHeaders(), signal: controller.signal })
      .then((response) => response.json().then((result) => ({ response, result })))
      .then(({ response, result }) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        const nextSummary = result.summary ?? null;
        setSummary(nextSummary);
        if (!focusId && nextSummary?.defaultFocus) {
          setFocusMode(nextSummary.defaultFocus.mode === "product" ? "product" : "species");
          setFocusId(String(nextSummary.defaultFocus.id ?? ""));
          setFocusDetail(nextSummary.defaultFocus);
          setFocusError("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load dashboard summary:", error);
          setSummary(null);
          setSummaryError("概览数据加载失败，请重试");
        }
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [financeRange.startDate, financeRange.endDate, dashboardSiteId, summaryRetry]);
  useEffect(() => {
    if (fishListSettingsOpen) setFishListFooterDraft(fishListFooterText);
  }, [fishListSettingsOpen, fishListFooterText]);
  useEffect(() => {
    if (!focusId) {
      setFocusDetail(null);
      setFocusError("");
      return;
    }
    if (focusDetail?.mode === focusMode && focusDetail.id === focusId) return;
    const controller = new AbortController();
    setFocusLoading(true);
    setFocusError("");
    fetch(
      `/api/dashboard-focus?mode=${encodeURIComponent(focusMode)}&id=${encodeURIComponent(focusId)}&siteId=${encodeURIComponent(dashboardSiteId)}`,
      { headers: authJsonHeaders(), signal: controller.signal }
    )
      .then((response) => response.json().then((result) => ({ response, result })))
      .then(({ response, result }) => {
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        setFocusDetail(result.focus ?? null);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") {
          console.error("Failed to load dashboard focus detail:", error);
          setFocusDetail(null);
          setFocusError("关注数据加载失败，请重新选择后重试");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFocusLoading(false);
      });
    return () => controller.abort();
  }, [dashboardSiteId, focusDetail, focusId, focusMode, focusRetry]);
  const focusData: FocusData | null = null;
  // Dashboard data is served as compact aggregates. Do not reuse large arrays
  // left in the shared store after navigating from another page: doing so
  // would re-run the old D x N fallback calculations before the summary wins.
  // The empty fallback only keeps the first render deterministic while the
  // compact request is in flight. Fish-list export loads its data on demand.
  const dashboardSpecies: Species[] = [];
  const dashboardProducts: Product[] = [];
  const dashboardBatches: PurchaseBatch[] = [];
  const dashboardTankGroups: TankGroup[] = [];
  const dashboardStock: StockItem[] = [];
  const dashboardOrders: Order[] = [];
  const dashboardShipments: Shipment[] = [];
  const dashboardLossRecords: StockLossRecord[] = [];
  const dashboardPersonnel: Personnel[] = [];
  const dashboardCustomers: Customer[] = [];
  const dashboardInventoryProjection = { outStockIds: [] as string[], outDateByStockId: {} as Record<string, string> };
  const shippedOutStockIds = getInventoryOutStockIds({
    shipments: dashboardShipments,
    orders: dashboardOrders,
    inventoryProjection: dashboardInventoryProjection,
  });
  const today = todayDateString();
  const todayDate = new Date(`${today}T00:00:00`);

  const productById = new Map(dashboardProducts.map((product) => [product.id, product]));
  const speciesById = new Map(dashboardSpecies.map((species) => [species.id, species]));
  const batchById = new Map(dashboardBatches.map((batch) => [batch.id, batch]));
  const customerById = new Map(dashboardCustomers.map((customer) => [customer.id, customer]));
  const subTankNameById = new Map<string, string>();
  for (const group of dashboardTankGroups) {
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
  const inTankStock = dashboardStock.filter((s) => isPhysicallyInTank(s, shippedOutStockIds));
  const inTankFishStock = inTankStock.filter((stockItem) => {
    const product = productById.get(stockItem.productId);
    const species = product ? speciesById.get(product.speciesId) : undefined;
    return isFishInventoryItem(product, species);
  });
  let inFishStock = inTankFishStock.length;
  let sick = inTankFishStock.filter((s) => s.status === "sick").length;
  let inTankSold = inTankFishStock.filter((s) => s.sold).length;
  let inTankSick = inTankFishStock.filter((s) => !s.sold && s.status === "sick").length;
  let inTankNormal = inTankFishStock.filter((s) => !s.sold && s.status !== "sick").length;
  let tankGroupCount = dashboardTankGroups.length;
  let subTankCount = dashboardTankGroups.reduce((n, g) => n + (g.subTanks?.length ?? 0), 0);
  const todayPayments = dashboardOrders.flatMap((order) =>
    (order.payments ?? []).filter((payment) =>
      isPaymentVerified(payment) && String(payment.time ?? "").slice(0, 10) === today
    )
  );
  let todayReceived = todayPayments
    .filter((payment) => payment.type !== "refund")
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const todayAdjustments = dashboardOrderAdjustmentTotals(dashboardOrders, dashboardShipments, today);
  let todayUnshippedRefund = todayAdjustments.unshippedRefund;
  let todayShippedDamage = todayAdjustments.shippedDamage;
  let todayShippedOut = dashboardShipments
    .filter((shipment) => shipment.shipDate === today && shipment.status !== "preparing")
    .reduce((sum, shipment) => sum + (shipment.itemStockIds?.length ?? 0), 0);

  let activeOrders = dashboardOrders.filter((o) => !["cancelled", "completed", "damaged"].includes(o.status)).length;
  let totalRevenue = dashboardOrders
    .filter((o) => o.status !== "cancelled" && o.status !== "damaged")
    .reduce((sum, o) => sum + o.items.reduce((s, i) => s + i.price, 0), 0);
  let pendingShipments = dashboardShipments.filter((s) => s.status === "preparing" || s.status === "outbound" || s.status === "shipped").length;

  let dailyFinanceData = financeDates.map((date) => {
    const adjustments = dashboardOrderAdjustmentTotals(dashboardOrders, dashboardShipments, date);
    const payments = dashboardOrders.flatMap((order) =>
      (order.payments ?? []).filter((payment) =>
        isPaymentVerified(payment) && String(payment.time ?? "").slice(0, 10) === date
      )
    );
    const ordersForDate = dashboardOrders.filter((order) =>
      isValidSalesOrder(order) && String(order.date ?? "").slice(0, 10) === date
    );
    const salesRows = ordersForDate.map((order) => {
      const orderShipments = orderShipmentsFor(order, dashboardShipments);
      return {
        order,
        orderShipments,
        amount: calcOrderDealAmount(order, orderShipments),
      };
    });
    return {
      date,
      label: shortDateLabel(date),
      received: payments
        .filter((payment) => payment.type !== "refund")
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      unshippedRefund: adjustments.unshippedRefund,
      shippedDamage: adjustments.shippedDamage,
      orderAmount: salesRows.reduce((sum, row) => sum + row.amount, 0),
      platformAmount: salesRows
        .filter((row) => isPlatformOrderSource(row.order.source))
        .reduce((sum, row) => sum + row.amount, 0),
      offlinePickupAmount: salesRows
        .filter((row) => isOfflinePickupOrder(row.order, row.orderShipments))
        .reduce((sum, row) => sum + row.amount, 0),
      privateDomainAmount: salesRows
        .filter((row) => String(row.order.source ?? "").trim() === "私域线上")
        .reduce((sum, row) => sum + row.amount, 0),
    };
  });
  const dailyDates = dailyFinanceData.map((point) => point.date);
  const stockById = new Map(dashboardStock.map((item) => [item.id, item]));
  const explicitLossIds = new Set(dashboardLossRecords.map((record) => record.stockItemId));
  const lossRows = [
    ...dashboardLossRecords,
    ...dashboardStock
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
      isFish: isFishInventoryItem(product, itemSpecies),
    };
  }).filter((row) => row.date && row.stockItem && row.isFish);
  const lossDateByStockId = new Map<string, string>();
  for (const row of lossRows) {
    if (!row.stockItem) continue;
    const current = lossDateByStockId.get(row.stockItem.id);
    if (!current || row.date < current) lossDateByStockId.set(row.stockItem.id, row.date);
  }
  for (const item of dashboardStock) {
    const itemLossDate = String(item.lossDate ?? "").slice(0, 10);
    if (!itemLossDate) continue;
    const current = lossDateByStockId.get(item.id);
    if (!current || itemLossDate < current) lossDateByStockId.set(item.id, itemLossDate);
  }
  const shippedDateByStockId = new Map<string, string>(
    Object.entries(dashboardInventoryProjection?.outDateByStockId ?? {})
      .map(([id, date]) => [normalizeInventoryId(id), String(date ?? "").slice(0, 10)] as const)
      .filter(([id, date]) => Boolean(id) && /^\d{4}-\d{2}-\d{2}$/.test(date))
  );
  for (const shipment of dashboardShipments) {
    if (shipment.status === "preparing") continue;
    const date = String(shipment.outboundDate ?? shipment.shipDate ?? shipment.createdAt ?? "").slice(0, 10);
    if (!date) continue;
    for (const rawStockItemId of shipment.itemStockIds ?? []) {
      const stockItemId = normalizeInventoryId(rawStockItemId);
      if (!stockItemId) continue;
      const current = shippedDateByStockId.get(stockItemId);
      if (!current || date < current) shippedDateByStockId.set(stockItemId, date);
    }
  }
  const fishStock = dashboardStock.filter((item) => {
    const product = productById.get(item.productId);
    const itemSpecies = product ? speciesById.get(product.speciesId) : undefined;
    return isFishInventoryItem(product, itemSpecies);
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
      const shippedDate = shippedDateByStockId.get(normalizeInventoryId(item.id));
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
    const batchArrivals = dashboardBatches
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
    todayUnshippedRefund = Number(summary.todayUnshippedRefund ?? summary.todayRefunded ?? 0);
    todayShippedDamage = Number(summary.todayShippedDamage ?? 0);
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
    dailyFinanceData = Array.isArray(summary.dailyFinanceData)
      ? summary.dailyFinanceData.map((point) => normalizeDailyFinancePoint(point))
      : dailyFinanceData;
    dailyLossData = Array.isArray(summary.dailyLossData) ? summary.dailyLossData : dailyLossData;
  }
  const salespersonOptions = rankDashboardSalespeople(Array.isArray(summary?.salespersonOptions)
    ? summary.salespersonOptions
    : []);
  const selectedSalespersonNames = dashboardSalespersonSelection(salespersonOptions, selectedSalespeople);
  const selectedSalespersonSet = new Set(selectedSalespersonNames);
  const dailySalespersonData: DailySalespersonPoint[] = (Array.isArray(summary?.dailySalespersonData)
    ? summary.dailySalespersonData
    : []).map((point) => {
      const breakdowns = (Array.isArray(point.breakdowns) ? point.breakdowns : [])
        .filter((row) => selectedSalespersonSet.has(row.salesperson));
      return {
        ...point,
        total: Number(breakdowns.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2)),
        orderCount: breakdowns.reduce((sum, row) => sum + Number(row.orderCount || 0), 0),
        itemCount: breakdowns.reduce((sum, row) => sum + Number(row.itemCount || 0), 0),
        breakdowns,
      };
    });
  const maxSalespersonValue = Math.max(
    1,
    ...dailySalespersonData.flatMap((point) => point.breakdowns.map((row) => row.amount))
  );
  const hoveredSalespersonPoint =
    hoveredSalespersonIndex !== null && hoveredSalespersonIndex < dailySalespersonData.length
      ? dailySalespersonData[hoveredSalespersonIndex]
      : null;
  const hoveredSalespersonX = hoveredSalespersonIndex !== null
    ? chartX(hoveredSalespersonIndex, dailySalespersonData.length)
    : 64;
  const hoveredSalespersonTransform = hoveredSalespersonIndex === 0
    ? "translateX(0)"
    : hoveredSalespersonIndex === dailySalespersonData.length - 1
      ? "translateX(-100%)"
      : "translateX(-50%)";
  const salespersonLabelStep = Math.max(1, Math.ceil(dailySalespersonData.length / 8));
  const salespersonRangeTotal = dailySalespersonData.reduce((sum, point) => sum + point.total, 0);
  const salespersonRangeOrders = dailySalespersonData.reduce((sum, point) => sum + point.orderCount, 0);
  const maxFinanceValue = Math.max(
    1,
    ...dailyFinanceData.flatMap((point) =>
      FINANCE_SERIES.map((series) => financeMetricValue(point, series.key))
    )
  );
  const financeRangeTotals = FINANCE_SERIES.map((series) => ({
    ...series,
    value: dailyFinanceData.reduce((sum, point) => sum + financeMetricValue(point, series.key), 0),
  }));
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
      species: focusData?.species ?? dashboardSpecies,
      products: focusData?.products ?? dashboardProducts,
      tankGroups: focusData?.tankGroups ?? dashboardTankGroups,
      stock: focusData?.stock ?? dashboardStock,
      orders: focusData?.orders ?? dashboardOrders,
      shipments: focusData?.shipments ?? dashboardShipments,
      lossRecords: focusData?.lossRecords ?? dashboardLossRecords,
      customers: focusData?.customers ?? dashboardCustomers,
      personnel: focusData?.personnel ?? dashboardPersonnel,
      inventoryProjection: focusData?.inventoryProjection ?? dashboardInventoryProjection,
    };
    const scope = normalizeSiteScope(dashboardSiteId);
    if (scope === ALL_SITE_ID) return source;
    const tankGroups = source.tankGroups.filter((group) => matchesSite(group, scope));
    const orders = source.orders.filter((order) => matchesSite(order, scope));
    const orderIds = new Set(orders.map((order) => order.id));
    const stock = source.stock.filter((item) => stockMatchesSite(item, scope, source.tankGroups));
    const stockIds = new Set(stock.map((item) => normalizeInventoryId(item.id)));
    return {
      ...source,
      tankGroups,
      stock,
      inventoryProjection: {
        outStockIds: (source.inventoryProjection?.outStockIds ?? [])
          .filter((id) => stockIds.has(normalizeInventoryId(id))),
        outDateByStockId: Object.fromEntries(
          Object.entries(source.inventoryProjection?.outDateByStockId ?? {})
            .filter(([id]) => stockIds.has(normalizeInventoryId(id)))
        ),
      },
      orders,
      shipments: source.shipments.filter((shipment) => matchesSite(shipment, scope) || orderIds.has(shipment.orderId)),
      lossRecords: source.lossRecords.filter((record) => matchesSite(record, scope) || stockIds.has(record.stockItemId)),
    };
  }, [
    dashboardSiteId,
    focusData,
    dashboardSpecies,
    dashboardProducts,
    dashboardTankGroups,
    dashboardStock,
    dashboardOrders,
    dashboardShipments,
    dashboardLossRecords,
    dashboardCustomers,
    dashboardPersonnel,
    dashboardInventoryProjection,
  ]);

  const fallbackHealthyFishStockMetrics = useMemo(() => {
    const fulfilledStockIds = getInventoryOutStockIds({
      shipments: focusSource.shipments,
      orders: focusSource.orders,
      inventoryProjection: focusSource.inventoryProjection,
    });
    try {
      return healthyFishInventoryMetrics({
        stock: focusSource.stock,
        products: focusSource.products,
        species: focusSource.species,
        outStockIds: fulfilledStockIds,
      });
    } catch (error) {
      console.error("Failed to calculate healthy fish inventory value:", error);
      return null;
    }
  }, [focusSource]);
  const summaryHealthyFishStockValue = Number(summary?.healthyFishStockValue);
  const summaryHealthyFishStockCount = Number(summary?.healthyFishStockCount);
  const summaryHealthyFishUnpricedCount = Number(summary?.healthyFishUnpricedCount);
  const summaryMatchesDashboardScope = normalizeSiteScope(summary?.siteId) === normalizeSiteScope(dashboardSiteId);
  const summaryHealthyFishStockValueCents = Math.round((summaryHealthyFishStockValue + Number.EPSILON) * 100);
  const hasValidSummaryHealthyFishMetrics = summaryMatchesDashboardScope &&
    Number.isFinite(summaryHealthyFishStockValue) &&
    summaryHealthyFishStockValue >= 0 &&
    Number.isSafeInteger(summaryHealthyFishStockValueCents) &&
    Number.isSafeInteger(summaryHealthyFishStockCount) &&
    summaryHealthyFishStockCount >= 0 &&
    Number.isSafeInteger(summaryHealthyFishUnpricedCount) &&
    summaryHealthyFishUnpricedCount >= 0;
  const healthyFishStockMetrics = hasValidSummaryHealthyFishMetrics
    ? {
        value: summaryHealthyFishStockValue,
        count: summaryHealthyFishStockCount,
        unpricedCount: summaryHealthyFishUnpricedCount,
      }
    : fallbackHealthyFishStockMetrics;
  const healthyFishStockDescription = !healthyFishStockMetrics
    ? "售价数据异常，暂无法安全计算"
    : healthyFishStockMetrics.unpricedCount > 0
      ? `按当前单鱼售价估算；${healthyFishStockMetrics.unpricedCount} 条未定价未计入`
      : "按当前单鱼售价估算，不含已售和疾病鱼";

  const focusAnalysis = useMemo(() => {
    const compactOptions = Array.isArray(summary?.focusOptions?.[focusMode])
      ? summary.focusOptions[focusMode]
      : null;
    if (compactOptions) {
      const selectedOption = compactOptions.find((option) => option.id === focusId) ?? null;
      const detailMatches = focusDetail?.mode === focusMode && focusDetail.id === focusId;
      return {
        options: compactOptions,
        selectedOption,
        metrics: detailMatches ? focusDetail.metrics : null,
        productRows: detailMatches ? focusDetail.productRows : [] as FocusProductRow[],
      };
    }
    const products = focusSource.products;
    const species = focusSource.species;
    const stock = focusSource.stock;
    const orders = focusSource.orders;
    const shipments = focusSource.shipments;
    const focusProductById = new Map(products.map((product) => [product.id, product]));
    const focusSpeciesById = new Map(species.map((item) => [item.id, item]));
    const shippedIds = getInventoryOutStockIds({
      shipments,
      orders,
      inventoryProjection: focusSource.inventoryProjection,
    });
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
  }, [focusDetail, focusId, focusMode, focusSource, summary, today, todayDate]);

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
      species: dashboardSpecies,
      products: dashboardProducts,
      tankGroups: dashboardTankGroups,
      stock: dashboardStock,
      shipments: dashboardShipments,
      inventoryProjection: dashboardInventoryProjection,
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
        inventoryProjection: data.inventoryProjection ?? exportData.inventoryProjection,
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
    const exportShippedOutStockIds = getInventoryOutStockIds({
      shipments: exportData.shipments,
      inventoryProjection: exportData.inventoryProjection,
    });
    const exportTankName = (subTankId?: string) => {
      if (!subTankId) return "—";
      for (const group of exportData.tankGroups) {
        const tank = group.subTanks.find((entry) => entry.id === subTankId);
        if (tank) return `${group.name} / ${tank.name}`;
      }
      return "—";
    };

    const sellableStock = exportData.stock
      .filter((stock) => {
        if (stock.sold || stock.lost || stock.status === "sick") return false;
        if (!isPhysicallyInTank(stock, exportShippedOutStockIds)) return false;
        const product = exportProductById.get(stock.productId);
        const species = product ? exportSpeciesById.get(product.speciesId) : undefined;
        return isFishInventoryItem(product, species);
      });
    const fishListPriceBaselines = buildStockPriceBaselines(sellableStock, exportData.products);

    const sellableRows = sellableStock
      .map((stock) => {
        const product = exportProductById.get(stock.productId);
        const species = product ? exportSpeciesById.get(product.speciesId) : undefined;
        return {
          stock,
          product,
          species,
          speciesId: species?.id ?? product?.speciesId ?? "unknown",
          speciesName: species?.name ?? "未归类",
          categoryName: fishListCategoryName(species?.category, species?.name),
          price: stockSalePrice(stock, product),
          defaultPrice: Number(product?.defaultPrice || 0),
          specialPrice: isStockSpecialPrice(stock, product, fishListPriceBaselines),
        };
      })
      .sort((a, b) =>
        fishListCategoryRank(a.categoryName) - fishListCategoryRank(b.categoryName) ||
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

    const regularGroups = new Map<string, {
      categoryName: string;
      productName: string;
      size: string;
      origin: string;
      price: number;
      productNotes: string[];
      stocks: StockItem[];
    }>();

    for (const row of sellableRows.filter((row) => !row.specialPrice)) {
      const productName = normalizeFishListGroupText(row.product?.name, row.stock.productId);
      const size = normalizeFishListGroupText(row.product?.size);
      const origin = normalizeFishListGroupText(row.product?.origin, "");
      const price = normalizeFishListGroupPrice(row.price || row.defaultPrice || 0);
      const productNotes = normalizeFishListGroupText(row.product?.notes, "");
      const key = [row.categoryName, productName, size, price.toFixed(2)].join("__");
      const existing = regularGroups.get(key);
      if (existing) {
        existing.stocks.push(row.stock);
        if (productNotes) existing.productNotes.push(productNotes);
      } else {
        regularGroups.set(key, {
          categoryName: row.categoryName,
          productName,
          size,
          origin,
          price,
          productNotes: productNotes ? [productNotes] : [],
          stocks: [row.stock],
        });
      }
    }

    const regularItemRows: FishListItemRow[] = [...regularGroups.values()]
      .map((group) => ({
        type: "item" as const,
        categoryName: group.categoryName,
        productName: group.productName,
        size: group.size,
        origin: group.origin,
        stockCount: group.stocks.length,
        priceText: formatFishListPrice(group.price),
        priceValue: group.price,
        notes: uniqueText([
          fishListStatusNote(group.stocks),
          ...group.productNotes,
          ...group.stocks.map((stock) => stock.notes),
        ]),
      }))
      .sort((a, b) =>
        fishListCategoryRank(a.categoryName) - fishListCategoryRank(b.categoryName) ||
        a.productName.localeCompare(b.productName, "zh-Hans-CN") ||
        a.size.localeCompare(b.size, "zh-Hans-CN") ||
        a.priceValue - b.priceValue
      );

    const specialItemRows: FishListItemRow[] = sellableRows
      .filter((row) => row.specialPrice)
      .map((row) => ({
        type: "item" as const,
        categoryName: "一物一价",
        productName: row.product?.name ?? row.stock.productId,
        size: row.product?.size || "—",
        origin: "",
        stockCount: 1,
        priceText: formatFishListPrice(row.price),
        priceValue: row.price,
        notes: uniqueText([
          row.stock.notes,
          row.stock.code ? `编号：${row.stock.code}` : "",
        ]),
        special: true,
      }))
      .sort((a, b) =>
        a.productName.localeCompare(b.productName, "zh-Hans-CN") ||
        a.size.localeCompare(b.size, "zh-Hans-CN") ||
        a.notes.localeCompare(b.notes, "zh-Hans-CN")
      );

    const groupedByCategory = new Map<string, FishListItemRow[]>();
    for (const row of regularItemRows) {
      groupedByCategory.set(row.categoryName, [...(groupedByCategory.get(row.categoryName) ?? []), row]);
    }
    if (specialItemRows.length > 0) groupedByCategory.set("一物一价", specialItemRows);

    const displayRows: FishListDisplayRow[] = [...groupedByCategory.entries()]
      .sort(([a], [b]) => fishListCategoryRank(a) - fishListCategoryRank(b) || a.localeCompare(b, "zh-Hans-CN"))
      .flatMap(([categoryName, rows]) => [{ type: "category" as const, categoryName }, ...rows]);

    const rowsPerPage = 15;
    const pageRows: FishListDisplayRow[][] = [];
    for (let i = 0; i < displayRows.length; i += rowsPerPage) {
      pageRows.push(displayRows.slice(i, i + rowsPerPage));
    }

    const fishListDateLabel = formatFishListDate(today);
    try {
      const template = await loadFishListImage(FISH_LIST_TEMPLATE_URL);
      const wordImages = pageRows.map((rows, index) => {
        const ctx = createFishListPageCanvas(template, fishListDateLabel, index + 1);
        drawFishListTable(ctx, rows);
        const canvas = ctx.canvas;
        return { bytes: canvasToJpegBytes(canvas), width: canvas.width, height: canvas.height };
      });
      const rulesCtx = createFishListPageCanvas(template, fishListDateLabel, pageRows.length + 1);
      drawFishListRules(rulesCtx, fishListFooterText);
      wordImages.push({
        bytes: canvasToJpegBytes(rulesCtx.canvas),
        width: rulesCtx.canvas.width,
        height: rulesCtx.canvas.height,
      });
      const exportNamePrefix = dashboardSiteId === ALL_SITE_ID ? "海洋森林" : `${siteName(state, dashboardSiteId)}海洋森林`;
      const exportDateName = `${Number(today.slice(5, 7))}月${Number(today.slice(8, 10))}日`;
      const exportTitle = `${exportNamePrefix}鱼单${exportDateName}`;
      const blob = buildDocxFromJpegs(wordImages, exportTitle);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${safeFilename(exportTitle)}.docx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success(`已导出可售鱼单：${sellableRows.length} 条`);
    } catch (error) {
      console.error("Failed to export fish list:", error);
      toast.error("导出鱼单失败，请刷新后重试");
    } finally {
      setExportingFishList(false);
    }
  };

  const saveFishListFooterText = async () => {
    if (!window.confirm("确认保存鱼单表格后的文字设置？")) return;
    setSavingFishListSettings(true);
    const nextText = fishListFooterDraft;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      systemSettings: {
        ...(latest.systemSettings ?? { fishListFooterText: DEFAULT_FISH_LIST_FOOTER_TEXT }),
        fishListFooterText: nextText,
      },
    }));
    setSavingFishListSettings(false);
    if (ok) {
      toast.success("鱼单文字设置已保存");
      setFishListSettingsOpen(false);
    } else {
      toast.error("保存失败，请刷新后重试");
    }
  };

  const cards = [
    { label: "今日收款金额", value: formatMoney(todayReceived), icon: Banknote },
    { label: "今日退单金额", value: formatMoney(todayUnshippedRefund), icon: RotateCcw },
    { label: "今日报损金额", value: formatMoney(todayShippedDamage), icon: CircleAlert },
    { label: "今日发货出库", value: `${todayShippedOut} 条`, icon: Truck },
    {
      label: "库存健康鱼总价值",
      value: healthyFishStockMetrics ? formatMoney(healthyFishStockMetrics.value) : "暂不可用",
      description: healthyFishStockDescription,
      icon: BadgeDollarSign,
      className: "sm:col-span-2",
    },
    { label: "在缸鱼类", value: inFishStock, icon: Fish },
    { label: "缸组/子缸", value: `${tankGroupCount} / ${subTankCount}`, icon: PackageSearch },
    { label: "疾病观察中", value: sick, icon: AlertTriangle },
    { label: "进行中订单", value: activeOrders, icon: ShoppingBag },
    { label: "待发/运输中", value: pendingShipments, icon: Truck },
    { label: "销售总额(¥)", value: totalRevenue.toFixed(0), icon: TrendingUp },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="fishroom-card rounded-2xl p-5 sm:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="inline-flex rounded-full border bg-secondary px-3 py-1 text-xs font-medium text-secondary-foreground">
            当前看板：{dashboardSiteId === ALL_SITE_ID ? "全部场地" : siteName(state, dashboardSiteId)}
          </div>
          <h2 className="fishroom-page-title mt-3">欢迎回来，{state.user?.username}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            海水鱼房经营概览 · 当前看板：{dashboardSiteId === ALL_SITE_ID ? "全部场地" : siteName(state, dashboardSiteId)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="fishroom-control flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-muted-foreground">
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
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="设置鱼单表格后的文字"
            onClick={() => setFishListSettingsOpen(true)}
          >
            <Settings2 className="size-4" />
          </Button>
        </div>
      </div>
      </div>
      {summaryError ? (
        <div className="flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between" role="alert">
          <span>{summaryError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setSummaryRetry((value) => value + 1)}>
            重新加载
          </Button>
        </div>
      ) : summaryLoading ? (
        <div className="rounded-xl border bg-muted/40 px-4 py-3 text-sm text-muted-foreground" role="status">
          正在加载经营概览…
        </div>
      ) : null}
      <Dialog open={fishListSettingsOpen} onOpenChange={setFishListSettingsOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>设置鱼单表格后的文字</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              这段文字会显示在导出鱼单的表格页之后，适合填写包装费、运费、报损规则等说明。
            </p>
            <Textarea
              rows={16}
              value={fishListFooterDraft}
              onChange={(event) => setFishListFooterDraft(event.target.value)}
              placeholder="请输入鱼单表格后的说明文字"
              className="min-h-[360px] font-mono text-sm"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setFishListSettingsOpen(false)} disabled={savingFishListSettings}>
              取消
            </Button>
            <Button type="button" onClick={saveFishListFooterText} disabled={savingFishListSettings}>
              {savingFishListSettings ? "保存中..." : "保存设置"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="order-2 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-6">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <Card key={c.label} className={`fishroom-card fishroom-metric-card flex items-center gap-4 p-5 ${c.className ?? ""}`}>
              <div className="fishroom-metric-icon flex size-12 shrink-0 items-center justify-center rounded-xl">
                <Icon aria-hidden="true" className="size-6" />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium text-muted-foreground">{c.label}</div>
                <div className="mt-1 text-2xl font-semibold tracking-normal tabular-nums">{c.value}</div>
                {c.description ? (
                  <div className="mt-1 text-xs leading-5 text-muted-foreground">{c.description}</div>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
      <Card className="fishroom-card order-3 p-5">
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
                      ? "bg-card text-primary"
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
              className="fishroom-control h-9 w-full rounded-lg border px-3 text-sm outline-none transition-colors focus:border-primary sm:w-56"
            />
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.65fr)]">
          <div className="fishroom-table-shell overflow-hidden rounded-xl">
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
                      ? "bg-secondary text-secondary-foreground"
                      : "hover:bg-muted/40"
                  }`}
                >
                  <span className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                    focusId === option.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
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
              <div className={`fishroom-card rounded-xl px-4 py-8 text-center text-sm ${focusError ? "text-red-700" : "text-muted-foreground"}`} role={focusError ? "alert" : "status"}>
                <div>{focusLoading ? "正在加载关注看板数据..." : focusError || "请选择要关注的商品或物种"}</div>
                {focusError && !focusLoading ? (
                  <button
                    type="button"
                    className="mt-3 rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                    onClick={() => setFocusRetry((value) => value + 1)}
                  >
                    重新加载
                  </button>
                ) : null}
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
              <div className="fishroom-table-shell overflow-hidden rounded-xl">
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

              <div className="fishroom-card rounded-xl p-4">
                <div className="text-sm font-medium">口径说明</div>
                <div className="mt-3 flex flex-col gap-2 text-xs text-muted-foreground">
                  <p>销售：统计未取消订单中的对应商品金额和数量。</p>
                  <p>平均去化：按每条已售鱼的入库日期到订单下单日期计算。</p>
                  <p>预计去化：当前可售数量除以近 30 天日均销量；没有近 30 天销售时显示为空。</p>
                  <p>在缸：未损耗、未出库的实物；其中已售在缸表示客户已下单但还没出库。</p>
                  <p>损耗率：损耗数量 / 该关注对象历史入库数量。</p>
                  {focusMetrics.currentAverageAgeDays > 0 && (
                    <p className="rounded-lg border bg-card px-2 py-1 text-foreground">
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
        <Card className="fishroom-card p-5">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-base font-semibold">销售情况</h3>
              <p className="text-xs text-muted-foreground">{financeRangeLabel} · 共 {financeDates.length} 天</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs">
              {FINANCE_SERIES.map((series) => (
                <span key={series.key} className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="size-2.5 rounded-full" style={{ backgroundColor: series.color }} />
                  {series.label}
                </span>
              ))}
            </div>
          </div>
          <DashboardDateFilter value={financeRange} today={today} onChange={setFinanceRange} />
          <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {financeRangeTotals.map((item) => (
              <div key={item.key} className="rounded-lg border bg-slate-50/60 px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="size-2 rounded-full" style={{ backgroundColor: item.color }} />
                  {item.label}
                </div>
                <div className="mt-1 font-mono text-sm font-semibold text-slate-900">{formatMoney(item.value)}</div>
              </div>
            ))}
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
                {FINANCE_SERIES.map((series) => (
                  <div key={series.key} className="mt-1 flex items-center justify-between gap-5" style={{ color: series.color }}>
                    <span className="flex items-center gap-1.5">
                      <span className="size-2 rounded-full" style={{ backgroundColor: series.color }} />
                      {series.label}
                    </span>
                    <span className="font-mono font-semibold">{formatMoney(financeMetricValue(hoveredFinancePoint, series.key))}</span>
                  </div>
                ))}
              </div>
            )}
            <svg viewBox="0 0 960 250" className="size-full" role="img" aria-label={`${financeRangeLabel}销售情况趋势图`}>
              {financeTicks.map((tick) => (
                <g key={tick.ratio}>
                  <line x1="64" x2="940" y1={tick.y} y2={tick.y} stroke="#e5e7eb" strokeDasharray="4 4" />
                  <text x="10" y={tick.y + 4} fontSize="12" fill="#64748b">¥{formatCompactMoney(tick.value)}</text>
                </g>
              ))}
              {FINANCE_SERIES.map((series) => (
                <polyline
                  key={series.key}
                  points={linePoints(dailyFinanceData, series.key, maxFinanceValue)}
                  fill="none"
                  stroke={series.color}
                  strokeWidth={series.key === "orderAmount" ? "3.5" : "2.5"}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={series.key === "orderAmount" ? "1" : "0.86"}
                />
              ))}
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
                  {FINANCE_SERIES.map((series) => (
                    <circle
                      key={series.key}
                      cx={hoveredFinanceX}
                      cy={18 + (1 - financeMetricValue(hoveredFinancePoint, series.key) / maxFinanceValue) * 198}
                      r="5.5"
                      fill={series.color}
                      stroke="#fff"
                      strokeWidth="2"
                    />
                  ))}
                </g>
              )}
              {dailyFinanceData.map((point, index) => {
                const divisor = Math.max(dailyFinanceData.length - 1, 1);
                const x = 64 + (index / divisor) * 876;
                return (
                  <g key={point.date}>
                    {FINANCE_SERIES.map((series) => (
                      <circle
                        key={series.key}
                        cx={x}
                        cy={18 + (1 - financeMetricValue(point, series.key) / maxFinanceValue) * 198}
                        r="2.8"
                        fill={series.color}
                        opacity="0.8"
                      >
                        <title>{`${point.date} ${series.label} ${formatMoney(financeMetricValue(point, series.key))}`}</title>
                      </circle>
                    ))}
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
                    <title>{[
                      point.date,
                      ...FINANCE_SERIES.map((series) => `${series.label} ${formatMoney(financeMetricValue(point, series.key))}`),
                    ].join("\n")}</title>
                  </rect>
                );
              })}
            </svg>
          </div>
        </Card>

        <Card className="fishroom-card p-5">
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
        <Card className="fishroom-card p-5 xl:col-span-2">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-base font-semibold">每日销售人员成交额</h3>
              <p className="text-xs text-muted-foreground">
                {financeRangeLabel} · 按下单日期和对接人统计，与上方销售日期同步
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                已选成交额 {formatMoney(salespersonRangeTotal)}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                已选订单 {salespersonRangeOrders} 单
              </span>
            </div>
          </div>
          <DashboardSalespersonFilter key={`${dashboardSiteId}:${financeRange.startDate}:${financeRange.endDate}`}
            options={salespersonOptions} selectedNames={selectedSalespersonNames} automatic={selectedSalespeople === null}
            colors={SALESPERSON_COLORS} onChange={(selection) => {
              setSelectedSalespeople(selection);
              setHoveredSalespersonIndex(null);
              setSelectedSalespersonPoint(null);
            }} />
          {selectedSalespersonNames.length === 0 && <p className="mb-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            {selectedSalespeople === null ? "所选时间范围暂无人员成交记录。" : "尚未选择人员，请通过“选择人员”添加，或恢复前 5 名。"}
          </p>}
          <div
            className="relative h-80"
            onMouseLeave={() => setHoveredSalespersonIndex(null)}
          >
            {hoveredSalespersonPoint && (
              <div
                className="pointer-events-none absolute top-2 z-10 min-w-64 rounded-lg border bg-white/95 px-3 py-2 text-xs shadow-lg"
                style={{
                  left: `${(hoveredSalespersonX / 960) * 100}%`,
                  transform: hoveredSalespersonTransform,
                }}
              >
                <div className="mb-1 flex items-center justify-between gap-4 font-semibold text-slate-900">
                  <span>{hoveredSalespersonPoint.date}</span>
                  <span>{formatMoney(hoveredSalespersonPoint.total)}</span>
                </div>
                <div className="mb-1 text-muted-foreground">
                  {hoveredSalespersonPoint.orderCount} 单 · {hoveredSalespersonPoint.itemCount} 条商品
                </div>
                <div className="space-y-1">
                  {hoveredSalespersonPoint.breakdowns.slice(0, 6).map((row) => {
                    const colorIndex = Math.max(0, salespersonOptions.findIndex((option) => option.name === row.salesperson));
                    return (
                      <div key={row.salesperson} className="flex items-center justify-between gap-5">
                        <span className="flex items-center gap-1.5 text-slate-700">
                          <span className="size-2 rounded-full" style={{ backgroundColor: SALESPERSON_COLORS[colorIndex % SALESPERSON_COLORS.length] }} />
                          {row.salesperson}
                        </span>
                        <span className="font-mono font-semibold">{formatMoney(row.amount)}</span>
                      </div>
                    );
                  })}
                  {hoveredSalespersonPoint.breakdowns.length > 6 && (
                    <div className="text-muted-foreground">还有 {hoveredSalespersonPoint.breakdowns.length - 6} 人，点击日期查看全部</div>
                  )}
                  {hoveredSalespersonPoint.breakdowns.length === 0 && (
                    <div className="text-muted-foreground">当天没有成交订单</div>
                  )}
                </div>
              </div>
            )}
            <svg viewBox="0 0 960 250" className="size-full" role="img" aria-label={`${financeRangeLabel}销售人员成交额折线图`}>
              {[1, 0.75, 0.5, 0.25, 0].map((ratio) => {
                const y = 18 + (1 - ratio) * 198;
                return (
                  <g key={ratio}>
                    <line x1="64" x2="940" y1={y} y2={y} stroke="#e5e7eb" strokeDasharray="4 4" />
                    <text x="10" y={y + 4} fontSize="12" fill="#64748b">¥{formatCompactMoney(maxSalespersonValue * ratio)}</text>
                  </g>
                );
              })}
              {selectedSalespersonNames.map((name, index) => {
                const colorIndex = Math.max(0, salespersonOptions.findIndex((option) => option.name === name));
                const color = SALESPERSON_COLORS[colorIndex % SALESPERSON_COLORS.length];
                return (
                  <polyline
                    key={name}
                    points={metricLinePoints(
                      dailySalespersonData,
                      (point) => point.breakdowns.find((row) => row.salesperson === name)?.amount ?? 0,
                      maxSalespersonValue
                    )}
                    fill="none"
                    stroke={color}
                    strokeWidth={selectedSalespersonNames.length > 6 ? "2.2" : "3.2"}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={selectedSalespersonNames.length > 10 ? 0.78 : 0.95}
                  >
                    <title>{name}</title>
                  </polyline>
                );
              })}
              {hoveredSalespersonPoint && (
                <g pointerEvents="none">
                  <line x1={hoveredSalespersonX} x2={hoveredSalespersonX} y1="18" y2="216" stroke="#94a3b8" strokeDasharray="4 4" />
                  {hoveredSalespersonPoint.breakdowns.map((row) => {
                    const colorIndex = Math.max(0, salespersonOptions.findIndex((option) => option.name === row.salesperson));
                    return (
                      <circle
                        key={row.salesperson}
                        cx={hoveredSalespersonX}
                        cy={chartY(row.amount, maxSalespersonValue)}
                        r="5"
                        fill={SALESPERSON_COLORS[colorIndex % SALESPERSON_COLORS.length]}
                        stroke="#fff"
                        strokeWidth="2"
                      />
                    );
                  })}
                </g>
              )}
              {dailySalespersonData.map((point, index) => {
                const x = chartX(index, dailySalespersonData.length);
                return (
                  <g key={point.date}>
                    {(index % salespersonLabelStep === 0 || index === dailySalespersonData.length - 1) && (
                      <text x={x} y="246" textAnchor="middle" fontSize="12" fill="#64748b">{point.label}</text>
                    )}
                  </g>
                );
              })}
              {dailySalespersonData.map((point, index) => {
                const divisor = Math.max(dailySalespersonData.length - 1, 1);
                const bandWidth = 876 / divisor;
                const x = chartX(index, dailySalespersonData.length);
                const x1 = Math.max(64, x - bandWidth / 2);
                const x2 = Math.min(940, x + bandWidth / 2);
                return (
                  <rect
                    key={`salesperson-hover-${point.date}`}
                    x={x1}
                    y="18"
                    width={Math.max(1, x2 - x1)}
                    height="228"
                    fill="transparent"
                    onMouseEnter={() => setHoveredSalespersonIndex(index)}
                    onMouseMove={() => setHoveredSalespersonIndex(index)}
                    onClick={() => setSelectedSalespersonPoint(point)}
                    cursor="pointer"
                  >
                    <title>{`${point.date}\n成交 ${formatMoney(point.total)}\n订单 ${point.orderCount} 单`}</title>
                  </rect>
                );
              })}
            </svg>
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            统计有效订单的调整后应付金额；取消订单不计入，报损退款调整会从成交额中扣除。
          </div>
        </Card>
        <Card className="fishroom-card p-5 xl:col-span-2">
          <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h3 className="text-base font-semibold">每日损耗趋势</h3>
              <p className="text-xs text-muted-foreground">
                {financeRangeLabel} · 死鱼数量、库存占比和预计销售价值
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
            <svg viewBox="0 0 960 250" className="size-full" role="img" aria-label={`${financeRangeLabel}损耗指标折线图`}>
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
      <Card className="fishroom-card order-4 p-6">
        <h3 className="mb-3">使用提示</h3>
        <ul className="text-sm text-muted-foreground flex flex-col gap-2 list-disc pl-5">
          <li>在「品名管理」中先维护物种和商品（带图片），再开始入库。</li>
          <li>「缸组管理」用大框表示缸组，小框表示子缸；可拖入新增子缸。</li>
          <li>「库存明细」按子缸可视化排布，每条鱼右上角显示状态标识。</li>
          <li>「日常管理」点击鱼图标打开<strong>生物详情</strong>：可查看时间轴、上传照片、添加观察记录，调整健康/疾病/开口状态。</li>
          <li>「订单管理」创建销售订单后，商品自动标记为已售，时间轴中记录销售时间。</li>
          <li>在「订单管理」的订单详情中记录发货、签收、报损和补发。</li>
        </ul>
      </Card>
      <Dialog
        open={Boolean(selectedSalespersonPoint)}
        onOpenChange={(open) => {
          if (!open) setSelectedSalespersonPoint(null);
        }}
      >
        <DialogContent aria-describedby={undefined} className="max-h-[85vh] max-w-4xl overflow-y-auto">
          {selectedSalespersonPoint && (
            <>
              <DialogHeader>
                <DialogTitle>{selectedSalespersonPoint.date} 销售人员成交明细</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border bg-sky-50 px-3 py-2">
                  <div className="text-xs text-sky-700">成交总额</div>
                  <div className="text-xl font-semibold text-sky-700">{formatMoney(selectedSalespersonPoint.total)}</div>
                </div>
                <div className="rounded-lg border bg-emerald-50 px-3 py-2">
                  <div className="text-xs text-emerald-700">订单数</div>
                  <div className="text-xl font-semibold text-emerald-700">{selectedSalespersonPoint.orderCount} 单</div>
                </div>
                <div className="rounded-lg border bg-indigo-50 px-3 py-2">
                  <div className="text-xs text-indigo-700">商品数</div>
                  <div className="text-xl font-semibold text-indigo-700">{selectedSalespersonPoint.itemCount} 条</div>
                </div>
              </div>
              {selectedSalespersonPoint.breakdowns.length > 0 ? (
                <div className="space-y-3">
                  {selectedSalespersonPoint.breakdowns.map((row) => {
                    const colorIndex = Math.max(0, salespersonOptions.findIndex((option) => option.name === row.salesperson));
                    return (
                      <section key={row.salesperson} className="overflow-hidden rounded-lg border">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="size-2.5 rounded-full" style={{ backgroundColor: SALESPERSON_COLORS[colorIndex % SALESPERSON_COLORS.length] }} />
                            <span className="font-semibold">{row.salesperson}</span>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {row.orderCount} 单 · {row.itemCount} 条商品 · <span className="font-semibold text-sky-700">{formatMoney(row.amount)}</span>
                          </div>
                        </div>
                        <div className="divide-y">
                          {row.orders.map((order) => (
                            <div key={order.orderId} className="grid gap-2 px-3 py-2 text-sm md:grid-cols-[1fr_1fr_0.8fr_0.8fr] md:items-center">
                              <div>
                                <div className="font-semibold">{order.orderNo}</div>
                                <div className="text-xs text-muted-foreground">{order.status}</div>
                              </div>
                              <div>
                                <div>{order.customerName || "未命名客户"}</div>
                                {order.notes ? <div className="line-clamp-1 text-xs text-muted-foreground">备注：{order.notes}</div> : null}
                              </div>
                              <div className="text-muted-foreground">{order.itemCount} 条商品</div>
                              <div className="text-right font-semibold text-sky-700">{formatMoney(order.amount)}</div>
                            </div>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                  当天没有符合当前人员筛选的成交订单。
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
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
                      <span>损耗地点</span>
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
                        <div>
                          <div className="font-medium">{detail.siteName || "未知场地"}</div>
                          <div className="mt-0.5 text-xs text-muted-foreground">{detail.tankName || "未知缸位"}</div>
                        </div>
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
