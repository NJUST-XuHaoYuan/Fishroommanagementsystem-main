import type { BioRecord, StockLossRecord, OperationLog, PurchaseBatch, StockItem } from "../store";

export type BatchReceivingSource = {
  boxId: string; itemId: string; lineId: string; boxNo: string;
  productId: string; productName: string; size: string; origin: string;
  orderedQuantity: number; stockedQuantity: number; lostQuantity: number; pendingQuantity: number;
};
export type BatchReceiptEntry = { boxId: string; itemId: string; stockedQuantity: number; lostQuantity: number; subTankId?: string; productName?: string; boxNo?: string; lineId?: string };
export type BatchReceipt = { id: string; date: string; operator?: string; createdBy?: string; createdAt?: string; entries: BatchReceiptEntry[]; proofPhotos?: string[]; reason?: string; notes?: string; status?: string };
export type BatchReceivingSnapshot = {
  ok: true; batch: PurchaseBatch; revision: number; costingRevision: number;
  sources: BatchReceivingSource[];
  summary: { orderedQuantity: number; stockedQuantity: number; lostQuantity: number; pendingQuantity: number };
  receipts: BatchReceipt[]; blockedReason: string; availabilityKnown?: boolean;
  permissions: { canStock: boolean; canLoss: boolean };
};
export type BatchReceivingResult = Partial<Omit<BatchReceivingSnapshot, "ok">> & { ok: boolean; error?: string; code?: string; pendingApproval?: boolean; message?: string; stockItems?: StockItem[]; stock?: StockItem[]; lossRecords?: StockLossRecord[]; bioRecords?: BioRecord[]; operationLog?: OperationLog };
export type ReceiptDraftEntry = { stocked: string; lost: string; groupId: string; subTankId: string };
export function receiptSourceKey(row: Pick<BatchReceivingSource, "boxId" | "itemId">) { return JSON.stringify([row.boxId, row.itemId]); }
export function receiptInteger(value: string): number | null {
  if (!value.trim()) return 0;
  if (!/^\d+$/.test(value.trim())) return null;
  const number = Number(value); return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
export function receiptEntries(sources: BatchReceivingSource[], drafts: Record<string, ReceiptDraftEntry>): BatchReceiptEntry[] {
  return sources.flatMap(row => {
    const draft = drafts[receiptSourceKey(row)]; if (!draft) return [];
    const stockedQuantity = receiptInteger(draft.stocked), lostQuantity = receiptInteger(draft.lost);
    return stockedQuantity === null || lostQuantity === null || stockedQuantity + lostQuantity === 0 ? [] : [{ boxId: row.boxId, itemId: row.itemId, stockedQuantity, lostQuantity, ...(stockedQuantity ? { subTankId: draft.subTankId } : {}) }];
  });
}
export function validateReceiptDraft(sources: BatchReceivingSource[], drafts: Record<string, ReceiptDraftEntry>, photos: string[], permissions: { canStock: boolean; canLoss: boolean }): string {
  let quantity = 0, lost = 0, entryCount = 0;
  for (const row of sources) {
    const draft = drafts[receiptSourceKey(row)]; if (!draft) continue;
    const liveCount = receiptInteger(draft.stocked), lostCount = receiptInteger(draft.lost);
    if (liveCount === null || lostCount === null) return `${row.productName}：请填写零或正整数数量。`;
    if (liveCount + lostCount > row.pendingQuantity) return `${row.productName}（箱 ${row.boxNo}）最多还能处理 ${row.pendingQuantity} 条，请核对数量。`;
    if (liveCount && !permissions.canStock) return "当前账号没有入库权限。";
    if (lostCount && !permissions.canLoss) return "当前账号没有到货报损权限。";
    if (liveCount && !draft.subTankId) return `${row.productName}：请选择接收入缸的位置。`;
    if (liveCount + lostCount > 0) entryCount++;
    quantity += liveCount + lostCount; lost += lostCount;
  }
  if (!quantity) return "请至少填写一条入缸或到货死亡的鱼。";
  if (entryCount > 100) return "单次最多处理 100 项装箱明细，请分次接收。";
  if (quantity > 500) return "单次最多处理 500 条，请分次接收。";
  if (lost && !photos.length) return "登记到货死亡需要先上传照片，原因可以之后补充。";
  return "";
}
