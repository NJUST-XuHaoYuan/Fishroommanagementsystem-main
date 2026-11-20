import { createHash, randomUUID } from "node:crypto";
import { resolveUniqueShipmentMutationTarget } from "./order-shipment-mutation-targets.mjs";

const list = value => Array.isArray(value) ? value : [];
const text = value => String(value ?? "").trim();
const fail = (statusCode, code, message) => { throw Object.assign(new Error(message), { statusCode, code }); };
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))) : entry);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");

function correctionTarget(state, shipmentId, actor) {
  // HTTP callers must refresh the authoritative account under the same lock.
  // An explicitly authorized maintenance script may supply its own audit actor.
  if (actor?.accessRole !== "admin" || !text(actor.username)) fail(403, "FULFILLMENT_CORRECTION_ADMIN_REQUIRED", "仅管理员可以更正履约核对记录");
  const target = resolveUniqueShipmentMutationTarget(state, shipmentId);
  const sites = list(state.sites).filter(site => text(site.id) === target.siteId);
  if (!target.siteId || sites.length !== 1 || (text(target.shipment.siteId) && text(target.shipment.siteId) !== target.siteId)) {
    fail(403, "FULFILLMENT_CORRECTION_SITE_INVALID", "订单和发货单的场地记录不一致或无效，请先核对");
  }
  if (!["outbound", "shipped", "delivered", "damaged"].includes(target.shipment.status)) {
    fail(409, "FULFILLMENT_CORRECTION_STATUS_INVALID", "仅已出库或已有发货记录的发货单可以更正履约核对信息");
  }
  return target;
}

export function shipmentFulfillmentCorrectionDetail(state = {}, shipmentId, actor = {}) {
  const { shipment, order } = correctionTarget(state, shipmentId, actor);
  const current = shipment.fulfillmentCorrection ?? null;
  const expectedVersion = current == null ? 0 : Number(current.version);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) fail(409, "FULFILLMENT_CORRECTION_VERSION_INVALID", "现有核对版本异常，请先核对历史记录");
  return { shipmentId: text(shipment.id), current, history: list(shipment.fulfillmentCorrectionHistory), expectedVersion,
    baselineToken: digest({ shipment, order, actor: { id: text(actor.id), username: text(actor.username), sessionVersion: actor.sessionVersion ?? 0 } }),
    original: { shipDate: text(shipment.shipDate), shippedAt: text(shipment.shippedAt), deliveredAt: text(shipment.deliveredAt), status: shipment.status },
    order: { id: text(order.id), orderNo: text(order.orderNo), date: text(order.date), status: order.status },
  };
}

