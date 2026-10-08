import assert from "node:assert/strict";
import test from "node:test";

import { getInventoryOutStockIds, isVisibleInStockInventory } from "./inventory.ts";
import { buildSpeciesStockGroups } from "./speciesStockGroups.ts";

const species = [
  { id: "sp-a", name: "黄金吊", scientificName: "Acanthurus olivaceus", commonNames: ["橙肩吊"], imageUrl: "species.jpg" },
  { id: "sp-b", name: "蓝吊", scientificName: "Paracanthurus hepatus", commonNames: [], imageUrl: "" },
];
const products = [
  { id: "p-a", speciesId: "sp-a", name: "黄金吊 M", size: "M", origin: "菲律宾", imageUrl: "product.jpg", defaultPrice: 100 },
  { id: "p-b", speciesId: "sp-a", name: "黄金吊 L", size: "L", origin: "印尼", imageUrl: "", defaultPrice: 180 },
  { id: "p-c", speciesId: "sp-b", name: "蓝吊 S", size: "S", origin: "巴厘岛", imageUrl: "", defaultPrice: 90 },
];
const tankGroups = [
  { id: "g-a", name: "同名组", location: "东区", subTanks: [{ id: "tank-a", name: "同名缸" }] },
  { id: "g-b", name: "同名组", location: "西区", subTanks: [{ id: "tank-b", name: "同名缸" }] },
  { id: "g-c", name: "检疫组", location: "北区", subTanks: [{ id: "tank-c", name: "疾病观察缸" }] },
];

function fish(overrides = {}) {
  return {
    id: "fish-a",
    productId: "p-a",
    batchId: "batch-a",
    subTankId: "tank-a",
    status: "healthy",
    sold: false,
    inDate: "2026-10-01",
    basePrice: 100,
    notes: "",
    ...overrides,
  };
}

test("sold stock remains in species, product and per-tank totals independently of health", () => {
  const stock = [
    fish({ id: "fish-unsold", code: "UNSOLD", basePrice: 100 }),
    fish({ id: "fish-sold-sick", code: "SOLD-SICK", status: "sick", sold: true, basePrice: 120 }),
    fish({ id: "fish-sold-feeding", code: "SOLD-FEEDING", status: "feeding", sold: 1, subTankId: "tank-b", basePrice: 80 }),
    fish({ id: "fish-other-product", productId: "p-b", subTankId: "tank-b", basePrice: 0 }),
  ];

  const [group] = buildSpeciesStockGroups({ stock, products, species, tankGroups });
  assert.equal(group.speciesId, "sp-a");
  assert.deepEqual({ total: group.total, sold: group.soldCount, unsold: group.unsoldCount }, { total: 4, sold: 2, unsold: 2 });
  assert.deepEqual(group.statuses, { healthy: 2, feeding: 1, sick: 1 });
  assert.equal(group.inventoryValue, 480);
  assert.deepEqual(group.productRows.map((row) => [row.productId, row.count]), [["p-a", 3], ["p-b", 1]]);

  const row = group.productRows[0];
  assert.deepEqual({ count: row.count, sold: row.soldCount, unsold: row.unsoldCount }, { count: 3, sold: 2, unsold: 1 });
  assert.deepEqual(row.soldItems.map((item) => item.id), ["fish-sold-sick", "fish-sold-feeding"]);
  assert.equal(row.soldItems[0], stock[1]);
  assert.deepEqual(row.tankRows, [
    { tankId: "tank-a", label: "同名组 / 同名缸", count: 2, soldCount: 1, unsoldCount: 1 },
    { tankId: "tank-b", label: "同名组 / 同名缸", count: 1, soldCount: 1, unsoldCount: 0 },
  ]);
  assert.deepEqual([...row.tankCounts.entries()], [["同名组 / 同名缸", 3]]);
});

test("same-named tanks stay separate because aggregation uses subTankId", () => {
  const [group] = buildSpeciesStockGroups({
    stock: [
      fish({ id: "fish-a1", subTankId: "tank-a" }),
      fish({ id: "fish-b1", subTankId: "tank-b", sold: true }),
    ],
    products,
    species,
    tankGroups,
  });
  const tanks = group.productRows[0].tankRows;
  assert.equal(tanks.length, 2);
  assert.equal(new Set(tanks.map((tank) => tank.label)).size, 1);
  assert.deepEqual(tanks.map((tank) => tank.tankId), ["tank-a", "tank-b"]);
});

