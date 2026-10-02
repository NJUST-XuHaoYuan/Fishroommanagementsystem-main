import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server;
let OrderAcquisitionBadge;
let OrderAcquisitionTag;
let NewCustomerApprovalPanel;
let mergeAcquisitionOrderTags;
let mergeNewCustomerApproval;

before(async () => {
  server = await createServer({
    configFile: false,
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, entries: [] },
    esbuild: { jsx: "automatic" },
  });
  ({
    OrderAcquisitionBadge,
    OrderAcquisitionTag,
    mergeAcquisitionOrderTags,
    mergeNewCustomerApproval,
  } = await server.ssrLoadModule("/src/app/components/OrderAcquisitionTag.tsx"));
  ({ NewCustomerApprovalPanel } = await server.ssrLoadModule("/src/app/components/NewCustomerApprovalPanel.tsx"));
});

after(async () => { await server?.close(); });

function detail(overrides = {}) {
  return {
    ok: true,
    orderId: "order-1",
    approval: null,
    canRequest: true,
    canApprove: false,
    customerEvidence: {
      customerId: "customer-1",
      identityKnown: true,
      firstOrderId: "order-1",
      otherOrderCount: 0,
      priorOrders: [],
    },
    currentOrder: {
      id: "order-1",
      orderNo: "SO-2026-001",
      date: "2026-10-02",
      customerId: "customer-1",
      contactPersonnelId: "person-1",
      contactPerson: "销售甲",
    },
    policyEffectiveDate: "2026-10-01",
    ...overrides,
  };
}

function renderPanel(initialDetail) {
  return renderToStaticMarkup(createElement(NewCustomerApprovalPanel, {
    orderId: "order-1",
    initialDetail,
  }));
}

test("badges distinguish pending, approved, rejected and the non-paying legacy marker", () => {
  assert.equal(renderToStaticMarkup(createElement(OrderAcquisitionBadge, {})), "");
  assert.match(renderToStaticMarkup(createElement(OrderAcquisitionBadge, { approvalStatus: "pending" })), /新客首单待审批/);
  assert.match(renderToStaticMarkup(createElement(OrderAcquisitionBadge, { approvalStatus: "approved" })), /新客首单已批准/);
  assert.match(renderToStaticMarkup(createElement(OrderAcquisitionBadge, { approvalStatus: "rejected" })), /新客申请已驳回/);
  const legacy = renderToStaticMarkup(createElement(OrderAcquisitionBadge, { marked: true }));
  assert.match(legacy, /历史获新标记/);
  assert.match(legacy, /不作为新规则提成依据/);
});

test("order panel explains the confirmed commission replacement and renders an authorized request form", () => {
  const markup = renderToStaticMarkup(createElement(OrderAcquisitionTag, {
    order: { id: "order-1", isAcquisitionOrder: true },
    initialDetail: detail(),
  }));
  assert.match(markup, /新客首单提成/);
  assert.match(markup, /负责人个人 0\.2%/);
  assert.match(markup, /0\.3% 进入公共团队池/);
  assert.match(markup, /负责人个人 5%/);
  assert.match(markup, /运费、包装费不计入/);
  assert.match(markup, /2026-10-01 00:00/);
  assert.match(markup, /退款在退款核销月扣回/);
  assert.match(markup, /历史获新.*不等于新客首单已批准/);
  assert.match(markup, /申请新客首单审批/);
  assert.match(markup, /minLength="5"/);
  assert.match(markup, /maxLength="1000"/);
  assert.match(markup, /disabled=""/);
});

test("unknown customer identity requires an explicit administrator confirmation before approval", () => {
  const approval = {
    status: "pending",
    requestId: "request-1",
    requestedAt: "2026-10-02T02:00:00.000Z",
    requestedBy: "sales-a",
    requestedByName: "销售甲",
    reason: "客户由线下首次到店成交",
    version: 3,
  };
  const markup = renderPanel(detail({
    approval,
    canRequest: false,
    canApprove: true,
    customerEvidence: {
      customerId: "",
      identityKnown: false,
      firstOrderId: "",
      otherOrderCount: 0,
      priorOrders: [],
      warning: "当前订单没有客户档案",
    },
  }));
  assert.match(markup, /待管理员审批/);
  assert.match(markup, /当前订单未关联客户档案/);
  assert.match(markup, /我已人工核对客户身份和历史订单/);
  assert.match(markup, /批准并采用 5%/);
  assert.match(markup, /驳回时必填/);
  const disabledButtons = markup.match(/<button[^>]*disabled=""[^>]*>/g) ?? [];
  assert.ok(disabledButtons.length >= 2);
});

