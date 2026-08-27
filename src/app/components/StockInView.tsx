import { useState, useMemo, useRef, useEffect } from "react";
import { useStore, isProductArchived, Order, PurchaseBatch, StockItem, StockStatus, uid } from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { StatusBadge, StatusLegend, statusRingClass, statusFrameClass } from "./StatusIcon";
import {
  Search, ChevronDown, Trash2, Check, ArrowRightLeft, MapPin, List,
  ExternalLink, Pencil, ReceiptText,
} from "lucide-react";
import { toast } from "sonner";
import { getInventoryOutStockIds, isVisibleInStockInventory, normalizeInventoryId } from "../utils/inventory";
import { usePermission } from "../utils/permissions";
import { buildStockPriceBaselines, isStockSpecialPrice } from "../utils/stockPricing";
import { linkedOrdersForStock, orderItemKeepsInventory } from "../utils/stockOrders";
import { orderSourceLabel } from "../utils/orderSources";
import { InventoryAdjustmentDialog } from "./InventoryAdjustmentDialog";

type StockViewMode = "tank" | "species";
type StockInViewProps = {
  allOrders?: Order[];
  onOpenOrder?: (orderId: string) => void;
};

const ORDER_STATUS_META: Record<string, { label: string; className: string }> = {
  pending: { label: "待处理", className: "bg-amber-100 text-amber-800" },
  confirmed: { label: "已确认", className: "bg-sky-100 text-sky-800" },
  shipped: { label: "发货中", className: "bg-violet-100 text-violet-800" },
  completed: { label: "已完成", className: "bg-emerald-100 text-emerald-800" },
  damaged: { label: "已报损", className: "bg-rose-100 text-rose-800" },
  cancelled: { label: "已取消", className: "bg-slate-100 text-slate-700" },
};

function buildStockItems(item: StockItem, quantity: number): StockItem[] {
  return item.id
    ? [item]
    : Array.from({ length: quantity }, () => ({ ...item, id: uid() }));
}

