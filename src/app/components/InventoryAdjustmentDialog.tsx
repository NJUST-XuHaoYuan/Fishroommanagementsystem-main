import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ClipboardCheck,
  Loader2,
  LockKeyhole,
  Minus,
  PackagePlus,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  InventoryAdjustmentAddition,
  InventoryAdjustmentDraft,
  InventoryAdjustmentLine,
  StockChangeRequest,
  StockItem,
  StockStatus,
  isProductArchived,
  uid,
  useStore,
} from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { getInventoryHiddenStockIds, isVisibleInStockInventory } from "../utils/inventory";
import { orderItemKeepsInventory } from "../utils/stockOrders";
import { matchesSite } from "../utils/sites";
import { usePermission } from "../utils/permissions";
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
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

type WorkMode = "remove" | "add" | "review";

type AdjustmentSummaryRow = {
  subTankId: string;
  tankLabel: string;
  currentCount: number;
  addCount: number;
  removeCount: number;
};

type NormalizedAdjustment = {
  lines: InventoryAdjustmentLine[];
  addCount: number;
  removeCount: number;
  tankCount: number;
  rows: AdjustmentSummaryRow[];
};

type SearchOption = {
  value: string;
  label: string;
  description?: string;
  imageUrl?: string;
};

const STATUS_META: Record<StockStatus, { label: string; className: string }> = {
  healthy: { label: "正常", className: "border-emerald-300 bg-emerald-50 text-emerald-800" },
  feeding: { label: "开口", className: "border-sky-300 bg-sky-50 text-sky-800" },
  sick: { label: "疾病", className: "border-rose-300 bg-rose-50 text-rose-800" },
};

function formatDraftTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value.replace("T", " ").slice(0, 16)
    : date.toLocaleString("zh-CN", { hour12: false });
}

function adjustmentSnapshot(
  removeStockIds: string[],
  additions: InventoryAdjustmentAddition[],
  notes: string,
  activeSubTankId: string,
) {
  return JSON.stringify({
    removeStockIds: [...removeStockIds].sort(),
    additions,
    notes,
    activeSubTankId,
  });
}

