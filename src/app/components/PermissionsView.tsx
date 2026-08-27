import { useEffect, useMemo, useState } from "react";
import {
  emptyPermissions,
  hasPersonnelAccount,
  isPersonnelAccountEnabled,
  isPersonnelResigned,
  useStore,
  PermissionAction,
  PermissionSet,
  Personnel,
} from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { ACTION_LABELS, normalizePermissions, PERMISSION_MODULES } from "../utils/permissions";
import { toast } from "sonner";
import { Search } from "lucide-react";
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

function accountSearchText(person: Personnel): string {
  return [
    person.name,
    person.personnelNo,
    person.username,
    person.department,
    person.role,
    isPersonnelAccountEnabled(person) ? "启用" : "停用",
    isPersonnelResigned(person) ? "离职" : "在职",
  ].filter(Boolean).join(" ").toLowerCase();
}

export function PermissionsView({ embedded = false }: { embedded?: boolean } = {}) {
  const { state, savePersonnelPermissions } = useStore();
  const accounts = useMemo(
    () => (state.personnel ?? [])
      .filter(hasPersonnelAccount)
      .map((person, index) => ({ person, index }))
      .sort((left, right) => {
        const resignedDiff = Number(isPersonnelResigned(left.person)) - Number(isPersonnelResigned(right.person));
        if (resignedDiff) return resignedDiff;
        const enabledDiff = Number(!isPersonnelAccountEnabled(left.person)) - Number(!isPersonnelAccountEnabled(right.person));
        return enabledDiff || left.index - right.index;
      })
      .map(({ person }) => person),
    [state.personnel]
  );
  const [selectedId, setSelectedId] = useState(accounts[0]?.id ?? "");
  const [accountQuery, setAccountQuery] = useState("");
  const [draftPermissions, setDraftPermissions] = useState<PermissionSet | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = accounts.find((person) => person.id === selectedId) ?? accounts[0];
  const selectedResigned = isPersonnelResigned(selected);
  const selectedAccountEnabled = Boolean(selected && isPersonnelAccountEnabled(selected));
  const savedPermissions = useMemo(
    () => normalizePermissions(selected?.permissions),
    [selected?.permissions]
  );
  const permissions = draftPermissions ?? savedPermissions;
  const canEditPermissions = Boolean(selected && !selectedResigned && selected.accessRole !== "admin");
  const hasUnsavedChanges = Boolean(
    canEditPermissions && !permissionsEqual(permissions, savedPermissions)
  );
  const filteredAccounts = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();
    return query ? accounts.filter((person) => accountSearchText(person).includes(query)) : accounts;
  }, [accounts, accountQuery]);

  useEffect(() => {
    if (accounts.length === 0) {
      if (selectedId) setSelectedId("");
      return;
    }
    if (!accounts.some((person) => person.id === selectedId)) setSelectedId(accounts[0].id);
  }, [accounts, selectedId]);

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
    if (
      hasUnsavedChanges &&
      typeof window !== "undefined" &&
      !window.confirm("当前权限修改尚未保存，切换账号会放弃这些修改。确认切换？")
    ) return;
    setSelectedId(personId);
  };

  const updatePermission = (moduleKey: keyof PermissionSet, action: PermissionAction, checked: boolean) => {
    if (!selected) return;
    if (selectedResigned) {
      toast.info("离职人员的账号不能再授权");
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
    if (selectedResigned) {
      toast.info("离职人员的账号不能再授权");
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
    if (selectedResigned) {
      toast.info("离职人员的账号不能再授权");
      return;
    }
    if (selected.accessRole === "admin") {
      toast.info("管理员默认拥有全部权限，无需单独授权");
      return;
    }
    if (!confirmWrite("保存", `保存「${selected.name || selected.username}」的账号权限设置。`)) return;
    setSaving(true);
    const ok = await savePersonnelPermissions(selected.id, permissions);
    setSaving(false);
    if (!ok) return toast.error("保存失败，请重试");
    setDraftPermissions(copyPermissions(permissions));
    toast.success("账号权限已保存");
  };

  const applyModule = (moduleKey: keyof PermissionSet, checked: boolean) => {
    if (!canEditPermissions) return;
    setDraftPermissions((current) => {
      const next = copyPermissions(current ?? savedPermissions);
      return {
        ...next,
        [moduleKey]: { create: checked, update: checked, delete: checked },
      };
    });
  };

  const applyAction = (action: PermissionAction, checked: boolean) => {
    if (!canEditPermissions) return;
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

  const renderAccountBadges = (person: Personnel) => (
    <span className="flex shrink-0 flex-wrap items-center justify-end gap-1">
      <Badge variant={person.accessRole === "admin" ? "default" : "secondary"} className="text-xs">
        {person.accessRole === "admin" ? "管理员" : "普通账号"}
      </Badge>
      {!isPersonnelAccountEnabled(person) && (
        <Badge variant="outline" className="border-amber-300 text-xs text-amber-700">已停用</Badge>
      )}
      {isPersonnelResigned(person) && (
        <Badge variant="outline" className="border-slate-300 text-xs text-slate-500">离职</Badge>
      )}
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      {!embedded && (
        <div>
          <h2>账号与权限</h2>
          <p className="text-sm text-muted-foreground">仅对已开通系统账号的人员配置可见区域和业务操作权限</p>
        </div>
      )}

      {accounts.length === 0 ? (
        <Card className="items-center p-8 text-center">
          <div>
            <h3>暂无系统账号</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              请先到“人员档案”中选择人员并开通账号，再返回这里配置权限。
            </p>
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <Card className="hidden gap-3 p-3 lg:flex">
            <div className="relative">
              <Label htmlFor="permission-account-search" className="sr-only">搜索系统账号</Label>
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="permission-account-search"
                value={accountQuery}
                onChange={(event) => setAccountQuery(event.target.value)}
                className="pl-9"
                placeholder="搜索姓名、工号或账号"
              />
            </div>
            <div className="grid gap-1">
              {filteredAccounts.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">没有符合条件的账号</div>
              ) : filteredAccounts.map((person) => (
                <button
                  key={person.id}
                  type="button"
                  aria-pressed={selected?.id === person.id}
                  onClick={() => selectAccount(person.id)}
                  className={`w-full rounded-md px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${
                    selected?.id === person.id ? "bg-sky-100 text-sky-700" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{person.name}</span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {person.personnelNo ? `${person.personnelNo} · ` : ""}{person.username}
                      </span>
                    </span>
                    {renderAccountBadges(person)}
                  </div>
                </button>
              ))}
            </div>
          </Card>

          <div className="grid gap-3 lg:hidden">
            <div className="relative">
              <Label htmlFor="permission-mobile-account-search" className="sr-only">搜索系统账号</Label>
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                id="permission-mobile-account-search"
                value={accountQuery}
                onChange={(event) => setAccountQuery(event.target.value)}
                className="pl-9"
                placeholder="搜索姓名、工号或账号"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="permission-mobile-account-select">选择账号</Label>
              <Select value={selected?.id ?? ""} onValueChange={selectAccount}>
                <SelectTrigger id="permission-mobile-account-select" className="min-h-11">
                  <SelectValue placeholder="选择需要配置的账号" />
                </SelectTrigger>
                <SelectContent>
                  {filteredAccounts.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.name}{person.personnelNo ? `（${person.personnelNo}）` : ""} · {person.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {filteredAccounts.length === 0 && (
                <p className="text-xs text-muted-foreground">没有符合搜索条件的账号，请清空搜索词。</p>
              )}
            </div>
          </div>

          <Card className="min-w-0 gap-4 p-4 sm:p-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3>{selected?.name ?? "未选择账号"}</h3>
                  {selected && renderAccountBadges(selected)}
                  {hasUnsavedChanges && (
                    <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">未保存</Badge>
                  )}
                </div>
                {selected && (
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {selected.personnelNo ? `工号 ${selected.personnelNo} · ` : ""}登录账号 {selected.username}
                  </p>
                )}
                <p className="mt-2 text-sm text-muted-foreground">
                  {selectedResigned
                    ? "该人员已离职，账号和权限均不再生效。"
                    : selected?.accessRole === "admin"
                    ? "管理员默认拥有全部权限，权限开关不可修改。"
                    : !selectedAccountEnabled
                    ? `账号当前已停用，所配权限暂不生效；当前已选 ${permissionCount}/${totalPermissionCount} 项。`
                    : `先勾选需要的权限，再一次保存。当前已选 ${permissionCount}/${totalPermissionCount} 项。`}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => applyAll(true)} disabled={!canEditPermissions}>
                  全部授权
                </Button>
                <Button size="sm" variant="outline" onClick={() => applyAll(false)} disabled={!canEditPermissions}>
                  清空权限
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="hidden md:inline-flex"
                  onClick={resetDraft}
                  disabled={!hasUnsavedChanges || saving}
                >
                  放弃修改
                </Button>
                <Button
                  size="sm"
                  className="hidden md:inline-flex"
                  onClick={saveDraft}
                  disabled={!hasUnsavedChanges || saving}
                >
                  {saving ? "保存中..." : "保存权限"}
                </Button>
              </div>
            </div>

            <div className="hidden overflow-auto rounded-lg border md:block">
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
                              className="h-8 px-2 text-xs"
                              aria-label={`全选所有模块的${ACTION_LABELS[action]}权限`}
                              disabled={!canEditPermissions}
                              onClick={() => applyAction(action, true)}
                            >
                              全选
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-8 px-2 text-xs"
                              aria-label={`清空所有模块的${ACTION_LABELS[action]}权限`}
                              disabled={!canEditPermissions}
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
                              className="h-8 px-2 text-xs"
                              disabled={!canEditPermissions}
                              onClick={() => applyModule(mod.key, !rowChecked)}
                            >
                              {rowChecked ? "清空本行" : "全选本行"}
                            </Button>
                          </div>
                        </td>
                        {ACTIONS.map((action) => {
                          const checkboxId = `permission-${mod.key}-${action}`;
                          return (
                            <td key={action} className="px-4 py-1 text-center">
                              <label
                                htmlFor={checkboxId}
                                className={`inline-flex min-h-11 min-w-11 items-center justify-center ${
                                  canEditPermissions ? "cursor-pointer" : "cursor-not-allowed"
                                }`}
                              >
                                <Checkbox
                                  id={checkboxId}
                                  className="min-h-4!"
                                  aria-label={`${mod.label}：${ACTION_LABELS[action]}`}
                                  checked={Boolean(selected && (selected.accessRole === "admin" || permissions[mod.key][action]))}
                                  disabled={!canEditPermissions}
                                  onCheckedChange={(value) => updatePermission(mod.key, action, value === true)}
                                />
                              </label>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 md:hidden">
              {PERMISSION_MODULES.map((mod) => {
                const rowChecked = ACTIONS.every((action) => permissions[mod.key][action]);
                return (
                  <section key={mod.key} className="rounded-xl border bg-background p-3" aria-labelledby={`permission-card-${mod.key}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h4 id={`permission-card-${mod.key}`} className="text-sm font-semibold">{mod.label}</h4>
                        <p className="text-xs text-muted-foreground">{mod.group}</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canEditPermissions}
                        onClick={() => applyModule(mod.key, !rowChecked)}
                      >
                        {rowChecked ? "清空" : "全选"}
                      </Button>
                    </div>
                    <div className="mt-3 grid gap-2">
                      {ACTIONS.map((action) => {
                        const checkboxId = `permission-mobile-${mod.key}-${action}`;
                        return (
                          <label
                            key={action}
                            htmlFor={checkboxId}
                            className={`flex min-h-11 items-center justify-between gap-4 rounded-lg border px-3 py-2 text-sm ${
                              canEditPermissions ? "cursor-pointer" : "cursor-not-allowed opacity-70"
                            }`}
                          >
                            <span>{ACTION_LABELS[action]}</span>
                            <Checkbox
                              id={checkboxId}
                              className="min-h-4!"
                              aria-label={`${mod.label}：${ACTION_LABELS[action]}`}
                              checked={Boolean(selected && (selected.accessRole === "admin" || permissions[mod.key][action]))}
                              disabled={!canEditPermissions}
                              onCheckedChange={(value) => updatePermission(mod.key, action, value === true)}
                            />
                          </label>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>

            <div className="sticky bottom-0 z-10 -mx-4 -mb-4 flex gap-2 border-t bg-card/95 p-3 backdrop-blur md:hidden">
              <Button
                variant="outline"
                className="flex-1"
                onClick={resetDraft}
                disabled={!hasUnsavedChanges || saving}
              >
                放弃修改
              </Button>
              <Button
                className="flex-1"
                onClick={saveDraft}
                disabled={!hasUnsavedChanges || saving}
              >
                {saving ? "保存中..." : "保存权限"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
