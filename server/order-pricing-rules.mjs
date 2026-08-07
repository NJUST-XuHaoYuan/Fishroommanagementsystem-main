function nonNegativeMoney(value) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Number(amount.toFixed(2));
}

export function sickMinimumReturnExemption(stockItem = {}, existingOrderItem = {}) {
  return existingOrderItem?.minReturnPriceExempt === true || stockItem?.status === "sick";
}

export function orderItemMinimumReturnFloor(item = {}) {
  return item?.minReturnPriceExempt === true ? 0 : nonNegativeMoney(item?.minReturnPrice);
}

export function orderMinimumReturnFloorTotal(items = []) {
  return Number((Array.isArray(items) ? items : []).reduce(
    (sum, item) => sum + orderItemMinimumReturnFloor(item),
    0
  ).toFixed(2));
}
