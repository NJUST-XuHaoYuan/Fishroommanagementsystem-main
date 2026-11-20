export type FulfillmentCorrection = {
  version: number;
  shippingTimeStatus: "known" | "unknown";
  actualShippedAt?: string;
  receiptStatus: "received" | "not_received" | "unknown";
  actualDeliveredAt?: string;
  reason: string;
  updatedAt: string;
  operator: string;
  operatorName?: string;
};

export type FulfillmentCorrectionHistory = {
  id: string;
  time: string;
  from: FulfillmentCorrection | null;
  to: FulfillmentCorrection;
  operator: string;
  operatorName?: string;
  reason: string;
};

export type FulfillmentCorrectionPreview = {
  shipmentId: string;
  expectedVersion: number;
  baselineToken: string;
  current: FulfillmentCorrection | null;
  history: FulfillmentCorrectionHistory[];
  original: { shipDate?: string; shippedAt?: string; deliveredAt?: string; status: string };
  order: { id: string; orderNo: string; date: string; status: string };
};

export type FulfillmentCorrectionDraft = {
  shippingTimeStatus: "known" | "unknown";
  actualShippedAt: string;
  receiptStatus: "received" | "not_received" | "unknown";
  actualDeliveredAt: string;
  receiptDateUnknown: boolean;
  reason: string;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function correctionDateTimeInput(value?: string): string {
  return text(value).replace(" ", "T").slice(0, 19);
}

function validCorrection(value: unknown): value is FulfillmentCorrection {
  const correction = object(value);
  return Boolean(correction && Number.isInteger(correction.version) && Number(correction.version) >= 1 &&
    ["known", "unknown"].includes(String(correction.shippingTimeStatus)) &&
    ["received", "not_received", "unknown"].includes(String(correction.receiptStatus)) &&
    typeof correction.reason === "string" && typeof correction.updatedAt === "string" && typeof correction.operator === "string");
}

export function fulfillmentCorrectionPreviewFromPayload(payload: unknown, shipmentId: string): FulfillmentCorrectionPreview | null {
  const data = object(payload), original = object(data?.original), order = object(data?.order);
  if (!data || data.shipmentId !== shipmentId || !Number.isInteger(data.expectedVersion) || Number(data.expectedVersion) < 0 || !text(data.baselineToken) ||
    !original || !text(original.status) || !order || !text(order.id) || typeof order.orderNo !== "string" || typeof order.date !== "string" ||
    !Array.isArray(data.history) || (data.current !== null && !validCorrection(data.current))) return null;
  if (data.history.some(value => {
    const record = object(value);
    return !record || !text(record.id) || !text(record.time) || typeof record.operator !== "string" || typeof record.reason !== "string" ||
      (record.from !== null && !validCorrection(record.from)) || !validCorrection(record.to);
  })) return null;
  if ((data.current ? Number((data.current as FulfillmentCorrection).version) : 0) !== data.expectedVersion) return null;
  return data as unknown as FulfillmentCorrectionPreview;
}

export function fulfillmentCorrectionDraft(current: FulfillmentCorrection | null): FulfillmentCorrectionDraft {
  return {
    shippingTimeStatus: current?.shippingTimeStatus ?? "unknown",
    actualShippedAt: current?.shippingTimeStatus === "known" ? correctionDateTimeInput(current.actualShippedAt) : "",
    receiptStatus: current?.receiptStatus ?? "unknown",
    actualDeliveredAt: current?.receiptStatus === "received" ? correctionDateTimeInput(current.actualDeliveredAt) : "",
    receiptDateUnknown: current?.receiptStatus === "received" && !text(current.actualDeliveredAt),
    reason: "",
  };
}

function validLocalDateTime(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = "0"] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day) &&
    date.getUTCHours() === Number(hour) && date.getUTCMinutes() === Number(minute) && date.getUTCSeconds() === Number(second);
}

export function fulfillmentCorrectionPayload(preview: FulfillmentCorrectionPreview, draft: FulfillmentCorrectionDraft, now: string) {
  if (!["known", "unknown"].includes(draft.shippingTimeStatus) || !["received", "not_received", "unknown"].includes(draft.receiptStatus)) throw new Error("请选择实际发货和收货核对结果。");
  const shippedAt = correctionDateTimeInput(draft.actualShippedAt), deliveredAt = correctionDateTimeInput(draft.actualDeliveredAt);
  const reason = draft.reason.trim();
  const checkTime = (value: string, label: string) => {
    if (!validLocalDateTime(value)) throw new Error(`请填写有效的${label}。`);
    if (preview.order.date && value.slice(0, 10) < preview.order.date) throw new Error(`${label}不能早于下单日期。`);
    if (value > now) throw new Error(`${label}不能晚于当前时间。`);
  };
  if (draft.shippingTimeStatus === "known") checkTime(shippedAt, "实际发货时间");
  if (draft.receiptStatus === "received" && !draft.receiptDateUnknown) checkTime(deliveredAt, "实际签收时间");
  if (draft.shippingTimeStatus === "known" && draft.receiptStatus === "received" && !draft.receiptDateUnknown && deliveredAt < shippedAt) throw new Error("实际签收时间不能早于实际发货时间。");
  if (!reason) throw new Error("请填写更正原因及核对依据；无法核实的内容也请说明。");
  if (reason.length > 1000) throw new Error("更正原因最多填写 1000 字。");
  return { shipmentId: preview.shipmentId, expectedVersion: preview.expectedVersion, baselineToken: preview.baselineToken,
    shippingTimeStatus: draft.shippingTimeStatus,
    ...(draft.shippingTimeStatus === "known" ? { actualShippedAt: shippedAt } : {}),
    receiptStatus: draft.receiptStatus,
    ...(draft.receiptStatus === "received" && !draft.receiptDateUnknown ? { actualDeliveredAt: deliveredAt } : {}), reason };
}

export function shipmentFulfillmentState(shipment: { fulfillmentCorrection?: FulfillmentCorrection }) {
  const correction = shipment.fulfillmentCorrection;
  if (!correction) return null;
  const shippingTimePending = correction.shippingTimeStatus !== "known" || !text(correction.actualShippedAt);
  const needsVerification = shippingTimePending ||
    correction.receiptStatus === "unknown" || (correction.receiptStatus === "received" && !text(correction.actualDeliveredAt));
  return {
    correction, needsVerification, shippingTimePending,
    receiptLabel: correction.receiptStatus === "received" ? text(correction.actualDeliveredAt) ? "已收到" : "已收到，签收日期待核实"
      : correction.receiptStatus === "not_received" ? "尚未收到" : "无法核实",
    label: needsVerification ? "履约待核实" : correction.receiptStatus === "not_received" ? "实际尚未收到" : "履约已核实",
    pending: needsVerification || correction.receiptStatus !== "received",
  };
}

export function fulfillmentCorrectionCanApply(current: { id: string; fulfillmentCorrection?: FulfillmentCorrection } | undefined, result: { id: string; fulfillmentCorrection?: FulfillmentCorrection }) {
  return Boolean(current && current.id === result.id && result.fulfillmentCorrection &&
    Number(result.fulfillmentCorrection.version) >= Number(current.fulfillmentCorrection?.version ?? 0));
}
