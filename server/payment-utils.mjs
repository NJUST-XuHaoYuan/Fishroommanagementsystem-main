export const PAYMENT_CHANNELS = ["wechat", "alipay", "douyin", "bank", "cash"];
export const DEFAULT_PAYMENT_METHOD_SETTINGS = [
  { id: "pm-wechat", name: "微信", channel: "wechat", account: "", enabled: false },
  { id: "pm-alipay", name: "支付宝", channel: "alipay", account: "", enabled: false },
  { id: "pm-douyin", name: "抖音", channel: "douyin", account: "抖店账户", enabled: true },
  { id: "pm-bank", name: "银行卡", channel: "bank", account: "", enabled: false },
  { id: "pm-cash", name: "现金", channel: "cash", account: "现金", enabled: true },
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
  if (!Array.isArray(settings?.paymentMethods)) {
    return DEFAULT_PAYMENT_METHOD_SETTINGS.map((method) => ({ ...method }));
  }
  const usedIds = new Set();
  return settings.paymentMethods.flatMap((method) => {
    const channel = normalizePaymentChannel(method?.channel);
    if (!channel) return [];
    const fallbackId = `pm-${channel}`;
    let id = String(method?.id ?? "").trim() || fallbackId;
    let suffix = 2;
    while (usedIds.has(id)) id = `${fallbackId}-${suffix++}`;
    usedIds.add(id);
    return [{
      id,
      name: String(method?.name ?? "").trim() || paymentChannelLabel(channel),
      channel,
      account: String(method?.account ?? "").trim(),
      enabled: method?.enabled === true,
    }];
  });
}

export function configuredPaymentMethods(settings = {}) {
  return normalizePaymentMethodSettings(settings).filter((method) => method.enabled && method.account);
}

export function configuredPaymentMethod(settings = {}, idOrChannel = "") {
  const selector = String(idOrChannel ?? "").trim();
  const methods = configuredPaymentMethods(settings);
  return methods.find((method) => method.id === selector) ??
    methods.find((method) => method.channel === normalizePaymentChannel(selector));
}

export function resolvePaymentMethodSnapshot(settings = {}, incoming = {}, current = {}) {
  const requestedPaymentMethodId = String(incoming.paymentMethodId ?? "").trim();
  const requestedChannel = normalizePaymentChannel(incoming.channel);
  const currentPaymentMethodId = String(current.paymentMethodId ?? "").trim();
  const currentPaymentMethodName = String(current.paymentMethodName ?? "").trim();
  const currentChannel = normalizePaymentChannel(current.channel);
  const currentAccount = String(current.account ?? "").trim();
  const preserveCurrentSnapshot = Boolean(currentChannel && currentAccount) &&
    currentChannel === requestedChannel &&
    (!requestedPaymentMethodId || requestedPaymentMethodId === currentPaymentMethodId);
  if (preserveCurrentSnapshot) {
    return {
      paymentMethodId: currentPaymentMethodId,
      paymentMethodName: currentPaymentMethodName || paymentChannelLabel(currentChannel),
      channel: currentChannel,
      account: currentAccount,
    };
  }
  const paymentMethod = configuredPaymentMethod(settings, requestedPaymentMethodId || requestedChannel);
  if (!paymentMethod) {
    const label = requestedChannel ? paymentChannelLabel(requestedChannel) : requestedPaymentMethodId || "未选择";
    throw new Error(`付款方式「${label}」未启用或未配置收款账户`);
  }
  return {
    paymentMethodId: paymentMethod.id,
    paymentMethodName: paymentMethod.name,
    channel: paymentMethod.channel,
    account: paymentMethod.account,
  };
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