test("search filters first so every returned count, status, value and tank row has the same scope", () => {
  const stock = [
    fish({ id: "match", code: "SOLD-ONLY-77", sold: true, status: "sick", subTankId: "tank-c", basePrice: 77 }),
    fish({ id: "other", code: "OTHER", sold: false, status: "healthy", basePrice: 100 }),
  ];
  const [group] = buildSpeciesStockGroups({ stock, products, species, tankGroups, query: " sold-only " });
  const [row] = group.productRows;
  assert.deepEqual({ total: group.total, sold: group.soldCount, unsold: group.unsoldCount, value: group.inventoryValue },
    { total: 1, sold: 1, unsold: 0, value: 77 });
  assert.deepEqual(group.statuses, { healthy: 0, feeding: 0, sick: 1 });
  assert.deepEqual({ count: row.count, sold: row.soldCount, unsold: row.unsoldCount }, { count: 1, sold: 1, unsold: 0 });
  assert.deepEqual(row.tankRows, [
    { tankId: "tank-c", label: "检疫组 / 疾病观察缸", count: 1, soldCount: 1, unsoldCount: 0 },
  ]);
  assert.equal(row.soldItems[0], stock[0]);
});

test("the original searchable product, species, fish and tank fields remain supported", () => {
  const stock = [fish({ code: "CODE-88", notes: "胆小观察" })];
  for (const query of [
    "黄金吊 m", "M", "菲律宾", "黄金吊", "acanthurus", "橙肩", "code-88", "胆小", "同名组", "同名缸", "东区",
  ]) {
    assert.equal(buildSpeciesStockGroups({ stock, products, species, tankGroups, query })[0]?.total, 1, query);
  }
  assert.deepEqual(buildSpeciesStockGroups({ stock, products, species, tankGroups, query: "不存在" }), []);
});

test("group, product and tank sorting preserves the existing count-first ordering", () => {
  const stock = [
    fish({ id: "a-1", productId: "p-a", subTankId: "tank-b" }),
    fish({ id: "a-2", productId: "p-a", subTankId: "tank-a" }),
    fish({ id: "a-3", productId: "p-b", subTankId: "tank-c" }),
    fish({ id: "b-1", productId: "p-c", subTankId: "tank-c" }),
  ];
  const groups = buildSpeciesStockGroups({ stock, products, species, tankGroups });
  assert.deepEqual(groups.map((group) => [group.speciesId, group.total]), [["sp-a", 3], ["sp-b", 1]]);
  assert.deepEqual(groups[0].productRows.map((row) => [row.productId, row.count]), [["p-a", 2], ["p-b", 1]]);
  assert.deepEqual(groups[0].productRows[0].tankRows.map((tank) => tank.tankId), ["tank-a", "tank-b"]);
});

test("real inventory filtering excludes lost and fulfilled fish while keeping sold fish in the tank, without mutation", () => {
  const stock = [
    fish({ id: "visible-unsold" }),
    fish({ id: "visible-sold", sold: true }),
    fish({ id: "lost", lost: true }),
    fish({ id: "fulfilled" }),
  ];
  const orders = [{ id: "order-a", status: "completed", items: [{ stockItemId: "fulfilled" }] }];
  const stockBefore = structuredClone(stock);
  const ordersBefore = structuredClone(orders);
  const hidden = getInventoryOutStockIds({ orders });
  const visibleStock = stock.filter((item) => isVisibleInStockInventory(item, hidden));
  const [group] = buildSpeciesStockGroups({ stock: visibleStock, products, species, tankGroups });

  assert.deepEqual(visibleStock.map((item) => item.id), ["visible-unsold", "visible-sold"]);
  assert.deepEqual({ total: group.total, sold: group.soldCount, unsold: group.unsoldCount }, { total: 2, sold: 1, unsold: 1 });
  assert.deepEqual(stock, stockBefore);
  assert.deepEqual(orders, ordersBefore);
});
