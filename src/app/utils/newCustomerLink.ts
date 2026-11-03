import type { Customer, User } from "../store";
import { isNewCustomerSessionCurrent, type NewCustomerSession } from "./newCustomerEvidence.ts";

export type NewCustomerChoice = Pick<Customer, "id" | "name" | "phone" | "wechat" | "douyin">;
export type NewCustomerLinkChange = {
  order: { id: string; customerId: string } & Record<string, unknown>;
  customer?: NewCustomerChoice & Partial<Customer>;
  expectedCustomerId: string;
  expectedApprovalVersion: number;
};

/** Never replace business fields, revive a deleted order, or overwrite newer customer edits. */
export function mergeNewCustomerLink<T extends { user: User; orders: Array<{ id: string; customerId: string; newCustomerApproval?: { version?: number } | null }>; customers: Customer[] }>(
  current: T, change: NewCustomerLinkChange, session?: NewCustomerSession,
): T {
  if (!isNewCustomerSessionCurrent(session, current.user)) return current;
  const target = current.orders.find(order => order.id === change.order.id);
  const customerId = String(change.order.customerId || "");
  if (!target || !customerId || (change.customer && change.customer.id !== customerId)
    || Number(target.newCustomerApproval?.version ?? 0) > change.expectedApprovalVersion
    || (target.customerId !== change.expectedCustomerId && target.customerId !== customerId)) return current;
  const incoming = change.customer;
  // Search/detail projections are deliberately incomplete. Only canonical customer
  // records may enter the editable store, which can later be saved wholesale.
  const canonical = ["id", "name", "addedDate", "phone", "wechat", "douyin", "source", "address", "notes"]
    .every(key => typeof incoming?.[key as keyof Customer] === "string");
  return {
    ...current,
    orders: current.orders.map(order => order.id === target.id ? { ...order, customerId } : order),
    customers: canonical && !current.customers.some(customer => customer.id === customerId)
      ? [...current.customers, incoming as Customer] : current.customers,
  };
}

export function newCustomerLinkReady({ canManage, canCreate, mode, customerId, name, processing }: {
  canManage?: boolean; canCreate?: boolean; mode: "existing" | "create"; customerId?: string; name?: string; processing?: boolean;
}) {
  return canManage === true && !processing && (mode === "existing" ? Boolean(customerId?.trim()) : canCreate === true && Boolean(name?.trim()));
}
