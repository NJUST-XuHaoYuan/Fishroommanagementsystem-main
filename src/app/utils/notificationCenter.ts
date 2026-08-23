export type LatestRequestToken = Readonly<{
  notificationId: string;
  sequence: number;
  signal: AbortSignal;
}>;

export type LatestRequestCoordinator = {
  begin: (notificationId: string) => LatestRequestToken;
  cancel: () => void;
  isCurrent: (token: LatestRequestToken) => boolean;
};

export function createLatestRequestCoordinator(): LatestRequestCoordinator {
  let sequence = 0;
  let activeNotificationId = "";
  let activeController: AbortController | null = null;

  return {
    begin(notificationId) {
      activeController?.abort();
      sequence += 1;
      activeNotificationId = String(notificationId ?? "").trim();
      activeController = new AbortController();
      return {
        notificationId: activeNotificationId,
        sequence,
        signal: activeController.signal,
      };
    },
    cancel() {
      activeController?.abort();
      activeController = null;
      activeNotificationId = "";
      sequence += 1;
    },
    isCurrent(token) {
      return Boolean(
        token &&
        activeController &&
        !token.signal.aborted &&
        token.signal === activeController.signal &&
        token.sequence === sequence &&
        token.notificationId === activeNotificationId
      );
    },
  };
}

export type ProfileAttachmentChangeKind = "added" | "replaced" | "removed" | "unchanged";

export type StockChangeOperation = "add" | "remove" | "update";

export const STOCK_CHANGE_REVIEW_SCHEMA_VERSION = 2;

export type StockApprovalComparableItem = {
  stockItemId?: unknown;
  siteId?: unknown;
  code?: unknown;
  rawCode?: unknown;
  productId?: unknown;
  productName?: unknown;
  speciesName?: unknown;
  size?: unknown;
  origin?: unknown;
  subTankId?: unknown;
  tankName?: unknown;
  batchId?: unknown;
  batchNo?: unknown;
  supplier?: unknown;
  inDate?: unknown;
  status?: unknown;
  sold?: unknown;
  lost?: unknown;
  basePrice?: unknown;
  priceOverridden?: unknown;
  commissionRate?: unknown;
  lossDate?: unknown;
  lossReason?: unknown;
  lossProofCount?: unknown;
  notes?: unknown;
};

export type StockChangeFieldDifference = {
  field: "siteId" | "product" | "tank" | "batch" | "inDate" | "status" | "sold" | "lost" | "basePrice" |
    "priceOverridden" | "commissionRate" | "lossDate" | "lossReason" | "lossProof" | "code" | "notes";
  label: string;
  beforeValue: string;
  afterValue: string;
};

export type StockChangeItemProjection = {
  operation: StockChangeOperation;
  operationLabel: string;
  stockItemId: string;
  identifier: string;
  before: StockApprovalComparableItem | null;
  after: StockApprovalComparableItem | null;
  differences: StockChangeFieldDifference[];
  reviewableUpdate: boolean;
};

const STOCK_STATUS_LABELS: Record<string, string> = {
  healthy: "正常",
  feeding: "开口",
  sick: "疾病",
};

function textValue(value: unknown): string {
  return String(value ?? "").trim();
}

function displayedValue(value: unknown): string {
  return textValue(value) || "未填写";
}

function codeValue(item: StockApprovalComparableItem | null): string {
  if (!item) return "";
  return Object.prototype.hasOwnProperty.call(item, "rawCode")
    ? textValue(item.rawCode)
    : textValue(item.code);
}

