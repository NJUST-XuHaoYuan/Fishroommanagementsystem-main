function id(value) {
  return String(value ?? "").trim();
}

function matchesById(records, targetId) {
  const wanted = id(targetId);
  return (Array.isArray(records) ? records : []).filter((record) => id(record?.id) === wanted);
}

function relationshipError(message, statusCode = 400, code = "STOCK_RELATION_INVALID") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stockIndex(records = []) {
  const byId = new Map();
  for (const item of Array.isArray(records) ? records : []) {
    const stockId = id(item?.id);
    if (!stockId || byId.has(stockId)) {
      throw relationshipError("库存记录 ID 缺失或重复，请先修复数据后再操作", 409, "STOCK_ID_NOT_UNIQUE");
    }
    byId.set(stockId, item);
  }
  return byId;
}

function stockConcurrencySnapshot(item = {}) {
  const optionalString = (value) => String(value ?? "");
  const legacySold = item?.status === "sold";
  return {
    id: id(item?.id),
    siteId: id(item?.siteId),
    productId: id(item?.productId),
    batchId: id(item?.batchId),
    subTankId: id(item?.subTankId),
    status: legacySold ? "healthy" : optionalString(item?.status),
    sold: legacySold || Boolean(item?.sold),
    lost: Boolean(item?.lost),
    lossDate: optionalString(item?.lossDate),
    lossReason: optionalString(item?.lossReason),
    lossProof: (Array.isArray(item?.lossProof) ? item.lossProof : []).map(optionalString),
    inDate: optionalString(item?.inDate),
    basePrice: Number(item?.basePrice ?? item?.cost ?? 0),
    priceOverridden: Boolean(item?.priceOverridden),
    commissionRate: Number(item?.commissionRate ?? 0),
    code: optionalString(item?.code),
    notes: optionalString(item?.notes),
  };
}

export function authoritativeStockMutationSiteId(state = {}, item = {}) {
  const stockId = id(item?.id) || "（新库存）";
  const products = matchesById(state.products, item?.productId);
  if (products.length !== 1) {
    throw relationshipError(`库存 ${stockId} 关联的商品不存在或不唯一`);
  }

  const batches = matchesById(state.batches, item?.batchId);
  if (batches.length !== 1) {
    throw relationshipError(`库存 ${stockId} 关联的采购批次不存在或不唯一`);
  }

  const subTankId = id(item?.subTankId);
  const tankMatches = (Array.isArray(state.tankGroups) ? state.tankGroups : []).flatMap((group) =>
    (Array.isArray(group?.subTanks) ? group.subTanks : [])
      .filter((tank) => id(tank?.id) === subTankId)
      .map(() => group)
  );
  if (!subTankId || tankMatches.length !== 1) {
    throw relationshipError(`库存 ${stockId} 关联的缸位不存在或不唯一`);
  }

  const directSiteId = id(item?.siteId);
  const tankSiteId = id(tankMatches[0]?.siteId);
  const siteMatches = matchesById(state.sites, directSiteId);
  if (!directSiteId || siteMatches.length !== 1) {
    throw relationshipError(`库存 ${stockId} 关联的场地不存在或不唯一`);
  }
  if (!tankSiteId || directSiteId !== tankSiteId) {
    throw relationshipError(`库存 ${stockId} 的场地和当前缸位不一致`);
  }
  return directSiteId;
}

