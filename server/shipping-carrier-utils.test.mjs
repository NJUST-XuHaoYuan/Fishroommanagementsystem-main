import assert from "node:assert/strict";
import test from "node:test";
import {
  configuredShippingCarriers,
  normalizeShippingCarrierSettings,
  resolveShippingCarrier,
  validateShippingCarrierSettings,
} from "./shipping-carrier-utils.mjs";

test("shipping carriers default to the initial configured choices", () => {
  assert.deepEqual(configuredShippingCarriers({}).map((carrier) => carrier.name), ["高铁", "顺丰", "京东"]);
});

test("shipping carrier settings normalize names and enabled states", () => {
  assert.deepEqual(normalizeShippingCarrierSettings({
    shippingCarriers: [
      { id: " custom ", name: " 德邦 ", enabled: true },
      { id: "disabled", name: "圆通", enabled: false },
    ],
  }), [
    { id: "custom", name: "德邦", enabled: true },
    { id: "disabled", name: "圆通", enabled: false },
  ]);
  assert.deepEqual(configuredShippingCarriers({
    shippingCarriers: [{ id: "disabled", name: "圆通", enabled: false }],
  }), []);
});

test("shipping carrier settings require unique names and an enabled choice", () => {
  assert.throws(() => validateShippingCarrierSettings([
    { id: "a", name: "顺丰", enabled: true },
    { id: "b", name: "顺丰", enabled: false },
  ]), /名称不能重复/);
  assert.throws(() => validateShippingCarrierSettings([
    { id: "a", name: "顺丰", enabled: false },
  ]), /至少启用一家/);
});

test("new shipments use enabled carriers while legacy values remain editable", () => {
  const settings = {
    shippingCarriers: [
      { id: "sf", name: "顺丰", enabled: true },
      { id: "jd", name: "京东", enabled: false },
    ],
  };
  assert.equal(resolveShippingCarrier(settings, "顺丰"), "顺丰");
  assert.throws(() => resolveShippingCarrier(settings, "京东"), /未启用或已删除/);
  assert.equal(resolveShippingCarrier(settings, "顺丰速运", "顺丰速运"), "顺丰速运");
});
