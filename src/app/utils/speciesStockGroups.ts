import type { Product, Species, StockItem, StockStatus, TankGroup } from "../store";

export type SpeciesStockTankRow = {
  tankId: string;
  label: string;
  count: number;
  soldCount: number;
  unsoldCount: number;
};

export type SpeciesStockProductRow = {
  productId: string;
  name: string;
  size: string;
  origin: string;
  count: number;
  soldCount: number;
  unsoldCount: number;
  soldItems: StockItem[];
  /** Compatibility map retained from the original view, keyed by display label. */
  tankCounts: Map<string, number>;
  tankRows: SpeciesStockTankRow[];
};

export type SpeciesStockGroup = {
  speciesId: string;
  speciesName: string;
  scientificName: string;
  commonNames: string[];
  imageUrl: string;
  total: number;
  soldCount: number;
  unsoldCount: number;
  inventoryValue: number;
  statuses: Record<StockStatus, number>;
  products: Map<string, SpeciesStockProductRow>;
  productRows: SpeciesStockProductRow[];
};

type ProductAccumulator = Omit<SpeciesStockProductRow, "tankRows"> & {
  tanks: Map<string, SpeciesStockTankRow>;
};

type GroupAccumulator = Omit<SpeciesStockGroup, "products" | "productRows"> & {
  products: Map<string, ProductAccumulator>;
};

export type BuildSpeciesStockGroupsInput = {
  /** Callers must pass only stock already accepted by isVisibleInStockInventory. */
  stock?: readonly StockItem[];
  products?: readonly Product[];
  species?: readonly Species[];
  tankGroups?: readonly TankGroup[];
  query?: string;
};

const includesTerm = (value: unknown, term: string) =>
  String(value ?? "").toLowerCase().includes(term);

/**
 * Pure projection for the stock species view. Sold is a sales marker only: it
 * never removes an otherwise visible in-tank fish or changes its health count.
 */
export function buildSpeciesStockGroups({
  stock = [],
  products = [],
  species = [],
  tankGroups = [],
  query = "",
}: BuildSpeciesStockGroupsInput = {}): SpeciesStockGroup[] {
  const productById = new Map(products.map((product) => [product.id, product]));
  const speciesById = new Map(species.map((item) => [item.id, item]));
  const tankMetaById = new Map<string, {
    groupName: string;
    subTankName: string;
    location: string;
    label: string;
  }>();
  for (const group of tankGroups) {
    for (const tank of group.subTanks) {
      tankMetaById.set(tank.id, {
        groupName: group.name,
        subTankName: tank.name,
        location: group.location,
        label: `${group.name} / ${tank.name}`,
      });
    }
  }

  const term = query.trim().toLowerCase();
  const matches = (item: StockItem) => {
    if (!term) return true;
    const product = productById.get(item.productId);
    const speciesRecord = product?.speciesId ? speciesById.get(product.speciesId) : undefined;
    const tank = tankMetaById.get(item.subTankId);
    return (
      includesTerm(product?.name, term) ||
      includesTerm(product?.size, term) ||
      includesTerm(product?.origin, term) ||
      includesTerm(speciesRecord?.name, term) ||
      includesTerm(speciesRecord?.scientificName, term) ||
      speciesRecord?.commonNames?.some((name) => includesTerm(name, term)) ||
      includesTerm(item.code, term) ||
      includesTerm(item.notes, term) ||
      includesTerm(tank?.groupName, term) ||
      includesTerm(tank?.subTankName, term) ||
      includesTerm(tank?.location, term)
    );
  };

  const groups = new Map<string, GroupAccumulator>();
  for (const item of stock) {
    if (!matches(item)) continue;
    const product = productById.get(item.productId);
    const speciesId = product?.speciesId ?? item.productId;
    const speciesRecord = speciesById.get(speciesId);
    const group = groups.get(speciesId) ?? {
      speciesId,
      speciesName: speciesRecord?.name ?? product?.name ?? speciesId,
      scientificName: speciesRecord?.scientificName ?? "",
      commonNames: speciesRecord?.commonNames ?? [],
      imageUrl: speciesRecord?.imageUrl || product?.imageUrl || "",
      total: 0,
      soldCount: 0,
      unsoldCount: 0,
      inventoryValue: 0,
      statuses: { healthy: 0, feeding: 0, sick: 0 },
      products: new Map(),
    };

    const sold = Boolean(item.sold);
    group.total += 1;
    group.soldCount += sold ? 1 : 0;
    group.unsoldCount += sold ? 0 : 1;
    const itemValue = Number(item.basePrice || product?.defaultPrice || 0);
    group.inventoryValue += Number.isFinite(itemValue) ? itemValue : 0;
    group.statuses[item.status] += 1;

    const productRow = group.products.get(item.productId) ?? {
      productId: item.productId,
      name: product?.name ?? item.productId,
      size: product?.size ?? "",
      origin: product?.origin ?? "",
      count: 0,
      soldCount: 0,
      unsoldCount: 0,
      soldItems: [],
      tankCounts: new Map<string, number>(),
      tanks: new Map<string, SpeciesStockTankRow>(),
    };
    productRow.count += 1;
    productRow.soldCount += sold ? 1 : 0;
    productRow.unsoldCount += sold ? 0 : 1;
    if (sold) productRow.soldItems.push(item);

    const tankId = item.subTankId;
    const tankLabel = tankMetaById.get(tankId)?.label ?? "未知缸位";
    const tankRow = productRow.tanks.get(tankId) ?? {
      tankId,
      label: tankLabel,
      count: 0,
      soldCount: 0,
      unsoldCount: 0,
    };
    tankRow.count += 1;
    tankRow.soldCount += sold ? 1 : 0;
    tankRow.unsoldCount += sold ? 0 : 1;
    productRow.tanks.set(tankId, tankRow);
    productRow.tankCounts.set(tankLabel, (productRow.tankCounts.get(tankLabel) ?? 0) + 1);
    group.products.set(item.productId, productRow);
    groups.set(speciesId, group);
  }

  return [...groups.values()]
    .map((group) => {
      const products = new Map<string, SpeciesStockProductRow>();
      for (const [productId, row] of group.products) {
        const { tanks, ...base } = row;
        products.set(productId, {
          ...base,
          tankRows: [...tanks.values()].sort((a, b) =>
            b.count - a.count ||
            a.label.localeCompare(b.label, "zh-Hans-CN") ||
            a.tankId.localeCompare(b.tankId, "zh-Hans-CN")
          ),
        });
      }
      return {
        ...group,
        products,
        productRows: [...products.values()].sort((a, b) =>
          b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN")
        ),
      };
    })
    .sort((a, b) =>
      b.total - a.total || a.speciesName.localeCompare(b.speciesName, "zh-Hans-CN")
    );
}
