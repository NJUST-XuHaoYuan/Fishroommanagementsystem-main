import { useCallback, useState, useMemo, useRef, useEffect } from "react";
import {
  useStore, Order, OrderItem, OrderStatus, Shipment, ShipmentDamageReplacement, Product, StockItem,
  Customer, CustomerType, Personnel, ShipmentStatus, Store, uid,
  ORDER_SOURCE_OPTIONS, configuredPaymentMethod, configuredPaymentMethods,
  isPersonnelResigned, PaymentChannel, PaymentMethodSetting, isPaymentVerified, paymentChannelLabel,
} from "../store";
import { DataTable } from "./common";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { statusRingClass } from "./StatusIcon";
import { toast } from "sonner";
import {
  Fish, CheckCircle, XCircle, Eye, ShoppingCart, Plus, Trash2,
  ChevronDown, Check, Truck, X, MapPin, AlertTriangle,
  Camera, Clock, PackageCheck, Download, Video, ArrowRightLeft,
  Phone, MessageCircle, UserRound, RotateCcw, Search,
  ChevronLeft, ChevronRight, Loader2, Send, ShieldCheck, Tag, Gavel,
  CircleDollarSign,
} from "lucide-react";
import { ShipDialog, ShipFormData } from "./ShipDialog";
import { getShippedOutStockIds, isPhysicallyInTank } from "../utils/inventory";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";
import { ORIGINAL_VIDEO_ACCEPT, downloadMedia, resolveMediaUrl, uploadOriginalMedia } from "../utils/media";
import { MediaVideo } from "./MediaVideo";
import { authJsonHeaders } from "../utils/authSession";
import { buildPublicSelectionCode } from "../utils/publicSelectionCode";
import { orderSearchRank, rankOrderSearchRows } from "../utils/orderSearch";
import {
  isPlatformOrderSource,
  isPlatformPaymentChannel,
  orderSourceBadgeClass,
  orderSourceLabel,
  platformOrderDisplayName,
  platformOrderNoForOrder,
  platformOrderNoLabel,
  platformPaymentChannelForOrderSource,
} from "../utils/orderSources";
import {
  formatBioRecordTime,
  minDatetimeForDate,
  normalizeBioRecordTime,
  nowDatetimeLocal,
} from "../utils/localDateTime";
import { PreciseDateTimeInput } from "./PreciseDateTimeInput";

// ─── Constants ────────────────────────────────────────────────────────────────

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
const ORDER_FORM_SCHEMA_VERSION = 2;
const MOBILE_ORDER_PAGE_SIZE = 12;
const NEW_ORDER_SOURCE_CHOICES = [
  {
    value: "平台下单",
    label: "抖音",
    description: "填写抖音订单编号，无需客户和地址",
    icon: Video,
    activeClass: "border-zinc-900 bg-zinc-950 text-white hover:border-black hover:bg-black",
    iconClass: "bg-white/10 text-white",
    descriptionClass: "text-zinc-300",
  },
  {
    value: "闲鱼平台",
    label: "闲鱼",
    description: "填写闲鱼订单编号，无需客户和地址",
    icon: Tag,
    activeClass: "border-amber-400 bg-amber-50 text-amber-950 hover:border-amber-500 hover:bg-amber-100",
    iconClass: "bg-amber-200 text-amber-900",
    descriptionClass: "text-amber-800",
  },
  {
    value: "微拍堂平台",
    label: "微拍堂",
    description: "填写微拍堂订单编号，无需客户和地址",
    icon: Gavel,
    activeClass: "border-red-400 bg-red-50 text-red-900 hover:border-red-500 hover:bg-red-100",
    iconClass: "bg-red-200 text-red-800",
    descriptionClass: "text-red-700",
  },
  {
    value: "私域线上",
    label: "线上私域",
    description: "选择客户、收货地址并按现有流程发货",
    icon: MessageCircle,
    activeClass: "border-emerald-400 bg-emerald-50 text-emerald-900 hover:border-emerald-500 hover:bg-emerald-100",
    iconClass: "bg-emerald-200 text-emerald-800",
    descriptionClass: "text-emerald-700",
  },
  {
    value: "线下",
    label: "线下自提",
    description: "选择客户并确认自提，无需填写发货信息",
    icon: MapPin,
    activeClass: "border-sky-400 bg-sky-50 text-sky-900 hover:border-sky-500 hover:bg-sky-100",
    iconClass: "bg-sky-200 text-sky-800",
    descriptionClass: "text-sky-700",
  },
] as const;

function isPickupOrderSource(source?: string): boolean {
  return ["线下", "线下自提"].includes(String(source ?? "").trim());
}

function paymentMethodsForOrderSource(methods: PaymentMethodSetting[], source?: string): PaymentMethodSetting[] {
  const platformChannel = platformPaymentChannelForOrderSource(source);
  return methods.filter((method) => platformChannel
    ? method.channel === platformChannel
    : !isPlatformPaymentChannel(method.channel));
}

function paymentMethodDisplayLabel(method: Pick<PaymentMethodSetting, "name" | "channel">): string {
  const channelLabel = paymentChannelLabel(method.channel);
  return method.name === channelLabel ? method.name : `${method.name} · ${channelLabel}`;
}

function historicalOrderPaymentMethodId(orderId: string): string {
  return `historical-order-${orderId}`;
}

function customerTypeLabel(type?: CustomerType) {
  if (type === "B") return "B端（批发）";
  if (type === "C") return "C端（零售）";
  return "未设置";
}

function effectiveOrderAddress(order?: Pick<Order, "shippingAddress"> | null, customer?: Pick<Customer, "address"> | null) {
  return String(order?.shippingAddress ?? "").trim() || String(customer?.address ?? "").trim();
}

type OrderPickerItem = {
  stockItemId: string;
  productId: string;
  price: number;
  minReturnPrice: number;
  commissionRate?: number;
};

function normalizeSearchText(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[－–—]/g, "-")
    .replace(/\s+/g, "")
    .trim();
}

function normalizeFishCode(value: unknown): string {
  return normalizeSearchText(value).replace(/[-_]/g, "");
}

function splitFishCodeInput(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\s,，、;；]+/)
    .map((code) => code.trim())
    .filter((code) => {
      const normalized = normalizeFishCode(code);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

type CreditSaleApprover = {
  username: string;
  name: string;
  isAdmin?: boolean;
  isOrderOwner?: boolean;
};

type CreditSaleRequiredPayload = {
  code?: string;
  orderId?: string;
  orderNo?: string;
  outstandingAmount?: number;
  eligibleApprovers?: CreditSaleApprover[];
  selectedApproverUsernames?: string[];
  requesterIsOrderOwner?: boolean;
};

type CreditSaleRequestDialogState = {
  orderId: string;
  orderNo: string;
  outstandingAmount: number;
  eligibleApprovers: CreditSaleApprover[];
  requesterIsOrderOwner: boolean;
};

class OrderApiError extends Error {
  code: string;
  payload: CreditSaleRequiredPayload;

  constructor(message: string, payload: CreditSaleRequiredPayload = {}) {
    super(message);
    this.name = "OrderApiError";
    this.code = String(payload.code ?? "");
    this.payload = payload;
  }
}

async function postOrderApi(path: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/${path}`, {
    method: "POST",
    headers: authJsonHeaders(),
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (result.notification || result.code === "CREDIT_SALE_CONFIRMATION_REQUIRED") {
    window.dispatchEvent(new CustomEvent("fishroom:notifications-refresh"));
  }
  if (!response.ok || !result.ok) {
    throw new OrderApiError(result.error || `HTTP ${response.status}`, result);
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

function countsAsBillableShipment(shipment: Shipment): boolean {
  return shipment.status !== "preparing" && !(shipment.status === "damaged" && shipment.damageResolution === "reship");
}

function countsAsFulfillmentShipment(shipment: Shipment): boolean {
  return shipment.status !== "preparing";
}

function shipmentHasActuallyShipped(shipment: Shipment): boolean {
  if (shipment.shipMethod === "pickup" && shipment.status !== "preparing") return true;
  return ["shipped", "delivered", "damaged"].includes(shipment.status) ||
    Boolean(String(shipment.shippedAt ?? "").trim());
}

function getBillableShippingFee(order: Order, shipments: Shipment[] = []): number {
  const activeShipments = shipments.filter((shipment) =>
    shipment.orderId === order.id && countsAsBillableShipment(shipment)
  );
  if (activeShipments.length === 0) return order.shippingFee ?? 0;
  return activeShipments.reduce((sum, shipment) => sum + (shipment.actualShippingFee ?? 0), 0);
}

function hasActualShippingFee(order: Order, shipments: Shipment[] = []): boolean {
  return shipments.some((shipment) =>
    shipment.orderId === order.id && countsAsBillableShipment(shipment)
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

function calcAmountRefunded(order: Order): number {
  return (order.payments ?? [])
    .filter((payment) => payment.type === "refund" && isPaymentVerified(payment))
    .reduce((sum, payment) => sum + payment.amount, 0);
}

function calcVerifiedNetPayment(order: Order): number {
  return Number((order.payments ?? [])
    .filter(isPaymentVerified)
    .reduce((sum, payment) => payment.type === "refund"
      ? sum - Number(payment.amount ?? 0)
      : sum + Number(payment.amount ?? 0), 0)
    .toFixed(2));
}

function isDamageRefundOrder(order: Order, shipments: Shipment[] = []): boolean {
  const orderShipments = shipments.filter((shipment) => shipment.orderId === order.id);
  return order.status === "damaged" ||
    orderShipments.some((shipment) => shipment.status === "damaged" && shipment.damageResolution === "refund");
}

type OrderStatusTag = {
  label: string;
  className: string;
};

const ORDER_STATUS_TAG_STYLE = {
  pendingShip: "bg-amber-100 text-amber-700",
  outNoTracking: "bg-blue-100 text-blue-700",
  receiving: "bg-purple-100 text-purple-700",
  completed: "bg-emerald-100 text-emerald-700",
  cancelled: "bg-gray-100 text-gray-500",
  damaged: "bg-red-100 text-red-700",
  outbound: "bg-sky-100 text-sky-700",
  delivered: "bg-emerald-100 text-emerald-700",
  paymentVerified: "bg-emerald-100 text-emerald-700",
  paymentPending: "bg-amber-100 text-amber-700",
  paymentCredit: "bg-violet-100 text-violet-700",
  paymentExempt: "bg-cyan-100 text-cyan-700",
};

function getOrderPaymentStatusTag(order: Order, shipments: Shipment[] = []): OrderStatusTag | null {
  if (order.status === "cancelled") return null;
  if (isPlatformOrderSource(order.source)) {
    return { label: "平台免核销", className: ORDER_STATUS_TAG_STYLE.paymentExempt };
  }
  const amountDue = Math.max(0, Number(calcAmountDue(order, shipments).toFixed(2)));
  const verifiedAmount = calcVerifiedNetPayment(order);
  const outstandingAmount = Math.max(0, Number((amountDue - verifiedAmount).toFixed(2)));
  if (outstandingAmount <= 0.005) {
    return { label: "已核销", className: ORDER_STATUS_TAG_STYLE.paymentVerified };
  }
  if (String(order.source ?? "").trim() === "线下") {
    return { label: "线下默认赊销", className: ORDER_STATUS_TAG_STYLE.paymentCredit };
  }
  const approvedAmount = order.creditSaleApproval?.confirmedAt && order.creditSaleApproval?.confirmedBy
    ? Number(order.creditSaleApproval.amount ?? 0)
    : 0;
  if (approvedAmount + 0.005 >= outstandingAmount) {
    return { label: "赊销已确认", className: ORDER_STATUS_TAG_STYLE.paymentCredit };
  }
  return { label: "待核销", className: ORDER_STATUS_TAG_STYLE.paymentPending };
}

function getAllOrderStatusTags(order: Order, shipments: Shipment[] = []): OrderStatusTag[] {
  const paymentTag = getOrderPaymentStatusTag(order, shipments);
  return paymentTag ? [...getOrderStatusTags(order, shipments), paymentTag] : getOrderStatusTags(order, shipments);
}

function getOrderStatusTags(order: Order, shipments: Shipment[] = []): OrderStatusTag[] {
  const orderShipments = shipments.filter((shipment) => shipment.orderId === order.id);
  const hasDamagedShipment = orderShipments.some((shipment) => shipment.status === "damaged");
  const tags: OrderStatusTag[] = [];

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

  const activeShipments = orderShipments.filter(countsAsFulfillmentShipment);
  const activeShippedItemIds = new Set(activeShipments.flatMap((shipment) => shipment.itemStockIds ?? []));
  const inventoryActiveItems = order.items.filter((item) => !item.inventoryRemovedAt);
  const removedInventoryCount = order.items.length - inventoryActiveItems.length;
  const hasUnshippedItems = inventoryActiveItems.some((item) => !activeShippedItemIds.has(item.stockItemId));
  const outboundShipments = activeShipments.filter((shipment) => shipment.status === "outbound");
  const shippedInProgress = activeShipments.filter((shipment) => shipment.status === "shipped");
  const needsTracking = shippedInProgress.some((shipment) =>
    (shipment.shipMethod ?? "express") !== "pickup" && !String(shipment.trackingNo ?? "").trim()
  );
  const waitingReceive = shippedInProgress.some((shipment) =>
    (shipment.shipMethod ?? "express") !== "pickup" && !!String(shipment.trackingNo ?? "").trim()
  );
  const allResolved = activeShipments.length > 0 && activeShipments.every((shipment) =>
    shipment.status === "delivered" || shipment.status === "damaged"
  );

  if (removedInventoryCount > 0) {
    tags.push({
      label: `库存已移除 ${removedInventoryCount} 件`,
      className: ORDER_STATUS_TAG_STYLE.cancelled,
    });
  }

  if (activeShipments.length === 0 && inventoryActiveItems.length > 0) {
    tags.push({
      label: isPickupOrderSource(order.source) ? "待自提" : "待发货",
      className: ORDER_STATUS_TAG_STYLE.pendingShip,
    });
    return tags;
  }

  if (hasUnshippedItems) {
    tags.push({
      label: isPickupOrderSource(order.source) ? "部分未自提" : "部分未发货",
      className: ORDER_STATUS_TAG_STYLE.pendingShip,
    });
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
  if (allResolved && !hasUnshippedItems) {
    tags.push({
      label: isPickupOrderSource(order.source) ? "已自提" : "已签收",
      className: ORDER_STATUS_TAG_STYLE.delivered,
    });
  }

  return tags;
}

function getOrderStatusText(order: Order, shipments: Shipment[] = []): string {
  return getAllOrderStatusTags(order, shipments).map((tag) => tag.label).join("、");
}

function hasPaymentRecords(order: Order): boolean {
  return (order.payments ?? []).length > 0;
}

function todayDateString(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
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
    ? personnel.find((person) =>
        (person.username === username || person.name === username) &&
        !isPersonnelResigned(person)
      )
    : undefined;
  if (currentAccount) return currentAccount.name;
  return personnel.find((person) => !isPersonnelResigned(person))?.name ?? "";
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
    ? personnel.find((person) =>
        (person.username === username || person.name === username) &&
        !isPersonnelResigned(person)
      )
    : undefined;
  add(currentAccount?.name);
  add(currentAccount?.username);
  return aliases;
}

function isActiveOrder(order: Order): boolean {
  return order.status !== "completed" && order.status !== "cancelled";
}

function getContactPersonOptions(personnel: Personnel[], current: string): Personnel[] {
  const activePersonnel = personnel.filter((person) => !isPersonnelResigned(person));
  const names = new Set(activePersonnel.map((person) => person.name));
  if (current && !names.has(current)) {
    return [{ id: `current-${current}`, name: current, role: "历史记录", phone: "", notes: "" }, ...activePersonnel];
  }
  return activePersonnel;
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

function normalizeMoneyAmount(value: unknown): number {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Number(amount.toFixed(2));
}

function normalizeMinReturnPrice(value: unknown): number {
  return normalizeMoneyAmount(value);
}

function itemCommissionAmount(item: { price?: number; minReturnPrice?: number }): number {
  return Math.max(0, normalizeMoneyAmount(item.price) - normalizeMinReturnPrice(item.minReturnPrice));
}

function orderCommissionTotalWithProducts(
  order: Pick<Order, "items">,
  getProduct: (productId: string) => Pick<Product, "minReturnPrice"> | undefined
): number {
  return (order.items ?? []).reduce((sum, item) => {
    const minReturnPrice = orderItemMinReturnPrice(item, getProduct(item.productId));
    return sum + itemCommissionAmount({ ...item, minReturnPrice });
  }, 0);
}

function orderMinimumReturnTotal(items: { minReturnPrice?: number }[]): number {
  return items.reduce((sum, item) => sum + normalizeMinReturnPrice(item.minReturnPrice), 0);
}

function orderGoodsNetTotal(itemsTotal: number, discount: number): number {
  return Number((itemsTotal - normalizeMoneyAmount(discount)).toFixed(2));
}

function productMinReturnPrice(product?: Pick<Product, "minReturnPrice"> | null): number {
  return normalizeMinReturnPrice(product?.minReturnPrice);
}

function orderItemMinReturnPrice(
  item: { minReturnPrice?: number; productId?: string },
  product?: Pick<Product, "minReturnPrice"> | null
): number {
  if (item.minReturnPrice != null) return normalizeMinReturnPrice(item.minReturnPrice);
  return productMinReturnPrice(product);
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
      .filter((shipment) => shipment.orderId === orderId && countsAsFulfillmentShipment(shipment))
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
  orderNotes: string;
  shipmentNotes: string;
  stockNotes: string;
};

type ShipmentWeatherDay = {
  date?: string;
  weather?: string;
  tempMin?: number;
  tempMax?: number;
  precipitationProbabilityMax?: number;
};

type ShipmentWeatherResponse = {
  ok?: boolean;
  locationName?: string;
  forecast?: ShipmentWeatherDay[];
  error?: string;
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
        address: effectiveOrderAddress(order, orderCustomer) || "待确认",
        contactPerson: order.contactPerson || "",
        productName: itemProduct?.name ?? orderItem.productId,
        size: itemProduct?.size ?? "",
        origin: itemProduct?.origin ?? "",
        code: stock?.code ?? "",
        tankName: subTankNameFromState(state, stock?.subTankId),
        stockStatus: stock?.status === "sick" ? "疾病" : stock?.status === "feeding" ? "开口" : "正常",
        price: orderItem.price,
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

function normalizeWeatherAddress(address: unknown): string {
  return String(address ?? "").trim();
}

function formatWeatherDate(date?: string): string {
  const match = String(date ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return String(date ?? "").trim() || "日期未知";
  return `${Number(match[2])}月${Number(match[3])}日`;
}

function formatShipmentWeatherDay(day: ShipmentWeatherDay): string {
  const weather = String(day.weather ?? "").trim() || "天气未知";
  const tempParts = [
    typeof day.tempMin === "number" ? `${Math.round(day.tempMin)}℃` : "",
    typeof day.tempMax === "number" ? `${Math.round(day.tempMax)}℃` : "",
  ].filter(Boolean);
  const temp = tempParts.length === 2 ? `${tempParts[0]}~${tempParts[1]}` : tempParts[0] || "";
  const rain = typeof day.precipitationProbabilityMax === "number"
    ? `降水概率${Math.round(day.precipitationProbabilityMax)}%`
    : "";
  return [formatWeatherDate(day.date), weather, temp, rain].filter(Boolean).join(" ");
}

function formatShipmentWeatherForecast(result?: ShipmentWeatherResponse): string {
  if (!result?.ok || !Array.isArray(result.forecast) || result.forecast.length === 0) {
    return result?.error ? `未获取到预报：${result.error}` : "未获取到预报";
  }
  const location = String(result.locationName ?? "").trim();
  const days = result.forecast.slice(0, 2).map(formatShipmentWeatherDay).filter(Boolean);
  return [location ? `预报地点：${location}` : "", ...days].filter(Boolean).join("；") || "未获取到预报";
}

async function fetchWeatherForecastsForPendingTrackingRows(rows: PendingTrackingShipmentRow[]): Promise<Map<string, string>> {
  const addresses = [...new Set(rows
    .map((row) => normalizeWeatherAddress(row.address))
    .filter((address) => address && address !== "待确认")
  )];
  const forecasts = new Map<string, string>();
  if (addresses.length === 0) return forecasts;

  toast.info("正在获取发货目的地未来两天天气预报…");
  await Promise.all(addresses.map(async (address) => {
    try {
      const response = await fetch(`/api/weather/forecast?address=${encodeURIComponent(address)}`, {
        method: "GET",
        headers: authJsonHeaders(),
      });
      const result = await response.json().catch(() => ({})) as ShipmentWeatherResponse;
      forecasts.set(address, response.ok && result.ok ? formatShipmentWeatherForecast(result) : formatShipmentWeatherForecast({
        ok: false,
        error: String(result?.error ?? `HTTP ${response.status}`),
      }));
    } catch (error) {
      forecasts.set(address, formatShipmentWeatherForecast({
        ok: false,
        error: error instanceof Error ? error.message : "请求失败",
      }));
    }
  }));
  return forecasts;
}

function weatherForPendingTrackingRow(row: PendingTrackingShipmentRow, forecasts: Map<string, string>): string {
  const address = normalizeWeatherAddress(row.address);
  if (!address || address === "待确认") return "地址待确认，未获取到预报";
  return forecasts.get(address) ?? "未获取到预报";
}

async function exportPendingTrackingShipmentsExcel(orders: Order[], state: Store) {
  const rows = collectPendingTrackingShipmentRows(orders, state);

  if (rows.length === 0) {
    toast.error("没有符合条件的发货商品：需已出库、未确认发货且不是上门自取");
    return;
  }

  const shipmentGroupList = groupPendingTrackingRows(rows);
  const weatherForecasts = await fetchWeatherForecastsForPendingTrackingRows(rows);

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
        className: "weather-row",
        cells: ["未来两天天气", weatherForPendingTrackingRow(first, weatherForecasts), "预报来源", "Open-Meteo"],
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
          .weather-row td { background: #ecfdf5; color: #064e3b; }
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

async function exportPendingTrackingShipmentsWord(orders: Order[], state: Store) {
  const rows = collectPendingTrackingShipmentRows(orders, state);
  if (rows.length === 0) {
    toast.error("没有符合条件的发货商品：需已出库、未确认发货且不是上门自取");
    return;
  }

  const shipmentGroupList = groupPendingTrackingRows(rows);
  const weatherForecasts = await fetchWeatherForecastsForPendingTrackingRows(rows);
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
            <tr class="meta-row weather-row">
              <th class="meta-label">未来两天天气</th>
              <td colspan="4">${excelEscape(weatherForPendingTrackingRow(first, weatherForecasts))}</td>
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
          .weather-row th, .weather-row td { background: #ecfdf5; color: #064e3b; }
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
    return [
      index + 1,
      order.orderNo,
      getOrderStatusText(order, state.shipments),
      orderSourceLabel(order.source),
      platformOrderNoForOrder(order),
      orderCustomer?.name ?? (isPlatformOrderSource(order.source) ? platformOrderDisplayName(order) : "—"),
      orderCustomer?.phone || "",
      order.source === "私域线上" ? effectiveOrderAddress(order, orderCustomer) || "" : "",
      order.date,
      isPickupOrderSource(order.source)
        ? "无需发货"
        : order.status === "completed" ? "—" : order.plannedShipDate || "—",
      order.contactPerson || "",
      order.items.length,
      orderShipments.length,
      money(itemSubtotal),
      money(getBillableShippingFee(order, state.shipments)),
      money(order.packagingFee),
      money(order.discount),
      money(amountDue),
      order.notes || "",
    ];
  });

  const productRows = orders.flatMap((order) => {
    const orderCustomer = customer(order.customerId);
    const orderShipments = shipmentsForOrder(order.id);
    const activeShipments = orderShipments.filter(countsAsFulfillmentShipment);
    const shippedItemIds = new Set(activeShipments.flatMap((shipment) => shipment.itemStockIds ?? []));
    return order.items.map((orderItem, index) => {
      const stock = stockItem(orderItem.stockItemId);
      const itemProduct = product(orderItem.productId);
      const itemBatch = batch(stock?.batchId);
      const itemShipment = shipmentForItem(orderShipments, orderItem.stockItemId);
      return [
        order.orderNo,
        orderCustomer?.name ?? (isPlatformOrderSource(order.source) ? platformOrderDisplayName(order) : "—"),
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
        isPickupOrderSource(order.source) ? "无需发货" : effectiveItemPlannedShipDate(order, orderItem) || "",
        stock?.status === "sick" ? "疾病" : stock?.status === "feeding" ? "开口" : "正常",
        stock?.lost
          ? "已损耗"
          : itemShipment?.status === "outbound"
            ? "已出库待发货"
            : shippedItemIds.has(orderItem.stockItemId)
              ? isPickupOrderSource(order.source) ? "已自提" : "已发货"
              : isPickupOrderSource(order.source) ? "待自提" : "待发货",
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
      orderCustomer?.name ?? (isPlatformOrderSource(order.source) ? platformOrderDisplayName(order) : "—"),
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
        ${table("订单汇总", ["序号", "订单号", "状态", "来源", "平台订单编号", "客户", "手机", "收货地址", "下单日期", "预计发货", "订单负责人", "商品数", "发货单数", "商品小计", "计费运费", "包装费", "折扣/优惠", "订单应收", "备注"], orderRows)}
        ${table("商品明细", ["订单号", "客户", "序号", "编号", "库存ID", "商品", "尺寸", "产地", "缸位", "批次", "供应商", "入库日期", "计划发货", "状态", "发货状态", "所属发货单", "售价", "备注"], productRows)}
        ${table("发货信息", ["订单号", "客户", "发货单", "方式", "发货日期", "承运方", "运单号", "状态", "报损处理", "实际运费", "商品数", "商品", "备注"], shipmentRows)}
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
      {getAllOrderStatusTags(order, shipments).map((tag) => (
        <span key={tag.label} className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tag.className}`}>
          {tag.label}
        </span>
      ))}
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
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">订单总数</div>
                <div className="mt-1 text-2xl font-semibold">{customerOrders.length}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  未完成 {activeCount} · 已完成 {completedCount}
                </div>
              </div>
              <div className="rounded-lg border bg-card p-3">
                <div className="text-xs text-muted-foreground">累计订单应收</div>
                <div className="mt-1 text-2xl font-semibold text-sky-700">{money(totalDue)}</div>
                <div className="mt-1 text-xs text-muted-foreground">按当前订单金额计算</div>
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

