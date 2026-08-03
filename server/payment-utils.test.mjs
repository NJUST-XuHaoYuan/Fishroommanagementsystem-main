import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredPaymentMethod,
  configuredPaymentMethods,
  isPaymentVerified,
  normalizePaymentChannel,
  normalizePaymentMethodSettings,
  resolvePaymentMethodSnapshot,
  refundMethodForChannel,
  verifiedPaymentTotals,
} from "./payment-utils.mjs";

test("payment methods fail closed until an account is configured", () => {
  assert.equal(configuredPaymentMethod({}, "wechat"), undefined);
  assert.deepEqual(configuredPaymentMethod({}, "douyin"), {
    id: "pm-douyin",
    name: "抖音",
    channel: "douyin",
    account: "抖店账户",
    enabled: true,
  });
  assert.equal(configuredPaymentMethod({}, "xianyu")?.account, "闲鱼账户");
  assert.equal(configuredPaymentMethod({}, "weipaitang")?.account, "微拍堂账户");
  assert.deepEqual(configuredPaymentMethod({}, "cash"), {
    id: "pm-cash",
    name: "现金",
    channel: "cash",
    account: "现金",
    enabled: true,
  });
});

test("configured payment methods preserve custom rows and normalize account text", () => {
  const methods = normalizePaymentMethodSettings({
    paymentMethods: [
      { id: "bank-main", name: "对公银行卡", channel: "bank", account: "  农行 1234  ", enabled: true },
      { id: "wechat-nanjing", name: "微信南京店", channel: "wechat", account: "南京海森", enabled: true },
      { channel: "unknown", account: "ignored", enabled: true },
    ],
  });
  assert.deepEqual(methods.map((method) => method.id), ["bank-main", "wechat-nanjing", "pm-xianyu", "pm-weipaitang"]);
  assert.equal(configuredPaymentMethod({ paymentMethods: methods }, "bank-main")?.account, "农行 1234");
  assert.equal(configuredPaymentMethod({ paymentMethods: methods }, "alipay"), undefined);
});

test("multiple methods may share a channel and remain selectable by id", () => {
  const settings = {
    paymentMethods: [
      { id: "wechat-nanjing", name: "微信南京店", channel: "wechat", account: "南京账户", enabled: true },
      { id: "wechat-beijing", name: "微信北京店", channel: "wechat", account: "北京账户", enabled: true },
      { id: "wechat-disabled", name: "微信停用", channel: "wechat", account: "旧账户", enabled: false },
    ],
  };
  assert.deepEqual(configuredPaymentMethods(settings).map((method) => method.id), ["wechat-nanjing", "wechat-beijing", "pm-xianyu", "pm-weipaitang"]);
  assert.equal(configuredPaymentMethod(settings, "wechat-beijing")?.account, "北京账户");
  assert.equal(configuredPaymentMethod(settings, "wechat")?.id, "wechat-nanjing");
});

test("new marketplace payment methods are added to an existing configuration", () => {
  assert.deepEqual(
    normalizePaymentMethodSettings({ paymentMethods: [] }).map((method) => method.channel),
    ["xianyu", "weipaitang"]
  );
  assert.equal(configuredPaymentMethod({ paymentMethods: [] }, "cash"), undefined);
});

test("payment snapshots preserve history and use configured data when switching", () => {
  const settings = {
    paymentMethods: [
      { id: "wechat-main", name: "微信新账户", channel: "wechat", account: "新账户", enabled: true },
      { id: "bank-main", name: "对公银行卡", channel: "bank", account: "银行卡账户", enabled: true },
    ],
  };
  assert.deepEqual(resolvePaymentMethodSnapshot(settings, {
    paymentMethodId: "wechat-main",
    channel: "wechat",
    account: "伪造账户",
  }, {
    paymentMethodId: "wechat-main",
    paymentMethodName: "微信旧账户",
    channel: "wechat",
    account: "旧账户",
  }), {
    paymentMethodId: "wechat-main",
    paymentMethodName: "微信旧账户",
    channel: "wechat",
    account: "旧账户",
  });
  assert.deepEqual(resolvePaymentMethodSnapshot(settings, {
    paymentMethodId: "bank-main",
    channel: "bank",
    account: "伪造账户",
  }, {
    paymentMethodId: "wechat-main",
    paymentMethodName: "微信旧账户",
    channel: "wechat",
    account: "旧账户",
  }), {
    paymentMethodId: "bank-main",
    paymentMethodName: "对公银行卡",
    channel: "bank",
    account: "银行卡账户",
  });
});

test("legacy snapshots remain usable after their configuration is removed", () => {
  assert.deepEqual(resolvePaymentMethodSnapshot({ paymentMethods: [] }, {
    channel: "wechat",
  }, {
    channel: "wechat",
    account: "历史账户",
  }), {
    paymentMethodId: "",
    paymentMethodName: "微信",
    channel: "wechat",
    account: "历史账户",
  });
  assert.throws(
    () => resolvePaymentMethodSnapshot({ paymentMethods: [] }, { channel: "bank" }, {}),
    /未启用或未配置收款账户/
  );
});

test("legacy payments remain verified", () => {
  assert.equal(isPaymentVerified({ type: "balance", amount: 100 }), true);
  assert.equal(isPaymentVerified({ verificationStatus: "pending" }), false);
});

test("verified totals exclude pending declarations", () => {
  assert.deepEqual(verifiedPaymentTotals([
    { type: "balance", amount: 500 },
    { type: "refund", amount: 100, verificationStatus: "verified" },
    { type: "refund", amount: 80, verificationStatus: "pending" },
    { type: "balance", amount: 120, verificationStatus: "pending" },
  ]), {
    received: 500,
    refunded: 100,
    pendingReceived: 120,
    pendingRefunded: 80,
    pendingCount: 2,
  });
});

test("refund path follows the actual funds location", () => {
  assert.equal(refundMethodForChannel("douyin"), "platform");
  assert.equal(refundMethodForChannel("xianyu"), "platform");
  assert.equal(refundMethodForChannel("weipaitang"), "platform");
  assert.equal(refundMethodForChannel("wechat"), "account");
  assert.equal(refundMethodForChannel("alipay"), "account");
  assert.equal(refundMethodForChannel("bank"), "account");
  assert.equal(refundMethodForChannel("cash"), "account");
  assert.equal(normalizePaymentChannel("unknown"), "");
});
