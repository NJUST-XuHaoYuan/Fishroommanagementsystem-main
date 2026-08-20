import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");

function routeBlock(path) {
  const marker = `if (url.pathname === "${path}"`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing route ${path}`);
  const nextRoute = source.indexOf("\n  if (url.pathname === ", start + marker.length);
  return source.slice(start, nextRoute === -1 ? source.length : nextRoute);
}

test("order and shipment mutation routes resolve unique authorized targets after locking state", () => {
  for (const path of [
    "/api/orders/credit-sale/request",
    "/api/orders/credit-sale/confirm",
    "/api/orders/payment-claim",
    "/api/orders/payment",
    "/api/orders/refund",
    "/api/orders/return-item",
    "/api/orders/complete",
    "/api/orders/delete",
    "/api/shipments/outbound",
  ]) {
    const block = routeBlock(path);
    const lockIndex = block.indexOf("SELECT data FROM app_state WHERE id = $1 FOR UPDATE");
    const resolverIndex = block.indexOf("resolveAuthorizedLockedOrderTarget");
    assert.ok(lockIndex >= 0 && resolverIndex > lockIndex, `${path} must authorize the unique order after acquiring the row lock`);
  }

  for (const path of [
    "/api/shipments/confirm",
    "/api/shipments/deliver",
    "/api/shipments/damage",
    "/api/shipments/cancel",
  ]) {
    const block = routeBlock(path);
    const lockIndex = block.indexOf("SELECT data FROM app_state WHERE id = $1 FOR UPDATE");
    const resolverIndex = block.indexOf("resolveAuthorizedLockedShipmentTarget");
    assert.ok(lockIndex >= 0 && resolverIndex > lockIndex, `${path} must authorize the unique shipment relation after acquiring the row lock`);
  }

  assert.match(
    source,
    /function resolveAuthorizedLockedOrderTarget[\s\S]*?requireVisibleSiteForAuth\(req, state, target\.siteId/,
  );
  assert.match(
    source,
    /function resolveAuthorizedLockedShipmentTarget[\s\S]*?requireVisibleSiteForAuth\(req, state, target\.siteId/,
  );
});

test("order and shipment success payloads always build site-filtered collections", () => {
  for (const path of [
    "/api/orders/credit-sale/request",
    "/api/orders/credit-sale/confirm",
    "/api/orders/payment-claim",
    "/api/orders/payment",
    "/api/orders/refund",
    "/api/orders/return-item",
    "/api/orders/complete",
    "/api/orders/delete",
    "/api/shipments/outbound",
    "/api/shipments/confirm",
    "/api/shipments/deliver",
    "/api/shipments/damage",
    "/api/shipments/cancel",
  ]) {
    assert.match(routeBlock(path), /siteVisibilityFilteredState\(/, `${path} must filter success collections by account site scope`);
  }

  assert.doesNotMatch(routeBlock("/api/orders/credit-sale/confirm"), /compactResponse|responseMode/);

  const rawCollectionInSuccessPayload = /sendJson\(req, res, 200,[\s\S]{0,1000}?\b(?:orders: (?:orders|nextOrders|approved\.nextOrders|nextState\.orders)|shipments: (?:shipments|nextShipments)|stock: nextStock)\b/;
  for (const path of [
    "/api/orders/credit-sale/request",
    "/api/orders/credit-sale/confirm",
    "/api/orders/payment-claim",
    "/api/orders/payment",
    "/api/orders/refund",
    "/api/orders/return-item",
    "/api/orders/complete",
    "/api/orders/delete",
    "/api/shipments/outbound",
    "/api/shipments/confirm",
    "/api/shipments/deliver",
    "/api/shipments/damage",
    "/api/shipments/cancel",
  ]) {
    assert.doesNotMatch(routeBlock(path), rawCollectionInSuccessPayload, `${path} must not return raw cross-site collections`);
  }
});

test("staff visibility never bypasses filtering just because every configured site is selected", () => {
  const start = source.indexOf("function siteVisibilityFilteredState");
  const end = source.indexOf("\nfunction inventoryProjectionForResponse", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /account\.accessRole === "admin"/);
  assert.doesNotMatch(block, /visibleSiteIds\.length\s*>=/);
});

test("authorized mutation sites must be explicit and uniquely configured", () => {
  const start = source.indexOf("function requireVisibleSiteForAuth");
  const end = source.indexOf("\n// These helpers must only", start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /String\(siteId \?\? ""\)\.trim\(\)/);
  assert.match(block, /siteMatches\.length === 1/);
  assert.doesNotMatch(block, /normalizeSiteId\(siteId\)/);
});
