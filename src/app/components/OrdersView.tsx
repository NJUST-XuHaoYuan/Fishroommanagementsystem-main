import { useState, useMemo, useRef, useEffect } from "react";
import {
  useStore, Order, OrderItem, OrderStatus, Shipment, Product, StockItem,
  PaymentRecord, PaymentType, Customer, CustomerType, Personnel, ShipmentStatus, Store, uid,
  ORDER_SOURCE_OPTIONS,
} from "../store";
import { DataTable } from "./common";
import { Button } from "./ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Checkbox } from "./ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "./ui/select";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { statusRingClass } from "./StatusIcon";
import { toast } from "sonner";
import {
  Fish, CheckCircle, XCircle, Eye, ShoppingCart, Plus, Trash2,
  ChevronDown, Check, Truck, X, MapPin, Pencil, AlertTriangle,
  Camera, Clock, PackageCheck, Download, Video, ArrowRightLeft,
  Phone, MessageCircle, UserRound, RotateCcw,
} from "lucide-react";
import { ShipDialog, ShipFormData } from "./ShipDialog";
import { getShippedOutStockIds, isPhysicallyInTank } from "../utils/inventory";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";
import { ORIGINAL_VIDEO_ACCEPT, downloadMedia, resolveMediaUrl, uploadOriginalMedia } from "../utils/media";
import { MediaVideo } from "./MediaVideo";
import { authJsonHeaders } from "../utils/authSession";

// ─── Constants ────────────────────────────────────────────────────────────────

const PAYMENT_TYPES: PaymentType[] = ["deposit", "balance", "shipping_fee", "refund", "other"];
const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  deposit: "定金", balance: "尾款", shipping_fee: "运费补款",
  refund: "退款", other: "其他",
};
const PAYMENT_TYPE_COLOR: Record<PaymentType, string> = {
  deposit: "bg-sky-100 text-sky-700",
  balance: "bg-blue-100 text-blue-700",
  shipping_fee: "bg-violet-100 text-violet-700",
  refund: "bg-red-100 text-red-700",
  other: "bg-gray-100 text-gray-600",
};
const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  preparing: "待发货",
  outbound: "已出库/待发货",
  shipped: "运输中",
  delivered: "已签收",
  damaged: "已报损",
};
const SHIP_METHOD_LABEL: Record<NonNullable<Shipment["shipMethod"]>, string> = {
  express: "物流发货",
  pickup: "上门自取",
};
const CUSTOMER_TYPE_OPTIONS: { value: Exclude<CustomerType, "">; label: string }[] = [
  { value: "B", label: "B端（批发）" },
  { value: "C", label: "C端（零售）" },
];

function customerTypeLabel(type?: CustomerType) {
  if (type === "B") return "B端（批发）";
  if (type === "C") return "C端（零售）";
  return "未设置";
}

type OrderPickerItem = {
  stockItemId: string;
  productId: string;
  price: number;
  commissionRate: number;
};

async function postOrderApi(path: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: authJsonHeaders(),
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }
  return result;
}

function mergeOperationLog(current: Store, operationLog: Store["operationLogs"][number] | undefined) {
  if (!operationLog) return current.operationLogs;
  return [operationLog, ...(current.operationLogs ?? [])]
    .filter((log, index, all) => all.findIndex((item) => item.id === log.id) === index)
    .slice(0, 10000);
}