type OrderRefundDraft = {
  amount: number;
  time: string;
  proof: string[];
  notes: string;
};

function OrderRefundDialog({
  order,
  open,
  saving,
  onOpenChange,
  onConfirm,
}: {
  order: Order | null;
  open: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (draft: OrderRefundDraft) => Promise<boolean>;
}) {
  const { state } = useStore();
  const [draft, setDraft] = useState<OrderRefundDraft>({
    amount: 0,
    time: nowDatetimeLocal(),
    proof: [],
    notes: "",
  });

  useEffect(() => {
    if (!open || !order) return;
    setDraft({
      amount: 0,
      time: nowDatetimeLocal(),
      proof: [],
      notes: "",
    });
  }, [open, order?.id]);

  if (!order) return null;
  const sourcePlatformChannel = platformPaymentChannelForOrderSource(order.source);
  const refundChannel = (sourcePlatformChannel || order.paymentChannel || "") as PaymentChannel | "";
  const refundMethod = configuredPaymentMethod(state.systemSettings, order.paymentMethodId || refundChannel);
  const refundAccount = order.paymentAccount || refundMethod?.account || "";
  const refundMethodName = order.paymentMethodName || refundMethod?.name || (refundChannel ? paymentChannelLabel(refundChannel) : "");
  const platformRefund = isPlatformPaymentChannel(refundChannel);

  const submit = async () => {
    if (!Number.isFinite(draft.amount) || draft.amount <= 0) return toast.error("请输入有效退款金额");
    if (!refundChannel || !refundAccount) return toast.error("该订单的付款方式尚未配置收款账户，请联系管理员处理");
    const confirmed = confirmWrite(
      "登记退款",
      platformRefund
        ? `登记订单「${order.orderNo}」的平台退款 ¥${draft.amount.toFixed(2)}，后续由财务结合平台账单核销。`
        : `登记订单「${order.orderNo}」的账户退款 ¥${draft.amount.toFixed(2)}，后续由财务核对独立出账。`
    );
    if (!confirmed) return;
    if (await onConfirm({ ...draft, notes: draft.notes.trim() })) {
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-h-[92dvh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>登记退款 · {order.orderNo}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>退款金额（元）<span className="ml-0.5 text-red-500">*</span></Label>
            <Input
              type="number"
              min={0}
              step={0.01}
              value={draft.amount || ""}
              onChange={(event) => setDraft((current) => ({ ...current, amount: Number(event.target.value) }))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>退款时间<span className="ml-0.5 text-red-500">*</span></Label>
            <PreciseDateTimeInput
              value={draft.time}
              onChange={(time) => setDraft((current) => ({ ...current, time }))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>退款渠道<span className="ml-0.5 text-red-500">*</span></Label>
            <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">
              {refundMethodName || "未配置"}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>{platformRefund ? "平台账户" : "退款账户"}<span className="ml-0.5 text-red-500">*</span></Label>
            <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">
              {refundAccount || "未配置"}
            </div>
          </div>
          <div className={`sm:col-span-2 rounded-md border px-3 py-2 text-sm ${platformRefund ? "border-rose-200 bg-rose-50 text-rose-800" : "border-sky-200 bg-sky-50 text-sky-800"}`}>
            {platformRefund
              ? "平台退款：冲减抖店待结算资金，不登记为对公账户出账。"
              : "账户退款：保留原收款入账和本次退款出账两条独立核销记录。"}
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>备注</Label>
            <Textarea
              rows={3}
              value={draft.notes}
              onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
              placeholder="退款原因或客户说明"
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>退款凭证</Label>
            <ProofUploader images={draft.proof} onChange={(proof) => setDraft((current) => ({ ...current, proof }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={() => void submit()} disabled={saving}>{saving ? "保存中..." : "登记退款"}</Button>
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
  saving = false,
  hasActuallyShipped = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  order: Order | null;
  item: OrderItem | null;
  product?: Product;
  stock?: StockItem;
  saving?: boolean;
  hasActuallyShipped?: boolean;
  onConfirm: () => boolean | Promise<boolean>;
}) {
  if (!order || !item) return null;

  const submit = async () => {
    const ok = await onConfirm();
    if (ok !== false) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{stock?.lost ? "移除损耗商品" : "移除未发货商品"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 py-1">
          <div className="rounded-lg border bg-muted/30 p-3 text-sm">
            <div className="font-medium">{product?.name ?? item.productId}</div>
            <div className="text-xs text-muted-foreground mt-1">
              订单售价 ¥{item.price.toFixed(2)}
              {stock?.code ? ` · 鱼码 ${stock.code}` : ""}
            </div>
            {stock?.lost && (
              <div className="mt-2 rounded border border-red-100 bg-red-50 px-2 py-1.5 text-xs text-red-700">
                该商品已损耗，不能发货；确认后会从订单商品中移除。
              </div>
            )}
          </div>
          <div className="rounded-lg border border-sky-100 bg-sky-50 px-3 py-2 text-xs text-sky-800">
            {hasActuallyShipped
              ? `确认后会从订单中移除此未发货商品，订单应收自动减少 ¥${item.price.toFixed(2)}。该订单已有商品发货，不能再登记普通退款；已发货商品退款必须走报损退款。`
              : `确认后会从订单中移除此商品，订单应收自动减少 ¥${item.price.toFixed(2)}。如需退回资金，可在本订单登记退款。`}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
          <Button onClick={submit} disabled={saving}>{saving ? "保存中..." : "确认移除"}</Button>
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
  const [resolution, setResolution] = useState<"refund" | "reship" | null>(null);
  const [damagedItemIds, setDamagedItemIds] = useState<string[]>([]);
  const [refundAmountByStockId, setRefundAmountByStockId] = useState<Record<string, number>>({});
  const [refundNotes, setRefundNotes] = useState("物流报损，待退款");
  const [reshipNotes, setReshipNotes] = useState("物流报损，安排补发");
  const [proof, setProof] = useState<string[]>([]);
  const [replacementByOriginal, setReplacementByOriginal] = useState<Record<string, string>>({});
  const [replacementGroupByOriginal, setReplacementGroupByOriginal] = useState<Record<string, string>>({});
  const [replacementSubTankByOriginal, setReplacementSubTankByOriginal] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) {
      const shippedIds = new Set(shipment?.itemStockIds ?? []);
      const shipmentItems = (order?.items ?? []).filter((item) => shippedIds.has(item.stockItemId));
      setResolution(null);
      setDamagedItemIds([]);
      setRefundAmountByStockId(Object.fromEntries(
        shipmentItems.map((item) => [item.stockItemId, Number(item.price.toFixed(2))])
      ));
      setRefundNotes("物流报损，待退款");
      setReshipNotes("物流报损，安排补发");
      setProof([]);
      setReplacementByOriginal({});
      setReplacementGroupByOriginal({});
      setReplacementSubTankByOriginal({});
    }
  }, [open, shipment?.id, order?.id]);

  if (!shipment || !order) return null;

  const damagedItems = order.items.filter((item) => (shipment.itemStockIds ?? []).includes(item.stockItemId));
  const damagedItemIdSet = new Set(damagedItemIds);
  const selectedDamagedItems = damagedItems.filter((item) => damagedItemIdSet.has(item.stockItemId));
  const selectedRefundSubtotal = selectedDamagedItems.reduce((sum, item) => sum + item.price, 0);
  const selectedRefundAmount = selectedDamagedItems.reduce(
    (sum, item) => sum + (refundAmountByStockId[item.stockItemId] ?? 0),
    0
  );
  const maxRefundForSelection = selectedRefundSubtotal;
  const selectedReplacementIds = new Set(Object.values(replacementByOriginal).filter(Boolean));
  const reshipSelectionComplete = selectedDamagedItems.length > 0 && selectedDamagedItems.every(
    (item) => Boolean(replacementByOriginal[item.stockItemId])
  );

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

  const setDamagedItemChecked = (stockItemId: string, checked: boolean) => {
    const targetItem = damagedItems.find((item) => item.stockItemId === stockItemId);
    setDamagedItemIds((current) => {
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
    if (!checked) {
      setReplacementByOriginal((current) => {
        const next = { ...current };
        delete next[stockItemId];
        return next;
      });
      setReplacementGroupByOriginal((current) => {
        const next = { ...current };
        delete next[stockItemId];
        return next;
      });
      setReplacementSubTankByOriginal((current) => {
        const next = { ...current };
        delete next[stockItemId];
        return next;
      });
    }
  };

  const setRefundItemAmount = (stockItemId: string, value: string) => {
    setRefundAmountByStockId((current) => ({
      ...current,
      [stockItemId]: value === "" ? 0 : Number(value),
    }));
  };

  const submit = async () => {
    if (selectedDamagedItems.length === 0) return toast.error("请先选择本次报损的鱼");
    if (!resolution) return toast.error("请选择退款或补发处理方式");
    let result: DamageResult;
    if (resolution === "refund") {
      if (!selectedRefundAmount || selectedRefundAmount <= 0) return toast.error("请输入有效待退款金额");
      const invalidRefundItem = selectedDamagedItems.find((item) => {
        const itemAmount = refundAmountByStockId[item.stockItemId] ?? 0;
        return itemAmount < 0 || itemAmount > item.price + 0.005;
      });
      if (invalidRefundItem) {
        const product = getProduct(invalidRefundItem.productId);
        return toast.error(`${product?.name ?? invalidRefundItem.productId} 的待退款金额不能超过售价 ¥${invalidRefundItem.price.toFixed(2)}`);
      }
      if (selectedRefundAmount > maxRefundForSelection + 0.005)
        return toast.error(`退款金额不能超过已选商品可退金额 ¥${maxRefundForSelection.toFixed(2)}`);
      const refundItemText = selectedDamagedItems.map((item) => {
        const product = getProduct(item.productId);
        const stock = getStockItem(item.stockItemId);
        const itemRefundAmount = refundAmountByStockId[item.stockItemId] ?? 0;
        return `${product?.name ?? item.productId}${stock?.code ? `(${stock.code})` : ""}（售价¥${item.price.toFixed(2)}，退款¥${itemRefundAmount.toFixed(2)}）`;
      }).join("、");
      result = {
        resolution: "refund",
        damagedItemStockIds: selectedDamagedItems.map((item) => item.stockItemId),
        refundAmount: Number(selectedRefundAmount.toFixed(2)),
        proof,
        notes: `${refundNotes.trim() || "物流报损，待退款"}；退款商品：${refundItemText}`,
      };
    } else {
      const replacements = selectedDamagedItems.map((item) => ({
        originalStockItemId: item.stockItemId,
        replacementStockItemId: replacementByOriginal[item.stockItemId] ?? "",
      }));
      if (replacements.some((item) => !item.replacementStockItemId))
        return toast.error("请选择补发库存鱼");
      if (new Set(replacements.map((item) => item.replacementStockItemId)).size !== replacements.length)
        return toast.error("同一条库存鱼不能重复补发");
      result = {
        resolution: "reship",
        notes: reshipNotes.trim() || "物流报损，安排补发",
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
        style={{ width: "min(94vw, 1180px)", maxWidth: "min(94vw, 1180px)" }}
      >
        <DialogHeader>
          <DialogTitle>物流报损处理</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 py-1 pr-1">
          <div className="rounded-lg border border-red-100 bg-red-50/60 p-3 text-sm text-red-800">
            先选择本次实际报损的鱼，再选择退款或补发。未勾选的鱼保持原发货记录，不受本次操作影响。
          </div>
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex size-6 items-center justify-center rounded-full bg-foreground text-xs text-background">1</span>
                选择本次报损的鱼<span className="text-red-500">*</span>
              </Label>
              <span className={`rounded-full px-2 py-1 text-xs font-medium ${
                selectedDamagedItems.length > 0 ? "bg-red-100 text-red-700" : "bg-muted text-muted-foreground"
              }`}>
                已选 {selectedDamagedItems.length} / {damagedItems.length} 条
              </span>
            </div>
            <div className="max-h-72 overflow-y-auto rounded-lg border p-2">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {damagedItems.map((item) => {
                  const product = getProduct(item.productId);
                  const stock = getStockItem(item.stockItemId);
                  const checked = damagedItemIdSet.has(item.stockItemId);
                  const iconUrl = stock ? getReplacementIcon(stock) : product?.imageUrl ?? "";
                  return (
                    <label
                      key={item.stockItemId}
                      htmlFor={`damage-item-${item.stockItemId}`}
                      className={`grid min-h-[68px] cursor-pointer grid-cols-[auto_44px_minmax(0,1fr)] items-center gap-2 rounded-md border p-2 transition-colors ${
                        checked ? "border-red-400 bg-red-50 ring-1 ring-red-200" : "bg-background hover:bg-muted/50"
                      }`}
                    >
                      <Checkbox
                        id={`damage-item-${item.stockItemId}`}
                        checked={checked}
                        onCheckedChange={(value) => setDamagedItemChecked(item.stockItemId, value === true)}
                      />
                      <div className="size-11 overflow-hidden rounded border bg-muted">
                        {iconUrl
                          ? <ImageWithFallback src={iconUrl} alt="" className="size-full object-cover" />
                          : <div className="flex size-full items-center justify-center"><Fish className="size-4 text-muted-foreground" /></div>}
                      </div>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <span className="truncate text-sm font-semibold">{product?.name ?? item.productId}</span>
                          <span className="shrink-0 text-xs font-medium">¥{item.price.toFixed(2)}</span>
                        </div>
                        <div className="mt-0.5 truncate text-xs font-medium text-foreground">
                          鱼码：{stock?.code || "无编号"}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {tankName(stock?.subTankId)}{productSummary(product) ? ` · ${productSummary(product)}` : ""}
                        </div>
                      </div>
                    </label>
                  );
                })}
                {damagedItems.length === 0 && (
                  <div className="p-4 text-center text-sm text-muted-foreground sm:col-span-2 lg:col-span-3 xl:col-span-4">该发货单没有可报损的鱼</div>
                )}
              </div>
            </div>
          </div>
          <div className="grid gap-2">
            <Label className="flex items-center gap-2 text-sm font-semibold">
              <span className="flex size-6 items-center justify-center rounded-full bg-foreground text-xs text-background">2</span>
              选择处理方式<span className="text-red-500">*</span>
            </Label>
            <Tabs
              value={resolution ?? ""}
              onValueChange={(value) => setResolution(value as "refund" | "reship")}
              className="gap-0"
            >
              <TabsList className="grid h-11 w-full grid-cols-2 rounded-none border-b-2 border-neutral-400 bg-transparent p-0">
                <TabsTrigger
                  value="refund"
                  disabled={selectedDamagedItems.length === 0}
                  className="h-11 rounded-b-none rounded-t-md border border-transparent bg-neutral-200 text-neutral-700 data-[state=active]:relative data-[state=active]:z-10 data-[state=active]:-mb-0.5 data-[state=active]:border-neutral-400 data-[state=active]:border-b-red-50 data-[state=active]:bg-red-50 data-[state=active]:text-red-800 data-[state=active]:shadow-none"
                >
                  <CircleDollarSign className="size-4" />
                  退款处理
                </TabsTrigger>
                <TabsTrigger
                  value="reship"
                  disabled={selectedDamagedItems.length === 0}
                  className="h-11 rounded-b-none rounded-t-md border border-transparent bg-neutral-200 text-neutral-700 data-[state=active]:relative data-[state=active]:z-10 data-[state=active]:-mb-0.5 data-[state=active]:border-neutral-400 data-[state=active]:border-b-sky-50 data-[state=active]:bg-sky-50 data-[state=active]:text-sky-800 data-[state=active]:shadow-none"
                >
                  <ArrowRightLeft className="size-4" />
                  补发处理
                </TabsTrigger>
              </TabsList>
              <TabsContent value="refund" className="mt-0 grid gap-4 rounded-b-md border border-t-0 border-neutral-400 bg-red-50 p-3 sm:p-4">
                <div className="grid gap-3">
              <div className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Label>填写已选报损鱼的退款金额</Label>
                  <span className="text-xs text-muted-foreground">
                    {selectedDamagedItems.length} 条 / 售价 ¥{selectedRefundSubtotal.toFixed(2)} / 退款 ¥{selectedRefundAmount.toFixed(2)}
                  </span>
                </div>
                <div className="max-h-56 overflow-y-auto rounded-lg border divide-y">
                  {selectedDamagedItems.map((item) => {
                    const product = getProduct(item.productId);
                    const stock = getStockItem(item.stockItemId);
                    const itemRefundAmount = refundAmountByStockId[item.stockItemId] ?? 0;
                    return (
                      <div key={item.stockItemId} className="grid gap-2 px-3 py-2.5 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_88px_132px] sm:items-start sm:gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{product?.name ?? item.productId} · {stock?.code || "无编号"}</div>
                          <div className="text-xs text-muted-foreground">
                            {tankName(stock?.subTankId)}
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
                            value={itemRefundAmount || ""}
                            onChange={(event) => setRefundItemAmount(item.stockItemId, event.target.value)}
                            className="h-8 text-right"
                            placeholder="0.00"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  每条鱼的应收调减金额可按协商结果修改，但不能超过该鱼售价和已选商品总售价。
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>退款金额合计</Label>
                  <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-base font-semibold text-red-600">
                    ¥{selectedRefundAmount.toFixed(2)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    当前最多可调减订单应收 ¥{maxRefundForSelection.toFixed(2)}
                  </p>
                </div>
                <div className="rounded-lg border border-orange-100 bg-orange-50 px-3 py-2 text-xs text-orange-800">
                  确认后会登记报损退款并调减订单应收；如已收款，财务台账会据此显示待退款并由财务核销。
                </div>
              </div>
                </div>
                <div className="grid gap-2">
                  <Label>报损 / 待退款备注</Label>
                  <textarea
                    value={refundNotes}
                    onChange={(event) => setRefundNotes(event.target.value)}
                    rows={3}
                    className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="填写报损原因、应退金额说明或沟通记录…"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>报损凭证</Label>
                  <ProofUploader images={proof} onChange={setProof} />
                  <p className="text-xs text-muted-foreground">可上传物流异常截图、沟通记录或退款凭证，记录会随报损退款保留。</p>
                </div>
              </TabsContent>
              <TabsContent value="reship" className="mt-0 grid gap-4 rounded-b-md border border-t-0 border-neutral-400 bg-sky-50 p-3 sm:p-4">
                <div className="grid gap-2">
              <Label>为已选报损鱼指定补发鱼<span className="text-red-500 ml-0.5">*</span></Label>
              <div className="rounded-lg border divide-y">
                {selectedDamagedItems.map((item) => {
                  const product = getProduct(item.productId);
                  const originalStock = getStockItem(item.stockItemId);
                  const groupOptions = availableReplacementGroups(item);
                  const selectedGroupId = replacementGroupByOriginal[item.stockItemId] ?? "";
                  const tankOptions = selectedGroupId ? availableReplacementTanks(item, selectedGroupId) : [];
                  const selectedTankId = replacementSubTankByOriginal[item.stockItemId] ?? "";
                  const options = selectedTankId ? availableReplacementOptions(item, selectedTankId) : [];
                  const selected = replacementByOriginal[item.stockItemId] ?? "";
                  return (
                    <div key={item.stockItemId} className="grid gap-3 p-3">
                      <div className="sticky top-0 z-10 rounded-lg border border-red-200 bg-red-50 p-3 shadow-sm">
                        <div className="mb-1 text-[11px] font-semibold text-red-700">当前补发对应的报损鱼</div>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="break-words text-sm font-semibold text-red-800">
                              {product?.name ?? item.productId} · 鱼码 {originalStock?.code || "无编号"}
                            </div>
                            <div className="break-words text-xs text-muted-foreground">
                              {tankName(originalStock?.subTankId)}
                              {productSummary(product) ? ` · ${productSummary(product)}` : ""}
                              {originalStock?.notes ? ` · 库存备注 ${originalStock.notes}` : ""}
                            </div>
                          </div>
                          <span className="shrink-0 text-xs font-medium text-red-700">原售价 ¥{item.price.toFixed(2)}</span>
                        </div>
                      </div>
                      <div className="grid gap-3 rounded-lg border bg-muted/10 p-3">
                        <div className="grid gap-2">
                          <div className="text-xs font-medium text-muted-foreground">A. 选择补发鱼所在缸组</div>
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
                            <div className="text-xs font-medium text-muted-foreground">B. 选择子缸</div>
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
                              <div className="text-xs font-medium text-muted-foreground">C. 选择具体补发鱼</div>
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
                {selectedDamagedItems.length === 0 && (
                  <div className="p-4 text-sm text-center text-muted-foreground">请先选择本次报损的鱼</div>
                )}
              </div>
              {Object.values(replacementByOriginal).some(Boolean) && (
                <div className="grid gap-2 rounded-lg border border-emerald-200 bg-emerald-50/70 p-3">
                  <div className="text-xs font-semibold text-emerald-800">本次补发关系</div>
                  {selectedDamagedItems.map((item) => {
                    const replacementStockItemId = replacementByOriginal[item.stockItemId];
                    if (!replacementStockItemId) return null;
                    const originalStock = getStockItem(item.stockItemId);
                    const originalProduct = getProduct(item.productId);
                    const replacementStock = getStockItem(replacementStockItemId);
                    const replacementProduct = replacementStock ? getProduct(replacementStock.productId) : undefined;
                    return (
                      <div key={item.stockItemId} className="grid items-center gap-2 rounded-md border border-emerald-100 bg-white px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                        <div className="min-w-0">
                          <div className="break-words font-medium text-red-700">原报损：{originalProduct?.name ?? "未知商品"} · {originalStock?.code || "无编号"}</div>
                          <div className="break-words text-xs text-muted-foreground">{tankName(originalStock?.subTankId)}</div>
                        </div>
                        <ArrowRightLeft className="size-4 shrink-0 text-emerald-600" />
                        <div className="min-w-0">
                          <div className="break-words font-medium text-emerald-700">补发：{replacementProduct?.name ?? "未知商品"} · {replacementStock?.code || "无编号"}</div>
                          <div className="break-words text-xs text-muted-foreground">{tankName(replacementStock?.subTankId)}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                补发可以从当前所有未售且还在有效缸位里的库存鱼中选择；按缸组、子缸、具体鱼逐级选择，避免选错。
              </p>
                </div>
                <div className="grid gap-2">
                  <Label>报损 / 补发备注</Label>
                  <textarea
                    value={reshipNotes}
                    onChange={(event) => setReshipNotes(event.target.value)}
                    rows={3}
                    className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="填写报损原因、补发说明或沟通记录…"
                  />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={!resolution || selectedDamagedItems.length === 0 || (resolution === "reship" && !reshipSelectionComplete)}
          >
            <XCircle className="size-4 mr-1" />
            {!resolution ? "请先选择处理方式" : resolution === "refund" ? "确认报损退款" : "确认报损补发"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
        entry.status !== "cancelled" &&
        entry.items.some((orderItem) =>
          orderItem.stockItemId === item.id && !orderItem.inventoryRemovedAt
        )
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
      toast.success(`已登记损耗；请到订单 ${order.orderNo} 中移除该商品，需要退款时在订单详情登记`);
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
                              <PreciseDateTimeInput
                                min={minDatetimeForDate(item.inDate)}
                                max={nowForRecord}
                                value={editingRecordTime}
                                onChange={setEditingRecordTime}
                                className="w-full sm:w-72 [&_input]:h-7 [&_input]:text-xs"
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
                                        await downloadMedia(src, `video-${videoIndex + 1}.mp4`, { mediaType: "video" });
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
                    <PreciseDateTimeInput
                      min={minDatetimeForDate(item.inDate)}
                      max={nowForRecord}
                      value={newRecord.date}
                      onChange={changeBioRecordDate}
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
                这条鱼已关联销售订单「{order.orderNo}」。确认损耗后会在订单商品上标记「损耗」，该商品不可发货；请到订单详情中移除该商品，需要退款时在订单详情登记。
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

  const replacementSide = (replacement: ShipmentDamageReplacement, side: "original" | "replacement") => {
    const stockItemId = side === "original" ? replacement.originalStockItemId : replacement.replacementStockItemId;
    const stock = getStockItem(stockItemId);
    const snapshotProductId = side === "original" ? replacement.originalProductId : replacement.replacementProductId;
    const product = getProduct(stock?.productId || snapshotProductId || "");
    const productName = side === "original" ? replacement.originalProductName : replacement.replacementProductName;
    const fishCode = side === "original" ? replacement.originalFishCode : replacement.replacementFishCode;
    const tankName = side === "original" ? replacement.originalTankName : replacement.replacementTankName;
    return {
      stockItemId,
      productName: productName || product?.name || "未知商品",
      fishCode: fishCode || stock?.code || "无编号",
      tankName: tankName || (stock ? subTankName(stock.subTankId) : "未知缸位"),
    };
  };

  const renderItemRow = (item: OrderItem, idx: number, options?: { damageRefunded?: boolean }) => {
    const p = getProduct(item.productId);
    const s = getStockItem(item.stockItemId);
    const isLost = !!s?.lost;
    const inventoryRemoved = Boolean(item.inventoryRemovedAt);
    const isUnshipped = !inventoryRemoved && !shippedItemIds.has(item.stockItemId);
    const damageRefunded = !!options?.damageRefunded;
    const minReturnPrice = orderItemMinReturnPrice(item, p);
    const commissionAmount = itemCommissionAmount({ ...item, minReturnPrice });
    return (
      <tr
        key={item.stockItemId ?? idx}
        className={`group border-t transition-colors ${inventoryRemoved ? "bg-slate-50/70" : "cursor-pointer hover:bg-muted/20"} ${isLost ? "bg-red-50/40" : ""}`}
        onClick={() => {
          if (!inventoryRemoved) setDetailId(item.stockItemId);
        }}
      >
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
                {inventoryRemoved && <span className="ml-2 rounded bg-slate-200 px-1 py-0.5 text-xs text-slate-700">库存记录已删除</span>}
              </div>
              {p?.size && <div className="text-xs text-muted-foreground">{p.size}{p.origin ? ` · ${p.origin}` : ""}</div>}
            </div>
          </div>
        </td>
        <td className="px-4 py-2.5 text-sm text-muted-foreground">
          {inventoryRemoved ? "已从库存移除" : s ? subTankName(s.subTankId) : "—"}
        </td>
        <td className="px-4 py-2.5 text-sm text-right">¥{item.price.toFixed(2)}</td>
        <td className="px-4 py-2.5 text-sm text-right">¥{minReturnPrice.toFixed(2)}</td>
        <td className="px-4 py-2.5 text-sm text-right text-emerald-700">¥{commissionAmount.toFixed(2)}</td>
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
          ) : !inventoryRemoved ? (
            <span className="text-xs text-sky-600 opacity-0 group-hover:opacity-100 transition-opacity">详情 ›</span>
          ) : (
            <span className="text-xs text-muted-foreground">历史保留</span>
          )}
        </td>
      </tr>
    );
  };

  const unshippedOrderItems = order.items.filter((i) =>
    !i.inventoryRemovedAt && !shippedItemIds.has(i.stockItemId)
  );
  const inventoryRemovedItems = order.items.filter((i) => Boolean(i.inventoryRemovedAt));

  const colHeader = (
    <thead>
      <tr className="border-t bg-muted/10">
        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">商品</th>
        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">缸位</th>
        <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">售价</th>
        <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">最低回厂价</th>
        <th className="text-right px-4 py-2 text-xs text-muted-foreground font-medium">可提成</th>
        <th className="w-12 px-3 py-2" />
      </tr>
    </thead>
  );

  return (
    <>
      {orderShipments.map((sh, si) => {
        const shItems = order.items.filter((i) => (sh.itemStockIds ?? []).includes(i.stockItemId));
        const damageReplacements = sh.damageResolution === "reship" ? (sh.damageReplacements ?? []) : [];
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
            {damageReplacements.length > 0 && (
              <div className="border-t border-sky-100 bg-sky-50/40 px-4 py-3">
                <div className="mb-2 text-xs font-semibold text-sky-800">补发对应关系（{damageReplacements.length} 条）</div>
                <div className="grid gap-2">
                  {damageReplacements.map((replacement) => {
                    const original = replacementSide(replacement, "original");
                    const reship = replacementSide(replacement, "replacement");
                    return (
                      <div key={`${original.stockItemId}-${reship.stockItemId}`} className="grid items-center gap-2 rounded-md border border-sky-100 bg-white px-3 py-2 text-sm sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                        <div className="min-w-0">
                          <div className="truncate font-medium text-red-700">原报损：{original.productName} · {original.fishCode}</div>
                          <div className="truncate text-xs text-muted-foreground">{original.tankName}</div>
                        </div>
                        <ArrowRightLeft className="size-4 shrink-0 text-sky-600" />
                        <button
                          type="button"
                          className="min-w-0 text-left hover:text-sky-700"
                          onClick={() => setDetailId(reship.stockItemId)}
                        >
                          <div className="truncate font-medium text-emerald-700">补发：{reship.productName} · {reship.fishCode}</div>
                          <div className="truncate text-xs text-muted-foreground">{reship.tankName} · 点击查看详情</div>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            {(shItems.length > 0 || damageReplacements.length === 0) && (
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
            )}
          </div>
        );
      })}

      {/* Unshipped items */}
      {unshippedOrderItems.length > 0 && (
        <div>
          <div className="px-4 py-2 flex items-center gap-2 text-xs font-medium border-t bg-amber-50/50 text-amber-800">
            {isPickupOrderSource(order.source)
              ? <MapPin className="size-3.5 shrink-0 opacity-60" />
              : <Plus className="size-3.5 shrink-0 opacity-60" />}
            {isPickupOrderSource(order.source) ? "待自提" : "待发货"}（{unshippedOrderItems.length} 件）
          </div>
          <table className="w-full">
            {colHeader}
            <tbody>
              {unshippedOrderItems.map((item, idx) => renderItemRow(item, idx))}
            </tbody>
          </table>
        </div>
      )}

      {inventoryRemovedItems.length > 0 && (
        <div>
          <div className="flex items-center gap-2 border-t bg-slate-100/70 px-4 py-2 text-xs font-medium text-slate-700">
            库存记录已删除（{inventoryRemovedItems.length} 件，订单历史保留）
          </div>
          <table className="w-full">
            {colHeader}
            <tbody>
              {inventoryRemovedItems.map((item, idx) => renderItemRow(item, idx))}
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
  customerId: string; date: string; source: string; platformOrderNo: string; paymentMethodId: string; paymentChannel: PaymentChannel | ""; shippingAddress: string; plannedShipDate: string; contactPerson: string; notes: string;
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
  const { state, setState } = useStore();
  const permission = usePermission("orders");
  const today = todayDateString();

  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shipDialogOpen, setShipDialogOpen] = useState(false);
  const [shipmentAction, setShipmentAction] = useState<Shipment | null>(null);
  const [shipmentConfirmSaving, setShipmentConfirmSaving] = useState(false);
  const [damageShipment, setDamageShipment] = useState<Shipment | null>(null);
  const [returnItem, setReturnItem] = useState<OrderItem | null>(null);
  const [returnSaving, setReturnSaving] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundSaving, setRefundSaving] = useState(false);
  const [creditSaleRequest, setCreditSaleRequest] = useState<CreditSaleRequestDialogState | null>(null);
  const [selectedCreditApprovers, setSelectedCreditApprovers] = useState<string[]>([]);
  const [requestingCreditApproval, setRequestingCreditApproval] = useState(false);
  const personnel = state.personnel ?? [];
  const defaultContactPerson = getDefaultContactPerson(personnel, state.user?.username);
  const editContactOptions = getContactPersonOptions(personnel, editForm?.contactPerson ?? defaultContactPerson);
  const availablePaymentMethods = configuredPaymentMethods(state.systemSettings);
  const editPaymentOptions = useMemo(() => {
    if (!editForm) return [];
    const options = paymentMethodsForOrderSource(availablePaymentMethods, editForm.source);
    if (!order || editForm.source !== order.source || !order.paymentChannel || !String(order.paymentAccount ?? "").trim()) {
      return options;
    }
    const snapshotId = order.paymentMethodId || historicalOrderPaymentMethodId(order.id);
    const snapshot: PaymentMethodSetting = {
      id: snapshotId,
      name: order.paymentMethodName || paymentChannelLabel(order.paymentChannel),
      channel: order.paymentChannel,
      account: String(order.paymentAccount).trim(),
      enabled: options.some((method) => method.id === snapshotId),
    };
    const existingIndex = options.findIndex((method) => method.id === snapshotId);
    if (existingIndex < 0) return [snapshot, ...options];
    return options.map((method, index) => index === existingIndex ? snapshot : method);
  }, [availablePaymentMethods, editForm, order]);
  const editPaymentMethod = editPaymentOptions.find((method) => method.id === editForm?.paymentMethodId);
  const editPaymentAccount = editPaymentMethod?.account ?? "";

  useEffect(() => {
    if (!open) {
      setEditMode(false);
      setEditForm(null);
      setShipDialogOpen(false);
      setShipmentAction(null);
      setShipmentConfirmSaving(false);
      setDamageShipment(null);
      setReturnItem(null);
      setReturnSaving(false);
      setRefundOpen(false);
      setRefundSaving(false);
      setCreditSaleRequest(null);
      setSelectedCreditApprovers([]);
      setRequestingCreditApproval(false);
    }
  }, [open]);

  const showCreditSaleRequest = (error: unknown): boolean => {
    if (!(error instanceof OrderApiError) || error.code !== "CREDIT_SALE_CONFIRMATION_REQUIRED") return false;
    const payload = error.payload;
    const fallbackOwner = personnel.find((person) =>
      !isPersonnelResigned(person) &&
      String(person.username ?? "").trim() &&
      [person.name, person.username].some((value) => String(value ?? "").trim() === String(order?.contactPerson ?? "").trim())
    );
    const fallbackApproversByUsername = new Map<string, CreditSaleApprover>(
      personnel
        .filter((person) =>
          person.accessRole === "admin" &&
          !isPersonnelResigned(person) &&
          String(person.username ?? "").trim()
        )
        .map((person) => ({
          username: String(person.username).trim(),
          name: String(person.name ?? person.username).trim(),
          isAdmin: true,
          isOrderOwner: String(person.username).trim() === String(fallbackOwner?.username ?? "").trim(),
        }))
        .map((person) => [person.username, person] as const)
    );
    if (fallbackOwner?.username) {
      const username = String(fallbackOwner.username).trim();
      const existing = fallbackApproversByUsername.get(username);
      fallbackApproversByUsername.set(username, {
        username,
        name: String(fallbackOwner.name ?? fallbackOwner.username).trim(),
        isAdmin: existing?.isAdmin === true,
        isOrderOwner: true,
      });
    }
    const fallbackApprovers = [...fallbackApproversByUsername.values()];
    const eligibleApprovers = (Array.isArray(payload.eligibleApprovers)
      ? payload.eligibleApprovers
      : fallbackApprovers)
      .map((person) => ({
        username: String(person?.username ?? "").trim(),
        name: String(person?.name ?? person?.username ?? "").trim(),
        isAdmin: person?.isAdmin === true,
        isOrderOwner: person?.isOrderOwner === true,
      }))
      .filter((person, index, all) =>
        person.username && all.findIndex((item) => item.username === person.username) === index
      );
    const eligibleUsernames = new Set(eligibleApprovers.map((person) => person.username));
    const existingSelection = (Array.isArray(payload.selectedApproverUsernames)
      ? payload.selectedApproverUsernames
      : [])
      .map((username) => String(username ?? "").trim())
      .filter((username, index, all) =>
        username && eligibleUsernames.has(username) && all.indexOf(username) === index
      );
    setCreditSaleRequest({
      orderId: String(payload.orderId ?? order?.id ?? ""),
      orderNo: String(payload.orderNo ?? order?.orderNo ?? ""),
      outstandingAmount: Math.max(0, Number(payload.outstandingAmount ?? 0)),
      eligibleApprovers,
      requesterIsOrderOwner: payload.requesterIsOrderOwner === true ||
        String(fallbackOwner?.username ?? "").trim() === String(state.user?.username ?? "").trim(),
    });
    setSelectedCreditApprovers(existingSelection);
    setShipDialogOpen(false);
    setShipmentAction(null);
    return true;
  };

  const submitCreditSaleRequest = async () => {
    if (!creditSaleRequest || requestingCreditApproval) return;
    if (!creditSaleRequest.requesterIsOrderOwner && selectedCreditApprovers.length === 0) {
      toast.error("请至少选择一位管理员或订单负责人");
      return;
    }
    setRequestingCreditApproval(true);
    try {
      const result = await postOrderApi("orders/credit-sale/request", {
        orderId: creditSaleRequest.orderId,
        recipientUsernames: selectedCreditApprovers,
        outstandingAmount: creditSaleRequest.outstandingAmount,
      });
      applyOrderApiResult(setState, result);
      setCreditSaleRequest(null);
      setSelectedCreditApprovers([]);
      setShipDialogOpen(false);
      setShipmentAction(null);
      window.dispatchEvent(new CustomEvent("fishroom:notifications-refresh"));
      toast.success(result.message || "赊销审批已发送，审批通过后可继续发货");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "发起赊销审批失败，请重试");
    } finally {
      setRequestingCreditApproval(false);
    }
  };

  const enterEdit = () => {
    if (!order) return;
    if (order.status === "completed") return toast.error("已完成订单不能再编辑");
    const sourceMethods = paymentMethodsForOrderSource(availablePaymentMethods, order.source);
    const configuredOrderMethod = order.paymentMethodId
      ? sourceMethods.find((method) => method.id === order.paymentMethodId)
      : sourceMethods.find((method) => method.channel === order.paymentChannel);
    const paymentMethodId = String(order.paymentAccount ?? "").trim() && order.paymentChannel
      ? order.paymentMethodId || historicalOrderPaymentMethodId(order.id)
      : configuredOrderMethod?.id ?? (sourceMethods.length === 1 ? sourceMethods[0].id : "");
    const paymentChannel = order.paymentChannel ?? configuredOrderMethod?.channel ?? "";
    setEditForm({
      customerId: order.customerId, date: order.date, plannedShipDate: order.plannedShipDate ?? "",
      source: order.source ?? "",
      platformOrderNo: platformOrderNoForOrder(order),
      paymentMethodId,
      paymentChannel,
      shippingAddress: order.shippingAddress ?? "",
      contactPerson: order.contactPerson || defaultContactPerson, notes: order.notes ?? "",
      shippingFee: order.shippingFee ?? 0, packagingFee: order.packagingFee ?? 0, discount: order.discount ?? 0,
      items: order.items.map((i) => ({
        stockItemId: i.stockItemId,
        productId: i.productId,
        price: i.price,
        minReturnPrice: orderItemMinReturnPrice(
          i,
          state.products.find((product) => product.id === i.productId)
        ),
        commissionRate: 0,
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
    if (!isPlatformOrderSource(editForm.source) && !editForm.customerId) return toast.error("请选择客户");
    if (isPlatformOrderSource(editForm.source) && !editForm.platformOrderNo.trim()) {
      return toast.error(`请填写${platformOrderNoLabel(editForm.source)}`);
    }
    if (!editForm.paymentMethodId || !editPaymentMethod) return toast.error("请选择付款方式");
    if (!editPaymentAccount) return toast.error("该付款方式未配置收款账户，请联系管理员处理");
    if (!editForm.contactPerson.trim()) return toast.error("请选择订单负责人");
    if (displayAmountDue < 0) return toast.error("折扣过大，订单应收不能为负数");
    if (displayGoodsNetTotal <= displayMinimumReturnTotal)
      return toast.error(`商品折后金额必须高于最低回厂价合计 ¥${displayMinimumReturnTotal.toFixed(2)}`);
    if (!isPickupOrderSource(editForm.source) && !editForm.plannedShipDate) return toast.error("请选择预计发货日期");
    if (editForm.plannedShipDate && editForm.plannedShipDate < editForm.date)
      return toast.error("预计发货日期不能早于下单日期");
    if (!confirmWrite("修改", `将保存订单「${order.orderNo}」的修改。`)) return;
    try {
      const result = await postOrderApi("orders/update", {
        orderFormSchemaVersion: ORDER_FORM_SCHEMA_VERSION,
        orderId: order.id,
        customerId: isPlatformOrderSource(editForm.source) ? "" : editForm.customerId,
        date: editForm.date,
        source: editForm.source.trim(),
        platformOrderNo: isPlatformOrderSource(editForm.source) ? editForm.platformOrderNo.trim() : "",
        douyinOrderNo: editForm.source === "平台下单" ? editForm.platformOrderNo.trim() : "",
        paymentMethodId: editForm.paymentMethodId === historicalOrderPaymentMethodId(order.id)
          ? ""
          : editForm.paymentMethodId,
        paymentChannel: editPaymentMethod.channel,
        shippingAddress: editForm.source === "私域线上" ? editForm.shippingAddress.trim() : "",
        plannedShipDate: isPickupOrderSource(editForm.source) ? "" : editForm.plannedShipDate,
        contactPerson: editForm.contactPerson.trim(),
        notes: editForm.notes,
        shippingFee: isPickupOrderSource(editForm.source) ? 0 : editForm.shippingFee,
        packagingFee: editForm.packagingFee,
        discount: editForm.discount,
        items: editForm.items.map((item) => ({
          ...item,
          minReturnPrice: normalizeMinReturnPrice(item.minReturnPrice),
          commissionRate: 0,
        })),
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
  const changeEditSource = (nextSource: string) => {
    setEditForm((form) => {
      if (!form) return form;
      const nextPaymentMethods = paymentMethodsForOrderSource(availablePaymentMethods, nextSource);
      const selectedPaymentMethod = nextPaymentMethods.find((method) => method.id === form.paymentMethodId) ??
        (nextPaymentMethods.length === 1 ? nextPaymentMethods[0] : undefined);
      return {
        ...form,
        source: nextSource,
        customerId: isPlatformOrderSource(nextSource) ? "" : form.customerId,
        platformOrderNo: isPlatformOrderSource(nextSource) ? form.platformOrderNo : "",
        paymentMethodId: selectedPaymentMethod?.id ?? "",
        paymentChannel: selectedPaymentMethod?.channel ?? "",
        shippingAddress: nextSource === "私域线上" ? form.shippingAddress : "",
        plannedShipDate: isPickupOrderSource(nextSource) ? "" : form.plannedShipDate,
        shippingFee: isPickupOrderSource(nextSource) ? 0 : form.shippingFee,
      };
    });
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
  const displayAddress = effectiveOrderAddress(order, customer);
  const hasOrderAddressOverride = Boolean(String(order?.shippingAddress ?? "").trim());
  const editDefaultAddress = String(customer?.address ?? "").trim();

  const displayItems = editMode && editForm ? editForm.items : (order?.items ?? []);
  const displayItemsWithMinimumReturn = displayItems.map((item) => ({
    ...item,
    minReturnPrice: orderItemMinReturnPrice(item, getProduct(item.productId)),
  }));
  const displayItemsTotal = displayItemsWithMinimumReturn.reduce((s, i) => s + i.price, 0);
  const displayShipping  = (editMode && editForm ? editForm.shippingFee  : order?.shippingFee)  ?? 0;
  const displayPackaging = (editMode && editForm ? editForm.packagingFee : order?.packagingFee) ?? 0;
  const displayDiscount  = (editMode && editForm ? editForm.discount     : order?.discount)     ?? 0;
  const displayGoodsNetTotal = orderGoodsNetTotal(displayItemsTotal, displayDiscount);
  const displayMinimumReturnTotal = orderMinimumReturnTotal(displayItemsWithMinimumReturn);
  const displayCommissionTotal = displayItemsWithMinimumReturn.reduce((s, i) => s + itemCommissionAmount(i), 0);
  const displayBelowMinimumReturn = displayItemsWithMinimumReturn.length > 0 && displayGoodsNetTotal <= displayMinimumReturnTotal;
  const draftAmountDue = displayItemsTotal + displayShipping + displayPackaging - displayDiscount;

  const orderShipments = state.shipments.filter((s) => s.orderId === order?.id);
  const damageRefundOrder = !!order && isDamageRefundOrder(order, state.shipments);
  const amountDue = order ? calcAmountDue(order, state.shipments) : 0;
  const damageRefundAdjustment = order ? calcDamageRefundAdjustment(order, state.shipments) : 0;
  const billableShipping = order ? getBillableShippingFee(order, state.shipments) : displayShipping;
  const hasActualShipping = order ? hasActualShippingFee(order, state.shipments) : false;
  const shippingAdjustment = order ? calcShippingAdjustment(order, state.shipments) : 0;
  const displayAmountDue = editMode && editForm ? draftAmountDue : amountDue;

  const activeOrderShipments = orderShipments.filter(countsAsFulfillmentShipment);
  const hasActuallyShipped = orderShipments.some(shipmentHasActuallyShipped);
  const shippedItemIds = new Set(activeOrderShipments.flatMap((s) => s.itemStockIds ?? []));
  const inventoryActiveItems = (order?.items ?? []).filter((item) => !item.inventoryRemovedAt);
  const unshippedItems = inventoryActiveItems.filter((i) => !shippedItemIds.has(i.stockItemId));
  const lostUnshippedItems = unshippedItems.filter((i) => state.stock.find((s) => s.id === i.stockItemId)?.lost);
  const shippableUnshippedItems = unshippedItems.filter((i) => {
    const stockItem = state.stock.find((s) => s.id === i.stockItemId);
    return Boolean(stockItem) && !stockItem?.lost;
  });
  const allItemsShipped = inventoryActiveItems.length > 0 && unshippedItems.length === 0;
  const allShipmentsResolved = activeOrderShipments.length > 0 && activeOrderShipments.every((s) =>
    s.status === "delivered" || s.status === "damaged"
  );
  const canCompleteOrder = !!order &&
    order.status !== "cancelled" &&
    order.status !== "completed" &&
    allItemsShipped &&
    allShipmentsResolved;
  const canShip = !!order && shippableUnshippedItems.length > 0
    && order.status !== "cancelled" && order.status !== "completed";
  const canReturnOrderItem = !!order && order.status !== "cancelled" && order.status !== "completed" && permission.canUpdate;
  const returnStock = returnItem ? state.stock.find((stock) => stock.id === returnItem.stockItemId) : undefined;
  const returnProduct = returnItem ? getProduct(returnItem.productId) : undefined;

  const openReturnItem = (item: OrderItem) => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (item.inventoryRemovedAt) return toast.error("该商品的库存记录已删除，订单历史仅供查看");
    if (order.status === "completed") return toast.error("已完成订单不能退商品");
    if (order.status === "cancelled") return toast.error("已取消订单不能退商品");
    if (shippedItemIds.has(item.stockItemId)) return toast.error("该商品已出库或已发货，不能从订单中移除");
    setReturnItem(item);
  };

  const submitReturnItem = async () => {
    if (!order || !returnItem) return false;
    if (!permission.requirePermission("update")) return false;
    if (returnSaving) return false;
    if (order.status === "completed") { toast.error("已完成订单不能退商品"); return false; }
    if (order.status === "cancelled") { toast.error("已取消订单不能退商品"); return false; }
    if (shippedItemIds.has(returnItem.stockItemId)) { toast.error("该商品已出库或已发货，不能从订单中移除"); return false; }
    if (!confirmWrite("修改", "将从订单中移除该商品，并同步调整订单应收。")) return false;
    setReturnSaving(true);
    try {
      const result = await postOrderApi("orders/return-item", {
        orderId: order.id,
        stockItemId: returnItem.stockItemId,
      });
      applyOrderApiResult(setState, result);
      setReturnItem(null);
      toast.success("商品已移除，订单应收已更新");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
      return false;
    } finally {
      setReturnSaving(false);
    }
  };

  const submitOrderRefund = async (draft: OrderRefundDraft) => {
    if (!order || refundSaving || !permission.requirePermission("update")) return false;
    if (hasActuallyShipped) {
      toast.error("订单已经发货，不能登记普通退款，请在对应发货单使用报损退款");
      return false;
    }
    setRefundSaving(true);
    try {
      const result = await postOrderApi("orders/refund", {
        orderId: order.id,
        ...draft,
      });
      applyOrderApiResult(setState, result);
      toast.success(isPlatformOrderSource(order.source) || isPlatformPaymentChannel(order.paymentChannel)
        ? "平台退款已登记，待财务按平台账单核销"
        : "账户退款已登记，待财务核对出账");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "退款登记失败，请重试");
      return false;
    } finally {
      setRefundSaving(false);
    }
  };

  const completeOrder = async () => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (!allItemsShipped)
      return toast.error(isPickupOrderSource(order.source)
        ? "尚有商品未自提，请先完成所有自提再确认完成"
        : "尚有商品未发货，请先完成所有发货再确认完成");
    if (!allShipmentsResolved)
      return toast.error("尚有发货未签收或报损未完成处理，请先处理完发货状态");
    if (!confirmWrite("完成", `将订单「${order.orderNo}」标记为已完成，完成后不可再编辑。`)) return;
    try {
      const result = await postOrderApi("orders/complete", { orderId: order.id });
      applyOrderApiResult(setState, result);
      toast.success("订单已完成");
    } catch (error) {
      if (showCreditSaleRequest(error)) return;
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
    }
  };

  const markShipmentDelivered = async (shipment: Shipment) => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (!confirmWrite("修改", "将该发货单状态改为已签收。")) return;
    try {
      const result = await postOrderApi("shipments/deliver", { shipmentId: shipment.id });
      applyOrderApiResult(setState, result);
      setShipmentAction(null);
      toast.success("已确认收货");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
    }
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
      if (showCreditSaleRequest(error)) return;
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setShipmentConfirmSaving(false);
    }
  };

  const cancelShipment = async (shipment: Shipment) => {
    if (!order) return;
    if (!permission.requirePermission("update")) return;
    if (shipmentConfirmSaving) return;
    if (order.status === "completed") return toast.error("已完成订单不能取消发货");
    if (shipment.status !== "outbound" && shipment.status !== "shipped") return toast.error("只有已出库或运输中的发货单可以取消");
    if (!confirmWrite("取消发货", "将取消这条出库/发货记录，商品会回到待发货状态；订单和商品不会被删除。")) return;
    setShipmentConfirmSaving(true);
    try {
      const result = await postOrderApi("shipments/cancel", { shipmentId: shipment.id });
      applyOrderApiResult(setState, result);
      setShipmentAction(null);
      toast.success("已取消出库/发货，商品已回到待发货状态");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
    } finally {
      setShipmentConfirmSaving(false);
    }
  };

  const reportShipmentDamage = async (shipment: Shipment, result: DamageResult) => {
    if (!order) return false;
    if (!permission.requirePermission("update")) return false;
    if (shipment.shipMethod === "pickup") { toast.error("上门自取订单不可报损"); return false; }
    if (!confirmWrite("修改", result.resolution === "refund" ? "将发货单报损并登记报损退款，订单应收同步调减，后续由财务核销。" : "将发货单报损并选择库存鱼补发。")) return false;
    try {
      const response = await postOrderApi("shipments/damage", {
        shipmentId: shipment.id,
        ...result,
      });
      applyOrderApiResult(setState, response);
      setShipmentAction(null);
      setDamageShipment(null);
      toast.success(result.resolution === "refund" ? "报损退款已登记，待财务核销" : "已报损，已选择库存鱼进入待发货");
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败，请重试");
      return false;
    }
  };

  const handleShipFromDetail = async (data: ShipFormData) => {
    if (!order) return false;
    if (!permission.requirePermission("update")) return false;
    const lostSelected = data.selectedItemIds.filter((id) => state.stock.find((stock) => stock.id === id)?.lost);
    if (lostSelected.length > 0) { toast.error("已损耗商品不能出库，请先从订单中删除"); return false; }
    const confirmDetail = data.shipMethod === "pickup"
      ? `将确认 ${data.selectedItemIds.length} 条商品上门自取并直接签收。`
      : `将出库 ${data.selectedItemIds.length} 条商品，后续需上传打包凭证再确认发货。`;
    if (!confirmWrite(data.shipMethod === "pickup" ? "确认自提" : "出库", confirmDetail)) return false;
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
      if (showCreditSaleRequest(error)) return false;
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
  const refundRecords = (order.payments ?? []).filter((payment) => payment.type === "refund");

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
                {!isPlatformOrderSource(editForm.source) && (
                  <div className="grid gap-1.5">
                    <Label className="text-xs">客户<span className="ml-0.5 text-red-500">*</span></Label>
                    <CustomerCombobox value={editForm.customerId}
                      onChange={(id) => setEditForm((f) => f ? { ...f, customerId: id } : f)}
                      customers={state.customers ?? []} />
                  </div>
                )}
                {isPlatformOrderSource(editForm.source) && (
                  <div className="grid gap-1.5">
                    <Label className="text-xs">{platformOrderNoLabel(editForm.source)}<span className="ml-0.5 text-red-500">*</span></Label>
                    <Input
                      value={editForm.platformOrderNo}
                      placeholder={`请输入${platformOrderNoLabel(editForm.source)}`}
                      onChange={(event) => setEditForm((form) => form ? { ...form, platformOrderNo: event.target.value } : form)}
                      className={!editForm.platformOrderNo.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}
                    />
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label className="text-xs">订单来源<span className="text-red-500 ml-0.5">*</span></Label>
                  <Select
                    value={editForm.source}
                    onValueChange={changeEditSource}
                  >
                    <SelectTrigger className={!editForm.source.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}>
                      <SelectValue placeholder="请选择来源" />
                    </SelectTrigger>
                    <SelectContent>
                      {ORDER_SOURCE_OPTIONS.map((source) => (
                        <SelectItem key={source} value={source}>{orderSourceLabel(source)}</SelectItem>
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
                {!isPickupOrderSource(editForm.source) && (
                  <div className="grid gap-1.5">
                    <Label className="text-xs">预计发货日期<span className="text-red-500 ml-0.5">*</span></Label>
                    <Input
                      type="date"
                      value={editForm.plannedShipDate}
                      min={editForm.date}
                      required
                      onChange={(e) => changeEditPlannedShipDate(e.target.value)}
                      className={!editForm.plannedShipDate || editForm.plannedShipDate < editForm.date ? "border-red-500 focus-visible:ring-red-500" : ""}
                    />
                    {!editForm.plannedShipDate && (
                      <p className="text-xs text-red-500">请选择预计发货日期</p>
                    )}
                    {editForm.plannedShipDate && editForm.plannedShipDate < editForm.date && (
                      <p className="text-xs text-red-500">发货日期不能早于下单日期</p>
                    )}
                  </div>
                )}
                <div className="grid gap-1.5">
                  <Label className="text-xs">订单负责人<span className="text-red-500 ml-0.5">*</span></Label>
                  <Select
                    value={editForm.contactPerson}
                    onValueChange={(value) => setEditForm((f) => f ? { ...f, contactPerson: value } : f)}
                  >
                    <SelectTrigger className={!editForm.contactPerson.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}>
                      <SelectValue placeholder="请选择订单负责人" />
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
                  <Label className="text-xs">付款方式<span className="text-red-500 ml-0.5">*</span></Label>
                  <Select
                    value={editForm.paymentMethodId}
                    onValueChange={(value) => {
                      const selectedMethod = editPaymentOptions.find((method) => method.id === value);
                      setEditForm((form) => form && selectedMethod ? {
                        ...form,
                        paymentMethodId: value,
                        paymentChannel: selectedMethod.channel,
                      } : form);
                    }}
                  >
                    <SelectTrigger className={!editForm.paymentMethodId ? "border-red-500 focus-visible:ring-red-500" : ""}>
                      <SelectValue placeholder="请选择付款方式" />
                    </SelectTrigger>
                    <SelectContent>
                      {editPaymentOptions.map((method) => (
                        <SelectItem key={method.id} value={method.id}>
                          {paymentMethodDisplayLabel(method)}{method.enabled ? "" : "（历史）"}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">对应收款账户<span className="text-red-500 ml-0.5">*</span></Label>
                  <div className={`h-10 flex items-center rounded-md border bg-muted/50 px-3 text-sm ${editPaymentAccount ? "text-foreground" : "border-red-500 text-red-500"}`}>
                    {editPaymentAccount || "未配置，请联系管理员"}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label className="text-xs">创建时间</Label>
                  <div className="h-10 flex items-center rounded-md border bg-muted/50 px-3 text-sm text-muted-foreground">
                    {formatOrderCreatedAt(order.createdAt)}
                  </div>
                </div>
                {editForm.source === "私域线上" && (
                  <div className="grid gap-1.5 col-span-4">
                    <Label className="text-xs">本单收货地址</Label>
                    <Input
                      value={editForm.shippingAddress}
                      placeholder={editDefaultAddress ? `不填则使用：${editDefaultAddress}` : "不填则使用客户默认地址"}
                      onChange={(e) => setEditForm((f) => f ? { ...f, shippingAddress: e.target.value } : f)}
                    />
                    <p className="text-xs text-muted-foreground">
                      {editDefaultAddress ? `客户默认地址：${editDefaultAddress}` : "该客户暂无默认地址；本单地址可为空。"}
                    </p>
                  </div>
                )}
                <div className="grid gap-1.5 col-span-5">
                  <Label className="text-xs">备注</Label>
                  <Input value={editForm.notes} placeholder="选填"
                    onChange={(e) => setEditForm((f) => f ? { ...f, notes: e.target.value } : f)} />
                </div>
              </div>
            ) : (
              <div className="rounded-lg border p-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm bg-muted/30">
                {isPlatformOrderSource(order.source) ? (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">{platformOrderNoLabel(order.source)}：</span>
                    <span className="font-medium">{platformOrderNoForOrder(order) || "—"}</span>
                  </div>
                ) : (
                  <>
                    <div><span className="text-muted-foreground">客户：</span><span className="font-medium">{customer?.name ?? "—"}</span></div>
                    <div><span className="text-muted-foreground">手机：</span>{customer?.phone || "—"}</div>
                    <div><span className="text-muted-foreground">微信：</span>{customer?.wechat || "—"}</div>
                    <div><span className="text-muted-foreground">客户来源：</span>{customer?.source || "—"}</div>
                  </>
                )}
                <div><span className="text-muted-foreground">订单来源：</span>{orderSourceLabel(order.source) || "—"}</div>
                <div>
                  <span className="text-muted-foreground">付款方式：</span>
                  {order.paymentMethodName || (order.paymentChannel ? paymentChannelLabel(order.paymentChannel) : "未登记")}
                </div>
                <div>
                  <span className="text-muted-foreground">收款账户：</span>
                  {order.paymentAccount || "未登记"}
                </div>
                <div><span className="text-muted-foreground">创建时间：</span>{formatOrderCreatedAt(order.createdAt)}</div>
                <div><span className="text-muted-foreground">下单日期：</span>{order.date}</div>
                {order.status !== "completed" && !isPickupOrderSource(order.source) && (
                  <div>
                    <span className="text-muted-foreground">预计发货：</span>
                    {order.plannedShipDate
                      ? <span className={order.plannedShipDate === today ? "text-orange-600 font-medium" : ""}>{order.plannedShipDate}</span>
                      : "—"}
                  </div>
                )}
                <div><span className="text-muted-foreground">订单负责人：</span>{order.contactPerson || "—"}</div>
                {order.source === "私域线上" && displayAddress && (
                  <div className="col-span-2">
                    <span className="text-muted-foreground">收货地址：</span>
                    {displayAddress}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {hasOrderAddressOverride ? "本单地址" : "客户默认地址"}
                    </span>
                  </div>
                )}
                {order.notes && <div className="col-span-2"><span className="text-muted-foreground">备注：</span>{order.notes}</div>}
              </div>
            )}

            {order.creditSaleApproval && (
              <div className="flex flex-col gap-1 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-900 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <span className="font-medium">赊销审批记录</span>
                  <span className="ml-2">¥{Number(order.creditSaleApproval.amount ?? 0).toFixed(2)}</span>
                  {order.creditSaleApproval.note && (
                    <span className="ml-2 text-violet-700">{order.creditSaleApproval.note}</span>
                  )}
                </div>
                <div className="text-xs text-violet-700">
                  {order.creditSaleApproval.confirmedByName || order.creditSaleApproval.confirmedBy}
                  <span className="mx-1">·</span>
                  {String(order.creditSaleApproval.confirmedAt ?? "").replace("T", " ").slice(0, 16)}
                </div>
              </div>
            )}

            {refundRecords.length > 0 && (
              <div className="rounded-lg border border-rose-100 bg-rose-50/40">
                <div className="border-b border-rose-100 px-3 py-2 text-xs font-medium text-rose-800">退款记录</div>
                <div className="divide-y divide-rose-100">
                  {[...refundRecords].sort((left, right) => String(right.time).localeCompare(String(left.time))).map((payment) => (
                    <div key={payment.id} className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium text-rose-700">¥{payment.amount.toFixed(2)}</span>
                        <span>{payment.paymentMethodName || (payment.channel ? paymentChannelLabel(payment.channel) : "渠道未登记")}</span>
                        <span className="text-xs text-muted-foreground">{payment.refundMethod === "platform" ? "平台冲减" : "账户出账"}</span>
                        <span className="text-xs text-muted-foreground">{payment.time.replace("T", " ").slice(0, 16)}</span>
                      </div>
                      <Badge variant="outline" className={isPaymentVerified(payment) ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                        {isPaymentVerified(payment) ? "已核销" : "待财务核销"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Items table ── */}
            <div className="rounded-lg border flex flex-col">
              <div className="px-4 py-2 bg-muted/50 text-xs font-medium text-muted-foreground flex items-center justify-between shrink-0 border-b rounded-t-lg">
                <span>订单商品（{displayItems.length} 条）</span>
                {editMode && editForm && (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="text-emerald-600">小计 ¥{displayItemsTotal.toFixed(2)}</span>
                    <span className="text-slate-600">最低回厂价 ¥{displayMinimumReturnTotal.toFixed(2)}</span>
                    <span className="text-emerald-700">可提成 ¥{displayCommissionTotal.toFixed(2)}</span>
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
                          <th className="text-right px-4 py-2 text-xs text-muted-foreground">最低回厂价</th>
                          <th className="text-right px-4 py-2 text-xs text-muted-foreground">可提成</th>
                          <th className="w-10 px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {displayItems.map((item, idx) => {
                          const p = getProduct(item.productId);
                          const s = state.stock.find((x) => x.id === item.stockItemId);
                          const isShipped = shippedItemIds.has(item.stockItemId);
                          const isLost = !!s?.lost;
                          const minReturnPrice = orderItemMinReturnPrice(item, p);
                          const commissionAmount = itemCommissionAmount({ ...item, minReturnPrice });
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
                                    {s?.code && (
                                      <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                                        {s.code}
                                      </span>
                                    )}
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
                                ¥{minReturnPrice.toFixed(2)}
                              </td>
                              <td className="px-4 py-2 text-sm text-right text-emerald-700">
                                ¥{commissionAmount.toFixed(2)}
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
                <div className={`grid gap-3 mb-4 ${isPickupOrderSource(editForm.source) ? "grid-cols-2" : "grid-cols-3"}`}>
                  {!isPickupOrderSource(editForm.source) && (
                    <div className="grid gap-1.5">
                      <Label className="text-xs">订单运费（¥）</Label>
                      <Input type="number" min={0} step={0.01} value={editForm.shippingFee || ""} placeholder="0" className="h-8 text-sm"
                        onChange={(e) => setEditForm((f) => f ? { ...f, shippingFee: Number(e.target.value) } : f)} />
                    </div>
                  )}
                  <div className="grid gap-1.5">
                    <Label className="text-xs">包装费（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={editForm.packagingFee || ""} placeholder="0" className="h-8 text-sm"
                      onChange={(e) => setEditForm((f) => f ? { ...f, packagingFee: Number(e.target.value) } : f)} />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">折扣/优惠（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={editForm.discount || ""} placeholder="0"
                      className={`h-8 text-sm${displayAmountDue < 0 ? " border-red-500 focus-visible:ring-red-500" : ""}`}
                      onChange={(e) => setEditForm((f) => f ? { ...f, discount: Number(e.target.value) } : f)} />
                    {displayAmountDue < 0 && <p className="text-xs text-red-500">折扣导致订单应收为负 ¥{Math.abs(displayAmountDue).toFixed(2)}</p>}
                  </div>
                </div>
                <div className="border-t pt-3 flex flex-col gap-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">商品小计</span><span>¥{displayItemsTotal.toFixed(2)}</span></div>
                  {displayDiscount > 0 && <div className="flex justify-between text-orange-600"><span>− 折扣</span><span>¥{displayDiscount.toFixed(2)}</span></div>}
                  <div className="flex justify-between"><span className="text-muted-foreground">商品折后金额</span><span>¥{displayGoodsNetTotal.toFixed(2)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">最低回厂价合计</span><span>¥{displayMinimumReturnTotal.toFixed(2)}</span></div>
                  <div className="flex justify-between text-emerald-700"><span>可提成金额</span><span>¥{displayCommissionTotal.toFixed(2)}</span></div>
                  {displayBelowMinimumReturn && (
                    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      商品折后金额必须高于最低回厂价合计。
                    </div>
                  )}
                  {displayShipping > 0 && <div className="flex justify-between"><span className="text-muted-foreground">+ 运费</span><span>¥{displayShipping.toFixed(2)}</span></div>}
                  {displayPackaging > 0 && <div className="flex justify-between"><span className="text-muted-foreground">+ 包装费</span><span>¥{displayPackaging.toFixed(2)}</span></div>}
                  <div className="flex justify-between font-semibold text-base border-t pt-2 mt-1">
                    <span>订单应收</span>
                    <span className={displayAmountDue < 0 ? "text-red-600" : "text-sky-700"}>¥{displayAmountDue.toFixed(2)}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border p-4 flex flex-col gap-2 text-sm">
                <div className="text-xs font-medium text-muted-foreground mb-1">费用明细</div>
                <div className="flex justify-between"><span className="text-muted-foreground">商品小计</span><span>¥{displayItemsTotal.toFixed(2)}</span></div>
                {displayDiscount > 0 && <div className="flex justify-between text-orange-600"><span>折扣 / 优惠</span><span>− ¥{displayDiscount.toFixed(2)}</span></div>}
                <div className="flex justify-between"><span className="text-muted-foreground">商品折后金额</span><span>¥{displayGoodsNetTotal.toFixed(2)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">最低回厂价合计</span><span>¥{displayMinimumReturnTotal.toFixed(2)}</span></div>
                <div className="flex justify-between text-emerald-700"><span>可提成金额</span><span>¥{displayCommissionTotal.toFixed(2)}</span></div>
                {!isPickupOrderSource(order.source) && (
                  <div className="flex justify-between"><span className="text-muted-foreground">订单运费</span><span>¥{displayShipping.toFixed(2)}</span></div>
                )}
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
                {damageRefundOrder && damageRefundAdjustment > 0.005 && (
                  <div className="flex justify-between text-red-600">
                    <span>报损退款调整</span>
                    <span>− ¥{damageRefundAdjustment.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t pt-2 font-semibold text-base">
                  <span>{damageRefundOrder ? "调整后订单应收" : "订单应收"}</span><span className="text-sky-700">¥{displayAmountDue.toFixed(2)}</span>
                </div>
              </div>
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
                      {isPickupOrderSource(order.source)
                        ? <MapPin className="size-3.5 mr-1" />
                        : <Truck className="size-3.5 mr-1" />}
                      {isPickupOrderSource(order.source)
                        ? shippableUnshippedItems.length < (order?.items.length ?? 0) ? "继续自提" : "确认自提"
                        : shippableUnshippedItems.length < (order?.items.length ?? 0) ? "继续出库" : "出库"}
                    </Button>
                  </div>
                )}
                {permission.canUpdate && order.status !== "cancelled" && order.status !== "completed" && activeOrderShipments.length > 0 && (
                  <div className="flex flex-col items-end gap-1">
                    {!allItemsShipped && (
                      <p className="text-xs text-purple-500">
                        尚有 {unshippedItems.length} 件{isPickupOrderSource(order.source) ? "未自提" : "未发货"}
                      </p>
                    )}
                    {allItemsShipped && !allShipmentsResolved && (
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

                {permission.canUpdate && !hasActuallyShipped && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-rose-300 text-rose-700 hover:bg-rose-50"
                    onClick={() => setRefundOpen(true)}
                  >
                    <RotateCcw className="mr-1 size-3.5" />登记退款
                  </Button>
                )}

                <div className="flex-1" />
                <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ReturnItemDialog
        open={!!returnItem}
        onOpenChange={(nextOpen) => { if (!nextOpen) setReturnItem(null); }}
        order={order}
        item={returnItem}
        product={returnProduct}
        stock={returnStock}
        saving={returnSaving}
        hasActuallyShipped={hasActuallyShipped}
        onConfirm={submitReturnItem}
      />

      <OrderRefundDialog
        order={order}
        open={refundOpen}
        saving={refundSaving}
        onOpenChange={setRefundOpen}
        onConfirm={submitOrderRefund}
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
        pickupOnly={isPickupOrderSource(order.source)}
      />

      <Dialog open={!!creditSaleRequest} onOpenChange={(nextOpen) => {
        if (!nextOpen && !requestingCreditApproval) {
          setCreditSaleRequest(null);
          setSelectedCreditApprovers([]);
        }
      }}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-amber-700" />
              申请赊销审批 · {creditSaleRequest?.orderNo}
            </DialogTitle>
          </DialogHeader>

          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950">
            该订单尚有 <strong>¥{Number(creditSaleRequest?.outstandingAmount ?? 0).toFixed(2)}</strong> 未经财务核销。
            {creditSaleRequest?.requesterIsOrderOwner
              ? " 你是订单负责人，提交申请后系统将直接审批通过并记录操作人。"
              : " 请选择接收审批的管理员或订单负责人，任一人同意后即可继续发货。"}
          </div>

          {!creditSaleRequest?.requesterIsOrderOwner && (
            <>
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">审批人（可多选）</div>
                {Number(creditSaleRequest?.eligibleApprovers.length ?? 0) > 0 && (
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={requestingCreditApproval}
                      onClick={() => setSelectedCreditApprovers(
                        creditSaleRequest?.eligibleApprovers.map((person) => person.username) ?? []
                      )}
                    >
                      全选
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={requestingCreditApproval || selectedCreditApprovers.length === 0}
                      onClick={() => setSelectedCreditApprovers([])}
                    >
                      清空
                    </Button>
                  </div>
                )}
              </div>

              {creditSaleRequest?.eligibleApprovers.length ? (
                <div className="max-h-72 overflow-y-auto rounded-md border divide-y">
                  {creditSaleRequest.eligibleApprovers.map((person) => {
                    const checked = selectedCreditApprovers.includes(person.username);
                    return (
                      <label
                        key={person.username}
                        className="flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/45"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={requestingCreditApproval}
                          onCheckedChange={(nextChecked) => setSelectedCreditApprovers((current) =>
                            nextChecked
                              ? [...current, person.username].filter((username, index, all) => all.indexOf(username) === index)
                              : current.filter((username) => username !== person.username)
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{person.name || person.username}</span>
                          <span className="block truncate text-xs text-muted-foreground">{person.username}</span>
                        </span>
                        <span className="flex shrink-0 flex-wrap justify-end gap-1">
                          {person.isOrderOwner && <Badge variant="outline">订单负责人</Badge>}
                          {person.isAdmin && <Badge variant="secondary">管理员</Badge>}
                          {checked && <Badge>已选择</Badge>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800">
                  当前没有可审批的在职管理员或订单负责人，请先在“人员与权限”中维护账号。
                </div>
              )}

              <div className="text-xs text-muted-foreground">
                已选择 {selectedCreditApprovers.length} 人。审批结果会同步显示给本次选择的所有审批人。
              </div>
            </>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={requestingCreditApproval}
              onClick={() => {
                setCreditSaleRequest(null);
                setSelectedCreditApprovers([]);
              }}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={requestingCreditApproval || (
                !creditSaleRequest?.requesterIsOrderOwner && selectedCreditApprovers.length === 0
              )}
              onClick={() => void submitCreditSaleRequest()}
            >
              {requestingCreditApproval
                ? <Loader2 className="size-4 animate-spin" />
                : creditSaleRequest?.requesterIsOrderOwner
                  ? <ShieldCheck className="size-4" />
                  : <Send className="size-4" />}
              {requestingCreditApproval
                ? "处理中"
                : creditSaleRequest?.requesterIsOrderOwner
                  ? "确认并直接通过"
                  : "发送审批"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
  const [fishCodeInput, setFishCodeInput] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [detailStockId, setDetailStockId] = useState<string | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setGroupId("");
      setSubTankId("");
      setFishCodeInput("");
      setSearchInput("");
      setPicked(new Set());
      setDetailStockId(null);
      if (clickTimer.current) {
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
      }
    }
  }, [open]);

  const getProduct = (id: string) => state.products.find((p) => p.id === id);

  const tankContextBySubId = (subTankId: string) => {
    for (const group of state.tankGroups) {
      const tank = group.subTanks.find((entry) => entry.id === subTankId);
      if (tank) return { group, tank };
    }
    return null;
  };

  const tankLabel = (subTankId: string) => {
    const ctx = tankContextBySubId(subTankId);
    return ctx ? `${ctx.group.name} / ${ctx.tank.name}` : "未知缸位";
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
  const isAvail = (s: StockItem) =>
    !s.sold && !excludeIds.has(s.id) && isPhysicallyInTank(s, shippedOutStockIds);
  const unavailableReason = (s: StockItem) => {
    if (excludeIds.has(s.id)) return "已在当前订单或已选列表中";
    if (s.sold) return "已被订单占用";
    if (!isPhysicallyInTank(s, shippedOutStockIds)) return "已不在缸内或已出库";
    return "不可添加";
  };

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
  const availableAllItems = state.stock
    .filter(isAvail)
    .slice()
    .sort((a, b) =>
      tankLabel(a.subTankId).localeCompare(tankLabel(b.subTankId), "zh-Hans-CN") ||
      (getProduct(a.productId)?.name ?? "").localeCompare(getProduct(b.productId)?.name ?? "", "zh-Hans-CN") ||
      String(a.code ?? "").localeCompare(String(b.code ?? ""), "zh-Hans-CN")
    );
  const searchTerm = normalizeSearchText(searchInput);
  const itemMatchesSearch = (s: StockItem) => {
    if (!searchTerm) return false;
    const p = getProduct(s.productId);
    const ctx = tankContextBySubId(s.subTankId);
    return [
      s.code,
      s.id,
      s.notes,
      p?.name,
      p?.size,
      p?.origin,
      ctx?.group.name,
      ctx?.tank.name,
      ctx ? `${ctx.group.name}/${ctx.tank.name}` : "",
      ctx ? `${ctx.group.name}${ctx.tank.name}` : "",
    ].some((value) => normalizeSearchText(value).includes(searchTerm));
  };
  const searchItems = searchTerm ? availableAllItems.filter(itemMatchesSearch) : [];
  const groupedSearchItems = groupByProduct(searchItems);

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

  const matchesFishCode = (stock: StockItem, code: string, partial = false) => {
    const normalizedCode = normalizeFishCode(code);
    if (!normalizedCode) return false;
    const tokens = [stock.code, stock.id].map(normalizeFishCode).filter(Boolean);
    return partial
      ? tokens.some((token) => token.includes(normalizedCode))
      : tokens.some((token) => token === normalizedCode);
  };

  const pickByFishCode = () => {
    const codes = splitFishCodeInput(fishCodeInput || searchInput);
    if (codes.length === 0) {
      toast.error("请输入编号");
      return;
    }

    const nextPicked = new Set(picked);
    const added: string[] = [];
    const skipped: string[] = [];
    const errors: string[] = [];
    let firstAdded: StockItem | null = null;

    for (const code of codes) {
      const exactMatches = state.stock.filter((stock) => matchesFishCode(stock, code));
      const codeMatches = exactMatches.length > 0
        ? exactMatches
        : state.stock.filter((stock) => matchesFishCode(stock, code, true));
      const availableMatches = codeMatches.filter(isAvail);

      if (availableMatches.length === 1) {
        const match = availableMatches[0];
        if (nextPicked.has(match.id)) {
          skipped.push(code);
          continue;
        }
        nextPicked.add(match.id);
        added.push(match.code?.trim() || code);
        firstAdded = firstAdded ?? match;
        continue;
      }

      if (availableMatches.length > 1) {
        errors.push(`编号「${code}」对应 ${availableMatches.length} 条可售鱼，请从搜索结果或缸位列表点选`);
        continue;
      }

      if (codeMatches.some((stock) => excludeIds.has(stock.id))) {
        errors.push(`编号「${code}」${unavailableReason(codeMatches.find((stock) => excludeIds.has(stock.id))!)}`);
        continue;
      }

      if (codeMatches.length > 0) {
        errors.push(`编号「${code}」对应的鱼${unavailableReason(codeMatches[0])}`);
      } else {
        errors.push(`未找到编号「${code}」`);
      }
    }

    if (added.length > 0) {
      setPicked(nextPicked);
      if (firstAdded) {
        const nextGroup = state.tankGroups.find((group) =>
          group.subTanks.some((tank) => tank.id === firstAdded?.subTankId)
        );
        if (nextGroup) setGroupId(nextGroup.id);
        setSubTankId(firstAdded.subTankId);
      }
      setFishCodeInput("");
      toast.success(`已按编号选择 ${added.length} 条鱼`);
    }

    if (skipped.length > 0 && added.length === 0 && errors.length === 0) {
      toast.info(`编号「${skipped.join("、")}」已在当前订单或已选列表中`);
    }

    if (errors.length > 0) {
      const message = errors.slice(0, 3).join("；");
      toast.error(errors.length > 3 ? `${message}；还有 ${errors.length - 3} 个问题` : message);
    }
  };

  const selectAll = () => setPicked(new Set(availableItems.map((s) => s.id)));
  const selectAllSearchResults = () =>
    setPicked((current) => new Set([...current, ...searchItems.map((s) => s.id)]));
  const clearAll = () => setPicked(new Set());

  const confirm = () => {
    const missingIds = Array.from(picked).filter((stockItemId) => !state.stock.some((x) => x.id === stockItemId));
    if (missingIds.length > 0) {
      toast.error("已选商品数据已变化，请重新选择商品");
      return;
    }
    const items = Array.from(picked).map((stockItemId) => {
      const s = state.stock.find((x) => x.id === stockItemId)!;
      return {
        stockItemId,
        productId: s.productId,
        price: s.basePrice ?? getProduct(s.productId)?.defaultPrice ?? 0,
        minReturnPrice: productMinReturnPrice(getProduct(s.productId)),
        commissionRate: 0,
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
      <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[86vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>选择商品</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto flex flex-col gap-4 pr-1 min-h-0">

          <div className="rounded-lg border bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <Label className="text-xs font-medium text-muted-foreground">搜索商品或按编号选鱼</Label>
              {picked.size > 0 && (
                <span className="text-xs font-medium text-emerald-600">已选 {picked.size} 条</span>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="relative min-w-0">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value);
                    setFishCodeInput(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      pickByFishCode();
                    }
                  }}
                  placeholder="搜索缸位 / 商品名 / 编号 / 备注，多个编号用空格"
                  className="h-9 pl-9"
                />
              </div>
              <Button type="button" variant="outline" size="sm" onClick={pickByFishCode}>
                <Check className="size-4" />
                编号选中
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              输入会即时模糊筛选；回车或点击“编号选中”会按明确编号加入。
            </p>
          </div>

          {searchTerm && (
            <div className="flex flex-col gap-2 rounded-lg border bg-white">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
                <div className="min-w-0 text-xs font-medium text-muted-foreground">
                  搜索结果 <span className="text-foreground">{searchItems.length}</span> 条
                </div>
                <div className="flex items-center gap-3">
                  {searchItems.length > 0 && (
                    <button
                      type="button"
                      onClick={selectAllSearchResults}
                      className="text-xs font-medium text-sky-600 hover:underline"
                    >
                      全选结果
                    </button>
                  )}
                  {picked.size > 0 && (
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-xs text-muted-foreground hover:underline"
                    >
                      清除已选
                    </button>
                  )}
                </div>
              </div>
              {searchItems.length === 0 ? (
                <div className="px-3 py-5 text-center text-sm text-muted-foreground">
                  没有匹配的可售鱼
                </div>
              ) : (
                <div className="max-h-64 overflow-y-auto divide-y">
                  {groupedSearchItems.map(([productId, stockItems]) => {
                    const p = getProduct(productId);
                    const selectedCount = stockItems.filter((s) => picked.has(s.id)).length;
                    return (
                      <div key={productId} className="p-3">
                        <div className="mb-2 flex items-center gap-2">
                          <div className="size-7 shrink-0 overflow-hidden rounded border bg-muted">
                            {p?.imageUrl
                              ? <ImageWithFallback src={p.imageUrl} alt="" className="size-full object-cover" />
                              : <div className="flex size-full items-center justify-center"><Fish className="size-3 text-muted-foreground" /></div>}
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className="text-sm font-medium">{p?.name ?? productId}</span>
                            {(p?.size || p?.origin) && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                {[p?.size, p?.origin].filter(Boolean).join(" · ")}
                              </span>
                            )}
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">×{stockItems.length}</span>
                          {selectedCount > 0 && (
                            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">+{selectedCount}</span>
                          )}
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          {stockItems.map((s) => {
                            const iconUrl = getItemIcon(s.id, s.productId);
                            const isSel = picked.has(s.id);
                            return (
                              <button
                                key={s.id}
                                type="button"
                                onClick={(event) => handleFishClick(s.id, event.detail)}
                                className={`grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-2 rounded-md border p-2 text-left transition hover:bg-muted/40 ${
                                  isSel ? "border-emerald-500 bg-emerald-50" : "border-border"
                                }`}
                                title="单击选择，双击查看/修改"
                              >
                                <span className={`relative size-10 overflow-hidden rounded bg-muted ${isSel ? "ring-2 ring-emerald-500 ring-offset-1" : statusRingClass(s.status)}`}>
                                  {iconUrl
                                    ? <ImageWithFallback src={iconUrl} alt="" className="size-full object-cover" />
                                    : <span className="flex size-full items-center justify-center"><Fish className="size-3 text-muted-foreground" /></span>}
                                  {isSel && (
                                    <span className="absolute inset-0 flex items-center justify-center bg-emerald-500/40">
                                      <Check className="size-4 text-white drop-shadow" />
                                    </span>
                                  )}
                                </span>
                                <span className="min-w-0">
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    {s.code && (
                                      <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs font-semibold text-slate-700">
                                        {s.code}
                                      </span>
                                    )}
                                    <span className="truncate text-xs text-muted-foreground">{statusLabel(s.status)}</span>
                                  </span>
                                  <span className="mt-1 block truncate text-xs text-muted-foreground">{tankLabel(s.subTankId)}</span>
                                  {s.notes && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{s.notes}</span>}
                                </span>
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

// ─── NewOrderDialog ───────────────────────────────────────────────────────────

function NewOrderDialog({
  open, onOpenChange,
}: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { state, activeSiteId, setState } = useStore();
  const permission = usePermission("orders");
  const customerPermission = usePermission("customers");
  const today = todayDateString();
  const currentUsername = state.user?.username ?? "";
  const personnel = state.personnel ?? [];
  const defaultContactPerson = getDefaultContactPerson(personnel, currentUsername);

  const [customerId, setCustomerId] = useState("");
  const [date, setDate] = useState(today);
  const [source, setSource] = useState("");
  const [platformOrderNo, setPlatformOrderNo] = useState("");
  const [paymentMethodId, setPaymentMethodId] = useState("");
  const [shippingAddress, setShippingAddress] = useState("");
  const [plannedShipDate, setPlannedShipDate] = useState("");
  const [contactPerson, setContactPerson] = useState(defaultContactPerson);
  const [notes, setNotes] = useState("");
  const [selectedItems, setSelectedItems] = useState<Map<string, { price: number; minReturnPrice: number }>>(new Map());
  const [shippingFee, setShippingFee] = useState(0);
  const [packagingFee, setPackagingFee] = useState(0);
  const [discount, setDiscount] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  useEffect(() => {
    if (open) {
      setCustomerId(""); setDate(today); setSource(""); setPlatformOrderNo(""); setPaymentMethodId(""); setShippingAddress(""); setPlannedShipDate(""); setContactPerson(defaultContactPerson); setNotes("");
      setSelectedItems(new Map());
      setShippingFee(0); setPackagingFee(0); setDiscount(0);
      setPickerOpen(false);
      setCustomerDialogOpen(false);
      setSubmitAttempted(false);
    }
  }, [open, defaultContactPerson, today]);

  const getProduct = (id: string) => state.products.find((p) => p.id === id);
  const selectedCustomer = useMemo(
    () => (state.customers ?? []).find((customer) => customer.id === customerId),
    [state.customers, customerId]
  );
  const selectedCustomerAddress = String(selectedCustomer?.address ?? "").trim();
  const platformOrder = isPlatformOrderSource(source);
  const pickupOrder = isPickupOrderSource(source);
  const availablePaymentMethods = useMemo(
    () => paymentMethodsForOrderSource(configuredPaymentMethods(state.systemSettings), source),
    [source, state.systemSettings]
  );
  const paymentMethod = configuredPaymentMethod(state.systemSettings, paymentMethodId);
  const paymentChannel = paymentMethod?.channel ?? "";
  const paymentAccount = paymentMethod?.account ?? "";

  const chooseSource = (nextSource: string) => {
    setSource(nextSource);
    setSubmitAttempted(false);
    setCustomerId("");
    setPlatformOrderNo("");
    const nextPaymentMethods = paymentMethodsForOrderSource(configuredPaymentMethods(state.systemSettings), nextSource);
    setPaymentMethodId(nextPaymentMethods.length === 1 ? nextPaymentMethods[0].id : "");
    setShippingAddress("");
    setPlannedShipDate("");
    setShippingFee(0);
  };

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
      for (const { stockItemId, price, minReturnPrice } of items) {
        if (!next.has(stockItemId)) {
          next.set(stockItemId, {
            price: normalizeMoneyAmount(price),
            minReturnPrice: normalizeMinReturnPrice(minReturnPrice),
          });
        }
      }
      return next;
    });
  };

  const setItemPrice = (stockItemId: string, price: number) =>
    setSelectedItems((prev) => {
      const current = prev.get(stockItemId) ?? { price: 0, minReturnPrice: 0 };
      return new Map(prev).set(stockItemId, { ...current, price });
    });

  const removeItem = (stockItemId: string) =>
    setSelectedItems((prev) => { const n = new Map(prev); n.delete(stockItemId); return n; });

  const itemsTotal = Array.from(selectedItems.values()).reduce((s, item) => s + item.price, 0);
  const minimumReturnTotal = orderMinimumReturnTotal(Array.from(selectedItems.values()));
  const goodsNetTotal = orderGoodsNetTotal(itemsTotal, discount);
  const belowMinimumReturn = selectedItems.size > 0 && goodsNetTotal <= minimumReturnTotal;
  const commissionTotal = Array.from(selectedItems.values()).reduce((s, item) => s + itemCommissionAmount(item), 0);
  const amountDue = itemsTotal + shippingFee + packagingFee - discount;
  const contactOptions = getContactPersonOptions(personnel, contactPerson);

  const createCustomer = async (customer: Customer) => {
    if (!customerPermission.requirePermission("create")) return false;
    const nextCustomer = { ...customer, id: customer.id || uid() };
    let createdCustomer = nextCustomer;
    try {
      const result = await postOrderApi("customers/create", {
        customer: nextCustomer,
        operator: state.user?.username ?? "system",
      });
      createdCustomer = (result.customer ?? nextCustomer) as Customer;
      setState((current) => {
        const currentSources = current.customerSources ?? [];
        const nextSources = Array.isArray(result.customerSources)
          ? result.customerSources
          : createdCustomer.source && !currentSources.includes(createdCustomer.source)
            ? [...currentSources, createdCustomer.source]
            : currentSources;
        const nextCustomers = Array.isArray(result.customers)
          ? result.customers
          : [...(current.customers ?? []).filter((item) => item.id !== createdCustomer.id), createdCustomer];
        return {
          ...current,
          customerSources: nextSources,
          customers: nextCustomers,
          operationLogs: mergeOperationLog(current, result.operationLog),
        };
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "新增客户失败，请重试");
      return false;
    }
    setCustomerId(createdCustomer.id);
    toast.success(`客户「${createdCustomer.name}」已新增`);
    return true;
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
    setSubmitAttempted(true);
    if (!source.trim()) return toast.error("请选择订单来源");
    if (!platformOrder && !customerId) return toast.error("请选择客户");
    if (platformOrder && !platformOrderNo.trim()) return toast.error(`请填写${platformOrderNoLabel(source)}`);
    if (!paymentMethodId || !paymentMethod) return toast.error("请选择付款方式");
    if (!paymentAccount) return toast.error("该付款方式未配置收款账户，请联系管理员处理");
    if (date > today) return toast.error("下单日期不能晚于今天");
    if (!contactPerson.trim()) return toast.error("请选择订单负责人");
    if (selectedItems.size === 0) return toast.error("请至少添加一条商品");
    if (!pickupOrder && !plannedShipDate) return toast.error("请选择预计发货日期");
    if (plannedShipDate && plannedShipDate < date) return toast.error("预计发货日期不能早于下单日期");
    if (amountDue < 0) return toast.error("折扣过大，订单应收不能为负数");
    if (belowMinimumReturn) return toast.error(`商品折后金额必须高于最低回厂价合计 ¥${minimumReturnTotal.toFixed(2)}`);
    const missingStockIds = Array.from(selectedItems.keys()).filter((stockItemId) =>
      !state.stock.some((item) => item.id === stockItemId)
    );
    if (missingStockIds.length > 0) {
      return toast.error("已选商品数据已变化，请移除后重新添加");
    }
    const items: OrderItem[] = Array.from(selectedItems.entries()).map(([stockItemId, draft]) => {
      const s = state.stock.find((x) => x.id === stockItemId)!;
      return {
        stockItemId,
        productId: s.productId,
        price: normalizeMoneyAmount(draft.price),
        minReturnPrice: normalizeMinReturnPrice(draft.minReturnPrice),
        commissionRate: 0,
      };
    });
    if (!confirmWrite("创建", `将创建销售订单，应收金额 ¥${amountDue.toFixed(2)}；创建后可直接出库发货。`)) return;
    let createdOrderNo = "";
    try {
      const result = await postOrderApi("orders/create", {
        orderFormSchemaVersion: ORDER_FORM_SCHEMA_VERSION,
        siteId: activeSiteId,
        customerId,
        date,
        source: source.trim(),
        platformOrderNo: platformOrder ? platformOrderNo.trim() : "",
        douyinOrderNo: source === "平台下单" ? platformOrderNo.trim() : "",
        paymentMethodId,
        paymentChannel,
        shippingAddress: source === "私域线上" ? shippingAddress.trim() : "",
        plannedShipDate: pickupOrder ? "" : plannedShipDate,
        contactPerson: contactPerson.trim(),
        items,
        shippingFee: pickupOrder ? 0 : shippingFee,
        packagingFee,
        discount,
        notes,
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
  const selectedRows = useMemo(() => (
    Array.from(selectedItems.entries()).flatMap(([stockItemId, draftItem]) => {
      const stockItem = state.stock.find((item) => item.id === stockItemId);
      if (!stockItem) return [];
      const product = state.products.find((item) => item.id === stockItem.productId);
      const minReturnPrice = normalizeMinReturnPrice(draftItem.minReturnPrice);
      const commissionAmount = itemCommissionAmount({ ...draftItem, minReturnPrice });
      return [{ stockItemId, stockItem, product, draftItem, minReturnPrice, commissionAmount }];
    })
  ), [selectedItems, state.stock, state.products]);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          aria-describedby={undefined}
          className="fishroom-fullscreen-dialog flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[90vh] sm:w-[min(92vw,1080px)] sm:max-w-[min(92vw,1080px)] sm:rounded-lg sm:border sm:p-0"
        >
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left sm:px-6">
            <DialogTitle className="text-base sm:text-lg">新建销售订单</DialogTitle>
          </DialogHeader>

          {!source ? (
            <div className="flex flex-1 flex-col items-center justify-start overflow-y-auto p-4 sm:justify-center sm:p-8">
              <div className="w-full max-w-3xl">
                <div className="mb-5 text-center">
                  <div className="text-base font-semibold text-foreground">选择订单来源</div>
                  <div className="mt-1 text-sm text-muted-foreground">不同来源会自动显示对应的必填信息和履约方式</div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {NEW_ORDER_SOURCE_CHOICES.map((choice) => {
                    const SourceIcon = choice.icon;
                    return (
                      <button
                        key={choice.value}
                        type="button"
                        className={`flex min-h-36 touch-manipulation flex-col items-start justify-between rounded-lg border bg-background p-4 text-left shadow-sm transition-colors hover:border-slate-400 hover:bg-muted/30 ${choice.activeClass}`}
                        onClick={() => chooseSource(choice.value)}
                      >
                        <span className={`flex size-11 items-center justify-center rounded-lg ${choice.iconClass}`}>
                          <SourceIcon className="size-5" />
                        </span>
                        <span className="mt-5">
                          <span className="block text-lg font-semibold">{choice.label}</span>
                          <span className={`mt-1 block text-sm leading-5 ${choice.descriptionClass}`}>{choice.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
          <div className="flex-1 overflow-y-auto p-3 sm:p-6">
            <div className="flex flex-col gap-4 sm:gap-5">

            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2.5 sm:px-4">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">订单来源</span>
                <span className="truncate text-sm font-semibold text-foreground">{orderSourceLabel(source)}</span>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => chooseSource("")}>
                重新选择
              </Button>
            </div>

            {/* ── 1. Customer + date + notes ── */}
            <div className="grid grid-cols-1 items-end gap-3 rounded-lg border bg-card p-3 sm:p-4 md:grid-cols-2 xl:grid-cols-4">
              {!platformOrder && (
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
              )}
              {platformOrder && (
                <div className="grid gap-2">
                  <Label>{platformOrderNoLabel(source)}<span className="ml-0.5 text-red-500">*</span></Label>
                  <Input
                    value={platformOrderNo}
                    onChange={(event) => setPlatformOrderNo(event.target.value)}
                    placeholder={`请输入${platformOrderNoLabel(source)}`}
                    autoComplete="off"
                    className={submitAttempted && !platformOrderNo.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}
                  />
                  {submitAttempted && !platformOrderNo.trim() && (
                    <p className="-mt-1 text-xs text-red-500">请填写{platformOrderNoLabel(source)}</p>
                  )}
                </div>
              )}
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
              {!pickupOrder && (
                <div className="grid gap-2">
                  <Label>预计发货日期<span className="text-red-500 ml-0.5">*</span></Label>
                  <Input
                    type="date"
                    value={plannedShipDate}
                    min={date}
                    required
                    onChange={(e) => changePlannedShipDate(e.target.value)}
                    className={(submitAttempted && !plannedShipDate) || (plannedShipDate && plannedShipDate < date) ? "border-red-500 focus-visible:ring-red-500" : ""}
                  />
                  {submitAttempted && !plannedShipDate && (
                    <p className="text-xs text-red-500 -mt-1">请选择预计发货日期</p>
                  )}
                  {plannedShipDate && plannedShipDate < date && (
                    <p className="text-xs text-red-500 -mt-1">发货日期不能早于下单日期</p>
                  )}
                </div>
              )}
              <div className="grid gap-2">
                <Label>订单负责人<span className="text-red-500 ml-0.5">*</span></Label>
                <Select
                  value={contactPerson}
                  onValueChange={setContactPerson}
                >
                  <SelectTrigger className={submitAttempted && !contactPerson.trim() ? "border-red-500 focus-visible:ring-red-500" : ""}>
                    <SelectValue placeholder="请选择订单负责人" />
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
              <div className="grid gap-2">
                <Label>付款方式<span className="text-red-500 ml-0.5">*</span></Label>
                <Select
                  value={paymentMethodId}
                  onValueChange={setPaymentMethodId}
                >
                  <SelectTrigger className={submitAttempted && !paymentMethodId ? "border-red-500 focus-visible:ring-red-500" : ""}>
                    <SelectValue placeholder="请选择付款方式" />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePaymentMethods.map((method) => (
                      <SelectItem key={method.id} value={method.id}>{paymentMethodDisplayLabel(method)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>对应收款账户<span className="text-red-500 ml-0.5">*</span></Label>
                <div className={`h-10 flex items-center rounded-md border bg-muted/50 px-3 text-sm ${submitAttempted && !paymentAccount ? "border-red-500 text-red-500" : "text-foreground"}`}>
                  {paymentAccount || (paymentMethodId ? "未配置，请联系管理员" : "选择付款方式后自动带出")}
                </div>
              </div>
              {source === "私域线上" && (
                <div className="grid gap-2 md:col-span-2 xl:col-span-3">
                  <Label>本单收货地址</Label>
                  <Input
                    value={shippingAddress}
                    onChange={(e) => setShippingAddress(e.target.value)}
                    placeholder={selectedCustomerAddress ? `不填则使用：${selectedCustomerAddress}` : "不填则使用客户默认地址"}
                  />
                  <p className="text-xs text-muted-foreground -mt-1">
                    {selectedCustomerAddress ? `客户默认地址：${selectedCustomerAddress}` : "选择客户后可自动使用客户默认地址。"}
                  </p>
                </div>
              )}
              <div className="grid gap-2 md:col-span-2 xl:col-span-4">
                <Label>备注</Label>
                <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="选填" />
              </div>
            </div>

            {/* ── 2. Items table ── */}
            <div className="flex flex-col rounded-lg border bg-card">
              <div className="flex shrink-0 flex-col gap-1 border-b bg-muted/50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <span className="text-sm font-medium">
                  已添加商品{selectedItems.size > 0 ? `（${selectedItems.size} 条）` : ""}
                </span>
                {selectedItems.size > 0 && (
                  <span className="text-sm text-muted-foreground">
                    小计 ¥{itemsTotal.toFixed(2)} · 最低回厂价 ¥{minimumReturnTotal.toFixed(2)} · 预计可提成 ¥{commissionTotal.toFixed(2)}
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
                  <>
                    <div className="flex flex-col divide-y md:hidden">
                      {selectedRows.map(({ stockItemId, stockItem, product, draftItem, minReturnPrice, commissionAmount }) => (
                        <div key={stockItemId} className="p-3">
                          <div className="flex items-start gap-2">
                            <div className="size-10 shrink-0 overflow-hidden rounded border bg-muted">
                              {product?.imageUrl
                                ? <ImageWithFallback src={product.imageUrl} alt="" className="size-full object-cover" />
                                : <div className="flex size-full items-center justify-center"><Fish className="size-4 text-muted-foreground" /></div>}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium">{product?.name ?? "—"}</div>
                              <div className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                                {stockItem.code && (
                                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600">
                                    {stockItem.code}
                                  </span>
                                )}
                                <span>{subTankName(stockItem.subTankId)}</span>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeItem(stockItemId)}
                              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600"
                              title="移除"
                            >
                              <X className="size-4" />
                            </button>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <div className="grid gap-1">
                              <Label className="text-xs">售价（¥）</Label>
                              <Input
                                type="number"
                                min={0}
                                value={draftItem.price}
                                onChange={(e) => setItemPrice(stockItemId, Number(e.target.value))}
                                className="h-9 text-sm"
                              />
                            </div>
                            <div className="grid gap-1">
                              <Label className="text-xs">最低回厂价（¥）</Label>
                              <div className="flex h-9 items-center rounded-md border bg-muted/30 px-3 text-sm">
                                ¥{minReturnPrice.toFixed(2)}
                              </div>
                            </div>
                          </div>
                          <div className="mt-2 text-right text-sm text-emerald-700">
                            可提成 ¥{commissionAmount.toFixed(2)}
                          </div>
                        </div>
                      ))}
                    </div>
                    <table className="hidden w-full md:table">
                      <thead className="sticky top-0 z-10 bg-muted/20">
                        <tr>
                          <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">商品</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">缸位</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">售价（¥）</th>
                          <th className="px-4 py-2 text-left text-xs font-medium text-muted-foreground">最低回厂价</th>
                          <th className="px-4 py-2 text-right text-xs font-medium text-muted-foreground">可提成</th>
                          <th className="w-10 px-2 py-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {selectedRows.map(({ stockItemId, stockItem, product, draftItem, minReturnPrice, commissionAmount }) => (
                          <tr key={stockItemId} className="border-t">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <div className="size-7 shrink-0 overflow-hidden rounded border bg-muted">
                                  {product?.imageUrl
                                    ? <ImageWithFallback src={product.imageUrl} alt="" className="size-full object-cover" />
                                    : <div className="flex size-full items-center justify-center"><Fish className="size-3 text-muted-foreground" /></div>}
                                </div>
                                <div className="min-w-0">
                                  <span className="text-sm">{product?.name ?? "—"}</span>
                                  {stockItem.code && (
                                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                                      {stockItem.code}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-2.5 text-sm text-muted-foreground">{subTankName(stockItem.subTankId)}</td>
                            <td className="px-4 py-2.5">
                              <Input
                                type="number" min={0}
                                value={draftItem.price}
                                onChange={(e) => setItemPrice(stockItemId, Number(e.target.value))}
                                className="h-7 w-28 text-sm"
                              />
                            </td>
                            <td className="px-4 py-2.5">
                              <span className="text-sm">¥{minReturnPrice.toFixed(2)}</span>
                            </td>
                            <td className="px-4 py-2.5 text-right text-sm text-emerald-700">
                              ¥{commissionAmount.toFixed(2)}
                            </td>
                            <td className="px-2 py-2.5">
                              <button
                                type="button"
                                onClick={() => removeItem(stockItemId)}
                                className="text-muted-foreground transition-colors hover:text-red-500"
                                title="移除"
                              >
                                <X className="size-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>

              {/* Always-visible add button */}
              <div className="flex shrink-0 flex-col gap-2 rounded-b-lg border-t bg-muted/10 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
                <button
                  onClick={() => setPickerOpen(true)}
                  className="flex items-center gap-1.5 text-sm text-sky-600 hover:text-sky-700 font-medium transition-colors"
                >
                  <Plus className="size-4" /> 添加商品
                </button>
                {selectedItems.size > 0 && (
                  <span className="text-xs text-muted-foreground">
                    共 {selectedItems.size} 条 · 小计 ¥{itemsTotal.toFixed(2)} · 最低回厂价 ¥{minimumReturnTotal.toFixed(2)} · 预计可提成 ¥{commissionTotal.toFixed(2)}
                  </span>
                )}
              </div>
            </div>

            {/* ── 3. Fees + settlement ── */}
            <div className="grid grid-cols-1 gap-4 rounded-lg border bg-card p-3 sm:p-4 lg:grid-cols-2 lg:gap-6">
              <div className="flex flex-col gap-3">
                <div className="text-xs font-medium text-muted-foreground">费用设置</div>
                <div className={`grid grid-cols-1 gap-3 ${pickupOrder ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
                  {!pickupOrder && (
                    <div className="grid gap-1.5">
                      <Label className="text-xs">订单运费（¥）</Label>
                      <Input type="number" min={0} step={0.01} value={shippingFee || ""} onChange={(e) => setShippingFee(Number(e.target.value))} placeholder="0" className="h-8 text-sm" />
                    </div>
                  )}
                  <div className="grid gap-1.5">
                    <Label className="text-xs">包装费（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={packagingFee || ""} onChange={(e) => setPackagingFee(Number(e.target.value))} placeholder="0" className="h-8 text-sm" />
                  </div>
                  <div className="grid gap-1.5">
                    <Label className="text-xs">折扣/优惠（¥）</Label>
                    <Input type="number" min={0} step={0.01} value={discount || ""} onChange={(e) => setDiscount(Number(e.target.value))} placeholder="0"
                      className={`h-8 text-sm${amountDue < 0 || belowMinimumReturn ? " border-red-500 focus-visible:ring-red-500" : ""}`} />
                    {amountDue < 0 && <p className="text-xs text-red-500">折扣导致订单应收为负 ¥{Math.abs(amountDue).toFixed(2)}</p>}
                    {belowMinimumReturn && <p className="text-xs text-red-500">商品折后金额必须高于最低回厂价合计</p>}
                  </div>
                </div>
              </div>
              <div className="flex flex-col justify-center gap-2 border-t pt-4 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
                <div className="text-xs font-medium text-muted-foreground mb-1">应收预览</div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">商品小计</span><span>¥{itemsTotal.toFixed(2)}</span></div>
                {discount > 0 && <div className="flex justify-between text-sm text-orange-600"><span>− 折扣</span><span>¥{discount.toFixed(2)}</span></div>}
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">商品折后金额</span><span>¥{goodsNetTotal.toFixed(2)}</span></div>
                <div className="flex justify-between text-sm"><span className="text-muted-foreground">最低回厂价合计</span><span>¥{minimumReturnTotal.toFixed(2)}</span></div>
                <div className="flex justify-between text-sm text-emerald-700"><span>预计可提成</span><span>¥{commissionTotal.toFixed(2)}</span></div>
                {belowMinimumReturn && (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    商品折后金额必须高于最低回厂价合计。
                  </div>
                )}
                {shippingFee > 0 && <div className="flex justify-between text-sm"><span className="text-muted-foreground">+ 运费</span><span>¥{shippingFee.toFixed(2)}</span></div>}
                {packagingFee > 0 && <div className="flex justify-between text-sm"><span className="text-muted-foreground">+ 包装费</span><span>¥{packagingFee.toFixed(2)}</span></div>}
                <div className="flex justify-between font-semibold text-base border-t pt-2">
                  <span>订单应收</span>
                  <span className={amountDue < 0 || belowMinimumReturn ? "text-red-600" : "text-sky-700"}>¥{amountDue.toFixed(2)}</span>
                </div>
              </div>
            </div>

            </div>
          </div>
          )}

          <DialogFooter className="flex-col border-t bg-background px-4 py-3 sm:flex-row sm:px-6">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>取消</Button>
            {source && (
              <Button className="w-full sm:w-auto" onClick={save}><ShoppingCart className="size-4 mr-1" />创建订单</Button>
            )}
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

    </>
  );
}

// ─── Main View ────────────────────────────────────────────────────────────────

type OrdersViewProps = {
  openOrderRequest?: { orderId: string; requestId: number } | null;
  onOpenOrderRequestHandled?: () => void;
};

type OwnerPaymentCandidate = {
  id: string;
  paymentMethodName: string;
  channel: PaymentChannel;
  account: string;
  externalTransactionNo: string;
  occurredAt: string;
  amount: number;
  payerName: string;
  notes: string;
  matchReason: string;
  candidates: Array<{
    orderId: string;
    orderNo: string;
    contactPerson: string;
    outstanding: number;
    reason: string;
  }>;
};

type OwnerPaymentClaimData = {
  candidates: OwnerPaymentCandidate[];
  cashOrders: Array<{
    orderId: string;
    orderNo: string;
    contactPerson: string;
    outstanding: number;
  }>;
};

function PaymentClaimDialog({
  open,
  data,
  loading,
  onOpenChange,
  onRefresh,
}: {
  open: boolean;
  data: OwnerPaymentClaimData;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const { setState } = useStore();
  const [savingKey, setSavingKey] = useState("");
  const [cashAmounts, setCashAmounts] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!open) return;
    setCashAmounts(Object.fromEntries(data.cashOrders.map((order) => [order.orderId, order.outstanding])));
  }, [data.cashOrders, open]);

  const claimStatement = async (statement: OwnerPaymentCandidate, orderId: string) => {
    const order = statement.candidates.find((candidate) => candidate.orderId === orderId);
    if (!order || !confirmWrite("认领", `确认流水 ${statement.externalTransactionNo || "无编号"} 的 ¥${statement.amount.toFixed(2)} 属于订单 ${order.orderNo}。`)) return;
    const key = `${statement.id}-${orderId}`;
    setSavingKey(key);
    try {
      const result = await postOrderApi("finance/statements/link", { action: "link", statementId: statement.id, orderId });
      applyOrderApiResult(setState, result);
      await onRefresh();
      toast.success("已认领收款，等待财务核销");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "收款认领失败");
    } finally {
      setSavingKey("");
    }
  };

  const recordCash = async (order: OwnerPaymentClaimData["cashOrders"][number]) => {
    const amount = Number(cashAmounts[order.orderId] ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) return toast.error("请输入现金收款金额");
    if (!confirmWrite("登记", `登记订单 ${order.orderNo} 的现金收款 ¥${amount.toFixed(2)}，后续由财务核销。`)) return;
    const key = `cash-${order.orderId}`;
    setSavingKey(key);
    try {
      const result = await postOrderApi("orders/payment-claim", { orderId: order.orderId, amount });
      applyOrderApiResult(setState, result);
      await onRefresh();
      toast.success("现金收款已登记，等待财务核销");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "现金收款登记失败");
    } finally {
      setSavingKey("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[92dvh] max-w-3xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-4 py-4 pr-12 sm:px-6">
          <DialogTitle>待认领收款</DialogTitle>
          <p className="text-sm text-muted-foreground">只处理系统无法唯一匹配的流水；支付号已经从账单带入，无需手工填写。</p>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-16 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />加载待认领收款</div>
          ) : data.candidates.length === 0 && data.cashOrders.length === 0 ? (
            <div className="px-4 py-16 text-center text-sm text-muted-foreground">当前没有需要你处理的收款</div>
          ) : (
            <>
              {data.candidates.length > 0 && (
                <section>
                  <div className="border-b bg-muted/30 px-4 py-2 text-sm font-semibold sm:px-6">账单匹配冲突</div>
                  <div className="divide-y">
                    {data.candidates.map((statement) => (
                      <div key={statement.id} className="px-4 py-4 sm:px-6">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0"><div className="font-medium">{statement.payerName || "付款方未知"} · {statement.paymentMethodName || paymentChannelLabel(statement.channel)}</div><div className="mt-1 truncate font-mono text-xs text-muted-foreground">流水 {statement.externalTransactionNo || "无编号"} · {statement.occurredAt.replace("T", " ").slice(0, 16)}</div></div>
                          <div className="text-lg font-semibold text-emerald-700">¥{statement.amount.toFixed(2)}</div>
                        </div>
                        <div className="mt-3 divide-y overflow-hidden rounded-md border">
                          {statement.candidates.map((order) => (
                            <div key={order.orderId} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                              <div><div className="font-medium">{order.orderNo}</div><div className="mt-1 text-xs text-muted-foreground">待收 ¥{order.outstanding.toFixed(2)} · {order.reason}</div></div>
                              <Button size="sm" variant="outline" onClick={() => void claimStatement(statement, order.orderId)} disabled={Boolean(savingKey)}>{savingKey === `${statement.id}-${order.orderId}` && <Loader2 className="size-3.5 animate-spin" />}认领到本单</Button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {data.cashOrders.length > 0 && (
                <section>
                  <div className="border-y bg-muted/30 px-4 py-2 text-sm font-semibold sm:px-6">现金收款</div>
                  <div className="divide-y">
                    {data.cashOrders.map((order) => (
                      <div key={order.orderId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
                        <div><div className="font-medium">{order.orderNo}</div><div className="mt-1 text-xs text-muted-foreground">待收余额 ¥{order.outstanding.toFixed(2)}</div></div>
                        <div className="flex items-end gap-2"><label className="grid gap-1 text-xs text-muted-foreground">本次收到<Input type="number" min={0} step={0.01} className="w-32" value={cashAmounts[order.orderId] ?? ""} onChange={(event) => setCashAmounts((current) => ({ ...current, [order.orderId]: Number(event.target.value) }))} /></label><Button size="sm" onClick={() => void recordCash(order)} disabled={Boolean(savingKey)}>{savingKey === `cash-${order.orderId}` && <Loader2 className="size-3.5 animate-spin" />}登记现金</Button></div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
        <DialogFooter className="border-t px-4 py-3 sm:px-6"><Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function OrdersView({
  openOrderRequest,
  onOpenOrderRequestHandled,
}: OrdersViewProps = {}) {
  const { state, setState, saveStateTransform, activeSiteId } = useStore();
  const permission = usePermission("orders");

  const [newOpen, setNewOpen] = useState(false);
  const [viewOrder, setViewOrder] = useState<Order | null>(null);
  const [viewCustomerId, setViewCustomerId] = useState<string | null>(null);
  const [deleteOrder, setDeleteOrder] = useState<Order | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<Set<string>>(new Set());
  const [exportFormatOpen, setExportFormatOpen] = useState(false);
  const [mobileSearch, setMobileSearch] = useState("");
  const [mobilePage, setMobilePage] = useState(1);
  const mobileListRef = useRef<HTMLDivElement>(null);
  const [paymentClaimOpen, setPaymentClaimOpen] = useState(false);
  const [paymentClaimsLoading, setPaymentClaimsLoading] = useState(false);
  const [paymentClaimData, setPaymentClaimData] = useState<OwnerPaymentClaimData>({ candidates: [], cashOrders: [] });

  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "completed">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [todayShipOnly, setTodayShipOnly] = useState(false);
  const [pendingTrackingOnly, setPendingTrackingOnly] = useState(false);
  const [myActiveOnly, setMyActiveOnly] = useState(false);
  const today = todayDateString();

  const loadPaymentClaims = useCallback(async (showLoading = false) => {
    if (!permission.canUpdate) {
      setPaymentClaimData({ candidates: [], cashOrders: [] });
      return;
    }
    if (showLoading) setPaymentClaimsLoading(true);
    try {
      const response = await fetch(`/api/orders/payment-candidates?siteId=${encodeURIComponent(activeSiteId)}`, {
        headers: authJsonHeaders(),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      setPaymentClaimData({
        candidates: Array.isArray(result.candidates) ? result.candidates : [],
        cashOrders: Array.isArray(result.cashOrders) ? result.cashOrders : [],
      });
    } catch (error) {
      if (showLoading) toast.error(error instanceof Error ? error.message : "待认领收款加载失败");
    } finally {
      if (showLoading) setPaymentClaimsLoading(false);
    }
  }, [activeSiteId, permission.canUpdate]);

  useEffect(() => {
    void loadPaymentClaims(false);
  }, [loadPaymentClaims, state.orders]);

  const pendingPaymentClaimCount = paymentClaimData.candidates.length + paymentClaimData.cashOrders.length;

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

  useEffect(() => {
    if (!openOrderRequest) return;
    const targetOrder = state.orders.find((order) => order.id === openOrderRequest.orderId);
    if (targetOrder) {
      setViewOrder(targetOrder);
    } else {
      toast.error("没有找到对应订单，可能已被删除或不属于当前场地");
      onOpenOrderRequestHandled?.();
    }
  }, [openOrderRequest?.requestId]);

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

  type OrderListRow = Order & {
    searchText: string;
    fishSearchCodes: string[];
    fishDisplayCodes: string[];
  };
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
      const orderStocks = order.items.map((item) => stockMap.get(item.stockItemId));
      const fishDisplayCodes = Array.from(new Set(
        order.items
          .map((item, index) => String(orderStocks[index]?.code ?? item.fishCode ?? "").trim())
          .filter(Boolean)
      ));
      const fishSearchCodes = Array.from(new Set(
        order.items.flatMap((item, index) => [
          item.stockItemId,
          orderStocks[index]?.code ?? item.fishCode,
          buildPublicSelectionCode(item.stockItemId),
        ])
          .map((code) => String(code ?? "").trim())
          .filter(Boolean)
      ));
      const itemSearchText = order.items.flatMap((item, index) => {
        const product = productMap.get(item.productId);
        const stock = orderStocks[index];
        const batch = stock ? batchMap.get(stock.batchId) : undefined;
        return [
          item.stockItemId,
          stock?.code ?? item.fishCode,
          buildPublicSelectionCode(item.stockItemId),
          item.plannedShipDate,
          item.price,
          orderItemMinReturnPrice(item, product),
          itemCommissionAmount({ ...item, minReturnPrice: orderItemMinReturnPrice(item, product) }),
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
        orderSourceLabel(order.source),
        platformOrderNoForOrder(order),
        order.plannedShipDate,
        getOrderStatusText(order, state.shipments),
        customer?.name,
        customer?.phone,
        customer?.wechat,
        customer?.douyin,
        customer?.source,
        customer?.address,
        order.shippingAddress,
        customer?.notes,
        order.contactPerson,
        order.notes,
        ...orderShipments.flatMap((shipment) => [
          shipment.shipDate,
          shipment.carrier,
          shipment.trackingNo,
          shipment.notes,
        ]),
        calcAmountDue(order, state.shipments).toFixed(2),
        orderCommissionTotalWithProducts(order, (productId) => productMap.get(productId)).toFixed(2),
        ...itemSearchText,
      ].filter(Boolean).join(" ");
      return { ...order, searchText, fishSearchCodes, fishDisplayCodes };
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

  const mobileFilteredOrders = useMemo(() => {
    return rankOrderSearchRows(filteredOrders, mobileSearch);
  }, [filteredOrders, mobileSearch]);

  useEffect(() => {
    setMobilePage(1);
  }, [mobileSearch, statusFilter, dateFrom, dateTo, todayShipOnly, pendingTrackingOnly, myActiveOnly]);

  const mobileTotalPages = Math.max(1, Math.ceil(mobileFilteredOrders.length / MOBILE_ORDER_PAGE_SIZE));
  const currentMobilePage = Math.min(mobilePage, mobileTotalPages);
  const mobileVisibleOrders = mobileFilteredOrders.slice(
    (currentMobilePage - 1) * MOBILE_ORDER_PAGE_SIZE,
    currentMobilePage * MOBILE_ORDER_PAGE_SIZE
  );

  const changeMobilePage = (nextPage: number) => {
    const normalized = Math.max(1, Math.min(mobileTotalPages, nextPage));
    setMobilePage(normalized);
    window.requestAnimationFrame(() => {
      const list = mobileListRef.current;
      const scrollContainer = list?.closest(".fishroom-content") as HTMLElement | null;
      if (!list || !scrollContainer) return;
      const listRect = list.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();
      const listTop = scrollContainer.scrollTop + listRect.top - containerRect.top - 12;
      scrollContainer.scrollTo({ top: Math.max(0, listTop), left: 0, behavior: "auto" });
    });
  };

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
  const allMobileFilteredSelected = mobileFilteredOrders.length > 0 && mobileFilteredOrders.every((order) => selectedOrderIds.has(order.id));

  const toggleSelectedOrder = (id: string, checked: boolean) => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      checked ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const toggleMobileFilteredOrders = () => {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev);
      if (allMobileFilteredSelected) {
        mobileFilteredOrders.forEach((order) => next.delete(order.id));
      } else {
        mobileFilteredOrders.forEach((order) => next.add(order.id));
      }
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
      toast.error("该订单已有财务流水，不能删除，请先在财务管理中处理");
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
  const hasMobileFilter = hasDateFilter || Boolean(mobileSearch.trim()) || statusFilter !== "all";
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
  const mobileProductById = useMemo(
    () => new Map(state.products.map((product) => [product.id, product])),
    [state.products]
  );

  const renderMobileOrderCard = (order: OrderListRow) => {
    const customer = getCustomer(order.customerId);
    const due = calcAmountDue(order, state.shipments);
    const commission = orderCommissionTotalWithProducts(order, (productId) => mobileProductById.get(productId));
    const orderShipments = state.shipments.filter((shipment) => shipment.orderId === order.id);
    const activeShipments = orderShipments.filter(countsAsFulfillmentShipment);
    const shippedIds = new Set(activeShipments.flatMap((shipment) => shipment.itemStockIds ?? []));
    const inventoryActiveItems = order.items.filter((item) => !item.inventoryRemovedAt);
    const unshippedCount = inventoryActiveItems.filter((item) => !shippedIds.has(item.stockItemId)).length;
    const nextShipDate = order.status === "completed"
      ? ""
      : inventoryActiveItems
          .map((item) => effectiveItemPlannedShipDate(order, item) || item.plannedShipDate)
          .filter(Boolean)
          .sort()[0] || order.plannedShipDate || "";
    const plannedTodayCount = inventoryActiveItems.filter((item) =>
      effectiveItemPlannedShipDate(order, item) === today || item.plannedShipDate === today
    ).length;
    const itemNames = order.items
      .map((item) => mobileProductById.get(item.productId)?.name ?? item.productId)
      .filter(Boolean);
    const shownItems = itemNames.slice(0, 2).join("、");
    const extraItemCount = Math.max(0, itemNames.length - 2);

    return (
      <article
        key={order.id}
        className="rounded-lg border bg-card p-3 shadow-sm transition-colors active:bg-muted/50"
      >
        <div className="flex items-start gap-3">
          <Checkbox
            checked={selectedOrderIds.has(order.id)}
            onCheckedChange={(checked) => toggleSelectedOrder(order.id, checked === true)}
            onClick={(event) => event.stopPropagation()}
            aria-label={`选择订单 ${order.orderNo}`}
            className="mt-1"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span className="truncate">{order.orderNo}</span>
                  <span className={`shrink-0 rounded-full border px-1.5 py-0.5 ${orderSourceBadgeClass(order.source)}`}>
                    {orderSourceLabel(order.source) || "未设置来源"}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-base font-semibold text-foreground">
                  {customer?.name ?? (isPlatformOrderSource(order.source)
                    ? platformOrderDisplayName(order)
                    : "未找到客户")}
                </div>
              </div>
              <span className="shrink-0 rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground">
                {order.items.length} 条
              </span>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              <OrderStatusTags order={order} shipments={state.shipments} />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-md bg-muted/35 px-2.5 py-2">
                <div className="text-xs text-muted-foreground">{isPickupOrderSource(order.source) ? "履约方式" : "预计发货"}</div>
                <div className={nextShipDate === today ? "mt-0.5 font-semibold text-orange-600" : "mt-0.5 font-semibold text-foreground"}>
                  {isPickupOrderSource(order.source)
                    ? "线下自提"
                    : order.status === "completed"
                    ? "已完成"
                    : nextShipDate
                      ? `${nextShipDate}${plannedTodayCount > 0 ? ` · ${plannedTodayCount}件` : ""}`
                      : "未设置"}
                </div>
              </div>
              <div className="rounded-md bg-muted/35 px-2.5 py-2">
                <div className="text-xs text-muted-foreground">{isPickupOrderSource(order.source) ? "待自提" : "未发货"}</div>
                <div className={unshippedCount > 0 ? "mt-0.5 font-semibold text-amber-700" : "mt-0.5 font-semibold text-emerald-700"}>
                  {unshippedCount > 0 ? `${unshippedCount} 条` : "已处理"}
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">订单应收</div>
                <div className="mt-0.5 font-semibold text-sky-700">¥{due.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">可提成</div>
                <div className="mt-0.5 font-semibold text-emerald-700">¥{commission.toFixed(2)}</div>
              </div>
            </div>

            <div className="mt-3 rounded-md bg-background px-2.5 py-2 text-xs text-muted-foreground">
              <span className="text-foreground">{shownItems || "无商品"}</span>
              {extraItemCount > 0 && <span> 等 {itemNames.length} 条</span>}
              {order.fishDisplayCodes.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1 text-sky-700">
                  <Fish className="size-3.5 shrink-0" />
                  <span className="truncate">
                    鱼码 {order.fishDisplayCodes.slice(0, 4).join("、")}
                    {order.fishDisplayCodes.length > 4 ? ` 等 ${order.fishDisplayCodes.length} 个` : ""}
                  </span>
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-col items-start gap-2">
              <div className="text-xs text-muted-foreground">下单 {order.date}</div>
              <div className="flex items-center gap-2">
                {customer && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-9 px-2 text-sky-700"
                    onClick={(event) => {
                      event.stopPropagation();
                      setViewCustomerId(customer.id);
                    }}
                  >
                    客户
                  </Button>
                )}
                {permission.canDelete && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={hasPaymentRecords(order) ? "h-9 px-2 text-muted-foreground" : "h-9 px-2 text-red-600 hover:bg-red-50 hover:text-red-700"}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (hasPaymentRecords(order)) {
                        toast.error("该订单已有财务流水，不能删除，请先在财务管理中处理");
                        return;
                      }
                      setDeleteOrder(order);
                    }}
                  >
                    删除
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  className="h-9 px-3"
                  onClick={(event) => {
                    event.stopPropagation();
                    setViewOrder(order);
                  }}
                >
                  详情
                </Button>
              </div>
            </div>
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>订单管理</h2>
        <p className="text-sm text-muted-foreground">
          创建时确认订单应收，创建后直接安排出库与发货
        </p>
      </div>

      <div className="flex flex-col gap-3 pb-16 md:hidden">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {STATUS_FILTERS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => {
                setStatusFilter(key);
                if (key !== "active") setMyActiveOnly(false);
              }}
              className={`h-10 shrink-0 rounded-full px-4 text-sm font-medium transition-colors ${
                statusFilter === key
                  ? "bg-sky-600 text-white"
                  : "border border-border bg-card text-muted-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <section className="rounded-lg border bg-card p-3 shadow-sm">
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={mobileSearch}
                onChange={(event) => setMobileSearch(event.target.value)}
                placeholder="搜索鱼码、订单、客户、商品..."
                className="h-10 pl-9"
              />
            </div>
            {permission.canCreate && (
              <Button type="button" className="h-10 shrink-0 px-3" onClick={() => setNewOpen(true)}>
                <Plus className="size-4" />
                新建
              </Button>
            )}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant={myActiveOnly ? "default" : "outline"}
              className={myActiveOnly
                ? "h-10 bg-sky-600 text-white hover:bg-sky-700"
                : "h-10 border-sky-200 text-sky-700 hover:bg-sky-50 hover:text-sky-800"
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
              我的 {myActiveOrderCount}
            </Button>
            {permission.canUpdate && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={pendingPaymentClaimCount > 0 ? "h-10 border-amber-300 bg-amber-50 text-amber-800" : "h-10"}
                onClick={() => { setPaymentClaimOpen(true); void loadPaymentClaims(true); }}
              >
                <CircleDollarSign className="mr-1 size-3.5" />
                待认领 {pendingPaymentClaimCount}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant={todayShipOnly ? "default" : "outline"}
              className={todayShipOnly
                ? "h-10 bg-orange-600 text-white hover:bg-orange-700"
                : "h-10 border-orange-200 text-orange-600 hover:bg-orange-50 hover:text-orange-700"
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
              今日发货 {todayShipCount}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={pendingTrackingOnly ? "default" : "outline"}
              className={pendingTrackingOnly
                ? "h-10 bg-emerald-600 text-white hover:bg-emerald-700"
                : "h-10 border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
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
              出库待发 {pendingTrackingCount}
            </Button>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">开始日期</Label>
              <Input
                type="date"
                value={dateFrom}
                max={dateFromMax}
                onChange={(event) => changeDateFrom(event.target.value)}
                className="h-10 text-sm"
              />
            </div>
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">结束日期</Label>
              <Input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                max={today}
                onChange={(event) => changeDateTo(event.target.value)}
                className="h-10 text-sm"
              />
            </div>
          </div>

          {hasMobileFilter && (
            <button
              type="button"
              onClick={() => {
                setStatusFilter("all");
                setDateFrom("");
                setDateTo("");
                setTodayShipOnly(false);
                setPendingTrackingOnly(false);
                setMyActiveOnly(false);
                setMobileSearch("");
              }}
              className="mt-3 h-9 text-sm font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              清除筛选
            </button>
          )}
        </section>

        <section className="rounded-lg border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">共 {mobileFilteredOrders.length} 单</div>
              <div className="text-xs text-muted-foreground">已选 {selectedOrders.length} 单用于导出</div>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 px-3"
                disabled={mobileFilteredOrders.length === 0}
                onClick={toggleMobileFilteredOrders}
              >
                {allMobileFilteredSelected ? "取消" : "全选"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 px-3"
                onClick={() => setExportFormatOpen(true)}
                disabled={selectedOrders.length === 0}
              >
                导出
              </Button>
            </div>
          </div>
        </section>

        <div ref={mobileListRef} className="flex flex-col gap-3">
          {mobileVisibleOrders.length === 0 ? (
            <div className="rounded-lg border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
              没有符合条件的订单
            </div>
          ) : (
            mobileVisibleOrders.map(renderMobileOrderCard)
          )}
        </div>

        {mobileFilteredOrders.length > 0 && mobileTotalPages > 1 && (
          <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center gap-2 rounded-lg border bg-card p-2">
            <Button
              type="button"
              size="icon"
              variant="outline"
              disabled={currentMobilePage <= 1}
              onClick={() => changeMobilePage(currentMobilePage - 1)}
              aria-label="上一页"
              title="上一页"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <label className="fishroom-control flex h-10 min-w-0 items-center rounded-md border px-3">
              <span className="sr-only">选择订单页码</span>
              <select
                value={currentMobilePage}
                onChange={(event) => changeMobilePage(Number(event.target.value))}
                className="size-full min-w-0 bg-transparent text-center text-sm font-medium text-foreground outline-none"
                aria-label="选择订单页码"
              >
                {Array.from({ length: mobileTotalPages }, (_, index) => index + 1).map((pageNumber) => (
                  <option key={pageNumber} value={pageNumber}>
                    第 {pageNumber} / {mobileTotalPages} 页
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="button"
              size="icon"
              variant="outline"
              disabled={currentMobilePage >= mobileTotalPages}
              onClick={() => changeMobilePage(currentMobilePage + 1)}
              aria-label="下一页"
              title="下一页"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Filter bar */}
      <div className="hidden items-center gap-3 flex-wrap md:flex">
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
          {permission.canUpdate && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className={pendingPaymentClaimCount > 0 ? "h-7 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100" : "h-7"}
              onClick={() => { setPaymentClaimOpen(true); void loadPaymentClaims(true); }}
            >
              <CircleDollarSign className="mr-1 size-3.5" />
              待认领收款{pendingPaymentClaimCount > 0 ? ` ${pendingPaymentClaimCount}` : ""}
            </Button>
          )}
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

	      <div className="hidden flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2 md:flex">
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

	      <div className="hidden md:block">
	      <DataTable
	        data={filteredOrders}
        searchKeys={["searchText"] as (keyof OrderListRow)[]}
        searchPlaceholder="搜索鱼码、订单号、客户、商品、来源..."
        searchRank={orderSearchRank}
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
              if (!customer) {
                return isPlatformOrderSource(r.source) ? (
                  <div>
                    <div className="text-sm font-medium text-foreground">{orderSourceLabel(r.source)}订单</div>
                    <div className="text-xs text-muted-foreground">{platformOrderNoForOrder(r) || "未填写编号"}</div>
                  </div>
                ) : <span className="text-muted-foreground">—</span>;
              }
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
              <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${orderSourceBadgeClass(r.source)}`}>
                {orderSourceLabel(r.source)}
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
            render: (r) => (
              <div title={r.fishDisplayCodes.length > 0 ? `鱼码：${r.fishDisplayCodes.join("、")}` : undefined}>
                <div>{r.items.length} 条</div>
                {r.fishDisplayCodes.length > 0 && (
                  <div className="mt-0.5 max-w-36 truncate text-xs text-sky-700">
                    鱼码 {r.fishDisplayCodes.slice(0, 3).join("、")}
                    {r.fishDisplayCodes.length > 3 ? "…" : ""}
                  </div>
                )}
              </div>
            ),
          },
          {
            key: "shippingFee",
            title: "订单应收",
            render: (r) => (
              <span className="text-sky-700 font-medium">¥{calcAmountDue(r, state.shipments).toFixed(2)}</span>
            ),
          },
          {
            key: "commission",
            title: "可提成",
            render: (r) => (
              <span className="font-medium text-emerald-700">
                ¥{orderCommissionTotalWithProducts(r, (productId) => state.products.find((product) => product.id === productId)).toFixed(2)}
              </span>
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
		                title={hasPaymentRecords(row) ? "已有财务流水，不能删除" : "删除订单"}
		                onClick={() => {
		                  if (hasPaymentRecords(row)) {
		                    toast.error("该订单已有财务流水，不能删除，请先在财务管理中处理");
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
      </div>

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
                : "将导出选中订单的订单、商品和发货信息，不包含财务流水。"}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-auto flex-col items-start gap-1 p-4 text-left"
                onClick={() => {
                  setExportFormatOpen(false);
                  void (async () => {
                    try {
                      if (pendingTrackingOnly) await exportPendingTrackingShipmentsExcel(selectedOrders, state);
                      else exportOrdersExcel(selectedOrders, state);
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "导出失败，请重试");
                    }
                  })();
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
                  void (async () => {
                    try {
                      await exportPendingTrackingShipmentsWord(selectedOrders, state);
                    } catch (error) {
                      toast.error(error instanceof Error ? error.message : "导出失败，请重试");
                    }
                  })();
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

      <PaymentClaimDialog
        open={paymentClaimOpen}
        data={paymentClaimData}
        loading={paymentClaimsLoading}
        onOpenChange={setPaymentClaimOpen}
        onRefresh={() => loadPaymentClaims(true)}
      />

      <NewOrderDialog open={newOpen} onOpenChange={setNewOpen} />

      <OrderDetailDialog
        order={syncedViewOrder}
        open={!!viewOrder}
        onOpenChange={(o) => {
          if (o) return;
          setViewOrder(null);
          onOpenOrderRequestHandled?.();
        }}
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
              {deleteOrder && hasPaymentRecords(deleteOrder) && " 该订单已有财务流水，不能删除，请先在财务管理中处理。"}
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
