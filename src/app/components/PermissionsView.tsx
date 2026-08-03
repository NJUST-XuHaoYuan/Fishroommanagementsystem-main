import { useEffect, useMemo, useState } from "react";
import { emptyPermissions, isPersonnelResigned, useStore, PermissionAction, PermissionSet } from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { ACTION_LABELS, normalizePermissions, PERMISSION_MODULES } from "../utils/permissions";
import { toast } from "sonner";
import { confirmWrite } from "../utils/writeConfirm";

const ACTIONS: PermissionAction[] = ["create", "update", "delete"];

function copyPermissions(permissions: PermissionSet): PermissionSet {
  const next = emptyPermissions();
  for (const mod of PERMISSION_MODULES) {
    next[mod.key] = { ...permissions[mod.key] };
  }
  return next;
}

function permissionsEqual(a: PermissionSet, b: PermissionSet): boolean {
  return PERMISSION_MODULES.every((mod) =>
    ACTIONS.every((action) => a[mod.key][action] === b[mod.key][action])
  );
}

export function PermissionsView({ embedded = false }: { embedded?: boolean } = {}) {
  const { state, savePersonnelPermissions } = useStore();
  const accounts = useMemo(
    () => (state.personnel ?? [])
      .map((person, index) => ({ person, index }))
      .sort((a, b) => {
        const resignedDiff = Number(isPersonnelResigned(a.person)) - Number(isPersonnelResigned(b.person));
        return resignedDiff || a.index - b.index;
      })
      .map(({ person }) => person),
    [state.personnel]
  );
  const [selectedId, setSelectedId] = useState(accounts[0]?.id ?? "");
  const [draftPermissions, setDraftPermissions] = useState<PermissionSet | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = accounts.find((person) => person.id === selectedId) ?? accounts[0];
  const selectedResigned = isPersonnelResigned(selected);
  const savedPermissions = useMemo(
    () => selectedResigned ? emptyPermissions() : normalizePermissions(selected?.permissions),
    [selected?.permissions, selectedResigned]
  );
  const permissions = draftPermissions ?? savedPermissions;
  const hasUnsavedChanges = !!selected && !selectedResigned && selected.accessRole !== "admin" && !permissionsEqual(permissions, savedPermissions);

  useEffect(() => {
    setDraftPermissions(copyPermissions(savedPermissions));
  }, [savedPermissions, selected?.id]);

  if (state.user?.role !== "admin") {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        当前账户没有人员与权限管理权限。
      </div>
    );
  }

  const selectAccount = (personId: string) => {
    if (hasUnsavedChanges && typeof window !== "undefined" && !window.confirm("当前权限修改尚未保存，切换人员会放弃这些修改。确认切换？")) return;
    setSelectedId(personId);
  };

  const updatePermission = (moduleKey: keyof PermissionSet, action: PermissionAction, checked: boolean) => {
    if (!selected) return;
    if (isPersonnelResigned(selected)) {
      toast.info("离职人员权限已清空，不能再授权");
      return;
    }
    if (selected.accessRole === "admin") {
      toast.info("管理员默认拥有全部权限，无需单独授权");
      return;
    }
    setDraftPermissions((current) => {
      const next = copyPermissions(current ?? savedPermissions);
      return {
        ...next,
        [moduleKey]: {
          ...next[moduleKey],
          [action]: checked,
        },
      };
    });
  };

  const applyAll = (checked: boolean) => {
    if (!selected) return;
    if (isPersonnelResigned(selected)) {
      toast.info("离职人员权限已清空，不能再授权");
      return;
    }
    if (selected.accessRole === "admin") {
      toast.info("管理员默认拥有全部权限，无需单独授权");
      return;
    }
    const next = emptyPermissions();
    for (const mod of PERMISSION_MODULES) {
      next[mod.key] = { create: checked, update: checked, delete: checked };
    }
    setDraftPermissions(next);
  };

  const resetDraft = () => {
    setDraftPermissions(copyPermissions(savedPermissions));
  };

  const saveDraft = async () => {
    if (!selected || !hasUnsavedChanges || saving) return;
    if (isPersonnelResigned(selected)) {
      toast.info("离职人员权限已清空，不能再授权");
      return;
    }
    if (selected.accessRole === "admin") {
      toast.info("管理员默认拥有全部权限，无需单独授权");
      return;
    }
    if (!confirmWrite("保存", `保存「${selected.name || selected.username}」的权限设置。`)) return;
    setSaving(true);
    const ok = await savePersonnelPermissions(selected.id, permissions);
    setSaving(false);
    if (!ok) return toast.error("保存失败，请重试");
    setDraftPermissions(copyPermissions(permissions));
    toast.success("权限已保存");
  };

  const applyModule = (moduleKey: keyof PermissionSet, checked: boolean) => {
    if (!selected || selectedResigned || selected.accessRole === "admin") return;
    setDraftPermissions((current) => {
      const next = copyPermissions(current ?? savedPermissions);
      return {
        ...next,
        [moduleKey]: { create: checked, update: checked, delete: checked },
      };
    });
  };

  const applyAction = (action: PermissionAction, checked: boolean) => {
    if (!selected || selectedResigned || selected.accessRole === "admin") return;
    setDraftPermissions((current) => {
      const next = copyPermissions(current ?? savedPermissions);
      for (const mod of PERMISSION_MODULES) {
        next[mod.key] = {
          ...next[mod.key],
          [action]: checked,
        };
      }
      return next;
    });
  };

  const permissionCount = PERMISSION_MODULES.reduce(
    (count, mod) => count + ACTIONS.filter((action) => permissions[mod.key][action]).length,
    0
  );
  const totalPermissionCount = PERMISSION_MODULES.length * ACTIONS.length;

  return (
    <div className="flex flex-col gap-4">
      {!embedded && (
        <div>
          <h2>权限设置</h2>
          <p className="text-sm text-muted-foreground">为每个账户配置各业务模块的添加、修改和删除权限</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        <Card className="gap-2 p-3">
          {accounts.map((person) => (
            <button
              key={person.id}
              type="button"
              onClick={() => selectAccount(person.id)}
              className={`rounded-md px-3 py-2 text-left text-sm hover:bg-muted ${
                selected?.id === person.id ? "bg-sky-100 text-sky-700" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">{person.name}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Badge variant={person.accessRole === "admin" ? "default" : "secondary"} className="text-xs">
                    {person.accessRole === "admin" ? "管理员" : "店员"}
                  </Badge>
                  {isPersonnelResigned(person) && (
                    <Badge variant="outline" className="border-slate-300 text-xs text-slate-500">离职</Badge>
                  )}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{person.username}</div>
            </button>
          ))}
        </Card>

        <Card className="gap-4 p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3>{selected?.name ?? "未选择账户"}</h3>
                {hasUnsavedChanges && (
                  <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">未保存</Badge>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {selectedResigned
                  ? "离职人员权限已清空，不能再授权。"
                  : selected?.accessRole === "admin"
                  ? "管理员默认拥有全部权限，权限开关不可修改。"
                  : `先勾选需要的权限，再一次保存。当前已选 ${permissionCount}/${totalPermissionCount} 项。`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => applyAll(true)} disabled={!selected || selectedResigned || selected.accessRole === "admin"}>
                全部授权
              </Button>
              <Button size="sm" variant="outline" onClick={() => applyAll(false)} disabled={!selected || selectedResigned || selected.accessRole === "admin"}>
                清空权限
              </Button>
              <Button size="sm" variant="outline" onClick={resetDraft} disabled={!hasUnsavedChanges || saving}>
                放弃修改
              </Button>
              <Button size="sm" onClick={saveDraft} disabled={!hasUnsavedChanges || saving}>
                {saving ? "保存中..." : "保存权限"}
              </Button>
            </div>
          </div>

          <div className="overflow-auto rounded-lg border">
            <table className="w-full min-w-[620px]">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left text-sm">模块</th>
                  {ACTIONS.map((action) => (
                    <th key={action} className="px-4 py-3 text-center text-sm">
                      <div className="flex flex-col items-center gap-2">
                        <span>{ACTION_LABELS[action]}</span>
                        <div className="flex gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs"
                            disabled={!selected || selectedResigned || selected.accessRole === "admin"}
                            onClick={() => applyAction(action, true)}
                          >
                            全选
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs"
                            disabled={!selected || selectedResigned || selected.accessRole === "admin"}
                            onClick={() => applyAction(action, false)}
                          >
                            清空
                          </Button>
                        </div>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_MODULES.map((mod) => {
                  const rowChecked = ACTIONS.every((action) => permissions[mod.key][action]);
                  return (
                    <tr key={mod.key} className="border-t">
                      <td className="px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="font-medium">{mod.label}</div>
                            <div className="text-xs text-muted-foreground">{mod.group}</div>
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            disabled={!selected || selectedResigned || selected.accessRole === "admin"}
                            onClick={() => applyModule(mod.key, !rowChecked)}
                          >
                            {rowChecked ? "清空本行" : "全选本行"}
                          </Button>
                        </div>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