function reviewSafeStockItem(item: StockApprovalComparableItem | null): StockApprovalComparableItem | null {
  if (!item) return null;
  return {
    stockItemId: item.stockItemId,
    siteId: item.siteId,
    code: item.code,
    rawCode: item.rawCode,
    productId: item.productId,
    productName: item.productName,
    speciesName: item.speciesName,
    size: item.size,
    origin: item.origin,
    subTankId: item.subTankId,
    tankName: item.tankName,
    batchId: item.batchId,
    batchNo: item.batchNo,
    supplier: item.supplier,
    inDate: item.inDate,
    status: item.status,
    sold: item.sold,
    lost: item.lost,
    basePrice: item.basePrice,
    priceOverridden: item.priceOverridden,
    commissionRate: item.commissionRate,
    lossDate: item.lossDate,
    lossReason: item.lossReason,
    lossProofCount: item.lossProofCount,
    notes: item.notes,
  };
}

export function stockApprovalSnapshotIdentityFields(item: StockApprovalComparableItem | null): Array<{
  field: "siteId" | "productId" | "subTankId" | "batchId";
  label: string;
  value: string;
}> {
  return [
    { field: "siteId", label: "所属场地 ID", value: displayedValue(item?.siteId) },
    { field: "productId", label: "商品 ID", value: displayedValue(item?.productId) },
    { field: "subTankId", label: "缸位 ID", value: displayedValue(item?.subTankId) },
    { field: "batchId", label: "批次 ID", value: displayedValue(item?.batchId) },
  ];
}

function productDisplay(item: StockApprovalComparableItem | null): string {
  if (!item) return "未填写";
  const values = [item.productName, item.speciesName, item.size, item.origin]
    .map(textValue)
    .filter((value, index, all) => value && all.indexOf(value) === index);
  return values.join(" · ") || displayedValue(item.productId);
}

function batchDisplay(item: StockApprovalComparableItem | null): string {
  if (!item) return "未填写";
  const values = [item.batchNo, item.supplier]
    .map(textValue)
    .filter((value, index, all) => value && all.indexOf(value) === index);
  return values.join(" · ") || displayedValue(item.batchId);
}

function relationChanged(
  before: StockApprovalComparableItem | null,
  after: StockApprovalComparableItem | null,
  idField: "productId" | "subTankId" | "batchId",
  display: (item: StockApprovalComparableItem | null) => string
): boolean {
  const beforeId = textValue(before?.[idField]);
  const afterId = textValue(after?.[idField]);
  return beforeId || afterId
    ? beforeId !== afterId
    : display(before) !== display(after);
}

function relationReviewValue(
  item: StockApprovalComparableItem | null,
  idField: "productId" | "subTankId" | "batchId",
  display: (item: StockApprovalComparableItem | null) => string
): string {
  const id = textValue(item?.[idField]);
  const label = display(item);
  return id ? `${label}\nID：${id}` : label;
}

function booleanDisplay(value: unknown): string {
  return value === true ? "是" : "否";
}

function moneyDisplay(value: unknown): string {
  if (value === "" || value == null) return "未填写";
  const amount = Number(value);
  return Number.isFinite(amount) ? `¥${amount.toFixed(2)}` : displayedValue(value);
}

function moneyComparable(value: unknown): string {
  if (value === "" || value == null) return "";
  const amount = Number(value);
  return Number.isFinite(amount) ? String(amount) : textValue(value);
}

function statusDisplay(value: unknown): string {
  const status = textValue(value);
  return STOCK_STATUS_LABELS[status] ?? displayedValue(status);
}

function rateDisplay(value: unknown): string {
  if (value === "" || value == null) return "未填写";
  const rate = Number(value);
  return Number.isFinite(rate) ? `${rate}%` : displayedValue(value);
}

function rateComparable(value: unknown): string {
  if (value === "" || value == null) return "";
  const rate = Number(value);
  return Number.isFinite(rate) ? String(rate) : textValue(value);
}

function proofCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function proofDisplay(value: unknown): string {
  const count = proofCount(value);
  return count > 0 ? `${count} 份凭证` : "无凭证";
}

