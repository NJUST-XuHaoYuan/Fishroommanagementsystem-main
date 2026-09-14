import type { BioDetailsPatch, Product, StockItem, StockPriceMode } from "../store";

function normalizePrice(value: unknown): number {
  const price = Number(value ?? 0);
  return Number.isFinite(price) ? Number(price.toFixed(2)) : 0;
}

export function stockSalePrice(stock: StockItem, product?: Product): number {
  return normalizePrice(stock.basePrice || product?.defaultPrice || 0);
}

type PriceSource = Pick<StockItem, "basePrice" | "priceMode" | "priceOverridden">;

function positivePriceCents(value: unknown): number | null {
  if (value == null || value === "" || !Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  const cents = Math.round((Number(value) + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

export function stockPriceMode(stock: PriceSource, product?: Pick<Product, "defaultPrice">): StockPriceMode {
  if (stock.priceMode === "product" || stock.priceMode === "manual" || stock.priceMode === "legacy") return stock.priceMode;
  if (stock.priceOverridden === true) return "manual";
  const price = positivePriceCents(stock.basePrice);
  const defaultPrice = positivePriceCents(product?.defaultPrice);
  return price != null && defaultPrice != null && price === defaultPrice ? "product" : "legacy";
}

export function stockPriceModeLabel(mode: StockPriceMode): string {
  return { product: "跟随商品价", manual: "单独定价", legacy: "历史价格待确认" }[mode];
}

/** Old unsaved additions with a different price retain that price as manual; new stock is never legacy. */
export function newStockPriceMode(stock: PriceSource, product?: Pick<Product, "defaultPrice">): "product" | "manual" {
  return stockPriceMode(stock, product) === "product" ? "product" : "manual";
}

/** No pricing fields on an untouched maintenance save: a product price may have changed meanwhile. */
export function buildStockPriceDetailsPatch(
  original: PriceSource,
  draft: { changed: boolean; mode: StockPriceMode; price: number },
): { details: BioDetailsPatch; expectedDetails: BioDetailsPatch } {
  if (!draft.changed) return { details: {}, expectedDetails: {} };
  if (draft.mode === "legacy") throw new Error("请选择跟随商品价或单独定价");
  const cents = positivePriceCents(draft.price);
  if (cents == null) throw new Error("请填写大于 0 的销售默认价");
  return {
    details: { basePrice: cents / 100, priceMode: draft.mode },
    expectedDetails: { basePrice: original.basePrice, ...(original.priceMode !== undefined ? { priceMode: original.priceMode } : {}) },
  };
}

export function buildStockPriceBaselines(
  stockItems: StockItem[],
  products: Product[],
): Map<string, number> {
  const productById = new Map(products.map((product) => [product.id, product]));
  const countsByProduct = new Map<string, Map<string, number>>();

  for (const stock of stockItems) {
    const price = stockSalePrice(stock, productById.get(stock.productId));
    if (!(price > 0)) continue;
    const priceKey = price.toFixed(2);
    const counts = countsByProduct.get(stock.productId) ?? new Map<string, number>();
    counts.set(priceKey, (counts.get(priceKey) ?? 0) + 1);
    countsByProduct.set(stock.productId, counts);
  }

  const baselines = new Map<string, number>();
  for (const [productId, counts] of countsByProduct.entries()) {
    const productDefault = normalizePrice(productById.get(productId)?.defaultPrice);
    let bestPrice = 0;
    let bestCount = -1;

    for (const [priceKey, count] of counts.entries()) {
      const price = Number(priceKey);
      const preferProductDefault = productDefault > 0 && Math.abs(price - productDefault) <= 0.005;
      const currentIsProductDefault = productDefault > 0 && Math.abs(bestPrice - productDefault) <= 0.005;
      if (
        count > bestCount ||
        (count === bestCount && preferProductDefault && !currentIsProductDefault) ||
        (count === bestCount && !preferProductDefault && !currentIsProductDefault && price < bestPrice)
      ) {
        bestPrice = price;
        bestCount = count;
      }
    }

    if (bestPrice > 0) baselines.set(productId, bestPrice);
  }

  return baselines;
}

export function isStockSpecialPrice(
  stock: StockItem,
  _product?: Product,
  _baselines?: Map<string, number>,
): boolean {
  return stock.priceMode === "manual" || (stock.priceMode == null && stock.priceOverridden === true);
}
