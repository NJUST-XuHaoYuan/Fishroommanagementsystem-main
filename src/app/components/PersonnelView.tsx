import { useState } from "react";
import { emptyPermissions, fullPermissions, isPersonnelResigned, useStore, Personnel, Role } from "../store";
import { DataTable } from "./common";
import { Button } from "./ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "./ui/select";
import { toast } from "sonner";
import { confirmWrite } from "../utils/writeConfirm";

const ACCESS_ROLE_LABEL: Record<Role, string> = {
  admin: "管理员",
  staff: "店员",
};

export function PersonnelView() {
  const { state, savePersonnelAccount, resignPersonnelAccount, deletePersonnelAccount } = useStore();
  const [editing, setEditing] = useState<Personnel | null>(null);
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<Personnel | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [resign, setResign] = useState<Personnel | null>(null);
  const [resigning, setResigning] = useState(false);

  if (state.user?.role !== "admin") {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        当前账户没有人员管理权限。
      </div>
    );
  }

  const empty = (): Personnel => ({
    id: "",
    name: "",
    username: "",
    password: "",
    accessRole: "staff",
    permissions: emptyPermissions(),
    role: "",
    phone: "",
    notes: "",
    employmentStatus: "active",
  });

  const orderCount = (name: string) =>
    (state.orders ?? []).filter((order) => order.contactPerson === name).length;

  const adminCount = (excludeId?: string) =>
    (state.personnel ?? []).filter((person) =>
      person.id !== excludeId &&
      person.accessRole === "admin" &&
      !isPersonnelResigned(person)
    ).length;

  const save = async () => {
    if (!editing) return;
    const next: Personnel = {
      ...editing,
      name: editing.name.trim(),
      username: editing.username.trim(),
      password: editing.password,
      accessRole: editing.accessRole,
      employmentStatus: isPersonnelResigned(editing) ? "resigned" : "active",
      resignedAt: editing.resignedAt,
      permissions: isPersonnelResigned(editing)
        ? emptyPermissions()
        : editing.accessRole === "admin"
        ? fullPermissions()
        : editing.permissions ?? emptyPermissions(),
      role: editing.role.trim(),
      phone: editing.phone.trim(),
      notes: editing.notes.trim(),
    };
    if (!next.name) return toast.error("请填写人员姓名");
    if (!next.username) return toast.error("请填写登录账号");
    if (!next.id && !next.password) return toast.error("请填写登录密码");
    if (next.password && next.password.length < 6) return toast.error("登录密码至少 6 位");
    if ((state.personnel ?? []).some((p) => p.id !== next.id && p.username === next.username))
      return toast.error("登录账号不能重复");
    const existing = (state.personnel ?? []).find((p) => p.id === next.id);
    if (existing?.username === state.user?.username && next.accessRole !== "admin")
      return toast.error("不能把当前管理员改为店员");
    if (existing?.accessRole === "admin" && next.accessRole !== "admin" && adminCount(existing.id) === 0)
      return toast.error("至少需要保留一个管理员账号");

    if (!confirmWrite(next.id ? "修改" : "新增", next.id ? "将保存人员账号的修改。" : "将新增一个人员账号。")) return;
    const ok = await savePersonnelAccount(next);
    if (!ok) return toast.error("保存失败，请重试");
    setOpen(false);
    toast.success("人员已保存");
  };

  const confirmDelete = async () => {
    if (!del) return;
    if (del.username === state.user?.username) return toast.error("当前登录人员不能删除");
    if (del.accessRole === "admin" && adminCount(del.id) === 0)
      return toast.error("至少需要保留一个管理员账号");
    if (orderCount(del.name) > 0) return toast.error("该人员已有订单关联，不能删除");
    const deleteId = del.id;
    setDeleting(true);
    const ok = await deletePersonnelAccount(deleteId);
    setDeleting(false);
    if (!ok) return toast.error("删除失败，请重试");
    setDel(null);
    toast.success("已删除");
  };

  const confirmResign = async () => {
    if (!resign) return;
    if (isPersonnelResigned(resign)) return toast.error("该人员已经离职");
    if (resign.username === state.user?.username) return toast.error("当前登录人员不能设为离职");
    if (resign.accessRole === "admin" && adminCount(resign.id) === 0)
      return toast.error("至少需要保留一个在职管理员账号");
    const resignId = resign.id;
    setResigning(true);
    const ok = await resignPersonnelAccount(resignId);
    setResigning(false);
    if (!ok) return toast.error("离职操作失败，请重试");
    setResign(null);
    toast.success("已设为离职，权限已清空");
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>账号密码管理</h2>
        <p className="text-sm text-muted-foreground">账号密码管理，维护登录账户与订单对接人名单</p>
      </div>

      <DataTable
        data={state.personnel ?? []}
        searchKeys={["name", "username", "accessRole", "employmentStatus", "role", "phone", "notes"]}
        searchPlaceholder="搜索姓名、账号、岗位、电话..."
        onAdd={() => { setEditing(empty()); setOpen(true); }}
        addLabel="新增人员"
        columns={[
          {
            key: "name",
            title: "姓名",
            render: (row) => (
              <div className="flex items-center gap-2">
                <span className="font-medium">{row.name}</span>
	                {row.username === state.user?.username && (
	                  <Badge variant="secondary" className="text-xs">当前账户</Badge>
	                )}
	                {isPersonnelResigned(row) && (
	                  <Badge variant="outline" className="border-slate-300 text-xs text-slate-500">离职</Badge>
	                )}
	              </div>
	            ),
	          },
	          { key: "username", title: "登录账号", render: (row) => row.username || "—" },
	          {
	            key: "employmentStatus",
	            title: "状态",
	            render: (row) => isPersonnelResigned(row)
	              ? <Badge variant="outline" className="border-slate-300 text-xs text-slate-500">离职</Badge>
	              : <Badge variant="secondary" className="text-xs">在职</Badge>,
	          },
	          {
	            key: "accessRole",
            title: "系统权限",
            render: (row) => (
              <Badge variant={row.accessRole === "admin" ? "default" : "secondary"} className="text-xs">
                {ACCESS_ROLE_LABEL[row.accessRole]}
              </Badge>
            ),
          },
          { key: "role", title: "岗位", render: (row) => row.role || "—" },
          { key: "phone", title: "电话", render: (row) => row.phone || "—" },
          { key: "orderCount", title: "关联订单", render: (row) => `${orderCount(row.name)} 单` },
	          { key: "notes", title: "备注", render: (row) => row.notes || "—" },
	        ]}
	        actions={(row) => (
	          <div className="flex justify-end gap-2">
	            <Button size="sm" variant="outline" onClick={() => { setEditing({ ...row }); setOpen(true); }}>
	              编辑
	            </Button>
	            {!isPersonnelResigned(row) && (
	              <Button size="sm" variant="outline" className="text-orange-600" onClick={() => setResign(row)}>
	                离职
	              </Button>
	            )}
	            <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDel(row)}>
	              删除
            </Button>
          </div>
        )}
      />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{editing?.id ? "编辑人员" : "新增人员"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>姓名<span className="text-red-500 ml-0.5">*</span></Label>
                  <Input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="必填"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>登录账号<span className="text-red-500 ml-0.5">*</span></Label>
                  <Input
                    value={editing.username}
                    onChange={(e) => setEditing({ ...editing, username: e.target.value })}
                    placeholder="必填"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
	                  <Label>
	                    登录密码{!editing.id && <span className="text-red-500 ml-0.5">*</span>}
	                  </Label>
	                  <Input
	                    type="password"
	                    value={editing.password}
	                    onChange={(e) => setEditing({ ...editing, password: e.target.value })}
	                    placeholder={editing.id ? "留空则不修改" : "必填，至少 6 位"}
	                  />
                </div>
                <div className="grid gap-2">
                  <Label>系统权限<span className="text-red-500 ml-0.5">*</span></Label>
                  <Select
                    value={editing.accessRole}
                    onValueChange={(value) => setEditing({ ...editing, accessRole: value as Role })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">管理员</SelectItem>
                      <SelectItem value="staff">店员</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid gap-2">
                <Label>岗位</Label>
                <Input
                  value={editing.role}
                  onChange={(e) => setEditing({ ...editing, role: e.target.value })}
                  placeholder="如：销售、养护、打包"
                />
              </div>
              <div className="grid gap-2">
                <Label>电话</Label>
                <Input
                  value={editing.phone}
                  onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                  placeholder="选填"
                />
              </div>
              <div className="grid gap-2">
                <Label>备注</Label>
                <Textarea
                  rows={3}
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  placeholder="选填"
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={save}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent className="w-[min(92vw,28rem)] max-w-[92vw] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-6">
          <AlertDialogHeader>
            <AlertDialogTitle>删除人员</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除人员「{del?.name}」？已有订单关联或当前登录人员不能删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <AlertDialogCancel disabled={deleting} className="mt-0">取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={(event) => {
                event.preventDefault();
                confirmDelete();
              }}
            >
              {deleting ? "删除中..." : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!resign} onOpenChange={(o) => !o && setResign(null)}>
        <AlertDialogContent className="w-[min(92vw,30rem)] max-w-[92vw] pb-[calc(1rem+env(safe-area-inset-bottom))] sm:pb-6">
          <AlertDialogHeader>
            <AlertDialogTitle>确认人员离职</AlertDialogTitle>
            <AlertDialogDescription>
              确认将「{resign?.name}」设为离职？离职后会清空全部权限，不能登录，也不会出现在订单对接人和养护操作员下拉列表中。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
            <AlertDialogCancel disabled={resigning} className="mt-0">取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={resigning}
              className="bg-orange-600 text-white hover:bg-orange-700"
              onClick={(event) => {
                event.preventDefault();
                confirmResign();
              }}
            >
              {resigning ? "处理中..." : "确认离职"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
