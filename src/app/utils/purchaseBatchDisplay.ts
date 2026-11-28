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
