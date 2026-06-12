import { useState, useRef, useMemo } from "react";
import { useStore, DailyLog, StockStatus, StockItem, uid } from "../store";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Badge } from "./ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { StatusBadge, statusRingClass, statusFrameClass } from "./StatusIcon";
import { Search, Fish, Camera, Clock, PackageCheck, ShoppingBag, X, Plus, ChevronDown, Video, Download, ArrowRightLeft, AlertTriangle, Check, ClipboardList, Truck } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { toast } from "sonner";
import { readAndCompressImage } from "../utils/imageUtils";
import { getShippedOutStockIds, isPhysicallyInTank } from "../utils/inventory";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";
import { authJsonHeaders } from "../utils/authSession";
import { normalizeSiteId } from "../utils/sites";

type RecordDraft = { date: string; text: string; photos: string[]; videos: string[] };

function nowDatetimeLocal(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function todayDateString(): string {
  return nowDatetimeLocal().slice(0, 10);
}

function minDatetimeForDate(date?: string): string | undefined {
  return date ? `${date.slice(0, 10)}T00:00` : undefined;
}

function normalizeBioRecordTime(value: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00`;
  return trimmed.slice(0, 16);
}

function formatBioRecordTime(value: string): string {
  const normalized = normalizeBioRecordTime(value);
  if (!normalized) return "—";
  return normalized.includes("T") ? normalized.replace("T", " ") : normalized;
}

export function DailyView() {
  const { state, setState, saveStateTransform, saveDailyLog, saveMaintenanceAction } = useStore();
  const permission = usePermission("daily");
  const [q, setQ] = useState("");
  const [filterStatuses, setFilterStatuses] = useState<Set<StockStatus>>(new Set());
  const [filterSoldOnly, setFilterSoldOnly] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

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
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const [editingRecordTime, setEditingRecordTime] = useState("");
  const photoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  // Log dialog state
  const [logOpen, setLogOpen] = useState(false);
  const [editingLog, setEditingLog] = useState<DailyLog | null>(null);
  const [logSaving, setLogSaving] = useState(false);
  const [logGroupFilter, setLogGroupFilter] = useState("all");
  const [logStartDate, setLogStartDate] = useState("");
  const [logEndDate, setLogEndDate] = useState("");
  const [viewLogGroupId, setViewLogGroupId] = useState<string | null>(null);

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
  const shippedOutStockIds = getShippedOutStockIds(state.shipments);
  const canBatchSelect = permission.canCreate || permission.canUpdate || permission.canDelete;
  const product = (id: string) => state.products.find((p) => p.id === id);
  const isSpecialPrice = (item: StockItem) => {
    const defaultPrice = Number(product(item.productId)?.defaultPrice ?? 0);
    const itemPrice = Number(item.basePrice ?? 0);
    return itemPrice > 0 && defaultPrice > 0 && Math.abs(itemPrice - defaultPrice) > 0.005;
  };
  const priceBadgeText = (item: StockItem) => `¥${Number(item.basePrice ?? 0).toFixed(0)}`;
  const batch = (id: string) => state.batches.find((b) => b.id === id);
  const stockItem = (id: string) => state.stock.find((s) => s.id === id);
  const relatedOrderForStock = (stockItemId: string) =>
    state.orders.find((order) =>
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
    (state.personnel ?? []).find((person) => person.username === state.user?.username)?.name ??
    state.user?.username ??
    "";
  const operatorOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: { value: string; label: string }[] = [];

    for (const person of state.personnel ?? []) {
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
  const filteredLogs = useMemo(
    () => [...(state.logs ?? [])]
      .filter((log) => {
        const gid = logGroupId(log);
        if (logGroupFilter !== "all" && gid !== logGroupFilter) return false;
        if (logStartDate && log.date < logStartDate) return false;
        if (logEndDate && log.date > logEndDate) return false;
        return true;
      })
      .sort((a, b) => b.date.localeCompare(a.date)),
    [state.logs, state.tankGroups, logGroupFilter, logStartDate, logEndDate]
  );
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
  const viewLogGroup = viewLogGroupId
    ? state.tankGroups.find((group) => group.id === viewLogGroupId) ?? null
    : null;
  const viewGroupLogs = viewLogGroupId ? logsByGroup.get(viewLogGroupId) ?? [] : [];
  const hasLogFilter = logGroupFilter !== "all" || !!logStartDate || !!logEndDate;

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
  const movingSiteId = siteIdForStockItem(movingItems[0]);
  const moveTargetGroups = movingSiteId
    ? state.tankGroups.filter((group) => normalizeSiteId(group.siteId) === movingSiteId)
    : state.tankGroups;
  const targetSubTanks = moveTargetGroups.find((g) => g.id === targetGroupId)?.subTanks ?? [];
  const batchRecordItems = batchRecordItemIds
    .map((id) => stockItem(id))
    .filter(Boolean) as StockItem[];
  const batchRecordMinDate = batchRecordItems.reduce(
    (latest, item) => (item.inDate && item.inDate > latest ? item.inDate : latest),
    ""
  );
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
    const sourceSiteGroups = state.tankGroups.filter((group) => normalizeSiteId(group.siteId) === sourceSiteId);
    const crossSiteItem = validIds
      .map((id) => stockItem(id))
      .find((item) => item && siteIdForStockItem(item) !== sourceSiteId);
    if (crossSiteItem) return toast.error("不能同时选择不同场地的鱼移缸");
    const defaultGroup = sourceSiteGroups.find((g) => g.id !== currentGroupId) ?? sourceSiteGroups[0];
    if (!defaultGroup) return toast.error("当前场地没有可选择的目标缸组");
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
    const targetSiteId = targetGroup ? normalizeSiteId(targetGroup.siteId) : "";
    if (!targetSiteId || movingItems.some((item) => siteIdForStockItem(item) !== targetSiteId)) {
      return toast.error("不能跨场地移缸，请选择同一场地内的目标子缸");
    }
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
        const needsCompress = file.size > 10 * 1024 * 1024;
        if (needsCompress) toast.info("图片较大，正在压缩…");
        const url = await readAndCompressImage(file);
        if (needsCompress) toast.success("压缩完成");
        setBatchRecord((prev) => ({ ...prev, photos: [...prev.photos, url] }));
      } catch {
        toast.error("图片处理失败，请重试");
      }
    });
  };

  const handleBatchVideoUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("video/")) { toast.error("请选择视频文件"); return; }
      if (file.size > 50 * 1024 * 1024) {
        toast.error("视频文件超过 50 MB 限制，请剪短后重试");
        return;
      }
      if (file.size > 10 * 1024 * 1024) toast.info("视频较大，读取中…");
      const reader = new FileReader();
      reader.onload = (ev) => {
        const url = ev.target?.result as string;
        setBatchRecord((prev) => ({ ...prev, videos: [...prev.videos, url] }));
        toast.success("视频已就绪");
      };
      reader.onerror = () => toast.error("视频读取失败，请重试");
      reader.readAsDataURL(file);
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
        const needsCompress = file.size > 10 * 1024 * 1024;
        if (needsCompress) toast.info("图片较大，正在压缩…");
        const url = await readAndCompressImage(file);
        if (needsCompress) toast.success("压缩完成");
        setLossProof((prev) => [...prev, url]);
      } catch {
        toast.error("图片处理失败，请重试");
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
      | { type: "sold"; date: string; orderNo: string }
      | { type: "shipment"; date: string; orderNo: string; carrier: string; trackingNo: string; status: string; shipMethod?: string }
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
    const order = state.orders.find((o) =>
      o.items.some((i) => i.stockItemId === item.id) && o.status !== "cancelled"
    );
    if (order) {
      events.push({ type: "sold", date: order.date, orderNo: order.orderNo });
    }
    for (const shipment of state.shipments.filter((shipment) =>
      Array.isArray(shipment.itemStockIds) && shipment.itemStockIds.includes(item.id)
    )) {
      const shipmentOrder = state.orders.find((order) => order.id === shipment.orderId);
      events.push({
        type: "shipment",
        date: shipment.shipDate,
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
    const price = Number(bioBasePrice);
    if (!bioBasePrice.trim() || Number.isNaN(price) || price <= 0) {
      return toast.error("请填写大于 0 的销售默认价");
    }
    if (!confirmWrite("修改", "将保存鱼的状态、售价、编号和备注。")) return;
    const normalizedPrice = Number(price.toFixed(2));
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      stock: latest.stock.map((x) =>
        x.id === bioItemId ? { ...x, status: bioStatus, basePrice: normalizedPrice, code: bioCode.trim(), notes: bioNotes } : x
      ),
    }));
    if (!ok) return toast.error("保存失败，请重试");
    setBioOpen(false);
    toast.success("鱼的信息已更新");
  };

  // Add bio record
  const addBioRecord = async () => {
    if (!bioItemId) return;
    if (!permission.requirePermission("create")) return;
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

  const saveBioRecordTime = async () => {
    if (!editingRecordId || !bioItemId) return;
    if (!permission.requirePermission("update")) return;
    const recordTime = normalizeBioRecordTime(editingRecordTime);
    if (!recordTime) return toast.error("请选择记录时间");
    if (recordTime > nowForRecord) return toast.error("记录时间不能晚于当前时间");
    const currentItem = stockItem(bioItemId);
    const minTime = minDatetimeForDate(currentItem?.inDate);
    if (currentItem && minTime && recordTime < minTime) return toast.error("记录时间不能早于入库日期");
    if (!confirmWrite("修改", "将修改这条观察/治疗记录的记录时间。")) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      bioRecords: latest.bioRecords.map((record) =>
        record.id === editingRecordId ? { ...record, date: recordTime } : record
      ),
    }));
    if (!ok) return toast.error("保存失败，请重试");
    setEditingRecordId(null);
    setEditingRecordTime("");
    toast.success("记录时间已更新");
  };

  // Delete bio record
  const deleteBioRecord = async (recordId: string) => {
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", "将删除这条观察/治疗记录。")) return;
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      bioRecords: latest.bioRecords.filter((r) => r.id !== recordId),
    }));
    if (!ok) return toast.error("删除失败，请重试");
    toast.success("记录已删除");
  };

  // Handle photo upload for new record
  const handlePhotoUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach(async (file) => {
      if (!file.type.startsWith("image/")) { toast.error("请选择图片文件"); return; }
      try {
        const needsCompress = file.size > 10 * 1024 * 1024;
        if (needsCompress) toast.info("图片较大，正在压缩…");
        const url = await readAndCompressImage(file);
        if (needsCompress) toast.success("压缩完成");
        setNewRecord((prev) => ({ ...prev, photos: [...prev.photos, url] }));
      } catch {
        toast.error("图片处理失败，请重试");
      }
    });
  };

  // Handle video upload for new record
  const handleVideoUpload = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((file) => {
      if (!file.type.startsWith("video/")) { toast.error("请选择视频文件"); return; }
      if (file.size > 50 * 1024 * 1024) {
        toast.error("视频文件超过 50 MB 限制，请剪短后重试");
        return;
      }
      if (file.size > 10 * 1024 * 1024) toast.info("视频较大，读取中…");
      const reader = new FileReader();
      reader.onload = (ev) => {
        const url = ev.target?.result as string;
        setNewRecord((prev) => ({ ...prev, videos: [...prev.videos, url] }));
        toast.success("视频已就绪");
      };
      reader.onerror = () => toast.error("视频读取失败，请重试");
      reader.readAsDataURL(file);
    });
  };

  // Log dialog
  const saveLog = async () => {
    if (!editingLog) return;
    if (!permission.requirePermission(editingLog.id ? "update" : "create")) return;
    if (!editingLog.date) return toast.error("请选择日期");
    if (editingLog.date > today) return toast.error("日志日期不能晚于今天");
    const tankGroupId = logGroupId(editingLog);
    if (!tankGroupId) return toast.error("请选择缸组");
    if (!editingLog.action.trim()) return toast.error("请填写操作内容");
    if (!editingLog.operator) return toast.error("请选择操作员");
    const logToSave: DailyLog = {
      ...editingLog,
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
      tankGroupId: logGroupId(log),
      subTankId: undefined,
    });
    setLogOpen(true);
  };

  const deleteLog = async (log: DailyLog) => {
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `将删除 ${log.date} 的养护日志，并同步删除鱼历史记录中由这条日志生成的记录。`)) return;
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
    setEditingLog({ id: "", date: today, tankGroupId: groupId, action: "", operator: currentOperator, notes: "" });
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
    <div className="flex flex-col gap-4">
      <div>
        <h2>日常管理</h2>
        <p className="text-sm text-muted-foreground">巡缸、查看生物详情、记录养护操作</p>
      </div>

      <Tabs defaultValue="visual">
        <TabsList>
          <TabsTrigger value="visual">缸位视图</TabsTrigger>
          <TabsTrigger value="logs">养护日志</TabsTrigger>
        </TabsList>

        <TabsContent value="visual" className="flex flex-col gap-4">
          {/* 过滤栏：状态按钮 + 搜索框 */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              {STATUS_ORDER.map((st) => {
                const meta = statusFilterMeta[st];
                const active = filterStatuses.has(st);
                return (
                  <button
                    key={st}
                    onClick={() => toggleStatusFilter(st)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-all select-none
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
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-medium transition-all select-none
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
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-1.5 py-1 rounded transition-colors"
                >
                  <X className="size-3" /> 清除
                </button>
              )}
            </div>
	            <div className="flex items-center gap-2">
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
	              <div className="relative">
	                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
	                <Input
	                  value={q}
	                  onChange={(e) => setQ(e.target.value)}
		                  placeholder="搜索缸位 / 商品名 / 编号 / 备注…"
		                  aria-label="搜索缸位、商品名、编号或备注"
		                  className="pl-9 w-64"
		                />
	              </div>
	            </div>
          </div>

          <div className="flex flex-col gap-4">
            {visibleGroups.length === 0 && anyFilter && (
              <div className="py-12 text-center text-sm text-muted-foreground">没有符合条件的结果</div>
            )}
            {visibleGroups.map((g) => {
              const groupLogs = logsByGroup.get(g.id) ?? [];
              const latestLog = groupLogs[0];
              return (
              <Card key={g.id} className="p-5 border-2 border-sky-200 bg-sky-50/30">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h3>{g.name}</h3>
                    <div className="text-xs text-muted-foreground">{g.location}</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="text-slate-700 border-slate-200 hover:bg-white"
                      onClick={() => setViewLogGroupId(g.id)}
                    >
                      <ClipboardList className="size-3.5 mr-1" />
                      查看日志{groupLogs.length > 0 ? ` ${groupLogs.length}` : ""}
                    </Button>
                    {permission.canCreate && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="text-sky-600 border-sky-200 hover:bg-sky-50"
                        onClick={() => openNewLogForGroup(g.id)}
                      >
                        <Plus className="size-3.5 mr-1" />
                        新增日志
                      </Button>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="mb-3 flex w-full items-start gap-2 rounded-md border bg-white/80 px-3 py-2 text-left transition-colors hover:bg-white"
                  onClick={() => setViewLogGroupId(g.id)}
                >
                  <Clock className="mt-0.5 size-4 shrink-0 text-sky-600" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-slate-600">最近养护</div>
                    {latestLog ? (
                      <>
                        <div className="mt-0.5 truncate text-sm font-medium">
                          {latestLog.date} · {latestLog.action}
                          {latestLog.operator ? ` · ${latestLog.operator}` : ""}
                        </div>
                        {latestLog.notes && (
                          <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{latestLog.notes}</div>
                        )}
                      </>
                    ) : (
                      <div className="mt-0.5 text-sm text-muted-foreground">暂无养护日志</div>
                    )}
                  </div>
                </button>
                {/* 子缸横向排列，溢出滚动 */}
                <div className="flex flex-row gap-3 overflow-x-auto pb-1">
                  {visibleSubTanks(g).map((t) => {
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
                      <div key={t.id} className="bg-white rounded-md border flex flex-col min-w-[220px] flex-shrink-0">
                        {/* 子缸标题行 */}
                        <div className="flex items-center justify-between px-3 py-2 border-b">
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
                        <div className="flex flex-col divide-y">
                          {items.length === 0 && (
                            <div className="px-3 py-3 text-xs text-muted-foreground text-center">
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
	                                      return (
	                                        <button
	                                          key={s.id}
	                                          onClick={(e) => {
	                                            e.stopPropagation();
	                                            if (selectMode) toggleSelectItem(s.id);
	                                            else openBio(s);
	                                          }}
	                                          className={`relative size-9 rounded overflow-hidden bg-muted hover:opacity-80 transition-opacity cursor-pointer ${
	                                            selected ? "ring-2 ring-emerald-500 ring-offset-2" : statusRingClass(s.status, s.sold)
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
              </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="logs" className="flex flex-col gap-4">
          {(() => {
            const canManageLogs = permission.canUpdate || permission.canDelete;
            return (
              <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">缸组</Label>
                <Select value={logGroupFilter} onValueChange={setLogGroupFilter}>
                  <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部缸组</SelectItem>
                    {state.tankGroups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">开始日期</Label>
                <Input
                  type="date"
                  value={logStartDate}
                  max={logEndDate || today}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value && value > today) return toast.error("开始日期不能晚于今天");
                    setLogStartDate(value);
                    if (logEndDate && value && logEndDate < value) setLogEndDate("");
                  }}
                  className="w-40"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">结束日期</Label>
                <Input
                  type="date"
                  value={logEndDate}
                  min={logStartDate || undefined}
                  max={today}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value && value > today) return toast.error("结束日期不能晚于今天");
                    if (logStartDate && value && value < logStartDate) return toast.error("结束日期不能早于开始日期");
                    setLogEndDate(value);
                  }}
                  className="w-40"
                />
              </div>
              {hasLogFilter && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setLogGroupFilter("all");
                    setLogStartDate("");
                    setLogEndDate("");
                  }}
                >
                  清除筛选
                </Button>
              )}
            </div>
            {permission.canCreate && (
              <Button onClick={() => {
                if (logGroupFilter === "all") {
                  toast.error("请先选择缸组，或从缸组卡片新增日志");
                  return;
                }
                setEditingLog({ id: "", date: today, tankGroupId: logGroupFilter, action: "", operator: currentOperator, notes: "" });
                setLogOpen(true);
              }}>新增日志</Button>
            )}
          </div>
          <div className="rounded-lg border bg-card overflow-hidden">
            <table className="w-full">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-4 py-3 text-sm">日期</th>
                  <th className="text-left px-4 py-3 text-sm">缸组</th>
                  <th className="text-left px-4 py-3 text-sm">操作</th>
                  <th className="text-left px-4 py-3 text-sm">操作员</th>
                  <th className="text-left px-4 py-3 text-sm">备注</th>
                  {canManageLogs && <th className="text-right px-4 py-3 text-sm">操作</th>}
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length === 0 ? (
                  <tr><td colSpan={canManageLogs ? 6 : 5} className="px-4 py-12 text-center text-muted-foreground text-sm">暂无日志</td></tr>
                ) : filteredLogs.map((l) => (
                  <tr key={l.id} className="border-t">
                    <td className="px-4 py-3 text-sm">{l.date}</td>
                    <td className="px-4 py-3 text-sm">{groupName(logGroupId(l))}</td>
                    <td className="px-4 py-3 text-sm">{l.action}</td>
                    <td className="px-4 py-3 text-sm">{l.operator}</td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{l.notes}</td>
                    {canManageLogs && (
                      <td className="px-4 py-3 text-sm">
                        <div className="flex items-center justify-end gap-2">
                          {permission.canUpdate && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={logSaving}
                              onClick={() => editLog(l)}
                            >
                              编辑
                            </Button>
                          )}
                          {permission.canDelete && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              disabled={logSaving}
                              onClick={() => deleteLog(l)}
                            >
                              删除
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
              </>
            );
          })()}
        </TabsContent>
      </Tabs>

      {/* ── 生物详情 Dialog ── */}
      <Dialog open={bioOpen} onOpenChange={setBioOpen}>
        <DialogContent aria-describedby={undefined} className="w-[min(96vw,56rem)] max-w-[96vw] sm:max-w-4xl max-h-[92dvh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {bioProduct?.imageUrl && (
                <div className="size-8 rounded overflow-hidden border">
                  <ImageWithFallback src={bioProduct.imageUrl} alt="" className="size-full object-cover" />
                </div>
              )}
              <span>生物详情</span>
              {bioProduct && (
                <span className="text-muted-foreground flex items-center gap-1.5">
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
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
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
                        <div className="flex items-center gap-2">
                          {ev.type === "record" && ev.sourceType !== "dailyLog" && editingRecordId === ev.id ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="datetime-local"
                                min={minDatetimeForDate(bioItem?.inDate)}
                                max={nowForRecord}
                                value={editingRecordTime}
                                onChange={(event) => setEditingRecordTime(event.target.value)}
                                className="h-7 w-40 text-xs"
                              />
                              <button type="button" onClick={saveBioRecordTime} className="text-xs text-emerald-600 hover:underline">保存</button>
                              <button type="button" onClick={() => { setEditingRecordId(null); setEditingRecordTime(""); }} className="text-xs text-muted-foreground hover:underline">取消</button>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">{formatBioRecordTime(ev.date)}</span>
                          )}
                          {ev.type === "record" && ev.sourceType !== "dailyLog" && permission.canUpdate && editingRecordId !== ev.id && (
                            <button
                              type="button"
                              onClick={() => startEditBioRecordTime(ev.id, ev.date)}
                              className="text-xs text-sky-500 hover:text-sky-700"
                              title="修改记录时间"
                            >
                              改时间
                            </button>
                          )}
	                          {ev.type === "record" && ev.sourceType !== "dailyLog" && permission.canDelete && (
	                            <button
                              type="button"
                              onClick={() => deleteBioRecord(ev.id)}
                              className="text-xs text-red-400 hover:text-red-600"
                              title="删除记录"
                            >
                              <X className="size-3" />
                            </button>
                          )}
                        </div>
                      </div>

                      {ev.type === "stock_in" && (
                        <p className="text-muted-foreground text-xs">批次：{ev.batchNo}</p>
                      )}
                      {ev.type === "sold" && (
                        <p className="text-yellow-700 text-xs">订单：{ev.orderNo}</p>
                      )}
                      {ev.type === "shipment" && (
                        <p className="text-violet-700 text-xs">
                          订单：{ev.orderNo}
                          {ev.shipMethod === "pickup" ? "；上门自取" : ""}
                          {ev.carrier ? `；${ev.carrier}` : ""}
                          {ev.trackingNo ? `；单号：${ev.trackingNo}` : ""}
                          {`；状态：${ev.status === "delivered" ? "已签收" : ev.status === "outbound" ? "已出库待发货" : ev.status === "shipped" ? "运输中" : ev.status === "damaged" ? "报损" : "待发货"}`}
                        </p>
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
                                  <a
                                    href={src}
                                    download={`photo-${pi + 1}.jpg`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="下载照片"
                                  >
                                    <Download className="size-4 text-white" />
                                  </a>
                                </div>
                              ))}
                            </div>
                          )}
                          {(ev.videos ?? []).length > 0 && (
                            <div className="flex flex-wrap gap-2 mt-2">
                              {(ev.videos ?? []).map((src, vi) => (
                                <div key={vi} className="group relative rounded border overflow-hidden" style={{ width: "120px" }}>
                                  <video src={src} className="w-full" controls />
                                  <a
                                    href={src}
                                    download={`video-${vi + 1}.mp4`}
                                    onClick={(e) => e.stopPropagation()}
                                    className="absolute top-1 right-1 bg-black/60 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                                    title="下载视频"
                                  >
                                    <Download className="size-3.5 text-white" />
                                  </a>
                                </div>
                              ))}
                            </div>
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
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label className="text-xs">记录时间</Label>
	                  <Input
	                    type="datetime-local"
                      min={minDatetimeForDate(bioItem?.inDate)}
	                    max={nowForRecord}
	                    value={newRecord.date}
	                    onChange={(e) => changeBioRecordDate(e.target.value)}
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
                      onChange={(e) => { handlePhotoUpload(e.target.files); e.target.value = ""; }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
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
                      accept="video/*"
                      multiple
                      className="hidden"
                      onChange={(e) => { handleVideoUpload(e.target.files); e.target.value = ""; }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex-1"
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
                      <img src={src} alt="" className="size-full object-cover" />
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
              <Button variant="outline" size="sm" onClick={addBioRecord} className="self-end">
                <Plus className="size-4" /> 添加观察/治疗记录
              </Button>
	            </div>
	            )}
	          </div>

		          <DialogFooter className="flex-col pt-3 border-t shrink-0 gap-2 sm:flex-row sm:flex-wrap sm:items-center">
		            <div className="flex w-full flex-wrap items-center gap-2 sm:mr-auto sm:w-auto">
		              {permission.canUpdate && bioItem && (
		                <Button variant="outline" onClick={() => openMoveDialog([bioItem.id])}>
		                  <ArrowRightLeft className="size-4 mr-1" />
		                  移缸
		                </Button>
		              )}
		              {permission.canDelete && bioItem && (
		                <Button
		                  variant="outline"
		                  className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
		                  onClick={() => openLossDialog(bioItem.id)}
		                >
		                  <AlertTriangle className="size-4 mr-1" />
		                  损耗
		                </Button>
		              )}
		            </div>
		            <Button variant="outline" onClick={() => setBioOpen(false)}>关闭</Button>
		            {permission.canUpdate && <Button onClick={saveBio}>保存信息</Button>}
		          </DialogFooter>
        </DialogContent>
	      </Dialog>

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
	            <div className="grid grid-cols-2 gap-3">
	              <div className="grid gap-2">
	                <Label>记录时间<span className="text-red-500 ml-0.5">*</span></Label>
	                <Input
	                  type="datetime-local"
	                  min={minDatetimeForDate(batchRecordMinDate)}
	                  max={nowForRecord}
	                  value={batchRecord.date}
	                  onChange={(e) => changeBatchRecordDate(e.target.value)}
	                />
	              </div>
	              <div className="grid gap-2">
	                <Label>附件</Label>
	                <div className="grid grid-cols-2 gap-2">
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
	                    accept="video/*"
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
	                    <img src={src} alt="" className="size-full object-cover" />
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
	            <div className="grid grid-cols-2 gap-3">
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
	                      <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
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
	              <div className="grid grid-cols-2 gap-3">
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
	                      <img src={src} alt="" className="size-full object-cover" />
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

	      {/* ── 缸组养护日志查看 Dialog ── */}
      <Dialog open={!!viewLogGroupId} onOpenChange={(open) => !open && setViewLogGroupId(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-3xl max-h-[86vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardList className="size-5 text-sky-600" />
              {viewLogGroup?.name ?? "缸组"}养护日志
            </DialogTitle>
          </DialogHeader>
          <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{viewLogGroup?.location || "—"}</div>
              <div className="text-xs text-muted-foreground">共 {viewGroupLogs.length} 条记录，按日期从新到旧排列</div>
            </div>
            {permission.canCreate && viewLogGroupId && (
              <Button
                type="button"
                size="sm"
                onClick={() => openNewLogForGroup(viewLogGroupId)}
              >
                <Plus className="size-3.5 mr-1" />
                新增日志
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border bg-card">
            {viewGroupLogs.length === 0 ? (
              <div className="px-4 py-12 text-center text-sm text-muted-foreground">暂无养护日志</div>
            ) : (
              <div className="divide-y">
                {viewGroupLogs.map((log) => (
                  <div key={log.id} className="grid gap-2 px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold">{log.date}</span>
                          <Badge variant="secondary">{log.operator || "—"}</Badge>
                          {log.syncedStockItemIds && log.syncedStockItemIds.length > 0 && (
                            <span className="text-xs text-muted-foreground">
                              已同步 {log.syncedStockItemIds.length} 条鱼
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-sm font-medium">{log.action}</div>
                        {log.notes && <div className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{log.notes}</div>}
                      </div>
                      {(permission.canUpdate || permission.canDelete) && (
                        <div className="flex shrink-0 items-center gap-2">
                          {permission.canUpdate && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={logSaving}
                              onClick={() => {
                                setViewLogGroupId(null);
                                editLog(log);
                              }}
                            >
                              编辑
                            </Button>
                          )}
                          {permission.canDelete && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-600 hover:bg-red-50 hover:text-red-700"
                              disabled={logSaving}
                              onClick={() => deleteLog(log)}
                            >
                              删除
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewLogGroupId(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

	      {/* ── 养护日志 Dialog ── */}
      <Dialog open={logOpen} onOpenChange={setLogOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogHeader><DialogTitle>{editingLog?.id ? "编辑日志" : "新增养护日志"}</DialogTitle></DialogHeader>
          {editingLog && (
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
	                  <Label>日期</Label>
	                  <Input
	                    type="date"
	                    max={today}
	                    value={editingLog.date}
	                    onChange={(e) => {
	                      const value = e.target.value;
	                      if (value && value > today) {
	                        toast.error("日志日期不能晚于今天");
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
