import { Product, StockItem } from "../store";

function normalizePrice(value: unknown): number {
  const price = Number(value ?? 0);
  return Number.isFinite(price) ? Number(price.toFixed(2)) : 0;
}

export function stockSalePrice(stock: StockItem, product?: Product): number {
  return normalizePrice(stock.basePrice || product?.defaultPrice || 0);
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
  return stock.priceOverridden === true;
}
