import assert from "node:assert/strict";
import test from "node:test";
import {
  batchRequiresLateStockApproval,
  buildStockChangeSnapshot,
  buildStockDeletionSnapshot,
  classifyStockMutationForApproval,
  filterEffectiveStockMutation,
  preserveBatchCreationTimes,
  rebuildStockChangeSnapshotFromApprovalRequest,
  stockApprovalDetailsForResponse,
  stockApprovalReviewDetails,
  stockChangeAdjustmentSignature,
  STOCK_CHANGE_SNAPSHOT_SCHEMA_VERSION,
  STOCK_BATCH_APPROVAL_DELAY_MS,
} from "./stock-approval-rules.mjs";
import { stockConcurrencySnapshot } from "./stock-mutation-relationships.mjs";

test("canonical no-op stock upserts are filtered while creates, deletes and real edits remain", () => {
  const legacySold = {
    id: "legacy-sold",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "sold",
    cost: 88,
    lossDate: " ",
    lossReason: "   ",
    notes: "   ",
  };
  const unchangedDisplayed = {
    id: "legacy-sold",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    sold: true,
    lost: false,
    lossDate: "",
    lossReason: "",
    lossProof: [],
    inDate: "",
    basePrice: 88,
    priceOverridden: false,
    commissionRate: 0,
    code: "",
    notes: "",
  };
  const realEdit = { ...unchangedDisplayed, notes: "核对后修改" };
  const created = { ...unchangedDisplayed, id: "new-stock" };

  assert.deepEqual(filterEffectiveStockMutation({
    stock: [legacySold],
    upsertItems: [unchangedDisplayed],
  }).upsertItems, []);
  assert.deepEqual(filterEffectiveStockMutation({
    stock: [legacySold],
    upsertItems: [realEdit, created],
    deleteIds: ["remove-stock"],
  }), {
    upsertItems: [realEdit, created],
    deleteIds: ["remove-stock"],
  });
});

test("stock change snapshots omit canonical no-ops and keep only real updates", () => {
  const current = {
    id: "stock-1",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    inDate: "2026-07-30",
    basePrice: 260,
    notes: "",
  };
  const snapshot = buildStockChangeSnapshot({
    stock: [current],
    upsertItems: [
      { ...current, notes: "   ", lossProof: [], commissionRate: 0, priceOverridden: false },
      { ...current, id: "stock-2", notes: "new" },
    ],
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }] }],
  });

  assert.deepEqual(snapshot.totals, { addCount: 1, removeCount: 0, updateCount: 0 });
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].operation, "add");
  assert.equal(snapshot.items[0].stockItemId, "stock-2");
});

test("real stock updates expose every canonical audit field without loss proof URLs", () => {
  const current = {
    id: "stock-1",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    sold: false,
    lost: false,
    lossDate: "",
    lossReason: "",
    lossProof: ["https://private.example/old-proof"],
    inDate: "2026-07-30",
    basePrice: 260,
    priceOverridden: false,
    commissionRate: 0,
    code: "",
    notes: "",
  };
  const updated = {
    ...current,
    lossDate: "2026-08-20",
    lossReason: "运输损耗",
    lossProof: ["https://private.example/new-proof"],
    priceOverridden: true,
    commissionRate: 2,
    code: "stock-1",
  };
  const snapshot = buildStockChangeSnapshot({
    stock: [current],
    upsertItems: [updated],
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }] }],
  });
  const change = snapshot.items[0];

  assert.deepEqual(snapshot.totals, { addCount: 0, removeCount: 0, updateCount: 1 });
  assert.deepEqual(change.changedFields, [
    "lossDate",
    "lossReason",
    "lossProof",
    "priceOverridden",
    "commissionRate",
    "code",
  ]);
  assert.equal(change.lossProofChanged, true);
  assert.equal(change.before.code, "");
  assert.equal(change.after.code, "stock-1");
  assert.equal(change.before.rawCode, "");
  assert.equal(change.after.rawCode, "stock-1");
  assert.equal(change.before.lossProofCount, 1);
  assert.equal(change.after.lossProofCount, 1);
  assert.notEqual(change.before.lossProofFingerprint, change.after.lossProofFingerprint);
  assert.equal(change.after.priceOverridden, true);
  assert.equal(change.after.commissionRate, 2);
  assert.equal(change.after.lossDate, "2026-08-20");
  assert.equal(change.after.lossReason, "运输损耗");
  for (const field of [
    "siteId",
    "productId",
    "batchId",
    "subTankId",
    "status",
    "sold",
    "lost",
    "lossDate",
    "lossReason",
    "inDate",
    "basePrice",
    "priceOverridden",
    "commissionRate",
    "code",
    "notes",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(change.after, field), true, `${field} should be auditable`);
  }
  assert.equal(Object.prototype.hasOwnProperty.call(change.after, "lossProof"), false);
  assert.doesNotMatch(JSON.stringify(snapshot), /private\.example/);
});

