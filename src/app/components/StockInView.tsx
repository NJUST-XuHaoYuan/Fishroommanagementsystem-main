import { useState, useMemo, useRef, useEffect } from "react";
import { useStore, PurchaseBatch, StockItem, StockStatus, uid } from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { StatusBadge, StatusLegend, statusRingClass, statusFrameClass } from "./StatusIcon";
import { Search, ChevronDown, Trash2, Check, ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import { getShippedOutStockIds, isPhysicallyInTank } from "../utils/inventory";
import { usePermission } from "../utils/permissions";
import { buildStockPriceBaselines, isStockSpecialPrice } from "../utils/stockPricing";
import { buildPublicSelectionCode, parsePublicSelectionCode } from "../utils/publicSelectionCode";

function buildStockItems(item: StockItem, quantity: number): StockItem[] {
  return item.id
    ? [item]
    : Array.from({ length: quantity }, () => ({ ...item, id: uid() }));
}

/** 支持模糊查询的商品选择器 */
function ProductCombobox({
  products,
  value,
  onChange,
}: {
  products: { id: string; name: string; size?: string; origin?: string; imageUrl?: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = products.find((p) => p.id === value);
  const filtered = useMemo(
    () =>
      q.trim()
        ? products.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()))
        : products,
    [q, products]
  );

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
        className="w-full flex items-center justify-between h-9 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs hover:bg-accent hover:text-accent-foreground"
        onClick={() => {
          setOpen((v) => !v);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
      >
        <span className={selected ? "text-foreground" : "text-muted-foreground"}>
          {selected ? selected.name : "请选择商品"}
        </span>
        <ChevronDown className="size-4 text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border bg-popover shadow-md flex flex-col">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                ref={inputRef}
                className="w-full h-8 pl-8 pr-3 text-sm rounded-sm border bg-background outline-none focus:ring-1 focus:ring-ring"
                placeholder="输入商品名搜索…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">无匹配商品</div>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent text-left ${
                    p.id === value ? "bg-accent/60" : ""
                  }`}
                  onClick={() => pick(p.id)}
                >
                  {p.imageUrl && (
                    <div className="size-6 rounded overflow-hidden border shrink-0">
                      <ImageWithFallback src={p.imageUrl} alt="" className="size-full object-cover" />
                    </div>
                  )}
                  <span className="flex-1 truncate">{p.name}</span>
                  {(p.size || p.origin) && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {[p.size, p.origin].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 支持按到货日期、批次号、供应商搜索的批次选择器 */
function BatchCombobox({
  batches,
  value,
  onChange,
}: {
  batches: PurchaseBatch[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const sorted = useMemo(
    () =>
      [...batches].sort((a, b) => {
        const byDate = b.arrivalDate.localeCompare(a.arrivalDate);
        return byDate || b.batchNo.localeCompare(a.batchNo);
      }),
    [batches]
  );

  const selected = batches.find((b) => b.id === value);
  const normalizedQuery = q.trim().toLowerCase().replace(/[./]/g, "-");
  const compactQuery = normalizedQuery.replace(/-/g, "");
  const filtered = useMemo(() => {
    if (!normalizedQuery) return sorted;
    return sorted.filter((b) => {
      const date = b.arrivalDate.toLowerCase();
      const compactDate = date.replace(/-/g, "");
      return (
        b.batchNo.toLowerCase().includes(normalizedQuery) ||
        b.supplier.toLowerCase().includes(normalizedQuery) ||
        date.includes(normalizedQuery) ||
        compactDate.includes(compactQuery)
      );
    });
  }, [compactQuery, normalizedQuery, sorted]);

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
        className="w-full flex items-center justify-between h-9 rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs hover:bg-accent hover:text-accent-foreground"
        onClick={() => {
          setOpen((v) => !v);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
      >
        <span className={selected ? "text-foreground truncate" : "text-muted-foreground"}>
          {selected
            ? `${selected.batchNo} · ${selected.supplier} · ${selected.arrivalDate}`
            : "请选择采购批次"}
        </span>
        <ChevronDown className="size-4 text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-md border bg-popover shadow-md flex flex-col">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                ref={inputRef}
                className="w-full h-8 pl-8 pr-3 text-sm rounded-sm border bg-background outline-none focus:ring-1 focus:ring-ring"
                placeholder="搜索批次号、供应商、到货日期…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">无匹配批次</div>
            ) : (
              filtered.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-accent text-left ${
                    b.id === value ? "bg-accent/60" : ""
                  }`}
                  onClick={() => pick(b.id)}
                >
                  <span className="font-mono text-sky-700 shrink-0">{b.batchNo}</span>
                  <span className="flex-1 min-w-0 truncate">{b.supplier}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{b.arrivalDate}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StockInView() {
  const { state, saveStockChange } = useStore();
  const permission = usePermission("stockIn");
  const isAdmin = state.user?.role === "admin";
  const [q, setQ] = useState("");
  const [publicLookupCode, setPublicLookupCode] = useState("");
  const [highlightStockId, setHighlightStockId] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<StockItem | null>(null);
  const [del, setDel] = useState<StockItem | null>(null);
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[]>([]);
  const [saveConfirm, setSaveConfirm] = useState<{ stockItems: StockItem[]; qty: number; isEdit: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [fromSubTank, setFromSubTank] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const today = new Date().toISOString().slice(0, 10);
  const shippedOutStockIds = getShippedOutStockIds(state.shipments);
  const product = (id: string) => state.products.find((p) => p.id === id);
  const batch = (id: string) => state.batches.find((b) => b.id === id);
  const priceBaselineByProduct = useMemo(
    () => buildStockPriceBaselines(
      state.stock.filter((item) => !item.lost && isPhysicallyInTank(item, shippedOutStockIds)),
      state.products,
    ),
    [state.stock, state.products, shippedOutStockIds],
  );
  const isSpecialPrice = (item: StockItem) => {
    return isStockSpecialPrice(item, product(item.productId), priceBaselineByProduct);
  };
  const priceBadgeText = (item: StockItem) => `¥${Number(item.basePrice ?? 0).toFixed(0)}`;
  const batchCommissionMultiplier = (batchId: string) => Number(batch(batchId)?.commissionMultiplier ?? 100);
  const defaultCommissionRate = (productId: string, batchId: string) => {
    const productRate = Number(product(productId)?.commissionRate ?? 0);
    const multiplier = batchCommissionMultiplier(batchId);
    return Number((productRate * multiplier / 100).toFixed(4));
  };
  const stockLockedByOrder = (id: string) =>
    state.orders.some((order) =>
      order.status !== "cancelled" && order.items.some((item) => item.stockItemId === id)
    );
  const stockCannotDelete = (item: StockItem) => Boolean(item.sold) || stockLockedByOrder(item.id);
  const latestBatchId = () =>
    [...state.batches].sort((a, b) => {
      const byDate = b.arrivalDate.localeCompare(a.arrivalDate);
      return byDate || b.batchNo.localeCompare(a.batchNo);
    })[0]?.id ?? "";

  const groupIdOfSubTank = (subTankId: string) =>
    state.tankGroups.find((g) => g.subTanks.some((t) => t.id === subTankId))?.id ?? "";

  const empty = (subTankId = ""): StockItem => {
    const defaultProduct = state.products[0];
    return {
      id: "",
      productId: defaultProduct?.id ?? "",
      batchId: latestBatchId(),
      subTankId,
      status: "healthy",
      inDate: today,
      basePrice: defaultProduct?.defaultPrice ?? 0,
      commissionRate: defaultCommissionRate(defaultProduct?.id ?? "", latestBatchId()),
      code: "",
      notes: "",
    };
  };

  const changeProduct = (productId: string) => {
    if (!editing) return;
    const currentDefault = product(editing.productId)?.defaultPrice ?? 0;
    const nextDefault = product(productId)?.defaultPrice ?? 0;
    const currentCommissionDefault = defaultCommissionRate(editing.productId, editing.batchId);
    const nextCommissionDefault = defaultCommissionRate(productId, editing.batchId);
    const shouldUseProductDefault = !editing.basePrice || editing.basePrice === currentDefault;
    const shouldUseCommissionDefault = editing.commissionRate == null || Number(editing.commissionRate) === currentCommissionDefault;
    setEditing({
      ...editing,
      productId,
      basePrice: shouldUseProductDefault ? nextDefault : editing.basePrice,
      commissionRate: shouldUseCommissionDefault ? nextCommissionDefault : editing.commissionRate,
    });
  };
  const changeBatch = (batchId: string) => {
    if (!editing) return;
    const nextBatch = batch(batchId);
    const currentCommissionDefault = defaultCommissionRate(editing.productId, editing.batchId);
    const nextCommissionDefault = defaultCommissionRate(editing.productId, batchId);
    const shouldUseCommissionDefault = editing.commissionRate == null || Number(editing.commissionRate) === currentCommissionDefault;
    setEditing({
      ...editing,
      batchId,
      inDate: nextBatch && editing.inDate && editing.inDate < nextBatch.arrivalDate
        ? nextBatch.arrivalDate
        : editing.inDate,
      commissionRate: shouldUseCommissionDefault ? nextCommissionDefault : editing.commissionRate,
    });
  };
  const changeInDate = (inDate: string) => {
    if (!editing) return;
    if (inDate && inDate > today) {
      toast.error("入库日期不能晚于今天");
      return;
    }
    const currentBatch = batch(editing.batchId);
    if (currentBatch && inDate && inDate < currentBatch.arrivalDate) {
      toast.error("入库日期不能早于采购批次到货日期");
      return;
    }
    setEditing({ ...editing, inDate });
  };

  const openDialog = (item: StockItem, subTankMode = false) => {
    if (!permission.requirePermission(item.id ? "update" : "create")) return;
    if (item.id && stockCannotDelete(item)) {
      toast.error("已售或已关联订单的商品不能在入库模块编辑或删除");
      return;
    }
    setEditing({
      ...item,
      commissionRate: item.commissionRate ?? defaultCommissionRate(item.productId, item.batchId),
    });
    setFromSubTank(subTankMode);
    setQuantity("1");
    const gid = item.subTankId
      ? groupIdOfSubTank(item.subTankId)
      : state.tankGroups[0]?.id ?? "";
    setSelectedGroupId(gid);
    setOpen(true);
  };

  const locatePublicLookupCode = () => {
    const candidates = parsePublicSelectionCode(publicLookupCode).map((item) => item.toLowerCase());
    if (candidates.length === 0) {
      toast.error("请粘贴公开页复制的选鱼码");
      return;
    }

    const target = state.stock.find((item) => {
      const itemCandidates = [
        item.id,
        item.code,
        buildPublicSelectionCode(item.id),
      ]
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter(Boolean);
      return itemCandidates.some((candidate) => candidates.includes(candidate));
    });

    if (!target) {
      toast.error("没有找到对应库存商品，请确认选鱼码是否完整");
      return;
    }

    const groupId = groupIdOfSubTank(target.subTankId);
    const productName = product(target.productId)?.name ?? target.productId;
    setQ("");
    setHighlightStockId(target.id);
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.add(`${target.subTankId}-${target.productId}`);
      return next;
    });

    window.setTimeout(() => {
      const element = [...document.querySelectorAll<HTMLElement>("[data-stock-item-id]")]
        .find((node) => node.dataset.stockItemId === target.id);
      element?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }, 80);

    window.setTimeout(() => {
      setHighlightStockId((current) => current === target.id ? "" : current);
    }, 8000);

    if (groupId) setSelectedGroupId(groupId);
    if (permission.canUpdate && !stockCannotDelete(target)) {
      openDialog({ ...target }, false);
      toast.success(`已打开：${productName}`);
      return;
    }

    toast.success(`已定位：${productName}`);
  };

  const subTanksOfGroup = useMemo(
    () => state.tankGroups.find((g) => g.id === selectedGroupId)?.subTanks ?? [],
    [selectedGroupId, state.tankGroups]
  );
  const editingBatch = editing ? batch(editing.batchId) : undefined;

  const filteredGroups = useMemo(() => {
    if (!q.trim()) return state.tankGroups;
    const term = q.toLowerCase();
    return state.tankGroups.filter(
      (g) =>
        g.name.toLowerCase().includes(term) ||
        g.subTanks.some((t) => t.name.toLowerCase().includes(term)) ||
        state.stock.some((s) => {
          if (!isPhysicallyInTank(s, shippedOutStockIds)) return false;
          if (!g.subTanks.find((t) => t.id === s.subTankId)) return false;
	          const p = product(s.productId);
	          return (
	            p?.name.toLowerCase().includes(term) ||
	            String(s.code ?? "").toLowerCase().includes(term)
	          );
	        })
    );
  }, [q, state, shippedOutStockIds]);

  const stockBySub = (subId: string) =>
    state.stock.filter((s) => s.subTankId === subId && isPhysicallyInTank(s, shippedOutStockIds));

  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const stockById = new Map(state.stock.map((item) => [item.id, item]));
      const next = new Set([...prev].filter((id) => {
        const item = stockById.get(id);
        return item && !stockCannotDelete(item);
      }));
      return next.size === prev.size ? prev : next;
    });
  }, [state.stock, state.orders]);

  const save = async () => {
    if (!editing) return;
    if (!permission.requirePermission(editing.id ? "update" : "create")) return;
    if (!editing.productId) return toast.error("请选择商品");
    if (!editing.batchId) return toast.error("请选择采购批次");
    if (!editing.inDate) return toast.error("请选择入库日期");
    if (editing.inDate > today) return toast.error("入库日期不能晚于今天");
    const currentBatch = batch(editing.batchId);
    if (currentBatch && editing.inDate < currentBatch.arrivalDate) return toast.error("入库日期不能早于采购批次到货日期");
    const basePrice = Number(editing.basePrice || product(editing.productId)?.defaultPrice || 0);
    if (!basePrice || basePrice <= 0) return toast.error("请填写单条售价");
    const commissionRate = Number(editing.commissionRate ?? 0);
    if (Number.isNaN(commissionRate) || commissionRate < 0) return toast.error("提成比例不能小于 0");
    if (!fromSubTank && !selectedGroupId) return toast.error("请选择缸组");
    if (!editing.subTankId) return toast.error("请选择子缸");
    const parsedQty = Number(quantity);
    if (fromSubTank && !editing.id && (!quantity.trim() || !Number.isInteger(parsedQty) || parsedQty <= 0)) {
      return toast.error("请填写大于 0 的入库数量");
    }
    const qty = fromSubTank && !editing.id ? parsedQty : 1;
    const stockItems = buildStockItems({ ...editing, basePrice: Number(basePrice.toFixed(2)), commissionRate: Number(commissionRate.toFixed(4)) }, qty);
    setSaveConfirm({ stockItems, qty, isEdit: Boolean(editing.id) });
  };

  const confirmSave = async () => {
    if (!saveConfirm) return;
    setSaving(true);
    const ok = await saveStockChange({ upsert: saveConfirm.stockItems });
    setSaving(false);
    if (!ok) {
      toast.error("保存失败，请重试");
      return;
    }
    const qty = saveConfirm.qty;
    setSaveConfirm(null);
    setOpen(false);
    toast.success(saveConfirm.isEdit ? "已保存入库记录" : qty > 1 ? `已入库 ${qty} 条` : "已入库");
  };

  const confirmDelete = async () => {
    if (!del) return;
    if (!permission.requirePermission("delete")) return;
    if (stockCannotDelete(del)) return toast.error("该鱼已售或已关联订单，不能删除入库记录");
    setSaving(true);
    const ok = await saveStockChange({ deleteIds: [del.id] });
    setSaving(false);
    if (!ok) {
      toast.error("删除失败，请重试");
      return;
    }
    setDel(null);
    toast.success("已删除");
  };

  const toggleSelected = (id: string) => {
    if (!selectMode) return;
    const item = state.stock.find((stock) => stock.id === id);
    if (!item || stockCannotDelete(item)) {
      toast.error("已售或已关联订单的商品不能批量删除");
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const enterSelectMode = () => {
    if (!permission.requirePermission("delete")) return;
    setSelectMode((prev) => {
      const next = !prev;
      if (!next) setSelectedIds(new Set());
      return next;
    });
  };

  const selectableItems = (items: StockItem[]) => items.filter((item) => !stockCannotDelete(item));

  const toggleSubTankSelection = (items: StockItem[]) => {
    if (!permission.requirePermission("delete")) return;
    const ids = selectableItems(items).map((item) => item.id);
    if (ids.length === 0) {
      toast.error("该子缸没有可删除的入库记录");
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      ids.forEach((id) => {
        allSelected ? next.delete(id) : next.add(id);
      });
      return next;
    });
  };

  const speciesIdOfProduct = (productId: string) => product(productId)?.speciesId ?? productId;

  const selectableSpeciesIds = (items: StockItem[], speciesId: string) =>
    selectableItems(items)
      .filter((item) => speciesIdOfProduct(item.productId) === speciesId)
      .map((item) => item.id);

  const toggleSpeciesSelection = (items: StockItem[], speciesId: string) => {
    if (!permission.requirePermission("delete")) return;
    const ids = selectableSpeciesIds(items, speciesId);
    if (ids.length === 0) {
      toast.error("该物种没有可删除的入库记录");
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = ids.every((id) => next.has(id));
      ids.forEach((id) => {
        allSelected ? next.delete(id) : next.add(id);
      });
      return next;
    });
  };

  const openBulkDelete = () => {
    if (!permission.requirePermission("delete")) return;
    const ids = [...selectedIds].filter((id) => {
      const item = state.stock.find((stock) => stock.id === id);
      return item && isPhysicallyInTank(item, shippedOutStockIds) && !stockCannotDelete(item);
    });
    if (ids.length === 0) return toast.error("请选择要删除的入库记录");
    setBulkDeleteIds(ids);
  };

  const confirmBulkDelete = async () => {
    if (!permission.requirePermission("delete")) return;
    if (bulkDeleteIds.length === 0) return;
    setSaving(true);
    const ok = await saveStockChange({ deleteIds: bulkDeleteIds });
    setSaving(false);
    if (!ok) {
      toast.error("批量删除失败，请重试");
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      bulkDeleteIds.forEach((id) => next.delete(id));
      return next;
    });
    const count = bulkDeleteIds.length;
    setBulkDeleteIds([]);
    setSelectMode(false);
    toast.success(`已删除 ${count} 条入库记录`);
  };

  const groupByProduct = (items: ReturnType<typeof stockBySub>) => {
    const map = new Map<string, typeof items>();
    for (const s of items) {
      const arr = map.get(s.productId) ?? [];
      arr.push(s);
      map.set(s.productId, arr);
    }
    return [...map.entries()];
  };

  const statusMeta: Record<StockStatus, { label: string }> = {
    healthy: { label: "正常" },
    feeding: { label: "开口" },
    sick:    { label: "疾病" },
  };

  const toggleExpand = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2>库存明细</h2>
          <p className="text-sm text-muted-foreground">查看和管理每个子缸内的库存商品</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-2 rounded-lg border bg-white p-1.5 shadow-sm">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={publicLookupCode}
                onChange={(event) => setPublicLookupCode(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    locatePublicLookupCode();
                  }
                }}
                placeholder="粘贴公开选鱼码"
                className="h-8 w-48 border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0"
              />
            </div>
            <Button type="button" size="sm" variant="outline" onClick={locatePublicLookupCode}>
              定位
            </Button>
          </div>
          {permission.canDelete && (
            <>
              <Button
                type="button"
                size="sm"
                variant={selectMode ? "default" : "outline"}
                onClick={enterSelectMode}
              >
                <ArrowRightLeft className="size-3.5 mr-1" />
                批量操作
              </Button>
              {selectMode && (
                <>
                <span className="text-xs text-muted-foreground">已选 {selectedIds.size} 条</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                  disabled={selectedIds.size === 0 || saving}
                  onClick={openBulkDelete}
                >
                  <Trash2 className="size-3.5 mr-1" />
                  批量删除
                </Button>
                </>
              )}
            </>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索缸 / 商品 / 编号..." className="pl-9 w-64" />
          </div>
        </div>
      </div>
      <StatusLegend />

      {/* 缸组列表：每个缸组独占一行 */}
      <div className="flex flex-col gap-4">
        {filteredGroups.map((g) => (
          <Card key={g.id} className="p-5 border-2 border-sky-200 bg-sky-50/30">
            <div className="mb-3">
              <h3>{g.name}</h3>
              <div className="text-xs text-muted-foreground">{g.location}</div>
            </div>
            {/* 子缸横向排列，溢出滚动 */}
            <div className="flex flex-row gap-3 overflow-x-auto pb-1">
              {g.subTanks.map((t) => {
                const items = stockBySub(t.id);
                const grouped = groupByProduct(items);
                const total = items.length;
                const selectableIds = selectableItems(items).map((item) => item.id);
                const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
                return (
                  <div key={t.id} className="bg-white rounded-md border flex flex-col min-w-[220px] flex-shrink-0">
                    {/* 子缸标题行 */}
                    <div className="flex items-center justify-between px-3 py-2 border-b">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{t.name}</span>
                        {total > 0 && (
                          <span className="text-xs bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded-full font-medium">
                            {total} 条
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {selectMode && permission.canDelete && total > 0 && (
                          <button
                            type="button"
                            className="text-xs text-red-600 hover:text-red-800 font-medium disabled:text-muted-foreground"
                            disabled={selectableIds.length === 0}
                            onClick={() => toggleSubTankSelection(items)}
                          >
                            {allSelected ? "取消" : "全选"}
                          </button>
                        )}
	                      {permission.canCreate && (
	                        <button
	                          className="text-xs text-sky-600 hover:text-sky-800 font-medium"
	                          onClick={() => openDialog(empty(t.id), true)}
	                        >
	                          + 入库
	                        </button>
	                      )}
                      </div>
                    </div>

                    {/* 商品分组列表 */}
                    <div className="flex flex-col divide-y">
                      {items.length === 0 && (
                        <div className="px-3 py-3 text-xs text-muted-foreground text-center">空缸</div>
                      )}
                      {grouped.map(([productId, stockItems]) => {
                        const p = product(productId);
                        const key = `${t.id}-${productId}`;
                        const isExpanded = expandedKeys.has(key);
                        const speciesId = speciesIdOfProduct(productId);
                        const sameSpeciesIds = selectableSpeciesIds(items, speciesId);
                        const sameSpeciesSelected =
                          sameSpeciesIds.length > 0 && sameSpeciesIds.every((id) => selectedIds.has(id));

                        const counts = stockItems.reduce((acc, s) => {
                          acc[s.status] = (acc[s.status] ?? 0) + 1;
                          return acc;
                        }, {} as Record<string, number>);

                        return (
                          <div key={productId}>
                            <div
                              role="button"
                              tabIndex={0}
                              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-slate-50 text-left"
                              onClick={() => toggleExpand(key)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  toggleExpand(key);
                                }
                              }}
                            >
                              <div className="size-8 rounded overflow-hidden border bg-muted shrink-0">
                                {p?.imageUrl ? (
                                  <ImageWithFallback src={p.imageUrl} alt={p?.name ?? ""} className="size-full object-cover" />
                                ) : (
                                  <div className="size-full flex items-center justify-center text-[8px] text-muted-foreground leading-tight p-0.5 text-center">
                                    {p?.name}
                                  </div>
                                )}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="text-sm truncate max-w-[7.5rem]">{p?.name ?? productId}</span>
                                  <span className="rounded-md bg-sky-600 px-2 py-1 text-center text-sm font-bold leading-none text-white shadow-sm shrink-0">
                                    X{stockItems.length}
                                  </span>
                                </div>
                                {(p?.size || p?.origin) && (
                                  <div className="flex items-center gap-1 mt-0.5">
                                    {p?.size && <span className="text-[10px] bg-slate-100 text-slate-500 px-1 rounded leading-tight">{p.size}</span>}
                                    {p?.origin && <span className="text-[10px] text-muted-foreground">{p.origin}</span>}
                                  </div>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {(["healthy","feeding","sick"] as StockStatus[])
                                  .filter((st) => counts[st])
                                  .map((st) => (
                                    <span key={st} className="flex items-center gap-0.5">
                                      <span className={`size-3 rounded shrink-0 border-2 ${statusFrameClass(st)}`} />
                                      <span className="text-xs text-muted-foreground">{counts[st]}</span>
                                    </span>
                                  ))}
                              </div>
                              {selectMode && permission.canDelete && (
                                <button
                                  type="button"
                                  className="shrink-0 rounded border border-red-200 px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:border-border disabled:text-muted-foreground"
                                  disabled={sameSpeciesIds.length === 0}
                                  title={`选择当前子缸内同一物种的 ${sameSpeciesIds.length} 条`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleSpeciesSelection(items, speciesId);
                                  }}
                                >
                                  {sameSpeciesSelected ? "取消同种" : "选同种"}
                                </button>
                              )}
                              <ChevronDown
                                className={`size-3.5 text-muted-foreground shrink-0 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                              />
                            </div>

                            {isExpanded && (
                              <div
                                className="grid gap-1.5 px-3 pb-2 pt-1 bg-slate-50 border-t"
                                style={{ gridTemplateColumns: "repeat(auto-fill, 2.25rem)", maxWidth: "27.375rem" }}
                              >
                                {stockItems.map((s) => {
                                  const selected = selectedIds.has(s.id);
                                  const locked = stockCannotDelete(s);
                                  const highlighted = highlightStockId === s.id;
                                  const lockReason = s.sold ? "已售商品，不能删除" : "已关联订单，不能删除";
                                  return (
                                    <div
                                      key={s.id}
                                      data-stock-item-id={s.id}
                                      role="button"
                                      tabIndex={0}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (selectMode) {
                                          if (!locked) toggleSelected(s.id);
                                          return;
                                        }
                                        openDialog({ ...s }, false);
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key !== "Enter" && e.key !== " ") return;
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (selectMode) {
                                          if (!locked) toggleSelected(s.id);
                                          return;
                                        }
                                        openDialog({ ...s }, false);
                                      }}
                                      className={`relative size-9 rounded overflow-hidden bg-muted hover:opacity-80 transition-opacity cursor-pointer ${
                                        highlighted
                                          ? "ring-4 ring-cyan-500 ring-offset-2 ring-offset-white"
                                          : selected ? "ring-2 ring-emerald-500 ring-offset-2" : statusRingClass(s.status, s.sold)
                                      } ${selectMode && locked ? "cursor-not-allowed opacity-50 hover:opacity-50" : ""}`}
                                      title={`${p?.name ?? ""}${s.code ? ` · 编号：${s.code}` : ""} · 售价：¥${Number(s.basePrice ?? 0).toFixed(2)}${isSpecialPrice(s) ? "（特殊价格）" : ""} · ${statusMeta[s.status].label}${selectMode && locked ? ` · ${lockReason}` : ""}`}
                                    >
                                    {p?.imageUrl ? (
                                      <ImageWithFallback src={p.imageUrl} alt={p?.name ?? ""} className="size-full object-cover" />
                                    ) : (
                                      <div className="size-full flex items-center justify-center text-[8px]">{p?.name}</div>
                                    )}
                                    {s.code && (
                                      <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-0.5 text-center text-[9px] font-semibold leading-3 text-white">
                                        {s.code}
                                      </span>
                                    )}
                                    {isSpecialPrice(s) && (
                                      <span className="absolute left-0 top-0 z-10 max-w-full truncate rounded-br bg-amber-400 px-0.5 text-[8px] font-bold leading-3 text-amber-950 shadow-sm">
                                        {priceBadgeText(s)}
                                      </span>
                                    )}
                                    <StatusBadge sold={s.sold} />
                                    {selected && (
                                      <div className="absolute inset-0 z-10 bg-emerald-500/35 flex items-center justify-center pointer-events-none">
                                        <Check className="size-4 text-white drop-shadow" />
                                      </div>
                                    )}
                                  </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>
              {editing?.id
                ? "编辑入库记录"
                : fromSubTank
                  ? `入库 · ${(() => {
                      for (const g of state.tankGroups) {
                        const t = g.subTanks.find((x) => x.id === editing?.subTankId);
                        if (t) return `${g.name} / ${t.name}`;
                      }
                      return "";
                    })()}`
                  : "新增入库"}
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label><span className="text-red-500">*</span> 商品</Label>
	                <ProductCombobox
	                  products={state.products}
	                  value={editing.productId}
	                  onChange={changeProduct}
	                />
              </div>

              <div className="grid gap-2">
                <Label><span className="text-red-500">*</span> 采购批次</Label>
                <BatchCombobox
                  batches={state.batches}
                  value={editing.batchId}
                  onChange={changeBatch}
                />
              </div>

              {!fromSubTank && (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label><span className="text-red-500">*</span> 缸组</Label>
                    <Select
                      value={selectedGroupId}
                      onValueChange={(v) => {
                        setSelectedGroupId(v);
                        setEditing((prev) => prev ? { ...prev, subTankId: "" } : prev);
                      }}
                    >
                      <SelectTrigger><SelectValue placeholder="请选择缸组" /></SelectTrigger>
                      <SelectContent>
                        {state.tankGroups.map((g) => (
                          <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label><span className="text-red-500">*</span> 子缸</Label>
                    <Select
                      value={editing.subTankId}
                      onValueChange={(v) => setEditing({ ...editing, subTankId: v })}
                      disabled={!selectedGroupId || subTanksOfGroup.length === 0}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={selectedGroupId ? "请选择子缸" : "先选缸组"} />
                      </SelectTrigger>
                      <SelectContent>
                        {subTanksOfGroup.map((t) => (
                          <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}

              {editing.id ? (
                <div className="grid gap-2">
                  <Label>入库日期</Label>
                  <Input
                    type="date"
                    value={editing.inDate}
                    min={editingBatch?.arrivalDate}
                    max={today}
                    onChange={(e) => changeInDate(e.target.value)}
                  />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>入库日期</Label>
                    <Input
                      type="date"
                      value={editing.inDate}
                      min={editingBatch?.arrivalDate}
                      max={today}
                      onChange={(e) => changeInDate(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label><span className="text-red-500">*</span> 单条售价(¥)</Label>
                    <Input
                      type="number"
                      min={0}
                      value={editing.basePrice === 0 ? "" : editing.basePrice}
                      onChange={(e) => setEditing({ ...editing, basePrice: e.target.value === "" ? 0 : Number(e.target.value) })}
                      placeholder="0.00"
                    />
                    <span className="text-xs text-muted-foreground">
                      入库时设置基础售价；已入库后的单条改价请到日常管理的鱼详情里操作。
                    </span>
                  </div>
                </div>
              )}

              <div className="grid gap-2">
                <Label>销售提成比例(%)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={editing.commissionRate ?? 0}
                  onChange={(e) => setEditing({ ...editing, commissionRate: e.target.value === "" ? 0 : Number(e.target.value) })}
                  disabled={!isAdmin}
                  placeholder="0"
                />
                <span className="text-xs text-muted-foreground">
                  {isAdmin ? "默认按商品提成 × 批次系数计算；也可以单独覆盖这条鱼的最终提成比例。" : "仅管理员可修改提成比例"}
                </span>
              </div>

              {fromSubTank && !editing.id && (
                <div className="grid gap-2">
                  <Label><span className="text-red-500">*</span> 入库数量</Label>
                  <Input
                    type="number"
                    min={1}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    placeholder="请填写入库数量"
                  />
                </div>
              )}

              <div className="grid gap-2">
                <Label>状态</Label>
                <Select value={editing.status} onValueChange={(v: StockStatus) => setEditing({ ...editing, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="healthy">正常</SelectItem>
                    <SelectItem value="feeding">开口</SelectItem>
                    <SelectItem value="sick">疾病</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {(!fromSubTank || editing.id) && (
                <div className="grid gap-2">
                  <Label>编号</Label>
                  <Input
                    value={editing.code ?? ""}
                    onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                    placeholder="可填写编号..."
                  />
                </div>
              )}

		              {editing.id && permission.canDelete && (
	                <Button variant="ghost" className="text-red-600 justify-start" onClick={() => { setDel(editing); setOpen(false); }}>
	                  删除该入库记录
                </Button>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>取消</Button>
            <Button onClick={save} disabled={saving}>{saving ? "保存中..." : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!saveConfirm} onOpenChange={(o) => !o && setSaveConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{saveConfirm?.isEdit ? "保存入库记录" : "确认入库"}</AlertDialogTitle>
            <AlertDialogDescription>
              {saveConfirm?.isEdit
                ? "将保存这条入库记录的修改。"
                : `将入库 ${saveConfirm?.qty ?? 0} 条商品。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                confirmSave();
              }}
            >
              {saving ? "保存中..." : "确认保存"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除入库记录</AlertDialogTitle>
            <AlertDialogDescription>确认删除该条入库记录？</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
	            <AlertDialogAction
	              disabled={saving}
	              onClick={(event) => {
	                event.preventDefault();
	                confirmDelete();
	              }}
	            >
	              {saving ? "删除中..." : "确认删除"}
	            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkDeleteIds.length > 0} onOpenChange={(o) => !o && setBulkDeleteIds([])}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量删除入库记录</AlertDialogTitle>
            <AlertDialogDescription>
              确认删除已选的 {bulkDeleteIds.length} 条入库记录？已售或已关联订单的鱼不会进入可删除选择。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                confirmBulkDelete();
              }}
            >
              {saving ? "删除中..." : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
