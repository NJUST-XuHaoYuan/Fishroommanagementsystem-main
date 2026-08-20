import { toast } from "sonner";
import { emptyPermissions, fullPermissions, useStore } from "../store";
import type { PermissionAction, PermissionModule, PermissionSet, User } from "../store";

export const PERMISSION_MODULES: { key: PermissionModule; label: string; group: string }[] = [
  { key: "species", label: "物种管理", group: "品名管理" },
  { key: "products", label: "商品管理", group: "品名管理" },
  { key: "tankGroups", label: "缸组管理", group: "库存管理" },
  { key: "batches", label: "采购批次", group: "库存管理" },
  { key: "stockIn", label: "库存明细", group: "库存管理" },
  { key: "daily", label: "日常管理", group: "维护管理" },
  { key: "lossRecords", label: "损耗记录", group: "维护管理" },
  { key: "customers", label: "客户管理", group: "销售管理" },
  { key: "orders", label: "订单管理", group: "销售管理" },
  { key: "finance", label: "财务管理", group: "财务管理" },
];

export const ACTION_LABELS: Record<PermissionAction, string> = {
  create: "添加记录",
  update: "修改记录",
  delete: "删除记录",
};

const ALL_PERMISSION_MODULES: PermissionModule[] = [
  ...PERMISSION_MODULES.map((module) => module.key),
  "accounts",
];

export function normalizePermissions(permissions?: Partial<PermissionSet>): PermissionSet {
  const normalized = emptyPermissions();
  for (const module of ALL_PERMISSION_MODULES) {
    normalized[module] = {
      create: permissions?.[module]?.create === true,
      update: permissions?.[module]?.update === true,
      delete: permissions?.[module]?.delete === true,
    };
  }
  return normalized;
}

/**
 * Derive frontend capabilities exclusively from the authenticated account summary.
 * Staff permissions fail closed when the summary is absent, disabled, or does not
 * match the signed-in identity. Administrators retain their existing global bypass.
 */
export function permissionStateForUser(user: User): {
  isAdmin: boolean;
  permissions: PermissionSet;
} {
  if (!user) return { isAdmin: false, permissions: emptyPermissions() };
  if (user.role === "admin") return { isAdmin: true, permissions: fullPermissions() };

  const account = user.account;
  const enabled = account?.accountEnabled === true &&
    account.username === user.username &&
    account.accessRole === user.role;
  const permissions = enabled ? normalizePermissions(account.permissions) : emptyPermissions();
  // Personnel/account administration is server-side admin-only even if legacy
  // records happen to contain an accounts permission bit for a staff account.
  permissions.accounts = emptyPermissions().accounts;
  return {
    isAdmin: false,
    permissions,
  };
}

/** Registering a maintenance loss mutates both daily stock and loss records. */
export function canRegisterMaintenanceLoss(
  canDeleteDaily: boolean,
  canCreateLossRecord: boolean,
): boolean {
  return canDeleteDaily && canCreateLossRecord;
}

export function requireMaintenanceLossPermissions(
  requireDailyDelete: () => boolean,
  requireLossRecordCreate: () => boolean,
): boolean {
  return requireDailyDelete() && requireLossRecordCreate();
}

export function usePermission(module: PermissionModule) {
  const { state } = useStore();
  const { isAdmin, permissions } = permissionStateForUser(state.user);

  const can = (action: PermissionAction) => isAdmin || permissions[module][action];
  const requirePermission = (action: PermissionAction) => {
    if (can(action)) return true;
    const label = PERMISSION_MODULES.find((m) => m.key === module)?.label ?? "当前模块";
    toast.error(`无权限：${label} / ${ACTION_LABELS[action]}`);
    return false;
  };

  return {
    isAdmin,
    canCreate: can("create"),
    canUpdate: can("update"),
    canDelete: can("delete"),
    can,
    requirePermission,
  };
}