test("stock change approvals group exact deltas by tank, product and batch", () => {
  const snapshot = buildStockChangeSnapshot({
    stock: [{
      id: "stock-remove",
      productId: "product-1",
      batchId: "batch-1",
      subTankId: "tank-1",
      status: "healthy",
      inDate: "2026-07-30",
      basePrice: 260,
    }],
    upsertItems: [
      { id: "stock-add-1", productId: "product-1", batchId: "batch-1", subTankId: "tank-2", status: "healthy", inDate: "2026-07-30", basePrice: 260 },
      { id: "stock-add-2", productId: "product-1", batchId: "batch-1", subTankId: "tank-2", status: "healthy", inDate: "2026-07-30", basePrice: 260 },
    ],
    deleteIds: ["stock-remove"],
    products: [{ id: "product-1", speciesId: "species-1", name: "蓝吊", origin: "印尼", size: "7-8" }],
    species: [{ id: "species-1", name: "蓝点吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-2026-030", arrivalDate: "2026-07-30", supplier: "供应商A" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }, { id: "tank-2", name: "D1-2" }] }],
  });

  assert.deepEqual(snapshot.totals, { addCount: 2, removeCount: 1, updateCount: 0 });
  assert.equal(snapshot.tanks.length, 2);
  assert.equal(snapshot.tanks.find((tank) => tank.subTankId === "tank-1")?.removeCount, 1);
  assert.equal(snapshot.tanks.find((tank) => tank.subTankId === "tank-2")?.addCount, 2);
  assert.deepEqual(snapshot.batches[0], {
    batchId: "batch-1",
    batchNo: "PO-2026-030",
    batchDate: "2026-07-30",
    supplier: "供应商A",
    origins: ["印尼"],
    addCount: 2,
    removeCount: 1,
    updateCount: 0,
  });
  assert.equal(snapshot.tanks[1].rows[0].origin, "印尼");
});

test("inventory adjustment signatures ignore generated stock ids", () => {
  const input = {
    stock: [{ id: "remove-a", productId: "product-1", batchId: "batch-1", subTankId: "tank-1" }],
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }, { id: "tank-2", name: "D1-2" }] }],
  };
  const first = buildStockChangeSnapshot({
    ...input,
    deleteIds: ["remove-a"],
    upsertItems: [{ id: "generated-a", productId: "product-1", batchId: "batch-1", subTankId: "tank-2" }],
  });
  const second = buildStockChangeSnapshot({
    ...input,
    deleteIds: ["remove-a"],
    upsertItems: [{ id: "generated-b", productId: "product-1", batchId: "batch-1", subTankId: "tank-2" }],
  });

  assert.deepEqual(stockChangeAdjustmentSignature(first), stockChangeAdjustmentSignature(second));
});

test("inventory adjustment signatures distinguish exact removals", () => {
  const input = {
    stock: [
      { id: "remove-a", productId: "product-1", batchId: "batch-1", subTankId: "tank-1" },
      { id: "remove-b", productId: "product-1", batchId: "batch-1", subTankId: "tank-1" },
    ],
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }] }],
  };
  const first = buildStockChangeSnapshot({ ...input, deleteIds: ["remove-a"] });
  const second = buildStockChangeSnapshot({ ...input, deleteIds: ["remove-b"] });

  assert.notDeepEqual(stockChangeAdjustmentSignature(first), stockChangeAdjustmentSignature(second));
});

