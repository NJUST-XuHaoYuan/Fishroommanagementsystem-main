export type BatchValuationAmount = {
  count: number;
  estimatedSaleValue: number;
  unpricedCount: number;
};

export type BatchStockValuation = {
  unsold: BatchValuationAmount;
  lost: BatchValuationAmount;
  restrictedCount: number;
  invalidStockCount?: number;
  bySpecies: {
    speciesId: string;
    speciesName: string;
    unsold: BatchValuationAmount;
    lost: BatchValuationAmount;
  }[];
};

// A missing price is not a free fish. Keep unpriced quantities visible beside any subtotal.
export function batchValuationDisplay(value?: BatchValuationAmount | null) {
  if (!value) return { amount: "—", quantity: "数量未加载", note: "", partial: false };
  const quantity = `${value.count.toLocaleString("zh-CN")} 条`;
  if (value.count > 0 && value.unpricedCount >= value.count) {
    return { amount: "暂无可估价", quantity, note: `${value.unpricedCount.toLocaleString("zh-CN")} 条缺少售价`, partial: true };
  }
  if (!Number.isFinite(value.estimatedSaleValue) || value.estimatedSaleValue < 0) {
    return { amount: "—", quantity, note: "估价暂不可用", partial: true };
  }
  const amount = `¥${value.estimatedSaleValue.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return {
    amount,
    quantity,
    note: value.unpricedCount > 0 ? `部分合计 · ${value.unpricedCount.toLocaleString("zh-CN")} 条缺少售价` : "",
    partial: value.unpricedCount > 0,
  };
}