test("approved state explains current-month true-up without rewriting prior months", () => {
  const markup = renderPanel(detail({
    canRequest: false,
    approval: {
      status: "approved",
      requestId: "request-1",
      requestedAt: "2026-10-02T02:00:00.000Z",
      requestedBy: "sales-a",
      reason: "首次成交证据完整",
      reviewedAt: "2026-10-02T03:00:00.000Z",
      reviewedBy: "admin",
      reviewedByName: "管理员",
      reviewNote: "已核对客户档案",
      version: 4,
    },
  }));
  assert.match(markup, /已批准为新客首单/);
  assert.match(markup, /未核销不计提/);
  assert.match(markup, /批准当月补计新客提成差额/);
  assert.match(markup, /往月不改写/);
  assert.doesNotMatch(markup, /申请新客首单审批/);
});

test("approval merge is versioned, metadata-only and never reinserts absent orders", () => {
  const current = [{
    id: "order-1",
    status: "completed",
    discount: 50,
    newCustomerApproval: { status: "pending", requestId: "request-1", version: 3 },
  }];
  const incoming = {
    id: "order-1",
    status: "confirmed",
    discount: 0,
    newCustomerApproval: { status: "approved", requestId: "request-1", version: 4 },
  };
  const [updated] = mergeNewCustomerApproval(current, incoming);
  assert.equal(updated.newCustomerApproval.status, "approved");
  assert.equal(updated.status, "completed");
  assert.equal(updated.discount, 50);
  assert.deepEqual(mergeNewCustomerApproval([], incoming), []);
  assert.strictEqual(mergeNewCustomerApproval(current, { ...incoming, id: "missing" })[0], current[0]);

  const stale = {
    ...incoming,
    newCustomerApproval: { status: "rejected", requestId: "request-1", version: 2 },
  };
  assert.strictEqual(mergeNewCustomerApproval(current, stale)[0], current[0]);

  const legacyAndApproval = mergeAcquisitionOrderTags([{
    ...updated,
    isAcquisitionOrder: true,
    acquisitionOrderUpdatedAt: "2026-09-30T00:00:00.000Z",
  }], {
    id: "order-1",
    isAcquisitionOrder: false,
    acquisitionOrderUpdatedAt: "2026-10-02T00:00:00.000Z",
    newCustomerApproval: { status: "approved", requestId: "request-1", version: 4 },
  })[0];
  assert.equal(legacyAndApproval.isAcquisitionOrder, false);
  assert.equal(legacyAndApproval.newCustomerApproval.status, "approved");
});

test("frontend uses dedicated request, review and detail contracts with optimistic-lock versions", async () => {
  const panelSource = await readFile(new URL("./NewCustomerApprovalPanel.tsx", import.meta.url), "utf8");
  assert.match(panelSource, /\/api\/orders\/new-customer\/detail\?orderId=/);
  assert.match(panelSource, /\/api\/orders\/new-customer\/request/);
  assert.match(panelSource, /\/api\/orders\/new-customer\/review/);
  assert.match(panelSource, /expectedApprovalVersion: detail\?\.approval\?\.version \?\? 0/);
  assert.match(panelSource, /confirmCustomerIdentity: true/);
  assert.match(panelSource, /response\.status === 409/);
  assert.match(panelSource, /onOrderUpdated\?\.\(order\)/);
  assert.doesNotMatch(panelSource, /orders\/acquisition-tag/);
});

test("station notifications reuse the panel and refresh after request resolution", async () => {
  const source = await readFile(new URL("./NotificationCenter.tsx", import.meta.url), "utf8");
  assert.match(source, /notification\.type === "new_customer_approval"/);
  assert.match(source, /if \(notification\.type === "new_customer_approval"\) return "新客首单审批"/);
  assert.match(source, /<NewCustomerApprovalPanel/);
  assert.match(source, /notificationId=\{selectedNewCustomerApproval\.id\}/);
  assert.match(source, /approvalRequestId=\{selectedNewCustomerApproval\.approvalRequestId\}/);
  assert.match(source, /await loadNotifications\(true\)/);
});
