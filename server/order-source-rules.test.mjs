import assert from "node:assert/strict";
import test from "node:test";
import {
  isPlatformOrderSource,
  isPlatformPaymentChannel,
  orderSourceLabel,
  platformOrderNoForOrder,
  platformOrderNoLabel,
  platformPaymentChannelForOrderSource,
} from "./order-source-rules.mjs";

test("all three marketplace sources share the platform order contract", () => {
  assert.equal(isPlatformOrderSource("平台下单"), true);
  assert.equal(isPlatformOrderSource("闲鱼平台"), true);
  assert.equal(isPlatformOrderSource("微拍堂平台"), true);
  assert.equal(isPlatformOrderSource("私域线上"), false);
  assert.equal(platformPaymentChannelForOrderSource("平台下单"), "douyin");
  assert.equal(platformPaymentChannelForOrderSource("闲鱼平台"), "xianyu");
  assert.equal(platformPaymentChannelForOrderSource("微拍堂平台"), "weipaitang");
  assert.equal(isPlatformPaymentChannel("xianyu"), true);
  assert.equal(isPlatformPaymentChannel("wechat"), false);
});

test("marketplace labels and order-number labels remain source specific", () => {
  assert.equal(orderSourceLabel("闲鱼平台"), "闲鱼");
  assert.equal(orderSourceLabel("微拍堂平台"), "微拍堂");
  assert.equal(platformOrderNoLabel("平台下单"), "抖音订单编号");
  assert.equal(platformOrderNoLabel("闲鱼平台"), "闲鱼订单编号");
  assert.equal(platformOrderNoLabel("微拍堂平台"), "微拍堂订单编号");
});

test("legacy Douyin order numbers remain readable through the generic platform field", () => {
  assert.equal(platformOrderNoForOrder({ source: "平台下单", douyinOrderNo: "DY-1" }), "DY-1");
  assert.equal(platformOrderNoForOrder({ source: "平台下单", platformOrderNo: "DY-2", douyinOrderNo: "DY-1" }), "DY-2");
  assert.equal(platformOrderNoForOrder({ source: "闲鱼平台", platformOrderNo: "XY-1" }), "XY-1");
  assert.equal(platformOrderNoForOrder({ source: "闲鱼平台", douyinOrderNo: "SHOULD-NOT-USE" }), "");
});
