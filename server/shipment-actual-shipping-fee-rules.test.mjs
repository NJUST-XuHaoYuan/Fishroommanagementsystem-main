import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ACTUAL_SHIPPING_FEE,
  ShipmentActualShippingFeeError,
  actualShippingFeeValuesDiffer,
  normalizeOutboundActualShippingFee,
  parseActualShippingFeeRequest,
  planActualShippingFeeUpdate,
  updateLockedAppState,
} from "./shipment-actual-shipping-fee-rules.mjs";

function stateFixture(overrides = {}) {
  return {
    orders: [{
      id: "order-1",
      orderNo: "SO-001",
      siteId: "nanjing",
      status: "shipped",
      shippingFeeMode: "prepaid",
    }],
    shipments: [
      {
        id: "shipment-1",
        orderId: "order-1",
        siteId: "nanjing",
        status: "shipped",
        shipMethod: "express",
        carrier: "顺丰",
        actualShippingFee: 0,
      },
      {
        id: "shipment-2",
        orderId: "order-1",
        siteId: "nanjing",
        status: "shipped",
        shipMethod: "express",
        carrier: "顺丰",
        actualShippingFee: 20,
      },
    ],
    operationLogs: [],
    ...overrides,
  };
}

function requestFixture(overrides = {}) {
  return {
    shipmentId: "shipment-1",
    actualShippingFee: 18.5,
    expectedActualShippingFee: 0,
    ...overrides,
  };
}

function plan(state = stateFixture(), request = requestFixture(), overrides = {}) {
  return planActualShippingFeeUpdate({
    state,
    request,
    hasOrderUpdatePermission: true,
    visibleSiteIds: ["nanjing"],
    ...overrides,
  });
}