function stockUpdateDifferences(
  before: StockApprovalComparableItem | null,
  after: StockApprovalComparableItem | null,
  lossProofChanged: boolean
): StockChangeFieldDifference[] {
  const differences: StockChangeFieldDifference[] = [];
  const add = (
    changed: boolean,
    field: StockChangeFieldDifference["field"],
    label: string,
    beforeValue: string,
    afterValue: string
  ) => {
    if (changed) differences.push({ field, label, beforeValue, afterValue });
  };

  add(
    textValue(before?.siteId) !== textValue(after?.siteId),
    "siteId",
    "所属场地 ID",
    displayedValue(before?.siteId),
    displayedValue(after?.siteId)
  );
  add(
    relationChanged(before, after, "productId", productDisplay),
    "product",
    "商品",
    relationReviewValue(before, "productId", productDisplay),
    relationReviewValue(after, "productId", productDisplay)
  );
  const tankDisplay = (item: StockApprovalComparableItem | null) => displayedValue(item?.tankName ?? item?.subTankId);
  add(
    relationChanged(before, after, "subTankId", tankDisplay),
    "tank",
    "缸位",
    relationReviewValue(before, "subTankId", tankDisplay),
    relationReviewValue(after, "subTankId", tankDisplay)
  );
  add(
    relationChanged(before, after, "batchId", batchDisplay),
    "batch",
    "批次",
    relationReviewValue(before, "batchId", batchDisplay),
    relationReviewValue(after, "batchId", batchDisplay)
  );
  add(textValue(before?.inDate) !== textValue(after?.inDate), "inDate", "入库日期", displayedValue(before?.inDate), displayedValue(after?.inDate));
  add(textValue(before?.status) !== textValue(after?.status), "status", "状态", statusDisplay(before?.status), statusDisplay(after?.status));
  add(Boolean(before?.sold) !== Boolean(after?.sold), "sold", "已售", booleanDisplay(before?.sold), booleanDisplay(after?.sold));
  add(Boolean(before?.lost) !== Boolean(after?.lost), "lost", "损耗", booleanDisplay(before?.lost), booleanDisplay(after?.lost));
  add(moneyComparable(before?.basePrice) !== moneyComparable(after?.basePrice), "basePrice", "售价", moneyDisplay(before?.basePrice), moneyDisplay(after?.basePrice));
  add(Boolean(before?.priceOverridden) !== Boolean(after?.priceOverridden), "priceOverridden", "特殊售价", booleanDisplay(before?.priceOverridden), booleanDisplay(after?.priceOverridden));
  add(rateComparable(before?.commissionRate) !== rateComparable(after?.commissionRate), "commissionRate", "提成比例", rateDisplay(before?.commissionRate), rateDisplay(after?.commissionRate));
  add(textValue(before?.lossDate) !== textValue(after?.lossDate), "lossDate", "损耗日期", displayedValue(before?.lossDate), displayedValue(after?.lossDate));
  add(textValue(before?.lossReason) !== textValue(after?.lossReason), "lossReason", "损耗原因", displayedValue(before?.lossReason), displayedValue(after?.lossReason));
  const proofCountChanged = proofCount(before?.lossProofCount) !== proofCount(after?.lossProofCount);
  const proofChanged = lossProofChanged || proofCountChanged;
  add(
    proofChanged,
    "lossProof",
    "损耗凭证",
    proofDisplay(before?.lossProofCount),
    lossProofChanged
      ? `${proofDisplay(after?.lossProofCount)}（凭证已替换）`
      : proofDisplay(after?.lossProofCount)
  );
  add(codeValue(before) !== codeValue(after), "code", "鱼码", displayedValue(codeValue(before)), displayedValue(codeValue(after)));
  add(textValue(before?.notes) !== textValue(after?.notes), "notes", "备注", displayedValue(before?.notes), displayedValue(after?.notes));
  return differences;
}

