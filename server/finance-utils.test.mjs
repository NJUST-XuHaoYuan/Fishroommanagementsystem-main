import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateOrderCommission,
  calculateOrderFeeBreakdown,
  normalizeExternalOrderNo,
  parseDouyinSettlementCsv,
} from "./finance-utils.mjs";

const CSV_HEADERS = [
  "结算时间",
  "订单号",
  "结算金额",
  "结算账户",
  "结算单类型",
  "下单时间",
  "商品名称",
  "订单总价",
  "结算前退款金额",
  "用户实付",
  "收入合计",
  "平台服务费",
  "支出合计",
];

test("parses a Douyin settlement CSV and skips the explanation row", () => {
  const csv = [
    CSV_HEADERS.join(","),
    ["字段说明", "", "", "", "", "", "", "", "", "", "", "", ""].join(","),
    [
      "2026-07-29 12:00:00",
      "'6927284698624393165",
      "95",
      "抖店账户",
      "订单结算",
      "2026-07-20 09:00:00",
      "蓝吊",
      "120",
      "10",
      "110",
      "100",
      "-5",
      "-5",
    ].join(","),
  ].join("\n");

  const parsed = parseDouyinSettlementCsv(csv);

  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.records[0].externalOrderNo, "6927284698624393165");
  assert.equal(parsed.records[0].formulaMatches, true);
  assert.deepEqual(parsed.totals, {
    orderTotal: 120,
    incomeTotal: 100,
    refundTotal: 10,
    platformFees: 5,
    settlementAmount: 95,
  });
  assert.match(parsed.fileHash, /^[a-f0-9]{64}$/);
});

test("normalizes spreadsheet-preserved external order numbers", () => {
  assert.equal(normalizeExternalOrderNo("'123456"), "123456");
  assert.equal(normalizeExternalOrderNo('="123456"'), "123456");
  assert.equal(normalizeExternalOrderNo(" 12 34 "), "1234");
});

test("calculates order owner commission with the minimum-return cap", () => {
  const order = {
    items: [
      { price: 600, minReturnPrice: 450 },
      { price: 400, minReturnPrice: 250 },
    ],
    discount: 100,
    status: "completed",
  };

  assert.deepEqual(calculateOrderCommission(order, 1), {
    commissionRate: 1,
    commissionBase: 900,
    minimumReturnTotal: 700,
    commissionCap: 200,
    commissionAmount: 9,
  });
  assert.equal(calculateOrderCommission({ ...order, commissionRate: 50 }, 1).commissionAmount, 200);
  assert.equal(calculateOrderCommission({ ...order, status: "cancelled" }, 1).commissionAmount, 0);
});

test("sick-fish price exemption does not create commission room below the original floor", () => {
  const result = calculateOrderCommission({
    status: "pending",
    discount: 0,
    commissionRate: 1,
    items: [
      { price: 100, minReturnPrice: 180, minReturnPriceExempt: true },
    ],
  });

  assert.equal(result.minimumReturnTotal, 180);
  assert.equal(result.commissionCap, 0);
  assert.equal(result.commissionAmount, 0);
});

test("calculates a complete order fee breakdown with shipping and damage adjustments", () => {
  const order = {
    items: [{ price: 300 }, { price: 180 }],
    discount: 30,
    shippingFee: 25,
    packagingFee: 15,
  };

  assert.deepEqual(calculateOrderFeeBreakdown(order, {
    billableShippingFee: 35,
    damageRefundAdjustment: 80,
  }), {
    itemSubtotal: 480,
    discount: 30,
    goodsNetTotal: 450,
    orderShippingFee: 25,
    billableShippingFee: 35,
    shippingFeeAdjustment: 10,
    packagingFee: 15,
    damageRefundAdjustment: 80,
    calculatedReceivable: 420,
  });
});