test("inventory adjustment signatures bind every canonical add proposal field", () => {
  const context = {
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ siteId: "nanjing", name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }] }],
  };
  const baselineItem = {
    id: "generated-baseline",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    sold: false,
    lost: false,
    lossDate: "",
    lossReason: "",
    lossProof: ["https://private.example/proof-a"],
    inDate: "2026-08-20",
    basePrice: 100,
    priceOverridden: false,
    commissionRate: 0,
    code: "FISH-001",
    notes: "原备注",
  };
  const signatureFor = (item) => stockChangeAdjustmentSignature(buildStockChangeSnapshot({
    ...context,
    upsertItems: [item],
  }));
  const baselineSignature = signatureFor(baselineItem);
  const variants = [
    ["status", { status: "feeding" }],
    ["sold", { sold: true }],
    ["lost", { lost: true }],
    ["lossDate", { lossDate: "2026-08-21" }],
    ["lossReason", { lossReason: "运输损耗" }],
    ["lossProof", { lossProof: ["https://private.example/proof-b"] }],
    ["inDate", { inDate: "2026-08-21" }],
    ["basePrice", { basePrice: 101 }],
    ["priceOverridden", { priceOverridden: true }],
    ["commissionRate", { commissionRate: 2 }],
    ["code", { code: "FISH-002" }],
    ["notes", { notes: "新备注" }],
  ];

  for (const [field, patch] of variants) {
    assert.notDeepEqual(signatureFor({
      ...baselineItem,
      ...patch,
      id: `generated-${field}`,
    }), baselineSignature, `${field} must change the adjustment signature`);
  }
  assert.doesNotMatch(JSON.stringify(baselineSignature), /private\.example/);
});

test("inventory adjustment signatures are multisets and keep update targets plus full proposals", () => {
  const context = {
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }] }],
  };
  const proposal = {
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    inDate: "2026-08-20",
    basePrice: 100,
    code: "FISH-001",
    notes: "新增",
  };
  const twoAdds = buildStockChangeSnapshot({
    ...context,
    upsertItems: [{ ...proposal, id: "generated-a" }, { ...proposal, id: "generated-b" }],
  });
  const reorderedAdds = buildStockChangeSnapshot({
    ...context,
    upsertItems: [{ ...proposal, id: "generated-y" }, { ...proposal, id: "generated-x" }],
  });
  const oneAdd = buildStockChangeSnapshot({
    ...context,
    upsertItems: [{ ...proposal, id: "generated-one" }],
  });
  assert.deepEqual(stockChangeAdjustmentSignature(twoAdds), stockChangeAdjustmentSignature(reorderedAdds));
  assert.notDeepEqual(stockChangeAdjustmentSignature(twoAdds), stockChangeAdjustmentSignature(oneAdd));

  const current = { ...proposal, id: "stock-update", notes: "旧备注" };
  const firstUpdate = buildStockChangeSnapshot({
    ...context,
    stock: [current],
    upsertItems: [{ ...current, notes: "新备注", basePrice: 110 }],
  });
  const secondUpdate = buildStockChangeSnapshot({
    ...context,
    stock: [current],
    upsertItems: [{ ...current, notes: "另一个备注", basePrice: 110 }],
  });
  assert.notDeepEqual(stockChangeAdjustmentSignature(firstUpdate), stockChangeAdjustmentSignature(secondUpdate));
  assert.equal(stockChangeAdjustmentSignature(firstUpdate).updates[0].stockItemId, "stock-update");
});

