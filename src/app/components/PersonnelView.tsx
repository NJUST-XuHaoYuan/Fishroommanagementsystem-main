import { useRef, useState } from "react";
import {
  emptyPermissions,
  fullPermissions,
  hasPersonnelAccount,
  isPersonnelAccountEnabled,
  isPersonnelResigned,
  useStore,
  Personnel,
  Role,
} from "../store";
import { DataTable } from "./common";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import { Switch } from "./ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";
import { confirmWrite } from "../utils/writeConfirm";
import { getSites, normalizeVisibleSiteIds } from "../utils/sites";
import { authJsonHeaders } from "../utils/authSession";

const ACCESS_ROLE_LABEL: Record<Role, string> = {
  admin: "管理员",
  staff: "普通账号",
};

type EmploymentFilter = "all" | "active" | "resigned";
type AccountFilter = "all" | "enabled" | "disabled" | "none";
type PersonnelRow = Personnel & { searchText: string };

function normalizedText(value: unknown): string {
  return String(value ?? "").trim();
}

function MaskedPersonnelInput({
  id,
  value,
  visible,
  onChange,
  onToggle,
  toggleLabel,
  placeholder,
  inputMode,
  disabled = false,
}: {
  id: string;
  value: string;
  visible: boolean;
  onChange: (value: string) => void;
  onToggle: () => void;
  toggleLabel: string;
  placeholder?: string;
  inputMode?: "text" | "numeric";
  disabled?: boolean;
}) {
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        className="h-11 pr-12"
        disabled={disabled}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-0 top-0 size-11 rounded-l-none"
        aria-label={toggleLabel}
        aria-pressed={visible}
        title={toggleLabel}
        onClick={onToggle}
        disabled={disabled}
      >
        {visible
          ? <EyeOff className="size-4" aria-hidden="true" />
          : <Eye className="size-4" aria-hidden="true" />}
      </Button>
    </div>
  );
}

