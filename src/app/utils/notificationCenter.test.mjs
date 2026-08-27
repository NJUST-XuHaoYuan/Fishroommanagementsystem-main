import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestRequestCoordinator,
  projectStockChangeItems,
  profileApprovalActionReady,
  profileApprovalDetailsReady,
  profileAttachmentChangeKind,
  stockApprovalActionReady,
  stockApprovalDetailsReady,
  stockApprovalReviewState,
  stockApprovalSnapshotIdentityFields,
} from "./notificationCenter.ts";

test("a newer detail request aborts and invalidates every older request", () => {
  const coordinator = createLatestRequestCoordinator();
  const first = coordinator.begin("notification-a");
  const second = coordinator.begin("notification-b");

  assert.equal(first.signal.aborted, true);
  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(second), true);
});

test("closing detail invalidates the active request", () => {
  const coordinator = createLatestRequestCoordinator();
  const request = coordinator.begin("notification-a");

  coordinator.cancel();

  assert.equal(request.signal.aborted, true);
  assert.equal(coordinator.isCurrent(request), false);
});

test("approval is ready only for the selected notification with non-empty loaded details", () => {
  assert.equal(profileApprovalDetailsReady({
    selectedNotificationId: "notification-a",
    loadedNotificationId: "notification-a",
    profileChanges: [{ field: "phone" }],
  }), true);
  assert.equal(profileApprovalDetailsReady({
    selectedNotificationId: "notification-b",
    loadedNotificationId: "notification-a",
    profileChanges: [{ field: "phone" }],
  }), false);
  assert.equal(profileApprovalDetailsReady({
    selectedNotificationId: "notification-a",
    loadedNotificationId: "notification-a",
    profileChanges: [],
  }), false);
  assert.equal(profileApprovalDetailsReady({
    selectedNotificationId: "notification-a",
    loadedNotificationId: "",
    profileChanges: [{ field: "phone" }],
  }), false);
});

test("profile approval action has no administrator-managed employment prerequisite", () => {
  assert.equal(profileApprovalActionReady({
    profileRequestId: "request-a",
    decision: "approve",
    detailsReady: true,
  }), true);
  assert.equal(profileApprovalActionReady({
    profileRequestId: "request-a",
    decision: "reject",
    detailsReady: true,
    note: "请补充证明",
  }), true);
  assert.equal(profileApprovalActionReady({
    profileRequestId: "request-a",
    decision: "reject",
    detailsReady: true,
    note: "",
  }), false);
  assert.equal(profileApprovalActionReady({
    profileRequestId: "request-a",
    decision: "approve",
    detailsReady: false,
  }), false);
});

test("attachment changes distinguish add, replace, remove and unchanged", () => {
  assert.equal(profileAttachmentChangeKind(null, { id: "new" }), "added");
  assert.equal(profileAttachmentChangeKind({ id: "old" }, { id: "new" }), "replaced");
  assert.equal(profileAttachmentChangeKind({ id: "old" }, null), "removed");
  assert.equal(profileAttachmentChangeKind({ id: "same" }, { id: "same" }), "unchanged");
});

test("stock change projection preserves add, remove and exact update differences", () => {
  const projected = projectStockChangeItems([
    {
      operation: "add",
      stockItemId: "stock-add",
      after: { code: "D1-001", productId: "product-a", productName: "蓝吊" },
    },
    {
      operation: "remove",
      stockItemId: "stock-remove",
      before: { code: "D1-002", productId: "product-b", productName: "黄金吊" },
    },
    {
      operation: "update",
      stockItemId: "stock-update",
      before: {
        siteId: "site-a",
        code: "D1-003",
        productId: "product-a",
        productName: "蓝吊旧名称",
        subTankId: "tank-a",
        tankName: "鱼D / D1",
        batchId: "batch-a",
        batchNo: "PO-1",
        inDate: "2026-08-01",
        status: "healthy",
        sold: false,
        lost: false,
        basePrice: 200,
        notes: "",
      },
      after: {
        siteId: "site-b",
        code: "D2-003",
        productId: "product-b",
        productName: "粉蓝吊",
        subTankId: "tank-b",
        tankName: "鱼D / D2",
        batchId: "batch-b",
        batchNo: "PO-2",
        inDate: "2026-08-02",
        status: "sick",
        sold: true,
        lost: true,
        basePrice: 260,
        notes: "重点观察",
      },
    },
  ]);

  assert.deepEqual(projected.map((item) => [item.operation, item.operationLabel, item.identifier]), [
    ["add", "新增", "D1-001"],
    ["remove", "删除", "D1-002"],
    ["update", "修改", "D2-003"],
  ]);
  assert.equal(projected[2].reviewableUpdate, true);
  assert.deepEqual(projected[2].differences.map((item) => item.field), [
    "siteId", "product", "tank", "batch", "inDate", "status", "sold", "lost", "basePrice", "code", "notes",
  ]);
  assert.deepEqual(projected[2].differences.find((item) => item.field === "status"), {
    field: "status",
    label: "状态",
    beforeValue: "正常",
    afterValue: "疾病",
  });
  assert.deepEqual(projected[2].differences.find((item) => item.field === "notes"), {
    field: "notes",
    label: "备注",
    beforeValue: "未填写",
    afterValue: "重点观察",
  });
});

