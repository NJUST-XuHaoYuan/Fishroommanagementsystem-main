import type { Order, OrderOwnerAssignment, Store } from "../store";
import { isNewCustomerSessionCurrent, type NewCustomerSession } from "./newCustomerEvidence";

export type OwnerAssignmentDecision = "accept" | "reject" | "cancel";
export type OrderOwnerFields = Pick<Order, "id" | "contactPersonnelId" | "contactPerson" | "ownerAssignment" | "newCustomerApproval" | "creditSaleApproval">;
export type OwnerAssignmentDetail = {
  orderId: string;
  assignment: OrderOwnerAssignment | null;
  currentOwner: { personnelId: string; name: string };
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
  blockedReason: string;
  approvalResetRequired?: { newCustomer: boolean; creditSale: boolean };
  order?: OrderOwnerFields;
};

export function parseOwnerAssignment(value: unknown): OrderOwnerAssignment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!["pending", "accepted", "rejected", "cancelled"].includes(String(item.status))
    || !["requestId", "toPersonnelId", "toUsername", "requestedAt"].every(key => typeof item[key] === "string" && Boolean(item[key]))
    || !["fromPersonnelId", "fromName", "toName", "requestedBy", "requestedByPersonnelId", "requestedByName"].every(key => typeof item[key] === "string")
    || ["resolvedBy", "resolvedByName", "note"].some(key => item[key] !== undefined && typeof item[key] !== "string")
    || !Number.isFinite(Date.parse(String(item.requestedAt)))
    || (item.version !== undefined && (!Number.isInteger(item.version) || Number(item.version) < 1))) return null;
  if (item.resolvedAt !== undefined && (typeof item.resolvedAt !== "string" || !Number.isFinite(Date.parse(item.resolvedAt)))) return null;
  return item as OrderOwnerAssignment;
}

export function ownerFieldsFromPayload(payload: unknown, orderId: string): OrderOwnerFields | null {
  if (!payload || typeof payload !== "object") return null;
  const order = (payload as { order?: unknown }).order;
  if (!order || typeof order !== "object" || Array.isArray(order)) return null;
  const item = order as Order;
  if (item.id !== orderId || (item.contactPersonnelId != null && typeof item.contactPersonnelId !== "string") || typeof item.contactPerson !== "string") return null;
  const assignment = item.ownerAssignment == null ? null : parseOwnerAssignment(item.ownerAssignment);
  if (item.ownerAssignment != null && !assignment) return null;
  return { id: orderId, contactPersonnelId: item.contactPersonnelId || "", contactPerson: item.contactPerson, ownerAssignment: assignment,
    newCustomerApproval: item.newCustomerApproval, creditSaleApproval: item.creditSaleApproval };
}

export function ownerAssignmentDetailFromPayload(payload: unknown, orderId: string): OwnerAssignmentDetail | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const item = payload as Record<string, any>;
  if (item.ok !== true || item.orderId !== orderId || !item.currentOwner || typeof item.currentOwner.personnelId !== "string" || typeof item.currentOwner.name !== "string") return null;
  const raw = item.assignment ?? item.ownerAssignment;
  const assignment = raw == null ? null : parseOwnerAssignment(raw);
  if (raw != null && !assignment) return null;
  return { orderId, assignment, currentOwner: { personnelId: item.currentOwner.personnelId, name: item.currentOwner.name },
    canAccept: item.canAccept === true, canReject: item.canReject === true, canCancel: item.canCancel === true,
    blockedReason: typeof item.blockedReason === "string" ? item.blockedReason : "", order: ownerFieldsFromPayload(item, orderId) ?? undefined,
    approvalResetRequired: { newCustomer: item.approvalResetRequired?.newCustomer === true, creditSale: item.approvalResetRequired?.creditSale === true } };
}

/** Positive means left is newer. Terminal states outrank pending even within one millisecond. */
export function compareOwnerAssignment(left?: OrderOwnerAssignment | null, right?: OrderOwnerAssignment | null) {
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  const version = Number(left.version || 0) - Number(right.version || 0);
  if (version) return version;
  const requested = Date.parse(left.requestedAt) - Date.parse(right.requestedAt);
  if (requested) return requested;
  const resolved = (Date.parse(left.resolvedAt || "") || 0) - (Date.parse(right.resolvedAt || "") || 0);
  if (resolved) return resolved;
  return Number(left.status !== "pending") - Number(right.status !== "pending");
}

export function retainNewerOwnerAssignments<T extends OrderOwnerFields>(current: T[], incoming: T[]): T[] {
  const currentById = new Map(current.map(order => [order.id, order]));
  return incoming.map(order => {
    const previous = currentById.get(order.id);
    if (!previous || compareOwnerAssignment(previous.ownerAssignment, order.ownerAssignment) <= 0) return order;
    return { ...order, contactPersonnelId: previous.contactPersonnelId, contactPerson: previous.contactPerson,
      ownerAssignment: previous.ownerAssignment, newCustomerApproval: previous.newCustomerApproval, creditSaleApproval: previous.creditSaleApproval };
  });
}

/** Merge only owner-related fields; never restore deleted orders or overwrite financial/fulfillment data. */
export function mergeOwnerAssignmentForSession(current: Store, incoming: OrderOwnerFields, session: NewCustomerSession): Store {
  if (!isNewCustomerSessionCurrent(session, current.user)) return current;
  const previous = current.orders.find(order => order.id === incoming.id);
  if (!previous || compareOwnerAssignment(previous.ownerAssignment, incoming.ownerAssignment) >= 0) return current;
  return { ...current, orders: current.orders.map(order => order.id === incoming.id ? { ...order, ...incoming } : order) };
}

export function ownerAssignmentActionReady(detail: OwnerAssignmentDetail | null, decision: OwnerAssignmentDecision, expectedRequestId?: string) {
  return Boolean(detail?.assignment?.status === "pending"
    && (!expectedRequestId || detail.assignment.requestId === expectedRequestId)
    && (decision === "accept" ? detail.canAccept && !detail.blockedReason : decision === "reject" ? detail.canReject : detail.canCancel));
}

export function ownerAssignmentDecisionApplied(order: OrderOwnerFields | null, decision: OwnerAssignmentDecision, requestId: string) {
  const expectedStatus = { accept: "accepted", reject: "rejected", cancel: "cancelled" }[decision];
  return Boolean(order?.ownerAssignment?.requestId === requestId && order.ownerAssignment.status === expectedStatus
    && (decision !== "accept" || order.contactPersonnelId === order.ownerAssignment.toPersonnelId));
}

export function ownerSelectionHint({ creating, currentOwnerName, selectedName, changed, pendingName }: {
  creating: boolean; currentOwnerName: string; selectedName: string; changed: boolean; pendingName?: string;
}) {
  if (pendingName) return `已通知${pendingName}确认接手，确认前仍由${currentOwnerName || "当前负责人"}负责。若要更换接收人，请先撤回待确认申请。`;
  if (!changed) return creating ? "默认由当前登录账号负责。选择其他人后，将通过站内信请对方确认。" : "仅修改订单其他信息，不会改变负责人。";
  return `保存后将通知${selectedName || "所选人员"}确认接手；确认前仍由${currentOwnerName || (creating ? "登记人（当前登录账号）" : "当前负责人")}负责。`;
}
