import { createHash } from "node:crypto";
import Papa from "papaparse";

export const DEFAULT_COMMISSION_RATE = 1;
export const DOUYIN_PLATFORM = "douyin";

const REQUIRED_DOUYIN_HEADERS = [
  "结算时间",
  "订单号",
  "结算金额",
  "结算账户",
  "结算单类型",
  "下单时间",
  "商品名称",
  "订单总价",
  "结算前退款金额",
  "用户实付",
  "收入合计",
  "平台服务费",
  "支出合计",
];

const MONEY_FIELDS = [
  "订单总价",
  "商品总价",
  "运费",
  "店铺券",
  "政府补贴商家垫资",
  "结算前退款金额",
  "平台补贴",
  "其他平台补贴",
  "政府补贴平台垫资",
  "达人补贴",
  "抖音支付补贴",
  "抖音月付营销补贴",
  "银行补贴",
  "以旧换新抵扣",
  "平台补贴运费",
  "用户实付",
  "收入合计",
  "平台服务费",
  "达人佣金",
  "服务商佣金",
  "渠道分成",
  "招商服务费",
  "站外推广费",
  "其他分成",
  "支出合计",
  "免佣金额",
  "结算金额",
];

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function parseMoney(value) {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^'/, "")
    .replace(/[,\s¥￥]/g, "");
  if (!normalized) return 0;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error(`无法识别金额：${value}`);
  return roundMoney(amount);
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizeExternalOrderNo(value) {
  return normalizeText(value)
    .replace(/^'+/, "")
    .replace(/^="([^"]+)"$/, "$1")
    .replace(/\s+/g, "");
}

export function normalizeCommissionRate(value, fallback = DEFAULT_COMMISSION_RATE) {
  const candidate = value === "" || value == null ? Number(fallback) : Number(value);
  if (!Number.isFinite(candidate)) return Number(fallback);
  return Number(Math.min(100, Math.max(0, candidate)).toFixed(4));
}

export function calculateOrderFeeBreakdown(order = {}, adjustments = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const itemSubtotal = roundMoney(items.reduce(
    (sum, item) => sum + Number(item?.price ?? 0),
    0
  ));
  const discount = roundMoney(Math.max(0, Number(order?.discount ?? 0)));
  const goodsNetTotal = roundMoney(itemSubtotal - discount);
  const orderShippingFee = roundMoney(Math.max(0, Number(order?.shippingFee ?? 0)));
  const billableShippingFee = roundMoney(Math.max(
    0,
    Number(adjustments?.billableShippingFee ?? orderShippingFee)
  ));
  const shippingFeeAdjustment = roundMoney(billableShippingFee - orderShippingFee);
  const packagingFee = roundMoney(Math.max(0, Number(order?.packagingFee ?? 0)));
  const damageRefundAdjustment = roundMoney(Math.max(
    0,
    Number(adjustments?.damageRefundAdjustment ?? 0)
  ));
  const calculatedReceivable = roundMoney(
    goodsNetTotal + billableShippingFee + packagingFee - damageRefundAdjustment
  );

  return {
    itemSubtotal,
    discount,
    goodsNetTotal,
    orderShippingFee,
    billableShippingFee,
    shippingFeeAdjustment,
    packagingFee,
    damageRefundAdjustment,
    calculatedReceivable,
  };
}

export function calculateOrderCommission(order = {}, defaultRate = DEFAULT_COMMISSION_RATE) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const productAmount = roundMoney(items.reduce((sum, item) => sum + Number(item?.price ?? 0), 0));
  const discount = roundMoney(Math.max(0, Number(order?.discount ?? 0)));
  const commissionBase = roundMoney(Math.max(0, productAmount - discount));
  const minimumReturnTotal = roundMoney(items.reduce(
    (sum, item) => sum + Math.max(0, Number(item?.minReturnPrice ?? 0)),
    0
  ));
  const commissionCap = roundMoney(Math.max(0, commissionBase - minimumReturnTotal));
  const commissionRate = normalizeCommissionRate(order?.commissionRate, defaultRate);
  const nominalCommission = roundMoney(commissionBase * commissionRate / 100);
  const commissionAmount = order?.status === "cancelled"
    ? 0
    : roundMoney(Math.min(nominalCommission, commissionCap));
  return {
    commissionRate,
    commissionBase,
    minimumReturnTotal,
    commissionCap,
    commissionAmount,
  };
}

export function financeFileHash(csvText) {
  return createHash("sha256").update(String(csvText ?? ""), "utf8").digest("hex");
}

export function settlementFingerprint(record = {}) {
  return createHash("sha256")
    .update([
      DOUYIN_PLATFORM,
      record.externalOrderNo,
      record.subOrderNo,
      record.settlementTime,
      record.settlementType,
      record.settlementAmount,
      record.preSettlementRefund,
    ].join("|"), "utf8")
    .digest("hex");
}

