import test from "node:test";
import assert from "node:assert/strict";
import {
  ORDER_SEARCH_NO_MATCH,
  normalizeOrderFishCode,
  orderSearchRank,
  rankOrderSearchRows,
} from "./orderSearch.ts";

test("finds an order by its displayed fish code", () => {
  const order = {
    orderNo: "SO-2026-1167",
    fishSearchCodes: ["299"],
    searchText: "客户备注",
  };

  assert.equal(orderSearchRank(order, "299"), 0);
  assert.equal(orderSearchRank(order, "不存在"), ORDER_SEARCH_NO_MATCH);
});

test("ranks a fish-code match ahead of customer phone and notes", () => {
  const phoneMatch = {
    id: "phone",
    orderNo: "SO-2",
    fishSearchCodes: ["901"],
    searchText: "客户手机号 15800001111 备注 158",
  };
  const fishMatch = {
    id: "fish",
    orderNo: "SO-1",
    fishSearchCodes: ["158"],
    searchText: "其他客户",
  };

  assert.deepEqual(
    rankOrderSearchRows([phoneMatch, fishMatch], "158").map((order) => order.id),
    ["fish", "phone"]
  );
});

test("supports partial and normalized fish codes", () => {
  assert.equal(normalizeOrderFishCode(" MFISH-Ab_C-12 "), "mfishabc12");
  assert.equal(orderSearchRank({
    fishSearchCodes: ["A-158"],
    searchText: "",
  }, "A15"), 1);
});

test("keeps the original order for matches with the same rank", () => {
  const rows = [
    { id: "newer", orderNo: "SO-2", searchText: "蓝吊" },
    { id: "older", orderNo: "SO-1", searchText: "蓝吊" },
  ];

  assert.deepEqual(
    rankOrderSearchRows(rows, "蓝吊").map((order) => order.id),
    ["newer", "older"]
  );
});