export function projectStockChangeItems(items: unknown): StockChangeItemProjection[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((rawItem) => {
    if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) return [];
    const source = rawItem as {
      operation?: unknown;
      stockItemId?: unknown;
      before?: unknown;
      after?: unknown;
      lossProofChanged?: unknown;
    };
    const operation = textValue(source.operation) as StockChangeOperation;
    if (!(["add", "remove", "update"] as StockChangeOperation[]).includes(operation)) return [];
    const before = source.before && typeof source.before === "object" && !Array.isArray(source.before)
      ? source.before as StockApprovalComparableItem
      : null;
    const after = source.after && typeof source.after === "object" && !Array.isArray(source.after)
      ? source.after as StockApprovalComparableItem
      : null;
    const stockItemId = textValue(source.stockItemId) || textValue(after?.stockItemId) || textValue(before?.stockItemId);
    const identifier = codeValue(after) || codeValue(before) || stockItemId || "库存标识缺失";
    const differences = operation === "update"
      ? stockUpdateDifferences(before, after, source.lossProofChanged === true)
      : [];
    return [{
      operation,
      operationLabel: operation === "add" ? "新增" : operation === "remove" ? "删除" : "修改",
      stockItemId,
      identifier,
      before: reviewSafeStockItem(before),
      after: reviewSafeStockItem(after),
      differences,
      reviewableUpdate: operation !== "update" || Boolean(before && after && differences.length > 0),
    }];
  });
}

export type StockApprovalReviewState = {
  reviewComplete: boolean;
  reviewError: string;
};

export function stockApprovalReviewState(stockDetails: unknown): StockApprovalReviewState {
  if (!stockDetails || typeof stockDetails !== "object" || Array.isArray(stockDetails)) {
    return { reviewComplete: false, reviewError: "库存审批明细缺失，不能批准" };
  }
  const details = stockDetails as {
    type?: unknown;
    schemaVersion?: unknown;
    reviewComplete?: unknown;
    reviewError?: unknown;
    items?: unknown;
  };
  if (details.type === "stock_delete") {
    const serverReviewError = textValue(details.reviewError);
    const complete = details.reviewComplete !== false && !serverReviewError &&
      Array.isArray(details.items) && details.items.length > 0;
    return {
      reviewComplete: complete,
      reviewError: complete
        ? ""
        : serverReviewError || (details.reviewComplete === false
          ? "删除申请的审批明细不完整，不能批准"
          : "删除申请没有可核对的库存明细，不能批准"),
    };
  }
  if (details.type !== "stock_change") {
    return { reviewComplete: false, reviewError: "库存审批明细类型无效，不能批准" };
  }
  const serverReviewError = textValue(details.reviewError);
  if (serverReviewError) return { reviewComplete: false, reviewError: serverReviewError };
  if (Number(details.schemaVersion) !== STOCK_CHANGE_REVIEW_SCHEMA_VERSION) {
    return {
      reviewComplete: false,
      reviewError: "该申请使用旧版库存明细，服务端未能重建为完整可审查版本，不能批准",
    };
  }
  if (details.reviewComplete !== true) {
    return {
      reviewComplete: false,
      reviewError: "库存明细重建失败或内容不完整，不能批准",
    };
  }
  const sourceItems = Array.isArray(details.items) ? details.items : [];
  const projectedItems = projectStockChangeItems(sourceItems);
  if (sourceItems.length === 0 || projectedItems.length !== sourceItems.length) {
    return {
      reviewComplete: false,
      reviewError: "库存审批缺少完整的逐条操作明细，不能批准",
    };
  }
  const snapshotsComplete = projectedItems.every((item) => {
    if (item.operation === "add") return Boolean(item.after);
    if (item.operation === "remove") return Boolean(item.before);
    return Boolean(item.before && item.after);
  });
  return snapshotsComplete
    ? { reviewComplete: true, reviewError: "" }
    : { reviewComplete: false, reviewError: "库存审批的修改前后快照不完整，不能批准" };
}

