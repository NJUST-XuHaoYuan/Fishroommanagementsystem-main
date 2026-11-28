import { isPersonnelAccountEnabled } from "./personnel-rules.mjs";

const text = value => String(value ?? "").trim();

// Resolve only the persisted effective owner. A pending transfer recipient, the
// creator, a display name supplied by a request, and an invalid owner ID are
// never alternative authority. Legacy names are accepted only when unique.
export function resolveOrderBusinessOwner(state = {}, order = {}) {
  const personnel = Array.isArray(state.personnel) ? state.personnel : [];
  const id = text(order.contactPersonnelId);
  const reference = text(order.contactPerson);
  if (!id && !reference) return null;
  const matches = personnel.filter(person => id ? text(person?.id) === id
    : [text(person?.username), text(person?.name)].includes(reference));
  if (matches.length !== 1) return null;
  const owner = matches[0];
  return isPersonnelAccountEnabled(owner) && text(owner.id) && text(owner.username) ? owner : null;
}

// Callers must also enforce the action's module/site permissions and refresh
// the authenticated account under the same lock as the order mutation.
export function isOrderBusinessMutationOwner(state = {}, order = {}, account = {}) {
  if (!isPersonnelAccountEnabled(account) || !text(account.id) || !text(account.username)) return false;
  if (account.accessRole === "admin") return true;
  const owner = resolveOrderBusinessOwner(state, order);
  return Boolean(owner && text(owner.id) === text(account.id) && text(owner.username) === text(account.username));
}

export function assertOrderBusinessMutationOwner(state, order, account) {
  if (!isOrderBusinessMutationOwner(state, order, account)) {
    throw Object.assign(new Error("只有当前订单负责人或管理员可以修改此订单"), {
      statusCode: 403, code: "ORDER_OWNER_REQUIRED",
    });
  }
}