function assertRuleError(fn, { statusCode, code, message }) {
  assert.throws(fn, (error) => {
    assert.equal(error instanceof ShipmentActualShippingFeeError, true);
    if (statusCode !== undefined) assert.equal(error.statusCode, statusCode);
    if (code !== undefined) assert.equal(error.code, code);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
}

test("plans a two-decimal update for exactly one visible prepaid express shipment", () => {
  const state = stateFixture();
  const result = plan(state, requestFixture({ actualShippingFee: 18.5 }));

  assert.equal(result.updatedShipment.actualShippingFee, 18.5);
  assert.equal(result.shipments[0], result.updatedShipment);
  assert.equal(result.shipments[1], state.shipments[1]);
  assert.equal(result.shipments.filter((item) => item === result.updatedShipment).length, 1);
  assert.equal(state.shipments[0].actualShippingFee, 0);
  assert.equal(result.order, state.orders[0]);
});

test("fails closed when a shipment id is duplicated across sites", () => {
  const state = stateFixture();
  state.orders.push({
    ...state.orders[0],
    id: "order-jiangyin",
    orderNo: "SO-JY-001",
    siteId: "jiangyin",
  });
  state.shipments.push({
    ...state.shipments[0],
    orderId: "order-jiangyin",
    siteId: "jiangyin",
    actualShippingFee: 99,
  });

  assertRuleError(() => plan(state), {
    statusCode: 409,
    code: "SHIPMENT_ID_NOT_UNIQUE",
    message: /发货单 ID 不唯一/,
  });
  assert.equal(state.shipments[0].actualShippingFee, 0);
  assert.equal(state.shipments[2].actualShippingFee, 99);
});

test("fails closed when the related order id is duplicated across sites", () => {
  const state = stateFixture();
  state.orders.push({
    ...state.orders[0],
    orderNo: "SO-JY-001",
    siteId: "jiangyin",
  });

  assertRuleError(() => plan(state), {
    statusCode: 409,
    code: "ORDER_ID_NOT_UNIQUE",
    message: /关联订单 ID 不唯一/,
  });
  assert.equal(state.shipments[0].actualShippingFee, 0);
});

test("request accepts only the three concurrency-safe fields", () => {
  assert.deepEqual(parseActualShippingFeeRequest(requestFixture()), requestFixture());
  assertRuleError(
    () => parseActualShippingFeeRequest(requestFixture({ operator: "admin" })),
    { message: /不支持的请求字段：operator/ }
  );
  const missingExpected = requestFixture();
  delete missingExpected.expectedActualShippingFee;
  assertRuleError(
    () => parseActualShippingFeeRequest(missingExpected),
    { statusCode: 409, code: "ACTUAL_SHIPPING_FEE_REVISION_REQUIRED" }
  );
});

test("requires orders.update permission before changing a shipment", () => {
  assertRuleError(
    () => plan(stateFixture(), requestFixture(), { hasOrderUpdatePermission: false }),
    { statusCode: 403, code: "ORDER_UPDATE_FORBIDDEN", message: /订单模块/ }
  );
});

test("requires visibility of the locked order site", () => {
  assertRuleError(
    () => plan(stateFixture(), requestFixture(), { visibleSiteIds: ["jiangyin"] }),
    { statusCode: 403, code: "ORDER_SITE_FORBIDDEN", message: /无权操作该订单场地/ }
  );
});

test("rejects missing, final, pickup, collect and non-active records", () => {
  assertRuleError(
    () => plan(stateFixture(), requestFixture({ shipmentId: "missing" })),
    { statusCode: 404, code: "SHIPMENT_NOT_FOUND" }
  );

  for (const status of ["completed", "cancelled"]) {
    const state = stateFixture();
    state.orders[0] = { ...state.orders[0], status };
    assertRuleError(() => plan(state), { statusCode: 409, code: "ORDER_NOT_EDITABLE" });
  }

  const pickupState = stateFixture();
  pickupState.shipments[0] = { ...pickupState.shipments[0], shipMethod: "pickup" };
  assertRuleError(() => plan(pickupState), { message: /仅快递/ });

  const collectState = stateFixture();
  collectState.orders[0] = { ...collectState.orders[0], shippingFeeMode: "collect" };
  assertRuleError(() => plan(collectState), { message: /仅寄付或包邮/ });

  for (const status of ["preparing", "unknown", ""]) {
    const state = stateFixture();
    state.shipments[0] = { ...state.shipments[0], status };
    assertRuleError(
      () => plan(state),
      { statusCode: 409, code: "SHIPMENT_NOT_EDITABLE" }
    );
  }
});

test("uses the shared mode normalization and supports prepaid and free corrections", () => {
  assert.equal(plan(stateFixture()).updatedShipment.actualShippingFee, 18.5);

  const freeState = stateFixture();
  freeState.orders[0] = { ...freeState.orders[0], shippingFeeMode: "free" };
  assert.equal(plan(freeState).updatedShipment.actualShippingFee, 18.5);

  const legacyDefaultState = stateFixture();
  legacyDefaultState.orders[0] = { ...legacyDefaultState.orders[0], shippingFeeMode: undefined };
  assert.equal(plan(legacyDefaultState).updatedShipment.actualShippingFee, 18.5);

  const offlineState = stateFixture();
  offlineState.orders[0] = { ...offlineState.orders[0], source: "线下", shippingFeeMode: "prepaid" };
  assertRuleError(() => plan(offlineState), { message: /仅寄付或包邮/ });
});

test("supports correcting active and resolved shipment history but not preparing rows", () => {
  for (const status of ["outbound", "shipped", "delivered", "damaged"]) {
    const state = stateFixture();
    state.shipments[0] = { ...state.shipments[0], status };
    assert.equal(plan(state).updatedShipment.actualShippingFee, 18.5);
  }
});

test("requires finite positive money within the limit and at most two decimals", () => {
  for (const actualShippingFee of ["18.5", Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 0.001, MAX_ACTUAL_SHIPPING_FEE + 0.01]) {
    assertRuleError(() => parseActualShippingFeeRequest(requestFixture({ actualShippingFee })), {});
  }
  assert.equal(
    parseActualShippingFeeRequest(requestFixture({ actualShippingFee: MAX_ACTUAL_SHIPPING_FEE })).actualShippingFee,
    MAX_ACTUAL_SHIPPING_FEE
  );
  assertRuleError(
    () => parseActualShippingFeeRequest(requestFixture({ expectedActualShippingFee: -0.01 })),
    {}
  );
});

test("initial outbound enforces the shared cap and precision without changing prepaid/free rules", () => {
  assert.equal(normalizeOutboundActualShippingFee(0, "prepaid"), 0);
  assert.equal(normalizeOutboundActualShippingFee(12.34, "free"), 12.34);
  assert.equal(normalizeOutboundActualShippingFee(MAX_ACTUAL_SHIPPING_FEE, "prepaid"), MAX_ACTUAL_SHIPPING_FEE);

  for (const [value, mode] of [
    [0, "free"],
    [12.345, "prepaid"],
    [MAX_ACTUAL_SHIPPING_FEE + 0.01, "free"],
  ]) {
    assertRuleError(() => normalizeOutboundActualShippingFee(value, mode), {});
  }
});

test("repairs legacy over-limit and sub-cent values using a cent-rounded concurrency token", () => {
  const state = stateFixture();
  state.shipments[0] = {
    ...state.shipments[0],
    actualShippingFee: MAX_ACTUAL_SHIPPING_FEE + 0.125,
  };

  assert.equal(
    plan(state, requestFixture({
      actualShippingFee: 18.5,
      expectedActualShippingFee: MAX_ACTUAL_SHIPPING_FEE + 0.13,
    })).updatedShipment.actualShippingFee,
    18.5
  );
  assertRuleError(
    () => plan(state, requestFixture({
      actualShippingFee: 18.5,
      expectedActualShippingFee: MAX_ACTUAL_SHIPPING_FEE + 0.12,
    })),
    { statusCode: 409, code: "ACTUAL_SHIPPING_FEE_CONFLICT" }
  );
});

test("uses the expected current fee to reject a stale writer", () => {
  const state = stateFixture();
  state.shipments[0] = { ...state.shipments[0], actualShippingFee: 12.34 };
  assertRuleError(
    () => plan(state, requestFixture({ expectedActualShippingFee: 0 })),
    {
      statusCode: 409,
      code: "ACTUAL_SHIPPING_FEE_CONFLICT",
      message: /运费已被他人更新，请刷新后重试/,
    }
  );
  assert.equal(
    plan(state, requestFixture({ expectedActualShippingFee: 12.34 })).updatedShipment.actualShippingFee,
    18.5
  );
});

test("detects monetary changes so the generic patch route cannot bypass concurrency", () => {
  assert.equal(actualShippingFeeValuesDiffer(undefined, 0), false);
  assert.equal(actualShippingFeeValuesDiffer("12.30", 12.3), false);
  assert.equal(actualShippingFeeValuesDiffer(12.3, 12.31), true);
  assert.equal(actualShippingFeeValuesDiffer("invalid", 12.31), true);
});

test("locked update selects FOR UPDATE, persists once and commits", async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (String(sql).startsWith("SELECT data")) return { rows: [{ data: stateFixture() }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const result = await updateLockedAppState(client, "main", (state) => {
    const planned = plan(state);
    return {
      nextState: { ...state, shipments: planned.shipments },
      shipment: planned.updatedShipment,
    };
  });

  assert.equal(result.shipment.actualShippingFee, 18.5);
  assert.deepEqual(queries.map(({ sql }) => String(sql).split(/\s+/)[0]), ["BEGIN", "SELECT", "UPDATE", "COMMIT"]);
  assert.match(queries[1].sql, /FOR UPDATE/);
  assert.equal(JSON.parse(queries[2].params[1]).shipments[0].actualShippingFee, 18.5);
});

test("locked update rolls back and never writes when validation or persistence fails", async () => {
  for (const failAt of ["planner", "UPDATE"]) {
    const queries = [];
    const client = {
      async query(sql) {
        const keyword = String(sql).split(/\s+/)[0];
        queries.push(keyword);
        if (keyword === "SELECT") return { rows: [{ data: stateFixture() }] };
        if (keyword === "UPDATE" && failAt === "UPDATE") throw new Error("database write failed");
        return { rows: [], rowCount: 1 };
      },
    };
    await assert.rejects(
      () => updateLockedAppState(client, "main", (state) => {
        if (failAt === "planner") throw new Error("validation failed");
        const planned = plan(state);
        return { nextState: { ...state, shipments: planned.shipments } };
      }),
      new RegExp(failAt === "planner" ? "validation failed" : "database write failed")
    );
    assert.equal(queries.at(-1), "ROLLBACK");
    assert.equal(queries.includes("COMMIT"), false);
    if (failAt === "planner") assert.equal(queries.includes("UPDATE"), false);
  }
});
