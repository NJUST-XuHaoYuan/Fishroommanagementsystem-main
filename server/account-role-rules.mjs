/** Security roles are explicit; a free-text job title never grants privileges. */
export const ACCOUNT_ROLES = ["admin", "staff", "finance"];
export function isAccountRole(value) { return ACCOUNT_ROLES.includes(value); }
export function normalizeAccountRole(value) { return isAccountRole(value) ? value : "staff"; }

/** Finance records remain editable only by finance staff or administrators. */
export function permissionsForAccountRole(role, permissions = {}) {
  const normalizedRole = normalizeAccountRole(role);
  if (normalizedRole === "admin") return permissions;
  return {
    ...permissions,
    accounts: { create: false, update: false, delete: false },
    finance: normalizedRole === "finance"
      ? { create: true, update: true, delete: permissions?.finance?.delete === true }
      : { create: false, update: false, delete: false },
  };
}