export function validateStockMutationRelationships(
  state = {},
  change = {},
  { visibleSiteIds } = {},
) {
  const stockById = stockIndex(state.stock);

  const visible = visibleSiteIds === undefined
    ? null
    : new Set((Array.isArray(visibleSiteIds) ? visibleSiteIds : []).map(id).filter(Boolean));
  const requireVisible = (siteId) => {
    if (visible && !visible.has(siteId)) {
      throw relationshipError("不能修改未授权场地的库存", 403, "STOCK_SITE_FORBIDDEN");
    }
  };

  const upsertItems = Array.isArray(change?.upsert) ? change.upsert : [];
  const upsertIds = upsertItems.map((item) => id(item?.id));
  if (upsertIds.some((stockId) => !stockId)) {
    throw relationshipError("库存记录 ID 不能为空", 400, "STOCK_ID_REQUIRED");
  }
  if (new Set(upsertIds).size !== upsertIds.length) {
    throw relationshipError("库存保存项 ID 不能重复", 400, "STOCK_UPSERT_ID_DUPLICATE");
  }

  const deleteIds = (Array.isArray(change?.deleteIds) ? change.deleteIds : []).map(id);
  if (deleteIds.some((stockId) => !stockId)) {
    throw relationshipError("库存删除项 ID 不能为空", 400, "STOCK_DELETE_ID_REQUIRED");
  }
  if (new Set(deleteIds).size !== deleteIds.length) {
    throw relationshipError("库存删除项不能重复", 400, "STOCK_DELETE_ID_DUPLICATE");
  }
  const deleteIdSet = new Set(deleteIds);
  if (upsertIds.some((stockId) => deleteIdSet.has(stockId))) {
    throw relationshipError("同一库存不能同时保存和删除", 400, "STOCK_UPSERT_DELETE_CONFLICT");
  }

  for (const item of upsertItems) {
    const stockId = id(item?.id);
    const previous = stockById.get(stockId);
    const previousSiteId = previous ? authoritativeStockMutationSiteId(state, previous) : "";
    const nextSiteId = authoritativeStockMutationSiteId(state, item);
    const nextBatchSiteId = id(matchesById(state.batches, item?.batchId)[0]?.siteId);
    if (previousSiteId) requireVisible(previousSiteId);
    requireVisible(nextSiteId);
    if (previousSiteId && previousSiteId !== nextSiteId) {
      throw relationshipError("库存不能通过普通保存跨场地移动，请使用专用移缸流程", 409, "STOCK_SITE_CHANGE_FORBIDDEN");
    }
    const batchChanged = previous && id(previous?.batchId) !== id(item?.batchId);
    // A batch records the procurement site. Fish moved later through the
    // dedicated maintenance flow legitimately keep that historical batch, so
    // only a new stock row or an explicit batch reassignment must use a batch
    // from the fish's current site.
    if ((!previous || batchChanged) && nextBatchSiteId !== nextSiteId) {
      throw relationshipError("新增库存或更换批次时，采购批次必须属于当前场地", 400, "STOCK_BATCH_SITE_INVALID");
    }
  }

  for (const stockId of deleteIds) {
    const previous = stockById.get(stockId);
    if (!previous) throw relationshipError("部分库存记录已不存在，请刷新后重试");
    requireVisible(authoritativeStockMutationSiteId(state, previous));
  }
  return true;
}

export function buildStockMutationExpectation(state = {}, change = {}) {
  const stockById = stockIndex(state.stock);
  const upsertIds = (Array.isArray(change?.upsert) ? change.upsert : []).map((item) => id(item?.id));
  const deleteIds = (Array.isArray(change?.deleteIds) ? change.deleteIds : []).map(id);
  const expectedOperations = Object.create(null);
  const expectedBefore = Object.create(null);
  for (const stockId of upsertIds) {
    const previous = stockById.get(stockId);
    expectedOperations[stockId] = previous ? "update" : "create";
    if (previous) expectedBefore[stockId] = stockConcurrencySnapshot(previous);
  }
  for (const stockId of deleteIds) {
    const previous = stockById.get(stockId);
    if (!previous) throw relationshipError("部分库存记录已不存在，请刷新后重试", 409, "STOCK_APPROVAL_STALE");
    expectedOperations[stockId] = "delete";
    expectedBefore[stockId] = stockConcurrencySnapshot(previous);
  }
  return { expectedOperations, expectedBefore };
}

export function assertStockMutationExpectation(state = {}, payload = {}) {
  const expectedOperations = payload?.expectedOperations;
  const expectedBefore = payload?.expectedBefore;
  if (!expectedOperations || typeof expectedOperations !== "object" ||
      !expectedBefore || typeof expectedBefore !== "object") {
    throw relationshipError("该库存审批缺少并发校验信息，请驳回后重新提交", 409, "STOCK_APPROVAL_STALE");
  }
  const stockById = stockIndex(state.stock);
  const upsertIds = (Array.isArray(payload?.upsert) ? payload.upsert : []).map((item) => id(item?.id));
  const deleteIds = (Array.isArray(payload?.deleteIds) ? payload.deleteIds : []).map(id);
  const requestedIds = [...upsertIds, ...deleteIds];
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw relationshipError("该库存审批的记录编号冲突，请驳回后重新提交", 409, "STOCK_APPROVAL_STALE");
  }
  const expectationIds = Object.keys(expectedOperations).map(id);
  if (new Set(expectationIds).size !== requestedIds.length ||
      requestedIds.some((stockId) => !expectationIds.includes(stockId))) {
    throw relationshipError("该库存审批的校验范围不完整，请驳回后重新提交", 409, "STOCK_APPROVAL_STALE");
  }
  for (const stockId of requestedIds) {
    const operation = expectedOperations[stockId];
    const current = stockById.get(stockId);
    const requiredOperation = deleteIds.includes(stockId) ? "delete" : current ? "update" : "create";
    if (operation !== requiredOperation) {
      throw relationshipError("库存操作类型已变化，请刷新后重试", 409, "STOCK_APPROVAL_STALE");
    }
    if (operation === "create") {
      if (current) throw relationshipError("待新增库存编号已被占用，请驳回后重新提交", 409, "STOCK_APPROVAL_STALE");
      continue;
    }
    if (!["update", "delete"].includes(operation) || !current ||
        stableJson(stockConcurrencySnapshot(current)) !== stableJson(stockConcurrencySnapshot(expectedBefore[stockId]))) {
      throw relationshipError("待审批库存已发生变化，请驳回后让发起人重新提交", 409, "STOCK_APPROVAL_STALE");
    }
  }
  return true;
}
