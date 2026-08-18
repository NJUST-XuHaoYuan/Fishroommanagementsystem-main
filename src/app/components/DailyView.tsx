import { useState, useRef, useMemo } from "react";
import { useStore, DailyLog, Order, Shipment, StockStatus, StockItem, TankGroup, isPersonnelResigned, uid } from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { StatusBadge, statusRingClass, statusFrameClass } from "./StatusIcon";
import { Search, Fish, Camera, Clock, PackageCheck, ShoppingBag, X, Plus, ChevronDown, Video, Download, ArrowRightLeft, AlertTriangle, Check, ClipboardList, FlaskConical, Truck, ExternalLink, Pencil, Trash2, Loader2, UploadCloud } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { toast } from "sonner";
import { getInventoryOutStockIds, isPhysicallyInTank } from "../utils/inventory";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";
import { authJsonHeaders } from "../utils/authSession";
import { normalizeSiteId, siteName } from "../utils/sites";
import { ORIGINAL_VIDEO_ACCEPT, downloadMedia, uploadOriginalMedia } from "../utils/media";
import { MediaVideo } from "./MediaVideo";
import { buildStockPriceBaselines, isStockSpecialPrice } from "../utils/stockPricing";
import { buildPublicSelectionCode, parsePublicSelectionCode } from "../utils/publicSelectionCode";
import { WaterQualityRecordsPanel } from "./WaterQualityRecordsPanel";
import { PreciseDateTimeInput } from "./PreciseDateTimeInput";
import { useRecordMediaUpload } from "../utils/useRecordMediaUpload";
import { bioRecordFromDraft, hasBioRecordDraftContent } from "../utils/bioRecordDraft";
import {
  formatBioRecordTime,
  isoToDatetimeLocal,
  minDatetimeForDate,
  normalizeBioRecordTime,
  nowDatetimeLocal,
} from "../utils/localDateTime";

type RecordDraft = { date: string; text: string; photos: string[]; videos: string[] };

function todayDateString(): string {
  return nowDatetimeLocal().slice(0, 10);
}

type DailyViewProps = {
  allTankGroups?: TankGroup[];
  allOrders?: Order[];
  allShipments?: Shipment[];
  onOpenOrder?: (orderId: string) => void;
};