test("add and remove snapshots expose every authoritative relationship id", () => {
  const item = {
    siteId: "site-nanjing",
    productId: "product-blue-tang",
    subTankId: "tank-d1",
    batchId: "batch-202608",
  };
  assert.deepEqual(stockApprovalSnapshotIdentityFields(item), [
    { field: "siteId", label: "所属场地 ID", value: "site-nanjing" },
    { field: "productId", label: "商品 ID", value: "product-blue-tang" },
    { field: "subTankId", label: "缸位 ID", value: "tank-d1" },
    { field: "batchId", label: "批次 ID", value: "batch-202608" },
  ]);
  const [addition, removal] = projectStockChangeItems([
    { operation: "add", stockItemId: "stock-add", after: item },
    { operation: "remove", stockItemId: "stock-remove", before: item },
  ]);
  assert.equal(addition.after.siteId, "site-nanjing");
  assert.equal(removal.before.siteId, "site-nanjing");
});

test("relation display renames do not become changes when authoritative ids match", () => {
  const [projected] = projectStockChangeItems([{
    operation: "update",
    stockItemId: "stock-a",
    before: {
      code: "D1-001",
      productId: "product-a",
      productName: "旧商品显示名",
      subTankId: "tank-a",
      tankName: "旧缸位显示名",
      batchId: "batch-a",
      batchNo: "旧批次显示名",
    },
    after: {
      code: "D1-001",
      productId: "product-a",
      productName: "新商品显示名",
      subTankId: "tank-a",
      tankName: "新缸位显示名",
      batchId: "batch-a",
      batchNo: "新批次显示名",
    },
  }]);

  assert.equal(projected.reviewableUpdate, false);
  assert.deepEqual(projected.differences, []);
});

test("relation changes remain distinguishable when display labels happen to match", () => {
  const [projected] = projectStockChangeItems([{
    operation: "update",
    stockItemId: "stock-a",
    before: { productId: "product-a", productName: "蓝吊" },
    after: { productId: "product-b", productName: "蓝吊" },
  }]);

  const productDifference = projected.differences.find((item) => item.field === "product");
  assert.match(productDifference.beforeValue, /product-a/);
  assert.match(productDifference.afterValue, /product-b/);
  assert.notEqual(productDifference.beforeValue, productDifference.afterValue);
});

test("stock review covers extended mutable fields and uses the proof change flag", () => {
  const [projected] = projectStockChangeItems([{
    operation: "update",
    stockItemId: "stock-a",
    lossProofChanged: true,
    before: {
      code: "generated-fallback",
      rawCode: "",
      priceOverridden: false,
      commissionRate: 0,
      lossDate: "",
      lossReason: "",
      lossProofCount: 1,
      notes: "  保持观察  ",
    },
    after: {
      code: "generated-fallback",
      rawCode: "FISH-001",
      priceOverridden: true,
      commissionRate: 2.5,
      lossDate: "2026-08-23",
      lossReason: "运输损耗",
      lossProofCount: 2,
      notes: "保持观察",
    },
  }]);

  assert.equal(projected.identifier, "FISH-001");
  assert.deepEqual(projected.differences.map((item) => item.field), [
    "priceOverridden", "commissionRate", "lossDate", "lossReason", "lossProof", "code",
  ]);
  const proofDifference = projected.differences.find((item) => item.field === "lossProof");
  assert.match(proofDifference.afterValue, /凭证已替换/);
  assert.equal(projected.differences.some((item) => item.field === "notes"), false);
});

test("proof replacement and blank raw fish codes use only safe review fields", () => {
  const [projected] = projectStockChangeItems([{
    operation: "update",
    stockItemId: "stock-fallback-id",
    lossProofChanged: true,
    before: {
      code: "generated-code-before",
      rawCode: "",
      lossProofCount: 1,
    },
    after: {
      code: "generated-code-after",
      rawCode: "",
      lossProofCount: 1,
    },
  }]);

  assert.equal(projected.identifier, "stock-fallback-id");
  assert.deepEqual(projected.differences.map((item) => item.field), ["lossProof"]);
  assert.match(projected.differences[0].afterValue, /凭证已替换/);
  assert.doesNotMatch(JSON.stringify(projected), /fingerprint/i);
});