export function stockApprovalDetailsReady({
  selectedNotificationId,
  loadedNotificationId,
  stockDetails,
}: {
  selectedNotificationId?: unknown;
  loadedNotificationId?: unknown;
  stockDetails?: unknown;
}): boolean {
  const selectedId = textValue(selectedNotificationId);
  const loadedId = textValue(loadedNotificationId);
  if (!selectedId || selectedId !== loadedId || !stockDetails || typeof stockDetails !== "object" || Array.isArray(stockDetails)) {
    return false;
  }
  const details = stockDetails as {
    type?: unknown;
    items?: unknown;
    reviewComplete?: unknown;
    reviewError?: unknown;
  };
  if (details.type === "stock_change") {
    return Array.isArray(details.items) || details.reviewComplete === false || Boolean(textValue(details.reviewError));
  }
  return details.type === "stock_delete" && Array.isArray(details.items) && details.items.length > 0;
}

export function stockApprovalActionReady({
  approvalRequestId,
  decision,
  processing,
  loadingDetails,
  detailError,
  detailsReady,
  reviewComplete,
  reviewError,
  hasUnreviewableUpdate,
  canApprove,
  note,
}: {
  approvalRequestId?: unknown;
  decision?: unknown;
  processing?: boolean;
  loadingDetails?: boolean;
  detailError?: unknown;
  detailsReady?: boolean;
  reviewComplete?: boolean;
  reviewError?: unknown;
  hasUnreviewableUpdate?: boolean;
  canApprove?: boolean;
  note?: unknown;
}): boolean {
  const normalizedDecision = textValue(decision);
  if (!textValue(approvalRequestId)) return false;
  if (normalizedDecision !== "approve" && normalizedDecision !== "reject") return false;
  if (processing || loadingDetails || canApprove !== true) return false;
  if (normalizedDecision === "reject") return Boolean(textValue(note));
  return !Boolean(detailError) && detailsReady === true && reviewComplete === true &&
    !textValue(reviewError) && hasUnreviewableUpdate !== true;
}

function attachmentId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return String((value as { id?: unknown }).id ?? "").trim();
}

export function profileAttachmentChangeKind(
  beforeAttachment: unknown,
  afterAttachment: unknown
): ProfileAttachmentChangeKind {
  const beforeId = attachmentId(beforeAttachment);
  const afterId = attachmentId(afterAttachment);
  if (!beforeId && afterId) return "added";
  if (beforeId && !afterId) return "removed";
  if (beforeId && afterId && beforeId !== afterId) return "replaced";
  return "unchanged";
}

export function profileApprovalDetailsReady({
  selectedNotificationId,
  loadedNotificationId,
  profileChanges,
}: {
  selectedNotificationId?: unknown;
  loadedNotificationId?: unknown;
  profileChanges?: unknown;
}): boolean {
  const selectedId = String(selectedNotificationId ?? "").trim();
  const loadedId = String(loadedNotificationId ?? "").trim();
  return Boolean(
    selectedId &&
    selectedId === loadedId &&
    Array.isArray(profileChanges) &&
    profileChanges.length > 0
  );
}

export function profileApprovalActionReady({
  profileRequestId,
  decision,
  processing,
  loadingDetails,
  detailError,
  detailsReady,
  note,
}: {
  profileRequestId?: unknown;
  decision?: unknown;
  processing?: boolean;
  loadingDetails?: boolean;
  detailError?: unknown;
  detailsReady?: boolean;
  note?: unknown;
}): boolean {
  const normalizedDecision = String(decision ?? "").trim();
  if (!String(profileRequestId ?? "").trim()) return false;
  if (normalizedDecision !== "approve" && normalizedDecision !== "reject") return false;
  if (processing || loadingDetails || Boolean(detailError) || !detailsReady) return false;
  return normalizedDecision === "approve" || Boolean(String(note ?? "").trim());
}
