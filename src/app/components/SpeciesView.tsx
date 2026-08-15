import { useState, useRef, useEffect, useMemo, KeyboardEvent } from "react";
import {
  normalizeSpeciesCategoryMajorMap,
  SPECIES_MAJOR_CATEGORIES,
  Species,
  SpeciesMajorCategoryKey,
  speciesMajorCategoryLabel,
  uid,
  useStore,
} from "../store";
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
import { ChevronDown, Check, X } from "lucide-react";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";

type CategoryOption = {
  name: string;
  majorCategory: SpeciesMajorCategoryKey;
};

// ── 小类下拉（按固定大类分组）──────────────────────────────
function CategoryCombobox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: CategoryOption[];
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
    () => options.filter((option) =>
      `${option.name} ${speciesMajorCategoryLabel(option.majorCategory)}`.toLocaleLowerCase("zh-CN")
        .includes(q.toLocaleLowerCase("zh-CN"))
    ),
    [options, q]
  );

  const pick = (v: string) => { onChange(v); setOpen(false); setQ(""); };
  const selected = options.find((option) => option.name === value);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className={`w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm bg-background hover:bg-accent/40 transition-colors ${!value ? "text-muted-foreground" : ""}`}
        onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 50); }}
      >
        <span className="min-w-0 truncate">
          {selected ? `${speciesMajorCategoryLabel(selected.majorCategory)} · ${selected.name}` : "请选择小类"}
        </span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-2 border-b">
            <Input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索大类或小类…"
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Escape") { setOpen(false); setQ(""); }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                无匹配小类，请到后台管理的分类管理中新增
              </div>
            )}
            {SPECIES_MAJOR_CATEGORIES.map((majorCategory) => {
              const group = filtered.filter((option) => option.majorCategory === majorCategory.key);
              if (group.length === 0) return null;
              return (
                <div key={majorCategory.key}>
                  <div className="border-y bg-muted/40 px-3 py-1.5 text-xs font-semibold text-muted-foreground first:border-t-0">
                    {majorCategory.label}
                  </div>
                  {group.map((option) => (
                    <button
                      key={option.name}
                      type="button"
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                      onClick={() => pick(option.name)}
                    >
                      <Check className={`size-3.5 shrink-0 ${value === option.name ? "opacity-100 text-sky-600" : "opacity-0"}`} />
                      {option.name}
                    </button>
                  ))}
                </div>
              );
            })}
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

// ── 主组件 ────────────────────────────────────────────────────
export function SpeciesView() {
  const { state, saveStateTransform } = useStore();
  const [editing, setEditing] = useState<Species | null>(null);
  const [deleting, setDeleting] = useState<Species | null>(null);
  const [open, setOpen] = useState(false);
  const permission = usePermission("species");

  const categoryMajorMap = useMemo(
    () => normalizeSpeciesCategoryMajorMap(state.speciesCategories, state.speciesCategoryMajorMap),
    [state.speciesCategories, state.speciesCategoryMajorMap]
  );
  const categories = useMemo(() => {
    const majorOrder = new Map(SPECIES_MAJOR_CATEGORIES.map((category, index) => [category.key, index]));
    return [...(state.speciesCategories ?? [])]
      .map((name): CategoryOption => ({
        name,
        majorCategory: categoryMajorMap[name] ?? "marineFish",
      }))
      .sort((a, b) =>
        (majorOrder.get(a.majorCategory) ?? 0) - (majorOrder.get(b.majorCategory) ?? 0) ||
        a.name.localeCompare(b.name, "zh-CN")
      );
  }, [categoryMajorMap, state.speciesCategories]);

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
    if (!editing.category.trim()) return toast.error("请选择小类");
    if (!state.speciesCategories.includes(editing.category)) {
      return toast.error("该小类已不存在，请重新选择");
    }
    if (!confirmWrite(editing.id ? "修改" : "新增", editing.id ? "将保存物种信息的修改。" : "将新增一个物种。")) return;
    const ok = await saveStateTransform((latest) => {
      const exists = latest.species.find((x) => x.id === editing.id);
      return {
        ...latest,
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
      <div>
        <div>
          <h2>物种管理</h2>
          <p className="text-sm text-muted-foreground">维护物种基础信息并选择后台已配置的小类</p>
        </div>
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
          {
            key: "majorCategory",
            title: "大类",
            render: (row) => speciesMajorCategoryLabel(categoryMajorMap[row.category] ?? "marineFish"),
          },
          { key: "category", title: "小类" },
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
                <Label>小类<span className="text-red-500 ml-0.5">*</span></Label>
                <CategoryCombobox
                  value={editing.category}
                  onChange={(v) => setEditing({ ...editing, category: v })}
                  options={categories}
                />
                {categories.length === 0 && (
                  <span className="text-xs text-amber-700">请先由管理员在后台管理的分类管理中新增小类</span>
                )}
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
