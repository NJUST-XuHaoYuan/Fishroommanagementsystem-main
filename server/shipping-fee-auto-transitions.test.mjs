import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeShippingFeeMode } from "./finance-utils.mjs";
import {
  countsAsCompletionShipment,
  shipmentIsResolvedForCompletion,
} from "./shipment-completion-rules.mjs";
import { shipmentsHavePendingActualShippingFee } from "./shipment-rules.mjs";
import { closeEndedOrderOwnerAssignments } from "./order-owner-assignment.mjs";
import { shipmentPaymentGate } from "./shipment-payment-rules.mjs";
import { paymentEvidenceShipmentSnapshot } from "./payment-proof-rules.mjs";

const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source block ${startMarker}`);
  return source.slice(start, end);
}

const validateFeesSource = sourceBetween(
  "function validateOrderShippingFeesRecorded",
  "\nfunction validateOrderCanComplete",
);
const validateCompleteSource = sourceBetween(
  "function validateOrderCanComplete",
  "\nfunction applyAutomaticOrderTransitions",
);
const automaticTransitionsSource = sourceBetween(
  "function applyAutomaticOrderTransitions",
  "\nconst ORDER_STATUS_VALUES",
);

function createAutomaticTransitions(clock) {
  const todayInChina = () => clock.today;
  const nowDatetimeInChina = () => `${clock.today}T04:00:00`;
  const addDaysToDateString = (dateString, days) => {
    const date = new Date(`${dateString}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const datePart = (value) => {
    const date = String(value ?? "").trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
  };
  const isDateOnOrBefore = (value, threshold) => {
    const date = datePart(value);
    return Boolean(date) && date <= threshold;
  };
  const calcAmountDueForOrder = () => 100;
  const shipmentPaymentGateForOrder = (order) => shipmentPaymentGate(order, calcAmountDueForOrder(order));
  const currentStationNotifications = (state) => Array.isArray(state.notifications) ? state.notifications : [];
  const ensureOrderCreditSaleNotifications = (state) => ({
    notifications: currentStationNotifications(state),
    changed: false,
  });
  const orderItemKeepsInventory = () => true;
  const uid = () => "log-auto-transition";
  const pushOperationLog = (logs, entry) => [...(Array.isArray(logs) ? logs : []), entry];

  return new Function(
    "todayInChina",
    "nowDatetimeInChina",
    "addDaysToDateString",
    "datePart",
    "isDateOnOrBefore",
    "shipmentPaymentGateForOrder",
    "currentStationNotifications",
    "ensureOrderCreditSaleNotifications",
    "orderItemKeepsInventory",
    "uid",
    "pushOperationLog",
    "normalizeShippingFeeMode",
    "shipmentsHavePendingActualShippingFee",
    "countsAsCompletionShipment",
    "shipmentIsResolvedForCompletion",
    "closeEndedOrderOwnerAssignments",
    "paymentEvidenceShipmentSnapshot",
    "calcAmountDueForOrder",
    `"use strict";\n${validateFeesSource}\n${validateCompleteSource}\n${automaticTransitionsSource}\nreturn applyAutomaticOrderTransitions;`,
  )(
    todayInChina,
    nowDatetimeInChina,
    addDaysToDateString,
    datePart,
    isDateOnOrBefore,
    shipmentPaymentGateForOrder,
    currentStationNotifications,
    ensureOrderCreditSaleNotifications,
    orderItemKeepsInventory,
    uid,
    pushOperationLog,
    normalizeShippingFeeMode,
    shipmentsHavePendingActualShippingFee,
    countsAsCompletionShipment,
    shipmentIsResolvedForCompletion,
    closeEndedOrderOwnerAssignments,
    paymentEvidenceShipmentSnapshot,
    calcAmountDueForOrder,
  );
}

function stateWithShipment(mode, {
  shipmentStatus = "shipped",
  actualShippingFee = 0,
  paymentGateOpen = true,
} = {}) {
  return {
    orders: [{
      id: "order-1",
      orderNo: "SO-2026-001",
      status: "shipped",
      source: "私域线上",
      shippingFeeMode: mode,
      paymentGateOpen,
      items: [{ stockItemId: "stock-1" }],
    }],
    shipments: [{
      id: "shipment-1",
      orderId: "order-1",
      status: shipmentStatus,
      shipMethod: "express",
      shippedAt: "2026-10-18T10:00:00",
      outboundDate: "2026-10-17",
      actualShippingFee,
      itemStockIds: ["stock-1"],
    }],
    notifications: [],
    operationLogs: [],
  };
}

test("pending prepaid and free fees allow auto-delivery but defer auto-completion until recorded", () => {
  const clock = { today: "2026-10-23" };
  const applyAutomaticOrderTransitions = createAutomaticTransitions(clock);

  for (const mode of ["prepaid", "free"]) {
    const delivered = applyAutomaticOrderTransitions(stateWithShipment(mode));
    assert.equal(delivered.summary.autoDeliveredCount, 1);
    assert.equal(delivered.state.shipments[0].status, "delivered");
    assert.equal(delivered.state.orders[0].status, "shipped");

    clock.today = "2026-10-27";
    const stillPending = applyAutomaticOrderTransitions(delivered.state);
    assert.equal(stillPending.summary.autoCompletedCount, 0);
    assert.equal(stillPending.state.orders[0].status, "shipped");

    const feeRecordedState = {
      ...stillPending.state,
      shipments: stillPending.state.shipments.map((shipment) => ({
        ...shipment,
        actualShippingFee: 18.5,
      })),
    };
    const completed = applyAutomaticOrderTransitions(feeRecordedState);
    assert.equal(completed.summary.autoCompletedCount, 1);
    assert.equal(completed.state.orders[0].status, "completed");

    clock.today = "2026-10-23";
  }
});

test("automatic shipment records uncovered value as credit and does not require retired approval", () => {
  const clock = { today: "2026-10-23" };
  const applyAutomaticOrderTransitions = createAutomaticTransitions(clock);
  const outboundState = stateWithShipment("prepaid", {
    shipmentStatus: "outbound",
    actualShippingFee: 20,
    paymentGateOpen: false,
  });
  const advancedShipment = applyAutomaticOrderTransitions(outboundState);
  assert.equal(advancedShipment.summary.paymentBlockedCount, 0);
  assert.equal(advancedShipment.summary.autoShippedCount, 1);
  assert.equal(advancedShipment.state.shipments[0].status, "shipped");
  assert.equal(advancedShipment.state.shipments[0].paymentEvidenceSnapshot.creditAmount, 100);

  clock.today = "2026-10-27";
  const deliveredState = stateWithShipment("prepaid", {
    shipmentStatus: "delivered",
    actualShippingFee: 20,
    paymentGateOpen: false,
  });
  deliveredState.shipments[0].deliveredAt = "2026-10-20T10:00:00";
  const creditCompletion = applyAutomaticOrderTransitions(deliveredState);
  assert.equal(creditCompletion.summary.autoCompletedCount, 1);
  assert.equal(creditCompletion.state.orders[0].status, "completed");
});