test("stock approval detail loading stays bound to the selected notification", () => {
  const stockDetails = {
    type: "stock_change",
    items: [{ operation: "add", stockItemId: "stock-a", after: { code: "D1-001" } }],
  };
  assert.equal(stockApprovalDetailsReady({
    selectedNotificationId: "notice-a",
    loadedNotificationId: "notice-a",
    stockDetails,
  }), true);
  assert.equal(stockApprovalDetailsReady({
    selectedNotificationId: "notice-b",
    loadedNotificationId: "notice-a",
    stockDetails,
  }), false);
  assert.equal(stockApprovalDetailsReady({
    selectedNotificationId: "notice-a",
    loadedNotificationId: "notice-a",
    stockDetails: { type: "stock_change", items: [] },
  }), true);
  assert.equal(stockApprovalDetailsReady({
    selectedNotificationId: "notice-a",
    loadedNotificationId: "notice-a",
    stockDetails: { type: "stock_delete", items: [{ stockItemId: "stock-a" }] },
  }), true);
});

test("stock detail A cannot unlock actions after notification B becomes current", () => {
  const coordinator = createLatestRequestCoordinator();
  const requestA = coordinator.begin("notice-a");
  const requestB = coordinator.begin("notice-b");
  const completeDetails = {
    type: "stock_change",
    schemaVersion: 2,
    reviewComplete: true,
    items: [{ operation: "add", stockItemId: "stock-a", after: { code: "A-1" } }],
  };

  assert.equal(coordinator.isCurrent(requestA), false);
  assert.equal(coordinator.isCurrent(requestB), true);
  assert.equal(stockApprovalDetailsReady({
    selectedNotificationId: "notice-b",
    loadedNotificationId: "notice-a",
    stockDetails: completeDetails,
  }), false);
});

test("schema v2 review state accepts complete details and rejects legacy or failed rebuilds", () => {
  const items = [{ operation: "add", stockItemId: "stock-a", after: { rawCode: "A-1" } }];
  assert.deepEqual(stockApprovalReviewState({
    type: "stock_change",
    schemaVersion: 2,
    reviewComplete: true,
    items,
  }), { reviewComplete: true, reviewError: "" });

  const legacy = stockApprovalReviewState({ type: "stock_change", items });
  assert.equal(legacy.reviewComplete, false);
  assert.match(legacy.reviewError, /旧版/);

  assert.deepEqual(stockApprovalReviewState({
    type: "stock_change",
    schemaVersion: 2,
    reviewComplete: false,
    reviewError: "历史申请缺少并发快照",
    items: [],
  }), {
    reviewComplete: false,
    reviewError: "历史申请缺少并发快照",
  });
});

test("explicitly incomplete stock deletions fail closed while legacy item details remain compatible", () => {
  const items = [{ stockItemId: "stock-delete", code: "D1-001" }];
  assert.deepEqual(stockApprovalReviewState({
    type: "stock_delete",
    reviewComplete: false,
    items,
  }), {
    reviewComplete: false,
    reviewError: "删除申请的审批明细不完整，不能批准",
  });
  assert.deepEqual(stockApprovalReviewState({
    type: "stock_delete",
    items,
  }), {
    reviewComplete: true,
    reviewError: "",
  });
});

test("unreviewable updates disable approval but allow a reasoned rejection", () => {
  const base = {
    approvalRequestId: "approval-a",
    detailsReady: true,
    reviewComplete: true,
    reviewError: "",
    hasUnreviewableUpdate: true,
    canApprove: true,
  };
  assert.equal(stockApprovalActionReady({ ...base, decision: "approve" }), false);
  assert.equal(stockApprovalActionReady({ ...base, decision: "reject", note: "申请内容没有实际差异" }), true);
  assert.equal(stockApprovalActionReady({ ...base, decision: "reject", note: "" }), false);
  assert.equal(stockApprovalActionReady({
    ...base,
    decision: "approve",
    hasUnreviewableUpdate: false,
  }), true);
  assert.equal(stockApprovalActionReady({
    ...base,
    decision: "reject",
    note: "已有其他管理员处理",
    canApprove: false,
  }), false);
});

test("legacy pending stock requests cannot be approved but remain rejectable with a reason", () => {
  const legacyPending = {
    approvalRequestId: "approval-legacy",
    detailsReady: false,
    reviewComplete: false,
    reviewError: "该申请使用旧版库存明细，不能批准",
    detailError: "库存审批明细加载失败",
    hasUnreviewableUpdate: false,
    canApprove: true,
  };
  assert.equal(stockApprovalActionReady({ ...legacyPending, decision: "approve" }), false);
  assert.equal(stockApprovalActionReady({
    ...legacyPending,
    decision: "reject",
    note: "旧申请无法完整核对，请重新发起",
  }), true);
  assert.equal(stockApprovalActionReady({ ...legacyPending, decision: "reject", note: "   " }), false);
  assert.equal(stockApprovalActionReady({
    ...legacyPending,
    decision: "reject",
    note: "旧申请无法完整核对，请重新发起",
    loadingDetails: true,
  }), false);
});