test("legacy and partial stock snapshots rebuild only from immutable payload snapshots", () => {
  const context = {
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }] }],
  };
  const beforeUpdate = {
    id: "stock-update",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    inDate: "2026-08-20",
    basePrice: 100,
    priceOverridden: false,
    commissionRate: 0,
    lossProof: ["https://private.example/proof-before"],
    code: "",
    notes: "不变",
  };
  const proposedUpdate = {
    ...beforeUpdate,
    priceOverridden: true,
    commissionRate: 2,
    lossProof: ["https://private.example/proof-after"],
  };
  const created = { ...proposedUpdate, id: "stock-create", code: "NEW-001" };
  const beforeRemove = { ...beforeUpdate, id: "stock-remove", code: "OLD-001" };
  const request = {
    payload: {
      upsert: [proposedUpdate, created],
      deleteIds: ["stock-remove"],
      expectedOperations: {
        "stock-update": "update",
        "stock-create": "create",
        "stock-remove": "delete",
      },
      expectedBefore: {
        "stock-update": stockConcurrencySnapshot(beforeUpdate),
        "stock-remove": stockConcurrencySnapshot(beforeRemove),
      },
    },
    stockDetails: {
      type: "stock_change",
      totals: { addCount: 1, removeCount: 0, updateCount: 0 },
      requestedCount: 1,
      items: [{
        operation: "add",
        stockItemId: "stock-create",
        before: null,
        after: { stockItemId: "stock-create", productId: "product-1", subTankId: "tank-1", batchId: "batch-1" },
      }],
    },
  };
  const review = stockApprovalReviewDetails(request, context);

  assert.equal(review.reviewComplete, true);
  assert.equal(review.usedStoredSnapshot, false);
  assert.equal(review.rebuiltFromPayload, true);
  assert.equal(review.stockDetails.schemaVersion, STOCK_CHANGE_SNAPSHOT_SCHEMA_VERSION);
  assert.equal(review.stockDetails.reviewComplete, true);
  assert.deepEqual(review.stockDetails.items.map((item) => [item.operation, item.stockItemId]).sort(), [
    ["add", "stock-create"],
    ["remove", "stock-remove"],
    ["update", "stock-update"],
  ]);
  const update = review.stockDetails.items.find((item) => item.operation === "update");
  assert.deepEqual(update.changedFields, ["lossProof", "priceOverridden", "commissionRate"]);
  assert.equal(update.lossProofChanged, true);
  assert.equal(update.before.basePrice, 100);
});

test("valid schema v2 snapshots stay immutable while unsafe requests fail closed", () => {
  const context = {
    products: [{ id: "product-1", name: "蓝吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-1" }],
    tankGroups: [{ name: "鱼D", subTanks: [{ id: "tank-1", name: "D1-1" }] }],
  };
  const before = {
    id: "stock-update",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    inDate: "2026-08-20",
    basePrice: 100,
    notes: "旧",
  };
  const request = {
    payload: {
      upsert: [{ ...before, notes: "新" }],
      deleteIds: [],
      expectedOperations: { "stock-update": "update" },
      expectedBefore: { "stock-update": stockConcurrencySnapshot(before) },
    },
  };
  const canonical = rebuildStockChangeSnapshotFromApprovalRequest(request, context);
  request.stockDetails = canonical;
  const validReview = stockApprovalReviewDetails(request, context);
  assert.equal(validReview.reviewComplete, true);
  assert.equal(validReview.usedStoredSnapshot, true);
  assert.strictEqual(validReview.stockDetails, canonical);

  const partialV2 = structuredClone(canonical);
  delete partialV2.items[0].after.status;
  const rebuiltPartialV2 = stockApprovalReviewDetails({ ...request, stockDetails: partialV2 }, context);
  assert.equal(rebuiltPartialV2.reviewComplete, true);
  assert.equal(rebuiltPartialV2.usedStoredSnapshot, false);
  assert.equal(rebuiltPartialV2.rebuiltFromPayload, true);
  assert.equal(rebuiltPartialV2.stockDetails.items[0].after.status, "healthy");

  const missingBefore = {
    ...request,
    payload: { ...request.payload, expectedBefore: {} },
  };
  const incomplete = stockApprovalReviewDetails(missingBefore, context);
  assert.equal(incomplete.reviewComplete, false);
  assert.equal(incomplete.stockDetails.reviewComplete, false);

  const extraOperation = {
    ...request,
    payload: {
      ...request.payload,
      expectedOperations: { ...request.payload.expectedOperations, unexpected: "delete" },
    },
  };
  assert.equal(stockApprovalReviewDetails(extraOperation, context).reviewComplete, false);

  const noOpUpdate = {
    ...request,
    payload: {
      ...request.payload,
      upsert: [before],
    },
  };
  assert.equal(stockApprovalReviewDetails(noOpUpdate, context).reviewComplete, false);
});

