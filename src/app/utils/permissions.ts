import { toast } from "sonner";
import { emptyPermissions, fullPermissions, isPersonnelResigned, PermissionAction, PermissionModule, PermissionSet } from "../store";
import { useStore } from "../store";

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
  { key: "accounts", label: "人员与权限", group: "后台管理" },
];

export const ACTION_LABELS: Record<PermissionAction, string> = {
  create: "添加记录",
  update: "修改记录",
  delete: "删除记录",
};

export function normalizePermissions(permissions?: Partial<PermissionSet>): PermissionSet {
  const normalized = emptyPermissions();
  const full = fullPermissions();
  for (const mod of PERMISSION_MODULES) {
    normalized[mod.key] = {
      create: permissions?.[mod.key]?.create ?? (mod.key === "finance" ? false : full[mod.key].create),
      update: permissions?.[mod.key]?.update ?? (mod.key === "finance" ? false : full[mod.key].update),
      delete: permissions?.[mod.key]?.delete ?? (mod.key === "finance" ? false : full[mod.key].delete),
    };
  }
  return normalized;
}

export function usePermission(module: PermissionModule) {
  const { state } = useStore();
  const user = state.user;
  const account = user
    ? (state.personnel ?? []).find((p) => p.username === user.username)
    : undefined;
  const resigned = isPersonnelResigned(account);
  const isAdmin = !resigned && (user?.role === "admin" || account?.accessRole === "admin");
  const permissions = resigned ? emptyPermissions() : normalizePermissions(account?.permissions);

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
