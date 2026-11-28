export type PurchaseCostFees = {
  internationalFreight: number;
  documentFee: number;
  domesticFreight: number;
  miscFee: number;
  importTax: number;
};
export type PurchaseCostLine = {
  id: string;
  productId: string;
  productName: string;
  size: string;
  origin: string;
  speciesId?: string;
  quantity: number;
  unitPrice: number;
  taxWeightPercent: number;
};
export type PurchaseBoxItem = { id: string; lineId: string; quantity: number; weightPercent: number };
export type PurchaseBox = { id: string; boxNo: string; items: PurchaseBoxItem[] };
export type PurchaseAllocatedAmounts = {
  purchaseCents: number;
  internationalFreightCents: number;
  documentFeeCents: number;
  domesticFreightCents: number;
  miscFeeCents: number;
  importTaxCents: number;
  totalCents: number;
};
export type PurchaseCostAllocation = {
  totals: PurchaseAllocatedAmounts & { quantity: number; lineCount: number; productCount: number; boxCount: number };
  lines: (PurchaseAllocatedAmounts & { lineId: string; quantity: number })[];
  boxes: { boxId: string; boxNo: string; freightCents: number;
    items: (PurchaseAllocatedAmounts & { itemId: string; lineId: string; quantity: number; weightPercent: number })[] }[];
};
export type PurchaseProcurement = {
  schemaVersion: 1;
  currency: "CNY";
  status: "draft" | "confirmed";
  lines: PurchaseCostLine[];
  boxes: PurchaseBox[];
  fees: PurchaseCostFees;
  allocation?: PurchaseCostAllocation;
  updatedAt?: string;
  updatedBy?: string;
  confirmedAt?: string;
  confirmedBy?: string;
};
export type PurchaseBatchSaveMode = "legacy" | "draft" | "confirm";
