export type LossPricingSnapshot = {
  basePrice: unknown;
  priceMode: unknown;
  priceOverridden: unknown;
};

export type LossPricingUpdate = {
  id: string;
  basePrice: number;
  priceMode: "manual";
  priceOverridden: true;
};

export function parseLossPriceInput(input: string): number {
  const value = input.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error("请输入大于 0、最多两位小数的售价");
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("请输入有效的正数售价");
  const amount = Number(cents) / 100;
  const [storedWhole, storedFraction = ""] = String(amount).split(".");
  if (BigInt(storedWhole) * 100n + BigInt(storedFraction.padEnd(2, "0")) !== cents) {
    throw new Error("售价过大，无法精确保留到分");
  }
  return amount;
}

type LossPoint = {
  estimatedValue: number;
  lossDetails?: Array<{ stockItemId: string; estimatedValue: number; pricingSnapshot?: LossPricingSnapshot }>;
};

/** Update the same persisted stock price everywhere without touching quantities or financial amounts. */
export function applyLossPricingUpdate<T extends LossPoint>(point: T, update: LossPricingUpdate): T {
  if (!point.lossDetails?.some((detail) => detail.stockItemId === update.id)) return point;
  const lossDetails = point.lossDetails.map((detail) => detail.stockItemId === update.id ? {
    ...detail,
    estimatedValue: update.basePrice,
    isPriceMissing: false,
    pricingSnapshot: { basePrice: update.basePrice, priceMode: update.priceMode, priceOverridden: update.priceOverridden },
  } : detail);
  return { ...point, lossDetails, estimatedValue: Number(lossDetails.reduce((total, detail) => total + detail.estimatedValue, 0).toFixed(2)) };
}