function formatInventoryValue(value: number) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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
    const handler = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
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
        className="flex h-11 w-full touch-manipulation items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs hover:bg-accent hover:text-accent-foreground sm:h-9"
        onClick={() => {
          setOpen((v) => !v);
          if (window.matchMedia("(pointer: fine)").matches) {
            setTimeout(() => inputRef.current?.focus(), 50);
          }
        }}
      >
        <span className={selected ? "text-foreground" : "text-muted-foreground"}>
          {selected ? selected.name : "请选择商品"}
        </span>
        <ChevronDown className="size-4 text-muted-foreground shrink-0" />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-[70] mt-1 flex max-h-[min(18rem,42dvh)] flex-col rounded-md border bg-popover shadow-md">
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
                  className={`flex min-h-11 w-full touch-manipulation items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent ${
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
    const handler = (e: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
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
        className="flex h-11 w-full touch-manipulation items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs hover:bg-accent hover:text-accent-foreground sm:h-9"
        onClick={() => {
          setOpen((v) => !v);
          if (window.matchMedia("(pointer: fine)").matches) {
            setTimeout(() => inputRef.current?.focus(), 50);
          }
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
        <div className="absolute left-0 right-0 top-full z-[70] mt-1 flex max-h-[min(20rem,46dvh)] flex-col rounded-md border bg-popover shadow-md">
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
                  className={`flex min-h-11 w-full touch-manipulation items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-accent ${
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

export function StockInView({ allOrders, onOpenOrder }: StockInViewProps = {}) {
  const { state, saveStockChange } = useStore();
  const permission = usePermission("stockIn");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<StockItem | null>(null);
  const [editingBaseline, setEditingBaseline] = useState<StockItem | null>(null);
  const [del, setDel] = useState<StockItem | null>(null);
  const [bulkDeleteIds, setBulkDeleteIds] = useState<string[]>([]);
  const [bulkDeleteExpectedBefore, setBulkDeleteExpectedBefore] = useState<Record<string, StockItem>>({});
  const [saveConfirm, setSaveConfirm] = useState<{
    stockItems: StockItem[];
    qty: number;
    isEdit: boolean;
    expectedOperations: Record<string, "create" | "update">;
    expectedBefore: Record<string, StockItem>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [linkedStockItem, setLinkedStockItem] = useState<StockItem | null>(null);

  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [fromSubTank, setFromSubTank] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<StockViewMode>("tank");

  const today = new Date().toISOString().slice(0, 10);
  const inventoryHiddenStockIds = useMemo(
    () => getInventoryOutStockIds(state),
    [state.inventoryProjection?.outStockIds, state.shipments, state.orders],
  );
  const productById = useMemo(
    () => new Map(state.products.map((p) => [p.id, p])),
    [state.products],
  );
  const activeProducts = useMemo(
    () => state.products.filter((item) => !isProductArchived(item)),
    [state.products],
  );
  const speciesById = useMemo(
    () => new Map(state.species.map((s) => [s.id, s])),
    [state.species],
  );
  const customerById = useMemo(
    () => new Map(state.customers.map((customer) => [customer.id, customer])),
    [state.customers],
  );
  const tankMetaById = useMemo(() => {
    const map = new Map<string, { groupName: string; subTankName: string; location: string; label: string }>();
    state.tankGroups.forEach((g) => {
      g.subTanks.forEach((t) => {
        map.set(t.id, {
          groupName: g.name,
          subTankName: t.name,
          location: g.location,
          label: `${g.name} / ${t.name}`,
        });
      });
    });
    return map;
  }, [state.tankGroups]);
  const activeStock = useMemo(
    () => state.stock.filter((item) => isVisibleInStockInventory(item, inventoryHiddenStockIds)),
    [state.stock, inventoryHiddenStockIds],
  );
  const product = (id: string) => productById.get(id);
  const batch = (id: string) => state.batches.find((b) => b.id === id);
  const priceBaselineByProduct = useMemo(
    () => buildStockPriceBaselines(
      activeStock,
      state.products,
    ),
    [activeStock, state.products],
  );
  const isSpecialPrice = (item: StockItem) => {
    return isStockSpecialPrice(item, product(item.productId), priceBaselineByProduct);
  };
  const priceBadgeText = (item: StockItem) => `¥${Number(item.basePrice ?? 0).toFixed(0)}`;
  const orderRelations = allOrders ?? state.orders;
  const pendingOrdersForStockIds = (ids: Iterable<string>) => {
    const idSet = new Set(ids);
    return orderRelations.filter((order) =>
      (order.status === "pending" || order.status === "confirmed") &&
      order.items.some((item) =>
        idSet.has(item.stockItemId) && orderItemKeepsInventory(item)
      )
    );
  };
  const linkedOrders = useMemo(
    () => linkedStockItem ? linkedOrdersForStock(orderRelations, linkedStockItem.id) : [],
    [linkedStockItem, orderRelations],
  );
  const stockLockedByProtectedOrder = (id: string) =>
    orderRelations.some((order) =>
      order.status !== "cancelled" &&
      order.status !== "pending" &&
      order.status !== "confirmed" &&
      order.items.some((item) => item.stockItemId === id && orderItemKeepsInventory(item))
    );
  const stockLockedByShipment = (id: string) =>
    inventoryHiddenStockIds.has(normalizeInventoryId(id));
  const stockCannotDelete = (item: StockItem) =>
    stockLockedByProtectedOrder(item.id) || stockLockedByShipment(item.id);
  const stockDeleteLockReason = (item: StockItem) =>
    stockLockedByShipment(item.id)
      ? "已出库或已发货，不能删除"
      : "已进入完成或异常订单，不能删除";
  const latestBatchId = () =>
    [...state.batches].sort((a, b) => {
      const byDate = b.arrivalDate.localeCompare(a.arrivalDate);
      return byDate || b.batchNo.localeCompare(a.batchNo);
    })[0]?.id ?? "";

  const groupIdOfSubTank = (subTankId: string) =>
    state.tankGroups.find((g) => g.subTanks.some((t) => t.id === subTankId))?.id ?? "";

  const empty = (subTankId = ""): StockItem => {
    const defaultProduct = activeProducts[0];
    return {
      id: "",
      productId: defaultProduct?.id ?? "",
      batchId: latestBatchId(),
      subTankId,
      status: "healthy",
      inDate: today,
      basePrice: defaultProduct?.defaultPrice ?? 0,
      commissionRate: 0,
      code: "",
      notes: "",
    };
  };

  const changeProduct = (productId: string) => {
    if (!editing) return;
    const currentDefault = product(editing.productId)?.defaultPrice ?? 0;
    const nextDefault = product(productId)?.defaultPrice ?? 0;
    const shouldUseProductDefault = !editing.basePrice || editing.basePrice === currentDefault;
    setEditing({
      ...editing,
      productId,
      basePrice: shouldUseProductDefault ? nextDefault : editing.basePrice,
      commissionRate: 0,
    });
  };
  const changeBatch = (batchId: string) => {
    if (!editing) return;
    const nextBatch = batch(batchId);
    setEditing({
      ...editing,
      batchId,
      inDate: nextBatch && editing.inDate && editing.inDate < nextBatch.arrivalDate
        ? nextBatch.arrivalDate
        : editing.inDate,
      commissionRate: 0,
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
    if (!item.id && !permission.requirePermission("create")) return;
    if (item.id && !permission.canUpdate) {
      if (!permission.requirePermission("delete")) return;
      if (stockCannotDelete(item)) {
        toast.error(stockDeleteLockReason(item));
        return;
      }
      setDel(item);
      return;
    }
    if (item.id && stockCannotDelete(item)) {
      toast.error(stockDeleteLockReason(item));
      return;
    }
    setEditing({
      ...item,
      lossProof: Array.isArray(item.lossProof) ? [...item.lossProof] : item.lossProof,
      commissionRate: 0,
    });
    setEditingBaseline(item.id ? {
      ...item,
      lossProof: Array.isArray(item.lossProof) ? [...item.lossProof] : item.lossProof,
    } : null);
    setFromSubTank(subTankMode);
    setQuantity("1");
    const gid = item.subTankId
      ? groupIdOfSubTank(item.subTankId)
      : state.tankGroups[0]?.id ?? "";
    setSelectedGroupId(gid);
    setOpen(true);
  };

  const openLinkedInventoryActions = () => {
    if (!linkedStockItem) return;
    const item = linkedStockItem;
    setLinkedStockItem(null);
    openDialog({ ...item }, false);
  };

  const openLinkedOrder = (orderId: string) => {
    if (!onOpenOrder) return;
    setLinkedStockItem(null);
    onOpenOrder(orderId);
  };

  const subTanksOfGroup = useMemo(
    () => state.tankGroups.find((g) => g.id === selectedGroupId)?.subTanks ?? [],
    [selectedGroupId, state.tankGroups]
  );
  const editingBatch = editing ? batch(editing.batchId) : undefined;
  const includesTerm = (value: unknown, term: string) =>
    String(value ?? "").toLowerCase().includes(term);

  const filteredGroups = useMemo(() => {
    if (!q.trim()) return state.tankGroups;
    const term = q.toLowerCase();
    return state.tankGroups.filter(
      (g) =>
        g.name.toLowerCase().includes(term) ||
        g.subTanks.some((t) => t.name.toLowerCase().includes(term)) ||
        activeStock.some((s) => {
          if (!g.subTanks.find((t) => t.id === s.subTankId)) return false;
	          const p = product(s.productId);
	          return (
	            p?.name.toLowerCase().includes(term) ||
	            String(s.code ?? "").toLowerCase().includes(term)
	          );
	        })
    );
  }, [q, state.tankGroups, activeStock, productById]);

  const stockBySub = (subId: string) =>
    activeStock.filter((s) => s.subTankId === subId);

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
  }, [state.stock, state.orders, state.shipments]);

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
    if (!fromSubTank && !selectedGroupId) return toast.error("请选择缸组");
    if (!editing.subTankId) return toast.error("请选择子缸");
    const parsedQty = Number(quantity);
    if (fromSubTank && !editing.id && (!quantity.trim() || !Number.isInteger(parsedQty) || parsedQty <= 0)) {
      return toast.error("请填写大于 0 的入库数量");
    }
    const qty = fromSubTank && !editing.id ? parsedQty : 1;
    const stockItems = buildStockItems({ ...editing, basePrice: Number(basePrice.toFixed(2)), commissionRate: 0 }, qty);
    if (editing.id && (!editingBaseline || editingBaseline.id !== editing.id)) {
      return toast.error("库存原始数据已失效，请关闭后重新打开");
    }
    setSaveConfirm({
      stockItems,
      qty,
      isEdit: Boolean(editing.id),
      expectedOperations: Object.fromEntries(stockItems.map((item) => [
        item.id,
        editing.id ? "update" : "create",
      ])),
      expectedBefore: editing.id && editingBaseline ? { [editing.id]: editingBaseline } : {},
    });
  };

  const confirmSave = async () => {
    if (!saveConfirm || saving) return;
    setSaving(true);
    const result = await saveStockChange({
      upsert: saveConfirm.stockItems,
      expectedOperations: saveConfirm.expectedOperations,
      expectedBefore: saveConfirm.expectedBefore,
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error || "保存失败，请重试");
      return;
    }
    const qty = saveConfirm.qty;
    setSaveConfirm(null);
    setOpen(false);
    if (result.pendingApproval) {
      toast.success(result.message || (saveConfirm.isEdit
        ? "修改申请已提交管理员审批"
        : "入库申请已提交管理员审批"));
      return;
    }
    toast.success(saveConfirm.isEdit ? "已保存入库记录" : qty > 1 ? `已入库 ${qty} 条` : "已入库");
  };

  const confirmDelete = async () => {
    if (!del || saving) return;
    if (!permission.requirePermission("delete")) return;
    if (stockCannotDelete(del)) return toast.error(stockDeleteLockReason(del));
    const linkedOrderCount = pendingOrdersForStockIds([del.id]).length;
    setSaving(true);
    const result = await saveStockChange({
      deleteIds: [del.id],
      expectedOperations: { [del.id]: "delete" },
      expectedBefore: { [del.id]: del },
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error || "删除失败，请重试");
      return;
    }
    setDel(null);
    if (result.pendingApproval) {
      toast.success(result.message || "删除申请已提交管理员审批");
      return;
    }
    toast.success(linkedOrderCount > 0 ? "已删除库存，订单历史已保留" : "已删除");
  };

  const toggleSelected = (id: string) => {
    if (!selectMode) return;
    const item = state.stock.find((stock) => stock.id === id);
    if (!item || stockCannotDelete(item)) {
      toast.error(item ? stockDeleteLockReason(item) : "库存记录不存在");
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
      return item && isVisibleInStockInventory(item, inventoryHiddenStockIds) && !stockCannotDelete(item);
    });
    if (ids.length === 0) return toast.error("请选择要删除的入库记录");
    setBulkDeleteIds(ids);
    setBulkDeleteExpectedBefore(Object.fromEntries(ids.flatMap((id) => {
      const item = state.stock.find((stock) => stock.id === id);
      return item ? [[id, {
        ...item,
        lossProof: Array.isArray(item.lossProof) ? [...item.lossProof] : item.lossProof,
      } as StockItem] as const] : [];
    })));
  };

  const confirmBulkDelete = async () => {
    if (!permission.requirePermission("delete")) return;
    if (bulkDeleteIds.length === 0 || saving) return;
    const linkedOrderCount = pendingOrdersForStockIds(bulkDeleteIds).length;
    setSaving(true);
    const result = await saveStockChange({
      deleteIds: bulkDeleteIds,
      expectedOperations: Object.fromEntries(bulkDeleteIds.map((id) => [id, "delete"])),
      expectedBefore: bulkDeleteExpectedBefore,
    });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.error || "批量删除失败，请重试");
      return;
    }
    if (result.pendingApproval) {
      setSelectedIds(new Set());
      setBulkDeleteIds([]);
      setBulkDeleteExpectedBefore({});
      setSelectMode(false);
      toast.success(result.message || "批量删除申请已提交管理员审批");
      return;
    }
    setSelectedIds((prev) => {
      const next = new Set(prev);
      bulkDeleteIds.forEach((id) => next.delete(id));
      return next;
    });
    const count = bulkDeleteIds.length;
    setBulkDeleteIds([]);
    setBulkDeleteExpectedBefore({});
    setSelectMode(false);
    toast.success(
      linkedOrderCount > 0
        ? `已删除 ${count} 条库存，${linkedOrderCount} 个订单历史已保留`
        : `已删除 ${count} 条入库记录`
    );
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

  const speciesStockGroups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const matches = (item: StockItem) => {
      if (!term) return true;
      const p = productById.get(item.productId);
      const sp = p?.speciesId ? speciesById.get(p.speciesId) : undefined;
      const tank = tankMetaById.get(item.subTankId);
      return (
        includesTerm(p?.name, term) ||
        includesTerm(p?.size, term) ||
        includesTerm(p?.origin, term) ||
        includesTerm(sp?.name, term) ||
        includesTerm(sp?.scientificName, term) ||
        sp?.commonNames?.some((name) => includesTerm(name, term)) ||
        includesTerm(item.code, term) ||
        includesTerm(item.notes, term) ||
        includesTerm(tank?.groupName, term) ||
        includesTerm(tank?.subTankName, term) ||
        includesTerm(tank?.location, term)
      );
    };

    const groups = new Map<string, {
      speciesId: string;
      speciesName: string;
      scientificName: string;
      commonNames: string[];
      imageUrl: string;
      total: number;
      inventoryValue: number;
      statuses: Record<StockStatus, number>;
      products: Map<string, {
        productId: string;
        name: string;
        size: string;
        origin: string;
        count: number;
        tankCounts: Map<string, number>;
      }>;
    }>();

    activeStock.filter(matches).forEach((item) => {
      const p = productById.get(item.productId);
      const speciesId = p?.speciesId ?? item.productId;
      const sp = speciesById.get(speciesId);
      const group = groups.get(speciesId) ?? {
        speciesId,
        speciesName: sp?.name ?? p?.name ?? speciesId,
        scientificName: sp?.scientificName ?? "",
        commonNames: sp?.commonNames ?? [],
        imageUrl: sp?.imageUrl || p?.imageUrl || "",
        total: 0,
        inventoryValue: 0,
        statuses: { healthy: 0, feeding: 0, sick: 0 },
        products: new Map(),
      };

      group.total += 1;
      const itemValue = Number(item.basePrice || p?.defaultPrice || 0);
      group.inventoryValue += Number.isFinite(itemValue) ? itemValue : 0;
      group.statuses[item.status] += 1;

      const productRow = group.products.get(item.productId) ?? {
        productId: item.productId,
        name: p?.name ?? item.productId,
        size: p?.size ?? "",
        origin: p?.origin ?? "",
        count: 0,
        tankCounts: new Map<string, number>(),
      };
      productRow.count += 1;
      const tankLabel = tankMetaById.get(item.subTankId)?.label ?? "未知缸位";
      productRow.tankCounts.set(tankLabel, (productRow.tankCounts.get(tankLabel) ?? 0) + 1);
      group.products.set(item.productId, productRow);
      groups.set(speciesId, group);
    });

    return [...groups.values()]
      .map((group) => ({
        ...group,
        productRows: [...group.products.values()]
          .map((row) => ({
            ...row,
            tankRows: [...row.tankCounts.entries()]
              .map(([label, count]) => ({ label, count }))
              .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "zh-Hans-CN")),
          }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN")),
      }))
      .sort((a, b) => b.total - a.total || a.speciesName.localeCompare(b.speciesName, "zh-Hans-CN"));
  }, [activeStock, q, productById, speciesById, tankMetaById]);

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2>库存明细</h2>
          <p className="text-sm text-muted-foreground">按缸位或品种查看和管理在缸库存</p>
        </div>
	        <div className="flex w-full flex-wrap items-center justify-start gap-2 sm:w-auto sm:justify-end">
	          {(permission.canCreate || permission.canDelete) && <InventoryAdjustmentDialog />}
	          <ToggleGroup
            type="single"
            value={viewMode}
            onValueChange={(value) => {
              if (value) setViewMode(value as StockViewMode);
            }}
            variant="outline"
            size="sm"
            className="w-full shrink-0 sm:w-auto"
          >
            <ToggleGroupItem value="tank" aria-label="缸位视图" className="flex-1 gap-1.5 px-3 sm:flex-none">
              <MapPin className="size-3.5" />
              缸位视图
            </ToggleGroupItem>
            <ToggleGroupItem value="species" aria-label="品种视图" className="flex-1 gap-1.5 px-3 sm:flex-none">
              <List className="size-3.5" />
              品种视图
            </ToggleGroupItem>
          </ToggleGroup>
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
          <div className="relative w-full sm:w-auto">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={viewMode === "tank" ? "搜索缸 / 商品 / 编号..." : "搜索品种 / 商品 / 缸位..."}
              className="w-full pl-9 sm:w-64"
            />
          </div>
        </div>
      </div>
      <StatusLegend />

      {viewMode === "tank" ? (
        /* 缸组列表：每个缸组独占一行 */
        <div className="flex flex-col gap-4">
          {filteredGroups.map((g) => (
          <Card key={g.id} className="border-2 border-sky-200 bg-sky-50/30 p-3 sm:p-5">
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
                                className="grid grid-cols-[repeat(auto-fill,2.5rem)] gap-1.5 border-t bg-slate-50 px-3 pb-2 pt-1 sm:grid-cols-[repeat(auto-fill,2.25rem)]"
                                style={{ maxWidth: "27.375rem" }}
                              >
                                {stockItems.map((s) => {
                                  const selected = selectedIds.has(s.id);
                                  const locked = stockCannotDelete(s);
                                  const lockReason = stockDeleteLockReason(s);
                                  return (
                                    <button
                                      key={s.id}
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        if (selectMode) {
                                          if (!locked) toggleSelected(s.id);
                                          return;
                                        }
                                        if (s.sold) {
                                          setLinkedStockItem({ ...s });
                                          return;
                                        }
                                        openDialog({ ...s }, false);
                                      }}
                                      className={`relative size-10 touch-manipulation overflow-hidden rounded bg-muted text-left transition-opacity hover:opacity-80 sm:size-9 ${
                                        selected ? "ring-2 ring-emerald-500 ring-offset-2" : statusRingClass(s.status, s.sold)
                                      } ${selectMode && locked ? "cursor-not-allowed opacity-50 hover:opacity-50" : ""}`}
                                      title={`${p?.name ?? ""}${s.code ? ` · 编号：${s.code}` : ""} · 售价：¥${Number(s.basePrice ?? 0).toFixed(2)}${isSpecialPrice(s) ? "（特殊价格）" : ""} · ${statusMeta[s.status].label}${s.sold && !selectMode ? " · 点击查看关联订单" : ""}${selectMode && locked ? ` · ${lockReason}` : ""}`}
                                      aria-label={
                                        s.sold && !selectMode
                                          ? `查看${p?.name ?? "该鱼"}的关联订单`
                                          : `${selectMode ? "选择" : "编辑"}${p?.name ?? "库存记录"}`
                                      }
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
                                  </button>
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
      ) : (
        <>
          {speciesStockGroups.length === 0 ? (
            <Card className="p-6 text-center text-sm text-muted-foreground">
              暂无匹配的在缸库存
            </Card>
          ) : (
            <Card className="gap-0 overflow-hidden rounded-lg">
              <div className="hidden grid-cols-[minmax(13rem,0.9fr)_minmax(10rem,0.65fr)_minmax(0,2.4fr)] gap-4 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground md:grid">
                <div>品种</div>
                <div>状态 / 货值</div>
                <div>商品规格 / 数量 / 缸位分布</div>
              </div>
              <div className="divide-y">
                {speciesStockGroups.map((group) => (
                  <div
                    key={group.speciesId}
                    className="grid gap-3 px-3 py-2.5 md:grid-cols-[minmax(13rem,0.9fr)_minmax(10rem,0.65fr)_minmax(0,2.4fr)] md:items-start"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="size-10 shrink-0 overflow-hidden rounded-md border bg-muted">
                        {group.imageUrl ? (
                          <ImageWithFallback src={group.imageUrl} alt={group.speciesName} className="size-full object-cover" />
                        ) : (
                          <div className="flex size-full items-center justify-center px-1 text-center text-[9px] text-muted-foreground">
                            {group.speciesName}
                          </div>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="truncate font-semibold leading-tight" title={group.speciesName}>
                            {group.speciesName}
                          </div>
                          <span className="shrink-0 rounded-md bg-slate-900 px-1.5 py-0.5 text-xs font-semibold leading-5 text-white">
                            {group.total} 条
                          </span>
                        </div>
                        {(group.commonNames.length > 0 || group.scientificName) && (
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">
                            {[group.commonNames.join(" / "), group.scientificName].filter(Boolean).join(" · ")}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-1 md:pt-0.5">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {(["healthy", "feeding", "sick"] as StockStatus[])
                          .filter((st) => group.statuses[st] > 0)
                          .map((st) => (
                            <span key={st} className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                              <span className={`size-3 rounded border-2 ${statusFrameClass(st)}`} />
                              {statusMeta[st].label} {group.statuses[st]} 条
                            </span>
                          ))}
                      </div>
                      <div className="flex items-baseline gap-1.5 text-xs">
                        <span className="text-muted-foreground">货值</span>
                        <span className="font-semibold tabular-nums text-slate-800">
                          {formatInventoryValue(group.inventoryValue)}
                        </span>
                      </div>
                    </div>

                    <div className="grid gap-1.5">
                      {group.productRows.map((row) => (
                        <div
                          key={row.productId}
                          className="grid gap-2 rounded-md bg-muted/30 px-2 py-1.5 text-sm md:grid-cols-[minmax(8rem,1fr)_auto_minmax(12rem,1.8fr)] md:items-center"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-medium" title={row.name}>{row.name}</div>
                            {(row.size || row.origin) && (
                              <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                {[row.size, row.origin].filter(Boolean).join(" · ")}
                              </div>
                            )}
                          </div>
                          <span className="w-fit whitespace-nowrap rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
                            {row.count} 条
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {row.tankRows.map((tank) => (
                              <span
                                key={tank.label}
                                className="rounded-full border bg-background px-2 py-0.5 text-xs text-muted-foreground"
                              >
                                {tank.label} · {tank.count} 条
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      <Dialog open={!!linkedStockItem} onOpenChange={(nextOpen) => !nextOpen && setLinkedStockItem(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ReceiptText className="size-5 text-amber-600" />
              关联订单
            </DialogTitle>
            <DialogDescription>
              黄色外框表示该库存已被订单占用，可在这里核对并打开对应订单。
            </DialogDescription>
          </DialogHeader>

          {linkedStockItem && (
            <div className="flex items-center gap-3 rounded-md bg-slate-50 px-3 py-2.5">
              <div className="size-11 shrink-0 overflow-hidden rounded-md bg-muted ring-2 ring-yellow-400 ring-offset-2">
                {product(linkedStockItem.productId)?.imageUrl ? (
                  <ImageWithFallback
                    src={product(linkedStockItem.productId)?.imageUrl ?? ""}
                    alt={product(linkedStockItem.productId)?.name ?? "库存鱼"}
                    className="size-full object-cover"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center px-1 text-center text-[9px] text-muted-foreground">
                    {product(linkedStockItem.productId)?.name ?? "库存鱼"}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <div className="truncate font-semibold">
                  {product(linkedStockItem.productId)?.name ?? linkedStockItem.productId}
                </div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {[
                    linkedStockItem.code ? `鱼码 ${linkedStockItem.code}` : "",
                    tankMetaById.get(linkedStockItem.subTankId)?.label ?? "",
                  ].filter(Boolean).join(" · ")}
                </div>
              </div>
            </div>
          )}

          {linkedOrders.length > 0 ? (
            <div className="divide-y overflow-hidden rounded-md border">
              {linkedOrders.map((order) => {
                const statusMeta = ORDER_STATUS_META[order.status] ?? {
                  label: order.status || "未知状态",
                  className: "bg-slate-100 text-slate-700",
                };
                const customerName = customerById.get(order.customerId)?.name;
                return (
                  <div
                    key={order.id}
                    className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-slate-900">{order.orderNo}</span>
                        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusMeta.className}`}>
                          {statusMeta.label}
                        </span>
                      </div>
                      <div className="mt-1 text-xs leading-5 text-muted-foreground">
                        {[order.date, orderSourceLabel(order.source), customerName].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    {onOpenOrder && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-10 w-full shrink-0 gap-1.5 sm:w-auto"
                        onClick={() => openLinkedOrder(order.id)}
                      >
                        查看订单
                        <ExternalLink className="size-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="rounded-md border border-dashed px-3 py-5 text-center text-sm text-muted-foreground">
              未找到有效关联订单，可能是历史状态残留。
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 gap-1.5 sm:mr-auto sm:min-h-9"
              onClick={openLinkedInventoryActions}
            >
              <Pencil className="size-3.5" />
              库存操作
            </Button>
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              onClick={() => setLinkedStockItem(null)}
            >
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
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
          {editing?.id && pendingOrdersForStockIds([editing.id]).length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 text-amber-900">
              该鱼关联 {pendingOrdersForStockIds([editing.id]).length} 个未出库订单。删除库存后，订单商品和收款历史会保留，并标记为“库存记录已删除”。
            </div>
          )}
          {editing && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-2">
                <Label><span className="text-red-500">*</span> 商品</Label>
	                <ProductCombobox
	                  products={state.products.filter((item) => !isProductArchived(item) || item.id === editing.productId)}
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
                <div className="grid gap-3 sm:grid-cols-2">
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
                <div className="grid gap-3 sm:grid-cols-2">
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
          <DialogFooter className="sticky bottom-[-1rem] z-10 -mx-4 -mb-4 border-t bg-background px-4 py-3 sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0">
            <Button className="min-h-11 sm:min-h-9" variant="outline" onClick={() => setOpen(false)} disabled={saving}>取消</Button>
            <Button className="min-h-11 sm:min-h-9" onClick={save} disabled={saving}>{saving ? "保存中..." : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!saveConfirm} onOpenChange={(o) => !o && setSaveConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{saveConfirm?.isEdit && !permission.isAdmin ? "提交库存修改申请" : saveConfirm?.isEdit ? "保存入库记录" : "确认入库"}</AlertDialogTitle>
            <AlertDialogDescription>
              {saveConfirm?.isEdit
                ? permission.isAdmin
                  ? "将保存这条入库记录的修改。"
                  : "将提交这条库存记录的修改申请，管理员批准后才会生效。"
                : !permission.isAdmin && saveConfirm?.stockItems.some((item) => {
                    const selectedBatch = state.batches.find((batchItem) => batchItem.id === item.batchId);
                    const createdAt = Date.parse(String(selectedBatch?.createdAt ?? ""));
                    return !Number.isFinite(createdAt) || Date.now() - createdAt >= 48 * 60 * 60 * 1000;
                  })
                  ? `将向创建已超过 48 小时的批次补录 ${saveConfirm?.qty ?? 0} 条商品，确认后提交管理员审批。`
                  : `将入库 ${saveConfirm?.qty ?? 0} 条商品。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9" disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 sm:min-h-9"
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
            <AlertDialogDescription>
              {!permission.isAdmin
                ? "确认后将提交管理员审批，批准前不会删除库存。"
                : del && pendingOrdersForStockIds([del.id]).length > 0
                ? `确认删除该条库存记录？关联的 ${pendingOrdersForStockIds([del.id]).length} 个未出库订单会保留商品和收款历史，并标记为“库存记录已删除”。`
                : "确认删除该条入库记录？"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9" disabled={saving}>取消</AlertDialogCancel>
	            <AlertDialogAction
	              className="min-h-11 sm:min-h-9"
	              disabled={saving}
	              onClick={(event) => {
	                event.preventDefault();
	                confirmDelete();
	              }}
	            >
	              {saving ? "提交中..." : permission.isAdmin ? "确认删除" : "提交审批"}
	            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkDeleteIds.length > 0} onOpenChange={(o) => {
        if (!o) {
          setBulkDeleteIds([]);
          setBulkDeleteExpectedBefore({});
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>批量删除入库记录</AlertDialogTitle>
            <AlertDialogDescription>
              {permission.isAdmin
                ? `确认删除已选的 ${bulkDeleteIds.length} 条入库记录？`
                : `确认提交删除 ${bulkDeleteIds.length} 条入库记录的审批？批准前不会删除库存。`}
              {pendingOrdersForStockIds(bulkDeleteIds).length > 0
                ? ` 其中关联 ${pendingOrdersForStockIds(bulkDeleteIds).length} 个未出库订单，订单商品和收款历史会保留并标记。`
                : ""}
              已实际出库或进入完成、异常订单的鱼不会进入可删除选择。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="min-h-11 sm:min-h-9" disabled={saving}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="min-h-11 sm:min-h-9"
              disabled={saving}
              onClick={(event) => {
                event.preventDefault();
                confirmBulkDelete();
              }}
            >
              {saving ? "提交中..." : permission.isAdmin ? "确认删除" : "提交审批"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