export function PersonnelView({ embedded = false }: { embedded?: boolean } = {}) {
  const {
    state,
    savePersonnelAccount,
    resignPersonnelAccount,
    deletePersonnelAccount,
    changePersonnelPassword,
  } = useStore();
  const [editing, setEditing] = useState<Personnel | null>(null);
  const [accountRequested, setAccountRequested] = useState(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sensitiveLoading, setSensitiveLoading] = useState(false);
  const sensitiveRequestSequence = useRef(0);
  const [del, setDel] = useState<Personnel | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [resign, setResign] = useState<Personnel | null>(null);
  const [resigning, setResigning] = useState(false);
  const [showIdCardNo, setShowIdCardNo] = useState(false);
  const [showBankAccountNo, setShowBankAccountNo] = useState(false);
  const [employmentFilter, setEmploymentFilter] = useState<EmploymentFilter>("all");
  const [accountFilter, setAccountFilter] = useState<AccountFilter>("all");
  const sites = getSites(state);
  const allSiteIds = sites.map((site) => site.id);

  const nextPersonnelNo = () => {
    const used = new Set((state.personnel ?? [])
      .map((person) => normalizedText(person.personnelNo)).filter(Boolean));
    let sequence = 1;
    while (used.has(`RY-${String(sequence).padStart(4, "0")}`)) sequence += 1;
    return `RY-${String(sequence).padStart(4, "0")}`;
  };

  if (state.user?.role !== "admin") {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        当前账户没有人员与权限管理权限。
      </div>
    );
  }

  const empty = (): Personnel => ({
    id: "",
    personnelNo: nextPersonnelNo(),
    name: "",
    gender: "",
    birthDate: "",
    department: "",
    hireDate: "",
    siteIds: [],
    phone: "",
    email: "",
    wechat: "",
    address: "",
    emergencyContact: "",
    emergencyPhone: "",
    idCardNo: "",
    bankAccountName: "",
    bankAccountNo: "",
    bankName: "",
    username: "",
    password: "",
    accountEnabled: false,
    accessRole: "staff",
    visibleSiteIds: allSiteIds,
    permissions: emptyPermissions(),
    role: "",
    notes: "",
    employmentStatus: "active",
  });

  const orderCount = (name: string) =>
    (state.orders ?? []).filter((order) => order.contactPerson === name).length;

  const adminCount = (excludeId?: string) =>
    (state.personnel ?? []).filter((person) =>
      person.id !== excludeId &&
      hasPersonnelAccount(person) &&
      isPersonnelAccountEnabled(person) &&
      person.accessRole === "admin" &&
      !isPersonnelResigned(person)
    ).length;

  const selectedVisibleSiteIds = (person: Pick<Personnel, "accessRole" | "visibleSiteIds">) => {
    if (person.accessRole === "admin") return allSiteIds;
    return normalizeVisibleSiteIds(person.visibleSiteIds, sites);
  };

  const selectedWorkSiteIds = (person: Pick<Personnel, "siteIds">) =>
    normalizeVisibleSiteIds(person.siteIds, sites);

  const visibleSiteNames = (person: Pick<Personnel, "accessRole" | "visibleSiteIds">) => {
    if (person.accessRole === "admin") return "全部区域";
    const ids = new Set(selectedVisibleSiteIds(person));
    const names = sites.filter((site) => ids.has(site.id)).map((site) => site.name);
    return names.length > 0 ? names.join("、") : "未设置";
  };

  const workSiteNames = (person: Pick<Personnel, "siteIds">) => {
    const ids = new Set(selectedWorkSiteIds(person));
    const names = sites.filter((site) => ids.has(site.id)).map((site) => site.name);
    return names.length > 0 ? names.join("、") : "未设置";
  };

  const closeEditor = () => {
    sensitiveRequestSequence.current += 1;
    setOpen(false);
    setEditing(null);
    setSensitiveLoading(false);
    setShowIdCardNo(false);
    setShowBankAccountNo(false);
  };

  const openCreate = () => {
    sensitiveRequestSequence.current += 1;
    setEditing(empty());
    setAccountRequested(false);
    setShowIdCardNo(false);
    setShowBankAccountNo(false);
    setSensitiveLoading(false);
    setOpen(true);
  };

  const editPerson = async (person: Personnel) => {
    const requestSequence = sensitiveRequestSequence.current + 1;
    sensitiveRequestSequence.current = requestSequence;
    setEditing({
      ...person,
      personnelNo: person.personnelNo ?? "",
      gender: person.gender ?? "",
      birthDate: person.birthDate ?? "",
      department: person.department ?? "",
      hireDate: person.hireDate ?? "",
      siteIds: selectedWorkSiteIds(person),
      phone: person.phone ?? "",
      email: person.email ?? "",
      wechat: person.wechat ?? "",
      address: person.address ?? "",
      emergencyContact: person.emergencyContact ?? "",
      emergencyPhone: person.emergencyPhone ?? "",
      idCardNo: "",
      bankAccountName: "",
      bankAccountNo: "",
      bankName: "",
      sensitiveRevision: "",
      username: person.username ?? "",
      password: "",
      accountEnabled: hasPersonnelAccount(person) ? isPersonnelAccountEnabled(person) : false,
      visibleSiteIds: selectedVisibleSiteIds(person),
      role: person.role ?? "",
      notes: person.notes ?? "",
    });
    setAccountRequested(hasPersonnelAccount(person));
    setShowIdCardNo(false);
    setShowBankAccountNo(false);
    setSensitiveLoading(true);
    setOpen(true);
    try {
      const response = await fetch("/api/personnel/sensitive", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({ personnelId: person.id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (sensitiveRequestSequence.current !== requestSequence) return;
      const sensitive = result.sensitive && typeof result.sensitive === "object" ? result.sensitive : {};
      const sensitiveRevision = normalizedText(result.sensitiveRevision);
      if (!sensitiveRevision) throw new Error("敏感档案版本缺失，请重新打开人员档案");
      setEditing((current) => current?.id === person.id ? {
        ...current,
        idCardNo: normalizedText(sensitive.idCardNo),
        bankAccountName: normalizedText(sensitive.bankAccountName),
        bankAccountNo: normalizedText(sensitive.bankAccountNo),
        bankName: normalizedText(sensitive.bankName),
        sensitiveRevision,
      } : current);
    } catch (error) {
      if (sensitiveRequestSequence.current !== requestSequence) return;
      closeEditor();
      toast.error(error instanceof Error ? error.message : "读取证件与工资账户信息失败");
    } finally {
      if (sensitiveRequestSequence.current === requestSequence) setSensitiveLoading(false);
    }
  };

  const toggleWorkSite = (siteId: string, checked: boolean) => {
    if (!editing) return;
    const current = selectedWorkSiteIds(editing);
    const next = checked
      ? [...current, siteId].filter((id, index, all) => all.indexOf(id) === index)
      : current.filter((id) => id !== siteId);
    setEditing({ ...editing, siteIds: next });
  };

  const toggleVisibleSite = (siteId: string, checked: boolean) => {
    if (!editing || editing.accessRole === "admin") return;
    const current = selectedVisibleSiteIds(editing);
    const next = checked
      ? [...current, siteId].filter((id, index, all) => all.indexOf(id) === index)
      : current.filter((id) => id !== siteId);
    setEditing({ ...editing, visibleSiteIds: next });
  };

  const save = async () => {
    if (!editing || saving || sensitiveLoading) return;
    const existing = (state.personnel ?? []).find((person) => person.id === editing.id);
    if (existing && !normalizedText(editing.sensitiveRevision)) {
      toast.error("敏感档案尚未安全加载，请重新打开后再保存");
      return;
    }
    const existingHasAccount = hasPersonnelAccount(existing);
    const shouldHaveAccount = existingHasAccount || accountRequested;
    const visibleSiteIds = !shouldHaveAccount || editing.accessRole === "admin"
      ? []
      : normalizeVisibleSiteIds(editing.visibleSiteIds, sites);
    const next: Personnel = {
      ...editing,
      personnelNo: normalizedText(editing.personnelNo),
      name: normalizedText(editing.name),
      gender: normalizedText(editing.gender) as Personnel["gender"],
      birthDate: normalizedText(editing.birthDate),
      department: normalizedText(editing.department),
      hireDate: normalizedText(editing.hireDate),
      siteIds: normalizeVisibleSiteIds(editing.siteIds, sites),
      phone: normalizedText(editing.phone),
      email: normalizedText(editing.email),
      wechat: normalizedText(editing.wechat),
      address: normalizedText(editing.address),
      emergencyContact: normalizedText(editing.emergencyContact),
      emergencyPhone: normalizedText(editing.emergencyPhone),
      idCardNo: normalizedText(editing.idCardNo),
      bankAccountName: normalizedText(editing.bankAccountName),
      bankAccountNo: normalizedText(editing.bankAccountNo),
      bankName: normalizedText(editing.bankName),
      username: shouldHaveAccount ? normalizedText(editing.username) : "",
      password: shouldHaveAccount ? String(editing.password ?? "") : "",
      accountEnabled: shouldHaveAccount ? editing.accountEnabled !== false : false,
      accessRole: shouldHaveAccount ? editing.accessRole : "staff",
      visibleSiteIds,
      employmentStatus: isPersonnelResigned(editing) ? "resigned" : "active",
      resignedAt: editing.resignedAt,
      permissions: isPersonnelResigned(editing) || !shouldHaveAccount
        ? emptyPermissions()
        : editing.accessRole === "admin"
        ? fullPermissions()
        : editing.permissions ?? emptyPermissions(),
      role: normalizedText(editing.role),
      notes: normalizedText(editing.notes),
    };

    if (!next.personnelNo) return toast.error("请填写人员工号");
    if (!next.name) return toast.error("请填写人员姓名");
    if (
      next.personnelNo &&
      (state.personnel ?? []).some((person) =>
        person.id !== next.id && normalizedText(person.personnelNo).toLowerCase() === next.personnelNo!.toLowerCase()
      )
    ) return toast.error("人员工号不能重复");
    if (next.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.email)) {
      return toast.error("请填写正确的邮箱地址");
    }
    if (shouldHaveAccount) {
      if (!next.username) return toast.error("请填写登录账号");
      if (!existingHasAccount && !next.password) return toast.error("新账号必须设置初始密码");
      if (next.password && next.password.length < 6) return toast.error("登录密码至少 6 位");
      if (next.accountEnabled !== false && next.accessRole === "staff" && visibleSiteIds.length === 0) {
        return toast.error("请至少选择一个账号可见区域");
      }
      if ((state.personnel ?? []).some((person) => person.id !== next.id && person.username === next.username)) {
        return toast.error("登录账号不能重复");
      }
    }
    if (existing?.username === state.user?.username && next.accessRole !== "admin") {
      return toast.error("不能把当前管理员改为普通账号");
    }
    if (existing?.username === state.user?.username && next.accountEnabled === false) {
      return toast.error("不能停用当前登录账号");
    }
    if (
      existing?.accessRole === "admin" &&
      isPersonnelAccountEnabled(existing) &&
      (next.accessRole !== "admin" || next.accountEnabled === false) &&
      adminCount(existing.id) === 0
    ) return toast.error("至少需要保留一个启用的管理员账号");

    const passwordToReset = existingHasAccount ? next.password : "";
    const personnelToSave = existingHasAccount ? { ...next, password: "" } : next;
    if (!confirmWrite(
      next.id ? "修改" : "新增",
      next.id
        ? `将保存人员档案的修改${passwordToReset ? "，并重置该账号密码" : ""}。`
        : "将新增一份人员档案。"
    )) return;
    setSaving(true);
    const ok = await savePersonnelAccount(personnelToSave);
    const passwordOk = ok && passwordToReset
      ? await changePersonnelPassword({ targetId: next.id, newPassword: passwordToReset })
      : true;
    setSaving(false);
    if (!ok) return toast.error("保存失败，请重试");
    if (!passwordOk) return toast.error("档案已保存，但密码重置失败，请在个人中心重试");
    closeEditor();
    toast.success(next.id ? `人员档案已更新${passwordToReset ? "，密码已重置" : ""}` : "人员档案已建立");
  };

  const confirmDelete = async () => {
    if (!del) return;
    if (hasPersonnelAccount(del) && del.username === state.user?.username) {
      return toast.error("当前登录人员不能删除");
    }
    if (del.accessRole === "admin" && isPersonnelAccountEnabled(del) && adminCount(del.id) === 0) {
      return toast.error("至少需要保留一个管理员账号");
    }
    if (orderCount(del.name) > 0) return toast.error("该人员已有订单关联，不能删除");
    const deleteId = del.id;
    setDeleting(true);
    const ok = await deletePersonnelAccount(deleteId);
    setDeleting(false);
    if (!ok) return toast.error("删除失败，请重试");
    setDel(null);
    toast.success("已删除误录人员档案");
  };

  const confirmResign = async () => {
    if (!resign) return;
    if (isPersonnelResigned(resign)) return toast.error("该人员已经离职");
    if (hasPersonnelAccount(resign) && resign.username === state.user?.username) {
      return toast.error("当前登录人员不能设为离职");
    }
    if (resign.accessRole === "admin" && isPersonnelAccountEnabled(resign) && adminCount(resign.id) === 0) {
      return toast.error("至少需要保留一个在职管理员账号");
    }
    const resignId = resign.id;
    setResigning(true);
    const ok = await resignPersonnelAccount(resignId);
    setResigning(false);
    if (!ok) return toast.error("离职操作失败，请重试");
    setResign(null);
    toast.success("已设为离职，关联账号已停用");
  };

  const rows: PersonnelRow[] = (state.personnel ?? [])
    .filter((person) => {
      if (employmentFilter === "active" && isPersonnelResigned(person)) return false;
      if (employmentFilter === "resigned" && !isPersonnelResigned(person)) return false;
      if (accountFilter === "none" && hasPersonnelAccount(person)) return false;
      if (accountFilter === "enabled" && !isPersonnelAccountEnabled(person)) return false;
      if (accountFilter === "disabled" && (!hasPersonnelAccount(person) || isPersonnelAccountEnabled(person))) return false;
      return true;
    })
    .map((person) => {
      const accountState = !hasPersonnelAccount(person)
        ? "未开通账号 无账号"
        : isPersonnelAccountEnabled(person)
        ? "账号已启用 启用账号"
        : "账号已停用 停用账号";
      return {
        ...person,
        searchText: [
          person.name,
          person.personnelNo,
          person.department,
          person.role,
          person.phone,
          person.email,
          person.wechat,
          person.username,
          workSiteNames(person),
          isPersonnelResigned(person) ? "离职" : "在职",
          accountState,
        ].filter(Boolean).join(" "),
      };
    });

  const renderAccountStatus = (person: Personnel) => {
    if (!hasPersonnelAccount(person)) {
      return <Badge variant="outline" className="text-xs">未开通</Badge>;
    }
    if (isPersonnelAccountEnabled(person)) {
      return <Badge variant="secondary" className="text-xs">已启用</Badge>;
    }
    return <Badge variant="outline" className="border-amber-300 text-xs text-amber-700">已停用</Badge>;
  };

  const existingEditingAccount = Boolean(
    editing?.id && (state.personnel ?? []).some((person) =>
      person.id === editing.id && hasPersonnelAccount(person)
    )
  );
  const sensitiveReady = !editing?.id || Boolean(normalizedText(editing.sensitiveRevision));
  const currentEditingAccount = Boolean(
    existingEditingAccount && editing?.username && editing.username === state.user?.username
  );

  return (
    <div className="flex flex-col gap-4">
      {!embedded && (
        <div>
          <h2>人员档案</h2>
          <p className="text-sm text-muted-foreground">登记人员基础资料；登录账号按实际需要单独开通</p>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="text-sm font-medium">档案筛选</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            当前显示 {rows.length} / {(state.personnel ?? []).length} 人
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:w-auto">
          <div className="grid gap-1">
            <Label htmlFor="personnel-employment-filter" className="text-xs text-muted-foreground">任职状态</Label>
            <Select value={employmentFilter} onValueChange={(value) => setEmploymentFilter(value as EmploymentFilter)}>
              <SelectTrigger id="personnel-employment-filter" className="min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部人员</SelectItem>
                <SelectItem value="active">仅在职</SelectItem>
                <SelectItem value="resigned">仅离职</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="personnel-account-filter" className="text-xs text-muted-foreground">账号状态</Label>
            <Select value={accountFilter} onValueChange={(value) => setAccountFilter(value as AccountFilter)}>
              <SelectTrigger id="personnel-account-filter" className="min-w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部账号状态</SelectItem>
                <SelectItem value="enabled">账号已启用</SelectItem>
                <SelectItem value="disabled">账号已停用</SelectItem>
                <SelectItem value="none">未开通账号</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <DataTable
        data={rows}
        searchKeys={["searchText"]}
        searchPlaceholder="搜索姓名、工号、岗位、电话或账号..."
        onAdd={openCreate}
        addLabel="新增人员档案"
        columns={[
          {
            key: "name",
            title: "人员",
            render: (row) => (
              <div className="min-w-[9rem]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  {isPersonnelResigned(row) ? (
                    <Badge variant="outline" className="border-slate-300 text-xs text-slate-500">离职</Badge>
                  ) : (
                    <Badge variant="secondary" className="text-xs">在职</Badge>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  工号：{row.personnelNo || "未设置"}
                </div>
              </div>
            ),
          },
          {
            key: "role",
            title: "部门 / 岗位",
            render: (row) => [row.department, row.role].filter(Boolean).join(" / ") || "—",
          },
          { key: "siteIds", title: "所属区域", render: (row) => workSiteNames(row) },
          {
            key: "phone",
            title: "联系方式",
            render: (row) => (
              <div>
                <div>{row.phone || "—"}</div>
                {row.email && <div className="mt-0.5 text-xs text-muted-foreground">{row.email}</div>}
              </div>
            ),
          },
          {
            key: "accountEnabled",
            title: "系统账号",
            render: (row) => (
              <div className="flex min-w-[7rem] flex-col items-start gap-1">
                {renderAccountStatus(row)}
                {hasPersonnelAccount(row) && (
                  <span className="text-xs text-muted-foreground">{row.username}</span>
                )}
              </div>
            ),
          },
        ]}
        actions={(row) => (
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => void editPerson(row)}>
              查看 / 编辑
            </Button>
            {!isPersonnelResigned(row) && (
              <Button size="sm" variant="outline" className="text-orange-700" onClick={() => setResign(row)}>
                办理离职
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-red-600"
              title="仅删除没有业务关联的误录档案"
              onClick={() => setDel(row)}
            >
              删除误录
            </Button>
          </div>
        )}
      />

      <Dialog open={open} onOpenChange={(nextOpen) => {
        if (!nextOpen && !saving) closeEditor();
      }}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "人员档案详情" : "新增人员档案"}</DialogTitle>
            <DialogDescription>
              人员资料和登录账号相互独立；没有后台操作需要的人员可只保存档案。
            </DialogDescription>
          </DialogHeader>

          {editing && (
            <div className="grid gap-4 py-1">
              <section className="rounded-xl border bg-card p-4" aria-labelledby="personnel-basic-heading">
                <div className="mb-4">
                  <h3 id="personnel-basic-heading" className="text-base font-semibold">基本信息</h3>
                  <p className="text-xs text-muted-foreground">用于人员识别和内部档案登记</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-no">人员工号<span className="ml-0.5 text-red-500">*</span></Label>
                    <Input
                      id="personnel-no"
                      value={editing.personnelNo ?? ""}
                      onChange={(event) => setEditing({ ...editing, personnelNo: event.target.value })}
                      placeholder="如：RY-0004"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-name">姓名<span className="ml-0.5 text-red-500">*</span></Label>
                    <Input
                      id="personnel-name"
                      value={editing.name}
                      onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                      placeholder="必填"
                      autoComplete="name"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-gender">性别</Label>
                    <Select
                      value={editing.gender || "unspecified"}
                      onValueChange={(value) => setEditing({
                        ...editing,
                        gender: (value === "unspecified" ? "" : value) as Personnel["gender"],
                      })}
                    >
                      <SelectTrigger id="personnel-gender">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="unspecified">未填写</SelectItem>
                        <SelectItem value="male">男</SelectItem>
                        <SelectItem value="female">女</SelectItem>
                        <SelectItem value="other">其他</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-birth-date">出生日期</Label>
                    <Input
                      id="personnel-birth-date"
                      type="date"
                      value={editing.birthDate ?? ""}
                      onChange={(event) => setEditing({ ...editing, birthDate: event.target.value })}
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-xl border bg-card p-4" aria-labelledby="personnel-employment-heading">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 id="personnel-employment-heading" className="text-base font-semibold">任职信息</h3>
                    <p className="text-xs text-muted-foreground">记录所属区域、部门、岗位和入职时间</p>
                  </div>
                  <Badge variant={isPersonnelResigned(editing) ? "outline" : "secondary"}>
                    {isPersonnelResigned(editing) ? "已离职" : "在职"}
                  </Badge>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-department">部门 / 班组</Label>
                    <Input
                      id="personnel-department"
                      value={editing.department ?? ""}
                      onChange={(event) => setEditing({ ...editing, department: event.target.value })}
                      placeholder="如：养护组、销售组"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-role">岗位</Label>
                    <Input
                      id="personnel-role"
                      value={editing.role}
                      onChange={(event) => setEditing({ ...editing, role: event.target.value })}
                      placeholder="如：销售、养护、打包"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-hire-date">入职日期</Label>
                    <Input
                      id="personnel-hire-date"
                      type="date"
                      value={editing.hireDate ?? ""}
                      onChange={(event) => setEditing({ ...editing, hireDate: event.target.value })}
                    />
                  </div>
                  <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
                    <span id="personnel-work-sites-label" className="text-sm font-medium">所属工作区域</span>
                    <div
                      role="group"
                      aria-labelledby="personnel-work-sites-label"
                      className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-3"
                    >
                      {sites.map((site) => {
                        const checkboxId = `personnel-work-site-${site.id}`;
                        return (
                          <label
                            key={site.id}
                            htmlFor={checkboxId}
                            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                          >
                            <Checkbox
                              id={checkboxId}
                              className="min-h-4!"
                              checked={selectedWorkSiteIds(editing).includes(site.id)}
                              onCheckedChange={(value) => toggleWorkSite(site.id, value === true)}
                            />
                            <span>{site.name}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border bg-card p-4" aria-labelledby="personnel-contact-heading">
                <div className="mb-4">
                  <h3 id="personnel-contact-heading" className="text-base font-semibold">联系信息</h3>
                  <p className="text-xs text-muted-foreground">联系方式仅用于内部业务联络和紧急联系</p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-phone">联系电话</Label>
                    <Input
                      id="personnel-phone"
                      type="tel"
                      value={editing.phone}
                      onChange={(event) => setEditing({ ...editing, phone: event.target.value })}
                      autoComplete="tel"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-email">邮箱</Label>
                    <Input
                      id="personnel-email"
                      type="email"
                      value={editing.email ?? ""}
                      onChange={(event) => setEditing({ ...editing, email: event.target.value })}
                      autoComplete="email"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-wechat">微信</Label>
                    <Input
                      id="personnel-wechat"
                      value={editing.wechat ?? ""}
                      onChange={(event) => setEditing({ ...editing, wechat: event.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-emergency-contact">紧急联系人</Label>
                    <Input
                      id="personnel-emergency-contact"
                      value={editing.emergencyContact ?? ""}
                      onChange={(event) => setEditing({ ...editing, emergencyContact: event.target.value })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="personnel-emergency-phone">紧急联系电话</Label>
                    <Input
                      id="personnel-emergency-phone"
                      type="tel"
                      value={editing.emergencyPhone ?? ""}
                      onChange={(event) => setEditing({ ...editing, emergencyPhone: event.target.value })}
                    />
                  </div>
                  <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
                    <Label htmlFor="personnel-address">联系地址</Label>
                    <Textarea
                      id="personnel-address"
                      rows={2}
                      value={editing.address ?? ""}
                      onChange={(event) => setEditing({ ...editing, address: event.target.value })}
                    />
                  </div>
                </div>
              </section>

              <section className="rounded-xl border bg-card p-4" aria-labelledby="personnel-sensitive-heading">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 id="personnel-sensitive-heading" className="text-base font-semibold">证件与工资账户</h3>
                    <p id="personnel-sensitive-description" className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {sensitiveLoading
                        ? "正在安全读取该人员的敏感档案……"
                        : "敏感档案仅供管理员按人查看和维护，每次查看都会记录；人员列表不会返回这些内容。"}
                    </p>
                  </div>
                  <Badge variant="outline" className="shrink-0">仅管理员可见</Badge>
                </div>

                <div className="grid gap-5" aria-describedby="personnel-sensitive-description">
                  <div className="grid gap-2 sm:max-w-xl">
                    <Label htmlFor="personnel-id-card-no">身份证件号码</Label>
                    <MaskedPersonnelInput
                      id="personnel-id-card-no"
                      value={editing.idCardNo ?? ""}
                      visible={showIdCardNo}
                      onChange={(value) => setEditing({ ...editing, idCardNo: value })}
                      onToggle={() => setShowIdCardNo((current) => !current)}
                      toggleLabel={showIdCardNo ? "隐藏身份证件号码" : "显示身份证件号码"}
                      placeholder="默认遮蔽，可点击右侧查看"
                      disabled={sensitiveLoading}
                    />
                  </div>

                  <div className="border-t pt-4">
                    <h4 className="mb-3 text-sm font-medium">工资账户</h4>
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="grid gap-2">
                        <Label htmlFor="personnel-bank-account-name">开户名</Label>
                        <Input
                          id="personnel-bank-account-name"
                          value={editing.bankAccountName ?? ""}
                          onChange={(event) => setEditing({ ...editing, bankAccountName: event.target.value })}
                          autoComplete="off"
                          className="h-11"
                          disabled={sensitiveLoading}
                        />
                      </div>
                      <div className="grid gap-2 sm:col-span-2 lg:col-span-1">
                        <Label htmlFor="personnel-bank-account-no">银行卡号</Label>
                        <MaskedPersonnelInput
                          id="personnel-bank-account-no"
                          value={editing.bankAccountNo ?? ""}
                          visible={showBankAccountNo}
                          onChange={(value) => setEditing({ ...editing, bankAccountNo: value })}
                          onToggle={() => setShowBankAccountNo((current) => !current)}
                          toggleLabel={showBankAccountNo ? "隐藏银行卡号" : "显示银行卡号"}
                          placeholder="默认遮蔽，可点击右侧查看"
                          inputMode="numeric"
                          disabled={sensitiveLoading}
                        />
                      </div>
                      <div className="grid gap-2 sm:col-span-2 lg:col-span-1">
                        <Label htmlFor="personnel-bank-name">开户银行</Label>
                        <Input
                          id="personnel-bank-name"
                          value={editing.bankName ?? ""}
                          onChange={(event) => setEditing({ ...editing, bankName: event.target.value })}
                          placeholder="如：中国工商银行南京某支行"
                          autoComplete="off"
                          className="h-11"
                          disabled={sensitiveLoading}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border bg-card p-4" aria-labelledby="personnel-account-heading">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 id="personnel-account-heading" className="text-base font-semibold">系统账号</h3>
                      {existingEditingAccount && renderAccountStatus(editing)}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      仅在需要登录管理系统时开通；业务权限在“账号与权限”页配置。
                    </p>
                  </div>
                  {!existingEditingAccount && (
                    <label
                      htmlFor="personnel-account-requested"
                      className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border px-3 py-2 text-sm sm:min-w-[13rem]"
                    >
                      <span>同时开通账号</span>
                      <Switch
                        id="personnel-account-requested"
                        className="min-h-[1.15rem]!"
                        checked={accountRequested}
                        onCheckedChange={(checked) => {
                          setAccountRequested(checked);
                          setEditing({
                            ...editing,
                            accountEnabled: checked,
                            username: checked ? editing.username : "",
                            password: checked ? editing.password : "",
                            permissions: checked ? editing.permissions ?? emptyPermissions() : emptyPermissions(),
                          });
                        }}
                      />
                    </label>
                  )}
                </div>

                {(existingEditingAccount || accountRequested) && (
                  <div className="mt-4 grid gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="grid gap-2">
                      <Label htmlFor="personnel-username">登录账号<span className="ml-0.5 text-red-500">*</span></Label>
                      <Input
                        id="personnel-username"
                        value={editing.username ?? ""}
                        onChange={(event) => setEditing({ ...editing, username: event.target.value })}
                        placeholder="设置唯一登录账号"
                        autoComplete="username"
                        disabled={existingEditingAccount}
                      />
                      {existingEditingAccount && (
                        <p className="text-xs text-muted-foreground">已有账号名不可直接修改。</p>
                      )}
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="personnel-password">
                        {existingEditingAccount ? "重置登录密码" : "初始登录密码"}
                        {!existingEditingAccount && <span className="ml-0.5 text-red-500">*</span>}
                      </Label>
                      <Input
                        id="personnel-password"
                        type="password"
                        value={editing.password ?? ""}
                        onChange={(event) => setEditing({ ...editing, password: event.target.value })}
                        placeholder={existingEditingAccount ? "留空则不修改" : "至少 6 位"}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="personnel-access-role">账号角色</Label>
                      <Select
                        value={editing.accessRole}
                        onValueChange={(value) => {
                          const accessRole = value as Role;
                          setEditing({
                            ...editing,
                            accessRole,
                            visibleSiteIds: accessRole === "admin"
                              ? allSiteIds
                              : selectedVisibleSiteIds(editing),
                          });
                        }}
                      >
                        <SelectTrigger id="personnel-access-role">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">管理员</SelectItem>
                          <SelectItem value="staff">普通账号</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
                      <label
                        htmlFor="personnel-account-enabled"
                        className="flex min-h-11 cursor-pointer items-center justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2 text-sm"
                      >
                        <span>
                          <span className="block font-medium">允许登录系统</span>
                          <span className="block text-xs font-normal text-muted-foreground">
                            停用后保留用户名和权限配置，但该账号不能登录。
                          </span>
                        </span>
                        <Switch
                          id="personnel-account-enabled"
                          className="min-h-[1.15rem]!"
                          checked={editing.accountEnabled !== false}
                          disabled={currentEditingAccount}
                          onCheckedChange={(checked) => setEditing({ ...editing, accountEnabled: checked })}
                        />
                      </label>
                    </div>
                    <div className="grid gap-2 sm:col-span-2 lg:col-span-3">
                      <span id="personnel-visible-sites-label" className="text-sm font-medium">
                        账号可见区域<span className="ml-0.5 text-red-500">*</span>
                      </span>
                      <div
                        role="group"
                        aria-labelledby="personnel-visible-sites-label"
                        className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-3"
                      >
                        {sites.map((site) => {
                          const checked = selectedVisibleSiteIds(editing).includes(site.id);
                          const disabled = editing.accessRole === "admin";
                          const checkboxId = `personnel-visible-site-${site.id}`;
                          return (
                            <label
                              key={site.id}
                              htmlFor={checkboxId}
                              className={[
                                "flex min-h-11 items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm",
                                disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
                              ].join(" ")}
                            >
                              <Checkbox
                                id={checkboxId}
                                className="min-h-4!"
                                checked={checked}
                                disabled={disabled}
                                onCheckedChange={(value) => toggleVisibleSite(site.id, value === true)}
                              />
                              <span>{site.name}</span>
                            </label>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        管理员默认全部区域可见；新普通账号默认没有业务操作权限，请保存后到“账号与权限”配置。
                      </p>
                    </div>
                  </div>
                )}
              </section>

              <section className="rounded-xl border bg-card p-4" aria-labelledby="personnel-notes-heading">
                <div className="grid gap-2">
                  <Label id="personnel-notes-heading" htmlFor="personnel-notes">档案备注</Label>
                  <Textarea
                    id="personnel-notes"
                    rows={3}
                    value={editing.notes}
                    onChange={(event) => setEditing({ ...editing, notes: event.target.value })}
                    placeholder="记录需要长期保留的内部说明"
                  />
                </div>
              </section>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={closeEditor}>取消</Button>
            <Button disabled={saving || sensitiveLoading || !sensitiveReady} onClick={save}>
              {saving ? "保存中..." : sensitiveLoading ? "正在读取敏感档案..." : "保存人员档案"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!del} onOpenChange={(nextOpen) => !nextOpen && !deleting && setDel(null)}>
        <AlertDialogContent className="w-[min(92vw,30rem)] max-w-[92vw] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-6">
          <AlertDialogHeader>
            <AlertDialogTitle>删除误录人员档案</AlertDialogTitle>
            <AlertDialogDescription>
              仅当「{del?.name}」是误录且没有任何业务关联时才可删除。正常离职人员应保留档案并办理离职。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <AlertDialogCancel disabled={deleting} className="mt-0">取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? "删除中..." : "确认删除误录"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!resign} onOpenChange={(nextOpen) => !nextOpen && !resigning && setResign(null)}>
        <AlertDialogContent className="w-[min(92vw,30rem)] max-w-[92vw] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-6">
          <AlertDialogHeader>
            <AlertDialogTitle>确认人员离职</AlertDialogTitle>
            <AlertDialogDescription>
              确认将「{resign?.name}」设为离职？人员档案和历史业务记录会保留；如已开通账号，账号将同时停用。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <AlertDialogCancel disabled={resigning} className="mt-0">取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={resigning}
              className="bg-orange-600 text-white hover:bg-orange-700"
              onClick={(event) => {
                event.preventDefault();
                void confirmResign();
              }}
            >
              {resigning ? "处理中..." : "确认办理离职"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