function SearchPicker({
  value,
  options,
  placeholder,
  searchPlaceholder,
  onChange,
}: {
  value: string;
  options: SearchOption[];
  placeholder: string;
  searchPlaceholder: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    if (!term) return options;
    return options.filter((option) =>
      `${option.label} ${option.description ?? ""}`.toLocaleLowerCase("zh-CN").includes(term)
    );
  }, [options, query]);

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="flex h-11 w-full items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm shadow-xs sm:h-9"
        onClick={() => {
          setOpen((current) => !current);
          setTimeout(() => inputRef.current?.focus(), 40);
        }}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "" : "text-muted-foreground"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-[80] mt-1 overflow-hidden rounded-md border bg-popover shadow-lg">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
                className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">没有匹配项</div>
            ) : filtered.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`flex min-h-11 w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-accent ${
                  option.value === value ? "bg-accent/70" : ""
                }`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery("");
                }}
              >
                {option.imageUrl && (
                  <div className="size-8 shrink-0 overflow-hidden rounded border bg-muted">
                    <ImageWithFallback src={option.imageUrl} alt="" className="size-full object-cover" />
                  </div>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{option.label}</span>
                  {option.description && (
                    <span className="block truncate text-xs text-muted-foreground">{option.description}</span>
                  )}
                </span>
                {option.value === value && <Check className="size-4 shrink-0" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function InventoryAdjustmentDialog() {
  const { state, activeSiteId, setActiveSiteId, saveStockChange } = useStore();
  const permission = usePermission("stockIn");
  const today = new Date().toISOString().slice(0, 10);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftState, setDraftState] = useState<"idle" | "dirty" | "saved" | "error">("idle");
  const [submitting, setSubmitting] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const [draft, setDraft] = useState<InventoryAdjustmentDraft | null>(null);
  const [workSiteId, setWorkSiteId] = useState("");
  const [mode, setMode] = useState<WorkMode>(permission.canDelete ? "remove" : "add");
  const [selectedSubTankId, setSelectedSubTankId] = useState("");
  const [stockQuery, setStockQuery] = useState("");
  const [removeStockIds, setRemoveStockIds] = useState<string[]>([]);
  const [additions, setAdditions] = useState<InventoryAdjustmentAddition[]>([]);
  const [additionForm, setAdditionForm] = useState<InventoryAdjustmentAddition | null>(null);
  const [editingAdditionId, setEditingAdditionId] = useState("");
  const [notes, setNotes] = useState("");
  const [submitPreview, setSubmitPreview] = useState<NormalizedAdjustment | null>(null);
  const [duplicateRequest, setDuplicateRequest] = useState<{
    payload: StockChangeRequest;
    createdAt?: string;
    status?: string;
  } | null>(null);
  const lastSavedSnapshotRef = useRef("");
  const latestSnapshotRef = useRef("");
  const saveSequenceRef = useRef(0);

  const hiddenStockIds = useMemo(
    () => getInventoryHiddenStockIds(state.shipments, state.orders),
    [state.orders, state.shipments],
  );
  const siteGroups = useMemo(
    () => state.tankGroups.filter((group) => !workSiteId || matchesSite(group, workSiteId)),
    [state.tankGroups, workSiteId],
  );
  const tankOptions = useMemo(
    () => siteGroups.flatMap((group) => group.subTanks.map((tank) => ({
      id: tank.id,
      groupId: group.id,
      groupName: group.name,
      tankName: tank.name,
      label: group.name === tank.name ? tank.name : `${group.name} / ${tank.name}`,
    }))),
    [siteGroups],
  );
  const tankById = useMemo(() => new Map(tankOptions.map((tank) => [tank.id, tank])), [tankOptions]);
  const siteBatches = useMemo(
    () => state.batches
      .filter((batch) => !workSiteId || matchesSite(batch, workSiteId))
      .sort((left, right) => right.arrivalDate.localeCompare(left.arrivalDate) || right.batchNo.localeCompare(left.batchNo)),
    [state.batches, workSiteId],
  );
  const products = useMemo(
    () => [...state.products].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    [state.products],
  );
  const activeProducts = useMemo(
    () => products.filter((product) => !isProductArchived(product)),
    [products],
  );
  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const batchById = useMemo(() => new Map(siteBatches.map((batch) => [batch.id, batch])), [siteBatches]);
  const visibleStock = useMemo(
    () => state.stock.filter((item) =>
      (!workSiteId || matchesSite(item, workSiteId)) && isVisibleInStockInventory(item, hiddenStockIds)
    ),
    [hiddenStockIds, state.stock, workSiteId],
  );
  const visibleStockById = useMemo(() => new Map(visibleStock.map((item) => [item.id, item])), [visibleStock]);
  const pendingOrderCountByStockId = useMemo(() => {
    const counts = new Map<string, number>();
    state.orders.filter((order) => ["pending", "confirmed"].includes(order.status)).forEach((order) => {
      order.items.forEach((item) => {
        if (!item.stockItemId || !orderItemKeepsInventory(item)) return;
        counts.set(item.stockItemId, (counts.get(item.stockItemId) ?? 0) + 1);
      });
    });
    return counts;
  }, [state.orders]);

  const stockLockedByShipment = (id: string) => state.shipments.some((shipment) =>
    shipment.status !== "preparing" && (shipment.itemStockIds ?? []).includes(id)
  );
  const stockLockedByProtectedOrder = (id: string) => state.orders.some((order) =>
    !["cancelled", "pending", "confirmed"].includes(order.status) &&
    order.items.some((item) => item.stockItemId === id && orderItemKeepsInventory(item))
  );
  const stockCannotRemove = (item: StockItem) =>
    stockLockedByShipment(item.id) || stockLockedByProtectedOrder(item.id);
  const stockLockReason = (item: StockItem) => stockLockedByShipment(item.id)
    ? "已出库或已发货"
    : "已进入完成或异常订单";
  const defaultAddition = (subTankId: string, targetSiteId = workSiteId): InventoryAdjustmentAddition => {
    const availableBatches = state.batches
      .filter((batch) => !targetSiteId || matchesSite(batch, targetSiteId))
      .sort((left, right) => right.arrivalDate.localeCompare(left.arrivalDate) || right.batchNo.localeCompare(left.batchNo));
    const product = activeProducts[0];
    const batch = availableBatches[0];
    return {
      id: uid("adjust-add"),
      subTankId,
      productId: product?.id ?? "",
      batchId: batch?.id ?? "",
      quantity: 1,
      status: "healthy",
      inDate: batch?.arrivalDate ?? today,
      basePrice: Number(product?.defaultPrice ?? 0),
      code: "",
      notes: "",
    };
  };

  const draftSnapshotValue = useMemo(
    () => adjustmentSnapshot(removeStockIds, additions, notes, selectedSubTankId),
    [additions, notes, removeStockIds, selectedSubTankId],
  );
  latestSnapshotRef.current = draftSnapshotValue;
  const hasWork = removeStockIds.length > 0 || additions.length > 0 || notes.trim().length > 0;

  const persistDraft = async (silent = false, expectedSnapshot = draftSnapshotValue) => {
    if (!workSiteId) {
      if (!silent) toast.error("请选择具体场地");
      return false;
    }
    if (!hasWork && !draft) {
      if (!silent) toast.error("当前没有需要保存的盘库内容");
      return false;
    }
    const sequence = ++saveSequenceRef.current;
    setSavingDraft(true);
    try {
      const response = await fetch("/api/stock/adjustment-draft", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          action: "save",
          draft: {
            id: draft?.id,
            siteId: workSiteId,
            removeStockIds,
            additions,
            activeSubTankId: selectedSubTankId,
            notes,
          },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "盘库草稿保存失败");
      if (sequence === saveSequenceRef.current) {
        setDraft(result.draft);
        lastSavedSnapshotRef.current = expectedSnapshot;
        setDraftState(latestSnapshotRef.current === expectedSnapshot ? "saved" : "dirty");
      }
      if (!silent) toast.success("盘库进度已保存，下次打开会自动继续");
      return true;
    } catch (error) {
      if (sequence === saveSequenceRef.current) setDraftState("error");
      if (!silent) toast.error(error instanceof Error ? error.message : "盘库草稿保存失败");
      return false;
    } finally {
      if (sequence === saveSequenceRef.current) setSavingDraft(false);
    }
  };

  useEffect(() => {
    if (!open || !draftReady) return;
    if (draftSnapshotValue === lastSavedSnapshotRef.current) {
      if (draft || hasWork) setDraftState("saved");
      return;
    }
    setDraftState("dirty");
    if (!hasWork && !draft) return;
    const timer = window.setTimeout(() => {
      void persistDraft(true, draftSnapshotValue);
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [draftSnapshotValue, draftReady, open]);

  useEffect(() => {
    if (!open || !workSiteId || tankOptions.length === 0) return;
    if (!tankById.has(selectedSubTankId)) {
      const firstTankId = tankOptions.find((tank) => visibleStock.some((item) => item.subTankId === tank.id))?.id ?? tankOptions[0].id;
      setSelectedSubTankId(firstTankId);
      setAdditionForm((current) => current ? { ...current, subTankId: firstTankId } : defaultAddition(firstTankId));
    }
    setRemoveStockIds((current) => {
      const next = current.filter((id) => {
        const item = visibleStockById.get(id);
        return item && !stockCannotRemove(item);
      });
      return next.length === current.length ? current : next;
    });
  }, [open, tankById, tankOptions, visibleStockById, workSiteId]);

  const loadDraft = async () => {
    setLoading(true);
    setDraftReady(false);
    try {
      const response = await fetch("/api/stock/adjustment-draft", { headers: authJsonHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "盘库草稿加载失败");
      const loaded = result.draft as InventoryAdjustmentDraft | null;
      const selectedSiteId = loaded?.siteId || (activeSiteId === "all" ? "" : activeSiteId);
      if (!selectedSiteId) {
        toast.error("请先在右上角选择具体场地，再开始盘库");
        return;
      }
      const availableTanks = state.tankGroups
        .filter((group) => matchesSite(group, selectedSiteId))
        .flatMap((group) => group.subTanks);
      const firstStockTank = availableTanks.find((tank) => state.stock.some((item) =>
        item.subTankId === tank.id && matchesSite(item, selectedSiteId) &&
        isVisibleInStockInventory(item, hiddenStockIds)
      ));
      const loadedTankId = availableTanks.some((tank) => tank.id === loaded?.activeSubTankId)
        ? String(loaded?.activeSubTankId)
        : firstStockTank?.id ?? availableTanks[0]?.id ?? "";
      const changingScopedSite = Boolean(loaded?.siteId && loaded.siteId !== activeSiteId && activeSiteId !== "all");
      const exactRemovalIds = (Array.isArray(loaded?.removeStockIds) ? loaded.removeStockIds : [])
        .filter((id) => {
          const item = state.stock.find((stockItem) => stockItem.id === id);
          if (!item && changingScopedSite) return true;
          return item && matchesSite(item, selectedSiteId) &&
            isVisibleInStockInventory(item, hiddenStockIds) && !stockCannotRemove(item);
        });
      const staleRemovalCount = (loaded?.removeStockIds?.length ?? 0) - exactRemovalIds.length;
      const exactAdditions = Array.isArray(loaded?.additions) ? loaded.additions : [];
      const legacyLines = Array.isArray(loaded?.lines) ? loaded.lines : [];
      const legacyAdditions = legacyLines.filter((line) => line.direction === "add").map((line) => {
        const product = state.products.find((item) => item.id === line.productId);
        const batch = state.batches.find((item) => item.id === line.batchId);
        return {
          id: uid("adjust-add"),
          subTankId: line.subTankId,
          productId: line.productId,
          batchId: line.batchId,
          quantity: line.quantity,
          status: "healthy" as const,
          inDate: batch?.arrivalDate ?? today,
          basePrice: Number(product?.defaultPrice ?? 0),
          code: "",
          notes: "",
        };
      });
      const migratedAdditions = exactAdditions.length > 0 ? exactAdditions : legacyAdditions;
      setDraft(loaded);
      setWorkSiteId(selectedSiteId);
      setSelectedSubTankId(loadedTankId);
      setRemoveStockIds(exactRemovalIds);
      setAdditions(migratedAdditions);
      setNotes(String(loaded?.notes ?? ""));
      setAdditionForm(defaultAddition(loadedTankId, selectedSiteId));
      setEditingAdditionId("");
      setStockQuery("");
      setMode(exactRemovalIds.length > 0 || permission.canDelete ? "remove" : "add");
      if (loaded?.siteId && loaded.siteId !== activeSiteId) {
        setActiveSiteId(loaded.siteId);
        toast.info("已切换到草稿对应场地");
      }
      const migratedSnapshot = adjustmentSnapshot(
        exactRemovalIds,
        migratedAdditions,
        String(loaded?.notes ?? ""),
        loadedTankId,
      );
      const requiresMigration = legacyLines.length > 0 || staleRemovalCount > 0;
      lastSavedSnapshotRef.current = requiresMigration ? "" : migratedSnapshot;
      latestSnapshotRef.current = migratedSnapshot;
      setDraftState(loaded && !requiresMigration ? "saved" : requiresMigration ? "dirty" : "idle");
      setOpen(true);
      setDraftReady(true);
      if (legacyLines.some((line) => line.direction === "remove")) {
        toast.warning("旧版草稿的减少项没有具体鱼只编号，请在当前库存中重新选择");
      } else if (staleRemovalCount > 0) {
        toast.warning(`${staleRemovalCount} 条草稿库存已变化，已从待减少清单移除`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "盘库草稿加载失败");
    } finally {
      setLoading(false);
    }
  };

  const discardDraft = async () => {
    setSavingDraft(true);
    try {
      const response = await fetch("/api/stock/adjustment-draft", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({ action: "delete" }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "草稿清除失败");
      const firstTankId = tankOptions.find((tank) => visibleStock.some((item) => item.subTankId === tank.id))?.id ?? tankOptions[0]?.id ?? "";
      setDraft(null);
      setRemoveStockIds([]);
      setAdditions([]);
      setNotes("");
      setSelectedSubTankId(firstTankId);
      setAdditionForm(defaultAddition(firstTankId));
      setEditingAdditionId("");
      const emptySnapshot = adjustmentSnapshot([], [], "", firstTankId);
      lastSavedSnapshotRef.current = emptySnapshot;
      latestSnapshotRef.current = emptySnapshot;
      setDraftState("idle");
      toast.success("盘库草稿已清除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "盘库草稿清除失败");
    } finally {
      setSavingDraft(false);
    }
  };

  const chooseTank = (subTankId: string) => {
    setSelectedSubTankId(subTankId);
    setAdditionForm((current) => current ? { ...current, subTankId } : defaultAddition(subTankId));
  };

  const toggleRemoval = (item: StockItem) => {
    if (!permission.requirePermission("delete")) return;
    if (stockCannotRemove(item)) return toast.error(`${stockLockReason(item)}，不能减少`);
    setRemoveStockIds((current) => current.includes(item.id)
      ? current.filter((id) => id !== item.id)
      : [...current, item.id]
    );
  };

  const changeAdditionProduct = (productId: string) => {
    setAdditionForm((current) => {
      if (!current) return current;
      const previousDefault = productById.get(current.productId)?.defaultPrice ?? 0;
      const nextDefault = productById.get(productId)?.defaultPrice ?? 0;
      return {
        ...current,
        productId,
        basePrice: !current.basePrice || current.basePrice === previousDefault ? nextDefault : current.basePrice,
      };
    });
  };

  const changeAdditionBatch = (batchId: string) => {
    setAdditionForm((current) => {
      if (!current) return current;
      const arrivalDate = batchById.get(batchId)?.arrivalDate ?? current.inDate;
      return {
        ...current,
        batchId,
        inDate: current.inDate < arrivalDate ? arrivalDate : current.inDate,
      };
    });
  };

  const saveAdditionToList = () => {
    if (!permission.requirePermission("create") || !additionForm) return;
    if (!additionForm.subTankId) return toast.error("请选择入库缸位");
    if (!additionForm.productId) return toast.error("请选择商品");
    if (!additionForm.batchId) return toast.error("请选择采购批次");
    if (!Number.isInteger(Number(additionForm.quantity)) || additionForm.quantity <= 0 || additionForm.quantity > 1000) {
      return toast.error("增加数量必须是 1 至 1000 的整数");
    }
    if (!additionForm.inDate) return toast.error("请选择入库日期");
    if (additionForm.inDate > today) return toast.error("入库日期不能晚于今天");
    const arrivalDate = batchById.get(additionForm.batchId)?.arrivalDate;
    if (arrivalDate && additionForm.inDate < arrivalDate) return toast.error("入库日期不能早于采购批次到货日期");
    if (!(Number(additionForm.basePrice) > 0)) return toast.error("请填写大于 0 的单条售价");
    const normalized: InventoryAdjustmentAddition = {
      ...additionForm,
      quantity: Number(additionForm.quantity),
      basePrice: Number(Number(additionForm.basePrice).toFixed(2)),
      code: additionForm.quantity === 1 ? String(additionForm.code ?? "").trim() : "",
      notes: String(additionForm.notes ?? "").trim(),
    };
    setAdditions((current) => editingAdditionId
      ? current.map((item) => item.id === editingAdditionId ? normalized : item)
      : [...current, normalized]
    );
    setEditingAdditionId("");
    setAdditionForm(defaultAddition(normalized.subTankId));
    toast.success(editingAdditionId ? "已更新待增加项" : "已加入盘库单");
  };

  const editAddition = (addition: InventoryAdjustmentAddition) => {
    setEditingAdditionId(addition.id);
    setAdditionForm({ ...addition });
    setSelectedSubTankId(addition.subTankId);
    setMode("add");
  };

  const summary = useMemo<NormalizedAdjustment>(() => {
    const lines: InventoryAdjustmentLine[] = [];
    const lineMap = new Map<string, InventoryAdjustmentLine>();
    const appendLine = (
      subTankId: string,
      productId: string,
      batchId: string,
      direction: "add" | "remove",
      quantity: number,
    ) => {
      const key = [subTankId, productId, batchId, direction].join("\0");
      const current = lineMap.get(key);
      if (current) current.quantity += quantity;
      else lineMap.set(key, { id: uid("adjust-line"), subTankId, productId, batchId, direction, quantity });
    };
    removeStockIds.forEach((id) => {
      const item = visibleStockById.get(id);
      if (item) appendLine(item.subTankId, item.productId, item.batchId, "remove", 1);
    });
    additions.forEach((item) => appendLine(item.subTankId, item.productId, item.batchId, "add", item.quantity));
    lines.push(...lineMap.values());
    const touchedTankIds = new Set([
      ...removeStockIds.map((id) => visibleStockById.get(id)?.subTankId ?? ""),
      ...additions.map((item) => item.subTankId),
    ].filter(Boolean));
    const rows = [...touchedTankIds].map((subTankId) => ({
      subTankId,
      tankLabel: tankById.get(subTankId)?.label ?? subTankId,
      currentCount: visibleStock.filter((item) => item.subTankId === subTankId).length,
      addCount: additions.filter((item) => item.subTankId === subTankId)
        .reduce((sum, item) => sum + item.quantity, 0),
      removeCount: removeStockIds.filter((id) => visibleStockById.get(id)?.subTankId === subTankId).length,
    })).sort((left, right) => left.tankLabel.localeCompare(right.tankLabel, "zh-CN"));
    return {
      lines,
      addCount: additions.reduce((sum, item) => sum + item.quantity, 0),
      removeCount: removeStockIds.length,
      tankCount: touchedTankIds.size,
      rows,
    };
  }, [additions, removeStockIds, tankById, visibleStock, visibleStockById]);

  const validateAdjustment = () => {
    if (summary.addCount === 0 && summary.removeCount === 0) {
      toast.error("请先选择要减少的库存，或添加新的入库项");
      return false;
    }
    if (summary.addCount > 0 && !permission.canCreate) {
      toast.error("当前账号没有新增库存权限");
      return false;
    }
    if (summary.removeCount > 0 && !permission.canDelete) {
      toast.error("当前账号没有删除库存权限");
      return false;
    }
    const changedRemoval = removeStockIds.find((id) => {
      const item = visibleStockById.get(id);
      return !item || stockCannotRemove(item);
    });
    if (changedRemoval) {
      toast.error("待减少库存已发生变化，请重新打开盘库工作台核对");
      return false;
    }
    return true;
  };

  const buildChangePayload = (): StockChangeRequest => {
    const upsert = additions.flatMap((addition) => Array.from({ length: addition.quantity }, () => ({
      id: uid(),
      siteId: workSiteId,
      productId: addition.productId,
      batchId: addition.batchId,
      subTankId: addition.subTankId,
      status: addition.status,
      inDate: addition.inDate,
      basePrice: addition.basePrice,
      commissionRate: 0,
      code: addition.quantity === 1 ? addition.code ?? "" : "",
      notes: [addition.notes, notes.trim() ? `盘库说明：${notes.trim()}` : ""]
        .filter(Boolean).join("\n") || "盘库增加",
    })));
    return {
      ...(upsert.length > 0 ? { upsert } : {}),
      ...(removeStockIds.length > 0 ? { deleteIds: removeStockIds } : {}),
      adjustmentContext: {
        kind: "inventory_adjustment",
        draftId: draft?.id,
        siteId: workSiteId,
        removeStockIds,
        additionStockIds: upsert.map((item) => item.id),
        lines: summary.lines,
      },
    };
  };

  const performSubmit = async (payload: StockChangeRequest, confirmDuplicate = false) => {
    if (submitting) return;
    setSubmitting(true);
    const result = await saveStockChange({ ...payload, confirmDuplicate });
    setSubmitting(false);
    if (result.duplicateConfirmationRequired) {
      setDuplicateRequest({
        payload,
        createdAt: result.duplicate?.createdAt,
        status: result.duplicate?.status,
      });
      return;
    }
    if (!result.ok) {
      toast.error(result.error || "盘库调整提交失败，请重试");
      return;
    }
    setDuplicateRequest(null);
    setSubmitPreview(null);
    setDraft(null);
    setRemoveStockIds([]);
    setAdditions([]);
    setNotes("");
    setDraftReady(false);
    setOpen(false);
    toast.success(result.message || (result.pendingApproval ? "盘库调整已提交审批" : "盘库调整已执行"));
  };

  const stockGroups = useMemo(() => {
    const term = stockQuery.trim().toLocaleLowerCase("zh-CN");
    const items = visibleStock.filter((item) => {
      if (item.subTankId !== selectedSubTankId) return false;
      if (!term) return true;
      const product = productById.get(item.productId);
      const batch = batchById.get(item.batchId);
      return `${product?.name ?? ""} ${product?.origin ?? ""} ${item.code ?? ""} ${batch?.batchNo ?? ""}`
        .toLocaleLowerCase("zh-CN").includes(term);
    });
    const grouped = new Map<string, StockItem[]>();
    items.forEach((item) => grouped.set(item.productId, [...(grouped.get(item.productId) ?? []), item]));
    return [...grouped.entries()]
      .map(([productId, stockItems]) => ({ productId, stockItems }))
      .sort((left, right) => (productById.get(left.productId)?.name ?? "")
        .localeCompare(productById.get(right.productId)?.name ?? "", "zh-CN"));
  }, [batchById, productById, selectedSubTankId, stockQuery, visibleStock]);

  const productOptions = useMemo<SearchOption[]>(() => activeProducts.map((product) => ({
    value: product.id,
    label: product.name,
    description: [product.size, product.origin].filter(Boolean).join(" · "),
    imageUrl: product.imageUrl,
  })), [activeProducts]);
  const batchOptions = useMemo<SearchOption[]>(() => siteBatches.map((batch) => ({
    value: batch.id,
    label: batch.batchNo,
    description: [batch.arrivalDate, batch.supplier].filter(Boolean).join(" · "),
  })), [siteBatches]);

  const renderSummary = () => (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">本次盘库单</h3>
          <Badge variant="secondary">{summary.tankCount} 个缸位</Badge>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
          <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-emerald-800">增加 +{summary.addCount}</div>
          <div className="rounded border border-rose-200 bg-rose-50 px-2 py-1.5 text-rose-800">减少 -{summary.removeCount}</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {summary.rows.length === 0 ? (
          <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
            还没有调整内容
          </div>
        ) : (
          <div className="space-y-2">
            {summary.rows.map((row) => (
              <div key={row.subTankId} className="rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">{row.tankLabel}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>当前 {row.currentCount}</span>
                  {row.removeCount > 0 && <span className="text-rose-700">-{row.removeCount}</span>}
                  {row.addCount > 0 && <span className="text-emerald-700">+{row.addCount}</span>}
                  <span>→ 盘后 {row.currentCount - row.removeCount + row.addCount}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {removeStockIds.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">待减少的具体库存</div>
            <div className="space-y-1.5">
              {removeStockIds.map((id) => {
                const item = visibleStockById.get(id);
                if (!item) return null;
                const product = productById.get(item.productId);
                return (
                  <div key={id} className="flex items-center gap-2 rounded border border-rose-200 bg-rose-50/60 px-2 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate">
                      {tankById.get(item.subTankId)?.tankName} · {product?.name ?? "未知商品"} · {item.code || item.id.slice(-6)}
                    </span>
                    <button type="button" className="text-rose-700" onClick={() => toggleRemoval(item)} title="移出待减少清单">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {additions.length > 0 && (
          <div>
            <div className="mb-2 text-xs font-semibold text-muted-foreground">待增加的入库项</div>
            <div className="space-y-1.5">
              {additions.map((addition) => (
                <div key={addition.id} className="rounded border border-emerald-200 bg-emerald-50/60 px-2 py-2 text-xs">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{productById.get(addition.productId)?.name ?? "未知商品"} × {addition.quantity}</div>
                      <div className="mt-0.5 truncate text-muted-foreground">
                        {tankById.get(addition.subTankId)?.label} · {batchById.get(addition.batchId)?.batchNo}
                      </div>
                    </div>
                    <button type="button" onClick={() => editAddition(addition)} title="编辑待增加项"><Pencil className="size-3.5" /></button>
                    <button
                      type="button"
                      className="text-rose-700"
                      onClick={() => setAdditions((current) => current.filter((item) => item.id !== addition.id))}
                      title="删除待增加项"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="inventory-adjustment-notes" className="text-xs">盘库说明</Label>
          <Textarea
            id="inventory-adjustment-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={1000}
            rows={3}
            placeholder="盘点原因或需要审批人关注的事项"
          />
        </div>
      </div>
    </div>
  );

  const closeWorkbench = () => {
    if (draftSnapshotValue !== lastSavedSnapshotRef.current && (hasWork || draft)) {
      void persistDraft(true, draftSnapshotValue);
    }
    setOpen(false);
  };

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => void loadDraft()} disabled={loading}>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardCheck className="size-3.5" />}
        盘库调整
      </Button>

      <Dialog open={open} onOpenChange={(nextOpen) => {
        if (submitting || savingDraft) return;
        if (!nextOpen && draftSnapshotValue !== lastSavedSnapshotRef.current && (hasWork || draft)) {
          void persistDraft(true, draftSnapshotValue);
        }
        setOpen(nextOpen);
      }}>
        <DialogContent className="h-[100dvh] max-h-[100dvh] gap-0 overflow-hidden rounded-none p-0 sm:h-[94dvh] sm:max-h-[94dvh] sm:max-w-[calc(100vw-2rem)] sm:rounded-lg xl:max-w-[94rem]">
          <DialogHeader className="shrink-0 gap-1 border-b px-4 py-3 pr-12 sm:px-5 sm:py-4 sm:pr-12">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <DialogTitle>盘库工作台</DialogTitle>
              <span className="text-xs text-muted-foreground">
                {draftState === "dirty" ? "有修改，正在自动保存" :
                  draftState === "saved" ? `已保存${draft?.updatedAt ? ` · ${formatDraftTime(draft.updatedAt)}` : ""}` :
                    draftState === "error" ? "自动保存失败，请手动保存" : "尚未形成草稿"}
              </span>
            </div>
            <DialogDescription>直接对照当前在缸库存选择减少个体，新增库存按入库信息登记。</DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="flex shrink-0 items-center justify-between gap-2 border-b bg-sky-50 px-4 py-2 text-xs text-sky-900 sm:px-5">
              <span>已载入当前账号唯一盘库草稿</span>
              <Button type="button" size="sm" variant="ghost" className="h-7 text-sky-800" onClick={() => void discardDraft()} disabled={savingDraft}>
                <RotateCcw className="size-3.5" />清除草稿
              </Button>
            </div>
          )}

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b bg-muted/30 p-2 sm:px-4">
              <Button type="button" size="sm" variant={mode === "remove" ? "default" : "ghost"} onClick={() => setMode("remove")} disabled={!permission.canDelete}>
                <Minus className="size-4" />减少库存
              </Button>
              <Button type="button" size="sm" variant={mode === "add" ? "default" : "ghost"} onClick={() => setMode("add")} disabled={!permission.canCreate}>
                <PackagePlus className="size-4" />增加库存
              </Button>
              <Button type="button" size="sm" variant={mode === "review" ? "default" : "ghost"} onClick={() => setMode("review")} className="xl:hidden">
                <ClipboardCheck className="size-4" />盘库单
                {(summary.addCount + summary.removeCount) > 0 && <Badge className="ml-0.5 px-1.5">{summary.addCount + summary.removeCount}</Badge>}
              </Button>
            </div>

            <div className="grid min-h-0 flex-1 xl:grid-cols-[15rem_minmax(0,1fr)_22rem]">
              <aside className="hidden min-h-0 flex-col border-r bg-muted/15 xl:flex">
                <div className="border-b px-3 py-3 text-xs font-semibold text-muted-foreground">选择缸位</div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {siteGroups.map((group) => (
                    <div key={group.id} className="mb-3">
                      <div className="px-2 pb-1 text-xs font-semibold text-muted-foreground">{group.name}</div>
                      <div className="space-y-1">
                        {group.subTanks.map((tank) => {
                          const count = visibleStock.filter((item) => item.subTankId === tank.id).length;
                          const selected = tank.id === selectedSubTankId;
                          return (
                            <button
                              key={tank.id}
                              type="button"
                              className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-left text-sm ${selected ? "bg-slate-900 text-white" : "hover:bg-muted"}`}
                              onClick={() => chooseTank(tank.id)}
                            >
                              <span className="truncate">{tank.name}</span>
                              <span className={`text-xs ${selected ? "text-white/70" : "text-muted-foreground"}`}>{count}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </aside>

              <main className="min-h-0 overflow-y-auto">
                {mode !== "review" && (
                  <div className="border-b p-3 xl:hidden">
                    <Label className="mb-1.5 block text-xs">当前缸位</Label>
                    <Select value={selectedSubTankId} onValueChange={chooseTank}>
                      <SelectTrigger className="h-11 sm:h-9"><SelectValue placeholder="选择缸位" /></SelectTrigger>
                      <SelectContent>
                        {tankOptions.map((tank) => <SelectItem key={tank.id} value={tank.id}>{tank.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {mode === "remove" && (
                  <div className="p-3 sm:p-5">
                    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h3 className="text-base font-semibold">{tankById.get(selectedSubTankId)?.label ?? "请选择缸位"}</h3>
                        <p className="mt-0.5 text-xs text-muted-foreground">点击具体鱼只加入待减少清单；已完成或已发货库存不可选。</p>
                      </div>
                      <div className="relative w-full sm:w-72">
                        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input value={stockQuery} onChange={(event) => setStockQuery(event.target.value)} placeholder="搜索商品、编号或批次" className="pl-9" />
                      </div>
                    </div>
                    {stockGroups.length === 0 ? (
                      <div className="rounded-md border border-dashed px-4 py-14 text-center text-sm text-muted-foreground">
                        {selectedSubTankId ? "该缸位没有匹配的在缸库存" : "请选择需要盘点的缸位"}
                      </div>
                    ) : (
                      <div className="divide-y rounded-md border bg-background">
                        {stockGroups.map(({ productId, stockItems }) => {
                          const product = productById.get(productId);
                          return (
                            <section key={productId} className="p-3 sm:p-4">
                              <div className="mb-3 flex items-center gap-3">
                                <div className="size-10 shrink-0 overflow-hidden rounded-md border bg-muted">
                                  {product?.imageUrl ? <ImageWithFallback src={product.imageUrl} alt="" className="size-full object-cover" /> : null}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-semibold">{product?.name ?? productId}</div>
                                  <div className="truncate text-xs text-muted-foreground">{[product?.size, product?.origin].filter(Boolean).join(" · ") || "未填写规格产地"}</div>
                                </div>
                                <Badge variant="secondary">{stockItems.length} 条</Badge>
                              </div>
                              <div className="grid grid-cols-3 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))]">
                                {stockItems.map((item) => {
                                  const selected = removeStockIds.includes(item.id);
                                  const locked = stockCannotRemove(item);
                                  const orderCount = pendingOrderCountByStockId.get(item.id) ?? 0;
                                  const batch = batchById.get(item.batchId);
                                  return (
                                    <button
                                      key={item.id}
                                      type="button"
                                      disabled={locked}
                                      onClick={() => toggleRemoval(item)}
                                      className={`relative min-h-28 overflow-hidden rounded-md border p-2 text-left transition-colors ${
                                        selected ? "border-rose-500 bg-rose-50 ring-1 ring-rose-500" :
                                          orderCount > 0 ? "border-amber-300 bg-amber-50/50" : "hover:border-slate-400"
                                      } ${locked ? "cursor-not-allowed opacity-55" : ""}`}
                                      title={locked ? stockLockReason(item) : orderCount > 0 ? `关联 ${orderCount} 个未出库订单` : "选择减少该库存"}
                                    >
                                      <div className="flex items-start gap-2">
                                        <div className="size-11 shrink-0 overflow-hidden rounded border bg-muted">
                                          {product?.imageUrl ? <ImageWithFallback src={product.imageUrl} alt="" className="size-full object-cover" /> : null}
                                        </div>
                                        {selected ? <Check className="ml-auto size-4 text-rose-700" /> : locked ? <LockKeyhole className="ml-auto size-4 text-muted-foreground" /> : null}
                                      </div>
                                      <div className="mt-2 truncate text-xs font-semibold">{item.code || `ID ${item.id.slice(-6)}`}</div>
                                      <div className="mt-1 truncate text-[11px] text-muted-foreground">{batch?.batchNo ?? `入库 ${item.inDate}`}</div>
                                      <div className="mt-1 flex flex-wrap gap-1">
                                        <span className={`rounded border px-1 py-0.5 text-[10px] ${STATUS_META[item.status].className}`}>{STATUS_META[item.status].label}</span>
                                        {orderCount > 0 && <span className="rounded border border-amber-300 bg-amber-100 px-1 py-0.5 text-[10px] text-amber-900">订单占用</span>}
                                      </div>
                                    </button>
                                  );
                                })}
                              </div>
                            </section>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                {mode === "add" && additionForm && (
                  <div className="mx-auto max-w-3xl p-3 sm:p-5">
                    <div className="mb-4">
                      <h3 className="text-base font-semibold">{editingAdditionId ? "编辑待增加项" : "增加库存"}</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">填写方式与普通入库一致，加入盘库单后可继续登记其他缸位。</p>
                    </div>
                    <div className="grid gap-4 rounded-md border bg-background p-3 sm:grid-cols-2 sm:p-5">
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label>入库缸位 *</Label>
                        <Select value={additionForm.subTankId} onValueChange={(value) => {
                          setAdditionForm({ ...additionForm, subTankId: value });
                          setSelectedSubTankId(value);
                        }}>
                          <SelectTrigger className="h-11 sm:h-9"><SelectValue placeholder="选择缸位" /></SelectTrigger>
                          <SelectContent>
                            {tankOptions.map((tank) => <SelectItem key={tank.id} value={tank.id}>{tank.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label>商品 *</Label>
                        <SearchPicker
                          value={additionForm.productId}
                          options={productOptions}
                          placeholder="选择商品"
                          searchPlaceholder="输入商品名、规格或产地"
                          onChange={changeAdditionProduct}
                        />
                      </div>
                      <div className="grid gap-1.5 sm:col-span-2">
                        <Label>采购批次 *</Label>
                        <SearchPicker
                          value={additionForm.batchId}
                          options={batchOptions}
                          placeholder="选择采购批次"
                          searchPlaceholder="搜索批次号、供应商或日期"
                          onChange={changeAdditionBatch}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>入库日期 *</Label>
                        <Input
                          type="date"
                          min={batchById.get(additionForm.batchId)?.arrivalDate}
                          max={today}
                          value={additionForm.inDate}
                          onChange={(event) => setAdditionForm({ ...additionForm, inDate: event.target.value })}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>增加数量 *</Label>
                        <Input
                          type="number"
                          min={1}
                          max={1000}
                          value={additionForm.quantity || ""}
                          onChange={(event) => setAdditionForm({ ...additionForm, quantity: Number(event.target.value) })}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>单条售价（¥）*</Label>
                        <Input
                          type="number"
                          min={0.01}
                          step={0.01}
                          value={additionForm.basePrice || ""}
                          onChange={(event) => setAdditionForm({ ...additionForm, basePrice: Number(event.target.value) })}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>状态</Label>
                        <Select value={additionForm.status} onValueChange={(value: StockStatus) => setAdditionForm({ ...additionForm, status: value })}>
                          <SelectTrigger className="h-11 sm:h-9"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="healthy">正常</SelectItem>
                            <SelectItem value="feeding">开口</SelectItem>
                            <SelectItem value="sick">疾病</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label>鱼只编号</Label>
                        <Input
                          value={additionForm.code ?? ""}
                          disabled={additionForm.quantity > 1}
                          onChange={(event) => setAdditionForm({ ...additionForm, code: event.target.value })}
                          placeholder={additionForm.quantity > 1 ? "批量增加时不填写编号" : "可选"}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>本项备注</Label>
                        <Input value={additionForm.notes ?? ""} onChange={(event) => setAdditionForm({ ...additionForm, notes: event.target.value })} placeholder="可选" />
                      </div>
                      <div className="flex flex-col-reverse gap-2 border-t pt-3 sm:col-span-2 sm:flex-row sm:justify-end">
                        {editingAdditionId && (
                          <Button type="button" variant="outline" onClick={() => {
                            setEditingAdditionId("");
                            setAdditionForm(defaultAddition(selectedSubTankId));
                          }}>取消编辑</Button>
                        )}
                        <Button type="button" onClick={saveAdditionToList}>
                          <Plus className="size-4" />{editingAdditionId ? "更新待增加项" : "加入盘库单"}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {mode === "review" && <div className="flex min-h-full flex-col xl:hidden">{renderSummary()}</div>}
              </main>

              <aside className="hidden min-h-0 border-l bg-muted/10 xl:flex">{renderSummary()}</aside>
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t bg-background px-3 py-3 sm:px-5">
            <Button type="button" variant="outline" onClick={closeWorkbench} disabled={submitting}>关闭</Button>
            <Button type="button" variant="outline" onClick={() => void persistDraft(false)} disabled={submitting || savingDraft}>
              {savingDraft ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存进度
            </Button>
            <Button type="button" onClick={() => {
              if (validateAdjustment()) setSubmitPreview(summary);
            }} disabled={submitting || savingDraft || summary.addCount + summary.removeCount === 0}>
              <ClipboardCheck className="size-4" />统一提交
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!submitPreview} onOpenChange={(nextOpen) => !nextOpen && !submitting && setSubmitPreview(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认统一提交盘库调整</AlertDialogTitle>
            <AlertDialogDescription>
              本次涉及 {submitPreview?.tankCount ?? 0} 个缸位，增加 {submitPreview?.addCount ?? 0} 条、减少 {submitPreview?.removeCount ?? 0} 条。
              {permission.isAdmin ? "提交后将直接执行。" : "提交后等待管理员审批，批准前不会修改库存。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-56 space-y-2 overflow-y-auto text-sm">
            {submitPreview?.rows.map((row) => (
              <div key={row.subTankId} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
                <span className="truncate font-medium">{row.tankLabel}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.currentCount} {row.removeCount > 0 ? `-${row.removeCount}` : ""} {row.addCount > 0 ? `+${row.addCount}` : ""} → {row.currentCount - row.removeCount + row.addCount}
                </span>
              </div>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>返回检查</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => {
              event.preventDefault();
              setSubmitPreview(null);
              void performSubmit(buildChangePayload());
            }} disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
              确认提交
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!duplicateRequest} onOpenChange={(nextOpen) => !nextOpen && !submitting && setDuplicateRequest(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-600" />检测到重复申请
            </AlertDialogTitle>
            <AlertDialogDescription>
              10 分钟内提交过完全相同的盘库调整
              {duplicateRequest?.createdAt ? `（${formatDraftTime(duplicateRequest.createdAt)}）` : ""}。
              {duplicateRequest?.status === "pending"
                ? "原申请仍在等待审批，继续确认不会重复创建第二条申请。"
                : "如现场确实再次发生了相同变化，可继续提交。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (duplicateRequest) void performSubmit(duplicateRequest.payload, true);
              }}
              disabled={submitting}
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : duplicateRequest?.status === "pending" ? <RotateCcw className="size-4" /> : <Plus className="size-4" />}
              {duplicateRequest?.status === "pending" ? "沿用原申请" : "仍要提交"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
