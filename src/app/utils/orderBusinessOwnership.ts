import type { Order, Personnel, User } from "../store";

type OwnedOrder = Pick<Order, "id" | "contactPersonnelId" | "contactPerson" | "ownerAssignment">;
const text = (value: unknown) => String(value ?? "").trim();

function validAccount(user: User) {
  const account = user?.account;
  return Boolean(user && account && account.accountEnabled === true && text(account.personnelId)
    && account.username === user.username && account.accessRole === user.role);
}

/** Peer account fields are deliberately redacted. Never infer ownership from creator or transfer recipient. */
export function isMyOrder(user: User, personnel: Personnel[], order: OwnedOrder): boolean {
  if (!validAccount(user)) return false;
  const account = user!.account!;
  const ownerId = text(order.contactPersonnelId);
  if (ownerId) return ownerId === account.personnelId;
  const reference = text(order.contactPerson);
  if (!reference) return false;
  // Legacy orders lack an ID. Names must be unique across the full visible directory,
  // including resigned personnel; the server also checks hidden account aliases.
  const matches = personnel.filter(person => [text(person.name), text(person.username),
    ...(person.id === account.personnelId ? [account.username] : [])].includes(reference));
  return matches.length === 1 && matches[0].id === account.personnelId;
}

export function canManageOrderBusiness(user: User, personnel: Personnel[], order: OwnedOrder | null | undefined): boolean {
  if (!order || !validAccount(user)) return false;
  return user!.role === "admin" || isMyOrder(user, personnel, order);
}

export function orderBusinessContext(user: User, order: OwnedOrder | null | undefined, allowed: boolean, sessionKey?: string): string {
  return JSON.stringify([order?.id, order?.contactPersonnelId, order?.contactPerson,
    user?.username, user?.role, user?.visibleSiteIds, user?.account, allowed, sessionKey]);
}
