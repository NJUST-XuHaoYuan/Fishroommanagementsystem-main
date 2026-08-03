export const PAYMENT_CHANNELS = ["wechat", "alipay", "douyin", "bank", "cash"];
export const DEFAULT_PAYMENT_METHOD_SETTINGS = [
  { channel: "wechat", account: "", enabled: false },
  { channel: "alipay", account: "", enabled: false },
  { channel: "douyin", account: "抖店账户", enabled: true },
  { channel: "bank", account: "", enabled: false },
  { channel: "cash", account: "现金", enabled: true },
];

export function normalizePaymentChannel(value = "") {
  const channel = String(value ?? "").trim();
  return PAYMENT_CHANNELS.includes(channel) ? channel : "";
}

export function paymentChannelLabel(channel = "") {
  return {
    wechat: "微信",
    alipay: "支付宝",
    douyin: "抖音",
    bank: "银行卡",
    cash: "现金",
  }[normalizePaymentChannel(channel)] || "未登记";
}

export function normalizePaymentMethodSettings(settings = {}) {
  const configured = new Map();
  const methods = Array.isArray(settings?.paymentMethods) ? settings.paymentMethods : [];
  for (const method of methods) {
    const channel = normalizePaymentChannel(method?.channel);
    if (!channel || configured.has(channel)) continue;
    configured.set(channel, {
      channel,
      account: String(method?.account ?? "").trim(),
      enabled: method?.enabled === true,
    });
  }
  return DEFAULT_PAYMENT_METHOD_SETTINGS.map((fallback) => configured.get(fallback.channel) ?? { ...fallback });
}

export function configuredPaymentMethod(settings = {}, channel = "") {
  const normalizedChannel = normalizePaymentChannel(channel);
  if (!normalizedChannel) return undefined;
  return normalizePaymentMethodSettings(settings).find((method) =>
    method.channel === normalizedChannel && method.enabled && method.account
  );
}

export function paymentVerificationStatus(payment = {}) {
  return payment?.verificationStatus === "pending" ? "pending" : "verified";
}

export function isPaymentVerified(payment = {}) {
  return paymentVerificationStatus(payment) === "verified";
}

export function refundMethodForChannel(channel = "") {
  return normalizePaymentChannel(channel) === "douyin" ? "platform" : "account";
}

export function verifiedPaymentTotals(payments = []) {
  return (Array.isArray(payments) ? payments : []).reduce((totals, payment) => {
    const amount = Number(payment?.amount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) return totals;
    if (!isPaymentVerified(payment)) {
      if (payment?.type === "refund") totals.pendingRefunded += amount;
      else totals.pendingReceived += amount;
      totals.pendingCount += 1;
      return totals;
    }
    if (payment?.type === "refund") totals.refunded += amount;
    else totals.received += amount;
    return totals;
  }, {
    received: 0,
    refunded: 0,
    pendingReceived: 0,
    pendingRefunded: 0,
    pendingCount: 0,
  });
}
