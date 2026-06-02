import { useState, useRef, useEffect, useMemo, KeyboardEvent } from "react";
import { useStore, Species, uid } from "../store";
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
import { Textarea } from "./ui/textarea";
import { ImageUpload } from "./ImageUpload";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { toast } from "sonner";
import { ChevronDown, Plus, Check, X, Pencil, Trash2, Settings2 } from "lucide-react";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";

// ── 分类下拉（可搜索 + 内联新增）────────────────────────────
function CategoryCombobox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
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

  const pick = (v: string) => { onChange(v); setOpen(false); setQ(""); };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className={`w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm bg-background hover:bg-accent/40 transition-colors ${!value ? "text-muted-foreground" : ""}`}
        onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 50); }}
      >
        <span>{value || "请选择分类"}</span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-2 border-b">
            <Input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索或输入新分类…"
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAdd) pick(q.trim());
                if (e.key === "Escape") { setOpen(false); setQ(""); }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 && !canAdd && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">无匹配分类</div>
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
                onClick={() => pick(q.trim())}
              >
                <Plus className="size-3.5 shrink-0" />
                新增分类「{q.trim()}」
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 俗名标签输入 ──────────────────────────────────────────────
function CommonNamesInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState("");
  const add = () => {
    const v = input.trim();
    if (!v || value.includes(v)) { setInput(""); return; }
    onChange([...value, v]);
    setInput("");
  };
  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); add(); }
    if (e.key === "Backspace" && !input && value.length > 0) remove(value.length - 1);
  };
  return (
    <div className="flex flex-wrap gap-1.5 rounded-md border px-2 py-1.5 min-h-[38px] bg-background focus-within:ring-1 focus-within:ring-ring">
      {value.map((tag, i) => (
        <span key={i} className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-xs font-medium">
          {tag}
          <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => remove(i)}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        placeholder={value.length === 0 ? "输入后按 Enter 添加…" : ""}
        className="flex-1 min-w-[100px] bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

// ── 分类管理弹窗 ──────────────────────────────────────────────
function ManageCategoriesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { state, saveStateTransform } = useStore();
  const categories = state.speciesCategories ?? [];

  // 使用计数
  const usageCount = (cat: string) => state.species.filter((s) => s.category === cat).length;

  // 内联编辑状态
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // 新增输入
  const [newVal, setNewVal] = useState("");

  // 待删除确认
  const [deletingIdx, setDeletingIdx] = useState<number | null>(null);

  useEffect(() => {
    if (editingIdx !== null) setTimeout(() => editInputRef.current?.focus(), 30);
  }, [editingIdx]);

  // 重命名
  const commitRename = async (idx: number) => {
    const trimmed = editVal.trim();
    if (!trimmed) { setEditingIdx(null); return; }
    const oldName = categories[idx];
    if (trimmed === oldName) { setEditingIdx(null); return; }
    if (categories.includes(trimmed)) {
      toast.error("该分类名已存在");
      return;
    }
    if (!confirmWrite("修改", `将分类「${oldName}」重命名为「${trimmed}」。`)) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      speciesCategories: latest.speciesCategories.map((c, i) => (i === idx ? trimmed : c)),
      // 同步更新所有使用旧名的物种
      species: latest.species.map((sp) => sp.category === oldName ? { ...sp, category: trimmed } : sp),
    }));
    if (!ok) return toast.error("保存失败，请重试");
    setEditingIdx(null);
    toast.success(`已重命名为「${trimmed}」`);
  };

  // 删除
  const confirmDelete = async () => {
    if (deletingIdx === null) return;
    const name = categories[deletingIdx];
    if (!confirmWrite("删除", `将删除分类「${name}」。`)) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      speciesCategories: latest.speciesCategories.filter((_, i) => i !== deletingIdx),
      // 清空使用该分类的物种的 category 字段
      species: latest.species.map((sp) => sp.category === name ? { ...sp, category: "" } : sp),
    }));
    if (!ok) return toast.error("删除失败，请重试");
    setDeletingIdx(null);
    toast.success(`已删除分类「${name}」`);
  };

  // 新增
  const addCategory = async () => {
    const v = newVal.trim();
    if (!v) return;
    if (categories.includes(v)) { toast.error("该分类名已存在"); return; }
    if (!confirmWrite("新增", `将新增分类「${v}」。`)) return;
    const ok = await saveStateTransform((latest) => ({ ...latest, speciesCategories: [...latest.speciesCategories, v] }));
    if (!ok) return toast.error("保存失败，请重试");
    setNewVal("");
    toast.success(`已新增分类「${v}」`);
  };

  const deletingName = deletingIdx !== null ? categories[deletingIdx] : "";
  const deletingUsage = deletingIdx !== null ? usageCount(deletingName) : 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle>管理分类</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1 max-h-80 overflow-y-auto pr-1">
            {categories.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">暂无分类</p>
            )}
            {categories.map((cat, idx) => {
              const cnt = usageCount(cat);
              const isEditing = editingIdx === idx;
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
                    <span className="flex-1 text-sm truncate">{cat}</span>
                  )}

                  {/* 使用数角标 */}
                  {!isEditing && (
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                      cnt > 0
                        ? "bg-sky-100 text-sky-700"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {cnt} 个物种
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
                        onClick={() => { setEditingIdx(idx); setEditVal(cat); }}
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
              placeholder="输入新分类名…"
              className="h-8 text-sm"
              onKeyDown={(e) => { if (e.key === "Enter") addCategory(); }}
            />
            <Button size="sm" onClick={addCategory} disabled={!newVal.trim()}>
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
            <AlertDialogTitle>删除分类「{deletingName}」</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingUsage > 0
                ? `该分类下有 ${deletingUsage} 个物种，删除后这些物种的分类将被清空，需手动重新指定。确认继续？`
                : "确认删除该分类？此操作无法撤销。"}
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
export function SpeciesView() {
  const { state, saveStateTransform } = useStore();
  const [editing, setEditing] = useState<Species | null>(null);
  const [deleting, setDeleting] = useState<Species | null>(null);
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const permission = usePermission("species");

  const categories = useMemo(
    () => [...(state.speciesCategories ?? [])].sort((a, b) => a.localeCompare(b, "zh-CN")),
    [state.speciesCategories]
  );

  const empty = (): Species => ({
    id: "", name: "", scientificName: "", category: "",
    commonNames: [], description: "", imageUrl: "",
  });

  const startAdd = () => {
    if (!permission.requirePermission("create")) return;
    setEditing(empty());
    setOpen(true);
  };
  const startEdit = (s: Species) => {
    if (!permission.requirePermission("update")) return;
    setEditing({ ...s, commonNames: s.commonNames ?? [] });
    setOpen(true);
  };

  const save = async () => {
    if (!editing) return;
    if (!permission.requirePermission(editing.id ? "update" : "create")) return;
    if (!editing.imageUrl.trim()) return toast.error("请上传物种图片");
    if (!editing.name.trim()) return toast.error("请填写中文名");
    if (!editing.scientificName.trim()) return toast.error("请填写学名");
    if (!editing.category.trim()) return toast.error("请选择或创建分类");
    if (!confirmWrite(editing.id ? "修改" : "新增", editing.id ? "将保存物种信息的修改。" : "将新增一个物种。")) return;
    const ok = await saveStateTransform((latest) => {
      // 如果是新增时输入了一个不在列表里的分类，自动加入
      const cats = latest.speciesCategories ?? [];
      const newCats = cats.includes(editing.category)
        ? cats
        : [...cats, editing.category];
      const exists = latest.species.find((x) => x.id === editing.id);
      return {
        ...latest,
        speciesCategories: newCats,
        species: exists
          ? latest.species.map((x) => (x.id === editing.id ? editing : x))
          : [...latest.species, { ...editing, id: uid() }],
      };
    });
    if (!ok) return toast.error("保存失败，请重试");
    setOpen(false);
    toast.success("已保存");
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `将删除物种「${deleting.name}」。`)) return;
    const deleteId = deleting.id;
    const ok = await saveStateTransform((latest) => ({ ...latest, species: latest.species.filter((x) => x.id !== deleteId) }));
    if (!ok) return toast.error("删除失败，请重试");
    setDeleting(null);
    toast.success("已删除");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h2>物种管理</h2>
          <p className="text-sm text-muted-foreground">维护鱼类物种基础信息</p>
        </div>
        {(permission.canCreate || permission.canUpdate || permission.canDelete) && <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
          <Settings2 className="size-3.5 mr-1.5" />管理分类
        </Button>}
      </div>

      <DataTable
        data={state.species}
        searchKeys={["name", "scientificName", "category", "commonNames"]}
        searchPlaceholder="搜索物种名称、学名、分类、俗名..."
        onAdd={permission.canCreate ? startAdd : undefined}
        addLabel="新增物种"
        columns={[
          {
            key: "image", title: "图片", width: "80px",
            render: (r) => (
              <div className="size-12 rounded-md overflow-hidden bg-muted">
                {r.imageUrl
                  ? <ImageWithFallback src={r.imageUrl} alt={r.name} className="size-full object-cover" />
                  : null}
              </div>
            ),
          },
          { key: "name", title: "中文名" },
          { key: "scientificName", title: "学名" },
          { key: "category", title: "分类" },
          {
            key: "commonNames", title: "俗名",
            render: (r) =>
              (r.commonNames ?? []).length > 0
                ? (r.commonNames ?? []).join("、")
                : <span className="text-muted-foreground text-xs">—</span>,
          },
          { key: "description", title: "描述" },
        ]}
        actions={(row) => (
          <div className="flex justify-end gap-2">
            {permission.canUpdate && <Button size="sm" variant="outline" onClick={() => startEdit(row)}>编辑</Button>}
            {permission.canDelete && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDeleting(row)}>删除</Button>}
          </div>
        )}
      />

      {/* 新增/编辑物种 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "编辑物种" : "新增物种"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label>物种图片<span className="text-red-500 ml-0.5">*</span></Label>
                <ImageUpload value={editing.imageUrl} onChange={(v) => setEditing({ ...editing, imageUrl: v })} />
                <span className="text-xs text-muted-foreground">将作为该物种下商品的默认图片</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>中文名<span className="text-red-500 ml-0.5">*</span></Label>
                  <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="如：小丑鱼" />
                </div>
                <div className="grid gap-2">
                  <Label>学名<span className="text-red-500 ml-0.5">*</span></Label>
                  <Input value={editing.scientificName} onChange={(e) => setEditing({ ...editing, scientificName: e.target.value })} placeholder="拉丁学名" />
                </div>
              </div>
              <div className="grid gap-2">
                <Label>分类<span className="text-red-500 ml-0.5">*</span></Label>
                <CategoryCombobox
                  value={editing.category}
                  onChange={(v) => setEditing({ ...editing, category: v })}
                  options={categories}
                />
              </div>
              <div className="grid gap-2">
                <Label>俗名</Label>
                <CommonNamesInput
                  value={editing.commonNames ?? []}
                  onChange={(v) => setEditing({ ...editing, commonNames: v })}
                />
                <span className="text-xs text-muted-foreground">可添加多个俗名，输入后按 Enter 确认</span>
              </div>
              <div className="grid gap-2">
                <Label>描述</Label>
                <Textarea rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="饲养要点、习性等简要说明" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={save}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 分类管理 */}
      <ManageCategoriesDialog open={manageOpen} onOpenChange={setManageOpen} />

      {/* 删除物种 */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除物种</AlertDialogTitle>
            <AlertDialogDescription>确认删除「{deleting?.name}」？此操作无法撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
