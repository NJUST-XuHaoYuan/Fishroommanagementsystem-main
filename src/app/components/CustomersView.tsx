import { useState, useRef, useEffect, useMemo } from "react";
import { useStore, Customer, uid } from "../store";
import { DataTable } from "./common";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
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
import { toast } from "sonner";
import { usePermission } from "../utils/permissions";
import { Phone, MessageCircle, Video, MapPin, Settings2, Pencil, Trash2, ChevronDown, Check, Plus } from "lucide-react";
import { confirmWrite } from "../utils/writeConfirm";

// ── 来源徽标颜色池（按 index 循环取色）────────────────────────
const SOURCE_COLORS = [
  "bg-slate-700 text-white",
  "bg-green-600 text-white",
  "bg-amber-500 text-white",
  "bg-sky-500 text-white",
  "bg-violet-500 text-white",
  "bg-rose-500 text-white",
  "bg-teal-500 text-white",
  "bg-orange-500 text-white",
];

function SourceBadge({ source, sourceList }: { source: string; sourceList: string[] }) {
  if (!source) return <span className="text-muted-foreground text-xs">—</span>;
  const idx = sourceList.indexOf(source);
  const cls = SOURCE_COLORS[(idx >= 0 ? idx : 0) % SOURCE_COLORS.length];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {source}
    </span>
  );
}