function normalizeSettlementRow(row, rowNumber) {
  const externalOrderNo = normalizeExternalOrderNo(row["订单号"]);
  if (!externalOrderNo) return null;

  const normalizedMoney = Object.fromEntries(
    MONEY_FIELDS.map((field) => [field, parseMoney(row[field])])
  );
  const record = {
    rowNumber,
    externalOrderNo,
    subOrderNo: normalizeExternalOrderNo(row["子订单号"]),
    settlementTime: normalizeText(row["结算时间"]),
    settlementAccount: normalizeText(row["结算账户"]),
    settlementType: normalizeText(row["结算单类型"]),
    hasPreSettlementRefund: normalizeText(row["有结算前退款"]) === "是",
    orderTime: normalizeText(row["下单时间"]),
    productId: normalizeExternalOrderNo(row["商品ID"]),
    productName: normalizeText(row["商品名称"]),
    quantity: Math.max(0, Number(normalizeText(row["商品数量"]) || 0)),
    influencerId: normalizeExternalOrderNo(row["达人ID"]),
    influencerName: normalizeText(row["达人名称"]),
    businessType: normalizeText(row["业务类型"]),
    orderType: normalizeText(row["订单类型"]),
    orderTotal: normalizedMoney["订单总价"],
    productTotal: normalizedMoney["商品总价"],
    shippingFee: normalizedMoney["运费"],
    storeCoupon: normalizedMoney["店铺券"],
    merchantGovernmentAdvance: normalizedMoney["政府补贴商家垫资"],
    preSettlementRefund: normalizedMoney["结算前退款金额"],
    platformSubsidy: normalizedMoney["平台补贴"],
    otherPlatformSubsidy: normalizedMoney["其他平台补贴"],
    governmentPlatformAdvance: normalizedMoney["政府补贴平台垫资"],
    influencerSubsidy: normalizedMoney["达人补贴"],
    douyinPaySubsidy: normalizedMoney["抖音支付补贴"],
    douyinMonthlyPaySubsidy: normalizedMoney["抖音月付营销补贴"],
    bankSubsidy: normalizedMoney["银行补贴"],
    tradeInDeduction: normalizedMoney["以旧换新抵扣"],
    platformShippingSubsidy: normalizedMoney["平台补贴运费"],
    userPaid: normalizedMoney["用户实付"],
    incomeTotal: normalizedMoney["收入合计"],
    platformServiceFee: normalizedMoney["平台服务费"],
    influencerCommission: normalizedMoney["达人佣金"],
    serviceProviderCommission: normalizedMoney["服务商佣金"],
    channelShare: normalizedMoney["渠道分成"],
    merchantServiceFee: normalizedMoney["招商服务费"],
    offsitePromotionFee: normalizedMoney["站外推广费"],
    otherShare: normalizedMoney["其他分成"],
    otherShareDescription: normalizeText(row["其他分成说明"]),
    expenseTotal: normalizedMoney["支出合计"],
    commissionExempt: normalizeText(row["是否免佣"]),
    commissionExemptAmount: normalizedMoney["免佣金额"],
    settlementAmount: normalizedMoney["结算金额"],
    merchantName: normalizeText(row["商户主体名称"]),
    appChannel: normalizeText(row["APP渠道"]),
    notes: normalizeText(row["备注"]),
    rawData: Object.fromEntries(
      Object.entries(row).map(([key, value]) => [String(key), value == null ? "" : String(value)])
    ),
  };
  return {
    ...record,
    fingerprint: settlementFingerprint(record),
    formulaMatches: Math.abs(record.settlementAmount - record.incomeTotal - record.expenseTotal) <= 0.02,
  };
}

export function parseDouyinSettlementCsv(csvText) {
  const text = String(csvText ?? "");
  if (!text.trim()) throw new Error("请选择抖店结算 CSV 文件");
  if (Buffer.byteLength(text, "utf8") > 12 * 1024 * 1024) {
    throw new Error("CSV 文件不能超过 12MB");
  }

  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => String(header ?? "").replace(/^\uFEFF/, "").trim(),
  });
  const headers = Array.isArray(parsed.meta?.fields) ? parsed.meta.fields : [];
  const missingHeaders = REQUIRED_DOUYIN_HEADERS.filter((header) => !headers.includes(header));
  if (missingHeaders.length > 0) {
    throw new Error(`抖店结算表缺少字段：${missingHeaders.join("、")}`);
  }

  const records = [];
  const rowErrors = [];
  for (let index = 0; index < parsed.data.length; index += 1) {
    try {
      const record = normalizeSettlementRow(parsed.data[index] ?? {}, index + 2);
      if (record) records.push(record);
    } catch (error) {
      rowErrors.push({
        rowNumber: index + 2,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (records.length === 0) throw new Error("CSV 中没有可导入的抖店结算记录");

  const parserErrors = (Array.isArray(parsed.errors) ? parsed.errors : [])
    .filter((error) => error?.code !== "TooFewFields")
    .map((error) => ({
      rowNumber: Number(error?.row ?? 0) + 2,
      message: String(error?.message ?? "CSV 解析失败"),
    }));
  const errors = [...parserErrors, ...rowErrors];
  const totals = records.reduce((summary, record) => ({
    orderTotal: roundMoney(summary.orderTotal + record.orderTotal),
    incomeTotal: roundMoney(summary.incomeTotal + record.incomeTotal),
    refundTotal: roundMoney(summary.refundTotal + Math.abs(record.preSettlementRefund)),
    platformFees: roundMoney(summary.platformFees + Math.abs(record.expenseTotal)),
    settlementAmount: roundMoney(summary.settlementAmount + record.settlementAmount),
  }), {
    orderTotal: 0,
    incomeTotal: 0,
    refundTotal: 0,
    platformFees: 0,
    settlementAmount: 0,
  });

  return {
    headers,
    records,
    errors,
    totals,
    fileHash: financeFileHash(text),
  };
}
