import { useState, useRef, useEffect, useMemo } from "react";
import { useStore, Product, Species, uid } from "../store";
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
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { ImageUpload } from "./ImageUpload";
import { toast } from "sonner";
import { ChevronDown, Plus, Check, Settings2, Pencil, Trash2, Search } from "lucide-react";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";

function mergeOrigins(origins: string[] = [], products: Product[] = []): string[] {
  const merged: string[] = [];
  const add = (value: string | undefined) => {
    const origin = (value ?? "").trim();
    if (origin && !merged.includes(origin)) merged.push(origin);
  };
  origins.forEach(add);
  products.forEach((product) => add(product.origin));
  return merged;
}

// ── 物种下拉组件（可搜索）──────────────────────────────────────
function SpeciesCombobox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (id: string) => void;
  options: Species[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((species) => species.id === value);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return options;
    return options.filter((species) => {
      const fields = [
        species.name,
        species.scientificName,
        species.category,
        species.description,
        ...(species.commonNames ?? []),
      ];
      return fields.some((field) => String(field ?? "").toLowerCase().includes(term));
    });
  }, [options, q]);

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

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className={`w-full flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm bg-background hover:bg-accent/40 transition-colors ${
          !selected ? "text-muted-foreground" : ""
        }`}
        onClick={() => {
          setOpen((o) => !o);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? selected.name : "选择物种"}
        </span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索物种名、俗名、学名…"
                className="h-8 pl-8 text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setOpen(false); setQ(""); }
                }}
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">无匹配物种</div>
            ) : (
              filtered.map((species) => (
                <button
                  key={species.id}
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left"
                  onClick={() => pick(species.id)}
                >
                  <Check className={`size-3.5 shrink-0 ${value === species.id ? "opacity-100 text-sky-600" : "opacity-0"}`} />
                  <div className="size-8 rounded overflow-hidden border bg-muted shrink-0">
                    {species.imageUrl ? (
                      <ImageWithFallback src={species.imageUrl} alt={species.name} className="size-full object-cover" />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{species.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[species.category, species.scientificName, ...(species.commonNames ?? []).slice(0, 2)]
                        .filter(Boolean)
                        .join(" · ") || "暂无补充信息"}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 产地下拉组件（可搜索 + 内联新增）──────────────────────────
function OriginCombobox({
  value,
  onChange,
  onAdd,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: (v: string) => void;   // 新增产地时同步写入 store
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
        <span>{value || "请选择产地"}</span>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-2 border-b">
            <Input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索或输入新产地…"
              className="h-8 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canAdd) pick(q.trim(), true);
                if (e.key === "Escape") { setOpen(false); setQ(""); }
              }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 && !canAdd && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">无匹配产地</div>
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
                新增产地「{q.trim()}」
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 产地管理弹窗 ───────────────────────────────────────────────
function ManageOriginsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { state, saveStateTransform } = useStore();
  const [draftOrigins, setDraftOrigins] = useState<string[]>([]);
  const [draftProducts, setDraftProducts] = useState<Product[]>([]);
  const origins = draftOrigins;
  const [saving, setSaving] = useState(false);

  // 使用计数
  const usageCount = (origin: string) =>
    draftProducts.filter((p) => p.origin === origin).length;

  // 内联编辑
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editVal, setEditVal] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // 新增
  const [newVal, setNewVal] = useState("");

  // 待删除确认
  const [deletingIdx, setDeletingIdx] = useState<number | null>(null);

  useEffect(() => {
    if (editingIdx !== null) setTimeout(() => editInputRef.current?.focus(), 30);
  }, [editingIdx]);

  useEffect(() => {
    if (!open) return;
    setDraftProducts((state.products ?? []).map((product) => ({ ...product, notes: product.notes ?? "" })));
    setDraftOrigins(mergeOrigins(state.productOrigins ?? [], state.products ?? []));
    setEditingIdx(null);
    setEditVal("");
    setNewVal("");
    setDeletingIdx(null);
  }, [open, state.productOrigins, state.products]);

  // 重命名（同步更新所有使用旧产地的商品）
  const commitRename = (idx: number) => {
    const trimmed = editVal.trim();
    if (!trimmed) { setEditingIdx(null); return; }
    const oldName = origins[idx];
    if (trimmed === oldName) { setEditingIdx(null); return; }
    if (origins.includes(trimmed)) { toast.error("该产地名已存在"); return; }
    setDraftOrigins((list) => list.map((o, i) => (i === idx ? trimmed : o)));
    setDraftProducts((list) => list.map((p) => p.origin === oldName ? { ...p, origin: trimmed } : p));
    setEditingIdx(null);
  };

  // 删除
  const confirmDelete = () => {
    if (deletingIdx === null) return;
    const name = origins[deletingIdx];
    setDraftOrigins((list) => list.filter((_, i) => i !== deletingIdx));
    setDraftProducts((list) => list.map((p) => p.origin === name ? { ...p, origin: "" } : p));
    setDeletingIdx(null);
  };

  // 新增
  const addOrigin = () => {
    const v = newVal.trim();
    if (!v) return;
    if (origins.includes(v)) { toast.error("该产地名已存在"); return; }
    setDraftOrigins((list) => [...list, v]);
    setNewVal("");
  };

  const saveAndClose = async () => {
    let nextOrigins = [...draftOrigins];
    let nextProducts = draftProducts.map((product) => ({ ...product, notes: product.notes ?? "" }));
    if (editingIdx !== null) {
      const trimmed = editVal.trim();
      const oldName = nextOrigins[editingIdx];
      if (trimmed && oldName && trimmed !== oldName) {
        if (nextOrigins.some((origin, idx) => idx !== editingIdx && origin === trimmed)) {
          toast.error("该产地名已存在");
          return;
        }
        nextOrigins = nextOrigins.map((origin, idx) => (idx === editingIdx ? trimmed : origin));
        nextProducts = nextProducts.map((product) => product.origin === oldName ? { ...product, origin: trimmed } : product);
      }
    }
    if (!confirmWrite("保存", "将保存产地列表及相关商品产地修改。")) return;
    setSaving(true);
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      productOrigins: nextOrigins,
      products: nextProducts,
    }));
    setSaving(false);
    if (!ok) {
      toast.error("保存失败，请不要关闭弹窗，稍后重试");
      return;
    }
    toast.success("产地已保存");
    onOpenChange(false);
  };

  const deletingName = deletingIdx !== null ? origins[deletingIdx] : "";
  const deletingUsage = deletingIdx !== null ? usageCount(deletingName) : 0;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle>管理产地</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-1 max-h-80 overflow-y-auto pr-1">
            {origins.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-6">暂无产地</p>
            )}
            {origins.map((origin, idx) => {
              const cnt = usageCount(origin);
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
                    <span className="flex-1 text-sm truncate">{origin}</span>
                  )}

                  {/* 使用数角标 */}
                  {!isEditing && (
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                      cnt > 0
                        ? "bg-sky-100 text-sky-700"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {cnt} 个商品
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
                        onClick={() => { setEditingIdx(idx); setEditVal(origin); }}
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
              placeholder="输入新产地名…"
              className="h-8 text-sm"
              onKeyDown={(e) => { if (e.key === "Enter") addOrigin(); }}
            />
            <Button size="sm" onClick={addOrigin} disabled={!newVal.trim() || saving}>
              <Plus className="size-3.5 mr-1" />新增
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>取消</Button>
            <Button onClick={saveAndClose} disabled={saving}>
              {saving ? "保存中..." : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={deletingIdx !== null} onOpenChange={(o) => !o && setDeletingIdx(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除产地「{deletingName}」</AlertDialogTitle>
            <AlertDialogDescription>
              {deletingUsage > 0
                ? `该产地下有 ${deletingUsage} 个商品，删除后这些商品的产地将被清空，需手动重新指定。确认继续？`
                : "确认删除该产地？此操作无法撤销。"}
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
type ProductRow = Product & {
  speciesSearch: string;
};

export function ProductsView() {
  const { state, saveProduct, saveStateTransform } = useStore();
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [open, setOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [speciesCard, setSpeciesCard] = useState<Species | null>(null);
  const [previewImage, setPreviewImage] = useState<{ src: string; title: string } | null>(null);
  const [priceStr, setPriceStr] = useState<string>("");
  const [commissionStr, setCommissionStr] = useState<string>("");
  const [savingProduct, setSavingProduct] = useState(false);
  const permission = usePermission("products");
  const isAdmin = state.user?.role === "admin";

  // 产地列表来自 store，排序后展示
  const allOrigins = useMemo(
    () => mergeOrigins(state.productOrigins ?? [], state.products ?? []).sort((a, b) => a.localeCompare(b, "zh-CN")),
    [state.productOrigins, state.products]
  );

  const speciesName = (id: string) => state.species.find((s) => s.id === id)?.name ?? "—";
  const speciesImage = (id: string) => state.species.find((s) => s.id === id)?.imageUrl ?? "";
  const speciesById = (id: string) => state.species.find((s) => s.id === id);
  const productRows = useMemo<ProductRow[]>(
    () => state.products.map((product) => {
      const species = speciesById(product.speciesId);
      const speciesSearch = species
        ? [
            species.name,
            species.category,
            species.scientificName,
            species.description,
            ...(species.commonNames ?? []),
          ].filter(Boolean).join(" ")
        : "";
      return { ...product, speciesSearch };
    }),
    [state.products, state.species]
  );

  const empty = (): Product => ({
    id: "", speciesId: "", name: "", size: "", origin: "", imageUrl: "", defaultPrice: 0, commissionRate: 0, notes: "",
  });

  const onSpeciesChange = (sid: string) => {
    if (!editing) return;
    const currentDefault = speciesImage(editing.speciesId);
    const useDefault = !editing.imageUrl || editing.imageUrl === currentDefault;
    setEditing({ ...editing, speciesId: sid, imageUrl: useDefault ? speciesImage(sid) : editing.imageUrl });
  };

  // 新产地随商品保存一起写入后端，避免下拉选择时提前落库。
  const addOriginToStore = (origin: string) => {
    void origin;
  };

  const save = async () => {
    if (!editing) return;
    if (!permission.requirePermission(editing.id ? "update" : "create")) return;
    if (!editing.speciesId) return toast.error("请选择所属物种");
    if (!editing.name.trim()) return toast.error("请填写商品名");
    if (!editing.size.trim()) return toast.error("请填写规格");
    if (!editing.origin.trim()) return toast.error("产地为必填项，请选择或新增产地");
    const price = parseFloat(priceStr);
    if (isNaN(price) || price <= 0) return toast.error("请填写销售默认价");
    const commissionRate = commissionStr.trim() === "" ? 0 : Number(commissionStr);
    if (Number.isNaN(commissionRate) || commissionRate < 0) return toast.error("提成比例不能小于 0");
    const finalEditing = {
      ...editing,
      id: editing.id || uid(),
      notes: editing.notes?.trim() ?? "",
      defaultPrice: isNaN(price) ? 0 : price,
      commissionRate: isAdmin ? Number(commissionRate.toFixed(4)) : Number(editing.commissionRate ?? 0),
    };
    if (!confirmWrite(editing.id ? "修改" : "新增", editing.id ? "将保存商品信息的修改。" : "将新增一个商品。")) return;
    setSavingProduct(true);
    const ok = await saveProduct(finalEditing);
    setSavingProduct(false);
    if (!ok) {
      toast.error("保存失败，请不要关闭弹窗，稍后重试");
      return;
    }
    setOpen(false);
    toast.success("已保存");
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `将删除商品「${deleting.name}」。`)) return;
    const deleteId = deleting.id;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      products: latest.products.filter((x) => x.id !== deleteId),
    }));
    if (!ok) {
      toast.error("删除失败，请重试");
      return;
    }
    setDeleting(null);
    toast.success("已删除");
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div>
          <h2>商品管理</h2>
          <p className="text-sm text-muted-foreground">基于物种维护具体商品规格、图片与售价</p>
        </div>
        {(permission.canCreate || permission.canUpdate || permission.canDelete) && <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
          <Settings2 className="size-3.5 mr-1.5" />管理产地
        </Button>}
      </div>

      <DataTable
        data={productRows}
        searchKeys={["name", "size", "origin", "notes", "speciesSearch"]}
        searchPlaceholder="搜索商品名称、所属物种、规格、产地、备注..."
        onAdd={permission.canCreate ? () => { setEditing(empty()); setPriceStr(""); setCommissionStr(""); setOpen(true); } : undefined}
        addLabel="新增商品"
        columns={[
          {
            key: "image", title: "图片", width: "80px",
            render: (r) => (
              r.imageUrl ? (
                <button
                  type="button"
                  className="size-12 overflow-hidden rounded-md bg-muted ring-offset-background transition hover:ring-2 hover:ring-sky-400 hover:ring-offset-2"
                  title="点击查看大图"
                  onClick={() => setPreviewImage({ src: r.imageUrl, title: r.name })}
                >
                  <ImageWithFallback src={r.imageUrl} alt={r.name} className="size-full object-cover" />
                </button>
              ) : (
                <div className="size-12 rounded-md bg-muted" />
              )
            ),
          },
          { key: "name", title: "商品名" },
          {
            key: "species",
            title: "所属物种",
            render: (r) => {
              const species = speciesById(r.speciesId);
              if (!species) return "—";
              return (
                <button
                  type="button"
                  className="font-medium text-sky-700 hover:text-sky-900 hover:underline"
                  onClick={() => setSpeciesCard(species)}
                >
                  {species.name}
                </button>
              );
            },
          },
          { key: "size", title: "规格" },
          { key: "origin", title: "产地" },
          { key: "defaultPrice", title: "销售默认价(¥)", render: (r) => Number(r.defaultPrice || 0).toFixed(2) },
          { key: "commissionRate", title: "提成比例", render: (r) => `${Number(r.commissionRate ?? 0).toFixed(2)}%` },
          {
            key: "notes",
            title: "备注",
            render: (r) => (
              <span className="block max-w-[220px] truncate text-muted-foreground">
                {r.notes?.trim() || "—"}
              </span>
            ),
          },
        ]}
        actions={(row) => (
          <div className="flex justify-end gap-2">
            {permission.canUpdate && <Button size="sm" variant="outline" onClick={() => {
              const { speciesSearch, ...product } = row;
              setEditing({ ...product, commissionRate: Number(product.commissionRate ?? 0), notes: product.notes ?? "" });
              setPriceStr(String(row.defaultPrice));
              setCommissionStr(String(row.commissionRate ?? 0));
              setOpen(true);
            }}>编辑</Button>}
            {permission.canDelete && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDeleting(row)}>删除</Button>}
          </div>
        )}
      />

      {/* 新增/编辑弹窗 */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{editing?.id ? "编辑商品" : "新增商品"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label>所属物种<span className="text-red-500 ml-0.5">*</span></Label>
                <SpeciesCombobox
                  value={editing.speciesId}
                  onChange={onSpeciesChange}
                  options={state.species}
                />
              </div>
              <div className="grid gap-2">
                <Label>商品名<span className="text-red-500 ml-0.5">*</span></Label>
                <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>规格<span className="text-red-500 ml-0.5">*</span></Label>
                  <Input value={editing.size} onChange={(e) => setEditing({ ...editing, size: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>产地<span className="text-red-500 ml-0.5">*</span></Label>
                  <OriginCombobox
                    value={editing.origin}
                    onChange={(v) => setEditing({ ...editing, origin: v })}
                    onAdd={addOriginToStore}
                    options={allOrigins}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label>销售默认价(¥)<span className="text-red-500 ml-0.5">*</span></Label>
                <Input
                  type="number"
                  value={priceStr}
                  onChange={(e) => setPriceStr(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="grid gap-2">
                <Label>销售提成比例(%)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={commissionStr}
                  onChange={(e) => setCommissionStr(e.target.value)}
                  placeholder="0"
                  disabled={!isAdmin}
                />
                {!isAdmin && <span className="text-xs text-muted-foreground">仅管理员可修改提成比例</span>}
              </div>
              <div className="grid gap-2">
                <Label>备注</Label>
                <Textarea
                  rows={3}
                  value={editing.notes ?? ""}
                  onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  placeholder="选填"
                />
              </div>
              <div className="grid gap-2">
                <Label>商品图片</Label>
                <ImageUpload value={editing.imageUrl} onChange={(v) => setEditing({ ...editing, imageUrl: v })} />
                <span className="text-xs text-muted-foreground">默认使用所属物种的图片，可上传本地图片覆盖</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={savingProduct}>取消</Button>
            <Button onClick={save} disabled={savingProduct}>{savingProduct ? "保存中..." : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除商品</AlertDialogTitle>
            <AlertDialogDescription>确认删除「{deleting?.name}」？</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 产地管理弹窗 */}
      <ManageOriginsDialog open={manageOpen} onOpenChange={setManageOpen} />

      {/* 商品图片大图预览 */}
      <Dialog open={!!previewImage} onOpenChange={(o) => !o && setPreviewImage(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{previewImage?.title ?? "商品图片"}</DialogTitle>
          </DialogHeader>
          <div className="flex max-h-[75vh] items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
            {previewImage?.src && (
              <ImageWithFallback
                src={previewImage.src}
                alt={previewImage.title}
                className="max-h-[75vh] max-w-full object-contain"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* 物种介绍卡片 */}
      <Dialog open={!!speciesCard} onOpenChange={(o) => !o && setSpeciesCard(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>物种介绍</DialogTitle>
          </DialogHeader>
          {speciesCard && (
            <div className="flex flex-col gap-4 sm:flex-row">
              <div className="size-32 shrink-0 overflow-hidden rounded-lg bg-muted">
                {speciesCard.imageUrl ? (
                  <ImageWithFallback src={speciesCard.imageUrl} alt={speciesCard.name} className="size-full object-cover" />
                ) : null}
              </div>
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <h3 className="text-xl font-semibold">{speciesCard.name}</h3>
                  <p className="text-sm text-muted-foreground">{speciesCard.category || "未分类"}</p>
                </div>
                <div className="grid gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">拉丁文学名：</span>
                    <span>{speciesCard.scientificName || "—"}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">其他俗名：</span>
                    <span>{speciesCard.commonNames?.length ? speciesCard.commonNames.join("、") : "—"}</span>
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto rounded-md border bg-slate-50 p-3 text-sm leading-relaxed whitespace-pre-wrap">
                  {speciesCard.description?.trim() || "暂无简介"}
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSpeciesCard(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