// ── 来源下拉组件（可搜索 + 内联新增）─────────────────────────
function SourceCombobox({
  value,
  onChange,
  onAdd,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: (v: string) => void;
  options: string[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(q.toLowerCase())),
    [options, q]
  );
  const canAdd = q.trim() && !options.some((o) => o === q.trim());

  const pick = (v: string, isNew = false) => {
    onChange(v);
    if (isNew) onAdd(v);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className={`w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm bg-background hover:bg-accent/40 transition-colors ${
          !value ? "text-muted-foreground" : ""
        }`}
        onClick={() => {
          setOpen((o) => !o);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
      >
        <span>{value || "请选择来源"}</span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-2 border-b">
            <Input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索或输入新来源…"
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAdd) pick(q.trim(), true);
                if (e.key === "Escape") { setOpen(false); setQ(""); }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 && !canAdd && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">无匹配来源</div>
            )}
            {filtered.map((o) => (
              <button
                key={o}
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                onClick={() => pick(o)}
              >
                <Check className={`size-3.5 shrink-0 ${value === o ? "opacity-100 text-sky-600" : "opacity-0"}`} />
                {o}
              </button>
            ))}
            {canAdd && (
              <button
                type="button"
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-sky-50 text-sky-600 font-medium border-t"
                onClick={() => pick(q.trim(), true)}
              >
                <Plus className="size-3.5 shrink-0" />
                新增来源「{q.trim()}」
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 来源管理弹窗 ───────────────────────────────────────────────
function ManageSourcesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { state, saveStateTransform } = useStore();
  const sources = state.customerSources ?? [];

  const usageCount = (src: string) =>
    (state.customers ?? []).filter((c) => c.source === src).length;

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const [newVal, setNewVal] = useState("");
  const [deletingIdx, setDeletingIdx] = useState<number | null>(null);

  useEffect(() => {
    if (editingIdx !== null) setTimeout(() => editInputRef.current?.focus(), 30);
  }, [editingIdx]);

  // 重命名（同步更新所有使用旧来源的客户）
  const commitRename = async (idx: number) => {
    const trimmed = editVal.trim();
    if (!trimmed) { setEditingIdx(null); return; }
    const oldName = sources[idx];
    if (trimmed === oldName) { setEditingIdx(null); return; }
    if (sources.includes(trimmed)) { toast.error("该来源名已存在"); return; }
    if (!confirmWrite("修改", `将客户来源「${oldName}」重命名为「${trimmed}」。`)) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      customerSources: (latest.customerSources ?? []).map((src, i) => (i === idx ? trimmed : src)),
      customers: (latest.customers ?? []).map((c) => c.source === oldName ? { ...c, source: trimmed } : c),
    }));
    if (!ok) return toast.error("保存失败，请重试");
    setEditingIdx(null);
    toast.success(`已重命名为「${trimmed}」`);
  };

  // 删除
  const confirmDelete = async () => {
    if (deletingIdx === null) return;
    const name = sources[deletingIdx];
    if (!confirmWrite("删除", `将删除客户来源「${name}」。`)) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      customerSources: (latest.customerSources ?? []).filter((_, i) => i !== deletingIdx),
      customers: (latest.customers ?? []).map((c) => c.source === name ? { ...c, source: "" } : c),
    }));
    if (!ok) return toast.error("删除失败，请重试");
    setDeletingIdx(null);
    toast.success(`已删除来源「${name}」`);
  };

  // 新增
  const addSource = async () => {
    const v = newVal.trim();
    if (!v) return;
    if (sources.includes(v)) { toast.error("该来源名已存在"); return; }
    if (!confirmWrite("新增", `将新增客户来源「${v}」。`)) return;
    const ok = await saveStateTransform((latest) => ({ ...latest, customerSources: [...(latest.customerSources ?? []), v] }));
    if (!ok) return toast.error("保存失败，请重试");
    setNewVal("");
    toast.success(`已新增来源「${v}」`);
  };

  const deletingName = deletingIdx !== null ? sources[deletingIdx] : "";
  const deletingUsage = deletingIdx !== null ? usageCount(deletingName) : 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle>管理来源</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1 max-h-80 overflow-y-auto pr-1">
            {sources.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">暂无来源</p>
            )}
            {sources.map((src, idx) => {
              const cnt = usageCount(src);
              const isEditing = editingIdx === idx;
              const colorCls = SOURCE_COLORS[idx % SOURCE_COLORS.length];
              return (
                <div
                  key={idx}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50 group"
                >
                  {isEditing ? (
                    <Input
                      ref={editInputRef}
                      value={editVal}
                      onChange={(e) => setEditVal(e.target.value)}
                      className="h-7 text-sm flex-1"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(idx);
                        if (e.key === "Escape") setEditingIdx(null);
                      }}
                      onBlur={() => commitRename(idx)}
                    />
                  ) : (
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${colorCls}`}>
                        {src}
                      </span>
                    </div>
                  )}

                  {/* 使用数角标 */}
                  {!isEditing && (
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium shrink-0 ${
                      cnt > 0 ? "bg-sky-100 text-sky-700" : "bg-muted text-muted-foreground"
                    }`}>
                      {cnt} 个客户
                    </span>
                  )}

                  {isEditing ? (
                    <button
                      type="button"
                      className="text-xs text-sky-600 hover:underline shrink-0"
                      onMouseDown={(e) => { e.preventDefault(); commitRename(idx); }}
                    >
                      确认
                    </button>
                  ) : (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        type="button"
                        className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                        title="重命名"
                        onClick={() => { setEditingIdx(idx); setEditVal(src); }}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className="p-1 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600"
                        title="删除"
                        onClick={() => setDeletingIdx(idx)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 新增行 */}
          <div className="flex gap-2 pt-2 border-t">
            <Input
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              placeholder="输入新来源名…"
              className="h-8 text-sm"
              onKeyDown={(e) => { if (e.key === "Enter") addSource(); }}
            />
            <Button size="sm" onClick={addSource} disabled={!newVal.trim()}>
              <Plus className="size-3.5 mr-1" />新增
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deletingIdx !== null} onOpenChange={(o) => !o && setDeletingIdx(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除来源「{deletingName}」</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingUsage > 0
                ? `该来源下有 ${deletingUsage} 个客户，删除后这些客户的来源将被清空，需手动重新指定。确认继续？`
                : "确认删除该来源？此操作无法撤销。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ── 主组件 ────────────────────────────────────────────────────
export function CustomersView() {
  const { state, saveStateTransform } = useStore();
  const today = new Date().toISOString().slice(0, 10);
  const permission = usePermission("customers");

  const [editing, setEditing] = useState<Customer | null>(null);
  const [deleting, setDeleting] = useState<Customer | null>(null);
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const sources = useMemo(
    () => state.customerSources ?? [],
    [state.customerSources]
  );

  const customers = useMemo(
    () => [...(state.customers ?? [])].sort((a, b) => b.addedDate.localeCompare(a.addedDate)),
    [state.customers]
  );

  const empty = (): Customer => ({
    id: "", name: "", addedDate: today,
    phone: "", wechat: "", douyin: "",
    source: "", address: "", notes: "",
  });

  // 新来源随客户保存一起写入后端，避免下拉选择时提前落库。
  const addSourceToStore = (src: string) => {
    void src;
  };

  const save = async () => {
    if (!editing) return;
    if (!permission.requirePermission(editing.id ? "update" : "create")) return;
    if (!editing.name.trim()) return toast.error("客户名称不可为空");
    if (editing.addedDate && editing.addedDate > today) return toast.error("客户添加时间不能晚于今天");
    if (!confirmWrite(editing.id ? "修改" : "新增", editing.id ? "将保存客户信息的修改。" : "将新增一个客户。")) return;
    const ok = await saveStateTransform((latest) => {
      // 保存时若来源不在列表，自动加入
      const list = latest.customerSources ?? [];
      const newSources = editing.source && !list.includes(editing.source)
        ? [...list, editing.source]
        : list;
      const customers = latest.customers ?? [];
      const exists = customers.find((c) => c.id === editing.id);
      return {
        ...latest,
        customerSources: newSources,
        customers: exists
          ? customers.map((c) => (c.id === editing.id ? editing : c))
          : [...customers, { ...editing, id: uid() }],
      };
    });
    if (!ok) return toast.error("保存失败，请重试");
    setOpen(false);
    toast.success("已保存");
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `将删除客户「${deleting.name}」。`)) return;
    const deleteId = deleting.id;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      customers: (latest.customers ?? []).filter((c) => c.id !== deleteId),
    }));
    if (!ok) return toast.error("删除失败，请重试");
    setDeleting(null);
    toast.success("已删除");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h2>客户管理</h2>
          <p className="text-sm text-muted-foreground">维护客户联系方式、来源渠道与常用地址</p>
        </div>
        {(permission.canCreate || permission.canUpdate || permission.canDelete) && (
          <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
            <Settings2 className="size-3.5 mr-1.5" />管理来源
          </Button>
        )}
      </div>

      <DataTable
        data={customers}
        searchKeys={["name", "phone", "wechat", "douyin", "address"]}
        searchPlaceholder="搜索客户名、手机号、微信号、地址..."
        onAdd={permission.canCreate ? () => { setEditing(empty()); setOpen(true); } : undefined}
        addLabel="新增客户"
        columns={[
          {
            key: "name",
            title: "客户名称",
            render: (r) => <span className="font-medium">{r.name}</span>,
          },
          {
            key: "source",
            title: "来源",
            render: (r) => <SourceBadge source={r.source} sourceList={sources} />,
          },
          {
            key: "contact",
            title: "联系方式",
            render: (r) => (
              <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {r.phone && (
                  <span className="flex items-center gap-1">
                    <Phone className="size-3 shrink-0" /> {r.phone}
                  </span>
                )}
                {r.wechat && (
                  <span className="flex items-center gap-1">
                    <MessageCircle className="size-3 shrink-0" /> {r.wechat}
                  </span>
                )}
                {r.douyin && (
                  <span className="flex items-center gap-1">
                    <Video className="size-3 shrink-0" /> {r.douyin}
                  </span>
                )}
                {!r.phone && !r.wechat && !r.douyin && "—"}
              </div>
            ),
          },
          {
            key: "address",
            title: "常用地址",
            render: (r) =>
              r.address ? (
                <span className="flex items-center gap-1 text-sm">
                  <MapPin className="size-3 shrink-0 text-muted-foreground" />
                  <span className="truncate max-w-[160px]">{r.address}</span>
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              ),
          },
          {
            key: "notes",
            title: "备注",
            render: (r) =>
              r.notes ? (
                <span className="text-sm text-muted-foreground truncate max-w-[140px] block">{r.notes}</span>
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              ),
          },
          {
            key: "addedDate",
            title: "添加时间",
            render: (r) => <span className="text-sm text-muted-foreground">{r.addedDate}</span>,
          },
        ]}
        actions={(row) => (
          <div className="flex justify-end gap-2">
            {permission.canUpdate && (
              <Button size="sm" variant="outline" onClick={() => { setEditing({ ...row }); setOpen(true); }}>
                编辑
              </Button>
            )}
            {permission.canDelete && (
              <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDeleting(row)}>
                删除
              </Button>
            )}
          </div>
        )}
      />

      {/* 新增/编辑弹窗 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "编辑客户" : "新增客户"}</DialogTitle>
          </DialogHeader>

          {editing && (
            <div className="grid gap-4 py-2">
              {/* 名称 + 来源 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>客户名称<span className="text-red-500 ml-0.5">*</span></Label>
                  <Input
                    value={editing.name}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    placeholder="请输入客户名称"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>来源</Label>
                  <SourceCombobox
                    value={editing.source}
                    onChange={(v) => setEditing({ ...editing, source: v })}
                    onAdd={addSourceToStore}
                    options={sources}
                  />
                </div>
              </div>

              {/* 手机号 + 添加时间 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>手机号</Label>
                  <Input
                    value={editing.phone}
                    onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
                    placeholder="请输入手机号"
                    type="tel"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>添加时间</Label>
                  <Input
                    type="date"
                    value={editing.addedDate}
                    max={today}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value && value > today) {
                        toast.error("客户添加时间不能晚于今天");
                        return;
                      }
                      setEditing({ ...editing, addedDate: value });
                    }}
                  />
                </div>
              </div>

              {/* 微信号 + 抖音号 */}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>微信号</Label>
                  <Input
                    value={editing.wechat}
                    onChange={(e) => setEditing({ ...editing, wechat: e.target.value })}
                    placeholder="请输入微信号"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>抖音号</Label>
                  <Input
                    value={editing.douyin}
                    onChange={(e) => setEditing({ ...editing, douyin: e.target.value })}
                    placeholder="请输入抖音号"
                  />
                </div>
              </div>

              {/* 常用地址 */}
              <div className="grid gap-2">
                <Label>常用地址</Label>
                <Input
                  value={editing.address}
                  onChange={(e) => setEditing({ ...editing, address: e.target.value })}
                  placeholder="省市区 + 详细地址"
                />
              </div>

              {/* 备注 */}
              <div className="grid gap-2">
                <Label>备注</Label>
                <textarea
                  value={editing.notes}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  placeholder="其他说明…"
                  rows={3}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
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

      {/* 删除确认 */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除客户</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除客户「{deleting?.name}」？此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-red-600 hover:bg-red-700">
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 来源管理弹窗 */}
      <ManageSourcesDialog open={manageOpen} onOpenChange={setManageOpen} />
    </div>
  );
}
