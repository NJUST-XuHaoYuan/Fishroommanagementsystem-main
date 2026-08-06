import { createHash } from "node:crypto";
import Papa from "papaparse";

const MAX_FILE_BYTES = 12 * 1024 * 1024;

const FIELD_ALIASES = {
  transactionNo: [
    "交易单号", "交易流水号", "支付流水号", "流水号", "银行流水号",
    "微信支付订单号", "支付宝交易号", "商户订单号", "业务流水号", "凭证号",
  ],
  occurredAt: [
    "交易时间", "付款时间", "收款时间", "入账时间", "记账时间", "发生时间", "创建时间",
  ],
  amount: ["交易金额", "金额", "金额(元)", "金额（元）", "收款金额", "到账金额", "实收金额"],
  income: ["收入金额", "收入", "贷方金额", "收入(元)", "收入（元）"],
  expense: ["支出金额", "支出", "借方金额", "支出(元)", "支出（元）"],
  payerName: [
    "付款方", "付款人", "付款方名称", "交易对方", "对方户名", "对方名称",
    "对方账号", "用户昵称", "微信昵称", "支付宝账号",
  ],
  direction: ["收支类型", "收支", "资金方向", "交易方向", "借贷标志"],
  transactionType: ["交易类型", "业务类型", "交易分类", "商品说明"],
  notes: ["备注", "附言", "摘要", "交易备注", "付款备注", "商品名称"],
};

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizeText(value) {
  return String(value ?? "").trim().replace(/^'+/, "");
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase().replace(/[\s\-_—–]+/g, "");
}

function firstValue(row, aliases) {
  for (const alias of aliases) {
    const value = row?.[alias];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function parseMoney(value) {
  const normalized = normalizeText(value)
    .replace(/[¥￥,\s]/g, "")
    .replace(/^\((.+)\)$/, "-$1");
  if (!normalized) return 0;
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) throw new Error(`无法识别金额：${value}`);
  return roundMoney(amount);
}

function statementDirection(row, rawAmount) {
  const income = parseMoney(firstValue(row, FIELD_ALIASES.income));
  const expense = parseMoney(firstValue(row, FIELD_ALIASES.expense));
  if (Math.abs(income) > 0.005 && Math.abs(expense) <= 0.005) return { direction: "income", amount: Math.abs(income) };
  if (Math.abs(expense) > 0.005 && Math.abs(income) <= 0.005) return { direction: "expense", amount: Math.abs(expense) };

  const hint = `${firstValue(row, FIELD_ALIASES.direction)} ${firstValue(row, FIELD_ALIASES.transactionType)}`;
  if (/支出|付款|退款|转出|借方|支取/.test(hint)) return { direction: "expense", amount: Math.abs(rawAmount) };
  if (/收入|收款|入账|转入|贷方|收取/.test(hint)) return { direction: "income", amount: Math.abs(rawAmount) };
  return { direction: rawAmount < 0 ? "expense" : "income", amount: Math.abs(rawAmount) };
}

export function paymentStatementFingerprint(record = {}) {
  return createHash("sha256")
    .update([
      record.channel,
      normalizeComparable(record.account),
      normalizeComparable(record.externalTransactionNo),
      normalizeText(record.occurredAt),
      roundMoney(record.amount),
      record.direction,
      normalizeComparable(record.payerName),
    ].join("|"), "utf8")
    .digest("hex");
}

export function parsePaymentStatementCsv(csvText, context = {}) {
  const text = String(csvText ?? "");
  if (!text.trim()) throw new Error("请选择收款账单 CSV 文件");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("CSV 文件不能超过 12MB");

  const channel = normalizeText(context.channel);
  const account = normalizeText(context.account);
  if (!channel || !account) throw new Error("请先选择账单对应的收款账户");

  const parsed = Papa.parse(text, {
    header: false,
    skipEmptyLines: "greedy",
  });
  const parsedRows = Array.isArray(parsed.data) ? parsed.data : [];
  const amountAliases = [...FIELD_ALIASES.amount, ...FIELD_ALIASES.income, ...FIELD_ALIASES.expense];
  const headerIndex = parsedRows.slice(0, 50).findIndex((cells) => {
    const headers = (Array.isArray(cells) ? cells : []).map((cell) => normalizeText(cell).replace(/^\uFEFF/, ""));
    return FIELD_ALIASES.occurredAt.some((field) => headers.includes(field)) &&
      amountAliases.some((field) => headers.includes(field));
  });
  if (headerIndex < 0) throw new Error("收款账单缺少字段：交易时间、交易金额");
  const headers = parsedRows[headerIndex].map((cell) => normalizeText(cell).replace(/^\uFEFF/, ""));
  const dataRows = parsedRows.slice(headerIndex + 1).map((cells) => Object.fromEntries(
    headers.flatMap((header, index) => header ? [[header, cells?.[index] ?? ""]] : [])
  ));

  const records = [];
  const errors = [];
  for (let index = 0; index < dataRows.length; index += 1) {
    const row = dataRows[index] ?? {};
    try {
      const occurredAt = firstValue(row, FIELD_ALIASES.occurredAt);
      const rawAmount = parseMoney(firstValue(row, FIELD_ALIASES.amount));
      const { direction, amount } = statementDirection(row, rawAmount);
      if (!occurredAt || amount <= 0.005) continue;
      const record = {
        rowNumber: headerIndex + index + 2,
        paymentMethodId: normalizeText(context.paymentMethodId),
        paymentMethodName: normalizeText(context.paymentMethodName),
        channel,
        account,
        externalTransactionNo: firstValue(row, FIELD_ALIASES.transactionNo),
        occurredAt,
        amount: roundMoney(amount),
        direction,
        payerName: firstValue(row, FIELD_ALIASES.payerName),
        notes: firstValue(row, FIELD_ALIASES.notes),
        rawData: Object.fromEntries(
          Object.entries(row).map(([key, value]) => [String(key), value == null ? "" : String(value)])
        ),
      };
      records.push({ ...record, fingerprint: paymentStatementFingerprint(record) });
    } catch (error) {
      errors.push({ rowNumber: headerIndex + index + 2, message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (records.length === 0) throw new Error("CSV 中没有可导入的收付款记录");

  const parserErrors = (Array.isArray(parsed.errors) ? parsed.errors : [])
    .filter((error) => error?.code !== "TooFewFields")
    .map((error) => ({ rowNumber: Number(error?.row ?? 0) + 1, message: String(error?.message ?? "CSV 解析失败") }));
  return {
    headers,
    records,
    errors: [...parserErrors, ...errors],
    fileHash: createHash("sha256").update(text, "utf8").digest("hex"),
    totals: records.reduce((summary, record) => ({
      income: roundMoney(summary.income + (record.direction === "income" ? record.amount : 0)),
      expense: roundMoney(summary.expense + (record.direction === "expense" ? record.amount : 0)),
    }), { income: 0, expense: 0 }),
  };
}

function dateDistanceDays(left, right) {
  const leftTime = Date.parse(String(left ?? "").replace(" ", "T"));
  const rightTime = Date.parse(String(right ?? "").replace(" ", "T"));
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 999;
  return Math.abs(leftTime - rightTime) / 86_400_000;
}

function matchingReason({ exactOutstanding, exactReceivable, orderNoHit, payerHit, days }) {
  const reasons = [];
  if (orderNoHit) reasons.push("账单备注含订单号");
  if (exactOutstanding) reasons.push("金额等于待收余额");
  else if (exactReceivable) reasons.push("金额等于订单应收");
  if (payerHit) reasons.push("付款方与客户一致");
  if (days <= 3) reasons.push("付款时间接近下单时间");
  return reasons.join("、") || "账户和金额接近";
}

export function matchPaymentStatement(statement = {}, orders = []) {
  if (statement.direction === "expense") {
    const candidates = (Array.isArray(orders) ? orders : []).flatMap((order) => {
      if (normalizeText(order?.paymentChannel) !== normalizeText(statement?.channel)) return [];
      if (normalizeComparable(order?.paymentAccount) !== normalizeComparable(statement?.account)) return [];
      const refund = (Array.isArray(order?.pendingRefunds) ? order.pendingRefunds : [])
        .find((payment) => Math.abs(Number(payment?.amount ?? 0) - Number(statement.amount ?? 0)) <= 0.01);
      if (!refund) return [];
      return [{
        orderId: String(order.id ?? ""),
        orderNo: String(order.orderNo ?? ""),
        customerName: String(order.customerName ?? ""),
        contactPerson: String(order.contactPerson ?? ""),
        receivable: roundMoney(order.receivable),
        outstanding: roundMoney(refund.amount),
        score: 100,
        reason: "退款金额与待核销退款一致",
        exactAmount: true,
      }];
    });
    return {
      matchedOrderId: candidates.length === 1 ? candidates[0].orderId : "",
      candidates: candidates.slice(0, 8),
      reason: candidates.length === 1
        ? candidates[0].reason
        : candidates.length > 1
          ? "存在多笔同金额待核销退款，需要财务确认"
          : "未找到同渠道、同账户、同金额的待核销退款",
    };
  }
  if (statement.direction !== "income") return { matchedOrderId: "", candidates: [], reason: "无法识别流水方向" };
  const statementAccount = normalizeComparable(statement.account);
  const statementChannel = normalizeText(statement.channel);
  const statementText = normalizeComparable([
    statement.externalTransactionNo,
    statement.payerName,
    statement.notes,
    ...Object.values(statement.rawData ?? {}),
  ].join(" "));

  const candidates = (Array.isArray(orders) ? orders : []).flatMap((order) => {
    if (order?.status === "cancelled") return [];
    if (normalizeText(order?.paymentChannel) !== statementChannel) return [];
    if (normalizeComparable(order?.paymentAccount) !== statementAccount) return [];
    const outstanding = roundMoney(order?.matchingOutstanding ?? order?.balance ?? order?.receivable);
    if (outstanding <= 0.005) return [];
    const receivable = roundMoney(order?.receivable);
    const amount = roundMoney(statement.amount);
    const exactOutstanding = Math.abs(amount - outstanding) <= 0.01;
    const exactReceivable = Math.abs(amount - receivable) <= 0.01 && Math.abs(outstanding - receivable) <= 0.01;
    const tolerance = Math.max(1, amount * 0.02);
    const amountDifference = Math.abs(amount - outstanding);
    const orderNoHit = Boolean(order?.orderNo && statementText.includes(normalizeComparable(order.orderNo)));
    if (!orderNoHit && !exactOutstanding && !exactReceivable && amountDifference > tolerance) return [];

    const customerText = normalizeComparable(order?.customerName);
    const payerText = normalizeComparable(statement.payerName);
    const payerHit = Boolean(customerText && payerText && (customerText.includes(payerText) || payerText.includes(customerText)));
    const days = dateDistanceDays(statement.occurredAt, order?.createdAt || order?.date);
    let score = orderNoHit ? 120 : 0;
    if (exactOutstanding) score += 70;
    else if (exactReceivable) score += 60;
    else score += Math.max(0, 35 - amountDifference);
    if (payerHit) score += 20;
    if (days <= 1) score += 15;
    else if (days <= 3) score += 10;
    else if (days <= 14) score += 5;
    return [{
      orderId: String(order.id ?? ""),
      orderNo: String(order.orderNo ?? ""),
      customerName: String(order.customerName ?? ""),
      contactPerson: String(order.contactPerson ?? ""),
      receivable,
      outstanding,
      score: Number(score.toFixed(2)),
      reason: matchingReason({ exactOutstanding, exactReceivable, orderNoHit, payerHit, days }),
      exactAmount: exactOutstanding || exactReceivable,
    }];
  }).sort((left, right) => right.score - left.score || left.orderNo.localeCompare(right.orderNo));

  const top = candidates[0];
  const second = candidates[1];
  const unambiguous = Boolean(
    top && top.exactAmount && top.score >= 75 && (!second || top.score - second.score >= 20)
  );
  return {
    matchedOrderId: unambiguous ? top.orderId : "",
    candidates: candidates.slice(0, 8),
    reason: unambiguous ? top.reason : candidates.length > 0 ? "存在多个可能订单，需要负责人或财务确认" : "未找到金额和账户相符的订单",
  };
}
