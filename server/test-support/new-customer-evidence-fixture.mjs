import { deflateSync } from "node:zlib";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./stock-pricing-fixture.mjs";
export { PRICING_TEST_PASSWORD };
export const EVIDENCE_TEST_KEYRING = JSON.stringify({ activeKid: "evidence-test", keys: { "evidence-test": Buffer.alloc(32, 7).toString("base64") } });
export function newCustomerEvidenceFixture() {
  const fixture = structuredClone(stockPricingFixture);
  fixture.state.customers = [{ id: "new-customer", name: "凭证测试客户", wechat: "evidence-test" }];
  const order = fixture.state.orders.find((item) => item.id === "ORDER-PENDING");
  Object.assign(order, { createdAt: "2026-10-01T09:00:00+08:00", customerId: "new-customer", contactPersonnelId: "pricing-editor", contactPerson: "价格测试editor",
    source: "私域线上", paymentChannel: "cash", paymentAccount: "synthetic", plannedShipDate: "2026-10-02" });
  fixture.state.orders = [order]; fixture.state.shipments = []; fixture.state.newCustomerEvidenceAttachments = [];
  return fixture;
}
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind, content) {
  const typeAndData = Buffer.concat([Buffer.from(kind), content]);
  const size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(content.length); crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([size, typeAndData, crc]);
}
// Deterministic transparent synthetic fixture, not customer data or a decoder mock.
export function evidencePng({ width = 8, height = 8 } = {}) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x++) { row[1 + x * 4] = 255; row[4 + x * 4] = x % 2 ? 255 : 0; }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