test("stock approval detail responses redact proof fingerprints and raw proof locations", () => {
  const before = {
    id: "stock-update",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    inDate: "2026-08-20",
    basePrice: 100,
    lossProof: ["https://private.example/proof-before"],
  };
  const request = {
    payload: {
      upsert: [{ ...before, lossProof: ["https://private.example/proof-after"] }],
      deleteIds: [],
      expectedOperations: { "stock-update": "update" },
      expectedBefore: { "stock-update": stockConcurrencySnapshot(before) },
    },
  };
  const internal = stockApprovalReviewDetails(request, {}).stockDetails;
  const response = stockApprovalDetailsForResponse(internal);
  const serialized = JSON.stringify(response);

  assert.equal(response.reviewComplete, true);
  assert.equal(response.items[0].lossProofChanged, true);
  assert.equal(response.items[0].before.lossProofCount, 1);
  assert.equal(response.items[0].after.lossProofCount, 1);
  assert.doesNotMatch(serialized, /lossProofFingerprint|private\.example|"signature"/);
});

test("stock deletion approvals preserve complete inventory details", () => {
  const snapshot = buildStockDeletionSnapshot({
    deleteIds: ["stock-1", "stock-missing", "stock-1"],
    stock: [{
      id: "stock-1",
      code: "D1-2-035",
      productId: "product-1",
      batchId: "batch-1",
      subTankId: "tank-1",
      siteId: "nanjing",
      inDate: "2026-07-30",
      status: "sick",
      sold: true,
      basePrice: 260,
      notes: "观察中",
    }],
    products: [{
      id: "product-1",
      speciesId: "species-1",
      name: "蓝吊",
      size: "7-8",
      origin: "印尼",
      imageUrl: "https://example.com/blue-tang.jpg",
    }],
    species: [{ id: "species-1", name: "蓝点吊" }],
    batches: [{ id: "batch-1", batchNo: "PO-2026-030", supplier: "供应商A" }],
    tankGroups: [{ id: "group-1", name: "鱼D 1800", subTanks: [{ id: "tank-1", name: "D1-2" }] }],
    orders: [{
      id: "order-1",
      orderNo: "SO-2026-1888",
      status: "pending",
      source: "私域线上",
      items: [{ stockItemId: "stock-1" }],
    }],
  });

  assert.equal(snapshot.requestedCount, 2);
  assert.equal(snapshot.availableCount, 1);
  assert.deepEqual(snapshot.items[0], {
    stockItemId: "stock-1",
    code: "D1-2-035",
    productName: "蓝吊",
    speciesName: "蓝点吊",
    size: "7-8",
    origin: "印尼",
    imageUrl: "https://example.com/blue-tang.jpg",
    tankName: "鱼D 1800 / D1-2",
    batchNo: "PO-2026-030",
    supplier: "供应商A",
    inDate: "2026-07-30",
    status: "sick",
    sold: true,
    lost: false,
    basePrice: 260,
    notes: "观察中",
    siteId: "nanjing",
    missing: false,
    linkedOrders: [{
      id: "order-1",
      orderNo: "SO-2026-1888",
      status: "pending",
      source: "私域线上",
    }],
  });
  assert.deepEqual(snapshot.items[1], {
    stockItemId: "stock-missing",
    code: "stock-missing",
    missing: true,
    linkedOrders: [],
  });
});

