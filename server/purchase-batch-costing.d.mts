import type { PurchaseCostAllocation, PurchaseProcurement } from "../src/app/utils/purchaseBatchTypes";
export const PURCHASE_COST_LIMITS: Readonly<{
  lines: number; boxes: number; boxItems: number; quantity: number; totalQuantity: number; money: number;
}>;
export function normalizePurchaseProcurement(input: unknown, options?: { confirmed?: boolean }): PurchaseProcurement;
export function calculatePurchaseBatchCosting(procurement: unknown): PurchaseCostAllocation;
