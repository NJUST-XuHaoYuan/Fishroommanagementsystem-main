import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./stock-pricing-fixture.mjs";
export { PRICING_TEST_PASSWORD };
export { evidencePng, EVIDENCE_TEST_KEYRING } from "./new-customer-evidence-fixture.mjs";

export function paymentProofFixture() {
  const fixture = structuredClone(stockPricingFixture);
  const state = fixture.state;
  const owner = state.personnel.find(person => person.id === "pricing-editor");
  owner.permissions = { orders: { create: true, update: true, delete: false } };
  state.personnel.push({ ...structuredClone(owner), id: "finance-reviewer", username: "finance-reviewer", name: "财务核验测试员", accessRole: "finance",
    permissions: { finance: { create: true, update: true, delete: true } } });
  state.personnel.push({ ...structuredClone(owner), id: "other-owner", username: "other-owner", name: "其他订单负责人" });
  state.customers = [{ id: "proof-customer", name: "付款凭证合成客户", wechat: "synthetic-proof" }];
  const stock = { ...state.stock[0], id: "proof-fish", code: "PAY-PROOF-001", sold: true };
  state.stock = [stock];
  state.orders = [{ id: "proof-order", orderNo: "SO-PROOF-TEST", siteId: "nanjing", source: "私域线上",
    createdAt: "2026-10-01T09:00:00+08:00", date: "2026-10-01", plannedShipDate: "2026-11-19",
    customerId: "proof-customer", contactPersonnelId: owner.id, contactPerson: owner.name,
    paymentMethodId: "pm-wechat", paymentMethodName: "微信", paymentChannel: "wechat", paymentAccount: "合成微信收款账户",
    shippingFeeMode: "collect", shippingFee: 0, packagingFee: 0, discount: 0, status: "pending", notes: "隔离测试，不涉及真实客户或收款",
    items: [{ stockItemId: stock.id, productId: stock.productId, fishCode: stock.code, price: 1000, minReturnPrice: 0 }], payments: [],
  }];
  state.shipments = []; state.bioRecords = []; state.lossRecords = []; state.notifications = []; state.operationLogs = [];
  state.paymentEvidenceAttachments = [];
  state.systemSettings = { paymentMethods: [
    { id: "pm-wechat", name: "微信", channel: "wechat", account: "合成微信收款账户", enabled: true },
    { id: "pm-cash", name: "现金", channel: "cash", account: "合成现金账户", enabled: true },
    { id: "pm-douyin", name: "抖音", channel: "douyin", account: "抖店账户", enabled: true },
  ] };
  return fixture;
}
