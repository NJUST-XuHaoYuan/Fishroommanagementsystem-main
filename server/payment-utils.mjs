export const PAYMENT_CHANNELS = ["wechat", "alipay", "douyin", "bank", "cash"];

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