function normalizedActualTime(value, label, nowMs, orderDate) {
  const raw = text(value).replace(" ", "T");
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/);
  if (!match) fail(400, "FULFILLMENT_CORRECTION_TIME_INVALID", `${label}必须填写有效日期和时间`);
  const [, y, m, d, hh, mm, ss = "00", zone = "+08:00"] = match;
  const calendar = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (calendar.toISOString().slice(0, 10) !== `${y}-${m}-${d}` || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) {
    fail(400, "FULFILLMENT_CORRECTION_TIME_INVALID", `${label}不是有效日期和时间`);
  }
  const instant = Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}${zone}`);
  if (!Number.isFinite(instant) || instant > nowMs) fail(400, "FULFILLMENT_CORRECTION_TIME_INVALID", `${label}不能晚于当前时间`);
  const chinaTime = new Date(instant + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
  if (chinaTime.slice(0, 10) < orderDate) fail(400, "FULFILLMENT_CORRECTION_TIME_INVALID", `${label}不能早于下单日期`);
  return { value: chinaTime, instant };
}

/** Uncertain facts never become certain merely because an old workflow timer elapsed. */
export function fulfillmentCorrectionBlocksProgress(shipment = {}) {
  const correction = shipment.fulfillmentCorrection;
  return Boolean(correction && (correction.shippingTimeStatus !== "known" || !text(correction.actualShippedAt) ||
    correction.receiptStatus !== "received" || !text(correction.actualDeliveredAt)));
}

export function assertFulfillmentCorrectionAllowsProgress(shipment = {}, target = "complete") {
  const correction = shipment.fulfillmentCorrection;
  const blocked = target === "shipped"
    ? Boolean(correction && (correction.shippingTimeStatus !== "known" || !text(correction.actualShippedAt)))
    : fulfillmentCorrectionBlocksProgress(shipment);
  if (blocked) fail(409, "FULFILLMENT_CORRECTION_UNCERTAIN", target === "shipped"
    ? "实际发货时间尚未核实，请管理员先在履约记录更正中核对后再确认发货"
    : "实际发货或签收信息尚未核实，请管理员先在履约记录更正中核对，不能按历史流程状态继续推进");
}

export function assertFulfillmentCorrectionUnchanged(previous = {}, next = {}) {
  if (canonical(previous.fulfillmentCorrection ?? null) !== canonical(next.fulfillmentCorrection ?? null) ||
      canonical(previous.fulfillmentCorrectionHistory ?? []) !== canonical(next.fulfillmentCorrectionHistory ?? [])) {
    fail(409, "FULFILLMENT_CORRECTION_IMMUTABLE", "履约核对信息和更正历史只能由管理员通过专用入口保存");
  }
  if (previous.fulfillmentCorrection && ["createdAt", "outboundDate", "shipDate", "shippedAt", "deliveredAt"].some(field =>
    canonical(previous[field]) !== canonical(next[field]))) {
    fail(409, "FULFILLMENT_CORRECTION_IMMUTABLE", "已核对发货单的原登记日期属于历史证据，不能通过普通保存改写");
  }
}

/** Pure, audited metadata amendment. It never calls inventory, finance or commission mutations. */
export function applyShipmentFulfillmentCorrection(state = {}, body = {}, actor = {}, { now = new Date(), createId = prefix => `${prefix}-${randomUUID()}` } = {}) {
  const target = correctionTarget(state, body.shipmentId, actor);
  const detail = shipmentFulfillmentCorrectionDetail(state, body.shipmentId, actor);
  if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion !== detail.expectedVersion ||
      !text(body.baselineToken) || body.baselineToken !== detail.baselineToken) {
    fail(409, "FULFILLMENT_CORRECTION_CONFLICT", "订单或履约记录已变化，请重新打开核对后保存");
  }
  const reason = text(body.reason);
  if (!reason || reason.length > 2000) fail(400, "FULFILLMENT_CORRECTION_REASON_REQUIRED", "请填写更正原因（最多 2000 字）");
  if (!["known", "unknown"].includes(body.shippingTimeStatus) || !["received", "not_received", "unknown"].includes(body.receiptStatus)) {
    fail(400, "FULFILLMENT_CORRECTION_INPUT_INVALID", "请选择有效的发货时间及签收核对状态");
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(text(now).match(/(?:Z|[+-]\d{2}:\d{2})$/) ? text(now) : `${text(now)}+08:00`);
  if (!Number.isFinite(nowMs)) fail(400, "FULFILLMENT_CORRECTION_TIME_INVALID", "系统核对时间无效");
  const orderDate = text(target.order.date).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) fail(409, "FULFILLMENT_CORRECTION_ORDER_DATE_INVALID", "原订单缺少有效下单日期，无法安全核对实际履约日期");
  if (body.shippingTimeStatus === "unknown" && text(body.actualShippedAt)) fail(400, "FULFILLMENT_CORRECTION_TIME_INVALID", "发货时间无法核实时请勿填写日期");
  if (body.receiptStatus !== "received" && text(body.actualDeliveredAt)) fail(400, "FULFILLMENT_CORRECTION_TIME_INVALID", "未签收或签收待核实时请勿填写签收日期");
  const shipped = body.shippingTimeStatus === "known" ? normalizedActualTime(body.actualShippedAt, "实际发货时间", nowMs, orderDate) : null;
  const delivered = body.receiptStatus === "received" && text(body.actualDeliveredAt)
    ? normalizedActualTime(body.actualDeliveredAt, "实际签收时间", nowMs, orderDate) : null;
  if (shipped && delivered && delivered.instant < shipped.instant) fail(400, "FULFILLMENT_CORRECTION_TIME_INVALID", "实际签收时间不能早于实际发货时间");
  const time = new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 19);
  const correction = { version: detail.expectedVersion + 1, shippingTimeStatus: body.shippingTimeStatus,
    ...(shipped ? { actualShippedAt: shipped.value } : {}), receiptStatus: body.receiptStatus,
    ...(delivered ? { actualDeliveredAt: delivered.value } : {}), reason, updatedAt: time,
    operator: text(actor.username), operatorName: text(actor.name || actor.username) };
  const history = { id: createId("fulfillment-correction"), time, from: detail.current, to: correction,
    operator: correction.operator, operatorName: correction.operatorName, reason };
  const operationLog = { id: createId("log"), time, operator: correction.operator, module: "订单管理", action: "履约记录更正",
    detail: `订单「${target.order.orderNo || target.order.id}」发货单 ${target.shipment.id} 更正实际履约核对记录（第 ${correction.version} 版）；原因：${reason}。原流程状态、原日期、鱼只库存及交易金额保留。` };
  if (!text(history.id) || !text(operationLog.id) || list(target.shipment.fulfillmentCorrectionHistory).some(entry => entry.id === history.id) ||
      list(state.operationLogs).some(entry => entry.id === operationLog.id)) fail(409, "FULFILLMENT_CORRECTION_AUDIT_ID_CONFLICT", "审计记录编号重复，请重试");
  const shipment = { ...target.shipment, fulfillmentCorrection: correction,
    fulfillmentCorrectionHistory: [...list(target.shipment.fulfillmentCorrectionHistory), history] };
  return { shipment, operationLog, state: { ...state,
    shipments: list(state.shipments).map(entry => entry === target.shipment ? shipment : entry),
    operationLogs: [operationLog, ...list(state.operationLogs)],
  } };
}
