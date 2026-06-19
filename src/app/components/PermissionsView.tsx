import { useMemo, useState } from "react";
import { emptyPermissions, isPersonnelResigned, useStore, PermissionAction, PermissionSet } from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { ACTION_LABELS, normalizePermissions, PERMISSION_MODULES } from "../utils/permissions";
import { toast } from "sonner";
import { confirmWrite } from "../utils/writeConfirm";

const ACTIONS: PermissionAction[] = ["create", "update", "delete"];

export function PermissionsView() {
  const { state, savePersonnelPermissions } = useStore();
  const accounts = state.personnel ?? [];
  const [selectedId, setSelectedId] = useState(accounts[0]?.id ?? "");

  const selected = accounts.find((person) => person.id === selectedId) ?? accounts[0];
  const selectedResigned = isPersonnelResigned(selected);
  const permissions = useMemo(
    () => selectedResigned ? emptyPermissions() : normalizePermissions(selected?.permissions),
    [selected?.permissions, selectedResigned]
  );

  if (state.user?.role !== "admin") {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        当前账户没有权限管理权限。
      </div>
    );
  }

  const updatePermission = async (moduleKey: keyof PermissionSet, action: PermissionAction, checked: boolean) => {
    if (!selected) return;
    if (isPersonnelResigned(selected)) {
      toast.info("离职人员权限已清空，不能再授权");
      return;
    }
    if (selected.accessRole === "admin") {
      toast.info("管理员默认拥有全部权限，无需单独授权");
      return;
    }
    if (!confirmWrite("修改", `将${checked ? "授予" : "取消"}「${selected.name || selected.username}」的权限。`)) return;
    const next = normalizePermissions(selected.permissions);
    const ok = await savePersonnelPermissions(selected.id, {
      ...next,
      [moduleKey]: {
        ...next[moduleKey],
        [action]: checked,
      },
    });
    if (!ok) return toast.error("保存失败，请重试");
    toast.success("权限已保存");
  };

  const applyAll = async (checked: boolean) => {
    if (!selected) return;
    if (isPersonnelResigned(selected)) {
      toast.info("离职人员权限已清空，不能再授权");
      return;
    }
    if (selected.accessRole === "admin") {
      toast.info("管理员默认拥有全部权限，无需单独授权");
      return;
    }
    const next = normalizePermissions();
    for (const mod of PERMISSION_MODULES) {
      next[mod.key] = { create: checked, update: checked, delete: checked };
    }
    if (!confirmWrite("修改", `将${checked ? "授予" : "清空"}「${selected.name || selected.username}」的全部权限。`)) return;
    const ok = await savePersonnelPermissions(selected.id, next);
    if (!ok) return toast.error("保存失败，请重试");
    toast.success(checked ? "已授予全部权限" : "已清空全部权限");
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>权限管理</h2>
        <p className="text-sm text-muted-foreground">为每个账户配置各业务模块的添加、修改和删除权限</p>
      </div>

      <div className="grid grid-cols-[260px_1fr] gap-4">
        <Card className="p-3 gap-2">
          {accounts.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => setSelectedId(person.id)}
              className={`rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${
                selected?.id === person.id ? "bg-sky-100 text-sky-700" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{person.name}</span>
	                <Badge variant={person.accessRole === "admin" ? "default" : "secondary"} className="text-xs">
	                  {person.accessRole === "admin" ? "管理员" : "店员"}
	                </Badge>
	                {isPersonnelResigned(person) && (
	                  <Badge variant="outline" className="border-slate-300 text-xs text-slate-500">离职</Badge>
	                )}
	              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{person.username}</div>
            </button>
          ))}
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3>{selected?.name ?? "未选择账户"}</h3>
              <p className="text-sm text-muted-foreground">
	                {selectedResigned
	                  ? "离职人员权限已清空，不能再授权。"
	                  : selected?.accessRole === "admin"
	                  ? "管理员默认拥有全部权限，权限开关不可修改。"
	                  : "勾选后立即生效。未勾选的操作会在对应页面隐藏或拦截。"}
              </p>
            </div>
            <div className="flex gap-2">
	              <Button size="sm" variant="outline" onClick={() => applyAll(true)} disabled={selectedResigned || selected?.accessRole === "admin"}>
	                全部授权
	              </Button>
	              <Button size="sm" variant="outline" onClick={() => applyAll(false)} disabled={selectedResigned || selected?.accessRole === "admin"}>
                清空权限
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm">模块</th>
                  {ACTIONS.map((action) => (
                    <th key={action} className="px-4 py-3 text-center text-sm">{ACTION_LABELS[action]}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_MODULES.map((mod) => (
                  <tr key={mod.key} className="border-t">
                    <td className="px-4 py-3">
                      <div className="font-medium">{mod.label}</div>
                      <div className="text-xs text-muted-foreground">{mod.group}</div>
                    </td>
                    {ACTIONS.map((action) => (
                      <td key={action} className="px-4 py-3 text-center">
                        <input
                          type="checkbox"
                          className="size-4 accent-sky-600"
	                          checked={!selectedResigned && (selected?.accessRole === "admin" || permissions[mod.key][action])}
	                          disabled={!selected || selectedResigned || selected.accessRole === "admin"}
                          onChange={(e) => updatePermission(mod.key, action, e.target.checked)}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