test("stock deletion snapshots keep tank labels compact and skip inline images", () => {
  const snapshot = buildStockDeletionSnapshot({
    deleteIds: ["stock-1"],
    stock: [{ id: "stock-1", productId: "product-1", subTankId: "tank-1" }],
    products: [{ id: "product-1", imageUrl: "data:image/jpeg;base64,very-large-image" }],
    tankGroups: [{ name: "D1-2", subTanks: [{ id: "tank-1", name: "D1-2" }] }],
  });

  assert.equal(snapshot.items[0].tankName, "D1-2");
  assert.equal(snapshot.items[0].imageUrl, "");
});

test("stock added before a batch is 48 hours old does not require approval", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  assert.equal(batchRequiresLateStockApproval({
    createdAt: new Date(now - STOCK_BATCH_APPROVAL_DELAY_MS + 1).toISOString(),
  }, now), false);
});

test("stock added at or after 48 hours requires approval", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  assert.equal(batchRequiresLateStockApproval({
    createdAt: new Date(now - STOCK_BATCH_APPROVAL_DELAY_MS).toISOString(),
  }, now), true);
  assert.equal(batchRequiresLateStockApproval({}, now), true);
});

test("batch creation timestamps are server-assigned and cannot be changed later", () => {
  const current = [
    { id: "old", batchNo: "PO-1", createdAt: "2026-08-01T00:00:00.000Z" },
    { id: "legacy", batchNo: "PO-LEGACY" },
  ];
  const next = preserveBatchCreationTimes(current, [
    { id: "old", batchNo: "PO-1", createdAt: "2099-01-01T00:00:00.000Z" },
    { id: "legacy", batchNo: "PO-LEGACY", createdAt: "2099-01-01T00:00:00.000Z" },
    { id: "new", batchNo: "PO-2", createdAt: "2000-01-01T00:00:00.000Z" },
  ], "2026-08-03T12:00:00.000Z");
  assert.equal(next[0].createdAt, "2026-08-01T00:00:00.000Z");
  assert.equal(next[1].createdAt, undefined);
  assert.equal(next[2].createdAt, "2026-08-03T12:00:00.000Z");
});

test("staff updates and deletes require approval before changing stock", () => {
  const updated = classifyStockMutationForApproval({
    existingIds: new Set(["stock-1"]),
    upsertItems: [{ id: "stock-1", batchId: "batch-new" }],
    batches: [{ id: "batch-new", createdAt: new Date().toISOString() }],
  });
  assert.equal(updated.requiresApproval, true);
  assert.equal(updated.updatedItems.length, 1);

  const deleted = classifyStockMutationForApproval({
    existingIds: ["stock-1"],
    deleteIds: ["stock-1"],
  });
  assert.equal(deleted.requiresApproval, true);
  assert.equal(deleted.hasDeletes, true);
});

test("approval classification ignores existing canonical no-op upserts", () => {
  const current = {
    id: "stock-1",
    siteId: "nanjing",
    productId: "product-1",
    batchId: "batch-1",
    subTankId: "tank-1",
    status: "healthy",
    inDate: "2026-08-20",
    basePrice: 100,
    notes: "",
  };
  const classification = classifyStockMutationForApproval({
    existingIds: new Set(["stock-1"]),
    stock: [current],
    upsertItems: [{
      ...current,
      sold: false,
      lost: false,
      lossProof: [],
      priceOverridden: false,
      commissionRate: 0,
      notes: "   ",
    }],
    batches: [{ id: "batch-1", createdAt: "2026-08-01T00:00:00.000Z" }],
    now: Date.parse("2026-08-23T00:00:00.000Z"),
  });

  assert.equal(classification.requiresApproval, false);
  assert.deepEqual(classification.updatedItems, []);
});

test("administrators remain the approving authority and may maintain stock directly", () => {
  const result = classifyStockMutationForApproval({
    isAdmin: true,
    existingIds: ["stock-1"],
    upsertItems: [{ id: "stock-1" }],
    deleteIds: ["stock-2"],
  });
  assert.equal(result.requiresApproval, false);
});