export function DailyView({ allTankGroups, allOrders, allShipments, onOpenOrder }: DailyViewProps = {}) {
  const { state, setState, saveStateTransform, saveDailyLog, saveMaintenanceAction } = useStore();
  const permission = usePermission("daily");
  const [q, setQ] = useState("");
  const [filterStatuses, setFilterStatuses] = useState<Set<StockStatus>>(new Set());
  const [filterSoldOnly, setFilterSoldOnly] = useState(false);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState("visual");
  const [recordGroupFilter, setRecordGroupFilter] = useState("all");
  const [viewRecordGroupId, setViewRecordGroupId] = useState<string | null>(null);
  const dailyViewRef = useRef<HTMLDivElement>(null);
  const recordScrollSnapshotRef = useRef<{ element: HTMLElement; top: number } | null>(null);
  const [publicLookupCode, setPublicLookupCode] = useState("");
  const [highlightStockId, setHighlightStockId] = useState("");

  // Bio detail dialog state
  const [bioOpen, setBioOpen] = useState(false);
  const [bioItemId, setBioItemId] = useState<string | null>(null);
  const [bioStatus, setBioStatus] = useState<StockStatus>("healthy");
  const [bioBasePrice, setBioBasePrice] = useState("");
  const [bioCode, setBioCode] = useState("");
  const [bioNotes, setBioNotes] = useState("");
  const [newRecord, setNewRecord] = useState<RecordDraft>({
    date: nowDatetimeLocal(),
    text: "",
    photos: [],
    videos: [],
  });
  const {
    dropZoneProps: recordMediaDropZoneProps,
    isDragging: recordMediaDragging,
    isUploading: recordMediaUploading,
    pasteFiles: pasteRecordMedia,
    uploadImages: uploadRecordPhotos,
    uploadVideos: uploadRecordVideos,
  } = useRecordMediaUpload(setNewRecord, permission.canCreate);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [editingRecordTime, setEditingRecordTime] = useState("");
  const [confirmTimeChangeOpen, setConfirmTimeChangeOpen] = useState(false);
  const [deletingRecordId, setDeletingRecordId] = useState<string | null>(null);
  const [recordActionSaving, setRecordActionSaving] = useState(false);
  const photoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  // Log dialog state
  const [logOpen, setLogOpen] = useState(false);
  const [editingLog, setEditingLog] = useState<DailyLog | null>(null);
  const [logSaving, setLogSaving] = useState(false);

  // Batch move state
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveItemIds, setMoveItemIds] = useState<string[]>([]);
  const [targetGroupId, setTargetGroupId] = useState("");
  const [targetSubTankId, setTargetSubTankId] = useState("");
  const [moveNotes, setMoveNotes] = useState("");
  const [moveSaving, setMoveSaving] = useState(false);

  // Batch observation/treatment state
  const [batchRecordOpen, setBatchRecordOpen] = useState(false);
  const [batchRecordItemIds, setBatchRecordItemIds] = useState<string[]>([]);
  const [batchRecord, setBatchRecord] = useState<RecordDraft>({
    date: nowDatetimeLocal(),
    text: "",
    photos: [],
    videos: [],
  });
  const [batchRecordSaving, setBatchRecordSaving] = useState(false);
  const batchPhotoRef = useRef<HTMLInputElement>(null);
  const batchVideoRef = useRef<HTMLInputElement>(null);

  // Batch status state
  const [batchStatusOpen, setBatchStatusOpen] = useState(false);
  const [batchStatusItemIds, setBatchStatusItemIds] = useState<string[]>([]);
  const [batchTargetStatus, setBatchTargetStatus] = useState<StockStatus>("healthy");
  const [batchStatusSaving, setBatchStatusSaving] = useState(false);

  // Loss state
  const [lossOpen, setLossOpen] = useState(false);
  const [lossItemIds, setLossItemIds] = useState<string[]>([]);
  const [lossDate, setLossDate] = useState(todayDateString());
  const [lossReason, setLossReason] = useState("");
  const [lossProof, setLossProof] = useState<string[]>([]);
  const [lossSaving, setLossSaving] = useState(false);
  const lossPhotoRef = useRef<HTMLInputElement>(null);

  const today = todayDateString();
  const nowForRecord = nowDatetimeLocal();
  const shippedOutStockIds = getInventoryOutStockIds(state);
  const canBatchSelect = permission.canCreate || permission.canUpdate || permission.canDelete;
  const product = (id: string) => state.products.find((p) => p.id === id);
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
  const batch = (id: string) => state.batches.find((b) => b.id === id);
  const stockItem = (id: string) => state.stock.find((s) => s.id === id);
  const timelineOrders = allOrders ?? state.orders;
  const timelineShipments = allShipments ?? state.shipments;
  const relatedOrderForStock = (stockItemId: string) =>
    timelineOrders.find((order) =>
      order.status !== "cancelled" && order.items.some((item) => item.stockItemId === stockItemId)
    );

  const subTankName = (id: string) => {
    for (const g of state.tankGroups) {
      const t = g.subTanks.find((x) => x.id === id);
      if (t) return `${g.name} / ${t.name}`;
    }
    return "—";
  };
  const groupIdBySubTank = (subTankId?: string) => {
    if (!subTankId) return "";
    return state.tankGroups.find((group) =>
      group.subTanks.some((tank) => tank.id === subTankId)
    )?.id ?? "";
  };
  const logGroupId = (log: DailyLog) => log.tankGroupId || groupIdBySubTank(log.subTankId);
  const groupName = (groupId?: string) =>
    state.tankGroups.find((group) => group.id === groupId)?.name ?? "—";
  const currentOperator =
    (state.personnel ?? []).find((person) => person.username === state.user?.username && !isPersonnelResigned(person))?.name ??
    state.user?.username ??
    "";
  const operatorOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];

    for (const person of state.personnel ?? []) {
      if (isPersonnelResigned(person)) continue;
      const value = person.name || person.username;
      if (!value || seen.has(value)) continue;
      seen.add(value);
      options.push({
        value,
        label: person.username && person.username !== value ? `${value}（${person.username}）` : value,
      });
    }

    if (editingLog?.operator && !seen.has(editingLog.operator)) {
      options.unshift({ value: editingLog.operator, label: `${editingLog.operator}（历史）` });
    }

    return options;
  }, [state.personnel, editingLog?.operator]);
  const logsByGroup = useMemo(() => {
    const map = new Map<string, DailyLog[]>();
    for (const log of state.logs ?? []) {
      const gid = logGroupId(log);
      if (!gid) continue;
      map.set(gid, [...(map.get(gid) ?? []), log]);
    }
    for (const [gid, logs] of map) {
      map.set(gid, logs.sort((a, b) => b.date.localeCompare(a.date)));
    }
    return map;
  }, [state.logs, state.tankGroups]);
  const waterRecordsByGroup = useMemo(() => {
    const map = new Map<string, typeof state.waterQualityRecords>();
    for (const record of state.waterQualityRecords ?? []) {
      map.set(record.tankGroupId, [...(map.get(record.tankGroupId) ?? []), record]);
    }
    for (const [groupId, records] of map) {
      map.set(groupId, records.sort((a, b) => b.measuredAt.localeCompare(a.measuredAt)));
    }
    return map;
  }, [state.waterQualityRecords]);

  const formatWaterSummary = (values: (typeof state.waterQualityRecords)[number]["values"]) => {
    const visibleValues = values.slice(0, 4).map((measurement) => {
      const precision = Math.max(0, Math.min(4, Math.trunc(Number(measurement.precision ?? 0))));
      const value = Number(measurement.value);
      return `${measurement.parameterName || measurement.parameterId} ${Number.isFinite(value) ? value.toFixed(precision) : "—"}${measurement.unit ? ` ${measurement.unit}` : ""}`;
    });
    return `${visibleValues.join(" · ")}${values.length > visibleValues.length ? ` · 另 ${values.length - visibleValues.length} 项` : ""}`;
  };

  const openGroupRecords = (groupId: string) => {
    let scrollElement = dailyViewRef.current?.parentElement ?? null;
    while (scrollElement) {
      const style = window.getComputedStyle(scrollElement);
      if (/(auto|scroll)/.test(style.overflowY) && scrollElement.scrollHeight > scrollElement.clientHeight) break;
      scrollElement = scrollElement.parentElement;
    }
    const fallbackScrollElement = document.scrollingElement instanceof HTMLElement
      ? document.scrollingElement
      : document.documentElement;
    const snapshotElement = scrollElement ?? fallbackScrollElement;
    recordScrollSnapshotRef.current = { element: snapshotElement, top: snapshotElement.scrollTop };
    setViewRecordGroupId(groupId);
  };
  const closeGroupRecords = () => {
    const snapshot = recordScrollSnapshotRef.current;
    setViewRecordGroupId(null);
    if (!snapshot) return;
    window.requestAnimationFrame(() => {
      snapshot.element.scrollTop = snapshot.top;
      recordScrollSnapshotRef.current = null;
    });
  };
  const viewRecordGroup = viewRecordGroupId
    ? state.tankGroups.find((group) => group.id === viewRecordGroupId) ?? null
    : null;

  const toggleStatusFilter = (st: StockStatus) =>
    setFilterStatuses((prev) => {
      const next = new Set(prev);
      next.has(st) ? next.delete(st) : next.add(st);
      return next;
    });

  const normalizeSearchText = (value: string) =>
    value
      .toLowerCase()
      .replace(/[－–—]/g, "-")
      .replace(/\s+/g, "")
      .trim();

  const tankContextBySubId = (subTankId: string) => {
    for (const group of state.tankGroups) {
      const tank = group.subTanks.find((x) => x.id === subTankId);
      if (tank) return { group, tank };
    }
    return null;
  };
  const siteIdForStockItem = (item?: StockItem | null) => {
    if (!item) return "";
    const tankSiteId = tankContextBySubId(item.subTankId)?.group.siteId;
    return normalizeSiteId(tankSiteId ?? item.siteId);
  };

  // 是否有任何过滤条件激活
  const term = normalizeSearchText(q);
  const anyFilter = filterStatuses.size > 0 || filterSoldOnly || term.length > 0;

  const tankMatchesTerm = (group: (typeof state.tankGroups)[number], tank: (typeof state.tankGroups)[number]["subTanks"][number]) => {
    if (!term) return false;
    const groupName = normalizeSearchText(group.name);
    const tankName = normalizeSearchText(tank.name);
    return (
      groupName.includes(term) ||
      tankName.includes(term) ||
      normalizeSearchText(`${group.name}/${tank.name}`).includes(term) ||
      normalizeSearchText(`${group.name}${tank.name}`).includes(term)
    );
  };

  // 单条鱼是否通过过滤
  const itemMatches = (s: StockItem): boolean => {
    if (!isPhysicallyInTank(s, shippedOutStockIds)) return false;
    if (filterStatuses.size > 0 || filterSoldOnly) {
      const matchesStatus = filterStatuses.has(s.status) && !s.sold;
      const matchesSold = filterSoldOnly && Boolean(s.sold);
      if (!matchesStatus && !matchesSold) return false;
    }
    if (term) {
      const p = product(s.productId);
      const pName = normalizeSearchText(p?.name ?? "");
      const code = normalizeSearchText(s.code ?? "");
      const notes = normalizeSearchText(s.notes ?? "");
      const ctx = tankContextBySubId(s.subTankId);
      const gName = ctx ? normalizeSearchText(ctx.group.name) : "";
      const tName = ctx ? normalizeSearchText(ctx.tank.name) : "";
      if (!pName.includes(term) && !code.includes(term) && !gName.includes(term) && !tName.includes(term) && !notes.includes(term))
        return false;
    }
    return true;
  };

  const subTankMatchesFilters = (g: (typeof state.tankGroups)[number], t: (typeof state.tankGroups)[number]["subTanks"][number]) => {
    if (term && tankMatchesTerm(g, t)) return true;
    return state.stock.some((s) => s.subTankId === t.id && itemMatches(s));
  };

  const filteredGroups = state.tankGroups.filter((g) => {
    if (!anyFilter) return true;
    if (term && normalizeSearchText(g.name).includes(term)) return true;
    return g.subTanks.some((t) => subTankMatchesFilters(g, t));
  });

  const visibleGroups = filteredGroups;

  const visibleSubTanks = (g: (typeof state.tankGroups)[number]) =>
    anyFilter ? g.subTanks.filter((t) => subTankMatchesFilters(g, t)) : g.subTanks;

  const stockBySub = (subId: string) => {
    const ctx = tankContextBySubId(subId);
    const matchedByTank = !!ctx && term.length > 0 && tankMatchesTerm(ctx.group, ctx.tank);
    return state.stock.filter((s) =>
      s.subTankId === subId &&
      isPhysicallyInTank(s, shippedOutStockIds) &&
      (!anyFilter || matchedByTank || itemMatches(s))
    );
  };

  /** 同一子缸内按 productId 分组 */
  const groupByProduct = (items: ReturnType<typeof stockBySub>) => {
    const map = new Map<string, typeof items>();
    for (const s of items) {
      const arr = map.get(s.productId) ?? [];
      arr.push(s);
      map.set(s.productId, arr);
    }
    return [...map.entries()];
  };

  const toggleExpand = (key: string) =>
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const toggleGroupExpand = (groupId: string) =>
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });

  const toggleSelectItem = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleVisibleSelection = (items: StockItem[], emptyMessage: string) => {
    if (!canBatchSelect) {
      permission.requirePermission("create");
      return;
    }
    const ids = items.map((item) => item.id);
    if (ids.length === 0) {
      toast.error(emptyMessage);
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

  const visibleSpeciesItems = (items: StockItem[], speciesId: string) =>
    items.filter((item) => speciesIdOfProduct(item.productId) === speciesId);

  const enterSelectMode = () => {
    if (!canBatchSelect) {
      permission.requirePermission("create");
      return;
    }
    setSelectMode((v) => {
      const next = !v;
      if (!next) setSelectedIds(new Set());
      return next;
    });
  };

  const selectedItems = Array.from(selectedIds)
    .map((id) => stockItem(id))
    .filter(Boolean) as StockItem[];

  const movingItems = moveItemIds
    .map((id) => stockItem(id))
    .filter(Boolean) as StockItem[];
  const moveTargetGroups = allTankGroups?.length ? allTankGroups : state.tankGroups;
  const targetSubTanks = moveTargetGroups.find((g) => g.id === targetGroupId)?.subTanks ?? [];
  const batchRecordItems = batchRecordItemIds
    .map((id) => stockItem(id))
    .filter(Boolean) as StockItem[];
  const batchRecordMinDate = batchRecordItems.reduce(
    (latest, item) => (item.inDate && item.inDate > latest ? item.inDate : latest),
    ""
  );
  const batchStatusItems = batchStatusItemIds
    .map((id) => stockItem(id))
    .filter(Boolean) as StockItem[];
  const lossItems = lossItemIds
    .map((id) => stockItem(id))
    .filter(Boolean) as StockItem[];
  const lossMinDate = lossItems.reduce(
    (latest, item) => (item.inDate && item.inDate > latest ? item.inDate : latest),
    ""
  );
  const lossRelatedOrderNos = Array.from(new Set(
    lossItems
      .map((item) => relatedOrderForStock(item.id)?.orderNo)
      .filter((orderNo): orderNo is string => !!orderNo)
  ));
  const changeLossDate = (value: string) => {
    if (value && value > today) {
      toast.error("损耗日期不能晚于今天");
      return;
    }
    if (lossMinDate && value && value < lossMinDate) {
      toast.error(`损耗日期不能早于最晚入库日期 ${lossMinDate}`);
      return;
    }
    setLossDate(value);
  };

  const changeBatchRecordDate = (value: string) => {
    const normalized = normalizeBioRecordTime(value);
    if (normalized && normalized > nowForRecord) {
      toast.error("记录时间不能晚于当前时间");
      return;
    }
    const minTime = minDatetimeForDate(batchRecordMinDate);
    if (normalized && minTime && normalized < minTime) {
      toast.error(`记录时间不能早于最晚入库日期 ${batchRecordMinDate}`);
      return;
    }
    setBatchRecord((p) => ({ ...p, date: normalized }));
  };

  const openMoveDialog = (ids: string[]) => {
    if (!permission.requirePermission("update")) return;
    const validIds = ids.filter((id) => {
      const item = stockItem(id);
      return item && isPhysicallyInTank(item, shippedOutStockIds);
    });
    if (validIds.length === 0) return toast.error("请选择要移缸的鱼");
    const first = stockItem(validIds[0]);
    const currentGroupId = first
      ? state.tankGroups.find((g) => g.subTanks.some((t) => t.id === first.subTankId))?.id
      : "";
    const sourceSiteId = siteIdForStockItem(first);
    const sameSiteGroups = moveTargetGroups.filter((group) => normalizeSiteId(group.siteId) === sourceSiteId);
    const defaultGroup =
      sameSiteGroups.find((g) => g.id !== currentGroupId) ??
      sameSiteGroups[0] ??
      moveTargetGroups.find((g) => g.id !== currentGroupId) ??
      moveTargetGroups[0];
    if (!defaultGroup) return toast.error("没有可选择的目标缸组");
    setMoveItemIds(validIds);
    setTargetGroupId(defaultGroup?.id ?? "");
    setTargetSubTankId("");
    setMoveNotes("");
    setBioOpen(false);
    setMoveOpen(true);
  };

  const submitMove = async () => {
    if (!permission.requirePermission("update")) return;
    if (moveItemIds.length === 0) return toast.error("请选择要移缸的鱼");
    if (!targetSubTankId) return toast.error("请选择目标子缸");
    if (movingItems.length > 0 && movingItems.every((item) => item.subTankId === targetSubTankId))
      return toast.error("目标子缸与当前子缸相同");
    const targetGroup = moveTargetGroups.find((group) =>
      group.subTanks.some((tank) => tank.id === targetSubTankId)
    );
    if (!targetGroup) return toast.error("目标子缸不存在或已被删除");
    if (!confirmWrite("移缸", `将移动 ${moveItemIds.length} 条鱼到目标子缸。`)) return;
    setMoveSaving(true);
    const ok = await saveMaintenanceAction({
      mode: "move",
      itemIds: moveItemIds,
      targetSubTankId,
      moveDate: today,
      moveNotes: moveNotes.trim(),
    });
    setMoveSaving(false);
    if (!ok) return toast.error("移缸保存失败，请刷新后重试");
    setMoveOpen(false);
    setSelectedIds(new Set());
    setSelectMode(false);
    toast.success(`已移缸 ${moveItemIds.length} 条`);
  };

  const openBatchStatusDialog = (ids: string[]) => {
    if (!permission.requirePermission("update")) return;
    const validIds = Array.from(new Set(ids)).filter((id) => {
      const item = stockItem(id);
      return item && isPhysicallyInTank(item, shippedOutStockIds);
    });
    if (validIds.length === 0) return toast.error("请选择要设置状态的鱼");
    setBatchStatusItemIds(validIds);
    setBatchTargetStatus("healthy");
    setBioOpen(false);
    setBatchStatusOpen(true);
  };

  const submitBatchStatus = async () => {
    if (!permission.requirePermission("update")) return;
    if (batchStatusItems.length === 0) return toast.error("请选择要设置状态的鱼");
    const statusLabel = statusMeta[batchTargetStatus].label;
    const changedCount = batchStatusItems.filter((item) => item.status !== batchTargetStatus).length;
    if (changedCount === 0) return toast.error(`所选鱼已经全部是${statusLabel}状态`);
    if (!confirmWrite("批量状态", `将 ${batchStatusItems.length} 条鱼设置为「${statusLabel}」状态。`)) return;
    setBatchStatusSaving(true);
    const ok = await saveMaintenanceAction({
      mode: "status",
      itemIds: batchStatusItems.map((item) => item.id),
      targetStatus: batchTargetStatus,
    });
    setBatchStatusSaving(false);
    if (!ok) return toast.error("状态保存失败，请刷新后重试");
    setBatchStatusOpen(false);
    setBatchStatusItemIds([]);
    setSelectedIds(new Set());
    setSelectMode(false);
    toast.success(`已更新状态 ${changedCount} 条`);
  };

  const openBatchRecordDialog = (ids: string[]) => {
    if (!permission.requirePermission("create")) return;
    const validIds = Array.from(new Set(ids)).filter((id) => {
      const item = stockItem(id);
      return item && isPhysicallyInTank(item, shippedOutStockIds);
    });
    if (validIds.length === 0) return toast.error("请选择要维护记录的鱼");
    setBatchRecordItemIds(validIds);
    setBatchRecord({ date: nowDatetimeLocal(), text: "", photos: [], videos: [] });
    setBioOpen(false);
    setBatchRecordOpen(true);
  };

  const handleBatchPhotoUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(async (file) => {
      if (!file.type.startsWith("image/")) { toast.error("请选择图片文件"); return; }
      try {
        toast.info("照片原图上传中…");
        const url = await uploadOriginalMedia(file);
        setBatchRecord((prev) => ({ ...prev, photos: [...prev.photos, url] }));
        toast.success("照片已上传");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "照片上传失败，请重试");
      }
    });
  };

  const handleBatchVideoUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(async (file) => {
      if (!file.type.startsWith("video/")) { toast.error("请选择视频文件"); return; }
      try {
        toast.info("视频原文件上传中…");
        const url = await uploadOriginalMedia(file);
        setBatchRecord((prev) => ({ ...prev, videos: [...prev.videos, url] }));
        toast.success("视频已上传");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "视频上传失败，请重试");
      }
    });
  };

  const submitBatchRecord = async () => {
    if (!permission.requirePermission("create")) return;
    if (batchRecordItems.length === 0) return toast.error("请选择要维护记录的鱼");
    if (!batchRecord.date) return toast.error("请选择记录时间");
    const recordTime = normalizeBioRecordTime(batchRecord.date);
    if (recordTime > nowForRecord) return toast.error("记录时间不能晚于当前时间");
    const minTime = minDatetimeForDate(batchRecordMinDate);
    if (minTime && recordTime < minTime) return toast.error(`记录时间不能早于最晚入库日期 ${batchRecordMinDate}`);
    if (!batchRecord.text.trim() && batchRecord.photos.length === 0 && batchRecord.videos.length === 0) {
      return toast.error("请填写记录内容或上传照片/视频");
    }
    if (!confirmWrite("批量维护", `将给 ${batchRecordItems.length} 条鱼添加同一条观察/治疗记录。`)) return;
    setBatchRecordSaving(true);
    const ok = await saveMaintenanceAction({
      mode: "record",
      itemIds: batchRecordItems.map((item) => item.id),
      recordDate: recordTime,
      recordText: batchRecord.text.trim(),
      recordPhotos: batchRecord.photos,
      recordVideos: batchRecord.videos,
    });
    setBatchRecordSaving(false);
    if (!ok) return toast.error("保存失败，请刷新后重试");
    setBatchRecordOpen(false);
    setBatchRecordItemIds([]);
    setBatchRecord({ date: nowDatetimeLocal(), text: "", photos: [], videos: [] });
    setSelectedIds(new Set());
    setSelectMode(false);
    toast.success(`已添加观察/治疗记录 ${batchRecordItems.length} 条`);
  };

  const openLossDialog = (ids: string | string[]) => {
    if (!permission.requirePermission("delete")) return;
    const validIds = Array.from(new Set(Array.isArray(ids) ? ids : [ids])).filter((id) => {
      const item = stockItem(id);
      return item && isPhysicallyInTank(item, shippedOutStockIds);
    });
    if (validIds.length === 0) return toast.error("请选择要报损的鱼");
    setLossItemIds(validIds);
    setLossDate(today);
    setLossReason("");
    setLossProof([]);
    setBioOpen(false);
    setLossOpen(true);
  };

  const handleLossProofUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(async (file) => {
      if (!file.type.startsWith("image/")) { toast.error("请选择图片文件"); return; }
      try {
        toast.info("损耗凭证原图上传中…");
        const url = await uploadOriginalMedia(file);
        setLossProof((prev) => [...prev, url]);
        toast.success("损耗凭证已上传");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "损耗凭证上传失败，请重试");
      }
    });
  };

  const submitLoss = async () => {
    if (!permission.requirePermission("delete")) return;
    if (lossItems.length === 0) return toast.error("请选择要报损的鱼");
    if (!lossDate) return toast.error("请选择损耗日期");
    if (lossDate > today) return toast.error("损耗日期不能晚于今天");
    if (lossMinDate && lossDate < lossMinDate) return toast.error(`损耗日期不能早于最晚入库日期 ${lossMinDate}`);
    if (lossProof.length === 0) return toast.error("请上传损耗照片凭证");
    const reason = lossReason.trim();
    if (!confirmWrite("登记损耗", `损耗后 ${lossItems.length} 条鱼会从在缸库存中移除，并生成损耗记录。`)) return;
    setLossSaving(true);
    const ok = await saveMaintenanceAction({
      mode: "loss",
      itemIds: lossItems.map((item) => item.id),
      lossDate,
      lossReason: reason,
      lossProof,
    });
    setLossSaving(false);
    if (!ok) return toast.error("损耗保存失败，请刷新后重试");
    setLossOpen(false);
    setLossItemIds([]);
    setLossProof([]);
    setSelectedIds(new Set());
    setSelectMode(false);
    if (lossRelatedOrderNos.length > 0) {
      toast.success(`已登记损耗 ${lossItems.length} 条；请到订单 ${lossRelatedOrderNos.join("、")} 里点击退商品并填写退款金额`);
    } else {
      toast.success(`已登记损耗 ${lossItems.length} 条`);
    }
  };

  // Get the display icon URL for a stock item
  const getItemIcon = (itemId: string, productId: string): string => {
    const recs = state.bioRecords
      .filter((r) => r.stockItemId === itemId && r.photos.length > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (recs.length > 0) {
      const last = recs[recs.length - 1];
      return last.photos[last.photos.length - 1];
    }
    return product(productId)?.imageUrl ?? "";
  };

  // Open bio detail dialog
  const loadBioRecords = async (stockItemId: string) => {
    try {
      const response = await fetch(`/api/bio-records?stockItemId=${encodeURIComponent(stockItemId)}`, { headers: authJsonHeaders() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      const records = Array.isArray(result.bioRecords) ? result.bioRecords : [];
      setState((current) => ({
        ...current,
        stock: result.stockItem
          ? current.stock.map((stock) => stock.id === stockItemId ? { ...stock, ...result.stockItem } : stock)
          : current.stock,
        bioRecords: [
          ...current.bioRecords.filter((record) => record.stockItemId !== stockItemId),
          ...records,
        ],
      }));
    } catch (error) {
      console.error("Failed to load bio records:", error);
      toast.error("养殖记录加载失败，请刷新后重试");
    }
  };

  const openBio = (item: StockItem) => {
    setBioItemId(item.id);
    setBioStatus(item.status);
    setBioBasePrice(item.basePrice && item.basePrice > 0 ? String(item.basePrice) : "");
    setBioCode(item.code ?? "");
    setBioNotes(item.notes ?? "");
    setNewRecord({ date: nowDatetimeLocal(), text: "", photos: [], videos: [] });
    setEditingRecordId(null);
    setEditingRecordTime("");
    setBioOpen(true);
    void loadBioRecords(item.id);
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

    const productName = product(target.productId)?.name ?? target.productId;
    setQ("");
    setFilterStatuses(new Set());
    setFilterSoldOnly(false);
    setHighlightStockId(target.id);
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      next.add(`${target.subTankId}-${target.productId}`);
      return next;
    });
    openBio(target);

    window.setTimeout(() => {
      const element = [...document.querySelectorAll<HTMLElement>("[data-daily-stock-item-id]")]
        .find((node) => node.dataset.dailyStockItemId === target.id);
      element?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }, 80);

    window.setTimeout(() => {
      setHighlightStockId((current) => current === target.id ? "" : current);
    }, 8000);

    toast.success(`已打开：${productName}`);
  };

  // Build timeline for bio detail
  const buildTimeline = (item: StockItem) => {
    const events: Array<
      | { type: "stock_in"; date: string; batchNo: string }
      | {
          type: "record";
          id: string;
          date: string;
          text: string;
          photos: string[];
          videos: string[];
          sourceType?: string;
          tankGroupName?: string;
          subTankName?: string;
          operator?: string;
        }
      | { type: "sold"; date: string; orderId: string; orderNo: string }
      | { type: "shipment"; date: string; orderId: string; orderNo: string; carrier: string; trackingNo: string; status: string; shipMethod?: string }
    > = [];

    const b = batch(item.batchId);
    events.push({ type: "stock_in", date: item.inDate, batchNo: b?.batchNo ?? "—" });

    const recs = state.bioRecords
      .filter((r) => r.stockItemId === item.id)
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const r of recs) {
      events.push({
        type: "record",
        id: r.id,
        date: r.date,
        text: r.text,
        photos: r.photos,
        videos: r.videos ?? [],
        sourceType: r.sourceType,
        tankGroupName: r.tankGroupName,
        subTankName: r.subTankName,
        operator: r.operator,
      });
    }

    // timeline: 只要有关联的有效订单，就显示销售记录（不依赖 sold 字段）
    const order = timelineOrders.find((o) =>
      o.items.some((i) => i.stockItemId === item.id) && o.status !== "cancelled"
    );
    if (order) {
      events.push({ type: "sold", date: order.date, orderId: order.id, orderNo: order.orderNo });
    }
    for (const shipment of timelineShipments.filter((shipment) =>
      Array.isArray(shipment.itemStockIds) && shipment.itemStockIds.includes(item.id)
    )) {
      const shipmentOrder = timelineOrders.find((order) => order.id === shipment.orderId);
      events.push({
        type: "shipment",
        date: shipment.shipDate,
        orderId: shipment.orderId,
        orderNo: shipmentOrder?.orderNo ?? "—",
        carrier: shipment.carrier,
        trackingNo: shipment.trackingNo,
        status: shipment.status,
        shipMethod: shipment.shipMethod,
      });
    }

    return events.sort((a, b) => a.date.localeCompare(b.date));
  };

  const bioItem = bioItemId ? state.stock.find((s) => s.id === bioItemId) : null;
  const bioProduct = bioItem ? product(bioItem.productId) : null;
  const timeline = bioItem ? buildTimeline(bioItem) : [];
  const editingRecord = editingRecordId
    ? state.bioRecords.find((record) => record.id === editingRecordId) ?? null
    : null;
  const deletingRecord = deletingRecordId
    ? state.bioRecords.find((record) => record.id === deletingRecordId) ?? null
    : null;
  const changeBioRecordDate = (value: string) => {
    const normalized = normalizeBioRecordTime(value);
    if (normalized && normalized > nowForRecord) {
      toast.error("记录时间不能晚于当前时间");
      return;
    }
    const minTime = minDatetimeForDate(bioItem?.inDate);
    if (bioItem && normalized && minTime && normalized < minTime) {
      toast.error("记录时间不能早于入库日期");
      return;
    }
    setNewRecord((p) => ({ ...p, date: normalized }));
  };

  // Save bio status/notes
  const saveBio = async () => {
    if (!bioItemId) return;
    if (!permission.requirePermission("update")) return;
    if (recordMediaUploading) return toast.info("请等待照片或视频上传完成");
    const savePendingRecord = hasBioRecordDraftContent(newRecord);
    let pendingRecordTime = "";
    if (savePendingRecord) {
      if (!permission.requirePermission("create")) return;
      if (!newRecord.date) return toast.error("请选择记录时间");
      pendingRecordTime = normalizeBioRecordTime(newRecord.date);
      if (pendingRecordTime > nowForRecord) return toast.error("记录时间不能晚于当前时间");
      const currentItem = stockItem(bioItemId);
      const minTime = minDatetimeForDate(currentItem?.inDate);
      if (currentItem && minTime && pendingRecordTime < minTime) {
        return toast.error("记录时间不能早于入库日期");
      }
    }
    const price = Number(bioBasePrice);
    if (!bioBasePrice.trim() || Number.isNaN(price) || price <= 0) {
      return toast.error("请填写大于 0 的销售默认价");
    }
    if (!confirmWrite(
      "修改",
      savePendingRecord
        ? "将保存鱼的信息，并新增当前填写的观察/治疗记录及媒体。"
        : "将保存鱼的状态、售价、编号和备注。",
    )) return;
    const normalizedPrice = Number(price.toFixed(2));
    const pendingRecord = savePendingRecord
      ? bioRecordFromDraft(newRecord, { id: uid(), stockItemId: bioItemId, date: pendingRecordTime })
      : null;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      stock: latest.stock.map((x) => {
        if (x.id !== bioItemId) return x;
        const currentPrice = Number(x.basePrice ?? 0);
        return {
          ...x,
          status: bioStatus,
          basePrice: normalizedPrice,
          priceOverridden: Math.abs(normalizedPrice - currentPrice) > 0.005 ? true : x.priceOverridden,
          code: bioCode.trim(),
          notes: bioNotes,
        };
      }),
      bioRecords: pendingRecord ? [...latest.bioRecords, pendingRecord] : latest.bioRecords,
    }));
    if (!ok) return toast.error("保存失败，请重试");
    if (pendingRecord) {
      setNewRecord({ date: nowDatetimeLocal(), text: "", photos: [], videos: [] });
    }
    setBioOpen(false);
    toast.success(pendingRecord ? "鱼的信息和观察记录已更新" : "鱼的信息已更新");
  };

  // Add bio record
  const addBioRecord = async () => {
    if (!bioItemId) return;
    if (!permission.requirePermission("create")) return;
    if (recordMediaUploading) return toast.info("请等待照片或视频上传完成");
    if (!newRecord.date) return toast.error("请选择记录时间");
    const currentItem = stockItem(bioItemId);
    const recordTime = normalizeBioRecordTime(newRecord.date);
    if (recordTime > nowForRecord) return toast.error("记录时间不能晚于当前时间");
    const minTime = minDatetimeForDate(currentItem?.inDate);
    if (currentItem && minTime && recordTime < minTime) return toast.error("记录时间不能早于入库日期");
    if (!newRecord.text.trim() && newRecord.photos.length === 0 && newRecord.videos.length === 0) {
      toast.error("请填写记录内容或上传照片/视频");
      return;
    }
    if (!confirmWrite("新增", "将新增一条观察/治疗记录。")) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      bioRecords: [
        ...latest.bioRecords,
        {
          id: uid(),
          stockItemId: bioItemId,
          date: recordTime,
          text: newRecord.text,
          photos: newRecord.photos,
          videos: newRecord.videos,
        },
      ],
    }));
    if (!ok) return toast.error("保存失败，请重试");
    setNewRecord({ date: nowDatetimeLocal(), text: "", photos: [], videos: [] });
    toast.success("记录已添加");
  };

  const startEditBioRecordTime = (recordId: string, date: string) => {
    if (!permission.requirePermission("update")) return;
    setEditingRecordId(recordId);
    setEditingRecordTime(normalizeBioRecordTime(date));
  };

  const requestBioRecordTimeChange = () => {
    if (!editingRecordId || !bioItemId) return;
    if (!permission.requirePermission("update")) return;
    const recordTime = normalizeBioRecordTime(editingRecordTime);
    if (!recordTime) return toast.error("请选择记录时间");
    if (recordTime > nowForRecord) return toast.error("记录时间不能晚于当前时间");
    const currentItem = stockItem(bioItemId);
    const minTime = minDatetimeForDate(currentItem?.inDate);
    if (currentItem && minTime && recordTime < minTime) return toast.error("记录时间不能早于入库日期");
    if (recordTime === normalizeBioRecordTime(editingRecord?.date ?? "")) {
      return toast.info("记录时间没有变化");
    }
    setConfirmTimeChangeOpen(true);
  };

  const confirmBioRecordTimeChange = async () => {
    if (!editingRecordId || !bioItemId) return;
    const recordTime = normalizeBioRecordTime(editingRecordTime);
    if (!recordTime) return;
    setRecordActionSaving(true);
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      bioRecords: latest.bioRecords.map((record) =>
        record.id === editingRecordId ? { ...record, date: recordTime } : record
      ),
    }));
    setRecordActionSaving(false);
    if (!ok) return toast.error("保存失败，请重试");
    setConfirmTimeChangeOpen(false);
    setEditingRecordId(null);
    setEditingRecordTime("");
    toast.success("记录时间已更新");
  };

  const requestDeleteBioRecord = (recordId: string) => {
    if (!permission.requirePermission("delete")) return;
    setDeletingRecordId(recordId);
  };

  const confirmDeleteBioRecord = async () => {
    if (!deletingRecordId) return;
    setRecordActionSaving(true);
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      bioRecords: latest.bioRecords.filter((record) => record.id !== deletingRecordId),
    }));
    setRecordActionSaving(false);
    if (!ok) return toast.error("删除失败，请重试");
    if (editingRecordId === deletingRecordId) {
      setEditingRecordId(null);
      setEditingRecordTime("");
    }
    setDeletingRecordId(null);
    toast.success("记录已删除");
  };

  // Log dialog
  const saveLog = async () => {
    if (!editingLog) return;
    if (!permission.requirePermission(editingLog.id ? "update" : "create")) return;
    if (!editingLog.date) return toast.error("请选择记录时间");
    const logTime = normalizeBioRecordTime(editingLog.date);
    if (logTime > nowForRecord) return toast.error("养护日志时间不能晚于当前时间");
    const tankGroupId = logGroupId(editingLog);
    if (!tankGroupId) return toast.error("请选择缸组");
    if (!editingLog.action.trim()) return toast.error("请填写操作内容");
    if (!editingLog.operator) return toast.error("请选择操作员");
    const logToSave: DailyLog = {
      ...editingLog,
      date: logTime,
      id: editingLog.id || uid(),
      tankGroupId,
      subTankId: undefined,
    };
    if (!confirmWrite(editingLog.id ? "修改" : "新增", editingLog.id ? "将保存养护日志的修改。" : "将新增一条养护日志。")) return;
    setLogSaving(true);
    const ok = await saveDailyLog({ log: logToSave });
    setLogSaving(false);
    if (!ok) return toast.error("保存失败，请重试");
    setLogOpen(false);
    toast.success("已记录");
  };

  const editLog = (log: DailyLog) => {
    if (!permission.requirePermission("update")) return;
    setEditingLog({
      ...log,
      date: normalizeBioRecordTime(log.date),
      tankGroupId: logGroupId(log),
      subTankId: undefined,
    });
    setLogOpen(true);
  };

  const deleteLog = async (log: DailyLog) => {
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `将删除 ${formatBioRecordTime(log.date)} 的养护日志，并同步删除鱼历史记录中由这条日志生成的记录。`)) return;
    setLogSaving(true);
    const ok = await saveDailyLog({ deleteId: log.id });
    setLogSaving(false);
    if (!ok) return toast.error("删除失败，请刷新后重试");
    if (editingLog?.id === log.id) {
      setLogOpen(false);
      setEditingLog(null);
    }
    toast.success("养护日志已删除");
  };

  const openNewLogForGroup = (groupId: string) => {
    if (!permission.requirePermission("create")) return;
    setEditingLog({ id: "", date: nowDatetimeLocal(), tankGroupId: groupId, action: "", operator: currentOperator, notes: "" });
    setLogOpen(true);
  };

  const statusMeta: Record<StockStatus, { label: string }> = {
    healthy: { label: "正常" },
    feeding: { label: "开口" },
    sick:    { label: "疾病" },
  };

  const statusFilterMeta: Record<StockStatus, { label: string; active: string; inactive: string }> = {
    healthy: { label: "正常", active: "bg-white border-slate-300 text-slate-800", inactive: "border-border text-muted-foreground hover:border-slate-300 hover:text-slate-700" },
    feeding: { label: "开口", active: "bg-sky-100 border-sky-400 text-sky-800",     inactive: "border-border text-muted-foreground hover:border-sky-300 hover:text-sky-700" },
    sick:    { label: "疾病", active: "bg-red-100 border-red-500 text-red-800",       inactive: "border-border text-muted-foreground hover:border-red-300 hover:text-red-700" },
  };

  const STATUS_ORDER: StockStatus[] = ["sick", "feeding", "healthy"];

  return (
    <div ref={dailyViewRef} className="flex flex-col gap-3">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
              <h2 className="leading-tight">日常管理</h2>
              <TabsList className="h-8 w-full rounded-full sm:w-auto">
                <TabsTrigger value="visual" className="flex-1 rounded-full px-3 text-sm sm:flex-none">缸位视图</TabsTrigger>
                <TabsTrigger value="records" className="flex-1 rounded-full px-3 text-sm sm:flex-none">养护与水质</TabsTrigger>
              </TabsList>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">巡缸、生物维护与水质测量记录</p>
          </div>
        </div>

        <TabsContent value="visual" className="flex flex-col gap-3">
          {/* 过滤栏：状态按钮 + 搜索框 */}
          <div className="sticky top-0 z-20 -mx-3 flex flex-col items-stretch gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-1 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:px-1 sm:py-1.5">
            <div className="flex min-w-0 flex-wrap items-center justify-start gap-1.5 sm:justify-end">
              {STATUS_ORDER.map((st) => {
                const meta = statusFilterMeta[st];
                const active = filterStatuses.has(st);
                return (
                  <button
                    key={st}
                    onClick={() => toggleStatusFilter(st)}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all select-none
                      ${active ? meta.active : meta.inactive}`}
                  >
                    <span className={`size-3 rounded border-2 shrink-0 ${statusFrameClass(st)}`} />
                    {meta.label}
                  </button>
                );
              })}
              {/* 已售独立过滤按钮 */}
              <button
                onClick={() => setFilterSoldOnly((v) => !v)}
                className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-all select-none
                  ${filterSoldOnly
                    ? "bg-amber-100 border-amber-400 text-amber-800"
                    : "border-border text-muted-foreground hover:border-amber-300 hover:text-amber-700"}`}
              >
                <span className={`size-3.5 rounded-full flex items-center justify-center text-[9px] font-bold leading-none shrink-0
                  ${filterSoldOnly ? "bg-amber-400 text-amber-900" : "bg-amber-200 text-amber-700"}`}>
                  ✕
                </span>
                已售
              </button>
              {(filterStatuses.size > 0 || filterSoldOnly) && (
                <button
                  onClick={() => { setFilterStatuses(new Set()); setFilterSoldOnly(false); }}
                  className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="size-3" /> 清除
                </button>
              )}
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-start gap-2 sm:justify-end">
              <div className="flex w-full items-center gap-2 rounded-lg border bg-white p-1.5 shadow-sm sm:w-auto">
                <div className="relative min-w-0 flex-1 sm:flex-none">
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
                    aria-label="公开选鱼码"
                    className="h-8 w-full border-0 bg-transparent pl-9 shadow-none focus-visible:ring-0 sm:w-48"
                  />
                </div>
                <Button type="button" size="sm" variant="outline" onClick={locatePublicLookupCode}>
                  定位
                </Button>
              </div>
              {canBatchSelect && (
                <Button
                  type="button"
                  size="sm"
                  variant={selectMode ? "default" : "outline"}
                  onClick={enterSelectMode}
                >
                  <ArrowRightLeft className="size-3.5 mr-1" />
                  批量操作
                </Button>
              )}
              {selectMode && (
                <>
                  <span className="text-xs text-muted-foreground">已选 {selectedItems.length} 条</span>
                  {permission.canCreate && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={selectedItems.length === 0}
                      onClick={() => openBatchRecordDialog(Array.from(selectedIds))}
                    >
                      批量维护
                    </Button>
                  )}
                  {permission.canUpdate && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={selectedItems.length === 0}
                      onClick={() => openBatchStatusDialog(Array.from(selectedIds))}
                    >
                      <Check className="size-3.5 mr-1" />
                      批量状态
                    </Button>
                  )}
                  {permission.canUpdate && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={selectedItems.length === 0}
                      onClick={() => openMoveDialog(Array.from(selectedIds))}
                    >
                      移到子缸
                    </Button>
                  )}
                  {permission.canDelete && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
                      disabled={selectedItems.length === 0}
                      onClick={() => openLossDialog(Array.from(selectedIds))}
                    >
                      批量报损
                    </Button>
                  )}
                </>
              )}
              <div className="relative min-w-0 flex-1 basis-full sm:min-w-[13rem] sm:basis-auto sm:flex-none">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="搜索缸位 / 商品名 / 编号 / 备注…"
                  aria-label="搜索缸位、商品名、编号或备注"
                  className="h-8 w-full pl-9 sm:w-72"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {visibleGroups.length === 0 && anyFilter && (
              <div className="py-12 text-center text-sm text-muted-foreground">没有符合条件的结果</div>
            )}
            {visibleGroups.map((g) => {
              const groupLogs = logsByGroup.get(g.id) ?? [];
              const latestLog = groupLogs[0];
              const groupWaterRecords = waterRecordsByGroup.get(g.id) ?? [];
              const latestWaterRecord = groupWaterRecords[0];
              const isGroupExpanded = expandedGroupIds.has(g.id);
              const subTanks = visibleSubTanks(g);
              const visibleStockCount = subTanks.reduce((sum, t) => sum + stockBySub(t.id).length, 0);
              const recordCount = groupLogs.length + groupWaterRecords.length;
              return (
              <Card key={g.id} className="p-3 border border-sky-200 bg-sky-50/30">
                <div className={isGroupExpanded ? "mb-2.5 grid gap-2.5" : "grid gap-2.5"}>
                  <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                    <button
                      type="button"
                      aria-expanded={isGroupExpanded}
                      aria-controls={`daily-group-${g.id}`}
                      className="flex min-w-0 items-start gap-2 rounded-lg px-1 py-0.5 text-left transition-colors hover:bg-white/70"
                      onClick={() => toggleGroupExpand(g.id)}
                    >
                      <ChevronDown
                        className={`mt-1 size-4 shrink-0 text-sky-600 transition-transform ${isGroupExpanded ? "rotate-180" : "-rotate-90"}`}
                      />
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-2">
                          <h3 className="truncate text-base">{g.name}</h3>
                          <span className="shrink-0 rounded-full bg-white/80 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                            {visibleStockCount} 条
                          </span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{g.location}</div>
                      </div>
                    </button>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 flex-1 border-slate-200 px-2.5 text-slate-700 hover:bg-white sm:flex-none"
                        onClick={() => openGroupRecords(g.id)}
                      >
                        <ClipboardList className="size-3.5 mr-1" />
                        查看记录{recordCount > 0 ? ` ${recordCount}` : ""}
                      </Button>
                      {permission.canCreate && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-8 flex-1 border-sky-200 px-2.5 text-sky-600 hover:bg-sky-50 sm:flex-none"
                          onClick={() => openNewLogForGroup(g.id)}
                        >
                          <Plus className="size-3.5 mr-1" />
                          新增养护
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-1.5 border-t border-sky-100 pt-2 sm:grid-cols-2 sm:gap-3">
                    <button
                      type="button"
                      className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/80"
                      onClick={() => openGroupRecords(g.id)}
                    >
                      <Clock className="mt-0.5 size-3.5 shrink-0 text-sky-700" />
                      <span className="min-w-0 text-xs">
                        <span className="mr-1.5 font-semibold text-slate-700">最新养护</span>
                        {latestLog ? (
                          <span className="text-slate-600">{formatBioRecordTime(latestLog.date)} · {latestLog.action || "未填写操作"}</span>
                        ) : (
                          <span className="text-muted-foreground">暂无记录</span>
                        )}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-white/80"
                      onClick={() => openGroupRecords(g.id)}
                    >
                      <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-cyan-700" />
                      <span className="min-w-0 text-xs">
                        <span className="mr-1.5 font-semibold text-slate-700">最新水质</span>
                        {latestWaterRecord ? (
                          <span className="text-slate-600">{isoToDatetimeLocal(latestWaterRecord.measuredAt).replace("T", " ")} · {formatWaterSummary(latestWaterRecord.values)}</span>
                        ) : (
                          <span className="text-muted-foreground">暂无记录</span>
                        )}
                      </span>
                    </button>
                  </div>
                </div>
                {/* 子缸横向排列，溢出滚动 */}
                {isGroupExpanded && (
                <div id={`daily-group-${g.id}`} className="flex flex-row gap-2.5 overflow-x-auto pb-0.5">
                  {subTanks.map((t) => {
                    const items = stockBySub(t.id);
                    const allItems = state.stock.filter((s) =>
                      s.subTankId === t.id && isPhysicallyInTank(s, shippedOutStockIds)
                    );
                    const matchedByTank = term.length > 0 && tankMatchesTerm(g, t);
                    const grouped = groupByProduct(items);
                    const total = items.length;
                    const visibleIds = items.map((item) => item.id);
                    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
                    return (
                      <div key={t.id} className="flex min-w-[208px] flex-shrink-0 flex-col overflow-hidden rounded-lg border border-slate-300 bg-white">
                        {/* 子缸标题行 */}
                        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 px-2.5 py-1.5">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium">{t.name}</span>
                            {allItems.length > 0 && (
                              <span className="text-xs bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded-full font-medium">
                                {anyFilter && total !== allItems.length
                                  ? `${total}/${allItems.length}`
                                  : `${allItems.length}`} 条
                              </span>
                            )}
                          </div>
                          {selectMode && canBatchSelect && total > 0 && (
                            <button
                              type="button"
                              className="text-xs text-sky-600 hover:text-sky-800 font-medium"
                              onClick={() => toggleVisibleSelection(items, "该子缸没有可选择的鱼")}
                            >
                              {allSelected ? "取消" : "全选"}
                            </button>
                          )}
                        </div>

                        {/* 商品分组列表 */}
                        <div className="flex flex-col divide-y divide-slate-200">
                          {items.length === 0 && (
                            <div className="px-2.5 py-2.5 text-xs text-muted-foreground text-center">
                              {anyFilter && !matchedByTank ? "无匹配" : "空缸"}
                            </div>
                          )}
                          {grouped.map(([productId, stockItems]) => {
                            const p = product(productId);
                            const key = `${t.id}-${productId}`;
                            const isExpanded = expandedKeys.has(key);
                            const speciesId = speciesIdOfProduct(productId);
                            const sameSpeciesItems = visibleSpeciesItems(items, speciesId);
                            const sameSpeciesSelected =
                              sameSpeciesItems.length > 0 && sameSpeciesItems.every((item) => selectedIds.has(item.id));

                            const counts = stockItems.reduce((acc, s) => {
                              acc[s.status] = (acc[s.status] ?? 0) + 1;
                              return acc;
                            }, {} as Record<string, number>);

                            return (
                              <div key={productId}>
                                <div
                                  role="button"
                                  tabIndex={0}
                                  className="w-full flex items-center gap-2 px-2.5 py-1.5 hover:bg-slate-50 text-left"
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
                                      <div className="size-full flex items-center justify-center">
                                        <Fish className="size-4 text-muted-foreground" />
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
                                  {selectMode && canBatchSelect && (
                                    <button
                                      type="button"
                                      className="shrink-0 rounded border border-sky-200 px-1.5 py-0.5 text-xs font-medium text-sky-600 hover:bg-sky-50 disabled:border-border disabled:text-muted-foreground"
                                      disabled={sameSpeciesItems.length === 0}
                                      title={`选择当前子缸内同一物种的 ${sameSpeciesItems.length} 条`}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        toggleVisibleSelection(sameSpeciesItems, "该物种没有可选择的鱼");
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
                                      const iconUrl = getItemIcon(s.id, s.productId);
                                      const selected = selectedIds.has(s.id);
                                      const highlighted = highlightStockId === s.id;
                                      return (
                                        <button
                                          key={s.id}
                                          data-daily-stock-item-id={s.id}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            if (selectMode) toggleSelectItem(s.id);
                                            else openBio(s);
                                          }}
                                          className={`relative size-9 rounded overflow-hidden bg-muted hover:opacity-80 transition-opacity cursor-pointer ${
                                            highlighted
                                              ? "ring-4 ring-cyan-500 ring-offset-2 ring-offset-white"
                                              : selected ? "ring-2 ring-emerald-500 ring-offset-2" : statusRingClass(s.status, s.sold)
                                          }`}
                                          title={`${p?.name ?? ""}${s.code ? ` · 编号：${s.code}` : ""} · 售价：¥${Number(s.basePrice ?? 0).toFixed(2)}${isSpecialPrice(s) ? "（特殊价格）" : ""} · ${statusMeta[s.status].label}${s.notes ? " · " + s.notes : ""}`}
                                        >
                                          {iconUrl ? (
                                            <ImageWithFallback src={iconUrl} alt={p?.name ?? ""} className="size-full object-cover" />
                                          ) : (
                                            <div className="size-full flex items-center justify-center">
                                              <Fish className="size-3 text-muted-foreground" />
                                            </div>
                                          )}
                                          {s.code && (
                                            <span className="absolute inset-x-0 bottom-0 z-20 truncate bg-black/65 px-0.5 text-center text-[9px] font-semibold leading-3 text-white">
                                              {s.code}
                                            </span>
                                          )}
                                          {isSpecialPrice(s) && (
                                            <span className="absolute left-0 top-0 z-20 max-w-full truncate rounded-br bg-amber-400 px-0.5 text-[8px] font-bold leading-3 text-amber-950 shadow-sm">
                                              {priceBadgeText(s)}
                                            </span>
                                          )}
                                          <StatusBadge sold={s.sold} />
                                          {selected && (
                                            <div className="absolute inset-0 z-10 bg-emerald-500/35 flex items-center justify-center">
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
                )}
              </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="records" className="flex flex-col gap-4">
          <WaterQualityRecordsPanel
            maintenanceLogs={state.logs ?? []}
            groupFilter={recordGroupFilter}
            onGroupFilterChange={setRecordGroupFilter}
            getMaintenanceGroupId={logGroupId}
            onCreateMaintenance={openNewLogForGroup}
            onEditMaintenance={editLog}
            onDeleteMaintenance={deleteLog}
            maintenanceSaving={logSaving}
          />
        </TabsContent>
      </Tabs>

      {/* Keep tank-context records over the tank view so closing returns to the same position. */}
      <Dialog open={Boolean(viewRecordGroupId)} onOpenChange={(open) => !open && closeGroupRecords()}>
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[90dvh] w-[min(96vw,56rem)] max-w-[96vw] flex-col overflow-hidden sm:max-w-4xl"
          data-daily-group-records-dialog
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 pr-6 text-left">
              <ClipboardList className="size-5 shrink-0 text-sky-700" />
              <span>{viewRecordGroup?.name ?? "缸组"}养护与水质</span>
            </DialogTitle>
            {viewRecordGroup?.location && (
              <div className="text-left text-sm text-muted-foreground">{viewRecordGroup.location}</div>
            )}
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {viewRecordGroupId && (
              <WaterQualityRecordsPanel
                maintenanceLogs={state.logs ?? []}
                groupFilter={viewRecordGroupId}
                getMaintenanceGroupId={logGroupId}
                onCreateMaintenance={(groupId) => {
                  closeGroupRecords();
                  openNewLogForGroup(groupId);
                }}
                onEditMaintenance={(log) => {
                  closeGroupRecords();
                  editLog(log);
                }}
                onDeleteMaintenance={deleteLog}
                maintenanceSaving={logSaving}
                viewMode="tank"
              />
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeGroupRecords}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── 生物详情 Dialog ── */}
      <Dialog
        open={bioOpen}
        onOpenChange={(open) => {
          if (!open && recordMediaUploading) return toast.info("请等待照片或视频上传完成");
          setBioOpen(open);
        }}
      >
        <DialogContent
          aria-describedby={undefined}
          className="w-[min(96vw,56rem)] max-w-[96vw] sm:max-w-4xl max-h-[92dvh] flex flex-col overflow-hidden"
          {...recordMediaDropZoneProps}
          onPaste={permission.canCreate ? pasteRecordMedia : undefined}
        >
          {recordMediaDragging && (
            <div className="pointer-events-none absolute inset-2 z-[60] flex items-center justify-center rounded-lg border-2 border-dashed border-sky-600 bg-background/95">
              <div className="flex items-center gap-2 text-base font-semibold text-sky-700">
                <UploadCloud className="size-6" />
                松开即可上传照片或视频
              </div>
            </div>
          )}
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2 pr-6 text-left">
              {bioProduct?.imageUrl && (
                <div className="size-8 rounded overflow-hidden border">
                  <ImageWithFallback src={bioProduct.imageUrl} alt="" className="size-full object-cover" />
                </div>
              )}
              <span>生物详情</span>
              {bioProduct && (
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-muted-foreground">
                  — {bioProduct.name}
                  {bioProduct.size && <span className="text-[11px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">{bioProduct.size}</span>}
                  {bioProduct.origin && <span className="text-[11px] text-muted-foreground">{bioProduct.origin}</span>}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="overflow-y-auto flex-1 min-h-0 flex flex-col gap-5 pr-1">
            {/* 状态 & 备注 */}
            <div className="grid gap-3 p-4 bg-muted/30 rounded-lg border md:grid-cols-4">
              <div className="grid gap-2">
                <Label className="flex items-center gap-2">
                  当前状态
                  {bioItem?.sold && (
                    <span className="flex items-center gap-1 text-xs text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                      <ShoppingBag className="size-3" /> 已售
                    </span>
                  )}
                </Label>
                <Select
                  value={bioStatus}
                  onValueChange={(v: StockStatus) => setBioStatus(v)}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="healthy">正常</SelectItem>
                    <SelectItem value="feeding">已开口</SelectItem>
                    <SelectItem value="sick">疾病</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label><span className="text-red-500">*</span> 销售默认价(¥)</Label>
                <Input
                  type="number"
                  min={0}
                  step={0.01}
                  value={bioBasePrice}
                  onChange={(e) => setBioBasePrice(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div className="grid gap-2">
                <Label>编号</Label>
                <Input
                  value={bioCode}
                  onChange={(e) => setBioCode(e.target.value)}
                  placeholder="可填写编号..."
                />
              </div>
              <div className="grid gap-2">
                <Label>备注</Label>
                <Input
                  value={bioNotes}
                  onChange={(e) => setBioNotes(e.target.value)}
                  placeholder="可填写备注..."
                />
              </div>
            </div>

            {/* 时间轴 */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Clock className="size-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">生物时间轴</span>
              </div>
              <div className="relative pl-6 flex flex-col gap-0">
                <div className="absolute left-2 top-2 bottom-2 w-px bg-border" />
                {timeline.map((ev, idx) => (
                  <div key={idx} className="relative mb-4">
                    {/* Dot */}
                    <div className={`absolute -left-[18px] size-3 rounded-full border-2 border-white ring-2 ${
                      ev.type === "stock_in" ? "bg-sky-500 ring-sky-300" :
                      ev.type === "sold" ? "bg-yellow-500 ring-yellow-300" :
                      ev.type === "shipment" ? "bg-violet-500 ring-violet-300" :
                      ev.type === "record" && ev.sourceType === "dailyLog" ? "bg-blue-500 ring-blue-300" :
                      "bg-emerald-500 ring-emerald-300"
                    }`} style={{ top: "4px" }} />

                    <div className={`rounded-lg border p-3 text-sm ${
                      ev.type === "sold" ? "border-yellow-200 bg-yellow-50" :
                      ev.type === "stock_in" ? "border-sky-200 bg-sky-50" :
                      ev.type === "shipment" ? "border-violet-200 bg-violet-50" :
                      ev.type === "record" && ev.sourceType === "dailyLog" ? "border-blue-200 bg-blue-50" :
                      "border-border bg-card"
                    }`}>
                      <div className="mb-1 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                          {ev.type === "stock_in" && <PackageCheck className="size-3.5 text-sky-600" />}
                          {ev.type === "record" && ev.sourceType === "dailyLog" && <ClipboardList className="size-3.5 text-blue-600" />}
                          {ev.type === "record" && ev.sourceType !== "dailyLog" && <Camera className="size-3.5 text-emerald-600" />}
                          {ev.type === "sold" && <ShoppingBag className="size-3.5 text-yellow-600" />}
                          {ev.type === "shipment" && <Truck className="size-3.5 text-violet-600" />}
                          <span className={`text-xs ${
                            ev.type === "sold" ? "text-yellow-700" :
                            ev.type === "stock_in" ? "text-sky-700" :
                            ev.type === "shipment" ? "text-violet-700" :
                            ev.type === "record" && ev.sourceType === "dailyLog" ? "text-blue-700" :
                            "text-emerald-700"
                          }`}>
                            {ev.type === "stock_in"
                              ? "入库"
                              : ev.type === "sold"
                                ? "销售"
                                : ev.type === "shipment"
                                  ? "物流"
                                  : ev.sourceType === "dailyLog"
                                    ? "缸组养护"
                                    : "观察/治疗记录"}
                          </span>
                        </div>
                        <span className="text-xs tabular-nums text-muted-foreground">{formatBioRecordTime(ev.date)}</span>
                      </div>

                      {ev.type === "stock_in" && (
                        <p className="text-muted-foreground text-xs">批次：{ev.batchNo}</p>
                      )}
                      {ev.type === "sold" && (
                        onOpenOrder ? (
                          <button
                            type="button"
                            onClick={() => onOpenOrder(ev.orderId)}
                            className="-mx-2 inline-flex min-h-10 items-center gap-1.5 rounded-md px-2 text-left text-xs font-medium text-yellow-800 transition-colors hover:bg-yellow-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500 focus-visible:ring-offset-2"
                            aria-label={`打开订单 ${ev.orderNo}`}
                          >
                            <span>订单：{ev.orderNo}</span>
                            <ExternalLink className="size-3.5 shrink-0" />
                          </button>
                        ) : (
                          <p className="text-xs text-yellow-700">订单：{ev.orderNo}</p>
                        )
                      )}
                      {ev.type === "shipment" && (
                        <div className="flex flex-col items-start gap-0.5 text-xs text-violet-700 sm:flex-row sm:items-center sm:gap-1">
                          {onOpenOrder ? (
                            <button
                              type="button"
                              onClick={() => onOpenOrder(ev.orderId)}
                              className="-mx-2 inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-left font-medium text-violet-800 transition-colors hover:bg-violet-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
                              aria-label={`打开订单 ${ev.orderNo}`}
                            >
                              <span>订单：{ev.orderNo}</span>
                              <ExternalLink className="size-3.5 shrink-0" />
                            </button>
                          ) : (
                            <span>订单：{ev.orderNo}</span>
                          )}
                          <span>
                            {ev.shipMethod === "pickup" ? "上门自取；" : ""}
                            {ev.carrier ? `${ev.carrier}；` : ""}
                            {ev.trackingNo ? `单号：${ev.trackingNo}；` : ""}
                            {`状态：${ev.status === "delivered" ? "已签收" : ev.status === "outbound" ? "已出库待发货" : ev.status === "shipped" ? "运输中" : ev.status === "damaged" ? "报损" : "待发货"}`}
                          </span>
                        </div>
                      )}
                      {ev.type === "record" && (
                        <>
                          {ev.text && <p className="text-foreground">{ev.text}</p>}
                          {ev.sourceType === "dailyLog" && (
                            <p className="mt-1 text-xs text-blue-700">
                              来自养护日志
                              {ev.tankGroupName ? `；缸组：${ev.tankGroupName}` : ""}
                              {ev.subTankName ? ` / ${ev.subTankName}` : ""}
                              {ev.operator ? `；操作员：${ev.operator}` : ""}
                            </p>
                          )}
                          {ev.photos.length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-2">
                              {ev.photos.map((src, pi) => (
                                <div key={pi} className="group relative size-16 rounded border overflow-hidden cursor-pointer">
                                  <ImageWithFallback src={src} alt={`照片${pi + 1}`} className="size-full object-cover" />
                                  <button
                                    type="button"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      try {
                                        await downloadMedia(src, `photo-${pi + 1}.jpg`);
                                      } catch {
                                        toast.error("照片下载失败，请刷新后重试");
                                      }
                                    }}
                                    className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="下载照片"
                                  >
                                    <Download className="size-4 text-white" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          {(ev.videos ?? []).length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-2">
                              {(ev.videos ?? []).map((src, vi) => (
                                <div key={vi} className="group relative rounded border overflow-hidden" style={{ width: "120px" }}>
                                  <MediaVideo src={src} className="w-full" controls />
                                  <button
                                    type="button"
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      try {
                                        await downloadMedia(src, `video-${vi + 1}.mp4`, { mediaType: "video" });
                                      } catch {
                                        toast.error("视频下载失败，请刷新后重试");
                                      }
                                    }}
                                    className="absolute top-1 right-1 bg-black/60 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="下载视频"
                                  >
                                    <Download className="size-3.5 text-white" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          {ev.sourceType !== "dailyLog" && (permission.canUpdate || permission.canDelete) && (
                            editingRecordId === ev.id ? (
                              <div className="mt-3 grid gap-3 border-t pt-3">
                                <div className="grid gap-1.5">
                                  <Label className="text-xs">修改记录时间</Label>
                                  <PreciseDateTimeInput
                                    min={minDatetimeForDate(bioItem?.inDate)}
                                    max={nowForRecord}
                                    value={editingRecordTime}
                                    onChange={setEditingRecordTime}
                                    className="w-full sm:max-w-80"
                                  />
                                </div>
                                <div className="grid grid-cols-2 gap-3 sm:flex sm:justify-end">
                                  <Button
                                    type="button"
                                    variant="outline"
                                    className="min-h-11"
                                    onClick={() => { setEditingRecordId(null); setEditingRecordTime(""); }}
                                  >
                                    取消
                                  </Button>
                                  <Button type="button" className="min-h-11" onClick={requestBioRecordTimeChange}>
                                    <Check className="size-4" />
                                    继续修改
                                  </Button>
                                </div>
                              </div>
                            ) : (
                              <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 sm:flex sm:justify-end">
                                {permission.canUpdate && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="min-h-11 gap-1.5 sm:min-h-9"
                                    disabled={Boolean(editingRecordId)}
                                    onClick={() => startEditBioRecordTime(ev.id, ev.date)}
                                  >
                                    <Pencil className="size-4" />
                                    修改时间
                                  </Button>
                                )}
                                {permission.canDelete && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="min-h-11 gap-1.5 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 sm:min-h-9"
                                    disabled={Boolean(editingRecordId)}
                                    onClick={() => requestDeleteBioRecord(ev.id)}
                                  >
                                    <Trash2 className="size-4" />
                                    删除记录
                                  </Button>
                                )}
                              </div>
                            )
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}

                {timeline.length === 0 && (
                  <div className="text-sm text-muted-foreground py-2">暂无记录</div>
                )}
              </div>
            </div>

	            {/* 添加记录 */}
	            {permission.canCreate && (
	            <div className="border rounded-lg p-4 flex flex-col gap-3 bg-muted/20">
              <div className="flex items-center gap-2">
                <Plus className="size-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">添加观察/治疗记录</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label className="text-xs">记录时间</Label>
	                  <PreciseDateTimeInput
                      min={minDatetimeForDate(bioItem?.inDate)}
	                    max={nowForRecord}
	                    value={newRecord.date}
	                    onChange={changeBioRecordDate}
	                  />
                </div>
                <div className="grid gap-2">
                  <Label className="text-xs">照片</Label>
                  <div className="flex items-center gap-2">
                    <input
                      ref={photoRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => { void uploadRecordPhotos(e.target.files); e.target.value = ""; }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      disabled={recordMediaUploading}
                      title="也可直接粘贴剪贴板中的图片"
                      onClick={() => photoRef.current?.click()}
                    >
                      <Camera className="size-4" /> 上传照片
                    </Button>
                  </div>
                </div>
	                <div className="grid gap-2">
	                  <Label className="text-xs">视频</Label>
	                  <div className="flex items-center gap-2">
	                    <input
	                      ref={videoRef}
	                      type="file"
	                      accept={ORIGINAL_VIDEO_ACCEPT}
	                      multiple
	                      className="hidden"
	                      onChange={(e) => { void uploadRecordVideos(e.target.files); e.target.value = ""; }}
	                    />
	                    <Button
	                      type="button"
	                      variant="outline"
	                      size="sm"
	                      className="flex-1"
	                      disabled={recordMediaUploading}
	                      title="也可直接粘贴剪贴板中的视频"
	                      onClick={() => videoRef.current?.click()}
	                    >
	                      <Video className="size-4" /> 上传视频
	                    </Button>
	                  </div>
	                </div>
              </div>
              {newRecord.photos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {newRecord.photos.map((src, i) => (
                    <div key={i} className="relative size-14 rounded border overflow-hidden">
                      <ImageWithFallback src={src} alt="" className="size-full object-cover" />
                      <button
                        onClick={() => setNewRecord((p) => ({ ...p, photos: p.photos.filter((_, idx) => idx !== i) }))}
                        className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full size-4 flex items-center justify-center text-[10px]"
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              {newRecord.videos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {newRecord.videos.map((src, i) => (
                    <div key={i} className="relative size-14 rounded border overflow-hidden">
                      <video src={src} alt="" className="size-full object-cover" controls />
                      <button
                        onClick={() => setNewRecord((p) => ({ ...p, videos: p.videos.filter((_, idx) => idx !== i) }))}
                        className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full size-4 flex items-center justify-center text-[10px]"
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid gap-2">
                <Label className="text-xs">记录内容</Label>
                <Textarea
                  rows={2}
                  placeholder="填写观察、治疗、用药等内容..."
                  value={newRecord.text}
                  onChange={(e) => setNewRecord((p) => ({ ...p, text: e.target.value }))}
                />
              </div>
              <Button variant="outline" size="sm" onClick={addBioRecord} disabled={recordMediaUploading} className="w-full self-end sm:w-auto">
                {recordMediaUploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {recordMediaUploading ? "媒体上传中…" : "添加观察/治疗记录"}
              </Button>
	            </div>
	            )}
	          </div>

		          <DialogFooter className="flex-col pt-3 border-t shrink-0 gap-2 sm:flex-row sm:flex-wrap sm:items-center">
		            <div className="flex w-full flex-wrap items-center gap-2 sm:mr-auto sm:w-auto">
		              {permission.canUpdate && bioItem && (
		                <Button variant="outline" disabled={recordMediaUploading} onClick={() => openMoveDialog([bioItem.id])}>
		                  <ArrowRightLeft className="size-4 mr-1" />
		                  移缸
		                </Button>
		              )}
		              {permission.canDelete && bioItem && (
		                <Button
		                  variant="outline"
		                  className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
		                  disabled={recordMediaUploading}
		                  onClick={() => openLossDialog(bioItem.id)}
		                >
		                  <AlertTriangle className="size-4 mr-1" />
		                  损耗
		                </Button>
		              )}
		            </div>
		            <Button variant="outline" disabled={recordMediaUploading} onClick={() => setBioOpen(false)}>关闭</Button>
		            {permission.canUpdate && (
                  <Button disabled={recordMediaUploading} onClick={saveBio}>
                    {hasBioRecordDraftContent(newRecord) ? "保存信息和记录" : "保存信息"}
                  </Button>
                )}
		          </DialogFooter>
        </DialogContent>
	      </Dialog>

      <AlertDialog
        open={confirmTimeChangeOpen}
        onOpenChange={(open) => {
          if (!open && !recordActionSaving) setConfirmTimeChangeOpen(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认修改记录时间</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-3 text-left">
                <p>请核对修改前后的时间，确认后将立即更新这条观察/治疗记录。</p>
                <div className="grid gap-2 rounded-md border bg-muted/40 p-3 text-sm tabular-nums text-foreground">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">原时间</span>
                    <span>{formatBioRecordTime(editingRecord?.date ?? "")}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3 font-medium">
                    <span className="text-muted-foreground">修改为</span>
                    <span>{formatBioRecordTime(editingRecordTime)}</span>
                  </div>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-3 sm:flex sm:justify-end">
            <AlertDialogCancel disabled={recordActionSaving} className="mt-0 min-h-11">返回检查</AlertDialogCancel>
            <AlertDialogAction
              disabled={recordActionSaving}
              className="min-h-11"
              onClick={(event) => {
                event.preventDefault();
                void confirmBioRecordTimeChange();
              }}
            >
              {recordActionSaving ? "修改中…" : "确认修改"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={Boolean(deletingRecordId)}
        onOpenChange={(open) => {
          if (!open && !recordActionSaving) setDeletingRecordId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除观察/治疗记录</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-3 text-left">
                <p>删除后无法在页面中恢复，请确认你要删除的是下面这条记录。</p>
                <div className="grid gap-1 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-foreground">
                  <span className="font-medium tabular-nums">{formatBioRecordTime(deletingRecord?.date ?? "")}</span>
                  <span className="whitespace-pre-wrap text-muted-foreground">{deletingRecord?.text || "无文字内容"}</span>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="grid grid-cols-2 gap-3 sm:flex sm:justify-end">
            <AlertDialogCancel disabled={recordActionSaving} className="mt-0 min-h-11">取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={recordActionSaving}
              className="min-h-11 bg-red-600 hover:bg-red-700"
              onClick={(event) => {
                event.preventDefault();
                void confirmDeleteBioRecord();
              }}
            >
              {recordActionSaving ? "删除中…" : "确认删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

	      {/* ── 批量观察/治疗 Dialog ── */}
	      <Dialog open={batchRecordOpen} onOpenChange={setBatchRecordOpen}>
	        <DialogContent aria-describedby={undefined} className="max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
	          <DialogHeader>
	            <DialogTitle>批量维护</DialogTitle>
	          </DialogHeader>
	          <div className="grid gap-4 py-2 overflow-y-auto pr-1">
	            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
	              <div className="font-medium mb-2">本次添加观察/治疗记录 {batchRecordItems.length} 条</div>
	              <div className="flex flex-col gap-1 text-xs text-muted-foreground max-h-32 overflow-y-auto">
	                {batchRecordItems.map((item) => {
	                  const p = product(item.productId);
	                  return (
	                    <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
	                      <span className="truncate">
	                        {p?.name ?? item.productId}{item.code ? ` · ${item.code}` : ""}
	                      </span>
	                      <span className="text-right">{subTankName(item.subTankId)}</span>
	                    </div>
	                  );
	                })}
	              </div>
	            </div>
	            <div className="grid gap-3 sm:grid-cols-2">
	              <div className="grid gap-2">
	                <Label>记录时间<span className="text-red-500 ml-0.5">*</span></Label>
	                <PreciseDateTimeInput
	                  min={minDatetimeForDate(batchRecordMinDate)}
	                  max={nowForRecord}
	                  value={batchRecord.date}
	                  onChange={changeBatchRecordDate}
	                />
	              </div>
	              <div className="grid gap-2">
	                <Label>附件</Label>
	                <div className="grid gap-2 sm:grid-cols-2">
	                  <input
	                    ref={batchPhotoRef}
	                    type="file"
	                    accept="image/*"
	                    multiple
	                    className="hidden"
	                    onChange={(e) => { handleBatchPhotoUpload(e.target.files); e.target.value = ""; }}
	                  />
	                  <Button type="button" variant="outline" size="sm" onClick={() => batchPhotoRef.current?.click()}>
	                    <Camera className="size-4" /> 上传照片
	                  </Button>
		                  <input
		                    ref={batchVideoRef}
		                    type="file"
		                    accept={ORIGINAL_VIDEO_ACCEPT}
		                    multiple
		                    className="hidden"
		                    onChange={(e) => { handleBatchVideoUpload(e.target.files); e.target.value = ""; }}
		                  />
		                  <Button type="button" variant="outline" size="sm" onClick={() => batchVideoRef.current?.click()}>
		                    <Video className="size-4" /> 上传视频
		                  </Button>
		                </div>
		              </div>
	            </div>
	            {batchRecord.photos.length > 0 && (
	              <div className="flex flex-wrap gap-2">
	                {batchRecord.photos.map((src, i) => (
	                  <div key={i} className="relative size-14 rounded border overflow-hidden">
	                    <ImageWithFallback src={src} alt="" className="size-full object-cover" />
	                    <button
	                      type="button"
	                      onClick={() => setBatchRecord((p) => ({ ...p, photos: p.photos.filter((_, idx) => idx !== i) }))}
	                      className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full size-4 flex items-center justify-center text-[10px]"
	                    >×</button>
	                  </div>
	                ))}
	              </div>
	            )}
	            {batchRecord.videos.length > 0 && (
	              <div className="flex flex-wrap gap-2">
	                {batchRecord.videos.map((src, i) => (
	                  <div key={i} className="relative size-14 rounded border overflow-hidden">
	                    <video src={src} className="size-full object-cover" controls />
	                    <button
	                      type="button"
	                      onClick={() => setBatchRecord((p) => ({ ...p, videos: p.videos.filter((_, idx) => idx !== i) }))}
	                      className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full size-4 flex items-center justify-center text-[10px]"
	                    >×</button>
	                  </div>
	                ))}
	              </div>
	            )}
	            <div className="grid gap-2">
	              <Label>记录内容</Label>
	              <Textarea
	                rows={4}
	                placeholder="填写观察、治疗、用药等内容..."
	                value={batchRecord.text}
	                onChange={(e) => setBatchRecord((p) => ({ ...p, text: e.target.value }))}
	              />
	            </div>
	          </div>
	          <DialogFooter className="pt-2 border-t shrink-0">
	            <Button variant="outline" onClick={() => setBatchRecordOpen(false)} disabled={batchRecordSaving}>取消</Button>
	            <Button onClick={submitBatchRecord} disabled={batchRecordSaving}>
	              {batchRecordSaving ? "保存中…" : "确认添加"}
	            </Button>
	          </DialogFooter>
	        </DialogContent>
	      </Dialog>

	      {/* ── 批量状态 Dialog ── */}
	      <Dialog open={batchStatusOpen} onOpenChange={setBatchStatusOpen}>
	        <DialogContent aria-describedby={undefined} className="max-w-lg max-h-[86vh] flex flex-col overflow-hidden">
	          <DialogHeader>
	            <DialogTitle>批量设置状态</DialogTitle>
	          </DialogHeader>
	          <div className="grid gap-4 py-2 overflow-y-auto pr-1">
	            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
	              <div className="font-medium mb-2">本次设置状态 {batchStatusItems.length} 条</div>
	              <div className="flex flex-col gap-1 text-xs text-muted-foreground max-h-36 overflow-y-auto">
	                {batchStatusItems.map((item) => {
	                  const p = product(item.productId);
	                  return (
	                    <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2">
	                      <span className="truncate">
	                        {p?.name ?? item.productId}{item.code ? ` · ${item.code}` : ""}
	                      </span>
	                      <Badge variant="outline" className="justify-self-end">{statusMeta[item.status].label}</Badge>
	                      <span className="text-right">{subTankName(item.subTankId)}</span>
	                    </div>
	                  );
	                })}
	              </div>
	            </div>
	            <div className="grid gap-2">
	              <Label>目标状态<span className="text-red-500 ml-0.5">*</span></Label>
	              <Select
	                value={batchTargetStatus}
	                onValueChange={(value: StockStatus) => setBatchTargetStatus(value)}
	              >
	                <SelectTrigger>
	                  <SelectValue placeholder="选择目标状态" />
	                </SelectTrigger>
	                <SelectContent>
	                  <SelectItem value="healthy">正常</SelectItem>
	                  <SelectItem value="feeding">开口</SelectItem>
	                  <SelectItem value="sick">疾病</SelectItem>
	                </SelectContent>
	              </Select>
	            </div>
	          </div>
	          <DialogFooter className="pt-2 border-t shrink-0">
	            <Button variant="outline" onClick={() => setBatchStatusOpen(false)} disabled={batchStatusSaving}>取消</Button>
	            <Button onClick={submitBatchStatus} disabled={batchStatusSaving}>
	              {batchStatusSaving ? "保存中…" : "确认设置"}
	            </Button>
	          </DialogFooter>
	        </DialogContent>
	      </Dialog>

	      {/* ── 移缸 Dialog ── */}
	      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
	        <DialogContent aria-describedby={undefined} className="max-w-lg">
	          <DialogHeader>
	            <DialogTitle>移缸</DialogTitle>
	          </DialogHeader>
	          <div className="grid gap-4 py-2">
	            <div className="rounded-lg border bg-muted/30 p-3 text-sm">
	              <div className="font-medium mb-2">本次移动 {movingItems.length} 条</div>
	              <div className="flex flex-col gap-1 text-xs text-muted-foreground max-h-28 overflow-y-auto">
	                {movingItems.map((item) => {
	                  const p = product(item.productId);
	                  return (
	                    <div key={item.id} className="flex items-center justify-between gap-2">
	                      <span>{p?.name ?? item.productId}</span>
	                      <span>{subTankName(item.subTankId)}</span>
	                    </div>
	                  );
	                })}
	              </div>
	            </div>
	            <div className="grid gap-3 sm:grid-cols-2">
	              <div className="grid gap-2">
	                <Label>目标缸组<span className="text-red-500 ml-0.5">*</span></Label>
	                <Select
	                  value={targetGroupId}
	                  onValueChange={(value) => {
	                    setTargetGroupId(value);
	                    setTargetSubTankId("");
	                  }}
	                >
	                  <SelectTrigger><SelectValue placeholder="选择缸组" /></SelectTrigger>
	                  <SelectContent>
                    {moveTargetGroups.map((group) => (
	                      <SelectItem key={group.id} value={group.id}>
	                        {siteName(state, group.siteId)} / {group.name}
	                      </SelectItem>
	                    ))}
	                  </SelectContent>
	                </Select>
	              </div>
	              <div className="grid gap-2">
	                <Label>目标子缸<span className="text-red-500 ml-0.5">*</span></Label>
	                <Select
	                  value={targetSubTankId}
	                  onValueChange={setTargetSubTankId}
	                  disabled={!targetGroupId || targetSubTanks.length === 0}
	                >
	                  <SelectTrigger>
	                    <SelectValue placeholder={targetGroupId ? "选择子缸" : "先选缸组"} />
	                  </SelectTrigger>
	                  <SelectContent>
	                    {targetSubTanks.map((tank) => (
	                      <SelectItem key={tank.id} value={tank.id}>{tank.name}</SelectItem>
	                    ))}
	                  </SelectContent>
	                </Select>
	              </div>
	            </div>
	            <div className="grid gap-2">
	              <Label>移缸备注</Label>
	              <Textarea
	                rows={2}
	                value={moveNotes}
	                onChange={(e) => setMoveNotes(e.target.value)}
	                placeholder="选填，如隔离、配对、调整密度等"
	              />
	            </div>
	          </div>
	          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveOpen(false)} disabled={moveSaving}>取消</Button>
            <Button onClick={submitMove} disabled={moveSaving}>{moveSaving ? "保存中…" : "确认移缸"}</Button>
	          </DialogFooter>
	        </DialogContent>
	      </Dialog>

	      {/* ── 损耗 Dialog ── */}
	      <Dialog open={lossOpen} onOpenChange={setLossOpen}>
	        <DialogContent aria-describedby={undefined} className="max-w-lg">
	          <DialogHeader>
	            <DialogTitle>登记损耗</DialogTitle>
	          </DialogHeader>
	          {lossItems.length > 0 && (
	            <div className="grid gap-4 py-2">
	              <div className="rounded-lg border border-red-100 bg-red-50/70 p-3 text-sm text-red-800">
	                损耗后所选鱼会从缸位视图和可售库存中移除，但原始库存记录、损耗凭证和时间轴记录会保留。
	              </div>
	              {lossRelatedOrderNos.length > 0 && (
	                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
	                  这批鱼中有 {lossRelatedOrderNos.length} 个关联销售订单：{lossRelatedOrderNos.join("、")}。确认损耗后会在订单商品上标记「损耗」，对应商品不可发货；需要到订单详情里点击退商品，手动填写退款金额后再完成退款记录。
	                </div>
	              )}
	              <div className="rounded-lg border p-3 text-sm">
	                <div className="font-medium mb-2">本次报损 {lossItems.length} 条</div>
	                <div className="flex flex-col gap-1 text-xs text-muted-foreground max-h-32 overflow-y-auto">
	                  {lossItems.map((item) => {
	                    const p = product(item.productId);
	                    return (
	                      <div key={item.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
	                        <span className="truncate">
	                          {p?.name ?? item.productId}{item.code ? ` · ${item.code}` : ""}
	                        </span>
	                        <span className="text-right">{subTankName(item.subTankId)}</span>
	                      </div>
	                    );
	                  })}
	                </div>
	              </div>
	              <div className="grid gap-3 sm:grid-cols-2">
	                <div className="grid gap-2">
		                  <Label>损耗日期<span className="text-red-500 ml-0.5">*</span></Label>
		                  <Input
		                    type="date"
		                    min={lossMinDate || undefined}
		                    max={today}
		                    value={lossDate}
		                    onChange={(e) => changeLossDate(e.target.value)}
		                  />
	                </div>
	              </div>
	              <div className="grid gap-2">
	                <Label>损耗原因</Label>
	                <Textarea
	                  rows={3}
	                  value={lossReason}
	                  onChange={(e) => setLossReason(e.target.value)}
	                  placeholder="选填，如死亡原因、发现时间、处理方式等"
	                />
	              </div>
	              <div className="grid gap-2">
	                <Label>照片凭证<span className="text-red-500 ml-0.5">*</span></Label>
	                <input
	                  ref={lossPhotoRef}
	                  type="file"
	                  accept="image/*"
	                  multiple
	                  className="hidden"
	                  onChange={(e) => { handleLossProofUpload(e.target.files); e.target.value = ""; }}
	                />
	                <div className="flex flex-wrap gap-2">
	                  {lossProof.map((src, index) => (
	                    <div key={index} className="relative size-16 rounded border overflow-hidden">
	                      <ImageWithFallback src={src} alt="" className="size-full object-cover" />
	                      <button
	                        type="button"
	                        onClick={() => setLossProof((prev) => prev.filter((_, i) => i !== index))}
	                        className="absolute -top-1 -right-1 bg-red-500 text-white rounded-full size-4 flex items-center justify-center text-[10px]"
	                      >
	                        ×
	                      </button>
	                    </div>
	                  ))}
	                  <button
	                    type="button"
	                    onClick={() => lossPhotoRef.current?.click()}
	                    className="size-16 rounded border border-dashed flex items-center justify-center text-muted-foreground hover:bg-muted"
	                  >
	                    <Camera className="size-5" />
	                  </button>
	                </div>
	              </div>
	            </div>
	          )}
	          <DialogFooter>
            <Button variant="outline" onClick={() => setLossOpen(false)} disabled={lossSaving}>取消</Button>
            <Button variant="destructive" onClick={submitLoss} disabled={lossSaving}>{lossSaving ? "保存中…" : "确认损耗"}</Button>
	          </DialogFooter>
	        </DialogContent>
	      </Dialog>

	      {/* ── 养护日志 Dialog ── */}
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{editingLog?.id ? "编辑日志" : "新增养护日志"}</DialogTitle></DialogHeader>
          {editingLog && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
	                  <Label>记录时间</Label>
	                  <PreciseDateTimeInput
	                    max={nowForRecord}
	                    value={editingLog.date}
	                    onChange={(inputValue) => {
	                      const value = normalizeBioRecordTime(inputValue);
	                      if (value && value > nowForRecord) {
	                        toast.error("养护日志时间不能晚于当前时间");
	                        return;
	                      }
	                      setEditingLog({ ...editingLog, date: value });
	                    }}
	                  />
                </div>
                <div className="grid gap-2">
                  <Label>缸组<span className="text-red-500 ml-0.5">*</span></Label>
                  <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3 text-sm">
                    {groupName(logGroupId(editingLog))}
                  </div>
                </div>
              </div>
              <div className="grid gap-2">
                <Label>操作（如：换水/投喂/下药）</Label>
                <Input value={editingLog.action} onChange={(e) => setEditingLog({ ...editingLog, action: e.target.value })} />
              </div>
              <div className="grid gap-2">
                <Label>操作员<span className="text-red-500 ml-0.5">*</span></Label>
                <Select value={editingLog.operator} onValueChange={(v) => setEditingLog({ ...editingLog, operator: v })}>
                  <SelectTrigger><SelectValue placeholder="请选择操作员" /></SelectTrigger>
                  <SelectContent>
                    {operatorOptions.map((person) => (
                      <SelectItem key={person.value} value={person.value}>{person.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>备注</Label>
                <Textarea rows={2} value={editingLog.notes} onChange={(e) => setEditingLog({ ...editingLog, notes: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLogOpen(false)} disabled={logSaving}>取消</Button>
            <Button onClick={saveLog} disabled={logSaving}>{logSaving ? "保存中…" : "保存"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
