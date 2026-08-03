export const ORDER_SOURCE_CONFIG = {
  "平台下单": { label: "抖音", platform: true, paymentChannel: "douyin", orderNoLabel: "抖音订单编号" },
  "闲鱼平台": { label: "闲鱼", platform: true, paymentChannel: "xianyu", orderNoLabel: "闲鱼订单编号" },
  "微拍堂平台": { label: "微拍堂", platform: true, paymentChannel: "weipaitang", orderNoLabel: "微拍堂订单编号" },
  "私域线上": { label: "线上私域", platform: false, paymentChannel: "", orderNoLabel: "" },
  "线下": { label: "线下自提", platform: false, paymentChannel: "", orderNoLabel: "" },
};

export const ORDER_SOURCE_VALUES = new Set(Object.keys(ORDER_SOURCE_CONFIG));
export const PLATFORM_ORDER_SOURCES = new Set(
  Object.entries(ORDER_SOURCE_CONFIG)
    .filter(([, config]) => config.platform)
    .map(([source]) => source)
);

export function orderSourceConfig(source = "") {
  return ORDER_SOURCE_CONFIG[String(source ?? "").trim()] ?? null;
}

export function orderSourceLabel(source = "") {
  const normalized = String(source ?? "").trim();
  return orderSourceConfig(normalized)?.label ?? normalized;
}

export function isPlatformOrderSource(source = "") {
  return PLATFORM_ORDER_SOURCES.has(String(source ?? "").trim());
}

export function platformPaymentChannelForOrderSource(source = "") {
  return orderSourceConfig(source)?.paymentChannel ?? "";
}

export function isPlatformPaymentChannel(channel = "") {
  return ["douyin", "xianyu", "weipaitang"].includes(String(channel ?? "").trim());
}

export function platformOrderNoLabel(source = "") {
  return orderSourceConfig(source)?.orderNoLabel ?? "平台订单编号";
}

export function platformOrderNoForOrder(order = {}) {
  const explicit = String(order?.platformOrderNo ?? "").trim();
  if (explicit) return explicit;
  return String(order?.source ?? "").trim() === "平台下单"
    ? String(order?.douyinOrderNo ?? "").trim()
    : "";
}
