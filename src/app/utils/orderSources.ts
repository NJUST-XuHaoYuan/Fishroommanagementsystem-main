import type { PaymentChannel } from "../store";

type OrderSourceMeta = {
  label: string;
  platform: boolean;
  paymentChannel?: PaymentChannel;
  orderNoLabel?: string;
  badgeClass: string;
};

const ORDER_SOURCE_META: Record<string, OrderSourceMeta> = {
  "平台下单": {
    label: "抖音",
    platform: true,
    paymentChannel: "douyin",
    orderNoLabel: "抖音订单编号",
    badgeClass: "border-zinc-900 bg-zinc-950 text-white",
  },
  "闲鱼平台": {
    label: "闲鱼",
    platform: true,
    paymentChannel: "xianyu",
    orderNoLabel: "闲鱼订单编号",
    badgeClass: "border-amber-400 bg-amber-100 text-amber-950",
  },
  "微拍堂平台": {
    label: "微拍堂",
    platform: true,
    paymentChannel: "weipaitang",
    orderNoLabel: "微拍堂订单编号",
    badgeClass: "border-red-300 bg-red-100 text-red-800",
  },
  "私域线上": {
    label: "线上私域",
    platform: false,
    badgeClass: "border-emerald-300 bg-emerald-100 text-emerald-800",
  },
  "线下": {
    label: "线下自提",
    platform: false,
    badgeClass: "border-sky-300 bg-sky-100 text-sky-800",
  },
};

export function orderSourceLabel(source?: string): string {
  const normalized = String(source ?? "").trim();
  return ORDER_SOURCE_META[normalized]?.label ?? normalized;
}

export function orderSourceBadgeClass(source?: string): string {
  const normalized = String(source ?? "").trim();
  return ORDER_SOURCE_META[normalized]?.badgeClass ?? "border-slate-300 bg-slate-100 text-slate-700";
}

export function isPlatformOrderSource(source?: string): boolean {
  return ORDER_SOURCE_META[String(source ?? "").trim()]?.platform === true;
}

export function platformPaymentChannelForOrderSource(source?: string): PaymentChannel | "" {
  return ORDER_SOURCE_META[String(source ?? "").trim()]?.paymentChannel ?? "";
}

export function isPlatformPaymentChannel(channel?: string): boolean {
  return ["douyin", "xianyu", "weipaitang"].includes(String(channel ?? "").trim());
}

export function platformOrderNoLabel(source?: string): string {
  return ORDER_SOURCE_META[String(source ?? "").trim()]?.orderNoLabel ?? "平台订单编号";
}

export function platformOrderNoForOrder(order?: {
  source?: string;
  platformOrderNo?: string;
  douyinOrderNo?: string;
} | null): string {
  const explicit = String(order?.platformOrderNo ?? "").trim();
  if (explicit) return explicit;
  return String(order?.source ?? "").trim() === "平台下单"
    ? String(order?.douyinOrderNo ?? "").trim()
    : "";
}

export function platformOrderDisplayName(order?: {
  source?: string;
  platformOrderNo?: string;
  douyinOrderNo?: string;
} | null): string {
  const sourceLabel = orderSourceLabel(order?.source) || "平台";
  const orderNo = platformOrderNoForOrder(order);
  return `${sourceLabel}订单${orderNo ? ` ${orderNo}` : ""}`;
}