function applyOrderApiResult(
  setState: (value: Store | ((current: Store) => Store)) => void,
  result: {
    orders?: Store["orders"];
    shipments?: Store["shipments"];
    stock?: Store["stock"];
    operationLog?: Store["operationLogs"][number];
  }
) {
  setState((current) => ({
    ...current,
    orders: Array.isArray(result.orders) ? result.orders : current.orders,
    shipments: Array.isArray(result.shipments) ? result.shipments : current.shipments,
    stock: Array.isArray(result.stock) ? result.stock : current.stock,
    operationLogs: mergeOperationLog(current, result.operationLog),
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countsAsActiveShipment(shipment: Shipment): boolean {
  return shipment.status !== "preparing" && !(shipment.status === "damaged" && shipment.damageResolution === "reship");
}

function getBillableShippingFee(order: Order, shipments: Shipment[] = []): number {
  const activeShipments = shipments.filter((shipment) =>
    shipment.orderId === order.id && countsAsActiveShipment(shipment)
  );
  if (activeShipments.length === 0) return order.shippingFee ?? 0;
  return activeShipments.reduce((sum, shipment) => sum + (shipment.actualShippingFee ?? 0), 0);
}

function hasActualShippingFee(order: Order, shipments: Shipment[] = []): boolean {
  return shipments.some((shipment) =>
    shipment.orderId === order.id && countsAsActiveShipment(shipment)
  );
}

function calcShippingAdjustment(order: Order, shipments: Shipment[] = []): number {
  if (!hasActualShippingFee(order, shipments)) return 0;
  return getBillableShippingFee(order, shipments) - (order.shippingFee ?? 0);
}

function calcDamageRefundAdjustment(order: Order, shipments: Shipment[] = []): number {
  const orderShipments = shipments.filter((shipment) => shipment.orderId === order.id);
  const explicitAdjustment = orderShipments.reduce((sum, shipment) => {
    if (shipment.status !== "damaged" || shipment.damageResolution !== "refund") return sum;
    return sum + (shipment.damageRefundAmount ?? 0);
  }, 0);
  if (explicitAdjustment > 0.005) return explicitAdjustment;

  const hasLegacyDamageRefund = orderShipments.some((shipment) =>
    shipment.status === "damaged" &&
    shipment.damageResolution === "refund" &&
    shipment.damageRefundAmount == null
  );
  return hasLegacyDamageRefund ? calcAmountRefunded(order) : 0;
}

function calcAmountDue(order: Order, shipments: Shipment[] = []): number {
  const items = order.items.reduce((s, i) => s + i.price, 0);
  return items + getBillableShippingFee(order, shipments) + (order.packagingFee ?? 0) - (order.discount ?? 0) - calcDamageRefundAdjustment(order, shipments);
}

function calcAmountPaid(order: Order): number {
  return (order.payments ?? []).reduce(
    (s, p) => (p.type === "refund" ? s - p.amount : s + p.amount), 0
  );
}

function calcAmountReceived(order: Order): number {
  return (order.payments ?? [])
    .filter((payment) => payment.type !== "refund")
    .reduce((sum, payment) => sum + payment.amount, 0);
}

function calcAmountRefunded(order: Order): number {
  return (order.payments ?? [])
    .filter((payment) => payment.type === "refund")
    .reduce((sum, payment) => sum + payment.amount, 0);
}

function isDamageRefundOrder(order: Order, shipments: Shipment[] = []): boolean {
  const orderShipments = shipments.filter((shipment) => shipment.orderId === order.id);
  return order.status === "damaged" ||
    orderShipments.some((shipment) => shipment.status === "damaged" && shipment.damageResolution === "refund");
}

type OrderFinancialState = {
  kind: "paid" | "payable" | "refundable";
  amount: number;
};

function getOrderFinancialState(order: Order, shipments: Shipment[] = []): OrderFinancialState {
  const balance = calcAmountDue(order, shipments) - calcAmountPaid(order);
  if (balance > 0.005) return { kind: "payable", amount: balance };
  if (balance < -0.005) return { kind: "refundable", amount: Math.abs(balance) };
  return { kind: "paid", amount: 0 };
}

type OrderStatusTag = {
  label: string;
  className: string;
};

const ORDER_STATUS_TAG_STYLE = {
  paid: "bg-emerald-100 text-emerald-700",
  payable: "bg-orange-100 text-orange-700",
  refundable: "bg-red-100 text-red-700",
  pendingShip: "bg-amber-100 text-amber-700",
  outNoTracking: "bg-blue-100 text-blue-700",
  receiving: "bg-purple-100 text-purple-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-gray-100 text-gray-500",
  damaged: "bg-red-100 text-red-700",
  outbound: "bg-sky-100 text-sky-700",
};

function getOrderStatusTags(order: Order, shipments: Shipment[] = []): OrderStatusTag[] {
  const orderShipments = shipments.filter((shipment) => shipment.orderId === order.id);
  const hasDamagedShipment = orderShipments.some((shipment) => shipment.status === "damaged");
  const financialState = getOrderFinancialState(order, shipments);
  const tags: OrderStatusTag[] = [{
    label: financialState.kind === "paid" ? "已结清" : financialState.kind === "payable" ? "待付款" : "待退款",
    className: financialState.kind === "paid"
      ? ORDER_STATUS_TAG_STYLE.paid
      : financialState.kind === "payable"
        ? ORDER_STATUS_TAG_STYLE.payable
        : ORDER_STATUS_TAG_STYLE.refundable,
  }];

  if (order.status === "cancelled") {
    tags.push({ label: "已取消", className: ORDER_STATUS_TAG_STYLE.cancelled });
    return tags;
  }

  if (order.status === "completed") {
    tags.push({ label: "已完成", className: ORDER_STATUS_TAG_STYLE.completed });
    return tags;
  }

  if (order.status === "damaged" || hasDamagedShipment) {
    tags.push({ label: "已报损", className: ORDER_STATUS_TAG_STYLE.damaged });
  }

  const activeShipments = orderShipments.filter(countsAsActiveShipment);
  const activeShippedItemIds = new Set(activeShipments.flatMap((shipment) => shipment.itemStockIds ?? []));
  const hasUnshippedItems = order.items.some((item) => !activeShippedItemIds.has(item.stockItemId));
  const outboundShipments = activeShipments.filter((shipment) => shipment.status === "outbound");
  const shippedInProgress = activeShipments.filter((shipment) => shipment.status === "shipped");
  const needsTracking = shippedInProgress.some((shipment) =>
    (shipment.shipMethod ?? "express") !== "pickup" && !String(shipment.trackingNo ?? "").trim()
  );
  const waitingReceive = shippedInProgress.some((shipment) =>
    (shipment.shipMethod ?? "express") !== "pickup" && !!String(shipment.trackingNo ?? "").trim()
  );

  if (activeShipments.length === 0 && order.items.length > 0) {
    tags.push({ label: "待发货", className: ORDER_STATUS_TAG_STYLE.pendingShip });
    return tags;
  }

  if (hasUnshippedItems) {
    tags.push({ label: "部分未发货", className: ORDER_STATUS_TAG_STYLE.pendingShip });
  }
  if (outboundShipments.length > 0) {
    tags.push({
      label: hasUnshippedItems ? "部分已出库/待发货" : "已出库/待发货",
      className: ORDER_STATUS_TAG_STYLE.outbound,
    });
  }
  if (needsTracking) {
    tags.push({
      label: hasUnshippedItems ? "部分已出库/待填单号" : "已出库/待填单号",
      className: ORDER_STATUS_TAG_STYLE.outNoTracking,
    });
  }
  if (waitingReceive) {
    tags.push({
      label: hasUnshippedItems ? "部分待收货" : "待收货",
      className: ORDER_STATUS_TAG_STYLE.receiving,
    });
  }

  return tags;
}

function getOrderStatusText(order: Order, shipments: Shipment[] = []): string {
  return getOrderStatusTags(order, shipments).map((tag) => tag.label).join("、");
}

function hasPaymentRecords(order: Order): boolean {
  return (order.payments ?? []).length > 0;
}

function nowDatetimeLocal(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function todayDateString(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function minDatetimeForDate(date?: string): string | undefined {
  return date ? `${date.slice(0, 10)}T00:00` : undefined;
}

function normalizeBioRecordTime(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00`;
  return trimmed.slice(0, 16);
}

function formatBioRecordTime(value: string): string {
  const normalized = normalizeBioRecordTime(value);
  if (!normalized) return "—";
  return normalized.includes("T") ? normalized.replace("T", " ") : normalized;
}

function orderNoSequence(orderNo: string): number {
  const match = orderNo.match(/(\d+)$/);
  return match ? Number(match[1]) || 0 : 0;
}

function compareOrdersByCreatedDesc(a: Order, b: Order): number {
  const aCreated = a.createdAt || "";
  const bCreated = b.createdAt || "";
  if (aCreated || bCreated) {
    const createdCompare = bCreated.localeCompare(aCreated);
    if (createdCompare !== 0) return createdCompare;
  }
  const dateCompare = b.date.localeCompare(a.date);
  if (dateCompare !== 0) return dateCompare;
  const sequenceCompare = orderNoSequence(b.orderNo) - orderNoSequence(a.orderNo);
  if (sequenceCompare !== 0) return sequenceCompare;
  return b.orderNo.localeCompare(a.orderNo);
}

function fmtDatetime(iso: string): string {
  return iso.replace("T", " ");
}

function formatLocalDateTimeMinute(value: string | undefined, emptyLabel: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return emptyLabel;
  const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (localMatch && !/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)) {
    return `${localMatch[1]} ${localMatch[2]}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw.replace("T", " ").slice(0, 16);
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16).replace("T", " ");
}

function formatOrderCreatedAt(value?: string): string {
  return formatLocalDateTimeMinute(value, "历史订单未记录");
}

function formatShipmentCreatedAt(value?: string): string {
  return formatLocalDateTimeMinute(value, "历史发货未记录");
}

function getDefaultContactPerson(personnel: Personnel[], username?: string): string {
  const currentAccount = username
    ? personnel.find((person) => person.username === username || person.name === username)
    : undefined;
  if (currentAccount) return currentAccount.name;
  return personnel[0]?.name ?? "";
}

function normalizeContactPersonName(value?: string): string {
  return String(value ?? "").trim().toLowerCase();
}

function getCurrentContactAliases(personnel: Personnel[], username?: string): Set<string> {
  const aliases = new Set<string>();
  const add = (value?: string) => {
    const normalized = normalizeContactPersonName(value);
    if (normalized) aliases.add(normalized);
  };
  add(username);
  const currentAccount = username
    ? personnel.find((person) => person.username === username || person.name === username)
    : undefined;
  add(currentAccount?.name);
  add(currentAccount?.username);
  return aliases;
}

function isActiveOrder(order: Order): boolean {
  return order.status !== "completed" && order.status !== "cancelled";
}

function getContactPersonOptions(personnel: Personnel[], current: string): Personnel[] {
  const names = new Set(personnel.map((person) => person.name));
  if (current && !names.has(current)) {
    return [{ id: `current-${current}`, name: current, role: "历史订单", phone: "", notes: "" }, ...personnel];
  }
  return personnel;
}

function excelEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(value: number | undefined): string {
  return `¥${Number(value ?? 0).toFixed(2)}`;
}

function normalizeCommissionRate(value: unknown): number {
  const rate = Number(value ?? 0);
  if (Number.isNaN(rate) || rate < 0) return 0;
  return Number(rate.toFixed(4));
}

function itemCommissionAmount(item: Pick<OrderItem, "price" | "commissionRate">): number {
  return Number(item.price ?? 0) * normalizeCommissionRate(item.commissionRate) / 100;
}

function orderCommissionTotal(order: Pick<Order, "items">): number {
  return (order.items ?? []).reduce((sum, item) => sum + itemCommissionAmount(item), 0);
}

function safeExcelFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}

function effectiveItemPlannedShipDate(order: Order, _item: OrderItem): string {
  return order.plannedShipDate || "";
}

function activeShippedItemIds(orderId: string, shipments: Shipment[]): Set<string> {
  return new Set(
    shipments
      .filter((shipment) => shipment.orderId === orderId && countsAsActiveShipment(shipment))
      .flatMap((shipment) => shipment.itemStockIds ?? [])
  );
}

function subTankNameFromState(state: Store, id?: string): string {
  if (!id) return "—";
  for (const group of state.tankGroups) {
    const tank = group.subTanks.find((entry) => entry.id === id);
    if (tank) return `${group.name} / ${tank.name}`;
  }
  return "—";
}

function hasPlannedShipPlanOnDate(order: Order, date: string): boolean {
  if (order.status === "cancelled") return false;
  if (order.plannedShipDate === date) return true;
  return order.items.some((item) => item.plannedShipDate === date);
}

function isPickupShipment(shipment: Shipment): boolean {
  return shipment.shipMethod === "pickup" || String(shipment.carrier ?? "").includes("上门自取");
}

function hasPendingTrackingShipmentOrder(order: Pick<Order, "id">, shipments: Shipment[]): boolean {
  return shipments.some((shipment) =>
    shipment.orderId === order.id &&
    shipment.status === "outbound" &&
    !isPickupShipment(shipment)
  );
}

type PendingTrackingShipmentRow = {
  shipmentId: string;
  shipDate: string;
  shipmentCreatedAt: string;
  carrier: string;
  orderNo: string;
  orderIndex: number;
  customerName: string;
  phone: string;
  wechat: string;
  douyin: string;
  address: string;
  contactPerson: string;
  productName: string;
  size: string;
  origin: string;
  code: string;
  tankName: string;
  stockStatus: string;
  price: number;
  balance: number;
  orderNotes: string;
  shipmentNotes: string;
  stockNotes: string;
};

function collectPendingTrackingShipmentRows(orders: Order[], state: Store): PendingTrackingShipmentRow[] {
  const customers = state.customers ?? [];
  const product = (id: string) => state.products.find((entry) => entry.id === id);
  const stockItem = (id: string) => state.stock.find((entry) => entry.id === id);
  const customer = (id: string) => customers.find((entry) => entry.id === id);

  const targetOrderIds = new Set(orders.map((order) => order.id));
  const targetShipments = state.shipments
    .filter((shipment) =>
      targetOrderIds.has(shipment.orderId) &&
      shipment.status === "outbound" &&
      !isPickupShipment(shipment)
    )
    .slice()
    .sort((a, b) =>
      a.shipDate.localeCompare(b.shipDate) ||
      formatShipmentCreatedAt(a.createdAt).localeCompare(formatShipmentCreatedAt(b.createdAt))
    );

  const rows = targetShipments.flatMap((shipment) => {
    const order = orders.find((entry) => entry.id === shipment.orderId);
    if (!order) return [];
    const orderCustomer = customer(order.customerId);
    const balance = calcAmountDue(order, state.shipments) - calcAmountPaid(order);
    return (shipment.itemStockIds ?? []).flatMap((stockItemId, index) => {
      const orderItem = order.items.find((item) => item.stockItemId === stockItemId);
      if (!orderItem) return [];
      const stock = stockItem(orderItem.stockItemId);
      const itemProduct = product(orderItem.productId);
      return [{
        shipmentId: shipment.id,
        shipDate: shipment.shipDate,
        shipmentCreatedAt: formatShipmentCreatedAt(shipment.createdAt),
        carrier: shipment.carrier || "",
        orderNo: order.orderNo,
        orderIndex: index + 1,
        customerName: orderCustomer?.name ?? "—",
        phone: orderCustomer?.phone || "",
        wechat: orderCustomer?.wechat || "",
        douyin: orderCustomer?.douyin || "",
        address: orderCustomer?.address || "待确认",
        contactPerson: order.contactPerson || "",
        productName: itemProduct?.name ?? orderItem.productId,
        size: itemProduct?.size ?? "",
        origin: itemProduct?.origin ?? "",
        code: stock?.code ?? "",
        tankName: subTankNameFromState(state, stock?.subTankId),
        stockStatus: stock?.status === "sick" ? "疾病" : stock?.status === "feeding" ? "开口" : "正常",
        price: orderItem.price,
        balance,
        orderNotes: order.notes || "",
        shipmentNotes: shipment.notes || "",
        stockNotes: stock?.notes || "",
      }];
    });
  });

  return rows;
}

function groupPendingTrackingRows(rows: PendingTrackingShipmentRow[]): PendingTrackingShipmentRow[][] {
  const shipmentGroups = new Map<string, PendingTrackingShipmentRow[]>();
  for (const row of rows) {
    shipmentGroups.set(row.shipmentId, [...(shipmentGroups.get(row.shipmentId) ?? []), row]);
  }
  return [...shipmentGroups.values()];
}

function exportPendingTrackingShipmentsExcel(orders: Order[], state: Store) {
  const rows = collectPendingTrackingShipmentRows(orders, state);

  if (rows.length === 0) {
    toast.error("没有符合条件的发货商品：需已出库、未确认发货且不是上门自取");
    return;
  }

  const shipmentGroupList = groupPendingTrackingRows(rows);

  const tableRow = (cells: unknown[], header = false, className = "") =>
    `<tr${className ? ` class="${className}"` : ""}>${cells.map((cell) => `<${header ? "th" : "td"} class="text">${excelEscape(cell)}</${header ? "th" : "td"}>`).join("")}</tr>`;
  const table = (title: string, dataRows: { cells: unknown[]; className?: string }[]) => `
    <table>
      <tr><td class="section" colspan="4">${excelEscape(title)}</td></tr>
      ${dataRows.map((row) => tableRow(row.cells, false, row.className)).join("")}
    </table>
  `;

  const groupedRows = shipmentGroupList.flatMap((items, index) => {
    const first = items[0];
    const sortedItems = [...items].sort((a, b) =>
      a.tankName.localeCompare(b.tankName, "zh-Hans-CN") ||
      a.productName.localeCompare(b.productName, "zh-Hans-CN") ||
      a.code.localeCompare(b.code, "zh-Hans-CN")
    );
    return [
      {
        className: "order-row",
        cells: [
          `订单 ${index + 1} 客户`,
          first.customerName,
          "发货地址",
          first.address,
        ],
      },
      {
        className: "note-row",
        cells: ["订单备注", first.orderNotes || "—", "商品数", `${items.length} 条`],
      },
      {
        className: "item-header",
        cells: ["商品名", "缸位", "尺寸", "备注"],
      },
      ...sortedItems.map((item, itemIndex) => ({
        className: "item-row",
        cells: [
          `${itemIndex + 1}. ${item.productName}`,
          item.tankName,
          item.size,
          item.stockNotes,
        ],
      })),
      { className: "spacer-row", cells: ["", "", "", ""] },
    ];
  });

  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: Arial, "Microsoft YaHei", sans-serif; }
          table { border-collapse: collapse; margin-bottom: 20px; width: 100%; }
          th, td { border: 1px solid #d9d9d9; padding: 6px 8px; font-size: 12px; vertical-align: top; }
          th { background: #f3f6f8; font-weight: 700; }
          .section { background: #0f70a8; color: #fff; font-size: 14px; font-weight: 700; }
          .order-row td { background: #eaf5ff; font-weight: 700; }
          .note-row td { background: #f7fbff; color: #333; }
          .item-header td { background: #eef2f6; font-weight: 700; text-align: center; }
          .item-row td { background: #fff; }
          .item-row td:first-child { font-weight: 700; }
          .spacer-row td { height: 10px; background: #fff; border-left: none; border-right: none; }
          .text { mso-number-format: "\\@"; }
        </style>
      </head>
      <body>
        ${table(
          "出库发货表（按订单分组）",
          groupedRows
        )}
      </body>
    </html>`;
  const blob = new Blob(["\ufeff", html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeExcelFilename(todayDateString())}_出库发货表.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast.success(`已导出 ${rows.length} 条已出库待发货商品`);
}

function exportPendingTrackingShipmentsWord(orders: Order[], state: Store) {
  const rows = collectPendingTrackingShipmentRows(orders, state);
  if (rows.length === 0) {
    toast.error("没有符合条件的发货商品：需已出库、未确认发货且不是上门自取");
    return;
  }

  const shipmentGroupList = groupPendingTrackingRows(rows);
  const blocks = shipmentGroupList.map((items, index) => {
    const first = items[0];
    const sortedItems = [...items].sort((a, b) =>
      a.tankName.localeCompare(b.tankName, "zh-Hans-CN") ||
      a.productName.localeCompare(b.productName, "zh-Hans-CN") ||
      a.code.localeCompare(b.code, "zh-Hans-CN")
    );
    return `
      <div class="order-block">
        <table>
          <thead>
            <tr class="order-head">
              <th colspan="4">
                <div class="order-title">订单 ${index + 1} · ${excelEscape(first.customerName)}</div>
                <div class="muted">商品数：${excelEscape(`${items.length} 条`)}</div>
              </th>
              <th class="order-no">${excelEscape(first.orderNo)}</th>
            </tr>
            <tr class="meta-row">
              <th class="meta-label">收货地址</th>
              <td colspan="4">${excelEscape(first.address)}</td>
            </tr>
            <tr class="meta-row">
              <th class="meta-label">订单备注</th>
              <td colspan="4">${excelEscape(first.orderNotes || "—")}</td>
            </tr>
            <tr>
              <th class="idx">#</th>
              <th>商品名</th>
              <th>缸位</th>
              <th class="size">尺寸</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            ${sortedItems.map((item, itemIndex) => `
              <tr>
                <td class="idx">${itemIndex + 1}</td>
                <td>${excelEscape(item.productName)}</td>
                <td>${excelEscape(item.tankName)}</td>
                <td class="size">${excelEscape(item.size || "—")}</td>
                <td>${excelEscape(item.stockNotes || "—")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }).join("");

  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          @page { size: A4 portrait; margin: 14mm 12mm; }
          body { font-family: Arial, "Microsoft YaHei", sans-serif; color: #111827; font-size: 10.5pt; }
          h1 { margin: 0 0 4pt; font-size: 18pt; }
          .summary { margin-bottom: 12pt; color: #4b5563; font-size: 9.5pt; }
          .order-block { page-break-inside: avoid; break-inside: avoid; margin-bottom: 12pt; }
          .order-title { font-size: 13pt; font-weight: 700; }
          .order-no { font-weight: 700; color: #0f70a8; white-space: nowrap; }
          .muted { margin-top: 2pt; color: #6b7280; font-size: 9pt; }
          .meta-label { font-weight: 700; background: #f8fafc; color: #475569; }
          table { width: 100%; border-collapse: collapse; table-layout: fixed; }
          th, td { border: 1px solid #cbd5e1; padding: 6pt 7pt; vertical-align: top; word-break: break-word; }
          th { background: #f3f6f8; font-weight: 700; text-align: left; }
          .order-head th { background: #eaf5ff; }
          .meta-row th, .meta-row td { background: #fff; }
          .meta-row .meta-label { background: #f8fafc; }
          .idx { width: 22pt; text-align: center; }
          .size { width: 48pt; text-align: center; }
        </style>
      </head>
      <body>
        <h1>出库发货表</h1>
        <div class="summary">共 ${shipmentGroupList.length} 个发货单，${rows.length} 条商品 · 导出时间 ${new Date().toLocaleString("zh-CN", { hour12: false })}</div>
        ${blocks}
      </body>
    </html>`;

  const blob = new Blob(["\ufeff", html], { type: "application/msword;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeExcelFilename(todayDateString())}_出库发货表_打印版.doc`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast.success(`已导出 Word 打印版：${rows.length} 条已出库待发货商品`);
}

function exportOrdersExcel(orders: Order[], state: Store) {
  if (orders.length === 0) {
    toast.error("请先选择要导出的订单");
    return;
  }
  const customers = state.customers ?? [];
  const product = (id: string) => state.products.find((entry) => entry.id === id);
  const stockItem = (id: string) => state.stock.find((entry) => entry.id === id);
  const batch = (id?: string) => state.batches.find((entry) => entry.id === id);
  const customer = (id: string) => customers.find((entry) => entry.id === id);
  const subTankName = (id?: string) => {
    if (!id) return "—";
    for (const group of state.tankGroups) {
      const tank = group.subTanks.find((entry) => entry.id === id);
      if (tank) return `${group.name} / ${tank.name}`;
    }
    return "—";
  };
  const shipmentsForOrder = (orderId: string) => state.shipments.filter((shipment) => shipment.orderId === orderId);
  const shipmentForItem = (orderShipments: Shipment[], stockItemId: string) =>
    orderShipments.find((shipment) => (shipment.itemStockIds ?? []).includes(stockItemId));
  const joinedShipmentProducts = (order: Order, shipment: Shipment) =>
    (shipment.itemStockIds ?? []).map((stockItemId) => {
      const orderItem = order.items.find((item) => item.stockItemId === stockItemId);
      const stock = stockItem(stockItemId);
      const itemProduct = product(orderItem?.productId ?? stock?.productId ?? "");
      return `${itemProduct?.name ?? orderItem?.productId ?? stockItemId}${stock?.code ? `(${stock.code})` : ""}`;
    }).join("、");

  const row = (cells: unknown[], header = false) =>
    `<tr>${cells.map((cell) => `<${header ? "th" : "td"} class="text">${excelEscape(cell)}</${header ? "th" : "td"}>`).join("")}</tr>`;
  const table = (title: string, headers: string[], rows: unknown[][]) => `
    <table>
      <tr><td class="section" colspan="${headers.length}">${excelEscape(title)}</td></tr>
      ${row(headers, true)}
      ${rows.length > 0 ? rows.map((cells) => row(cells)).join("") : row(["暂无记录", ...Array(headers.length - 1).fill("")])}
    </table>
  `;

  const orderRows = orders.map((order, index) => {
    const orderCustomer = customer(order.customerId);
    const orderShipments = shipmentsForOrder(order.id);
    const itemSubtotal = order.items.reduce((sum, item) => sum + item.price, 0);
    const amountDue = calcAmountDue(order, state.shipments);
    const amountPaid = calcAmountPaid(order);
    const financialState = getOrderFinancialState(order, state.shipments);
    return [
      index + 1,
      order.orderNo,
      getOrderStatusText(order, state.shipments),
      order.source || "",
      orderCustomer?.name ?? "—",
      orderCustomer?.phone || "",
      order.date,
      order.status === "completed" ? "—" : order.plannedShipDate || "—",
      order.contactPerson || "",
      order.items.length,
      orderShipments.length,
      money(itemSubtotal),
      money(getBillableShippingFee(order, state.shipments)),
      money(order.packagingFee),
      money(order.discount),
      money(amountDue),
      money(amountPaid),
      financialState.kind === "paid"
        ? "已结清"
        : financialState.kind === "payable"
          ? `待付款 ${money(financialState.amount)}`
          : `待退款 ${money(financialState.amount)}`,
      order.notes || "",
    ];
  });

  const productRows = orders.flatMap((order) => {
    const orderCustomer = customer(order.customerId);
    const orderShipments = shipmentsForOrder(order.id);
    const activeShipments = orderShipments.filter(countsAsActiveShipment);
    const shippedItemIds = new Set(activeShipments.flatMap((shipment) => shipment.itemStockIds ?? []));
    return order.items.map((orderItem, index) => {
      const stock = stockItem(orderItem.stockItemId);
      const itemProduct = product(orderItem.productId);
      const itemBatch = batch(stock?.batchId);
      const itemShipment = shipmentForItem(orderShipments, orderItem.stockItemId);
      return [
        order.orderNo,
        orderCustomer?.name ?? "—",
        index + 1,
        stock?.code ?? "",
        orderItem.stockItemId,
        itemProduct?.name ?? orderItem.productId,
        itemProduct?.size ?? "",
        itemProduct?.origin ?? "",
        subTankName(stock?.subTankId),
        itemBatch?.batchNo ?? "",
        itemBatch?.supplier ?? "",
        stock?.inDate ?? "",
        effectiveItemPlannedShipDate(order, orderItem) || "",
        stock?.status === "sick" ? "疾病" : stock?.status === "feeding" ? "开口" : "正常",
        stock?.lost
          ? "已损耗"
          : itemShipment?.status === "outbound"
            ? "已出库待发货"
            : shippedItemIds.has(orderItem.stockItemId) ? "已发货" : "待发货",
        itemShipment ? `发货单${orderShipments.findIndex((shipment) => shipment.id === itemShipment.id) + 1}` : "",
        money(orderItem.price),
        stock?.notes ?? "",
      ];
    });
  });

  const shipmentRows = orders.flatMap((order) => {
    const orderCustomer = customer(order.customerId);
    return shipmentsForOrder(order.id).map((shipment, index) => [
      order.orderNo,
      orderCustomer?.name ?? "—",
      index + 1,
      SHIP_METHOD_LABEL[shipment.shipMethod ?? "express"],
      shipment.shipDate,
      shipment.carrier || "—",
      shipment.trackingNo || "—",
      SHIPMENT_STATUS_LABEL[shipment.status],
      shipment.damageResolution === "refund" ? "退款" : shipment.damageResolution === "reship" ? "补发" : "",
      money(shipment.actualShippingFee ?? 0),
      (shipment.itemStockIds ?? []).length,
      joinedShipmentProducts(order, shipment),
      shipment.notes || "",
    ]);
  });

  const paymentRows = orders.flatMap((order) => {
    const orderCustomer = customer(order.customerId);
    return [...(order.payments ?? [])]
      .sort((a, b) => a.time.localeCompare(b.time))
      .map((payment, index) => [
        order.orderNo,
        orderCustomer?.name ?? "—",
        index + 1,
        fmtDatetime(payment.time),
        PAYMENT_TYPE_LABEL[payment.type],
        payment.type === "refund" ? `-${money(payment.amount)}` : money(payment.amount),
        payment.notes || "",
      ]);
  });

  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: Arial, "Microsoft YaHei", sans-serif; }
          table { border-collapse: collapse; margin-bottom: 18px; width: 100%; }
          th, td { border: 1px solid #d9d9d9; padding: 6px 8px; font-size: 12px; vertical-align: top; }
          th { background: #f3f6f8; font-weight: 700; }
          .section { background: #0f70a8; color: #fff; font-size: 14px; font-weight: 700; }
          .text { mso-number-format: "\\@"; }
        </style>
      </head>
      <body>
        ${table("订单汇总", ["序号", "订单号", "状态", "来源", "客户", "手机", "下单日期", "预计发货", "对接人", "商品数", "发货单数", "商品小计", "计费运费", "包装费", "折扣/优惠", "应付总额", "实付净额", "结算状态", "备注"], orderRows)}
        ${table("商品明细", ["订单号", "客户", "序号", "编号", "库存ID", "商品", "尺寸", "产地", "缸位", "批次", "供应商", "入库日期", "计划发货", "状态", "发货状态", "所属发货单", "售价", "备注"], productRows)}
        ${table("发货信息", ["订单号", "客户", "发货单", "方式", "发货日期", "承运方", "运单号", "状态", "报损处理", "实际运费", "商品数", "商品", "备注"], shipmentRows)}
        ${table("资金往来", ["订单号", "客户", "序号", "时间", "类型", "金额", "备注"], paymentRows)}
      </body>
    </html>`;
  const blob = new Blob(["\ufeff", html], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const suffix = orders.length === 1 ? orders[0].orderNo : `${orders.length}个订单_${todayDateString()}`;
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeExcelFilename(suffix)}_订单信息.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ─── Small UI pieces ──────────────────────────────────────────────────────────

function OrderStatusTags({
  order,
  shipments,
  className = "",
}: {
  order: Order;
  shipments: Shipment[];
  className?: string;
}) {
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${className}`}>
      {getOrderStatusTags(order, shipments).map((tag) => (
        <span key={tag.label} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tag.className}`}>
          {tag.label}
        </span>
      ))}
    </span>
  );
}

function PaymentBadge({ type }: { type: PaymentType }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${PAYMENT_TYPE_COLOR[type]}`}>
      {PAYMENT_TYPE_LABEL[type]}
    </span>
  );
}

function LostItemOverlay({ compact = false }: { compact?: boolean }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-red-600/85 text-white">
      <AlertTriangle className={compact ? "size-3" : "size-5"} />
      <span className={compact ? "text-[8px] leading-none font-bold" : "text-[10px] leading-none font-bold"}>
        损耗
      </span>
    </div>
  );
}

function ShipmentStatusBadge({
  shipment,
  onClick,
}: {
  shipment: Shipment;
  onClick?: () => void;
}) {
  if (shipment.status === "delivered") {
    return (
      <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700">
        <CheckCircle className="size-3" /> 已签收
      </span>
    );
  }

  if (shipment.status === "damaged") {
    const label = shipment.damageResolution === "reship" ? "已报损 · 补发" : "已报损 · 退款";
    return (
      <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">
        <XCircle className="size-3" /> {label}
      </span>
    );
  }

  if (shipment.status === "outbound" && onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title="点击上传打包凭证并确认发货"
        className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-sky-100 text-sky-700 hover:bg-sky-200 transition-colors cursor-pointer"
      >
        <PackageCheck className="size-3" /> 已出库/待发货
      </button>
    );
  }

  if (shipment.status === "shipped" && onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title="点击处理运输状态"
        className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700 hover:bg-blue-200 transition-colors cursor-pointer"
      >
        <Truck className="size-3" /> 运输中
      </button>
    );
  }

  return (
    <span className="ml-auto inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">
      <Truck className="size-3" /> 待发货
    </span>
  );
}

// ─── CustomerCombobox ─────────────────────────────────────────────────────────

function CustomerCombobox({
  value, onChange, customers,
}: { value: string; onChange: (id: string) => void; customers: Customer[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) { setOpen(false); setQ(""); }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const selected = customers.find((c) => c.id === value);
  const filtered = customers.filter(
    (c) => !q || c.name.includes(q) || c.phone.includes(q) || c.wechat.includes(q)
  );

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm bg-background hover:bg-accent/40 transition-colors ${!value ? "text-muted-foreground" : ""}`}
        onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 50); }}
      >
        <span>
          {selected
            ? `${selected.name}${selected.phone ? ` · ${selected.phone}` : ""}`
            : "请选择客户"}
        </span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-2 border-b">
            <Input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索客户名、手机号…"
              className="h-8 text-sm"
              onKeyDown={(e) => e.key === "Escape" && (setOpen(false), setQ(""))}
            />
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">无匹配客户</div>
            )}
            {filtered.map((c) => (
              <button
                key={c.id}
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-accent text-left"
                onClick={() => { onChange(c.id); setOpen(false); setQ(""); }}
              >
                <Check className={`size-3.5 shrink-0 ${value === c.id ? "opacity-100 text-sky-600" : "opacity-0"}`} />
                <div>
                  <div className="text-sm font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {[c.phone, c.wechat && `微信: ${c.wechat}`, c.source].filter(Boolean).join(" · ")}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerSourceCombobox({
  value,
  onChange,
  onAdd,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: (v: string) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(
    () => options.filter((option) => option.toLowerCase().includes(q.toLowerCase())),
    [options, q]
  );
  const canAdd = q.trim() && !options.some((option) => option === q.trim());

  const pick = (v: string, isNew = false) => {
    onChange(v);
    if (isNew) onAdd(v);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className={`w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm bg-background hover:bg-accent/40 transition-colors ${
          !value ? "text-muted-foreground" : ""
        }`}
        onClick={() => {
          setOpen((current) => !current);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
      >
        <span>{value || "请选择来源"}</span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-2 border-b">
            <Input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索或输入新来源..."
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAdd) pick(q.trim(), true);
                if (e.key === "Escape") {
                  setOpen(false);
                  setQ("");
                }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 && !canAdd && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">无匹配来源</div>
            )}
            {filtered.map((option) => (
              <button
                key={option}
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                onClick={() => pick(option)}
              >
                <Check className={`size-3.5 shrink-0 ${value === option ? "opacity-100 text-sky-600" : "opacity-0"}`} />
                {option}
              </button>
            ))}
            {canAdd && (
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-sky-50 text-sky-600 font-medium border-t"
                onClick={() => pick(q.trim(), true)}
              >
                <Plus className="size-3.5 shrink-0" />
                新增来源「{q.trim()}」
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateCustomerDialog({
  open,
  onOpenChange,
  sources,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: string[];
  onCreate: (customer: Customer) => boolean | Promise<boolean>;
}) {
  const today = todayDateString();
  const emptyCustomer = (): Customer => ({
    id: uid(),
    name: "",
    customerType: "C",
    addedDate: today,
    phone: "",
    wechat: "",
    douyin: "",
    source: "",
    address: "",
    notes: "",
  });
  const [form, setForm] = useState<Customer>(emptyCustomer);

  useEffect(() => {
    if (open) setForm(emptyCustomer());
  }, [open, today]);

  const submit = async () => {
    const name = form.name.trim();
    if (!name) return toast.error("请输入客户名称");
    if (form.addedDate && form.addedDate > today) return toast.error("客户添加时间不能晚于今天");
    const customer: Customer = {
      id: form.id,
      name,
      customerType: form.customerType ?? "",
      addedDate: form.addedDate,
      phone: form.phone.trim(),
      wechat: form.wechat.trim(),
      douyin: form.douyin.trim(),
      source: form.source.trim(),
      address: form.address.trim(),
      notes: form.notes.trim(),
    };
    if (!confirmWrite("新增", `将新增客户「${customer.name}」，并选入当前订单。`)) return;
    const ok = await onCreate(customer);
    if (ok !== false) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新增客户</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="grid gap-2">
              <Label>客户名称<span className="text-red-500 ml-0.5">*</span></Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((current) => ({ ...current, name: e.target.value }))}
                placeholder="请输入客户名称"
              />
            </div>
            <div className="grid gap-2">
              <Label>类型</Label>
              <Select
                value={form.customerType || undefined}
                onValueChange={(value) => setForm((current) => ({ ...current, customerType: value as CustomerType }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择类型" />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOMER_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>来源</Label>
              <CustomerSourceCombobox
                value={form.source}
                onChange={(value) => setForm((current) => ({ ...current, source: value }))}
                onAdd={(value) => setForm((current) => ({ ...current, source: value }))}
                options={sources}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>手机号</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm((current) => ({ ...current, phone: e.target.value }))}
                placeholder="请输入手机号"
                type="tel"
              />
            </div>
            <div className="grid gap-2">
              <Label>添加时间</Label>
              <Input
                type="date"
                value={form.addedDate}
                max={today}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value && value > today) {
                    toast.error("客户添加时间不能晚于今天");
                    return;
                  }
                  setForm((current) => ({ ...current, addedDate: value }));
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>微信号</Label>
              <Input
                value={form.wechat}
                onChange={(e) => setForm((current) => ({ ...current, wechat: e.target.value }))}
                placeholder="请输入微信号"
              />
            </div>
            <div className="grid gap-2">
              <Label>抖音号</Label>
              <Input
                value={form.douyin}
                onChange={(e) => setForm((current) => ({ ...current, douyin: e.target.value }))}
                placeholder="请输入抖音号"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>常用地址</Label>
            <Input
              value={form.address}
              onChange={(e) => setForm((current) => ({ ...current, address: e.target.value }))}
              placeholder="省市区 + 详细地址"
            />
          </div>

          <div className="grid gap-2">
            <Label>备注</Label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))}
              placeholder="其他说明..."
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit}>保存客户</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Customer Detail ──────────────────────────────────────────────────────────

function CustomerDetailDialog({
  customer,
  open,
  onOpenChange,
  orders,
  shipments,
}: {
  customer: Customer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orders: Order[];
  shipments: Shipment[];
}) {
  const customerOrders = useMemo(() => {
    if (!customer) return [];
    return orders
      .filter((order) => order.customerId === customer.id)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [customer, orders]);

  const totalDue = customerOrders.reduce((sum, order) => sum + calcAmountDue(order, shipments), 0);
  const totalPaid = customerOrders.reduce((sum, order) => sum + calcAmountPaid(order), 0);
  const balance = totalDue - totalPaid;
  const activeCount = customerOrders.filter((order) => order.status !== "completed" && order.status !== "cancelled").length;
  const completedCount = customerOrders.filter((order) => order.status === "completed").length;
  const recentOrders = customerOrders.slice(0, 5);

  const field = (label: string, value?: string) => (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 min-h-5 break-words text-sm font-medium">{value || "—"}</div>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-full bg-sky-100 text-sky-700">
              <UserRound className="size-5" />
            </span>
            <span>{customer?.name ?? "客户详情"}</span>
          </DialogTitle>
        </DialogHeader>

        {customer && (
          <div className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">订单总数</div>
                <div className="mt-1 text-2xl font-semibold">{customerOrders.length}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  未完成 {activeCount} · 已完成 {completedCount}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">累计应收</div>
                <div className="mt-1 text-2xl font-semibold text-sky-700">{money(totalDue)}</div>
                <div className="mt-1 text-xs text-muted-foreground">按当前订单金额计算</div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">累计实收</div>
                <div className="mt-1 text-2xl font-semibold text-emerald-600">{money(totalPaid)}</div>
                <div className={`mt-1 text-xs ${balance > 0.005 ? "text-orange-600" : balance < -0.005 ? "text-red-600" : "text-muted-foreground"}`}>
                  {Math.abs(balance) <= 0.005 ? "账款已平" : balance > 0 ? `待收 ${money(balance)}` : `多收 ${money(Math.abs(balance))}`}
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {field("类型", customerTypeLabel(customer.customerType))}
              {field("来源", customer.source)}
              {field("添加时间", customer.addedDate)}
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <div className="text-xs text-muted-foreground">手机号</div>
                <div className="mt-1 flex min-h-5 items-center gap-1.5 break-words text-sm font-medium">
                  <Phone className="size-3.5 text-muted-foreground" />
                  {customer.phone || "—"}
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <div className="text-xs text-muted-foreground">微信号</div>
                <div className="mt-1 flex min-h-5 items-center gap-1.5 break-words text-sm font-medium">
                  <MessageCircle className="size-3.5 text-muted-foreground" />
                  {customer.wechat || "—"}
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <div className="text-xs text-muted-foreground">抖音号</div>
                <div className="mt-1 flex min-h-5 items-center gap-1.5 break-words text-sm font-medium">
                  <Video className="size-3.5 text-muted-foreground" />
                  {customer.douyin || "—"}
                </div>
              </div>
              <div className="rounded-lg border bg-muted/20 px-3 py-2">
                <div className="text-xs text-muted-foreground">常用地址</div>
                <div className="mt-1 flex min-h-5 items-start gap-1.5 break-words text-sm font-medium">
                  <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                  <span>{customer.address || "—"}</span>
                </div>
              </div>
            </div>

            <div className="rounded-lg border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">客户备注</div>
              <div className="mt-1 min-h-5 whitespace-pre-wrap break-words text-sm">{customer.notes || "—"}</div>
            </div>

            <div className="rounded-lg border overflow-hidden">
              <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">最近订单</div>
              {recentOrders.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">暂无订单</div>
              ) : (
                <div className="divide-y">
                  {recentOrders.map((order) => (
                    <div key={order.id} className="grid gap-2 px-3 py-2 text-sm md:grid-cols-[1.2fr_0.9fr_0.9fr_0.9fr]">
                      <span className="font-medium">{order.orderNo}</span>
                      <span className="text-muted-foreground">{order.date}</span>
                      <OrderStatusTags order={order} shipments={shipments} />
                      <span className="font-medium text-sky-700">{money(calcAmountDue(order, shipments))}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ProofUploader ────────────────────────────────────────────────────────────

function ProofUploader({
  images, onChange,
}: { images: string[]; onChange: (imgs: string[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);

  const handleFiles = async (files: FileList) => {
    setLoading(true);
    const results: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        toast.info("凭证原图上传中…");
        results.push(await uploadOriginalMedia(file));
        toast.success("凭证已上传");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "凭证上传失败");
      }
    }
    onChange([...images, ...results]);
    setLoading(false);
  };

  const openImg = async (src: string) => {
    const resolved = await resolveMediaUrl(src).catch(() => src);
    const w = window.open();
    w?.document.write(`<img src="${resolved}" style="max-width:100%;max-height:100vh;display:block;margin:auto;" />`);
  };

  return (
    <div className="flex flex-wrap gap-2 items-start">
      {images.map((img, i) => (
        <div key={i} className="relative group shrink-0">
          <ImageWithFallback
            src={img}
            alt="凭证"
            className="size-14 object-cover rounded border cursor-pointer hover:opacity-80"
            onClick={() => openImg(img)}
            title="点击查看大图"
          />
          <button
            type="button"
            className="absolute -top-1 -right-1 size-4 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => onChange(images.filter((_, j) => j !== i))}
          >
            <Trash2 className="size-2.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="size-14 rounded border border-dashed flex items-center justify-center text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors shrink-0"
        onClick={() => fileRef.current?.click()}
        disabled={loading}
        title="上传凭证图片"
      >
        {loading
          ? <div className="size-4 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
          : <Plus className="size-4" />}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />
    </div>
  );
}

// ─── AddPaymentDialog ─────────────────────────────────────────────────────────

function AddPaymentDialog({
  open, onOpenChange, onAdd, editingRecord, onUpdate,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onAdd: (r: PaymentRecord) => boolean | Promise<boolean>;
  editingRecord?: PaymentRecord | null;
  onUpdate?: (r: PaymentRecord) => boolean | Promise<boolean>;
}) {
  const emptyForm = () => ({
    time: nowDatetimeLocal(), type: "balance" as PaymentType,
    amount: 0, proof: [] as string[], notes: "",
  });
  const [form, setForm] = useState(emptyForm);
  const isEditing = !!editingRecord;

  useEffect(() => {
    if (!open) return;
    setForm(editingRecord
      ? {
          time: editingRecord.time,
          type: editingRecord.type,
          amount: editingRecord.amount,
          proof: [...(editingRecord.proof ?? [])],
          notes: editingRecord.notes ?? "",
        }
      : emptyForm()
    );
  }, [open, editingRecord]);

  const submit = async () => {
    if (!form.amount || form.amount <= 0) return toast.error("请输入有效金额");
    const ok = editingRecord
      ? await onUpdate?.({ ...editingRecord, ...form, amount: Number(form.amount) })
      : await onAdd({ ...form, id: uid(), amount: Number(form.amount) });
    if (ok !== false) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEditing ? "修改资金往来记录" : "添加收款 / 退款记录"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>类型</Label>
              <Select
                value={form.type}
                onValueChange={(v) => setForm((f) => ({ ...f, type: v as PaymentType }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{PAYMENT_TYPE_LABEL[t]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>金额（元）<span className="text-red-500">*</span></Label>
              <Input
                type="number" min={0} step={0.01}
                value={form.amount || ""}
                onChange={(e) => setForm((f) => ({ ...f, amount: Number(e.target.value) }))}
                placeholder="0.00"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>时间</Label>
            <Input
              type="datetime-local"
              value={form.time}
              onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
            />
          </div>
          <div className="grid gap-2">
            <Label>备注</Label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="描述该笔收款/退款情况…"
              rows={2}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div className="grid gap-2">
            <Label>凭证图片</Label>
            <ProofUploader
              images={form.proof}
              onChange={(imgs) => setForm((f) => ({ ...f, proof: imgs }))}
            />
            <p className="text-xs text-muted-foreground">支持多张凭证，点击图片查看大图</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit}>{isEditing ? "保存修改" : "添加记录"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Return Unshipped Item ────────────────────────────────────────────────────

function ReturnItemDialog({
  open,
  onOpenChange,
  order,
  item,
  product,
  stock,
  maxRefund,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Order | null;
  item: OrderItem | null;
  product?: Product;
  stock?: StockItem;
  maxRefund: number;
  onConfirm: (refund: PaymentRecord | null) => boolean | Promise<boolean>;
}) {
  const [amount, setAmount] = useState(0);
  const [time, setTime] = useState(nowDatetimeLocal());
  const [notes, setNotes] = useState("");
  const [proof, setProof] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !item) return;
    setAmount(Number(Math.min(item.price, maxRefund).toFixed(2)));
    setTime(nowDatetimeLocal());
    setNotes(stock?.lost ? "未发货商品损耗退款" : "未发货商品退款");
    setProof([]);
  }, [open, item?.stockItemId, maxRefund, stock?.lost]);

  if (!order || !item) return null;

  const submit = async () => {
    if (amount < 0) return toast.error("退款金额不能为负数");
    if (amount > maxRefund + 0.005) return toast.error(`退款金额不能超过当前净已收款 ¥${maxRefund.toFixed(2)}`);
    const refund = amount > 0.005
      ? {
          id: uid(),
          time,
          type: "refund" as const,
          amount: Number(amount.toFixed(2)),
          proof,
          notes: notes.trim() || (stock?.lost ? "未发货商品损耗退款" : "未发货商品退款"),
        }
      : null;
    const ok = await onConfirm(refund);
    if (ok !== false) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{stock?.lost ? "退损耗商品" : "退未发货商品"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="font-medium">{product?.name ?? item.productId}</div>
            <div className="text-xs text-muted-foreground mt-1">
              订单售价 ¥{item.price.toFixed(2)}，当前净已收款 ¥{maxRefund.toFixed(2)}
            </div>
            {stock?.lost && (
              <div className="mt-2 rounded border border-red-100 bg-red-50 px-2 py-1.5 text-xs text-red-700">
                该商品已损耗，不能发货；确认后会从订单商品中移除。
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>退款金额（元）</Label>
              <Input
                type="number"
                min={0}
                max={maxRefund}
                step={0.01}
                value={amount === 0 ? "" : amount}
                onChange={(event) => setAmount(event.target.value === "" ? 0 : Number(event.target.value))}
                placeholder="0.00"
              />
              <p className="text-xs text-muted-foreground">不需要实际退款可填 0。</p>
            </div>
            <div className="grid gap-2">
              <Label>退款时间</Label>
              <Input type="datetime-local" value={time} onChange={(event) => setTime(event.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>退款 / 退货备注</Label>
            <Textarea
              rows={3}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="填写原因、协商结果或退款方式..."
            />
          </div>
          <div className="grid gap-2">
            <Label>退款凭证</Label>
            <ProofUploader images={proof} onChange={setProof} />
          </div>
          <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            确认后会先从订单中移除此商品，订单应收金额随之减少；退款金额大于 0 时，会同步写入资金往来记录。
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit}>确认退商品</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Shipment Status Actions ─────────────────────────────────────────────────

function ShipmentActionDialog({
  shipment, orderNo, open, saving = false, onOpenChange, onDelivered, onDamage, onCancelShipment, onConfirmShipment,
}: {
  shipment: Shipment | null;
  orderNo?: string;
  open: boolean;
  saving?: boolean;
  onOpenChange: (o: boolean) => void;
  onDelivered: (shipment: Shipment) => void;
  onDamage: (shipment: Shipment) => void;
  onCancelShipment: (shipment: Shipment) => void;
  onConfirmShipment: (shipment: Shipment, packingProof: string[]) => void;
}) {
  const [packingProof, setPackingProof] = useState<string[]>([]);

  useEffect(() => {
    if (open && shipment) setPackingProof([...(shipment.packingProof ?? [])]);
  }, [open, shipment?.id]);

  if (!shipment) return null;
  const method = shipment.shipMethod === "pickup" ? "上门自取" : (shipment.carrier || "快递");

  if (shipment.status === "outbound") {
    const confirmShipment = () => {
      if (packingProof.length < 2) {
        toast.error("请至少上传 2 张打包凭证：捞鱼照片和封箱前照片");
        return;
      }
      onConfirmShipment(shipment, packingProof);
    };

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>出库发货确认</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm flex flex-col gap-1">
              <div><span className="text-muted-foreground">订单：</span>{orderNo ?? "—"}</div>
              <div><span className="text-muted-foreground">方式：</span>{method}</div>
              <div><span className="text-muted-foreground">出库操作时间：</span>{formatShipmentCreatedAt(shipment.createdAt)}</div>
              <div><span className="text-muted-foreground">出库日期：</span>{shipment.outboundDate || shipment.shipDate}</div>
              <div><span className="text-muted-foreground">商品数：</span>{(shipment.itemStockIds ?? []).length} 条</div>
            </div>

            <div className="grid gap-2">
              <Label>打包凭证<span className="text-red-500 ml-0.5">*</span></Label>
              <ProofUploader images={packingProof} onChange={setPackingProof} />
              <p className="text-xs text-muted-foreground">
                至少上传 2 张：鱼捞出后的照片、封箱前照片。上传后点击「确认发货」才会进入运输中。
              </p>
            </div>

            <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
              已出库的鱼已经不在缸内显示；如果出库点错，可以在真正发货前取消出库。
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>关闭</Button>
            <Button
              variant="outline"
              className="text-amber-700 border-amber-200 hover:bg-amber-50"
              onClick={() => onCancelShipment(shipment)}
              disabled={saving}
            >
              <RotateCcw className="size-4 mr-1" />
              取消出库
            </Button>
            <Button onClick={confirmShipment} disabled={saving}>
              <Truck className="size-4 mr-1" />
              {saving ? "保存中..." : "确认发货"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-sm">
        <DialogHeader>
          <DialogTitle>处理运输状态</DialogTitle>
        </DialogHeader>
        <div className="rounded-lg border bg-muted/30 p-3 text-sm flex flex-col gap-1">
          <div><span className="text-muted-foreground">订单：</span>{orderNo ?? "—"}</div>
          <div><span className="text-muted-foreground">方式：</span>{method}</div>
          {shipment.trackingNo && (
            <div><span className="text-muted-foreground">运单号：</span>{shipment.trackingNo}</div>
          )}
          <div><span className="text-muted-foreground">出库操作时间：</span>{formatShipmentCreatedAt(shipment.createdAt)}</div>
          <div><span className="text-muted-foreground">发货操作时间：</span>{formatShipmentCreatedAt(shipment.shippedAt || shipment.createdAt)}</div>
          <div><span className="text-muted-foreground">发货日期：</span>{shipment.shipDate}</div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Button
            variant="outline"
            className="h-auto py-3 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
            onClick={() => onDelivered(shipment)}
          >
            <CheckCircle className="size-4" />
            确认收货
          </Button>
          <Button
            variant="outline"
            className="h-auto py-3 text-red-700 border-red-200 hover:bg-red-50"
            onClick={() => onDamage(shipment)}
          >
            <XCircle className="size-4" />
            报损处理
          </Button>
          <Button
            variant="outline"
            className="h-auto py-3 text-amber-700 border-amber-200 hover:bg-amber-50"
            onClick={() => onCancelShipment(shipment)}
          >
            <RotateCcw className="size-4" />
            取消发货
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReportDamageDialog({
  shipment, order, open, onOpenChange, onSubmit,
}: {
  shipment: Shipment | null;
  order: Order | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSubmit: (shipment: Shipment, result: DamageResult) => boolean | Promise<boolean>;
}) {
  const { state } = useStore();
  const refundable = order ? Math.max(calcAmountPaid(order), 0) : 0;
  const [resolution, setResolution] = useState<"refund" | "reship">("refund");
  const [refundItemIds, setRefundItemIds] = useState<string[]>([]);
  const [refundAmountByStockId, setRefundAmountByStockId] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState("物流报损，待退款");
  const [proof, setProof] = useState<string[]>([]);
  const [replacementByOriginal, setReplacementByOriginal] = useState<Record<string, string>>({});
  const [replacementGroupByOriginal, setReplacementGroupByOriginal] = useState<Record<string, string>>({});
  const [replacementSubTankByOriginal, setReplacementSubTankByOriginal] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      const shippedIds = new Set(shipment?.itemStockIds ?? []);
      const shipmentItems = (order?.items ?? []).filter((item) => shippedIds.has(item.stockItemId));
      const defaultRefundIds = shipmentItems.map((item) => item.stockItemId);
      setResolution("refund");
      setRefundItemIds(defaultRefundIds);
      setRefundAmountByStockId(Object.fromEntries(
        shipmentItems.map((item) => [item.stockItemId, Number(item.price.toFixed(2))])
      ));
      setNotes("物流报损，待退款");
      setProof([]);
      setReplacementByOriginal({});
      setReplacementGroupByOriginal({});
      setReplacementSubTankByOriginal({});
    }
  }, [open, shipment?.id, order?.id, refundable]);

  if (!shipment || !order) return null;

  const damagedItems = order.items.filter((item) => (shipment.itemStockIds ?? []).includes(item.stockItemId));
  const refundItemIdSet = new Set(refundItemIds);
  const selectedRefundItems = damagedItems.filter((item) => refundItemIdSet.has(item.stockItemId));
  const selectedRefundSubtotal = selectedRefundItems.reduce((sum, item) => sum + item.price, 0);
  const selectedRefundAmount = selectedRefundItems.reduce(
    (sum, item) => sum + (refundAmountByStockId[item.stockItemId] ?? 0),
    0
  );
  const maxRefundForSelection = Math.min(refundable, selectedRefundSubtotal);
  const selectedReplacementIds = new Set(Object.values(replacementByOriginal).filter(Boolean));

  const getProduct = (id: string) => state.products.find((product) => product.id === id);
  const getStockItem = (id: string) => state.stock.find((stock) => stock.id === id);
  const shippedOutStockIds = getShippedOutStockIds(state.shipments);
  const productSummary = (product?: Product) =>
    [
      product?.size ? `规格 ${product.size}` : "",
      product?.origin ? `产地 ${product.origin}` : "",
      product?.defaultPrice != null ? `默认售价 ¥${Number(product.defaultPrice).toFixed(2)}` : "",
      product?.notes ? `备注 ${product.notes}` : "",
    ].filter(Boolean).join(" · ");
  const tankName = (subTankId?: string) => {
    if (!subTankId) return "—";
    for (const group of state.tankGroups) {
      const tank = group.subTanks.find((item) => item.id === subTankId);
      if (tank) return `${group.name} / ${tank.name}`;
    }
    return "—";
  };
  const tankContext = (subTankId?: string) => {
    if (!subTankId) return null;
    for (const group of state.tankGroups) {
      const tank = group.subTanks.find((item) => item.id === subTankId);
      if (tank) return { group, tank, name: `${group.name} / ${tank.name}` };
    }
    return null;
  };
  const replacementOptionLabel = (stock: StockItem) => {
    const product = getProduct(stock.productId);
    return [
      product?.name ?? "未知商品",
      product?.size ? `规格 ${product.size}` : "",
      product?.origin ? `产地 ${product.origin}` : "",
      product?.defaultPrice != null ? `默认售价 ¥${Number(product.defaultPrice).toFixed(2)}` : "",
      stock.code ? `鱼编号 ${stock.code}` : "",
      `缸位 ${tankName(stock.subTankId)}`,
      stock.basePrice != null ? `入库售价 ¥${Number(stock.basePrice).toFixed(2)}` : "",
      stock.notes ? `库存备注 ${stock.notes}` : "",
    ].filter(Boolean).join(" · ");
  };
  const getReplacementIcon = (stock: StockItem) => {
    const records = state.bioRecords
      .filter((record) => record.stockItemId === stock.id && record.photos.length > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (records.length > 0) return records[records.length - 1].photos.at(-1) ?? "";
    return getProduct(stock.productId)?.imageUrl ?? "";
  };
  const availableReplacementOptions = (item: OrderItem, subTankId?: string) =>
    state.stock.filter((stock) =>
      !stock.sold &&
      isPhysicallyInTank(stock, shippedOutStockIds) &&
      !!tankContext(stock.subTankId) &&
      (!subTankId || stock.subTankId === subTankId) &&
      (!selectedReplacementIds.has(stock.id) || replacementByOriginal[item.stockItemId] === stock.id)
    );
  const availableReplacementGroups = (item: OrderItem) => {
    const map = new Map<string, { name: string; count: number }>();
    for (const stock of availableReplacementOptions(item)) {
      const ctx = tankContext(stock.subTankId);
      if (!ctx) continue;
      const current = map.get(ctx.group.id);
      map.set(ctx.group.id, { name: ctx.group.name, count: (current?.count ?? 0) + 1 });
    }
    return [...map.entries()].map(([id, info]) => ({ id, ...info }));
  };
  const availableReplacementTanks = (item: OrderItem, groupId: string) => {
    const map = new Map<string, { name: string; count: number }>();
    for (const stock of availableReplacementOptions(item)) {
      const ctx = tankContext(stock.subTankId);
      if (!ctx || ctx.group.id !== groupId) continue;
      const current = map.get(stock.subTankId);
      map.set(stock.subTankId, { name: ctx.tank.name, count: (current?.count ?? 0) + 1 });
    }
    return [...map.entries()].map(([id, info]) => ({ id, ...info }));
  };

  const setRefundItemChecked = (stockItemId: string, checked: boolean) => {
    const targetItem = damagedItems.find((item) => item.stockItemId === stockItemId);
    setRefundItemIds((current) => {
      const next = checked
        ? Array.from(new Set([...current, stockItemId]))
        : current.filter((id) => id !== stockItemId);
      return next;
    });
    setRefundAmountByStockId((current) => {
      const next = { ...current };
      if (checked) next[stockItemId] = next[stockItemId] ?? Number((targetItem?.price ?? 0).toFixed(2));
      else delete next[stockItemId];
      return next;
    });
  };

  const setRefundItemAmount = (stockItemId: string, value: string) => {
    setRefundAmountByStockId((current) => ({
      ...current,
      [stockItemId]: value === "" ? 0 : Number(value),
    }));
  };

  const submit = async () => {
    let result: DamageResult;
    if (resolution === "refund") {
      if (selectedRefundItems.length === 0) return toast.error("请选择实际需要退款的商品");
      if (!selectedRefundAmount || selectedRefundAmount <= 0) return toast.error("请输入有效待退款金额");
      const invalidRefundItem = selectedRefundItems.find((item) => {
        const itemAmount = refundAmountByStockId[item.stockItemId] ?? 0;
        return itemAmount < 0 || itemAmount > item.price + 0.005;
      });
      if (invalidRefundItem) {
        const product = getProduct(invalidRefundItem.productId);
        return toast.error(`${product?.name ?? invalidRefundItem.productId} 的待退款金额不能超过售价 ¥${invalidRefundItem.price.toFixed(2)}`);
      }
      if (selectedRefundAmount > maxRefundForSelection + 0.005)
        return toast.error(`退款金额不能超过已选商品可退金额 ¥${maxRefundForSelection.toFixed(2)}`);
      const refundItemText = selectedRefundItems.map((item) => {
        const product = getProduct(item.productId);
        const stock = getStockItem(item.stockItemId);
        const itemRefundAmount = refundAmountByStockId[item.stockItemId] ?? 0;
        return `${product?.name ?? item.productId}${stock?.code ? `(${stock.code})` : ""}（售价¥${item.price.toFixed(2)}，退款¥${itemRefundAmount.toFixed(2)}）`;
      }).join("、");
      result = {
        resolution: "refund",
        damagedItemStockIds: selectedRefundItems.map((item) => item.stockItemId),
        refundAmount: Number(selectedRefundAmount.toFixed(2)),
        proof,
        notes: `${notes.trim() || "物流报损，待退款"}；退款商品：${refundItemText}`,
      };
    } else {
      if (damagedItems.length === 0) return toast.error("该发货单没有可补发的商品");
      const replacements = damagedItems.map((item) => ({
        originalStockItemId: item.stockItemId,
        replacementStockItemId: replacementByOriginal[item.stockItemId] ?? "",
      }));
      if (replacements.some((item) => !item.replacementStockItemId))
        return toast.error("请选择补发库存鱼");
      if (new Set(replacements.map((item) => item.replacementStockItemId)).size !== replacements.length)
        return toast.error("同一条库存鱼不能重复补发");
      result = {
        resolution: "reship",
        notes: notes.trim() || "物流报损，安排补发",
        replacements,
      };
    }
    const ok = await onSubmit(shipment, result);
    if (ok !== false) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-none sm:max-w-none max-h-[90vh] flex flex-col"
        style={{ width: "min(92vw, 980px)", maxWidth: "min(92vw, 980px)" }}
      >
        <DialogHeader>
          <DialogTitle>物流报损处理</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 py-1 pr-1">
          <div className="rounded-lg border border-red-100 bg-red-50/60 p-3 text-sm text-red-800">
            该发货单会标记为「已报损」。选择退款时只勾选实际报损并退款的鱼，金额可按协商结果填写；选择补发需要从未售库存里选择替换鱼。
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { setResolution("refund"); setNotes("物流报损，待退款"); }}
              className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                resolution === "refund"
                  ? "border-red-500 bg-red-50 text-red-700"
                  : "hover:bg-muted text-muted-foreground"
              }`}
            >
              退款
            </button>
            <button
              type="button"
              onClick={() => { setResolution("reship"); setNotes("物流报损，安排补发"); }}
              className={`rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
                resolution === "reship"
                  ? "border-sky-500 bg-sky-50 text-sky-700"
                  : "hover:bg-muted text-muted-foreground"
              }`}
            >
              补发
            </button>
          </div>
          {resolution === "refund" && (
            <div className="grid gap-3">
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Label>选择实际退款商品<span className="text-red-500">*</span></Label>
                  <span className="text-xs text-muted-foreground">
                    已选 {selectedRefundItems.length} 件 / 售价 ¥{selectedRefundSubtotal.toFixed(2)} / 退款 ¥{selectedRefundAmount.toFixed(2)}
                  </span>
                </div>
                <div className="max-h-56 overflow-y-auto rounded-lg border divide-y">
                  {damagedItems.map((item) => {
                    const product = getProduct(item.productId);
                    const stock = getStockItem(item.stockItemId);
                    const checked = refundItemIdSet.has(item.stockItemId);
                    const itemRefundAmount = refundAmountByStockId[item.stockItemId] ?? 0;
                    return (
                      <div key={item.stockItemId} className="grid grid-cols-[auto_minmax(0,1fr)_96px_132px] items-start gap-3 px-3 py-2.5 hover:bg-muted/40">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(value) => setRefundItemChecked(item.stockItemId, value === true)}
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{product?.name ?? item.productId}</div>
                          <div className="text-xs text-muted-foreground">
                            {stock?.code ? `编号 ${stock.code} · ` : ""}{tankName(stock?.subTankId)}
                            {product?.size ? ` · ${product.size}` : ""}
                            {product?.origin ? ` · ${product.origin}` : ""}
                          </div>
                        </div>
                        <div className="text-right text-sm font-medium">
                          <div>售价</div>
                          <div>¥{item.price.toFixed(2)}</div>
                        </div>
                        <div className="grid gap-1">
                          <div className="text-right text-xs text-muted-foreground">本次退款</div>
                          <Input
                            type="number"
                            min={0}
                            max={item.price}
                            step={0.01}
                            value={checked ? (itemRefundAmount || "") : ""}
                            onChange={(event) => setRefundItemAmount(item.stockItemId, event.target.value)}
                            disabled={!checked}
                            className="h-8 text-right"
                            placeholder="0.00"
                          />
                        </div>
                      </div>
                    );
                  })}
                  {damagedItems.length === 0 && (
                    <div className="p-4 text-center text-sm text-muted-foreground">该发货单没有商品</div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  只勾选实际要退款的鱼；每条鱼的待退款金额可手动改，但不能超过该鱼售价、已选商品总售价和当前净已收款。
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>退款金额合计</Label>
                  <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-base font-semibold text-red-600">
                    ¥{selectedRefundAmount.toFixed(2)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    当前最多可退 ¥{maxRefundForSelection.toFixed(2)}，订单净已收 ¥{refundable.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-orange-100 bg-orange-50 px-3 py-2 text-xs text-orange-800">
                  确认后只会把这笔金额计入订单「待退款」。实际退款完成后，请在资金往来里手动新增退款记录。
                </div>
              </div>
            </div>
          )}
          {resolution === "reship" && (
            <div className="grid gap-2">
              <Label>选择补发库存鱼<span className="text-red-500 ml-0.5">*</span></Label>
              <div className="rounded-lg border divide-y max-h-64 overflow-y-auto">
                {damagedItems.map((item) => {
                  const product = getProduct(item.productId);
                  const originalStock = getStockItem(item.stockItemId);
                  const groupOptions = availableReplacementGroups(item);
                  const selectedGroupId = replacementGroupByOriginal[item.stockItemId] ?? "";
                  const tankOptions = selectedGroupId ? availableReplacementTanks(item, selectedGroupId) : [];
                  const selectedTankId = replacementSubTankByOriginal[item.stockItemId] ?? "";
                  const options = selectedTankId ? availableReplacementOptions(item, selectedTankId) : [];
                  const selected = replacementByOriginal[item.stockItemId] ?? "";
                  return (
                    <div key={item.stockItemId} className="p-3 grid gap-2">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{product?.name ?? item.productId}</div>
                          <div className="text-xs text-muted-foreground">
                            原报损鱼：{tankName(originalStock?.subTankId)}
                            {productSummary(product) ? ` · ${productSummary(product)}` : ""}
                            {originalStock?.code ? ` · 鱼编号 ${originalStock.code}` : ""}
                            {originalStock?.notes ? ` · 库存备注 ${originalStock.notes}` : ""}
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground shrink-0">原售价 ¥{item.price.toFixed(2)}</span>
                      </div>
                      <div className="grid gap-3 rounded-lg border bg-muted/10 p-3">
                        <div className="grid gap-2">
                          <div className="text-xs font-medium text-muted-foreground">① 选择缸组</div>
                          {groupOptions.length === 0 ? (
                            <div className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                              暂无可补发库存
                            </div>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {groupOptions.map((group) => (
                                <button
                                  key={group.id}
                                  type="button"
                                  onClick={() => {
                                    setReplacementGroupByOriginal((current) => ({ ...current, [item.stockItemId]: group.id }));
                                    setReplacementSubTankByOriginal((current) => {
                                      const next = { ...current };
                                      delete next[item.stockItemId];
                                      return next;
                                    });
                                    setReplacementByOriginal((current) => {
                                      const next = { ...current };
                                      delete next[item.stockItemId];
                                      return next;
                                    });
                                  }}
                                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                                    selectedGroupId === group.id
                                      ? "border-sky-600 bg-sky-600 text-white"
                                      : "border-border bg-background hover:bg-muted"
                                  }`}
                                >
                                  {group.name}
                                  <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                    selectedGroupId === group.id ? "bg-white/25 text-white" : "bg-sky-100 text-sky-700"
                                  }`}>
                                    {group.count}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>

                        {selectedGroupId && (
                          <div className="grid gap-2">
                            <div className="text-xs font-medium text-muted-foreground">② 选择子缸</div>
                            <div className="flex flex-wrap gap-2">
                              {tankOptions.map((tank) => (
                                <button
                                  key={tank.id}
                                  type="button"
                                  onClick={() => {
                                    setReplacementSubTankByOriginal((current) => ({ ...current, [item.stockItemId]: tank.id }));
                                    setReplacementByOriginal((current) => {
                                      const next = { ...current };
                                      delete next[item.stockItemId];
                                      return next;
                                    });
                                  }}
                                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                                    selectedTankId === tank.id
                                      ? "border-sky-500 bg-sky-500 text-white"
                                      : "border-border bg-background hover:bg-muted"
                                  }`}
                                >
                                  {tank.name}
                                  <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                                    selectedTankId === tank.id ? "bg-white/25 text-white" : "bg-sky-100 text-sky-700"
                                  }`}>
                                    {tank.count}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {selectedTankId && (
                          <div className="grid gap-2">
                            <div className="flex items-center justify-between">
                              <div className="text-xs font-medium text-muted-foreground">③ 选择具体库存鱼</div>
                              {selected && <span className="text-xs font-medium text-emerald-600">已选择</span>}
                            </div>
                            {options.length === 0 ? (
                              <div className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
                                该子缸暂无可补发库存
                              </div>
                            ) : (
                              <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto pr-1 md:grid-cols-2">
                                {options.map((stock) => {
                                  const optionProduct = getProduct(stock.productId);
                                  const iconUrl = getReplacementIcon(stock);
                                  const isSelected = selected === stock.id;
                                  return (
                                    <button
                                      key={stock.id}
                                      type="button"
                                      onClick={() =>
                                        setReplacementByOriginal((current) => ({ ...current, [item.stockItemId]: stock.id }))
                                      }
                                      title={replacementOptionLabel(stock)}
                                      className={`flex min-w-0 items-center gap-2 rounded-lg border p-2 text-left transition-colors ${
                                        isSelected
                                          ? "border-emerald-500 bg-emerald-50 ring-1 ring-emerald-400"
                                          : "border-border bg-background hover:bg-muted/70"
                                      }`}
                                    >
                                      <div className="relative size-12 shrink-0 overflow-hidden rounded border bg-muted">
                                        {iconUrl
                                          ? <ImageWithFallback src={iconUrl} alt="" className="size-full object-cover" />
                                          : <div className="flex size-full items-center justify-center"><Fish className="size-4 text-muted-foreground" /></div>}
                                        {stock.code && (
                                          <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-0.5 text-center text-[9px] font-semibold leading-3 text-white">
                                            {stock.code}
                                          </span>
                                        )}
                                      </div>
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium">
                                          {optionProduct?.name ?? "未知商品"}
                                          {stock.code ? ` · ${stock.code}` : ""}
                                        </div>
                                        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                                          {[
                                            optionProduct?.size ? `规格 ${optionProduct.size}` : "",
                                            optionProduct?.origin ? `产地 ${optionProduct.origin}` : "",
                                            stock.basePrice != null ? `入库售价 ¥${Number(stock.basePrice).toFixed(2)}` : "",
                                            stock.notes ? `备注 ${stock.notes}` : "",
                                          ].filter(Boolean).join(" · ")}
                                        </div>
                                      </div>
                                      {isSelected && <Check className="size-4 shrink-0 text-emerald-600" />}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                {damagedItems.length === 0 && (
                  <div className="p-4 text-sm text-center text-muted-foreground">该发货单没有可补发的商品</div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                补发可以从当前所有未售且还在有效缸位里的库存鱼中选择；按缸组、子缸、具体鱼逐级选择，避免选错。
              </p>
            </div>
          )}
          <div className="grid gap-2">
            <Label>{resolution === "refund" ? "报损 / 待退款备注" : "报损 / 补发备注"}</Label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={resolution === "refund" ? "填写报损原因、应退金额说明或沟通记录…" : "填写报损原因、补发说明或沟通记录…"}
            />
          </div>
          {resolution === "refund" && (
            <div className="grid gap-2">
              <Label>报损凭证</Label>
              <ProofUploader images={proof} onChange={setProof} />
              <p className="text-xs text-muted-foreground">可上传物流异常截图、沟通记录等凭证；实际退款凭证请在资金往来里上传。</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="destructive" onClick={submit}>
            <XCircle className="size-4 mr-1" />
            {resolution === "refund" ? "确认报损待退款" : "确认报损补发"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── PaymentTimeline ──────────────────────────────────────────────────────────

function PaymentTimeline({
  payments, onAdd, onEdit, onDelete, canAdd, canEdit, canDelete,
}: {
  payments: PaymentRecord[];
  onAdd: () => void;
  onEdit: (record: PaymentRecord) => void;
  onDelete: (record: PaymentRecord) => void;
  canAdd: boolean;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const sorted = [...payments].sort((a, b) => a.time.localeCompare(b.time));

  const openImg = (src: string) => {
    const w = window.open();
    w?.document.write(`<img src="${src}" style="max-width:100%;max-height:100vh;display:block;margin:auto;" />`);
  };

  return (
    <div className="flex flex-col">
      {sorted.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-3">暂无收款记录</p>
      )}
      {sorted.map((p, idx) => {
        const isRefund = p.type === "refund";
        const isLast = idx === sorted.length - 1;
        return (
          <div key={p.id} className="flex gap-3">
            <div className="flex flex-col items-center w-4 shrink-0">
              <div
                className={`size-3 rounded-full mt-0.5 ring-2 ring-offset-1 shrink-0 ${
                  isRefund ? "bg-red-400 ring-red-200" : "bg-emerald-400 ring-emerald-200"
                }`}
              />
              {!isLast && <div className="w-px flex-1 bg-border min-h-4 my-1" />}
            </div>
            <div className={`flex-1 ${isLast ? "pb-1" : "pb-4"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">{fmtDatetime(p.time)}</span>
                  <PaymentBadge type={p.type} />
                  <span className={`text-sm font-semibold ${isRefund ? "text-red-600" : "text-emerald-600"}`}>
                    {isRefund ? "−" : "+"}¥{p.amount.toFixed(2)}
                  </span>
                </div>
                {(canEdit || canDelete) && (
                  <div className="flex shrink-0 items-center gap-1">
                    {canEdit && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs"
                        onClick={() => onEdit(p)}
                      >
                        <Pencil className="size-3 mr-1" />
                        编辑
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700"
                        onClick={() => onDelete(p)}
                      >
                        <Trash2 className="size-3 mr-1" />
                        删除
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {p.notes && <p className="text-xs text-muted-foreground mt-0.5">{p.notes}</p>}
              {p.proof?.length > 0 && (
                <div className="flex gap-2 mt-2 flex-wrap">
                  {p.proof.map((img, i) => (
                    <img
                      key={i}
                      src={img}
                      className="size-14 object-cover rounded border cursor-pointer hover:opacity-80"
                      onClick={() => openImg(img)}
                      title="点击查看大图"
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {canAdd && (
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm text-sky-600 hover:text-sky-700 font-medium mt-2 hover:underline w-fit"
          onClick={onAdd}
        >
          <Plus className="size-4" /> 添加收款 / 退款记录
        </button>
      )}
    </div>
  );
}

// ─── StockItemDetailDialog ────────────────────────────────────────────────────

function StockItemDetailDialog({
  stockItemId, open, onOpenChange,
}: { stockItemId: string | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { state, setState } = useStore();
  useEffect(() => {
    if (!open || !stockItemId) return;
    let cancelled = false;
    fetch(`/api/bio-records?stockItemId=${encodeURIComponent(stockItemId)}`, { headers: authJsonHeaders() })
      .then((response) => response.json().then((result) => ({ response, result })))
      .then(({ response, result }) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        const records = Array.isArray(result.bioRecords) ? result.bioRecords : [];
        setState((current) => ({
          ...current,
          stock: result.stockItem
            ? current.stock.map((stock) => stock.id === stockItemId ? { ...stock, ...result.stockItem } : stock)
            : current.stock,
          bioRecords: [
            ...current.bioRecords.filter((record) => record.stockItemId !== stockItemId),
            ...records,
          ],
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load bio records:", error);
          toast.error("养殖记录加载失败，请刷新后重试");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, stockItemId, setState]);
  if (!stockItemId) return null;
  const s = state.stock.find((x) => x.id === stockItemId);
  if (!s) return null;
  const p = state.products.find((x) => x.id === s.productId);
  const batch = state.batches.find((x) => x.id === s.batchId);
  const bioRecs = state.bioRecords
    .filter((r) => r.stockItemId === stockItemId)
    .sort((a, b) => b.date.localeCompare(a.date));

  const tankName = (() => {
    for (const g of state.tankGroups) {
      const t = g.subTanks.find((x) => x.id === s.subTankId);
      if (t) return `${g.name} / ${t.name}`;
    }
    return "—";
  })();

  const statusLabel: Record<string, string> = { healthy: "正常", sick: "病弱", feeding: "开口", sold: "已售", lost: "已损耗" };
  const statusColor: Record<string, string> = {
    healthy: "bg-white text-slate-700 border border-slate-200",
    sick: "bg-red-100 text-red-700",
    feeding: "bg-amber-100 text-amber-700",
    sold: "bg-gray-100 text-gray-500",
    lost: "bg-red-100 text-red-700",
  };

  const openImg = (src: string) => {
    const w = window.open();
    w?.document.write(`<img src="${src}" style="max-width:100%;max-height:100vh;display:block;margin:auto;" />`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-md max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Fish className="size-4 text-sky-600" />
            {p?.name ?? "商品详情"}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1">
          {/* Product info */}
          <div className="flex gap-3">
            <div className="relative size-16 rounded-lg overflow-hidden border bg-muted shrink-0">
	              {p?.imageUrl
	                ? <ImageWithFallback src={p.imageUrl} alt="" className="size-full object-cover" />
	                : <div className="size-full flex items-center justify-center"><Fish className="size-5 text-muted-foreground" /></div>}
	              {s.code && (
	                <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-0.5 text-center text-[10px] font-semibold leading-4 text-white">
	                  {s.code}
	                </span>
	              )}
	              {s.lost && <LostItemOverlay />}
            </div>
            <div className="flex flex-col gap-1 text-sm">
              <div className="font-semibold text-base">{p?.name ?? "—"}</div>
              {(p?.size || p?.origin) && (
                <div className="text-muted-foreground">{[p?.size, p?.origin].filter(Boolean).join(" · ")}</div>
              )}
              <span className={`self-start px-1.5 py-0.5 rounded text-xs font-medium ${statusColor[s.lost ? "lost" : s.status] ?? "bg-gray-100 text-gray-500"}`}>
                {statusLabel[s.lost ? "lost" : s.status] ?? s.status}
              </span>
            </div>
          </div>

          {/* Stock details */}
	          <div className="rounded-lg border p-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
	            {s.code && <div><span className="text-muted-foreground">显示编号：</span>{s.code}</div>}
	            <div><span className="text-muted-foreground">库存编号：</span><span className="font-mono text-xs">{s.id}</span></div>
            <div><span className="text-muted-foreground">入库日期：</span>{s.inDate}</div>
            <div><span className="text-muted-foreground">所在缸位：</span>{tankName}</div>
            <div><span className="text-muted-foreground">销售默认价：</span>¥{s.basePrice.toFixed(2)}</div>
            {batch && <div className="col-span-2"><span className="text-muted-foreground">批次：</span>{batch.batchNo} · {batch.supplier}</div>}
            {s.notes && <div className="col-span-2"><span className="text-muted-foreground">备注：</span>{s.notes}</div>}
          </div>

          {/* Bio records */}
          <div>
            <div className="text-xs font-medium text-muted-foreground mb-2">养殖记录（{bioRecs.length}）</div>
            {bioRecs.length === 0
              ? <p className="text-sm text-muted-foreground text-center py-4 border border-dashed rounded-lg">暂无养殖记录</p>
              : (
                <div className="flex flex-col gap-2">
                  {bioRecs.map((r) => (
                    <div key={r.id} className="rounded-lg border p-3 text-sm">
                      <div className="text-xs text-muted-foreground mb-1">{formatBioRecordTime(r.date)}</div>
                      <p>{r.text}</p>
                      {r.photos.length > 0 && (
                        <div className="flex gap-2 mt-2 flex-wrap">
                          {r.photos.map((img, i) => (
                            <img key={i} src={img} className="size-14 object-cover rounded border cursor-pointer hover:opacity-80"
                              onClick={() => openImg(img)} />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Editable Stock Bio Dialog for Order Picker ─────────────────────────────

function StockPickerBioDialog({
  stockItemId,
  open,
  onOpenChange,
}: {
  stockItemId: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { state, setState, saveStateTransform, saveMaintenanceAction } = useStore();
  const permission = usePermission("daily");
  const today = todayDateString();
  const nowForRecord = nowDatetimeLocal();
  const photoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  const lossPhotoRef = useRef<HTMLInputElement>(null);
  const [actionMode, setActionMode] = useState<"detail" | "move" | "loss">("detail");
  const [bioStatus, setBioStatus] = useState<StockItem["status"]>("healthy");
  const [bioCode, setBioCode] = useState("");
  const [bioNotes, setBioNotes] = useState("");
  const [newRecord, setNewRecord] = useState<{ date: string; text: string; photos: string[]; videos: string[] }>({
    date: nowDatetimeLocal(),
    text: "",
    photos: [],
    videos: [],
  });
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [editingRecordTime, setEditingRecordTime] = useState("");
  const [targetGroupId, setTargetGroupId] = useState("");
  const [targetSubTankId, setTargetSubTankId] = useState("");
  const [moveNotes, setMoveNotes] = useState("");
  const [moveSaving, setMoveSaving] = useState(false);
  const [lossDate, setLossDate] = useState(today);
  const [lossReason, setLossReason] = useState("");
  const [lossProof, setLossProof] = useState<string[]>([]);
  const [lossSaving, setLossSaving] = useState(false);

  const item = stockItemId ? state.stock.find((stock) => stock.id === stockItemId) : null;
  const product = item ? state.products.find((entry) => entry.id === item.productId) : undefined;
  const batch = item ? state.batches.find((entry) => entry.id === item.batchId) : undefined;
  const order = item
    ? state.orders.find((entry) =>
        entry.status !== "cancelled" && entry.items.some((orderItem) => orderItem.stockItemId === item.id)
      )
    : undefined;

  useEffect(() => {
    if (!open || !item) return;
    setBioStatus(item.status);
    setBioCode(item.code ?? "");
    setBioNotes(item.notes ?? "");
    setNewRecord({ date: nowDatetimeLocal(), text: "", photos: [], videos: [] });
    setEditingRecordId(null);
    setEditingRecordTime("");
    setActionMode("detail");
    setTargetGroupId("");
    setTargetSubTankId("");
    setMoveNotes("");
    setLossDate(today);
    setLossReason("");
    setLossProof([]);
  }, [open, item?.id, item?.status, item?.notes, today]);

  useEffect(() => {
    if (!open || !stockItemId) return;
    let cancelled = false;
    fetch(`/api/bio-records?stockItemId=${encodeURIComponent(stockItemId)}`, { headers: authJsonHeaders() })
      .then((response) => response.json().then((result) => ({ response, result })))
      .then(({ response, result }) => {
        if (cancelled) return;
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        const records = Array.isArray(result.bioRecords) ? result.bioRecords : [];
        setState((current) => ({
          ...current,
          stock: result.stockItem
            ? current.stock.map((stock) => stock.id === stockItemId ? { ...stock, ...result.stockItem } : stock)
            : current.stock,
          bioRecords: [
            ...current.bioRecords.filter((record) => record.stockItemId !== stockItemId),
            ...records,
          ],
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("Failed to load bio records:", error);
          toast.error("养殖记录加载失败，请刷新后重试");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, stockItemId, setState]);

  if (!open || !stockItemId) return null;

  const subTankName = (subTankId?: string) => {
    if (!subTankId) return "—";
    for (const group of state.tankGroups) {
      const tank = group.subTanks.find((entry) => entry.id === subTankId);
      if (tank) return `${group.name} / ${tank.name}`;
    }
    return "—";
  };
  const groupIdBySubTank = (subTankId?: string) => {
    if (!subTankId) return "";
    return state.tankGroups.find((group) =>
      group.subTanks.some((tank) => tank.id === subTankId)
    )?.id ?? "";
  };
  const tankName = subTankName(item?.subTankId);
  const targetSubTanks = state.tankGroups.find((group) => group.id === targetGroupId)?.subTanks ?? [];
  const shippedOutStockIds = getShippedOutStockIds(state.shipments);

  const timeline = item
    ? [
        { type: "stock_in" as const, date: item.inDate, batchNo: batch?.batchNo ?? "—" },
        ...state.bioRecords
          .filter((record) => record.stockItemId === item.id)
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((record) => ({
            type: "record" as const,
            id: record.id,
            date: record.date,
            text: record.text,
            photos: record.photos ?? [],
            videos: record.videos ?? [],
          })),
        ...(order ? [{ type: "sold" as const, date: order.date, orderNo: order.orderNo }] : []),
      ].sort((a, b) => a.date.localeCompare(b.date))
    : [];

  const changeBioRecordDate = (value: string) => {
    const normalized = normalizeBioRecordTime(value);
    if (normalized && normalized > nowForRecord) return toast.error("记录时间不能晚于当前时间");
    const minTime = minDatetimeForDate(item?.inDate);
    if (item && normalized && minTime && normalized < minTime) return toast.error("记录时间不能早于入库日期");
    setNewRecord((prev) => ({ ...prev, date: normalized }));
  };

  const saveBio = async () => {
    if (!item) return;
    if (!permission.requirePermission("update")) return;
    if (!confirmWrite("修改", "将保存鱼的状态、编号和备注。")) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      stock: latest.stock.map((stock) =>
        stock.id === item.id ? { ...stock, status: bioStatus, code: bioCode.trim(), notes: bioNotes } : stock
      ),
    }));
    if (!ok) return toast.error("保存失败，请重试");
    toast.success("状态已更新");
  };

  const addBioRecord = async () => {
    if (!item) return;
    if (!permission.requirePermission("create")) return;
    if (!newRecord.date) return toast.error("请选择记录时间");
    const recordTime = normalizeBioRecordTime(newRecord.date);
    if (recordTime > nowForRecord) return toast.error("记录时间不能晚于当前时间");
    const minTime = minDatetimeForDate(item.inDate);
    if (minTime && recordTime < minTime) return toast.error("记录时间不能早于入库日期");
    if (!newRecord.text.trim() && newRecord.photos.length === 0 && newRecord.videos.length === 0) {
      return toast.error("请填写记录内容或上传照片/视频");
    }
    if (!confirmWrite("新增", "将新增一条观察记录。")) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      bioRecords: [
        ...latest.bioRecords,
        {
          id: uid(),
          stockItemId: item.id,
          date: recordTime,
          text: newRecord.text,
          photos: newRecord.photos,
          videos: newRecord.videos,
        },
      ],
    }));
    if (!ok) return toast.error("保存失败，请重试");
    setNewRecord({ date: nowDatetimeLocal(), text: "", photos: [], videos: [] });
    toast.success("记录已添加");
  };

  const startEditBioRecordTime = (recordId: string, date: string) => {
    if (!permission.requirePermission("update")) return;
    setEditingRecordId(recordId);
    setEditingRecordTime(normalizeBioRecordTime(date));
  };

  const saveBioRecordTime = async () => {
    if (!item || !editingRecordId) return;
    if (!permission.requirePermission("update")) return;
    const recordTime = normalizeBioRecordTime(editingRecordTime);
    if (!recordTime) return toast.error("请选择记录时间");
    if (recordTime > nowForRecord) return toast.error("记录时间不能晚于当前时间");
    const minTime = minDatetimeForDate(item.inDate);
    if (minTime && recordTime < minTime) return toast.error("记录时间不能早于入库日期");
    if (!confirmWrite("修改", "将修改这条观察记录的记录时间。")) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      bioRecords: latest.bioRecords.map((record) =>
        record.id === editingRecordId ? { ...record, date: recordTime } : record
      ),
    }));
    if (!ok) return toast.error("保存失败，请重试");
    setEditingRecordId(null);
    setEditingRecordTime("");
    toast.success("记录时间已更新");
  };

  const deleteBioRecord = async (recordId: string) => {
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", "将删除这条观察记录。")) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      bioRecords: latest.bioRecords.filter((record) => record.id !== recordId),
    }));
    if (!ok) return toast.error("删除失败，请重试");
    toast.success("记录已删除");
  };

  const handlePhotoUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(async (file) => {
      if (!file.type.startsWith("image/")) return toast.error("请选择图片文件");
      try {
        toast.info("照片原图上传中…");
        const url = await uploadOriginalMedia(file);
        setNewRecord((prev) => ({ ...prev, photos: [...prev.photos, url] }));
        toast.success("照片已上传");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "照片上传失败，请重试");
      }
    });
  };

  const handleVideoUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(async (file) => {
      if (!file.type.startsWith("video/")) return toast.error("请选择视频文件");
      try {
        toast.info("视频原文件上传中…");
        const url = await uploadOriginalMedia(file);
        setNewRecord((prev) => ({ ...prev, videos: [...prev.videos, url] }));
        toast.success("视频已上传");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "视频上传失败，请重试");
      }
    });
  };

  const openMoveDialog = () => {
    if (!item) return;
    if (!permission.requirePermission("update")) return;
    if (!isPhysicallyInTank(item, shippedOutStockIds)) return toast.error("该鱼已不在当前库存中，不能移缸");
    const currentGroupId = groupIdBySubTank(item.subTankId);
    const defaultGroup = state.tankGroups.find((group) => group.id !== currentGroupId) ?? state.tankGroups[0];
    setTargetGroupId(defaultGroup?.id ?? "");
    setTargetSubTankId("");
    setMoveNotes("");
    setActionMode("move");
  };

  const submitMove = async () => {
    if (!item) return;
    if (!permission.requirePermission("update")) return;
    if (!targetSubTankId) return toast.error("请选择目标子缸");
    if (item.subTankId === targetSubTankId) return toast.error("目标子缸与当前子缸相同");
    if (!confirmWrite("移缸", `将移动「${product?.name ?? item.productId}」到目标子缸。`)) return;
    setMoveSaving(true);
    const ok = await saveMaintenanceAction({
      mode: "move",
      itemIds: [item.id],
      targetSubTankId,
      moveDate: today,
      moveNotes: moveNotes.trim(),
    });
    setMoveSaving(false);
    if (!ok) return toast.error("移缸保存失败，请刷新后重试");
    toast.success("已移缸");
    onOpenChange(false);
  };

  const openLossDialog = () => {
    if (!item) return;
    if (!permission.requirePermission("delete")) return;
    if (!isPhysicallyInTank(item, shippedOutStockIds)) return toast.error("该鱼已不在当前库存中，不能登记损耗");
    setLossDate(today);
    setLossReason("");
    setLossProof([]);
    setActionMode("loss");
  };

  const changeLossDate = (value: string) => {
    if (value && value > today) return toast.error("损耗日期不能晚于今天");
    if (item && value && value < item.inDate) return toast.error("损耗日期不能早于入库日期");
    setLossDate(value);
  };

  const handleLossProofUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(async (file) => {
      if (!file.type.startsWith("image/")) return toast.error("请选择图片文件");
      try {
        toast.info("损耗凭证原图上传中…");
        const url = await uploadOriginalMedia(file);
        setLossProof((prev) => [...prev, url]);
        toast.success("损耗凭证已上传");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "损耗凭证上传失败，请重试");
      }
    });
  };

  const submitLoss = async () => {
    if (!item) return;
    if (!permission.requirePermission("delete")) return;
    if (!lossDate) return toast.error("请选择损耗日期");
    if (lossDate > today) return toast.error("损耗日期不能晚于今天");
    if (lossDate < item.inDate) return toast.error("损耗日期不能早于入库日期");
    if (lossProof.length === 0) return toast.error("请上传损耗照片凭证");
    if (!confirmWrite("登记损耗", "损耗后该鱼会从缸位视图和可售库存中移除，并生成损耗记录。")) return;
    setLossSaving(true);
    const ok = await saveMaintenanceAction({
      mode: "loss",
      stockItemId: item.id,
      lossDate,
      lossReason: lossReason.trim(),
      lossProof,
    });
    setLossSaving(false);
    if (!ok) return toast.error("损耗保存失败，请刷新后重试");
    if (order) {
      toast.success(`已登记损耗；请到订单 ${order.orderNo} 里点击退商品并填写退款金额`);
    } else {
      toast.success("已登记损耗");
    }
    onOpenChange(false);
  };

  return (
    <>
    <Dialog open={open && actionMode === "detail"} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {product?.imageUrl && (
              <div className="size-8 rounded overflow-hidden border">
                <ImageWithFallback src={product.imageUrl} alt="" className="size-full object-cover" />
              </div>
            )}
            <span>生物详情</span>
            {product && (
              <span className="text-muted-foreground flex items-center gap-1.5">
                — {product.name}
                {product.size && <span className="text-[11px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{product.size}</span>}
                {product.origin && <span className="text-[11px] text-muted-foreground">{product.origin}</span>}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {item ? (
          <div className="overflow-y-auto flex-1 min-h-0 flex flex-col gap-5 pr-1">
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-4 md:grid-cols-3">
              <div className="grid gap-2">
                <Label>当前状态</Label>
                <Select value={bioStatus} onValueChange={(value: StockItem["status"]) => setBioStatus(value)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="healthy">正常</SelectItem>
                    <SelectItem value="feeding">已开口</SelectItem>
                    <SelectItem value="sick">疾病</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>编号</Label>
                <Input value={bioCode} onChange={(event) => setBioCode(event.target.value)} placeholder="可填写编号..." />
              </div>
              <div className="grid gap-2">
                <Label>备注</Label>
                <Input value={bioNotes} onChange={(event) => setBioNotes(event.target.value)} placeholder="可填写备注..." />
              </div>
              <div className="text-xs text-muted-foreground md:col-span-2">
                入库：{item.inDate} · 批次：{batch?.batchNo ?? "—"} · 缸位：{tankName} · 销售默认价：¥{Number(item.basePrice ?? 0).toFixed(2)}
              </div>
            </div>

            <div>
              <div className="mb-3 flex items-center gap-2">
                <Clock className="size-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">生物时间轴</span>
              </div>
              <div className="relative flex flex-col gap-0 pl-6">
                <div className="absolute bottom-2 left-2 top-2 w-px bg-border" />
                {timeline.map((event, index) => (
                  <div key={`${event.type}-${index}`} className="relative mb-4">
                    <div
                      className={`absolute -left-[18px] size-3 rounded-full border-2 border-white ring-2 ${
                        event.type === "stock_in" ? "bg-sky-500 ring-sky-300" :
                        event.type === "sold" ? "bg-yellow-500 ring-yellow-300" :
                        "bg-emerald-500 ring-emerald-300"
                      }`}
                      style={{ top: "4px" }}
                    />
                    <div
                      className={`rounded-lg border p-3 text-sm ${
                        event.type === "sold" ? "border-yellow-200 bg-yellow-50" :
                        event.type === "stock_in" ? "border-sky-200 bg-sky-50" :
                        "border-border bg-card"
                      }`}
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {event.type === "stock_in" && <PackageCheck className="size-3.5 text-sky-600" />}
                          {event.type === "record" && <Camera className="size-3.5 text-emerald-600" />}
                          {event.type === "sold" && <ShoppingCart className="size-3.5 text-yellow-600" />}
                          <span className="text-xs">
                            {event.type === "stock_in" ? "入库" : event.type === "sold" ? "销售" : "观察记录"}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          {event.type === "record" && editingRecordId === event.id ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="datetime-local"
                                min={minDatetimeForDate(item.inDate)}
                                max={nowForRecord}
                                value={editingRecordTime}
                                onChange={(inputEvent) => setEditingRecordTime(inputEvent.target.value)}
                                className="h-7 w-40 text-xs"
                              />
                              <button type="button" onClick={saveBioRecordTime} className="text-xs text-emerald-600 hover:underline">保存</button>
                              <button type="button" onClick={() => { setEditingRecordId(null); setEditingRecordTime(""); }} className="text-xs text-muted-foreground hover:underline">取消</button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">{formatBioRecordTime(event.date)}</span>
                          )}
                          {event.type === "record" && permission.canUpdate && editingRecordId !== event.id && (
                            <button
                              type="button"
                              onClick={() => startEditBioRecordTime(event.id, event.date)}
                              className="text-xs text-sky-500 hover:text-sky-700"
                              title="修改记录时间"
                            >
                              改时间
                            </button>
                          )}
                          {event.type === "record" && permission.canDelete && (
                            <button type="button" onClick={() => deleteBioRecord(event.id)} className="text-xs text-red-400 hover:text-red-600" title="删除记录">
                              <X className="size-3" />
                            </button>
                          )}
                        </div>
                      </div>
                      {event.type === "stock_in" && <p className="text-xs text-muted-foreground">批次：{event.batchNo}</p>}
                      {event.type === "sold" && <p className="text-xs text-yellow-700">订单：{event.orderNo}</p>}
                      {event.type === "record" && (
                        <>
                          {event.text && <p className="text-foreground">{event.text}</p>}
                          {event.photos.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {event.photos.map((src, photoIndex) => (
                                <div key={photoIndex} className="group relative size-16 cursor-pointer overflow-hidden rounded border">
                                  <ImageWithFallback src={src} alt={`照片${photoIndex + 1}`} className="size-full object-cover" />
                                  <button
                                    type="button"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      try {
                                        await downloadMedia(src, `photo-${photoIndex + 1}.jpg`);
                                      } catch {
                                        toast.error("照片下载失败，请刷新后重试");
                                      }
                                    }}
                                    className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100"
                                    title="下载照片"
                                  >
                                    <Download className="size-4 text-white" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          {event.videos.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {event.videos.map((src, videoIndex) => (
                                <div key={videoIndex} className="group relative overflow-hidden rounded border" style={{ width: "120px" }}>
                                  <MediaVideo src={src} className="w-full" controls />
                                  <button
                                    type="button"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      try {
                                        await downloadMedia(src, `video-${videoIndex + 1}.mp4`);
                                      } catch {
                                        toast.error("视频下载失败，请刷新后重试");
                                      }
                                    }}
                                    className="absolute right-1 top-1 rounded bg-black/60 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                                    title="下载视频"
                                  >
                                    <Download className="size-3.5 text-white" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {permission.canCreate && (
              <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-4">
                <div className="flex items-center gap-2">
                  <Plus className="size-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">添加观察记录</span>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="grid gap-2">
                    <Label className="text-xs">记录时间</Label>
                    <Input
                      type="datetime-local"
                      min={minDatetimeForDate(item.inDate)}
                      max={nowForRecord}
                      value={newRecord.date}
                      onChange={(event) => changeBioRecordDate(event.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label className="text-xs">照片</Label>
                    <input ref={photoRef} type="file" accept="image/*" multiple className="hidden" onChange={(event) => { handlePhotoUpload(event.target.files); event.target.value = ""; }} />
                    <Button type="button" variant="outline" size="sm" onClick={() => photoRef.current?.click()}>
                      <Camera className="size-4" /> 上传照片
                    </Button>
	                  </div>
	                  <div className="grid gap-2">
	                    <Label className="text-xs">视频</Label>
	                    <div className="flex items-center gap-2">
	                      <input ref={videoRef} type="file" accept={ORIGINAL_VIDEO_ACCEPT} multiple className="hidden" onChange={(event) => { handleVideoUpload(event.target.files); event.target.value = ""; }} />
	                      <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => videoRef.current?.click()}>
	                        <Video className="size-4" /> 上传视频
	                      </Button>
	                    </div>
	                  </div>
	                </div>
                {newRecord.photos.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {newRecord.photos.map((src, index) => (
                      <div key={index} className="relative size-14 overflow-hidden rounded border">
                        <ImageWithFallback src={src} alt="" className="size-full object-cover" />
                        <button type="button" onClick={() => setNewRecord((prev) => ({ ...prev, photos: prev.photos.filter((_, idx) => idx !== index) }))} className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">×</button>
                      </div>
                    ))}
                  </div>
                )}
                {newRecord.videos.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {newRecord.videos.map((src, index) => (
                      <div key={index} className="relative size-14 overflow-hidden rounded border">
                        <video src={src} className="size-full object-cover" controls />
                        <button type="button" onClick={() => setNewRecord((prev) => ({ ...prev, videos: prev.videos.filter((_, idx) => idx !== index) }))} className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white">×</button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid gap-2">
                  <Label className="text-xs">记录内容</Label>
                  <Textarea rows={2} placeholder="填写观察内容、用药记录等..." value={newRecord.text} onChange={(event) => setNewRecord((prev) => ({ ...prev, text: event.target.value }))} />
                </div>
                <Button type="button" variant="outline" size="sm" onClick={addBioRecord} className="self-end">
                  <Plus className="size-4" /> 添加此记录
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-muted-foreground">未找到该库存记录</div>
        )}

        <DialogFooter className="shrink-0 border-t pt-2">
          <div className="mr-auto flex items-center gap-2">
            {permission.canUpdate && item && (
              <Button variant="outline" onClick={openMoveDialog}>
                <ArrowRightLeft className="mr-1 size-4" />
                移缸
              </Button>
            )}
            {permission.canDelete && item && (
              <Button
                variant="outline"
                className="border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700"
                onClick={openLossDialog}
              >
                <AlertTriangle className="mr-1 size-4" />
                损耗
              </Button>
            )}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
          {permission.canUpdate && item && <Button onClick={saveBio}>保存状态</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={open && actionMode === "move"} onOpenChange={(nextOpen) => !nextOpen && setActionMode("detail")}>
      <DialogContent aria-describedby={undefined} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>移缸</DialogTitle>
        </DialogHeader>
        {item && (
          <div className="grid gap-4 py-2">
            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
              <div className="font-medium">{product?.name ?? item.productId}</div>
              <div className="mt-1 text-xs text-muted-foreground">当前缸位：{subTankName(item.subTankId)}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>目标缸组<span className="ml-0.5 text-red-500">*</span></Label>
                <Select
                  value={targetGroupId}
                  onValueChange={(value) => {
                    setTargetGroupId(value);
                    setTargetSubTankId("");
                  }}
                >
                  <SelectTrigger><SelectValue placeholder="选择缸组" /></SelectTrigger>
                  <SelectContent>
                    {state.tankGroups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>目标子缸<span className="ml-0.5 text-red-500">*</span></Label>
                <Select
                  value={targetSubTankId}
                  onValueChange={setTargetSubTankId}
                  disabled={!targetGroupId || targetSubTanks.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={targetGroupId ? "选择子缸" : "先选缸组"} />
                  </SelectTrigger>
                  <SelectContent>
                    {targetSubTanks.map((tank) => (
                      <SelectItem key={tank.id} value={tank.id}>{tank.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>移缸备注</Label>
              <Textarea
                rows={2}
                value={moveNotes}
                onChange={(event) => setMoveNotes(event.target.value)}
                placeholder="选填，如隔离、配对、调整密度等"
              />
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setActionMode("detail")} disabled={moveSaving}>取消</Button>
          <Button onClick={submitMove} disabled={moveSaving}>{moveSaving ? "保存中…" : "确认移缸"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={open && actionMode === "loss"} onOpenChange={(nextOpen) => !nextOpen && setActionMode("detail")}>
      <DialogContent aria-describedby={undefined} className="max-w-lg">
        <DialogHeader>
          <DialogTitle>登记损耗</DialogTitle>
        </DialogHeader>
        {item && (
          <div className="grid gap-4 py-2">
            <div className="rounded-lg border border-red-100 bg-red-50/70 p-3 text-sm text-red-800">
              损耗后该鱼会从缸位视图和可售库存中移除，但原始库存记录、损耗凭证和时间轴记录会保留。
            </div>
            {order && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                这条鱼已关联销售订单「{order.orderNo}」。确认损耗后会在订单商品上标记「损耗」，该商品不可发货；需要到订单详情里点击退商品，手动填写退款金额后再完成退款记录。
              </div>
            )}
            <div className="rounded-lg border p-3 text-sm">
              <div className="font-medium">{product?.name ?? item.productId}</div>
              <div className="mt-1 text-xs text-muted-foreground">当前缸位：{subTankName(item.subTankId)}</div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label>损耗日期<span className="ml-0.5 text-red-500">*</span></Label>
                <Input
                  type="date"
                  min={item.inDate}
                  max={today}
                  value={lossDate}
                  onChange={(event) => changeLossDate(event.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>损耗原因</Label>
              <Textarea
                rows={3}
                value={lossReason}
                onChange={(event) => setLossReason(event.target.value)}
                placeholder="选填，如死亡原因、发现时间、处理方式等"
              />
            </div>
            <div className="grid gap-2">
              <Label>照片凭证<span className="ml-0.5 text-red-500">*</span></Label>
              <input
                ref={lossPhotoRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  handleLossProofUpload(event.target.files);
                  event.target.value = "";
                }}
              />
              <div className="flex flex-wrap gap-2">
                {lossProof.map((src, index) => (
                  <div key={index} className="relative size-16 overflow-hidden rounded border">
                    <ImageWithFallback src={src} alt="" className="size-full object-cover" />
                    <button
                      type="button"
                      onClick={() => setLossProof((prev) => prev.filter((_, idx) => idx !== index))}
                      className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-red-500 text-[10px] text-white"
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => lossPhotoRef.current?.click()}
                  className="flex size-16 items-center justify-center rounded border border-dashed text-muted-foreground hover:bg-muted"
                >
                  <Camera className="size-5" />
                </button>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setActionMode("detail")} disabled={lossSaving}>取消</Button>
          <Button variant="destructive" onClick={submitLoss} disabled={lossSaving}>{lossSaving ? "保存中…" : "确认损耗"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

// ─── ItemsWithShipments ───────────────────────────────────────────────────────

function ItemsWithShipments({
  order, orderShipments, shippedItemIds, getProduct, getStockItem, subTankName, onShipmentAction, onReturnItem, canReturnItem,
}: {
  order: Order;
  orderShipments: Shipment[];
  shippedItemIds: Set<string>;
  getProduct: (id: string) => Product | undefined;
  getStockItem: (id: string) => StockItem | undefined;
  subTankName: (id: string) => string;
  onShipmentAction?: (shipment: Shipment) => void;
  onReturnItem?: (item: OrderItem) => void;
  canReturnItem?: boolean;
}) {
  const [detailId, setDetailId] = useState<string | null>(null);

  const renderItemRow = (item: OrderItem, idx: number, options?: { damageRefunded?: boolean }) => {
    const p = getProduct(item.productId);
    const s = getStockItem(item.stockItemId);
    const isLost = !!s?.lost;
    const isUnshipped = !shippedItemIds.has(item.stockItemId);
    const damageRefunded = !!options?.damageRefunded;
    return (
      <tr key={item.stockItemId ?? idx} className={`border-t hover:bg-muted/20 transition-colors cursor-pointer group ${isLost ? "bg-red-50/40" : ""}`}
        onClick={() => setDetailId(item.stockItemId)}>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-2">
            <div className="relative size-8 rounded overflow-hidden border bg-muted shrink-0">
              {p?.imageUrl
                ? <ImageWithFallback src={p.imageUrl} alt="" className="size-full object-cover" />
                : <div className="size-full flex items-center justify-center"><Fish className="size-3 text-muted-foreground" /></div>}
              {isLost && <LostItemOverlay compact />}
            </div>
            <div>
              <div className="text-sm">
                {p?.name ?? "—"}
                {isLost && <span className="ml-2 text-xs text-red-700 bg-red-100 px-1 py-0.5 rounded">已损耗，需退商品</span>}
                {damageRefunded && <span className="ml-2 text-xs text-red-700 bg-red-100 px-1 py-0.5 rounded">报损退款</span>}
              </div>
              {p?.size && <div className="text-xs text-muted-foreground">{p.size}{p.origin ? ` · ${p.origin}` : ""}</div>}
            </div>
          </div>
        </td>
        <td className="px-4 py-2.5 text-sm text-muted-foreground">{s ? subTankName(s.subTankId) : "—"}</td>
        <td className="px-4 py-2.5 text-sm text-right">¥{item.price.toFixed(2)}</td>
        <td className="px-4 py-2.5 text-sm text-right">{normalizeCommissionRate(item.commissionRate).toFixed(2)}%</td>
        <td className="px-4 py-2.5 text-sm text-right text-emerald-700">¥{itemCommissionAmount(item).toFixed(2)}</td>
        <td className="px-3 py-2.5 text-right">
          {isUnshipped && canReturnItem ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={isLost ? "h-7 px-2 text-xs text-red-600 border-red-200 hover:bg-red-50" : "h-7 px-2 text-xs"}
              onClick={(event) => {
                event.stopPropagation();
                onReturnItem?.(item);
              }}
            >
              退
            </Button>
          ) : (
            <span className="text-xs text-sky-600 opacity-0 group-hover:opacity-100 transition-opacity">详情 ›</span>
          )}
        </td>
      </tr>
    );
  };

  const unshippedOrderItems = order.items.filter((i) => !shippedItemIds.has(i.stockItemId));

  const colHeader = (
    <thead>
      <tr className="border-t bg-muted/10">
        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">商品</th>
        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">缸位</th>
        <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">售价</th>
        <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">提成比例</th>
        <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">提成</th>
        <th className="w-12 px-3 py-2" />
      </tr>
    </thead>
  );

  return (
    <>
      {orderShipments.map((sh, si) => {
        const shItems = order.items.filter((i) => (sh.itemStockIds ?? []).includes(i.stockItemId));
        const shipmentHeaderTone = sh.status === "delivered"
          ? "bg-emerald-50/60 text-emerald-800"
          : sh.status === "damaged"
            ? "bg-red-50/60 text-red-800"
            : sh.status === "outbound"
              ? "bg-sky-50/60 text-sky-800"
              : "bg-purple-50/60 text-purple-800";
        return (
          <div key={sh.id}>
            {/* Shipment header */}
            <div className={`px-4 py-2 flex items-center gap-3 text-xs font-medium ${si === 0 ? "border-t" : "border-t"} ${shipmentHeaderTone}`}>
              {sh.shipMethod === "pickup"
                ? <MapPin className="size-3.5 shrink-0" />
                : <Truck className="size-3.5 shrink-0" />}
              <span>
                {sh.status === "outbound" ? "出库单" : "发货单"} {si + 1}：
                {sh.shipMethod === "pickup" ? "上门自取" : `${sh.carrier || "快递"}`}
                {sh.trackingNo ? ` · ${sh.trackingNo}` : ""}
                {" · "}{sh.status === "outbound" ? (sh.outboundDate || sh.shipDate) : sh.shipDate}
              </span>
              <ShipmentStatusBadge
                shipment={sh}
                onClick={(sh.status === "outbound" || (sh.status === "shipped" && sh.shipMethod !== "pickup"))
                  ? () => onShipmentAction?.(sh)
                  : undefined}
              />
            </div>
            <table className="w-full">
              {colHeader}
              <tbody>
                {shItems.map((item, idx) => {
                  const damagedIds = new Set(
                    sh.damageItemStockIds ?? (sh.status === "damaged" && sh.damageResolution === "refund" ? (sh.itemStockIds ?? []) : [])
                  );
                  return renderItemRow(item, idx, { damageRefunded: damagedIds.has(item.stockItemId) });
                })}
                {shItems.length === 0 && (
                  <tr className="border-t"><td colSpan={6} className="px-4 py-3 text-center text-xs text-muted-foreground">—</td></tr>
                )}
              </tbody>
            </table>
          </div>
        );
      })}

      {/* Unshipped items */}
      {unshippedOrderItems.length > 0 && (
        <div>
          <div className="px-4 py-2 flex items-center gap-2 text-xs font-medium border-t bg-amber-50/50 text-amber-800">
            <Plus className="size-3.5 shrink-0 opacity-60" />
            待发货（{unshippedOrderItems.length} 件）
          </div>
          <table className="w-full">
            {colHeader}
            <tbody>
              {unshippedOrderItems.map((item, idx) => renderItemRow(item, idx))}
            </tbody>
          </table>
        </div>
      )}

      {order.items.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-muted-foreground">暂无商品</div>
      )}

      <StockItemDetailDialog
        stockItemId={detailId}
        open={!!detailId}
        onOpenChange={(o) => { if (!o) setDetailId(null); }}
      />
    </>
  );
}

// ─── OrderDetailDialog ────────────────────────────────────────────────────────

type EditForm = {
  customerId: string; date: string; source: string; plannedShipDate: string; contactPerson: string; notes: string;
  shippingFee: number; packagingFee: number; discount: number;
  items: OrderPickerItem[];
};

type ReshipReplacement = {
  originalStockItemId: string;
  replacementStockItemId: string;
};

type DamageResult =
  | { resolution: "refund"; refundAmount: number; damagedItemStockIds: string[]; notes: string; proof: string[] }
  | { resolution: "reship"; notes: string; replacements: ReshipReplacement[] };

function OrderDetailDialog({
  order, open, onOpenChange,
}: { order: Order | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { state, setState, saveStateTransform, saveOrderPaymentChange } = useStore();
  const permission = usePermission("orders");
  const isAdmin = state.user?.role === "admin";
  const today = todayDateString();
  const [addPayOpen, setAddPayOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PaymentRecord | null>(null);
  const [deletingPayment, setDeletingPayment] = useState<PaymentRecord | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shipDialogOpen, setShipDialogOpen] = useState(false);
  const [shipmentAction, setShipmentAction] = useState<Shipment | null>(null);
  const [shipmentConfirmSaving, setShipmentConfirmSaving] = useState(false);
  const [damageShipment, setDamageShipment] = useState<Shipment | null>(null);
  const [returnItem, setReturnItem] = useState<OrderItem | null>(null);
  const personnel = state.personnel ?? [];
  const defaultContactPerson = getDefaultContactPerson(personnel, state.user?.username);
  const editContactOptions = getContactPersonOptions(personnel, editForm?.contactPerson ?? defaultContactPerson);

  useEffect(() => {
    if (!open) {
      setEditMode(false);
      setEditForm(null);
      setShipDialogOpen(false);
      setShipmentAction(null);
      setShipmentConfirmSaving(false);
      setDamageShipment(null);
      setReturnItem(null);
      setAddPayOpen(false);
      setEditingPayment(null);
      setDeletingPayment(null);
    }
  }, [open]);

  const enterEdit = () => {
    if (!order) return;
    if (order.status === "completed") return toast.error("已完成订单不能再编辑");
    setEditForm({
      customerId: order.customerId, date: order.date, plannedShipDate: order.plannedShipDate ?? "",
      source: order.source ?? "",
      contactPerson: order.contactPerson || defaultContactPerson, notes: order.notes ?? "",
      shippingFee: order.shippingFee ?? 0, packagingFee: order.packagingFee ?? 0, discount: order.discount ?? 0,
      items: order.items.map((i) => ({
        stockItemId: i.stockItemId,
        productId: i.productId,
        price: i.price,
        commissionRate: normalizeCommissionRate(i.commissionRate),
      })),
    });
    setEditMode(true);
  };

  const cancelEdit = () => { setEditMode(false); setEditForm(null); };

  const saveEdit = async () => {
    if (!order || !editForm) return;
    if (!permission.requirePermission("update")) return;
    if (order.status === "completed") return toast.error("已完成订单不能再编辑");
    if (editForm.date > today) return toast.error("下单日期不能晚于今天");
    if (!editForm.source.trim()) return toast.error("请选择订单来源");
    if (!editForm.contactPerson.trim()) return toast.error("请选择对接人");
    if (displayAmountDue < 0) return toast.error("折扣过大，应付金额不能为负数");
    if (editForm.items.some((item) => normalizeCommissionRate(item.commissionRate) < 0))
      return toast.error("提成比例不能小于 0");
    if (editForm.plannedShipDate && editForm.plannedShipDate < editForm.date)
      return toast.error("预计发货日期不能早于下单日期");
    if (!confirmWrite("修改", `将保存订单「${order.orderNo}」的修改。`)) return;
    try {
      const result = await postOrderApi("orders/update", {
        orderId: order.id,
        customerId: editForm.customerId,
        date: editForm.date,
        source: editForm.source.trim(),
        plannedShipDate: editForm.plannedShipDate || undefined,
        contactPerson: editForm.contactPerson.trim(),
        notes: editForm.notes,
        shippingFee: editForm.shippingFee,
        packagingFee: editForm.packagingFee,
        discount: editForm.discount,
        items: editForm.items.map((item) => ({ ...item, commissionRate: normalizeCommissionRate(item.commissionRate) })),
        operator: state.user?.username ?? "system",
      });
      applyOrderApiResult(setState, result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
      return;
    }
    setEditMode(false); setEditForm(null);
    toast.success("订单已更新");
  };

  const addPickerItems = (items: OrderPickerItem[]) => {
    if (!editForm) return;
    const existingIds = new Set(editForm.items.map((i) => i.stockItemId));
    setEditForm((f) => f ? {
      ...f,
      items: [
        ...f.items,
        ...items
          .filter((i) => !existingIds.has(i.stockItemId))
          .map((i) => ({ ...i })),
      ],
    } : f);
  };
  const changeEditOrderDate = (newDate: string) => {
    if (newDate && newDate > today) {
      toast.error("下单日期不能晚于今天");
      return;
    }
    setEditForm((f) => {
      if (!f) return f;
      return {
        ...f,
        date: newDate,
        plannedShipDate: f.plannedShipDate && f.plannedShipDate < newDate ? "" : f.plannedShipDate,
        items: f.items,
      };
    });
  };
  const changeEditPlannedShipDate = (newDate: string) => {
    if (editForm?.date && newDate && newDate < editForm.date) {
      toast.error("预计发货日期不能早于下单日期");
      return;
    }
    setEditForm((f) => f ? { ...f, plannedShipDate: newDate } : f);
  };
  const removeEditItem = (id: string) => {
    if (shippedItemIds.has(id)) return toast.error("该商品已在出库/发货单中，无法从订单移除");
    const existingOrderItem = order?.items.find((item) => item.stockItemId === id);
    if (existingOrderItem) {
      setEditMode(false);
      setEditForm(null);
      setReturnItem(existingOrderItem);
      return;
    }
    setEditForm((f) => f ? { ...f, items: f.items.filter((i) => i.stockItemId !== id) } : f);
  };
  const setEditItemPrice = (id: string, price: number) =>
    setEditForm((f) => f ? { ...f, items: f.items.map((i) => i.stockItemId === id ? { ...i, price } : i) } : f);
  const setEditItemCommissionRate = (id: string, commissionRate: number) =>
    setEditForm((f) => f ? { ...f, items: f.items.map((i) => i.stockItemId === id ? { ...i, commissionRate: normalizeCommissionRate(commissionRate) } : i) } : f);

  const excludePickerIds = useMemo(() => new Set((editForm?.items ?? []).map((i) => i.stockItemId)), [editForm]);

  const getProduct = (id: string) => state.products.find((p) => p.id === id);
  const subTankName = (id: string) => {
    for (const g of state.tankGroups) {
      const t = g.subTanks.find((x) => x.id === id);
      if (t) return `${g.name} / ${t.name}`;
    }
    return "—";
  };

  const customer = (state.customers ?? []).find(
    (c) => c.id === (editMode && editForm ? editForm.customerId : order?.customerId)
  );

  const displayItems = editMode && editForm ? editForm.items : (order?.items ?? []);
  const displayItemsTotal = displayItems.reduce((s, i) => s + i.price, 0);
  const displayCommissionTotal = displayItems.reduce((s, i) => s + itemCommissionAmount(i), 0);
  const displayShipping  = (editMode && editForm ? editForm.shippingFee  : order?.shippingFee)  ?? 0;
  const displayPackaging = (editMode && editForm ? editForm.packagingFee : order?.packagingFee) ?? 0;
  const displayDiscount  = (editMode && editForm ? editForm.discount     : order?.discount)     ?? 0;
  const draftAmountDue = displayItemsTotal + displayShipping + displayPackaging - displayDiscount;

  const orderShipments = state.shipments.filter((s) => s.orderId === order?.id);
  const damageRefundOrder = !!order && isDamageRefundOrder(order, state.shipments);
  const amountDue = order ? calcAmountDue(order, state.shipments) : 0;
  const amountPaid = order ? calcAmountPaid(order) : 0;
  const amountReceived = order ? calcAmountReceived(order) : 0;
  const amountRefunded = order ? calcAmountRefunded(order) : 0;
  const damageRefundAdjustment = order ? calcDamageRefundAdjustment(order, state.shipments) : 0;
  const financialState = order ? getOrderFinancialState(order, state.shipments) : { kind: "paid" as const, amount: 0 };
  const isFinancialSettled = financialState.kind === "paid";
  const balance = amountDue - amountPaid;
  const billableShipping = order ? getBillableShippingFee(order, state.shipments) : displayShipping;
  const hasActualShipping = order ? hasActualShippingFee(order, state.shipments) : false;
  const shippingAdjustment = order ? calcShippingAdjustment(order, state.shipments) : 0;
  const displayAmountDue = editMode && editForm ? draftAmountDue : amountDue;
  const displayOriginalAmountDue = damageRefundOrder ? displayAmountDue + damageRefundAdjustment : displayAmountDue;

  const activeOrderShipments = orderShipments.filter(countsAsActiveShipment);
  const shippedItemIds = new Set(activeOrderShipments.flatMap((s) => s.itemStockIds ?? []));
  const unshippedItems = (order?.items ?? []).filter((i) => !shippedItemIds.has(i.stockItemId));
  const lostUnshippedItems = unshippedItems.filter((i) => state.stock.find((s) => s.id === i.stockItemId)?.lost);
  const shippableUnshippedItems = unshippedItems.filter((i) => !state.stock.find((s) => s.id === i.stockItemId)?.lost);
  const allItemsShipped = (order?.items ?? []).length > 0 && unshippedItems.length === 0;
  const allShipmentsResolved = activeOrderShipments.length > 0 && activeOrderShipments.every((s) =>
    s.status === "delivered" || (s.status === "damaged" && s.damageResolution === "refund")
  );
  const canCompleteOrder = !!order &&
    order.status !== "cancelled" &&
    order.status !== "completed" &&
    allItemsShipped &&
    allShipmentsResolved &&
    isFinancialSettled;
  const canShip = !!order && shippableUnshippedItems.length > 0 && isFinancialSettled
    && order.status !== "cancelled" && order.status !== "completed";
  const canReturnOrderItem = !!order && order.status !== "cancelled" && order.status !== "completed" && permission.canUpdate;
  const returnStock = returnItem ? state.stock.find((stock) => stock.id === returnItem.stockItemId) : undefined;
  const returnProduct = returnItem ? getProduct(returnItem.productId) : undefined;
  const maxReturnRefund = order ? Math.max(calcAmountPaid(order), 0) : 0;

  const openReturnItem = (item: OrderItem) => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (order.status === "completed") return toast.error("已完成订单不能退商品");
    if (order.status === "cancelled") return toast.error("已取消订单不能退商品");
    if (shippedItemIds.has(item.stockItemId)) return toast.error("该商品已出库或已发货，不能按未发货商品退款");
    setReturnItem(item);
  };

  const addPayment = async (record: PaymentRecord) => {
    if (!order) return false;
    if (!permission.requirePermission("create")) return false;
    if (order.status === "completed") { toast.error("已完成订单不能再编辑资金记录"); return false; }
    if (order.status === "cancelled") { toast.error("已取消订单不能再编辑资金记录"); return false; }
    if (!confirmWrite("新增", "将新增一条资金往来记录。")) return false;
    const ok = await saveOrderPaymentChange({ orderId: order.id, action: "add", payment: record });
    if (!ok) { toast.error("保存失败，请重试"); return false; }
    toast.success("记录已添加");
    return true;
  };

  const openAddPayment = () => {
    if (!permission.requirePermission("create")) return;
    if (order?.status === "completed") return toast.error("已完成订单不能再编辑资金记录");
    if (order?.status === "cancelled") return toast.error("已取消订单不能再编辑资金记录");
    setEditingPayment(null);
    setAddPayOpen(true);
  };

  const openEditPayment = (record: PaymentRecord) => {
    if (!permission.requirePermission("update")) return;
    if (order?.status === "completed") return toast.error("已完成订单不能再编辑资金记录");
    setEditingPayment(record);
    setAddPayOpen(true);
  };

  const updatePayment = async (record: PaymentRecord) => {
    if (!order) return false;
    if (!permission.requirePermission("update")) return false;
    if (order.status === "completed") { toast.error("已完成订单不能再编辑资金记录"); return false; }
    if (order.status === "cancelled") { toast.error("已取消订单不能再编辑资金记录"); return false; }
    if (!confirmWrite("修改", "将保存资金往来记录的修改。")) return false;
    const ok = await saveOrderPaymentChange({ orderId: order.id, action: "update", payment: record });
    if (!ok) { toast.error("保存失败，请重试"); return false; }
    toast.success("资金记录已更新");
    return true;
  };

  const openDeletePayment = (record: PaymentRecord) => {
    if (!permission.requirePermission("delete")) return;
    if (order?.status === "completed") return toast.error("已完成订单不能再编辑资金记录");
    if (order?.status === "cancelled") return toast.error("已取消订单不能再编辑资金记录");
    setDeletingPayment(record);
  };

  const deletePayment = async () => {
    if (!order || !deletingPayment) return;
    if (!permission.requirePermission("delete")) return;
    if (order.status === "completed") return toast.error("已完成订单不能再编辑资金记录");
    if (order.status === "cancelled") return toast.error("已取消订单不能再编辑资金记录");
    if (!confirmWrite("删除", "将删除这条资金往来记录。")) return;
    const deletePaymentId = deletingPayment.id;
    const ok = await saveOrderPaymentChange({ orderId: order.id, action: "delete", paymentId: deletePaymentId });
    if (!ok) return toast.error("删除失败，请重试");
    setDeletingPayment(null);
    toast.success("资金记录已删除");
  };

  const submitReturnItem = async (refund: PaymentRecord | null) => {
    if (!order || !returnItem) return false;
    if (!permission.requirePermission("update")) return false;
    if (order.status === "completed") { toast.error("已完成订单不能退商品"); return false; }
    if (order.status === "cancelled") { toast.error("已取消订单不能退商品"); return false; }
    if (shippedItemIds.has(returnItem.stockItemId)) { toast.error("该商品已出库或已发货，不能按未发货商品退款"); return false; }
    if (!confirmWrite("退款", refund ? `将退商品并记录退款 ¥${refund.amount.toFixed(2)}。` : "将退商品并调整应收金额。")) return false;
    const returnStockItemId = returnItem.stockItemId;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      orders: latest.orders.map((o) =>
        o.id === order.id
          ? {
              ...o,
              items: o.items.filter((item) => item.stockItemId !== returnStockItemId),
              payments: refund ? [...(o.payments ?? []), refund] : (o.payments ?? []),
            }
          : o
      ),
      stock: latest.stock.map((stock) =>
        stock.id === returnStockItemId ? { ...stock, sold: false } : stock
      ),
    }));
    if (!ok) { toast.error("保存失败，请重试"); return false; }
    setReturnItem(null);
    toast.success(refund ? `已退商品并记录退款 ¥${refund.amount.toFixed(2)}` : "已退商品，应收金额已更新");
    return true;
  };

  const completeOrder = async () => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (!isFinancialSettled) {
      const action = financialState.kind === "refundable" ? "退款" : "收款";
      return toast.error(`${action}未结清（差额 ¥${financialState.amount.toFixed(2)}），请先完成${action}`);
    }
    if (!allItemsShipped)
      return toast.error("尚有商品未发货，请先完成所有发货再确认完成");
    if (!allShipmentsResolved)
      return toast.error("尚有发货未签收或报损未完成处理，请先处理完发货状态");
    if (!confirmWrite("完成", `将订单「${order.orderNo}」标记为已完成，完成后不可再编辑。`)) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      orders: latest.orders.map((o) => o.id === order.id ? { ...o, status: "completed" } : o),
    }));
    if (!ok) return toast.error("保存失败，请重试");
    toast.success("订单已完成");
  };

  const markShipmentDelivered = async (shipment: Shipment) => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (!confirmWrite("修改", "将该发货单状态改为已签收。")) return;
    const ok = await saveStateTransform((latest) => {
      const shipments = latest.shipments.map((sh) =>
        sh.id === shipment.id ? { ...sh, status: "delivered" as const } : sh
      );
      const relatedShipments = shipments.filter((sh) => sh.orderId === order.id && countsAsActiveShipment(sh));
      const shippedIds = new Set(relatedShipments.flatMap((sh) => sh.itemStockIds ?? []));
      const nextAllItemsShipped = order.items.length > 0 && order.items.every((i) => shippedIds.has(i.stockItemId));
      return {
        ...latest,
        shipments,
        orders: latest.orders.map((o) =>
          o.id === order.id
            ? { ...o, status: o.status === "damaged" ? "damaged" : nextAllItemsShipped ? "shipped" : o.status }
            : o
        ),
      };
    });
    if (!ok) return toast.error("保存失败，请重试");
    setShipmentAction(null);
    toast.success("已确认收货");
  };

  const confirmOutboundShipment = async (shipment: Shipment, packingProof: string[]) => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (shipmentConfirmSaving) return;
    if (order.status === "completed") return toast.error("已完成订单不能再确认发货");
    if (shipment.status !== "outbound") return toast.error("只有已出库的商品可以确认发货");
    if (packingProof.length < 2) return toast.error("请至少上传 2 张打包凭证");
    if (!confirmWrite("发货", "将保存打包凭证，并把该出库单改为已发货。")) return;
    setShipmentConfirmSaving(true);
    try {
      const result = await postOrderApi("shipments/confirm", {
        shipmentId: shipment.id,
        packingProof,
      });
      applyOrderApiResult(setState, result);
      setShipmentAction(null);
      toast.success(shipment.shipMethod === "pickup" ? "已上传凭证并确认自取完成" : "已上传凭证并确认发货");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setShipmentConfirmSaving(false);
    }
  };

  const cancelShipment = async (shipment: Shipment) => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (order.status === "completed") return toast.error("已完成订单不能取消发货");
    if (shipment.status !== "outbound" && shipment.status !== "shipped") return toast.error("只有已出库或运输中的发货单可以取消");
    if (!confirmWrite("取消发货", "将取消这条出库/发货记录，商品会回到待发货状态；订单和商品不会被删除。")) return;
    const ok = await saveStateTransform((latest) => {
      const shipments = latest.shipments.filter((sh) => sh.id !== shipment.id);
      const remainingActiveShipments = shipments.filter((sh) => sh.orderId === order.id && countsAsActiveShipment(sh));
      return {
        ...latest,
        shipments,
        orders: latest.orders.map((o) => {
          if (o.id !== order.id) return o;
          if (o.status === "completed" || o.status === "cancelled" || o.status === "damaged") return o;
          return { ...o, status: remainingActiveShipments.length > 0 ? "shipped" as const : "pending" as const };
        }),
      };
    });
    if (!ok) return toast.error("保存失败，请重试");
    setShipmentAction(null);
    toast.success("已取消出库/发货，商品已回到待发货状态");
  };

  const reportShipmentDamage = async (shipment: Shipment, result: DamageResult) => {
    if (!order) return false;
    if (!permission.requirePermission("update")) return false;
    if (shipment.shipMethod === "pickup") { toast.error("上门自取订单不可报损"); return false; }
    if (!confirmWrite("修改", result.resolution === "refund" ? "将发货单报损并计入待退款金额，实际退款需手动录入资金往来。" : "将发货单报损并选择库存鱼补发。")) return false;
    const ok = await saveStateTransform((latest) => {
      const replacementMap = result.resolution === "reship"
        ? new Map(result.replacements.map((item) => [item.originalStockItemId, item.replacementStockItemId]))
        : new Map<string, string>();
      const shipments = latest.shipments.map((sh) =>
        sh.id === shipment.id
          ? {
              ...sh,
              status: "damaged" as const,
              damageResolution: result.resolution,
              damageItemStockIds: result.resolution === "refund" ? result.damagedItemStockIds : sh.damageItemStockIds,
              damageRefundAmount: result.resolution === "refund" ? result.refundAmount : sh.damageRefundAmount,
              damageProof: result.resolution === "refund" ? result.proof : sh.damageProof,
              notes: result.notes || sh.notes,
            }
          : sh
      );
      return {
        ...latest,
        shipments,
        stock: result.resolution === "reship"
          ? latest.stock.map((stock) =>
              result.replacements.some((item) => item.replacementStockItemId === stock.id)
                ? { ...stock, sold: true }
                : stock
            )
          : latest.stock,
        orders: latest.orders.map((o) =>
          o.id === order.id
            ? result.resolution === "refund"
              ? { ...o, status: "damaged" as const }
              : {
                  ...o,
                  status: "shipped" as const,
                  items: o.items.map((item) => {
                    const replacementStockItemId = replacementMap.get(item.stockItemId);
                    if (!replacementStockItemId) return item;
                    const replacementStock = latest.stock.find((stock) => stock.id === replacementStockItemId);
                    return {
                      ...item,
                      stockItemId: replacementStockItemId,
                      productId: replacementStock?.productId ?? item.productId,
                    };
                  }),
                }
            : o
        ),
      };
    });
    if (!ok) { toast.error("保存失败，请重试"); return false; }
    setShipmentAction(null);
    setDamageShipment(null);
    toast.success(result.resolution === "refund" ? "已报损，待退款金额已计入订单" : "已报损，已选择库存鱼进入待发货");
    return true;
  };

  const handleShipFromDetail = async (data: ShipFormData) => {
    if (!order) return false;
    if (!permission.requirePermission("update")) return false;
    const lostSelected = data.selectedItemIds.filter((id) => state.stock.find((stock) => stock.id === id)?.lost);
    if (lostSelected.length > 0) { toast.error("已损耗商品不能出库，请先从订单中删除"); return false; }
    const confirmDetail = data.shipMethod === "pickup"
      ? `将确认 ${data.selectedItemIds.length} 条商品上门自取并直接签收。`
      : `将出库 ${data.selectedItemIds.length} 条商品，后续需上传打包凭证再确认发货。`;
    if (!confirmWrite("出库", confirmDetail)) return false;
    try {
      const result = await postOrderApi("shipments/outbound", {
        orderId: order.id,
        shipDate: data.shipDate,
        shipMethod: data.shipMethod,
        carrier: data.carrier,
        actualShippingFee: data.shipMethod === "pickup" ? 0 : data.actualShippingFee,
        notes: data.notes,
        selectedItemIds: data.selectedItemIds,
        operator: state.user?.username ?? "system",
      });
      applyOrderApiResult(setState, result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
      return false;
    }
    setShipDialogOpen(false);
    const actualShippingFee = data.shipMethod === "pickup" ? 0 : data.actualShippingFee;
    const feeDiff = actualShippingFee - (order.shippingFee ?? 0);
    if (data.shipMethod === "pickup") {
      toast.success("已确认上门自取签收");
    } else if (Math.abs(feeDiff) > 0.005) {
      if (feeDiff > 0)
        toast.success(`已出库 — 实际运费多 ¥${feeDiff.toFixed(2)}，已计入应收账款`);
      else
        toast.success(`已出库 — 实际运费少 ¥${Math.abs(feeDiff).toFixed(2)}，已计入应收账款`);
    } else {
      toast.success("已出库，请上传打包凭证后确认发货");
    }
    return true;
  };



  if (!order) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o && editMode) cancelEdit(); onOpenChange(o); }}>
        <DialogContent
          aria-describedby={undefined}
          className="max-w-none sm:max-w-none flex flex-col p-8"
          style={{ width: "min(92vw, 1080px)", maxWidth: "min(92vw, 1080px)", height: "90vh" }}
        >
          <DialogHeader>
            <div className="flex items-center gap-3 flex-wrap">
              <DialogTitle>{order.orderNo}</DialogTitle>
              <OrderStatusTags order={order} shipments={state.shipments} />
              {editMode && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">编辑中</span>}
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto flex flex-col gap-5 pr-1">

            {/* ── 基本信息 ── */}
            {editMode && editForm ? (
              <div className="rounded-lg border p-4 grid grid-cols-5 gap-3 bg-amber-50/50">
                <div className="grid gap-1.5">
                  <Label className="text-xs">客户</Label>
                  <CustomerCombobox value={editForm.customerId}
                    onChange={(id) => setEditForm((f) => f ? { ...f, customerId: id } : f)}
                    customers={state.customers ?? []} />
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">订单来源<span className="text-red-500 ml-0.5">*</span></Label>
                  <Select
                    value={editForm.source}
                    onValueChange={(value) => setEditForm((f) => f ? { ...f, source: value } : f)}
                  >
                    <SelectTrigger className={!editForm.source.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}>
                      <SelectValue placeholder="请选择来源" />
                    </SelectTrigger>
                    <SelectContent>
                      {ORDER_SOURCE_OPTIONS.map((source) => (
                        <SelectItem key={source} value={source}>{source}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">下单日期</Label>
                  <Input type="date" value={editForm.date}
                    max={today}
                    className={editForm.date > today ? "border-red-500 focus-visible:ring-red-500" : ""}
                    onChange={(e) => changeEditOrderDate(e.target.value)} />
                  {editForm.date > today && (
                    <p className="text-xs text-red-500">下单日期不能晚于今天</p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">预计发货日期</Label>
                  <Input
                    type="date"
                    value={editForm.plannedShipDate}
                    min={editForm.date}
                    onChange={(e) => changeEditPlannedShipDate(e.target.value)}
                    className={editForm.plannedShipDate && editForm.plannedShipDate < editForm.date ? "border-red-500 focus-visible:ring-red-500" : ""}
                  />
                  {editForm.plannedShipDate && editForm.plannedShipDate < editForm.date && (
                    <p className="text-xs text-red-500">发货日期不能早于下单日期</p>
                  )}
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">对接人<span className="text-red-500 ml-0.5">*</span></Label>
                  <Select
                    value={editForm.contactPerson}
                    onValueChange={(value) => setEditForm((f) => f ? { ...f, contactPerson: value } : f)}
                  >
                    <SelectTrigger className={!editForm.contactPerson.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}>
                      <SelectValue placeholder="请选择对接人" />
                    </SelectTrigger>
                    <SelectContent>
                      {editContactOptions.map((person) => (
                        <SelectItem key={person.id} value={person.name}>
                          {person.name}{person.role ? ` · ${person.role}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">创建时间</Label>
                  <div className="h-10 flex items-center rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
                    {formatOrderCreatedAt(order.createdAt)}
                  </div>
                </div>
                <div className="grid gap-1.5 col-span-4">
                  <Label className="text-xs">备注</Label>
                  <Input value={editForm.notes} placeholder="选填"
                    onChange={(e) => setEditForm((f) => f ? { ...f, notes: e.target.value } : f)} />
                </div>
              </div>
            ) : (
              <div className="rounded-lg border p-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm bg-muted/30">
                <div><span className="text-muted-foreground">客户：</span><span className="font-medium">{customer?.name ?? "—"}</span></div>
                <div><span className="text-muted-foreground">手机：</span>{customer?.phone || "—"}</div>
                <div><span className="text-muted-foreground">微信：</span>{customer?.wechat || "—"}</div>
                <div><span className="text-muted-foreground">客户来源：</span>{customer?.source || "—"}</div>
                <div><span className="text-muted-foreground">订单来源：</span>{order.source || "—"}</div>
                <div><span className="text-muted-foreground">创建时间：</span>{formatOrderCreatedAt(order.createdAt)}</div>
                <div><span className="text-muted-foreground">下单日期：</span>{order.date}</div>
                {order.status !== "completed" && (
                  <div>
                    <span className="text-muted-foreground">预计发货：</span>
                    {order.plannedShipDate
                      ? <span className={order.plannedShipDate === today ? "text-orange-600 font-medium" : ""}>{order.plannedShipDate}</span>
                      : "—"}
                  </div>
                )}
                <div><span className="text-muted-foreground">对接人：</span>{order.contactPerson || "—"}</div>
                {customer?.address && <div className="col-span-2"><span className="text-muted-foreground">地址：</span>{customer.address}</div>}
                {order.notes && <div className="col-span-2"><span className="text-muted-foreground">备注：</span>{order.notes}</div>}
              </div>
            )}

            {/* ── Items table ── */}
            <div className="rounded-lg border flex flex-col">
              <div className="px-4 py-2 bg-muted/50 text-xs font-medium text-muted-foreground flex items-center justify-between shrink-0 border-b rounded-t-lg">
                <span>订单商品（{displayItems.length} 条）</span>
                {editMode && editForm && (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-emerald-600">小计 ¥{displayItemsTotal.toFixed(2)}</span>
                    <span className="text-emerald-700">提成 ¥{displayCommissionTotal.toFixed(2)}</span>
                  </div>
                )}
              </div>

              {editMode ? (
                /* Edit mode: flat table, shipped items shown with lock icon */
                <>
                  <div className="overflow-y-auto" style={{ maxHeight: "22rem" }}>
                    <table className="w-full">
                      <thead className="sticky top-0 z-10 bg-white">
                        <tr className="border-b">
                          <th className="text-left px-4 py-2 text-xs text-muted-foreground">商品</th>
                          <th className="text-left px-4 py-2 text-xs text-muted-foreground">缸位</th>
                          <th className="text-right px-4 py-2 text-xs text-muted-foreground">售价</th>
                          <th className="text-right px-4 py-2 text-xs text-muted-foreground">提成比例</th>
                          <th className="text-right px-4 py-2 text-xs text-muted-foreground">提成</th>
                          <th className="w-10 px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {displayItems.map((item, idx) => {
                          const p = getProduct(item.productId);
                          const s = state.stock.find((x) => x.id === item.stockItemId);
                          const isShipped = shippedItemIds.has(item.stockItemId);
                          const isLost = !!s?.lost;
                          const commissionRate = normalizeCommissionRate(item.commissionRate);
                          return (
                            <tr key={item.stockItemId ?? idx} className={`border-t ${isShipped ? "bg-purple-50/30" : isLost ? "bg-red-50/40" : ""}`}>
                              <td className="px-4 py-2">
                                <div className="flex items-center gap-2">
                                  <div className="relative size-8 rounded overflow-hidden border bg-muted shrink-0">
                                    {p?.imageUrl
                                      ? <ImageWithFallback src={p.imageUrl} alt="" className="size-full object-cover" />
                                      : <div className="size-full flex items-center justify-center"><Fish className="size-3 text-muted-foreground" /></div>}
                                    {isLost && <LostItemOverlay compact />}
                                  </div>
                                  <div>
                                    <span className="text-sm">{p?.name ?? "—"}</span>
                                    {isShipped && <span className="ml-2 text-xs text-purple-600 bg-purple-100 px-1 py-0.5 rounded">已出库/发货</span>}
                                    {isLost && <span className="ml-2 text-xs text-red-700 bg-red-100 px-1 py-0.5 rounded">已损耗，需退商品</span>}
                                  </div>
                                </div>
                              </td>
                              <td className="px-4 py-2 text-sm text-muted-foreground">{s ? subTankName(s.subTankId) : "—"}</td>
                              <td className="px-4 py-2 text-sm text-right">
                                <Input type="number" min={0} value={item.price}
                                  onChange={(e) => setEditItemPrice(item.stockItemId, Number(e.target.value))}
                                  disabled={isLost}
                                  className="h-7 w-24 text-sm text-right ml-auto" />
                              </td>
                              <td className="px-4 py-2 text-sm text-right">
                                <Input
                                  type="number"
                                  min={0}
                                  step={0.01}
                                  value={commissionRate}
                                  onChange={(e) => setEditItemCommissionRate(item.stockItemId, Number(e.target.value))}
                                  disabled={isLost || !isAdmin}
                                  className="h-7 w-24 text-sm text-right ml-auto"
                                />
                              </td>
                              <td className="px-4 py-2 text-sm text-right text-emerald-700">
                                ¥{itemCommissionAmount(item).toFixed(2)}
                              </td>
	                              <td className="px-2 py-2">
	                                {!isShipped && (
	                                  <button onClick={() => removeEditItem(item.stockItemId)}
	                                    className="text-muted-foreground hover:text-red-500 transition-colors" title={order.items.some((orderItem) => orderItem.stockItemId === item.stockItemId) ? "退商品" : "移除"}>
	                                    <X className="size-4" />
	                                  </button>
	                                )}
                              </td>
                            </tr>
                          );
                        })}
                        {displayItems.length === 0 && (
                          <tr className="border-t">
                            <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">暂无商品</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-4 py-2.5 border-t bg-muted/10 shrink-0 rounded-b-lg">
                    <button onClick={() => setPickerOpen(true)}
                      className="flex items-center gap-1.5 text-sm text-sky-600 hover:text-sky-700 font-medium">
                      <Plus className="size-4" /> 添加商品
                    </button>
                  </div>
                </>
              ) : (
                /* View mode: items grouped by shipment */
                <div className="overflow-y-auto rounded-b-lg" style={{ maxHeight: "28rem" }}>
                  <ItemsWithShipments
                    order={order}
                    orderShipments={orderShipments}
                    shippedItemIds={shippedItemIds}
                    getProduct={getProduct}
                    getStockItem={(id) => state.stock.find((x) => x.id === id)}
                    subTankName={subTankName}
                    onShipmentAction={setShipmentAction}
                    onReturnItem={openReturnItem}
                    canReturnItem={canReturnOrderItem}
                  />
                </div>
              )}
            </div>

            {/* ── 费用 ── */}
            {editMode && editForm ? (
              <div className="rounded-lg border p-4 bg-amber-50/50">
                <div className="text-xs font-medium text-muted-foreground mb-3">费用设置</div>
                <div className="grid grid-cols-3 gap-3 mb-4">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">预收运费（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={editForm.shippingFee || ""} placeholder="0" className="h-8 text-sm"
                      onChange={(e) => setEditForm((f) => f ? { ...f, shippingFee: Number(e.target.value) } : f)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">包装费（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={editForm.packagingFee || ""} placeholder="0" className="h-8 text-sm"
                      onChange={(e) => setEditForm((f) => f ? { ...f, packagingFee: Number(e.target.value) } : f)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">折扣/优��（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={editForm.discount || ""} placeholder="0"
                      className={`h-8 text-sm${displayAmountDue < 0 ? " border-red-500 focus-visible:ring-red-500" : ""}`}
                      onChange={(e) => setEditForm((f) => f ? { ...f, discount: Number(e.target.value) } : f)} />
                    {displayAmountDue < 0 && <p className="text-xs text-red-500">折扣超出应付金额 ¥{Math.abs(displayAmountDue).toFixed(2)}</p>}
                  </div>
                </div>
                <div className="border-t pt-3 flex flex-col gap-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">商品小计</span><span>¥{displayItemsTotal.toFixed(2)}</span></div>
                  <div className="flex justify-between text-emerald-700"><span>销售提成</span><span>¥{displayCommissionTotal.toFixed(2)}</span></div>
                  {displayShipping > 0 && <div className="flex justify-between"><span className="text-muted-foreground">+ 运费</span><span>¥{displayShipping.toFixed(2)}</span></div>}
                  {displayPackaging > 0 && <div className="flex justify-between"><span className="text-muted-foreground">+ 包装费</span><span>¥{displayPackaging.toFixed(2)}</span></div>}
                  {displayDiscount > 0 && <div className="flex justify-between text-orange-600"><span>− 折扣</span><span>¥{displayDiscount.toFixed(2)}</span></div>}
                  <div className="flex justify-between font-semibold text-base border-t pt-2 mt-1">
                    <span>应付总额</span>
                    <span className={displayAmountDue < 0 ? "text-red-600" : "text-sky-700"}>¥{displayAmountDue.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border p-4 flex flex-col gap-2 text-sm">
                <div className="text-xs font-medium text-muted-foreground mb-1">费用明细</div>
                <div className="flex justify-between"><span className="text-muted-foreground">商品小计</span><span>¥{displayItemsTotal.toFixed(2)}</span></div>
                <div className="flex justify-between text-emerald-700"><span>销售提成</span><span>¥{displayCommissionTotal.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">预收运费</span><span>¥{displayShipping.toFixed(2)}</span></div>
                {hasActualShipping && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">实际运费</span>
                    <span>¥{billableShipping.toFixed(2)}</span>
                  </div>
                )}
                {Math.abs(shippingAdjustment) > 0.005 && (
                  <div className={`flex justify-between ${shippingAdjustment > 0 ? "text-orange-600" : "text-emerald-600"}`}>
                    <span>{shippingAdjustment > 0 ? "运费补收" : "运费应退"}</span>
                    <span>{shippingAdjustment > 0 ? "+" : "−"}¥{Math.abs(shippingAdjustment).toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between"><span className="text-muted-foreground">包装费</span><span>¥{displayPackaging.toFixed(2)}</span></div>
                {displayDiscount > 0 && <div className="flex justify-between text-orange-600"><span>折扣 / 优惠</span><span>− ¥{displayDiscount.toFixed(2)}</span></div>}
                {damageRefundOrder && damageRefundAdjustment > 0.005 && (
                  <div className="flex justify-between text-red-600">
                    <span>报损退款调整</span>
                    <span>− ¥{damageRefundAdjustment.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-2 font-semibold text-base">
                  <span>{damageRefundOrder ? "调整后应付" : "应付总额"}</span><span className="text-sky-700">¥{displayAmountDue.toFixed(2)}</span>
                </div>
              </div>
            )}

            {/* ── 收付款（只读模式显示）── */}
            {!editMode && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-lg border p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-1">{damageRefundOrder ? "原应付" : "应付"}</div>
                    <div className="text-lg font-semibold">¥{displayOriginalAmountDue.toFixed(2)}</div>
                  </div>
                  <div className="rounded-lg border p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-1">{damageRefundOrder ? "已收" : "已付"}</div>
                    <div className="text-lg font-semibold text-emerald-600">¥{(damageRefundOrder ? amountReceived : amountPaid).toFixed(2)}</div>
                  </div>
                  {damageRefundOrder ? (
                    <div className={`rounded-lg border p-3 text-center ${
                      financialState.kind === "refundable"
                        ? "border-red-200 bg-red-50"
                        : financialState.kind === "payable"
                          ? "border-orange-200 bg-orange-50"
                          : "border-emerald-200 bg-emerald-50"
                    }`}>
                      <div className="text-xs text-muted-foreground mb-1">
                        {financialState.kind === "refundable" ? "待退款" : financialState.kind === "payable" ? "待付款" : "已结清"}
                      </div>
                      <div className={`text-lg font-semibold ${
                        financialState.kind === "refundable"
                          ? "text-red-600"
                          : financialState.kind === "payable"
                            ? "text-orange-600"
                            : "text-emerald-600"
                      }`}>
                        {financialState.kind === "paid" ? "✓" : `¥${financialState.amount.toFixed(2)}`}
                      </div>
                    </div>
                  ) : (
                    <div className={`rounded-lg border p-3 text-center ${
                      balance > 0.005 ? "border-orange-200 bg-orange-50" : balance < -0.005 ? "border-emerald-200 bg-emerald-50" : ""
                    }`}>
                      <div className="text-xs text-muted-foreground mb-1">
                        {balance > 0.005 ? "待付" : balance < -0.005 ? "多付" : "已结清"}
                      </div>
                      <div className={`text-lg font-semibold ${
                        balance > 0.005 ? "text-orange-600" : balance < -0.005 ? "text-emerald-600" : "text-muted-foreground"
                      }`}>
                        {Math.abs(balance) < 0.005 ? "✓" : `${balance < 0 ? "−" : ""}¥${Math.abs(balance).toFixed(2)}`}
                      </div>
                    </div>
                  )}
                </div>
                <div className="rounded-lg border p-4">
                  <div className="text-xs font-medium text-muted-foreground mb-4">资金往来记录</div>
		                  <PaymentTimeline
		                    payments={order.payments ?? []}
		                    onAdd={openAddPayment}
		                    onEdit={openEditPayment}
		                    onDelete={openDeletePayment}
		                    canAdd={order.status !== "cancelled" && order.status !== "completed" && permission.canCreate}
		                    canEdit={order.status !== "cancelled" && order.status !== "completed" && permission.canUpdate}
		                    canDelete={order.status !== "cancelled" && order.status !== "completed" && permission.canDelete}
		                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter className="flex-wrap gap-2 pt-2 border-t">
            {editMode ? (
              <>
                <Button variant="ghost" onClick={cancelEdit}>取消编辑</Button>
                <div className="flex-1" />
                <Button onClick={saveEdit}><Check className="size-4 mr-1" />保存修改</Button>
              </>
            ) : (
	              <>
			                {permission.canUpdate && order.status !== "cancelled" && order.status !== "completed" && order.status !== "damaged" && (
			                  <Button size="sm" variant="outline" className="text-amber-600 border-amber-300 hover:bg-amber-50" onClick={enterEdit}>
	                    编辑订单
                  </Button>
                )}
	                {permission.canUpdate && unshippedItems.length > 0 && order.status !== "cancelled" && order.status !== "completed" && (
                  <div className="flex flex-col items-end gap-1">
	                    {lostUnshippedItems.length > 0 && (
	                      <p className="text-xs text-red-600">
	                        {lostUnshippedItems.length} 件已损耗，不能出库，请在商品行点击退
	                      </p>
	                    )}
                    {!isFinancialSettled && (
                      <p className={financialState.kind === "refundable" ? "text-xs text-red-500" : "text-xs text-orange-500"}>
                        {financialState.kind === "refundable" ? "处理完待退款后方可出库" : "付清货款后方可出库"}
                      </p>
                    )}
                    {shippableUnshippedItems.length === 0 && lostUnshippedItems.length > 0 && (
                      <p className="text-xs text-muted-foreground">无可出库商品</p>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className={canShip ? "text-sky-600 border-sky-300 hover:bg-sky-50" : "text-muted-foreground border-muted"}
                      onClick={() => setShipDialogOpen(true)}
                      disabled={!canShip}
                    >
                      <Truck className="size-3.5 mr-1" />
                      {shippableUnshippedItems.length < (order?.items.length ?? 0) ? "继续出库" : "出库"}
                    </Button>
                  </div>
                )}
	                {permission.canUpdate && order.status !== "cancelled" && order.status !== "completed" && activeOrderShipments.length > 0 && (
                  <div className="flex flex-col items-end gap-1">
                    {!allItemsShipped && (
                      <p className="text-xs text-purple-500">尚有 {unshippedItems.length} 件未发货</p>
                    )}
                    {allItemsShipped && !isFinancialSettled && (
                      <p className={financialState.kind === "refundable" ? "text-xs text-red-500" : "text-xs text-orange-500"}>
                        {financialState.kind === "refundable"
                          ? `待退款 ¥${financialState.amount.toFixed(2)}`
                          : `还差 ¥${financialState.amount.toFixed(2)} 未付`}
                      </p>
                    )}
                    {allItemsShipped && isFinancialSettled && !allShipmentsResolved && (
                      <p className="text-xs text-purple-500">尚有发货未签收或报损未完成处理</p>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className={!canCompleteOrder ? "text-muted-foreground border-muted" : "text-emerald-600"}
                      onClick={completeOrder}
                      disabled={!canCompleteOrder}
                    >
                      <CheckCircle className="size-3.5 mr-1" />完成订单
                    </Button>
                  </div>
                )}

                <div className="flex-1" />
                <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AddPaymentDialog
        open={addPayOpen}
        onOpenChange={(o) => {
          setAddPayOpen(o);
          if (!o) setEditingPayment(null);
        }}
        onAdd={addPayment}
        editingRecord={editingPayment}
        onUpdate={updatePayment}
      />

      <AlertDialog open={!!deletingPayment} onOpenChange={(nextOpen) => !nextOpen && setDeletingPayment(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除资金往来记录</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除这笔「{deletingPayment ? PAYMENT_TYPE_LABEL[deletingPayment.type] : ""}」记录？
              {deletingPayment ? ` 金额 ¥${deletingPayment.amount.toFixed(2)}。` : ""}
              删除后订单的实付金额会重新计算。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={deletePayment} className="bg-red-600 hover:bg-red-700">
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ReturnItemDialog
        open={!!returnItem}
        onOpenChange={(nextOpen) => { if (!nextOpen) setReturnItem(null); }}
        order={order}
        item={returnItem}
        product={returnProduct}
        stock={returnStock}
        maxRefund={maxReturnRefund}
        onConfirm={submitReturnItem}
      />

      <ShipmentActionDialog
        shipment={shipmentAction}
        orderNo={order.orderNo}
        open={!!shipmentAction}
        saving={shipmentConfirmSaving}
        onOpenChange={(o) => { if (!o) setShipmentAction(null); }}
        onDelivered={markShipmentDelivered}
        onDamage={(shipment) => {
          setShipmentAction(null);
          setDamageShipment(shipment);
        }}
        onCancelShipment={cancelShipment}
        onConfirmShipment={confirmOutboundShipment}
      />

      <ReportDamageDialog
        shipment={damageShipment}
        order={order}
        open={!!damageShipment}
        onOpenChange={(o) => { if (!o) setDamageShipment(null); }}
        onSubmit={reportShipmentDamage}
      />

      <ShipDialog
        order={order}
        open={shipDialogOpen}
        onOpenChange={setShipDialogOpen}
        onShip={handleShipFromDetail}
        unshippedItems={shippableUnshippedItems}
        getProductName={(pid) => getProduct(pid)?.name ?? "—"}
        getTankName={(sid) => {
          const s = state.stock.find((x) => x.id === sid);
          return s ? subTankName(s.subTankId) : "—";
        }}
        balance={balance}
      />

      {editMode && (
        <StockPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          excludeIds={excludePickerIds}
          onAdd={addPickerItems}
        />
      )}


    </>
  );
}

// ─── StockPickerDialog ────────────────────────────────────────────────────────

function StockPickerDialog({
  open, onOpenChange, excludeIds, onAdd,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  excludeIds: Set<string>;
  onAdd: (items: OrderPickerItem[]) => void;
}) {
  const { state } = useStore();
  const [groupId, setGroupId] = useState("");
  const [subTankId, setSubTankId] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [detailStockId, setDetailStockId] = useState<string | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setGroupId("");
      setSubTankId("");
      setPicked(new Set());
      setDetailStockId(null);
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
    }
  }, [open]);

  const getProduct = (id: string) => state.products.find((p) => p.id === id);
  const getBatch = (id: string) => state.batches.find((b) => b.id === id);
  const getDefaultCommissionRate = (stock: StockItem) => {
    if (stock.commissionRate != null) return normalizeCommissionRate(stock.commissionRate);
    const productRate = normalizeCommissionRate(getProduct(stock.productId)?.commissionRate);
    const multiplier = normalizeCommissionRate(getBatch(stock.batchId)?.commissionMultiplier ?? 100);
    return normalizeCommissionRate(productRate * multiplier / 100);
  };

  const getItemIcon = (itemId: string, productId: string) => {
    const recs = state.bioRecords
      .filter((r) => r.stockItemId === itemId && r.photos.length > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (recs.length > 0) {
      const last = recs[recs.length - 1];
      return last.photos[last.photos.length - 1];
    }
    return getProduct(productId)?.imageUrl ?? "";
  };

  const groupByProduct = (items: typeof state.stock) => {
    const map = new Map<string, typeof items>();
    for (const s of items) {
      const arr = map.get(s.productId) ?? [];
      arr.push(s);
      map.set(s.productId, arr);
    }
    return [...map.entries()];
  };

  const shippedOutStockIds = getShippedOutStockIds(state.shipments);
  const isAvail = (s: typeof state.stock[0]) =>
    !s.sold && !excludeIds.has(s.id) && isPhysicallyInTank(s, shippedOutStockIds);

  const availableGroups = state.tankGroups.filter((g) =>
    g.subTanks.some((t) => state.stock.some((s) => s.subTankId === t.id && isAvail(s)))
  );

  const selectedGroup = state.tankGroups.find((g) => g.id === groupId);
  const availableSubTanks = (selectedGroup?.subTanks ?? []).filter((t) =>
    state.stock.some((s) => s.subTankId === t.id && isAvail(s))
  );

  const availableItems = subTankId
    ? state.stock.filter((s) => s.subTankId === subTankId && isAvail(s))
    : [];

  const grouped = groupByProduct(availableItems);

  const toggleFish = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const handleFishClick = (id: string, clickCount: number) => {
    if (clickCount >= 2) {
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
      setDetailStockId(id);
      return;
    }
    if (clickTimer.current) clearTimeout(clickTimer.current);
    clickTimer.current = setTimeout(() => {
      toggleFish(id);
      clickTimer.current = null;
    }, 220);
  };

  const selectAll = () => setPicked(new Set(availableItems.map((s) => s.id)));
  const clearAll = () => setPicked(new Set());

  const confirm = () => {
    const items = Array.from(picked).map((stockItemId) => {
      const s = state.stock.find((x) => x.id === stockItemId)!;
      return {
        stockItemId,
        productId: s.productId,
        price: s.basePrice ?? getProduct(s.productId)?.defaultPrice ?? 0,
        commissionRate: getDefaultCommissionRate(s),
      };
    });
    onAdd(items);
    onOpenChange(false);
  };

  const statusLabel = (st: string) =>
    st === "healthy" ? "正常" : st === "sick" ? "疾病" : "开口";

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>选择商品</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1 min-h-0">

          {/* Step 1: 缸组 */}
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">① 选择缸组</div>
            {availableGroups.length === 0 ? (
              <div className="text-sm text-muted-foreground py-2">暂无可售库存</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {availableGroups.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => { setGroupId(g.id); setSubTankId(""); setPicked(new Set()); }}
                    className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                      groupId === g.id
                        ? "bg-sky-600 text-white border-sky-600"
                        : "bg-background border-border hover:bg-muted"
                    }`}
                  >
                    {g.name}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Step 2: 子缸 */}
          {groupId && (
            <div className="flex flex-col gap-2">
              <div className="text-xs font-medium text-muted-foreground">② 选择子缸</div>
              <div className="flex flex-wrap gap-2">
                {availableSubTanks.map((t) => {
                  const cnt = state.stock.filter((s) => s.subTankId === t.id && isAvail(s)).length;
                  return (
                    <button
                      key={t.id}
                      onClick={() => { setSubTankId(t.id); setPicked(new Set()); }}
                      className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors flex items-center gap-1.5 ${
                        subTankId === t.id
                          ? "bg-sky-500 text-white border-sky-500"
                          : "bg-background border-border hover:bg-muted"
                      }`}
                    >
                      {t.name}
                      <span className={`text-[10px] px-1 py-0.5 rounded-full font-semibold ${
                        subTankId === t.id ? "bg-white/30 text-white" : "bg-sky-100 text-sky-700"
                      }`}>{cnt}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 3: 生物选择 */}
          {subTankId && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="text-xs font-medium text-muted-foreground">③ 选择生物（可多选）</div>
                <div className="flex items-center gap-3">
                  {picked.size > 0 && (
                    <span className="text-xs text-emerald-600 font-medium">已选 {picked.size} 条</span>
                  )}
                  <button onClick={selectAll} className="text-xs text-sky-600 hover:underline">全选</button>
                  {picked.size > 0 && (
                    <button onClick={clearAll} className="text-xs text-muted-foreground hover:underline">清除</button>
                  )}
                </div>
              </div>
              {availableItems.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-6 border rounded-lg">该子缸暂无可售商品</div>
              ) : (
                <div className="rounded-lg border overflow-hidden divide-y">
                  {grouped.map(([productId, stockItems]) => {
                    const p = getProduct(productId);
                    const selCount = stockItems.filter((s) => picked.has(s.id)).length;
                    return (
                      <div key={productId} className="p-3">
                        <div className="flex items-center gap-2 mb-2.5">
                          <div className="size-7 rounded overflow-hidden border bg-muted shrink-0">
                            {p?.imageUrl
                              ? <ImageWithFallback src={p.imageUrl} alt="" className="size-full object-cover" />
                              : <div className="size-full flex items-center justify-center"><Fish className="size-3 text-muted-foreground" /></div>}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium">{p?.name ?? productId}</span>
                            {(p?.size || p?.origin) && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                {[p?.size, p?.origin].filter(Boolean).join(" · ")}
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground shrink-0">×{stockItems.length}</span>
                          {selCount > 0 && (
                            <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-semibold">+{selCount}</span>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5 pl-9">
                          {stockItems.map((s) => {
                            const iconUrl = getItemIcon(s.id, s.productId);
                            const isSel = picked.has(s.id);
                            return (
                              <button
                                key={s.id}
                                onClick={(event) => handleFishClick(s.id, event.detail)}
                                className={`relative size-10 rounded overflow-hidden bg-muted transition-all cursor-pointer hover:opacity-80 ${
                                  isSel ? "ring-2 ring-emerald-500 ring-offset-1" : statusRingClass(s.status)
                                }`}
	                                title={`${p?.name ?? ""}${s.code ? ` · 编号：${s.code}` : ""} · ${statusLabel(s.status)}${s.notes ? " · " + s.notes : ""}（单击选择，双击查看/修改）`}
                              >
	                                {iconUrl
	                                  ? <ImageWithFallback src={iconUrl} alt="" className="size-full object-cover" />
	                                  : <div className="size-full flex items-center justify-center"><Fish className="size-3 text-muted-foreground" /></div>}
	                                {s.code && (
	                                  <span className="absolute inset-x-0 bottom-0 z-20 truncate bg-black/65 px-0.5 text-center text-[9px] font-semibold leading-3 text-white">
	                                    {s.code}
	                                  </span>
	                                )}
	                                {isSel && (
	                                  <div className="absolute inset-0 z-10 bg-emerald-500/40 flex items-center justify-center">
	                                    <Check className="size-4 text-white drop-shadow" />
	                                  </div>
	                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {!groupId && availableGroups.length > 0 && (
            <div className="text-sm text-muted-foreground text-center py-6 border border-dashed rounded-lg">
              请先选择缸组
            </div>
          )}
          {groupId && !subTankId && (
            <div className="text-sm text-muted-foreground text-center py-6 border border-dashed rounded-lg">
              请选择子缸
            </div>
          )}
        </div>

        <DialogFooter className="pt-3 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={confirm} disabled={picked.size === 0}>
            <Plus className="size-4 mr-1" />
            添加{picked.size > 0 ? ` ${picked.size} 条` : ""}商品
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <StockPickerBioDialog
      stockItemId={detailStockId}
      open={!!detailStockId}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setDetailStockId(null);
      }}
    />
    </>
  );
}

// ─── NewOrderDialog ────────────────────��──────────────────────────────────────

function NewOrderDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { state, activeSiteId, setState, saveStateTransform } = useStore();
  const permission = usePermission("orders");
  const customerPermission = usePermission("customers");
  const isAdmin = state.user?.role === "admin";
  const today = todayDateString();
  const currentUsername = state.user?.username ?? "";
  const personnel = state.personnel ?? [];
  const defaultContactPerson = getDefaultContactPerson(personnel, currentUsername);

  const [customerId, setCustomerId] = useState("");
  const [date, setDate] = useState(today);
  const [source, setSource] = useState("");
  const [plannedShipDate, setPlannedShipDate] = useState("");
  const [contactPerson, setContactPerson] = useState(defaultContactPerson);
  const [notes, setNotes] = useState("");
  const [selectedItems, setSelectedItems] = useState<Map<string, { price: number; commissionRate: number }>>(new Map());
  const [shippingFee, setShippingFee] = useState(0);
  const [packagingFee, setPackagingFee] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [draftPayments, setDraftPayments] = useState<PaymentRecord[]>([]);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [editingPayment, setEditingPayment] = useState<PaymentRecord | null>(null);

  useEffect(() => {
    if (open) {
      setCustomerId(""); setDate(today); setSource(""); setPlannedShipDate(""); setContactPerson(defaultContactPerson); setNotes("");
      setSelectedItems(new Map());
      setShippingFee(0); setPackagingFee(0); setDiscount(0);
      setPickerOpen(false);
      setCustomerDialogOpen(false);
      setDraftPayments([]);
      setPaymentOpen(false);
      setEditingPayment(null);
    }
  }, [open, defaultContactPerson, today]);

  const getProduct = (id: string) => state.products.find((p) => p.id === id);

  const subTankName = (id: string) => {
    for (const g of state.tankGroups) {
      const t = g.subTanks.find((x) => x.id === id);
      if (t) return `${g.name} / ${t.name}`;
    }
    return "—";
  };

  const addFromPicker = (items: OrderPickerItem[]) => {
    setSelectedItems((prev) => {
      const next = new Map(prev);
      for (const { stockItemId, price, commissionRate } of items) {
        if (!next.has(stockItemId)) next.set(stockItemId, { price, commissionRate: normalizeCommissionRate(commissionRate) });
      }
      return next;
    });
  };

  const setItemPrice = (stockItemId: string, price: number) =>
    setSelectedItems((prev) => {
      const current = prev.get(stockItemId) ?? { price: 0, commissionRate: 0 };
      return new Map(prev).set(stockItemId, { ...current, price });
    });

  const setItemCommissionRate = (stockItemId: string, commissionRate: number) =>
    setSelectedItems((prev) => {
      const current = prev.get(stockItemId) ?? { price: 0, commissionRate: 0 };
      return new Map(prev).set(stockItemId, { ...current, commissionRate: normalizeCommissionRate(commissionRate) });
    });

  const removeItem = (stockItemId: string) =>
    setSelectedItems((prev) => { const n = new Map(prev); n.delete(stockItemId); return n; });

  const itemsTotal = Array.from(selectedItems.values()).reduce((s, item) => s + item.price, 0);
  const commissionTotal = Array.from(selectedItems.values()).reduce((s, item) => s + item.price * normalizeCommissionRate(item.commissionRate) / 100, 0);
  const amountDue = itemsTotal + shippingFee + packagingFee - discount;
  const contactOptions = getContactPersonOptions(personnel, contactPerson);

  const createCustomer = async (customer: Customer) => {
    if (!customerPermission.requirePermission("create")) return false;
    const nextCustomer = { ...customer, id: customer.id || uid() };
    const ok = await saveStateTransform((latest) => {
      const sources = latest.customerSources ?? [];
      const nextSources = nextCustomer.source && !sources.includes(nextCustomer.source)
        ? [...sources, nextCustomer.source]
        : sources;
      return {
        ...latest,
        customerSources: nextSources,
        customers: [...(latest.customers ?? []), nextCustomer],
      };
    });
    if (!ok) {
      toast.error("新增客户失败，请重试");
      return false;
    }
    setCustomerId(nextCustomer.id);
    toast.success(`客户「${nextCustomer.name}」已新增`);
    return true;
  };

  const addDraftPayment = async (record: PaymentRecord) => {
    setDraftPayments((current) => [...current, record]);
    toast.success("资金往来记录已添加");
    return true;
  };

  const updateDraftPayment = async (record: PaymentRecord) => {
    setDraftPayments((current) => current.map((item) => (item.id === record.id ? record : item)));
    toast.success("资金往来记录已修改");
    return true;
  };

  const deleteDraftPayment = (record: PaymentRecord) => {
    if (!confirmWrite("删除", "将删除这条待随订单保存的资金往来记录。")) return;
    setDraftPayments((current) => current.filter((item) => item.id !== record.id));
    toast.success("资金往来记录已删除");
  };

  const changeOrderDate = (newDate: string) => {
    if (newDate && newDate > today) {
      toast.error("下单日期不能晚于今天");
      return;
    }
    setDate(newDate);
    if (plannedShipDate && plannedShipDate < newDate) setPlannedShipDate("");
  };
  const changePlannedShipDate = (newDate: string) => {
    if (date && newDate && newDate < date) {
      toast.error("预计发货日期不能早于下单日期");
      return;
    }
    setPlannedShipDate(newDate);
  };

  const save = async () => {
    if (!permission.requirePermission("create")) return;
    if (!customerId) return toast.error("请选择客户");
    if (date > today) return toast.error("下单日期不能晚于今天");
    if (!source.trim()) return toast.error("请选择订单来源");
    if (!contactPerson.trim()) return toast.error("请选择对接人");
    if (selectedItems.size === 0) return toast.error("请至少添加一条商品");
    if (plannedShipDate && plannedShipDate < date) return toast.error("预计发货日期不能早于下单日期");
    if (amountDue < 0) return toast.error("折扣过大，应付金额不能为负数");
    const items: OrderItem[] = Array.from(selectedItems.entries()).map(([stockItemId, draft]) => {
      const s = state.stock.find((x) => x.id === stockItemId)!;
      return {
        stockItemId,
        productId: s.productId,
        price: draft.price,
        commissionRate: normalizeCommissionRate(draft.commissionRate),
      };
    });
    const paymentText = draftPayments.length > 0 ? `，并保存 ${draftPayments.length} 条资金往来记录` : "";
    if (!confirmWrite("创建", `将创建销售订单${paymentText}。`)) return;
    let createdOrderNo = "";
    try {
      const result = await postOrderApi("orders/create", {
        siteId: activeSiteId,
        customerId,
        date,
        source: source.trim(),
        plannedShipDate: plannedShipDate || undefined,
        contactPerson: contactPerson.trim(),
        items,
        shippingFee,
        packagingFee,
        discount,
        notes,
        payments: draftPayments.map((payment) => ({ ...payment, amount: Number(payment.amount) })),
        operator: state.user?.username ?? "system",
      });
      applyOrderApiResult(setState, result);
      createdOrderNo = result.order?.orderNo ?? "";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "创建失败，请重试");
      return;
    }
    onOpenChange(false);
    toast.success(createdOrderNo ? `订单 ${createdOrderNo} 已创建` : "订单已创建");
  };

  const excludeIds = useMemo(() => new Set(selectedItems.keys()), [selectedItems]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          aria-describedby={undefined}
          className="max-w-none sm:max-w-none flex flex-col p-8"
          style={{ width: "min(92vw, 1080px)", maxWidth: "min(92vw, 1080px)", height: "90vh" }}
        >
          <DialogHeader>
            <DialogTitle>新建销售订单</DialogTitle>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto flex flex-col gap-5 pr-1">

            {/* ── 1. Customer + date + notes ── */}
            <div className="rounded-lg border p-4 grid grid-cols-4 gap-3 items-end">
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>客户<span className="text-red-500 ml-0.5">*</span></Label>
                  {customerPermission.canCreate && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 text-xs font-medium text-sky-600 hover:text-sky-700 hover:underline"
                      onClick={() => setCustomerDialogOpen(true)}
                    >
                      <Plus className="size-3" />
                      新建客户
                    </button>
                  )}
                </div>
                <CustomerCombobox value={customerId} onChange={setCustomerId} customers={state.customers ?? []} />
              </div>
              <div className="grid gap-2">
                <Label>来源<span className="text-red-500 ml-0.5">*</span></Label>
                <Select value={source} onValueChange={setSource}>
                  <SelectTrigger className={!source.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}>
                    <SelectValue placeholder="请选择来源" />
                  </SelectTrigger>
                  <SelectContent>
                    {ORDER_SOURCE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>下单日期</Label>
                <Input
                  type="date"
                  value={date}
                  max={today}
                  className={date > today ? "border-red-500 focus-visible:ring-red-500" : ""}
                  onChange={(e) => changeOrderDate(e.target.value)}
                />
                {date > today && (
                  <p className="text-xs text-red-500 -mt-1">下单日期不能晚于今天</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label>预计发货日期</Label>
                <Input
                  type="date"
                  value={plannedShipDate}
                  min={date}
                  onChange={(e) => changePlannedShipDate(e.target.value)}
                  className={plannedShipDate && plannedShipDate < date ? "border-red-500 focus-visible:ring-red-500" : ""}
                />
                {plannedShipDate && plannedShipDate < date && (
                  <p className="text-xs text-red-500 -mt-1">发货日期不能早于下单日期</p>
                )}
              </div>
              <div className="grid gap-2">
                <Label>对接人<span className="text-red-500 ml-0.5">*</span></Label>
                <Select
                  value={contactPerson}
                  onValueChange={setContactPerson}
                >
                  <SelectTrigger className={!contactPerson.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}>
                    <SelectValue placeholder="请选择对接人" />
                  </SelectTrigger>
                  <SelectContent>
                    {contactOptions.map((person) => (
                      <SelectItem key={person.id} value={person.name}>
                        {person.name}{person.role ? ` · ${person.role}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-3 grid gap-2">
                <Label>备注</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="选填" />
              </div>
            </div>

            {/* ── 2. Items table ── */}
            <div className="rounded-lg border flex flex-col">
              <div className="px-4 py-2.5 bg-muted/50 border-b flex items-center justify-between shrink-0 rounded-t-lg">
                <span className="text-sm font-medium">
                  已添加商品{selectedItems.size > 0 ? `（${selectedItems.size} 条）` : ""}
                </span>
                {selectedItems.size > 0 && (
                  <span className="text-sm text-muted-foreground">
                    小计 ¥{itemsTotal.toFixed(2)} · 预计提成 ¥{commissionTotal.toFixed(2)}
                  </span>
                )}
              </div>

              {/* scrollable items list — height capped so the add button is always visible */}
              <div className="overflow-y-auto" style={{ maxHeight: "22rem" }}>
                {selectedItems.size === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    暂无商品，点击下方「添加商品」按钮
                  </div>
                ) : (
                  <table className="w-full">
                    <thead className="bg-muted/20 sticky top-0 z-10">
                      <tr>
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">商品</th>
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">缸位</th>
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">售价（¥）</th>
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">提成比例</th>
                        <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">提成</th>
                        <th className="w-10 px-2 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from(selectedItems.keys()).map((stockItemId) => {
                        const s = state.stock.find((x) => x.id === stockItemId);
                        if (!s) return null;
                        const p = getProduct(s.productId);
                        const draftItem = selectedItems.get(stockItemId) ?? { price: 0, commissionRate: 0 };
                        const commissionRate = normalizeCommissionRate(draftItem.commissionRate);
                        return (
                          <tr key={stockItemId} className="border-t">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <div className="size-7 rounded overflow-hidden border bg-muted shrink-0">
                                  {p?.imageUrl
                                    ? <ImageWithFallback src={p.imageUrl} alt="" className="size-full object-cover" />
                                    : <div className="size-full flex items-center justify-center"><Fish className="size-3 text-muted-foreground" /></div>}
                                </div>
                                <span className="text-sm">{p?.name ?? "—"}</span>
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-sm text-muted-foreground">{subTankName(s.subTankId)}</td>
                            <td className="px-4 py-2.5">
                              <Input
                                type="number" min={0}
                                value={draftItem.price}
                                onChange={(e) => setItemPrice(stockItemId, Number(e.target.value))}
                                className="h-7 w-28 text-sm"
                              />
                            </td>
                            <td className="px-4 py-2.5">
                              <Input
                                type="number"
                                min={0}
                                step={0.01}
                                value={commissionRate}
                                onChange={(e) => setItemCommissionRate(stockItemId, Number(e.target.value))}
                                disabled={!isAdmin}
                                className="h-7 w-24 text-sm"
                              />
                            </td>
                            <td className="px-4 py-2.5 text-right text-sm text-emerald-700">
                              ¥{(draftItem.price * commissionRate / 100).toFixed(2)}
                            </td>
                            <td className="px-2 py-2.5">
                              <button
                                onClick={() => removeItem(stockItemId)}
                                className="text-muted-foreground hover:text-red-500 transition-colors"
                                title="移除"
                              >
                                <X className="size-4" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Always-visible add button */}
              <div className="px-4 py-2.5 border-t bg-muted/10 flex items-center justify-between shrink-0 rounded-b-lg">
                <button
                  onClick={() => setPickerOpen(true)}
                  className="flex items-center gap-1.5 text-sm text-sky-600 hover:text-sky-700 font-medium transition-colors"
                >
                  <Plus className="size-4" /> 添加商品
                </button>
                {selectedItems.size > 0 && (
                  <span className="text-xs text-muted-foreground">
                    共 {selectedItems.size} 条 · 小计 ¥{itemsTotal.toFixed(2)} · 预计提成 ¥{commissionTotal.toFixed(2)}
                  </span>
                )}
              </div>
            </div>

            {/* ── 3. Fees + settlement ── */}
            <div className="rounded-lg border p-4 grid grid-cols-2 gap-6">
              <div className="flex flex-col gap-3">
                <div className="text-xs font-medium text-muted-foreground">费用设置</div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="grid gap-1.5">
                    <Label className="text-xs">预收运费（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={shippingFee || ""} onChange={(e) => setShippingFee(Number(e.target.value))} placeholder="0" className="h-8 text-sm" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">包装费（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={packagingFee || ""} onChange={(e) => setPackagingFee(Number(e.target.value))} placeholder="0" className="h-8 text-sm" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">折扣/优惠（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={discount || ""} onChange={(e) => setDiscount(Number(e.target.value))} placeholder="0"
                      className={`h-8 text-sm${amountDue < 0 ? " border-red-500 focus-visible:ring-red-500" : ""}`} />
                    {amountDue < 0 && <p className="text-xs text-red-500">折扣超出应付金额 ¥{Math.abs(amountDue).toFixed(2)}</p>}
                  </div>
                </div>
              </div>
              <div className="flex flex-col gap-2 justify-center border-l pl-6">
                <div className="text-xs font-medium text-muted-foreground mb-1">结算预览</div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">商品小计</span><span>¥{itemsTotal.toFixed(2)}</span></div>
                <div className="flex justify-between text-sm text-emerald-700"><span>预计提成</span><span>¥{commissionTotal.toFixed(2)}</span></div>
                {shippingFee > 0 && <div className="flex justify-between text-sm"><span className="text-muted-foreground">+ 运费</span><span>¥{shippingFee.toFixed(2)}</span></div>}
                {packagingFee > 0 && <div className="flex justify-between text-sm"><span className="text-muted-foreground">+ 包装费</span><span>¥{packagingFee.toFixed(2)}</span></div>}
                {discount > 0 && <div className="flex justify-between text-sm text-orange-600"><span>− 折扣</span><span>¥{discount.toFixed(2)}</span></div>}
                <div className="flex justify-between font-semibold text-base border-t pt-2">
                  <span>应付总额</span>
                  <span className={amountDue < 0 ? "text-red-600" : "text-sky-700"}>¥{amountDue.toFixed(2)}</span>
                </div>
              </div>
            </div>

            {/* ── 4. Payment records ── */}
            <div className="rounded-lg border p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-muted-foreground">资金往来记录</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">可先录入定金、尾款或退款，创建订单时一起保存。</div>
                </div>
                {draftPayments.length > 0 && (
                  <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                    {draftPayments.length} 条
                  </span>
                )}
              </div>
              <PaymentTimeline
                payments={draftPayments}
                onAdd={() => {
                  setEditingPayment(null);
                  setPaymentOpen(true);
                }}
                onEdit={(record) => {
                  setEditingPayment(record);
                  setPaymentOpen(true);
                }}
                onDelete={deleteDraftPayment}
                canAdd={permission.canCreate}
                canEdit={permission.canCreate}
                canDelete={permission.canCreate}
              />
            </div>
          </div>

          <DialogFooter className="pt-2 border-t">
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button onClick={save}><ShoppingCart className="size-4 mr-1" />创建订单</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <StockPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        excludeIds={excludeIds}
        onAdd={addFromPicker}
      />

      <CreateCustomerDialog
        open={customerDialogOpen}
        onOpenChange={setCustomerDialogOpen}
        sources={state.customerSources ?? []}
        onCreate={createCustomer}
      />

      <AddPaymentDialog
        open={paymentOpen}
        onOpenChange={(nextOpen) => {
          setPaymentOpen(nextOpen);
          if (!nextOpen) setEditingPayment(null);
        }}
        editingRecord={editingPayment}
        onAdd={addDraftPayment}
        onUpdate={updateDraftPayment}
      />
    </>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────

export function OrdersView() {
  const { state, setState, saveStateTransform } = useStore();
  const permission = usePermission("orders");

  const [newOpen, setNewOpen] = useState(false);
  const [viewOrder, setViewOrder] = useState<Order | null>(null);
  const [viewCustomerId, setViewCustomerId] = useState<string | null>(null);
  const [deleteOrder, setDeleteOrder] = useState<Order | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [exportFormatOpen, setExportFormatOpen] = useState(false);

  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "completed">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [todayShipOnly, setTodayShipOnly] = useState(false);
  const [pendingTrackingOnly, setPendingTrackingOnly] = useState(false);
  const [myActiveOnly, setMyActiveOnly] = useState(false);
  const today = todayDateString();

  const customers = state.customers ?? [];
  const getCustomer = (customerId: string) => customers.find((c) => c.id === customerId);
  const viewCustomer = viewCustomerId ? getCustomer(viewCustomerId) ?? null : null;
  const changeDateFrom = (value: string) => {
    if (value && value > today) {
      toast.error("开始日期不能晚于今天");
      return;
    }
    setDateFrom(value);
    if (dateTo && value && dateTo < value) setDateTo("");
  };
  const changeDateTo = (value: string) => {
    if (value && value > today) {
      toast.error("结束日期不能晚于今天");
      return;
    }
    if (dateFrom && value && value < dateFrom) {
      toast.error("结束日期不能早于开始日期");
      return;
    }
    setDateTo(value);
  };

  const syncedViewOrder = useMemo(
    () => viewOrder ? state.orders.find((o) => o.id === viewOrder.id) ?? viewOrder : null,
    [viewOrder, state.orders]
  );

  const orderList = useMemo(
    () => [...state.orders].sort(compareOrdersByCreatedDesc),
    [state.orders]
  );
  const currentContactAliases = useMemo(
    () => getCurrentContactAliases(state.personnel ?? [], state.user?.username),
    [state.personnel, state.user?.username]
  );
  const isCurrentUserContactOrder = (order: Order) =>
    currentContactAliases.has(normalizeContactPersonName(order.contactPerson));

  type OrderListRow = Order & { searchText: string };
  const orderRows = useMemo<OrderListRow[]>(() => {
    const customerMap = new Map(customers.map((customer) => [customer.id, customer]));
    const productMap = new Map(state.products.map((product) => [product.id, product]));
    const stockMap = new Map(state.stock.map((stock) => [stock.id, stock]));
    const batchMap = new Map(state.batches.map((batch) => [batch.id, batch]));
    const subTankMap = new Map(
      state.tankGroups.flatMap((group) =>
        group.subTanks.map((tank) => [tank.id, `${group.name} / ${tank.name}`] as const)
      )
    );
    const shipmentsByOrder = new Map<string, Shipment[]>();
    for (const shipment of state.shipments) {
      shipmentsByOrder.set(shipment.orderId, [...(shipmentsByOrder.get(shipment.orderId) ?? []), shipment]);
    }

    return orderList.map((order) => {
      const customer = customerMap.get(order.customerId);
      const orderShipments = shipmentsByOrder.get(order.id) ?? [];
      const itemSearchText = order.items.flatMap((item) => {
        const product = productMap.get(item.productId);
        const stock = stockMap.get(item.stockItemId);
        const batch = stock ? batchMap.get(stock.batchId) : undefined;
        return [
          item.stockItemId,
          item.plannedShipDate,
          item.price,
          item.commissionRate,
          product?.name,
          product?.size,
          product?.origin,
          batch?.batchNo,
          batch?.supplier,
          batch?.arrivalDate,
          batch?.notes,
          stock ? subTankMap.get(stock.subTankId) : undefined,
          stock?.inDate,
          stock?.notes,
          stock?.lossReason,
        ];
      });
      const searchText = [
        order.orderNo,
        order.date,
        order.source,
        order.plannedShipDate,
        getOrderStatusText(order, state.shipments),
        customer?.name,
        customer?.phone,
        customer?.wechat,
        customer?.douyin,
        customer?.source,
        customer?.address,
        customer?.notes,
        order.contactPerson,
        order.notes,
        ...order.payments.flatMap((payment) => [
          PAYMENT_TYPE_LABEL[payment.type],
          payment.amount,
          payment.time,
          payment.notes,
        ]),
        ...orderShipments.flatMap((shipment) => [
          shipment.shipDate,
          shipment.carrier,
          shipment.trackingNo,
          shipment.notes,
        ]),
        calcAmountDue(order, state.shipments).toFixed(2),
        calcAmountPaid(order).toFixed(2),
        orderCommissionTotal(order).toFixed(2),
        ...itemSearchText,
      ].filter(Boolean).join(" ");
      return { ...order, searchText };
    });
  }, [customers, orderList, state.batches, state.products, state.shipments, state.stock, state.tankGroups]);

	  const filteredOrders = useMemo(() => {
	    return orderRows.filter((o) => {
	      if (todayShipOnly && !hasPlannedShipPlanOnDate(o, today)) return false;
	      if (pendingTrackingOnly && !hasPendingTrackingShipmentOrder(o, state.shipments)) return false;
	      if (statusFilter === "active" && !isActiveOrder(o)) return false;
      if (statusFilter === "completed" && o.status !== "completed") return false;
      if (myActiveOnly && (!isActiveOrder(o) || !isCurrentUserContactOrder(o))) return false;
      if (dateFrom && o.date < dateFrom) return false;
      if (dateTo && o.date > dateTo) return false;
	      return true;
	    });
	  }, [orderRows, todayShipOnly, today, pendingTrackingOnly, state.shipments, statusFilter, myActiveOnly, currentContactAliases, dateFrom, dateTo]);

  useEffect(() => {
    setSelectedOrderIds((prev) => {
      if (prev.size === 0) return prev;
      const existingIds = new Set(state.orders.map((order) => order.id));
      const next = new Set([...prev].filter((id) => existingIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [state.orders]);

  const selectedOrders = useMemo(
    () => orderList.filter((order) => selectedOrderIds.has(order.id)),
    [orderList, selectedOrderIds]
  );
  const allFilteredSelected = filteredOrders.length > 0 && filteredOrders.every((order) => selectedOrderIds.has(order.id));

  const toggleSelectedOrder = (id: string, checked: boolean) => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const toggleFilteredOrders = () => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredOrders.forEach((order) => next.delete(order.id));
      } else {
        filteredOrders.forEach((order) => next.add(order.id));
      }
      return next;
    });
  };

  const doDeleteOrder = async () => {
    if (!deleteOrder) return;
    if (!permission.requirePermission("delete")) return;
    if (hasPaymentRecords(deleteOrder)) {
      toast.error("该订单已有收款记录，不能删除");
      setDeleteOrder(null);
      return;
    }
    if (!confirmWrite("删除", `将删除订单「${deleteOrder.orderNo}」。`)) return;
    const deleteId = deleteOrder.id;
    try {
      const result = await postOrderApi("orders/delete", {
        orderId: deleteId,
        operator: state.user?.username ?? "system",
      });
      applyOrderApiResult(setState, result);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败，请重试");
      return;
    }
    if (viewOrder?.id === deleteOrder.id) setViewOrder(null);
    setDeleteOrder(null);
    toast.success("订单已删除");
  };

  const STATUS_FILTERS = [
    { key: "all",       label: "全部" },
    { key: "active",    label: "未完成" },
    { key: "completed", label: "已完成" },
  ] as const;

  const hasDateFilter = dateFrom || dateTo || todayShipOnly || pendingTrackingOnly || myActiveOnly;
  const dateFromMax = dateTo && dateTo < today ? dateTo : today;
  const myActiveOrderCount = useMemo(
    () => orderList.filter((order) => isActiveOrder(order) && isCurrentUserContactOrder(order)).length,
    [orderList, currentContactAliases]
  );
  const todayShipCount = useMemo(
    () => orderList.filter((order) => hasPlannedShipPlanOnDate(order, today)).length,
    [orderList, today]
  );
  const pendingTrackingCount = useMemo(
    () => orderList.filter((order) => hasPendingTrackingShipmentOrder(order, state.shipments)).length,
    [orderList, state.shipments]
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>订单管理</h2>
        <p className="text-sm text-muted-foreground">
          管理客户销售订单，记录资金往来与收付款凭证
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex gap-1">
          {STATUS_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => {
                setStatusFilter(key);
                if (key !== "active") setMyActiveOnly(false);
              }}
              className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
                statusFilter === key
                  ? "bg-sky-600 text-white"
                  : "bg-muted text-muted-foreground hover:bg-muted/70"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-2">
          <Button
            type="button"
            size="sm"
            variant={myActiveOnly ? "default" : "outline"}
            className={myActiveOnly
              ? "h-7 bg-sky-600 hover:bg-sky-700 text-white"
              : "h-7 border-sky-200 text-sky-700 hover:bg-sky-50 hover:text-sky-800"
            }
            onClick={() => {
              const next = !myActiveOnly;
              setMyActiveOnly(next);
              if (next) {
                setStatusFilter("active");
                setDateFrom("");
                setDateTo("");
                setTodayShipOnly(false);
                setPendingTrackingOnly(false);
              }
            }}
          >
            <UserRound className="size-3.5 mr-1" />
            我的未完成{myActiveOrderCount > 0 ? ` ${myActiveOrderCount}` : ""}
          </Button>
          <span className="text-xs text-muted-foreground shrink-0">日期</span>
          <Input
            type="date"
            value={dateFrom}
            max={dateFromMax}
            onChange={(e) => changeDateFrom(e.target.value)}
            className="h-7 w-34 text-xs"
          />
          <span className="text-xs text-muted-foreground">—</span>
          <Input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            max={today}
            onChange={(e) => changeDateTo(e.target.value)}
            className="h-7 w-34 text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant={todayShipOnly ? "default" : "outline"}
            className={todayShipOnly
              ? "h-7 bg-orange-600 hover:bg-orange-700 text-white"
              : "h-7 border-orange-200 text-orange-600 hover:bg-orange-50 hover:text-orange-700"
            }
            onClick={() => {
              const next = !todayShipOnly;
              setTodayShipOnly(next);
              if (next) {
                setPendingTrackingOnly(false);
                setMyActiveOnly(false);
                setStatusFilter("all");
                setDateFrom("");
                setDateTo("");
              }
            }}
          >
            <Truck className="size-3.5 mr-1" />
            筛选今日发货计划{todayShipCount > 0 ? ` ${todayShipCount}` : ""}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={pendingTrackingOnly ? "default" : "outline"}
            className={pendingTrackingOnly
              ? "h-7 bg-emerald-600 hover:bg-emerald-700 text-white"
              : "h-7 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
            }
            onClick={() => {
              const next = !pendingTrackingOnly;
              setPendingTrackingOnly(next);
              if (next) {
                setTodayShipOnly(false);
                setMyActiveOnly(false);
                setStatusFilter("all");
                setDateFrom("");
                setDateTo("");
                setSelectedOrderIds(new Set(
                  orderList
                    .filter((order) => hasPendingTrackingShipmentOrder(order, state.shipments))
                    .map((order) => order.id)
                ));
              }
            }}
          >
            <Truck className="size-3.5 mr-1" />
            筛选出库发货订单{pendingTrackingCount > 0 ? ` ${pendingTrackingCount}` : ""}
          </Button>
          {hasDateFilter && (
            <button
              onClick={() => { setDateFrom(""); setDateTo(""); setTodayShipOnly(false); setPendingTrackingOnly(false); setMyActiveOnly(false); }}
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              清除
            </button>
          )}
        </div>
	      </div>

	      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
	        <div className="flex flex-wrap items-center gap-2 text-sm">
	          <span className="text-muted-foreground">批量导出</span>
	          <span className="font-medium">已选 {selectedOrders.length} 个订单</span>
	          {selectedOrders.length > 0 && (
	            <Button
	              type="button"
	              size="sm"
	              variant="ghost"
	              onClick={() => setSelectedOrderIds(new Set())}
	            >
	              清空选择
	            </Button>
	          )}
	        </div>
	        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setExportFormatOpen(true)}
          disabled={selectedOrders.length === 0}
        >
          <Download className="size-3.5 mr-1" />
          {pendingTrackingOnly ? "导出选中出库发货表" : "导出选中订单信息"}
        </Button>
	      </div>

	      <DataTable
	        data={filteredOrders}
        searchKeys={["searchText"] as (keyof OrderListRow)[]}
        searchPlaceholder="搜索订单号、客户、商品、来源、对接人..."
        onAdd={permission.canCreate ? () => setNewOpen(true) : undefined}
	        addLabel="新建订单"
	        columns={[
	          {
	            key: "select",
	            title: (
	              <div className="flex items-center gap-2">
	                <span>选择</span>
	                <button
	                  type="button"
	                  className="rounded border border-sky-200 px-1.5 py-0.5 text-xs font-medium text-sky-600 hover:bg-sky-50 disabled:border-border disabled:text-muted-foreground"
	                  onClick={toggleFilteredOrders}
	                  disabled={filteredOrders.length === 0}
	                >
	                  {allFilteredSelected ? "取消" : "全选"}
	                </button>
	              </div>
	            ),
	            width: "110px",
	            render: (r) => (
	              <Checkbox
	                checked={selectedOrderIds.has(r.id)}
	                onCheckedChange={(checked) => toggleSelectedOrder(r.id, checked === true)}
	                onClick={(event) => event.stopPropagation()}
	                aria-label={`选择订单 ${r.orderNo}`}
	              />
	            ),
	          },
	          {
	            key: "customerId",
	            title: "客户",
            render: (r) => {
              const customer = getCustomer(r.customerId);
              if (!customer) return <span className="text-muted-foreground">—</span>;
              return (
                <Button
                  type="button"
                  variant="link"
                  className="h-auto p-0 text-left text-sm font-medium text-sky-700 hover:text-sky-800"
                  onClick={(event) => {
                    event.stopPropagation();
                    setViewCustomerId(customer.id);
                  }}
                >
                  {customer.name}
                </Button>
              );
            },
          },
          {
            key: "source",
            title: "来源",
            render: (r) => r.source ? (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-xs font-medium text-sky-700">
                {r.source}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            ),
          },
          { key: "date", title: "下单日期" },
          {
            key: "plannedShipDate",
            title: "预计发货",
            render: (r) => {
              if (r.status === "completed") return <span className="text-muted-foreground">—</span>;
              const todayItems = r.items.filter((item) =>
                effectiveItemPlannedShipDate(r, item) === today || item.plannedShipDate === today
              );
              if (todayItems.length > 0) {
                return <span className="text-orange-600 font-medium">今日 {today} · {todayItems.length}件</span>;
              }
              const nextDate = r.items
                .map((item) => effectiveItemPlannedShipDate(r, item) || item.plannedShipDate)
                .filter(Boolean)
                .sort()[0];
              if (!nextDate) return <span className="text-muted-foreground">—</span>;
              return <span>{nextDate}</span>;
            },
          },
          {
            key: "items",
            title: "商品数",
            render: (r) => `${r.items.length} 条`,
          },
          {
            key: "shippingFee",
            title: "应付",
            render: (r) => (
              <span className="text-sky-700 font-medium">¥{calcAmountDue(r, state.shipments).toFixed(2)}</span>
            ),
          },
          {
            key: "payments",
            title: "实付",
            render: (r) => {
              const paid = calcAmountPaid(r);
              const due = calcAmountDue(r, state.shipments);
              return (
                <span className={paid + 0.005 >= due ? "text-emerald-600" : "text-orange-500"}>
                  ¥{paid.toFixed(2)}
                </span>
              );
            },
          },
          {
            key: "commission",
            title: "提成",
            render: (r) => (
              <span className="font-medium text-emerald-700">¥{orderCommissionTotal(r).toFixed(2)}</span>
            ),
          },
          {
            key: "status",
            title: "状态",
            render: (r) => <OrderStatusTags order={r} shipments={state.shipments} />,
          },
        ]}
        actions={(row) => (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="outline" onClick={() => setViewOrder(row)}>
              <Eye className="size-3.5 mr-1" />详情
            </Button>
	            {permission.canDelete && (
	              <Button
	                size="sm"
	                variant="ghost"
	                className={hasPaymentRecords(row) ? "text-muted-foreground" : "text-red-500 hover:text-red-700 hover:bg-red-50"}
	                title={hasPaymentRecords(row) ? "已有收款记录，不能删除" : "删除订单"}
	                onClick={() => {
	                  if (hasPaymentRecords(row)) {
	                    toast.error("该订单已有收款记录，不能删除");
	                    return;
	                  }
	                  setDeleteOrder(row);
	                }}
	              >
	                <Trash2 className="size-3.5" />
	              </Button>
	            )}
          </div>
        )}
      />

      <Dialog open={exportFormatOpen} onOpenChange={setExportFormatOpen}>
        <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{pendingTrackingOnly ? "导出出库发货表" : "导出订单信息"}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <p className="text-sm text-muted-foreground">
              当前已选 {selectedOrders.length} 个订单。
              {pendingTrackingOnly
                ? "只会导出这些订单里「已出库/待发货」的商品，不包含订单里未出库或已发货的商品。"
                : "将导出选中订单的完整订单、商品、发货和资金信息。"}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-auto flex-col items-start gap-1 p-4 text-left"
                onClick={() => {
                  setExportFormatOpen(false);
                  if (pendingTrackingOnly) exportPendingTrackingShipmentsExcel(selectedOrders, state);
                  else exportOrdersExcel(selectedOrders, state);
                }}
              >
                <span className="font-semibold">Excel</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {pendingTrackingOnly ? "出库发货表，便于二次整理" : "订单全量信息"}
                </span>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-auto flex-col items-start gap-1 p-4 text-left"
                onClick={() => {
                  if (!pendingTrackingOnly) {
                    toast.error("Word 打印版仅用于出库发货表；订单全量信息请导出 Excel");
                    return;
                  }
                  setExportFormatOpen(false);
                  exportPendingTrackingShipmentsWord(selectedOrders, state);
                }}
              >
                <span className="font-semibold">Word</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {pendingTrackingOnly ? "打印版，只含出库待发货商品" : "仅出库发货表可用"}
                </span>
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setExportFormatOpen(false)}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <NewOrderDialog open={newOpen} onOpenChange={setNewOpen} />

      <OrderDetailDialog
        order={syncedViewOrder}
        open={!!viewOrder}
        onOpenChange={(o) => { if (!o) setViewOrder(null); }}
      />

      <CustomerDetailDialog
        customer={viewCustomer}
        open={!!viewCustomerId}
        onOpenChange={(open) => { if (!open) setViewCustomerId(null); }}
        orders={orderList}
        shipments={state.shipments}
      />

      <AlertDialog open={!!deleteOrder} onOpenChange={(o) => !o && setDeleteOrder(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除订单</AlertDialogTitle>
            <AlertDialogDescription>
              确认彻底删除「{getCustomer(deleteOrder?.customerId ?? "")?.name ?? ""}」的订单（{deleteOrder?.date}）？
              {" 关联商品将恢复为在库状态，相关发货记录会一并删除。"}
              {deleteOrder && hasPaymentRecords(deleteOrder) && " 该订单已有收款记录，不能删除。"}
              此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={doDeleteOrder}
              disabled={deleteOrder ? hasPaymentRecords(deleteOrder) : false}
              className="bg-red-600 hover:bg-red-700 disabled:opacity-50"
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
