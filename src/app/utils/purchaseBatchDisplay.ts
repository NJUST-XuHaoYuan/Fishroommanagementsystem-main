import type { PurchaseBatch, Product } from "../store";
import type { PurchaseCostLine, PurchaseProcurement, PurchaseBox } from "./purchaseBatchTypes";

export const PURCHASE_FEE_LABELS = [
  ["internationalFreight", "总运费", "各箱等额，再按箱内重量占比分摊"],
  ["documentFee", "文件费", "按采购数量分摊"],
  ["domesticFreight", "国内运费", "按采购数量分摊"],
  ["miscFee", "杂费", "按采购数量分摊"],
  ["importTax", "进口税", "按采购金额 × 税金权重分摊"],
] as const;

export function batchPurchaseTotal(batch: Pick<PurchaseBatch, "bioFee" | "shippingFee" | "totalCost" | "procurement">): number | null {
  if (typeof batch.totalCost === "number" && Number.isFinite(batch.totalCost)) return batch.totalCost;
  if (batch.procurement?.status === "draft") return null;
  return Number(batch.bioFee || 0) + Number(batch.shippingFee || 0);
}

const BATCH_COST_ROWS = [
  { key: "purchase", label: "生物采购金额", centsKey: "purchaseCents" },
  { key: "internationalFreight", label: "国际运费", centsKey: "internationalFreightCents" },
  { key: "documentFee", label: "文件费", centsKey: "documentFeeCents" },
  { key: "domesticFreight", label: "国内运费", centsKey: "domesticFreightCents" },
  { key: "miscFee", label: "杂费", centsKey: "miscFeeCents" },
  { key: "importTax", label: "进口税金", centsKey: "importTaxCents" },
] as const;

export type BatchCostBreakdown = {
  mode: "confirmed" | "draft" | "legacy";
  rows: { key: typeof BATCH_COST_ROWS[number]["key"]; label: string; amount: number | null }[];
  total: number | null;
};
type BatchCostInput = Pick<PurchaseBatch, "bioFee" | "shippingFee" | "totalCost" | "procurement">;

function validCostCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return Math.round(value / 100 * 100) === value ? value : null;
}
function amountCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) <= 0.000001 ? validCostCents(cents) : null;
}
function sumCostCents(values: (number | null)[]): number | null {
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return validCostCents(sum);
}

/** Distinguishes confirmed allocations, unfinished estimates and unitemized history. */
export function batchCostBreakdown(batch: BatchCostInput): BatchCostBreakdown {
  const procurement = batch.procurement;
  const mode = !procurement ? "legacy" : procurement.status === "confirmed" ? "confirmed" : "draft";
  let values: (number | null)[];
  let totalCents: number | null;
  if (mode === "confirmed") {
    const totals = procurement?.allocation?.totals;
    values = BATCH_COST_ROWS.map(row => validCostCents(totals?.[row.centsKey]));
    const allocatedTotal = validCostCents(totals?.totalCents);
    const savedTotal = amountCents(batch.totalCost);
    // Do not conceal missing/corrupt allocations with old two-category totals.
    totalCents = allocatedTotal !== null && sumCostCents(values) === allocatedTotal && savedTotal === allocatedTotal
      ? allocatedTotal : null;
  } else if (mode === "draft") {
    const validDraft = procurement?.status === "draft";
    const lines = validDraft && Array.isArray(procurement.lines) ? procurement.lines : [];
    const purchaseCents = lines.length ? sumCostCents(lines.map(line => {
      if (!line || !Number.isSafeInteger(line.quantity) || line.quantity <= 0) return null;
      const unitCents = amountCents(line.unitPrice);
      return unitCents === null ? null : validCostCents(unitCents * line.quantity);
    })) : null;
    values = BATCH_COST_ROWS.map(row => row.key === "purchase" ? purchaseCents
      : validDraft ? amountCents(procurement.fees?.[row.key]) : null);
    totalCents = sumCostCents(values);
  } else {
    values = [amountCents(batch.bioFee), amountCents(batch.shippingFee), null, null, null, null];
    const legacyTotal = amountCents(batchPurchaseTotal(batch));
    // An explicit historical total is authoritative; incomplete component fields
    // must not silently turn into zero when no total was ever recorded.
    totalCents = amountCents(batch.totalCost) !== null || values[0] !== null && values[1] !== null ? legacyTotal : null;
  }
  return {
    mode,
    rows: BATCH_COST_ROWS.map((row, index) => ({ key: row.key,
      label: mode === "legacy" && row.key === "internationalFreight" ? "运输费用" : row.label,
      amount: values[index] === null ? null : values[index]! / 100 })),
    total: totalCents === null ? null : totalCents / 100,
  };
}

export function emptyPurchaseProcurement(): PurchaseProcurement {
  return { schemaVersion: 1, currency: "CNY", status: "draft", lines: [], boxes: [], fees: {
    internationalFreight: 0, documentFee: 0, domesticFreight: 0, miscFee: 0, importTax: 0,
  } };
}

export function purchaseLineFromProduct(product: Product, id: string): PurchaseCostLine {
  return { id, productId: product.id, productName: product.name, size: product.size, origin: product.origin,
    speciesId: product.speciesId, quantity: 0, unitPrice: 0, taxWeightPercent: 100 };
}

export function purchaseLineLabel(line: PurchaseCostLine): string {
  return [line.productName, line.size, line.origin].filter(Boolean).join(" · ");
}

export function purchasePackingProgress(lines: PurchaseCostLine[], boxes: PurchaseBox[]) {
  return lines.map(line => {
    const packed = boxes.reduce((sum, box) => sum + box.items.filter(item => item.lineId === line.id).reduce((n, item) => n + (Number.isFinite(item.quantity) ? item.quantity : 0), 0), 0);
    return { lineId: line.id, purchased: line.quantity, packed, remaining: line.quantity - packed };
  });
}

export function removePurchaseLine(procurement: PurchaseProcurement, lineId: string): PurchaseProcurement {
  return { ...procurement, lines: procurement.lines.filter(line => line.id !== lineId),
    boxes: procurement.boxes.map(box => ({ ...box, items: box.items.filter(item => item.lineId !== lineId) })) };
}

export function purchaseBasicError(batch: Pick<PurchaseBatch, "supplier" | "arrivalDate">, today: string, arrivalDateMax?: string) {
  if (!batch.supplier.trim()) return "请填写供应商。";
  if (!batch.arrivalDate) return "请选择到货日期。";
  if (batch.arrivalDate > today) return "到货日期不能晚于今天。";
  if (arrivalDateMax && batch.arrivalDate > arrivalDateMax) return "到货日期不能晚于该批次最早入库日期。";
  return "";
}

export function purchaseLineStepError(lines: PurchaseCostLine[]) {
  if (!lines.length) return "请先添加采购商品。";
  for (const line of lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) return `${line.productName}：采购数量须为正整数。`;
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0 || Math.abs(line.unitPrice * 100 - Math.round(line.unitPrice * 100)) > 0.000001) return `${line.productName}：请填写有效采购单价，最多两位小数。`;
  }
  return "";
}
