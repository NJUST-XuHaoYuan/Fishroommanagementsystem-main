import { authJsonHeaders } from "./authSession.ts";

export const ORDER_FOLLOWUP_MAX_LENGTH = 3000;
export type OrderFollowupRecord = {
  id: string; content: string; createdAt: string; operator: string;
  operatorName: string; operatorPersonnelId: string;
};
export type OrderFollowupDetail = {
  ok: true; siteId: string; orderId: string; records: OrderFollowupRecord[];
  total: number; canCreate: boolean; replayed?: boolean;
};
export type OrderFollowupMutation = { context: string; content: string; clientMutationId: string };
export type OrderFollowupWrite = { siteId: string; orderId: string; content: string; clientMutationId: string };

export class OrderFollowupRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "OrderFollowupRequestError"; this.status = status; }
}

function specificContext(siteId: string, orderId: string) {
  if (!siteId.trim() || siteId === "all" || !orderId.trim()) throw new Error("请选择具体场地和订单后查看回访记录。");
}
export function orderFollowupContent(content: string): string {
  const value = content.trim();
  if (!value) throw new Error("请填写本次回访内容。");
  if (value.length > ORDER_FOLLOWUP_MAX_LENGTH) throw new Error("回访内容最多 3000 字，请精简后再保存。");
  return value;
}

export function createOrderFollowupMutationId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues !== "function") throw new Error("当前浏览器无法安全生成回访编号，请刷新或更换浏览器后重试。");
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keep the same mutation after a lost response; changing account/order/content starts a new one. */
export function orderFollowupMutation(previous: OrderFollowupMutation | null, context: string, content: string,
  createId = createOrderFollowupMutationId): OrderFollowupMutation {
  const value = orderFollowupContent(content);
  return previous?.context === context && previous.content === value ? previous : { context, content: value, clientMutationId: createId() };
}

export function parseOrderFollowupDetail(value: unknown, siteId: string, orderId: string): OrderFollowupDetail {
  specificContext(siteId, orderId);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("回访记录信息不完整，请刷新重试。");
  const raw = value as Record<string, unknown>;
  if (raw.ok !== true || raw.siteId !== siteId || raw.orderId !== orderId || !Array.isArray(raw.records)
    || !Number.isSafeInteger(raw.total) || raw.total !== raw.records.length || typeof raw.canCreate !== "boolean"
    || (raw.replayed !== undefined && typeof raw.replayed !== "boolean")) throw new Error("回访记录与当前订单不一致或信息不完整，请刷新重试。");
  const ids = new Set<string>();
  const records = raw.records.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("回访记录格式异常，请刷新重试。");
    const record = item as Record<string, unknown>;
    if (!["id", "content", "createdAt", "operator", "operatorName", "operatorPersonnelId"].every(key => typeof record[key] === "string")
      || !(record.id as string).trim() || ids.has(record.id as string) || !(record.content as string).trim()
      || (record.content as string).length > ORDER_FOLLOWUP_MAX_LENGTH || !(record.operator as string).trim()
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(record.createdAt as string)
      || !Number.isFinite(Date.parse(`${record.createdAt}+08:00`))) throw new Error("回访记录格式异常，请刷新重试。");
    ids.add(record.id as string);
    return { id: record.id, content: record.content, createdAt: record.createdAt, operator: record.operator,
      operatorName: record.operatorName, operatorPersonnelId: record.operatorPersonnelId } as OrderFollowupRecord;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { ok: true, siteId, orderId, records, total: raw.total as number, canCreate: raw.canCreate,
    ...(raw.replayed !== undefined ? { replayed: raw.replayed } : {}) };
}

async function responseDetail(response: Response, siteId: string, orderId: string): Promise<OrderFollowupDetail> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 401 ? "登录已过期，请重新登录后查看回访记录。"
      : response.status === 403 ? "当前账号已无权操作这笔订单的回访记录。"
      : typeof payload?.error === "string" && payload.error.trim() ? payload.error : "回访记录暂时无法读取，请稍后重试。";
    throw new OrderFollowupRequestError(message, response.status);
  }
  return parseOrderFollowupDetail(payload, siteId, orderId);
}

export async function fetchOrderFollowups(siteId: string, orderId: string, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<OrderFollowupDetail> {
  specificContext(siteId, orderId);
  const params = new URLSearchParams({ siteId, orderId });
  const response = await request(`/api/order-followups?${params}`, { headers: authJsonHeaders(), signal, cache: "no-store" });
  return responseDetail(response, siteId, orderId);
}

export async function saveOrderFollowup(input: OrderFollowupWrite, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<OrderFollowupDetail> {
  specificContext(input.siteId, input.orderId);
  const content = orderFollowupContent(input.content);
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(input.clientMutationId)) throw new Error("回访编号无效，请重新打开订单后重试。");
  const response = await request("/api/order-followups", { method: "POST", headers: authJsonHeaders(), signal, cache: "no-store",
    body: JSON.stringify({ siteId: input.siteId, orderId: input.orderId, content, clientMutationId: input.clientMutationId }) });
  return responseDetail(response, input.siteId, input.orderId);
}
