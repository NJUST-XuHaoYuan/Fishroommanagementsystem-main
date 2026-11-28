// Shared by the API and the browser. Monetary arithmetic is integer cents;
// products of amounts and weights use BigInt so large valid inputs stay exact.
export const PURCHASE_COST_LIMITS = Object.freeze({
  lines: 1000, boxes: 1000, boxItems: 10000,
  quantity: 100000, totalQuantity: 1000000, money: 1000000000,
});
const FEES = ["internationalFreight", "documentFee", "domesticFreight", "miscFee", "importTax"];
const COMPONENTS = ["purchaseCents", ...FEES.map(key => `${key}Cents`)];
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const fail = (message, code = "PURCHASE_COST_INVALID") => {
  throw Object.assign(new Error(message), { statusCode: 400, code });
};
function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label}格式不正确`);
  return value;
}
function text(value, label, max = 200, required = false) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") fail(`${label}必须为文字`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) fail(`${label}${required ? "不能为空，且" : ""}最多 ${max} 个字`);
  return normalized;
}
function decimalScaled(value, label, max, defaultValue) {
  if (value === undefined && defaultValue !== undefined) value = defaultValue;
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "number" && !Number.isFinite(value))) fail(`${label}必须为非负数，最多两位小数`);
  const raw = String(value).trim();
  // Cap textual length before BigInt conversion. Blank, exponent notation and
  // implicit Number(null/false) coercions must not become a valid zero.
  if (raw.length > 32 || !/^\d+(?:\.\d{1,2})?$/.test(raw)) fail(`${label}必须为非负数，最多两位小数`);
  const [whole, fraction = ""] = raw.split(".");
  const scaled = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (scaled > BigInt(max) * 100n) fail(`${label}不能超过 ${max}`, "PURCHASE_COST_LIMIT_EXCEEDED");
  return Number(scaled);
}
function quantity(value, label) {
  if ((typeof value !== "number" && typeof value !== "string") ||
      (typeof value === "string" && !/^\d{1,7}$/.test(value.trim()))) fail(`${label}必须为非负整数`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > PURCHASE_COST_LIMITS.quantity) {
    fail(`${label}必须为 0 至 ${PURCHASE_COST_LIMITS.quantity} 的整数`, "PURCHASE_COST_QUANTITY_INVALID");
  }
  return result;
}
function collection(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail(`${label}必须为列表，且最多 ${maximum} 项`, "PURCHASE_COST_LIMIT_EXCEEDED");
  return value;
}
function uniqueId(value, label, seen) {
  const id = text(value, label, 120, true);
  if (seen.has(id)) fail(`${label}重复，请刷新后核对`, "PURCHASE_COST_DUPLICATE_ID");
  seen.add(id);
  return id;
}
function safeNumber(value, label = "采购总成本") {
  if (value < 0n || value > MAX_CENTS) fail(`${label}超出可安全计算范围`, "PURCHASE_COST_LIMIT_EXCEEDED");
  return Number(value);
}
const cents = value => decimalScaled(value, "金额", PURCHASE_COST_LIMITS.money);
const percent = value => decimalScaled(value, "比例", 100);

/** Normalize draft structure too; only completeness checks are deferred. */
export function normalizePurchaseProcurement(input, { confirmed = false } = {}) {
  const raw = object(input, "采购明细");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) fail("不支持的采购明细版本");
  if (raw.currency !== undefined && raw.currency !== "CNY") fail("采购成本仅支持人民币");
  const feesInput = raw.fees === undefined ? {} : object(raw.fees, "采购费用");
  const fees = Object.fromEntries(FEES.map(key => [key, decimalScaled(feesInput[key], "采购费用", PURCHASE_COST_LIMITS.money, 0) / 100]));
  const lineIds = new Set();
  const lines = collection(raw.lines, "采购品种", PURCHASE_COST_LIMITS.lines).map((entry, index) => {
    const line = object(entry, `采购品种 ${index + 1}`);
    return {
      id: uniqueId(line.id, "采购明细编号", lineIds),
      productId: text(line.productId, "采购商品", 120, true),
      productName: text(line.productName, "商品名称", 300),
      size: text(line.size, "商品规格"), origin: text(line.origin, "商品产地"),
      ...(line.speciesId !== undefined ? { speciesId: text(line.speciesId, "物种编号", 120) } : {}),
      quantity: quantity(line.quantity, "原采购数量"),
      unitPrice: decimalScaled(line.unitPrice, "采购单价", PURCHASE_COST_LIMITS.money) / 100,
      taxWeightPercent: decimalScaled(line.taxWeightPercent, "税金分摊权重比例", 100, 100) / 100,
    };
  });
  const totalQuantity = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (totalQuantity > PURCHASE_COST_LIMITS.totalQuantity) fail(`采购总数量不能超过 ${PURCHASE_COST_LIMITS.totalQuantity}`, "PURCHASE_COST_LIMIT_EXCEEDED");
  const boxIds = new Set(), itemIds = new Set(), boxNumbers = new Set();
  let itemCount = 0;
  const quantitiesByLine = new Map(lines.map(line => [line.id, 0]));
  const boxes = collection(raw.boxes, "箱单", PURCHASE_COST_LIMITS.boxes).map((entry, index) => {
    const box = object(entry, `箱单 ${index + 1}`);
    const id = uniqueId(box.id, "箱单编号", boxIds);
    const boxNo = text(box.boxNo, "箱号", 120, confirmed);
    if (boxNo && boxNumbers.has(boxNo)) fail("箱号不能重复", "PURCHASE_COST_DUPLICATE_BOX_NUMBER");
    if (boxNo) boxNumbers.add(boxNo);
    const boxLineIds = new Set();
    const items = collection(box.items, "箱内品种", PURCHASE_COST_LIMITS.boxItems).map(itemInput => {
      if (++itemCount > PURCHASE_COST_LIMITS.boxItems) fail(`箱内明细总数不能超过 ${PURCHASE_COST_LIMITS.boxItems}`, "PURCHASE_COST_LIMIT_EXCEEDED");
      const item = object(itemInput, "箱内品种");
      const itemId = uniqueId(item.id, "箱内明细编号", itemIds);
      const lineId = text(item.lineId, "箱内关联采购明细", 120, true);
      if (!lineIds.has(lineId)) fail("箱内品种必须关联本批次采购明细", "PURCHASE_COST_LINE_NOT_FOUND");
      if (boxLineIds.has(lineId)) fail("同一箱内的同一采购明细只能填写一行", "PURCHASE_COST_DUPLICATE_BOX_LINE");
      boxLineIds.add(lineId);
      const count = quantity(item.quantity, "箱内数量");
      quantitiesByLine.set(lineId, quantitiesByLine.get(lineId) + count);
      return { id: itemId, lineId, quantity: count,
        weightPercent: decimalScaled(item.weightPercent, "箱内品种合计重量占比", 100) / 100 };
    });
    if (confirmed && (!items.length || items.some(item => item.quantity === 0))) fail("每箱至少填写一种商品，箱内数量必须大于 0", "PURCHASE_COST_BOX_INCOMPLETE");
    if (confirmed && items.reduce((sum, item) => sum + percent(item.weightPercent), 0) !== 10000) {
      fail(`箱「${boxNo}」的重量占比合计必须为 100%`, "PURCHASE_COST_BOX_WEIGHT_INVALID");
    }
    return { id, boxNo, items };
  });
  if (confirmed) {
    if (!lines.length || lines.some(line => line.quantity === 0)) fail("至少填写一种商品，原采购数量必须大于 0", "PURCHASE_COST_LINES_INCOMPLETE");
    if (!boxes.length) fail("请补齐实际箱单后再确认成本", "PURCHASE_COST_BOX_INCOMPLETE");
    for (const line of lines) if (quantitiesByLine.get(line.id) !== line.quantity) {
      fail(`商品「${line.productName || line.productId}」箱内数量合计必须等于原采购数量 ${line.quantity}`, "PURCHASE_COST_QUANTITY_MISMATCH");
    }
    const taxWeight = lines.reduce((sum, line) => sum + BigInt(cents(line.unitPrice)) * BigInt(line.quantity) * BigInt(percent(line.taxWeightPercent)), 0n);
    if (cents(fees.importTax) > 0 && taxWeight === 0n) fail("税金大于 0 时，至少一种商品必须有正的采购金额和税金权重", "PURCHASE_COST_TAX_WEIGHT_ZERO");
  }
  // A partially filled draft must not become a vehicle for overflow either.
  const purchaseTotal = lines.reduce((sum, line) => sum + BigInt(cents(line.unitPrice)) * BigInt(line.quantity), 0n);
  safeNumber(purchaseTotal + FEES.reduce((sum, key) => sum + BigInt(cents(fees[key])), 0n));
  return { schemaVersion: 1, currency: "CNY", status: confirmed ? "confirmed" : "draft", lines, boxes, fees };
}

const idCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function allocate(total, entries) {
  const totalBig = BigInt(total);
  if (!totalBig) return entries.map(() => 0);
  const denominator = entries.reduce((sum, entry) => sum + BigInt(entry.weight), 0n);
  if (denominator <= 0n) fail("分摊权重合计必须大于 0", "PURCHASE_COST_WEIGHT_ZERO");
  const parts = entries.map((entry, index) => {
    const product = totalBig * BigInt(entry.weight);
    return { index, key: entry.key, amount: product / denominator, remainder: product % denominator };
  });
  let remainder = totalBig - parts.reduce((sum, entry) => sum + entry.amount, 0n);
  const priority = [...parts].sort((a, b) => a.remainder === b.remainder ? idCompare(a.key, b.key) : a.remainder > b.remainder ? -1 : 1);
  for (const entry of priority) {
    if (remainder === 0n) break;
    entry.amount += 1n; remainder -= 1n;
  }
  return parts.map(entry => safeNumber(entry.amount));
}
const emptyAmounts = () => Object.fromEntries(COMPONENTS.map(key => [key, 0]));
const totalAmounts = amount => ({ ...amount, totalCents: safeNumber(COMPONENTS.reduce((sum, key) => sum + BigInt(amount[key]), 0n)) });

/** Complete confirmed-mode calculation. Input order never controls rounding. */
export function calculatePurchaseBatchCosting(input) {
  const procurement = normalizePurchaseProcurement(input, { confirmed: true });
  const { lines, boxes, fees } = procurement;
  const lineAmounts = lines.map(line => ({ ...emptyAmounts(), purchaseCents: safeNumber(BigInt(cents(line.unitPrice)) * BigInt(line.quantity)) }));
  const lineIndexes = new Map(lines.map((line, index) => [line.id, index]));
  const boxFreight = allocate(cents(fees.internationalFreight), boxes.map(box => ({ key: box.id, weight: 1 })));
  const resultBoxes = boxes.map((box, boxIndex) => {
    const freights = allocate(boxFreight[boxIndex], box.items.map(item => ({ key: item.lineId, weight: percent(item.weightPercent) })));
    return { boxId: box.id, boxNo: box.boxNo, freightCents: boxFreight[boxIndex], items: box.items.map((item, index) => {
      const internationalFreightCents = freights[index];
      lineAmounts[lineIndexes.get(item.lineId)].internationalFreightCents += internationalFreightCents;
      return { itemId: item.id, lineId: item.lineId, quantity: item.quantity, weightPercent: item.weightPercent,
        ...emptyAmounts(), internationalFreightCents };
    }) };
  });
  for (const fee of ["documentFee", "domesticFreight", "miscFee", "importTax"]) {
    const amounts = allocate(cents(fees[fee]), lines.map((line, index) => ({ key: line.id,
      weight: fee === "importTax" ? BigInt(lineAmounts[index].purchaseCents) * BigInt(percent(line.taxWeightPercent)) : line.quantity })));
    amounts.forEach((value, index) => { lineAmounts[index][`${fee}Cents`] = value; });
  }
  const locationsByLine = new Map(lines.map(line => [line.id, []]));
  for (const box of resultBoxes) for (const item of box.items) locationsByLine.get(item.lineId).push({ item, boxId: box.boxId });
  for (const [lineIndex, line] of lines.entries()) {
    const locations = locationsByLine.get(line.id);
    for (const component of COMPONENTS.filter(key => key !== "internationalFreightCents")) {
      const parts = allocate(lineAmounts[lineIndex][component], locations.map(({ item, boxId }) => ({ key: boxId, weight: item.quantity })));
      locations.forEach(({ item }, index) => { item[component] = parts[index]; });
    }
  }
  const totals = emptyAmounts();
  for (const amount of lineAmounts) for (const component of COMPONENTS) totals[component] = safeNumber(BigInt(totals[component]) + BigInt(amount[component]));
  return {
    totals: { ...totalAmounts(totals), quantity: lines.reduce((sum, line) => sum + line.quantity, 0), lineCount: lines.length,
      productCount: new Set(lines.map(line => line.productId)).size, boxCount: boxes.length },
    lines: lines.map((line, index) => ({ lineId: line.id, quantity: line.quantity, ...totalAmounts(lineAmounts[index]) })),
    boxes: resultBoxes.map(box => ({ ...box, items: box.items.map(totalAmounts) })),
  };
}
