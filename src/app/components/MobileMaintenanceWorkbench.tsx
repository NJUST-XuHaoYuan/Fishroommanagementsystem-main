import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Check, CheckCircle2, ArrowLeft, Camera, ChevronRight, ClipboardList, Droplets, Eye, Fish, FlaskConical, MapPin, MoreHorizontal, RefreshCw, Search, Utensils, X } from "lucide-react";
import { toast } from "sonner";
import { useStore, uid, normalizeWaterQualityParameters, waterQualityParameterIdsForGroup, type BioRecord, type DailyLog, type StockItem, type WaterQualityRecord, type WaterQualityMeasurement, type StockLossRecord } from "../store";
import { isMobileSharedWaterLog, mobileWaterHistoryLocation, mobileMaintenanceHistoryTime, mobileWaterTimestamp, mobileWaterDisplayValue, mobileWaterMeasurement, orderMobileWaterParameters, parseMobileWaterValue, toggleMobileWaterValueSign } from "../utils/mobileWaterQuality";
import { createMaintenanceClientMutationId } from "../utils/maintenanceMutation";
import { freezeMobileLossItems, mobileLossRequest, mobileLossValidation, type MobileLossItem, type MobileLossRequest } from "../utils/mobileLoss";
import { canRegisterMaintenanceLoss, usePermission } from "../utils/permissions";
import { matchesSite, siteName } from "../utils/sites";
import { getInventoryOutStockIds, isPhysicallyInTank } from "../utils/inventory";
import { nowDatetimeLocal, formatBioRecordTime } from "../utils/localDateTime";
import { authJsonHeaders } from "../utils/authSession";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";
import { MobileMaintenanceMedia } from "./MobileMaintenanceMedia";
import { useMaintenancePlans } from "../utils/useMaintenancePlans";
import { isActiveMaintenanceTask, maintenanceToday, type MaintenanceTask, type MaintenanceCompletion } from "../utils/maintenanceWorkbench";
import { maintenanceRecordAction, maintenanceOperationLabel, pendingMaintenanceCompletionState } from "../utils/maintenancePlanTargets";
import { isInheritedMaintenanceHistory, maintenanceHistoryScopeLabel } from "../utils/maintenanceGroupHistory";
import "./mobile-maintenance.css";

type Step = "tasks" | "taskResult" | "taskUnlink" | "lossList" | "lossPhoto" | "lossConfirm" | "lossResult" | "lossHistory" | "lossDetail" | "lossReason" | "groupAction" | "sub" | "action" | "tankType" | "waterParameter" | "waterForm" | "fishList" | "fishAction" | "form" | "confirm" | "history" | "detail" | "discard";
type Draft = { id: string; scope: "group" | "fish"; kind: string; fishId: string; date: string; text: string; medicine: string; initialDate: string; waterParameterId: string; waterValue: string; waterMethod: string; photos: string[]; videos: string[] };
type History = { id: string; kind: "tank" | "fish" | "water"; operator: string; waterValues?: WaterQualityMeasurement[]; sourceLocation?: string; inherited?: boolean; date: string; title: string; text: string; location: string; fishLabel: string; photos: string[]; videos: string[] };
type LossDraft = { id: string; selectedIds: string[]; items: MobileLossItem[]; date: string; reason: string; photos: string[]; orderNos: string[] };
type LossHistoryItem = StockLossRecord & { productName?: string; fishCode?: string; reasonUpdatedBy?: string; reasonUpdatedAt?: string };
const freshLossDraft = (): LossDraft => ({ id: createMaintenanceClientMutationId(), selectedIds: [], items: [], date: nowDatetimeLocal().slice(0, 10), reason: "", photos: [], orderNos: [] });
const types = [{ label: "喂食", Icon: Utensils }, { label: "换水", Icon: Droplets }, { label: "观察", Icon: Eye }, { label: "其他", Icon: MoreHorizontal }];
const freshDraft = (scope: Draft["scope"] = "group", fishId = ""): Draft => { const date = nowDatetimeLocal(); return { id: uid(), scope, fishId, kind: "", date, initialDate: date, text: "", medicine: "", waterParameterId: "", waterValue: "", waterMethod: "", photos: [], videos: [] }; };

export function MobileMaintenanceWorkbench() {
  const { state, activeSiteId, saveDailyLog, saveBioRecordChange, saveWaterQualityRecord, saveMaintenanceAction, saveLossReason } = useStore();
  const permission = usePermission("daily");
  const lossPermission = usePermission("lossRecords");
  const plans = useMaintenancePlans(permission.canCreate || permission.canUpdate || permission.canDelete);
  const [activeTask, setActiveTask] = useState<MaintenanceTask | null>(null);
  const [taskCompletion, setTaskCompletion] = useState<MaintenanceCompletion | null>(null);
  const [pendingLink, setPendingLink] = useState<{ taskId: string; completion: MaintenanceCompletion } | null>(null);
  const taskStorageKey = `maintenance-pending-link:${activeSiteId}:${state.user?.username || ""}`;
  const pendingContextRef = useRef<string>(taskStorageKey); pendingContextRef.current = taskStorageKey;
  const canReportLoss = canRegisterMaintenanceLoss(permission.canDelete, lossPermission.canCreate);
  const [groupId, setGroupId] = useState("");
  const [subId, setSubId] = useState("");
  const [step, setStep] = useState<Step | null>(null);
  const [groupSearch, setGroupSearch] = useState("");
  const [fishSearch, setFishSearch] = useState("");
  const [draft, setDraft] = useState<Draft>(() => freshDraft());
  const [lossDraft, setLossDraft] = useState<LossDraft>(() => freshLossDraft());
  const lossAttempt = useRef<MobileLossRequest | null>(null);
  const [lossRows, setLossRows] = useState<LossHistoryItem[]>([]);
  const [lossHistoryMissing, setLossHistoryMissing] = useState(false);
  const [lossDetail, setLossDetail] = useState<LossHistoryItem | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<History[]>([]);
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyAll, setHistoryAll] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [detail, setDetail] = useState<History | null>(null);
  const [returnStep, setReturnStep] = useState<Step>("action");
  const [discardTo, setDiscardTo] = useState<Step | null>("action");
  const busyRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const context = JSON.stringify([activeSiteId, state.user?.username, state.user?.role, state.user?.visibleSiteIds, state.user?.account, captureNewCustomerSession()?.key]);
  const contextRef = useRef(context); contextRef.current = context;
  const canRead = permission.canCreate || permission.canUpdate || permission.canDelete || lossPermission.canUpdate;
  const groups = useMemo(() => state.tankGroups.filter(group => matchesSite(group, activeSiteId)), [state.tankGroups, activeSiteId]);
  const group = groups.find(item => item.id === groupId);
  const sub = group?.subTanks.find(item => item.id === subId);
  const waterParameters = useMemo(() => normalizeWaterQualityParameters(state.systemSettings), [state.systemSettings]);
  const commonWaterIds = waterQualityParameterIdsForGroup(group, waterParameters);
  const sortedWaterParameters = orderMobileWaterParameters(waterParameters, commonWaterIds);
  const waterParameter = waterParameters.find(parameter => parameter.id === draft.waterParameterId);
  const isWaterDraft = draft.scope === "group" && draft.kind === "水质";
  const waterMeasurement = waterParameter ? mobileWaterMeasurement(waterParameter, draft.waterValue, draft.waterMethod) : null;
  const location = group && sub ? `${group.name} / ${sub.name}` : "";
  const groupLocation = group ? `${group.name} · 整个缸组` : "";
  const draftLocation = draft.scope === "group" ? groupLocation : location;
  const outIds = useMemo(() => getInventoryOutStockIds(state), [state.orders, state.shipments, state.inventoryProjection]);
  const tankFish = useMemo(() => sub ? state.stock.filter(item => item.subTankId === sub.id && isPhysicallyInTank(item, outIds)) : [], [state.stock, sub, outIds]);
  const selectedFish = tankFish.find(item => item.id === draft.fishId);
  const product = (item?: StockItem) => state.products.find(value => value.id === item?.productId);
  const visibleFish = tankFish.filter(item => `${product(item)?.name || ""} ${item.code || ""} ${item.id}`.toLowerCase().includes(fishSearch.trim().toLowerCase()));
  const fishLabel = (item?: StockItem) => item ? `${product(item)?.name || "未命名商品"} · ${item.code || `库存 ${item.id}`}` : "鱼只已不在当前子缸";
  const lossEditing = ["lossList", "lossPhoto", "lossConfirm"].includes(step || "");
  const reasonDirty = step === "lossReason" && reasonText !== (lossDetail?.reason || "");
  const dirty = (lossEditing && Boolean(lossDraft.selectedIds.length || lossDraft.photos.length || lossDraft.reason)) || reasonDirty || (!taskCompletion && Boolean(draft.text.trim() || draft.medicine.trim() || draft.photos.length || draft.videos.length || draft.waterValue.length || draft.waterMethod || draft.date !== draft.initialDate));
  const blocked = saving || uploading || plans.saving;
  const displayName = state.personnel.find(person => person.username === state.user?.username)?.name || state.user?.username || "本人";
  const operatorLabel = (username: string) => state.personnel.find(person => person.username === username)?.name || username || displayName;
  const draftText = [draft.kind === "拍照／视频" ? "" : `【${draft.kind}】`, draft.medicine.trim() ? `实际用药及用量：${draft.medicine.trim()}` : "", draft.text.trim()].filter(Boolean).join("\n");

  useEffect(() => {
    alive.current = true; setActiveTask(null); setTaskCompletion(null); setPendingLink(null); try { const saved = JSON.parse(sessionStorage.getItem(taskStorageKey) || "null"); if (saved?.taskId && saved.completion?.recordId && ["dailyLog", "waterQualityRecord", "bioRecord"].includes(saved.completion.kind)) setPendingLink(saved); } catch {} setGroupId(""); setSubId(""); setStep(null); setDraft(freshDraft()); setLossDraft(freshLossDraft()); lossAttempt.current = null; setLossRows([]); setLossDetail(null); setReasonText(""); setHistory([]); setError(""); setSaving(false); setUploading(false); busyRef.current = false;
    return () => { alive.current = false; };
  }, [context]);
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [step]);
  useEffect(() => {
    if (!dirty && !uploading && !saving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, uploading, saving]);

  const move = (next: Step | null) => { setError(""); setStep(next); };
  const resetDrafts = () => { setActiveTask(null); setTaskCompletion(null); setDraft(freshDraft()); setLossDraft(freshLossDraft()); lossAttempt.current = null; setReasonText(""); };
  const openLossHistory = (missing = false) => { resetDrafts(); setLossDetail(null); setLossHistoryMissing(missing); move("lossHistory"); };
  const startLoss = () => { resetDrafts(); setFishSearch(""); move("lossList"); };
  const leave = (next: Step | null) => {
    if (blocked || busyRef.current) return;
    if (dirty) { setReturnStep(step || "action"); setDiscardTo(next); move("discard"); }
    else { resetDrafts(); move(next); }
  };
  const close = () => {
    if (blocked) return;
    if (step === "discard") { move(returnStep); return; }
    if (activeTask) { if (taskCompletion) { setActiveTask(null); setTaskCompletion(null); move("tasks"); return; } leave("tasks"); return; }
    if (step === "lossReason") { leave("lossDetail"); return; }
    if (lossEditing) { leave("action"); return; }
    if (step === "lossResult") { resetDrafts(); move("action"); return; }
    const editing = ["form", "waterParameter", "waterForm", "confirm", "fishAction", "fishList", "tankType"].includes(step || "");
    leave(editing && group ? draft.scope === "group" ? "groupAction" : sub ? "action" : "groupAction" : null);
  };
  const back = () => {
    if (blocked) return;
    if (activeTask && ["form", "waterParameter", "taskResult"].includes(step || "")) { close(); return; }
    if (step === "tasks") { move(null); return; }
    if (step === "taskUnlink") { move("tasks"); return; }
    if (step === "discard") { move(returnStep); return; }
    if (step === "lossReason") { leave("lossDetail"); return; }
    if (step === "lossDetail") { move("lossHistory"); return; }
    if (step === "lossHistory") { move(null); return; }
    if (step === "lossResult") { resetDrafts(); move("action"); return; }
    if (step === "lossList") { leave("action"); return; }
    if (step === "lossPhoto") { move("lossList"); return; }
    if (step === "lossConfirm") { if (lossAttempt.current) setError("本次已提交，请重试确认保存结果。需要修改内容时请先在“我的报损”核对是否已保存。"); else move("lossPhoto"); return; }
    if (step === "confirm") { move(isWaterDraft ? "waterForm" : "form"); return; }
    if (step === "waterForm") { move("waterParameter"); return; }
    if (step === "waterParameter") { leave("groupAction"); return; }
    if (step === "form") { if (draft.scope === "group") leave("groupAction"); else move(draft.scope === "fish" ? "fishAction" : "tankType"); return; }
    if (step === "tankType") { leave("groupAction"); return; }
    if (step === "fishAction") { leave("fishList"); return; }
    if (step === "fishList") { leave("action"); return; }
    if (step === "detail") { move(returnStep); return; }
    if (step === "history") { move(historyAll ? null : subId ? "action" : "groupAction"); return; }
    if (step === "action") { setDraft(freshDraft()); move("sub"); return; }
    if (step === "sub") { setSubId(""); move("groupAction"); return; }
    move(null);
  };

  useEffect(() => {
    if (!canRead || activeSiteId === "all" || !state.user || !["groupAction", "action", "history"].includes(step || "")) return;
    const session = captureNewCustomerSession(), captured = context;
    if (!session) { setHistoryError("登录已过期，请重新登录。"); return; }
    const controller = new AbortController();
    const current = () => alive.current && !controller.signal.aborted && contextRef.current === captured && isNewCustomerSessionCurrent(session);
    setHistory([]); setHistoryError(""); setHistoryLoading(true);
    const params = new URLSearchParams({ siteId: activeSiteId, limit: "30" });
    if (step === "groupAction") params.set("tankGroupId", groupId);
    else if (step === "action" || !historyAll) { if (subId) params.set("subTankId", subId); else if (groupId) params.set("tankGroupId", groupId); }
    void (async () => {
      try {
        const response = await fetch(`/api/mobile-maintenance/history?${params}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || "记录加载失败，请重试。");
        if (!current()) return;
        const logRows: History[] = (Array.isArray(payload.logs) ? payload.logs : []).map((log: DailyLog) => {
          const tg = state.tankGroups.find(value => value.id === log.tankGroupId);
          const sharedWater = isMobileSharedWaterLog(log);
          const inherited = isInheritedMaintenanceHistory(log);
          const sourceId = log.recordedFromSubTankId || (sharedWater ? log.subTankId : undefined);
          const sourceSub = tg?.subTanks.find(value => value.id === sourceId);
          return { id: `tank:${log.id}`, kind: "tank", operator: log.operator || log.createdBy || "", date: mobileMaintenanceHistoryTime(log.date), title: log.action, text: log.notes, location: `${maintenanceHistoryScopeLabel(log, groups, historyAll ? "all" : groupId)} · 整个缸组`, inherited, sourceLocation: inherited ? "原房间记录，当时未区分具体缸" : sourceId ? sourceSub?.name || sourceId : undefined, fishLabel: "", photos: log.photos || [], videos: log.videos || [] };
        });
        const fishRows: History[] = (Array.isArray(payload.bioRecords) ? payload.bioRecords : []).map((record: BioRecord) => {
          const item = state.stock.find(value => value.id === record.stockItemId);
          const recordedGroup = state.tankGroups.find(value => value.subTanks.some(tank => tank.id === record.subTankId));
          const recordedSub = recordedGroup?.subTanks.find(value => value.id === record.subTankId);
          const recordedLocation = record.tankLocation || [record.tankGroupName || recordedGroup?.name, record.subTankName || recordedSub?.name].filter(Boolean).join(" / ") || "历史缸位";
          return { id: `fish:${record.id}`, kind: "fish", operator: record.operator || "", date: mobileMaintenanceHistoryTime(record.date), title: record.text?.match(/^【(.+?)】/)?.[1] || "鱼只记录", text: record.text, location: recordedLocation, fishLabel: item ? fishLabel(item) : `鱼只 ${record.stockItemId}`, photos: record.photos || [], videos: record.videos || [] };
        });
        const waterRows: History[] = (Array.isArray(payload.waterQualityRecords) ? payload.waterQualityRecords : []).map((record: WaterQualityRecord) => {
          const tg = state.tankGroups.find(value => value.id === record.tankGroupId);
          const sourceId = record.recordedFromSubTankId || record.subTankId;
          const st = tg?.subTanks.find(value => value.id === sourceId);
          const waterLocation = mobileWaterHistoryLocation(tg?.name, sourceId, st?.name);
          return { id: `water:${record.id}`, kind: "water", operator: record.operator || record.createdBy || "", date: mobileMaintenanceHistoryTime(record.measuredAt),
            title: record.values.length === 1 ? `水质 · ${record.values[0].parameterName}` : `水质测量 · ${record.values.length} 项`,
            text: record.notes || "", location: `${siteName(state, record.siteId || activeSiteId)} · ${isInheritedMaintenanceHistory(record) ? maintenanceHistoryScopeLabel(record, groups, historyAll ? "all" : groupId) : waterLocation.location}`, inherited: isInheritedMaintenanceHistory(record), sourceLocation: isInheritedMaintenanceHistory(record) ? "原房间记录，当时未区分具体缸" : waterLocation.sourceLocation,
            fishLabel: "", waterValues: record.values, photos: record.photos || [], videos: record.videos || [] };
        });
        setHistory([...logRows, ...fishRows, ...waterRows].sort((a, b) => b.date.localeCompare(a.date)));
        setHistoryTruncated(payload.truncated === true);
      } catch (cause) { if (current()) setHistoryError(cause instanceof Error ? cause.message : "记录加载失败。"); }
      finally { if (current()) setHistoryLoading(false); }
    })();
    return () => controller.abort();
  }, [step, historyVersion, historyAll, groupId, subId, context, canRead]);

  useEffect(() => {
    if (step !== "lossHistory" || !canRead || activeSiteId === "all") return;
    const session = captureNewCustomerSession(), captured = context;
    if (!session) { setHistoryError("登录已过期，请重新登录。"); return; }
    const controller = new AbortController();
    const current = () => alive.current && !controller.signal.aborted && contextRef.current === captured && isNewCustomerSessionCurrent(session);
    setLossRows([]); setHistoryError(""); setHistoryLoading(true);
    const params = new URLSearchParams({ siteId: activeSiteId, kind: "loss", limit: "100" });
    if (lossHistoryMissing) params.set("reasonStatus", "missing");
    void (async () => { try {
      const response = await fetch(`/api/mobile-maintenance/history?${params}`, { headers: authJsonHeaders(), signal: controller.signal, cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "报损记录加载失败。");
      if (current()) { setLossRows(Array.isArray(payload.lossRecords) ? payload.lossRecords : []); setHistoryTruncated(payload.truncated === true); }
    } catch (cause) { if (current()) setHistoryError(cause instanceof Error ? cause.message : "报损记录加载失败。"); }
    finally { if (current()) setHistoryLoading(false); } })();
    return () => controller.abort();
  }, [step, lossHistoryMissing, historyVersion, context, canRead]);

  const lossLabel = (record: LossHistoryItem) => {
    const item = state.stock.find(item => item.id === record.stockItemId);
    return `${record.productName || product(item)?.name || "鱼只"} · ${record.fishCode || item?.code || `库存 ${record.stockItemId}`}`;
  };
  const lossLocation = (record: LossHistoryItem) => {
    const recordedGroup = state.tankGroups.find(group => group.id === record.tankGroupId || group.subTanks.some(sub => sub.id === record.subTankId));
    return record.tankLocation || record.tankName || [record.tankGroupName || recordedGroup?.name, record.subTankName || recordedGroup?.subTanks.find(sub => sub.id === record.subTankId)?.name].filter(Boolean).join(" / ") || "历史缸位";
  };
  const prepareLossPhotos = () => {
    if (!canReportLoss || !sub) { setError("没有报损权限，或缸位已变化。"); return; }
    const selected = tankFish.filter(item => lossDraft.selectedIds.includes(item.id));
    if (!selected.length || selected.length !== lossDraft.selectedIds.length) { setError("选中的鱼已移缸、出库或报损，请重新核对。未保存任何报损。"); return; }
    const unchanged = lossDraft.items.length === selected.length && lossDraft.items.every(item => lossDraft.selectedIds.includes(item.expected.id));
    const items = unchanged ? lossDraft.items : freezeMobileLossItems(selected, sub.id, outIds, fishLabel, item => product(item)?.imageUrl || "");
    const orderNos = Array.from(new Set(state.orders.filter(order => order.status !== "cancelled" && order.items.some(item => lossDraft.selectedIds.includes(item.stockItemId))).map(order => order.orderNo)));
    setLossDraft(current => ({ ...current, items, photos: unchanged ? current.photos : [], orderNos })); move("lossPhoto");
  };
  const submitLoss = async () => {
    if (blocked || busyRef.current) return;
    if (!canReportLoss) { setError("没有登记损耗的权限。"); return; }
    const problem = mobileLossValidation(lossDraft.items, lossDraft.date, nowDatetimeLocal().slice(0, 10), lossDraft.photos);
    if (problem) { setError(problem); return; }
    const session = captureNewCustomerSession(), captured = context;
    if (!session) { setError("登录已过期，请重新登录。"); return; }
    const request = lossAttempt.current || mobileLossRequest(lossDraft.id, lossDraft.items, lossDraft.date, lossDraft.reason, lossDraft.photos);
    lossAttempt.current = request; busyRef.current = true; setSaving(true); setError("");
    try {
      const result = await saveMaintenanceAction(request);
      if (!alive.current || contextRef.current !== captured || !isNewCustomerSessionCurrent(session)) return;
      if (!result.ok) {
        if (result.code === "MAINTENANCE_STALE") {
          lossAttempt.current = null; setLossDraft(current => ({ ...current, selectedIds: [], items: [] })); move("lossList");
          setError("鱼只位置或状态已变化，本次未报损。请重新核对选鱼；若列表仍不正确，请刷新页面后再操作。"); return;
        }
        throw new Error(result.error || "保存未成功，照片和选鱼已保留，请重试确认结果。");
      }
      setHistoryVersion(value => value + 1); move("lossResult");
    } catch (cause) { if (alive.current && contextRef.current === captured && isNewCustomerSessionCurrent(session)) setError(cause instanceof Error ? cause.message : "保存失败，请重试确认结果。"); }
    finally { if (alive.current && contextRef.current === captured) { busyRef.current = false; setSaving(false); } }
  };
  const submitLossReason = async () => {
    if (blocked || busyRef.current || !lossDetail) return;
    const reason = reasonText.trim();
    if (!reason) { setError("请填写损耗原因。"); return; }
    if (reason.length > 2000) { setError("原因最多填写 2000 字。"); return; }
    const session = captureNewCustomerSession(), captured = context;
    if (!session) { setError("登录已过期，请重新登录。"); return; }
    busyRef.current = true; setSaving(true); setError("");
    try {
      const result = await saveLossReason({ recordId: lossDetail.id, reason, expectedReason: lossDetail.reason || "" });
      if (!alive.current || contextRef.current !== captured || !isNewCustomerSessionCurrent(session)) return;
      if (!result.ok) throw new Error(result.error || "原因保存失败，内容已保留。");
      setLossDetail(current => result.lossRecord || (current ? { ...current, reason } : current)); setReasonText(reason); setHistoryVersion(value => value + 1); move("lossDetail"); toast.success("原因已保存。");
    } catch (cause) { if (alive.current && contextRef.current === captured && isNewCustomerSessionCurrent(session)) setError(cause instanceof Error ? cause.message : "保存失败，内容已保留。"); }
    finally { if (alive.current && contextRef.current === captured) { busyRef.current = false; setSaving(false); } }
  };

  const pendingTasks = (plans.snapshot?.tasks || []).filter(task => isActiveMaintenanceTask(task)
    && (permission.isAdmin || !task.assignedTo || task.assignedTo === state.user?.username))
    .sort((a, b) => `${a.dueDate} ${a.dueTime}`.localeCompare(`${b.dueDate} ${b.dueTime}`));
  useEffect(() => {
    if (!pendingLink || !plans.snapshot || pendingContextRef.current !== taskStorageKey) return;
    if (pendingMaintenanceCompletionState(plans.snapshot.tasks, pendingLink) === "resolved") {
      setPendingLink(null); try { sessionStorage.removeItem(taskStorageKey); } catch {}
    }
  }, [pendingLink, plans.snapshot, taskStorageKey]);
  const beginTask = async (task: MaintenanceTask) => {
    if (blocked || !permission.canCreate || !plans.snapshot?.permissions.canUpdate) return;
    setError(""); plans.setError("");
    if (pendingLink && pendingLink.taskId !== task.id) { setError("还有一条已保存的记录等待关联计划，请先完成列表中的该任务。"); return; }
    const resumed = pendingLink?.taskId === task.id ? pendingLink.completion : null;
    if (!resumed && task.targetUnavailable) { setError(task.targetUnavailableReason || "维护对象已不在当前场地，请调整计划。"); return; }
    if (!resumed && task.dueDate > maintenanceToday()) { setError("这项任务尚未到执行日期。"); return; }
    const next = task.status === "pending" && !resumed ? await plans.mutate("start_task", { taskId: task.id }) : plans.snapshot;
    if (!next) return;
    const current = next.tasks.find(item => item.id === task.id);
    if (!current || !isActiveMaintenanceTask(current)) { setError("任务已更新，请刷新待办列表。"); return; }
    const targetGroup = groups.find(group => group.id === (current.currentTankId || current.tankId));
    const fish = state.stock.find(item => item.id === current.stockItemId);
    const targetSub = targetGroup?.subTanks.find(sub => sub.id === (current.currentSubTankId || fish?.subTankId));
    if (!resumed && (!targetGroup || current.targetType === "fish" && (!fish || !targetSub || !isPhysicallyInTank(fish, outIds)))) { setError("鱼只或缸位已变化，请刷新页面后重新核对。"); return; }
    setGroupId(targetGroup?.id || ""); setSubId(targetSub?.id || ""); setActiveTask(current); setTaskCompletion(resumed);
    const nextDraft = { ...freshDraft(current.targetType === "fish" ? "fish" : "group", current.stockItemId || ""), kind: maintenanceRecordAction(current.type, current.targetType || "group") };
    setDraft(nextDraft); move(resumed ? "taskResult" : current.type === "measurement" ? "waterParameter" : "form");
  };
  const finishTask = async (completion: MaintenanceCompletion, task = activeTask) => {
    if (!task) return false;
    const result = await plans.mutate("complete_task", { taskId: task.id, completion });
    if (!result) return false;
    setPendingLink(null); setTaskCompletion(null); setActiveTask(null); try { sessionStorage.removeItem(taskStorageKey); } catch {}
    setDraft(freshDraft()); setHistoryVersion(value => value + 1); move("tasks"); toast.success("维护记录已保存，任务已完成。"); return true;
  };

  const validate = () => {
    if (!permission.canCreate) return "没有添加维护记录的权限。";
    if (activeTask) {
      const current = plans.snapshot?.tasks.find(task => task.id === activeTask.id);
      if (!current || !isActiveMaintenanceTask(current) || current.targetUnavailable || (!permission.isAdmin && current.assignedTo !== state.user?.username)) return "任务或维护对象已变化，请返回待办重新核对。";
    }
    if (!group || (draft.scope !== "group" && !sub)) return "缸位已发生变化，请重新选择。";
    if (draft.scope === "fish" && !selectedFish) return "这条鱼已离开当前子缸，请返回重新选鱼。";
    if (!draft.kind) return "请选择记录类型。";
    if (!draft.date || !Number.isFinite(Date.parse(draft.date))) return "请选择记录时间。";
    if (isWaterDraft) {
      if (!waterParameter) return "请选择水质参数；配置可能已更新。";
      const parsed = parseMobileWaterValue(draft.waterValue);
      if (parsed.error) return parsed.error;
      if (!waterMeasurement) return "数值过大，请核对测量结果。";
      if (draft.waterMethod && !waterParameter.testMethods?.includes(draft.waterMethod)) return "测试方法配置已更新，请重新选择。";
      return "";
    }
    if (draft.scope === "group" && draft.kind === "下药" && !draft.medicine.trim()) return "请填写实际药品及用量。";
    if (draft.kind === "拍照／视频" && !draft.photos.length && !draft.videos.length) return "请先添加照片或视频。";
    if (draft.kind !== "拍照／视频" && !draft.text.trim()) return "请填写本次观察、治疗或维护的实际情况。";
    return "";
  };
  const save = async () => {
    if (blocked || busyRef.current) return;
    const problem = validate(); if (problem) { setError(problem); return; }
    const session = captureNewCustomerSession(), captured = context;
    if (!session) { setError("登录已过期，请重新登录。"); return; }
    busyRef.current = true; setSaving(true); setError("");
    try {
      if (isWaterDraft && waterMeasurement) {
        const ok = await saveWaterQualityRecord({ createOnly: true, record: { id: draft.id, siteId: activeSiteId, tankGroupId: groupId, scope: "group",
          measuredAt: mobileWaterTimestamp(draft.date), values: [waterMeasurement], operator: "", notes: draft.text.trim(), photos: draft.photos, videos: draft.videos } });
        if (!ok) throw new Error("水质记录保存失败，数值和附件已保留，请重试。");
      } else if (draft.scope === "group") {
        const ok = await saveDailyLog({ createOnly: true, log: { id: draft.id, siteId: activeSiteId, date: draft.date, tankGroupId: groupId, scope: "group" as const, action: draft.kind, operator: "", notes: draftText, photos: draft.photos, videos: draft.videos } });
        if (!ok) throw new Error("维护记录保存失败，内容已保留，请重试。");
      } else {
        const result = await saveBioRecordChange({ action: "create", stockItemId: draft.fishId, expectedSubTankId: subId, record: { id: draft.id, stockItemId: draft.fishId, date: draft.date, text: draftText, photos: draft.photos, videos: draft.videos } });
        if (!result.ok) throw new Error(result.error || "鱼只记录保存失败，内容已保留，请重试。");
      }
      if (!alive.current || contextRef.current !== captured || !isNewCustomerSessionCurrent(session)) return;
      if (activeTask) {
        const completion: MaintenanceCompletion = { kind: isWaterDraft ? "waterQualityRecord" : draft.scope === "fish" ? "bioRecord" : "dailyLog", recordId: draft.id };
        setTaskCompletion(completion); setPendingLink({ taskId: activeTask.id, completion });
        try { sessionStorage.setItem(taskStorageKey, JSON.stringify({ taskId: activeTask.id, completion })); } catch {}
        move("taskResult"); await finishTask(completion); return;
      }
      setDraft(freshDraft()); setHistoryAll(false); setHistoryVersion(value => value + 1); move(draft.scope === "group" ? "groupAction" : "action"); toast.success("记录已保存，可以继续维护。");
    } catch (cause) {
      if (alive.current && contextRef.current === captured && isNewCustomerSessionCurrent(session)) setError(cause instanceof Error ? cause.message : "保存失败，内容已保留。");
    } finally { if (alive.current && contextRef.current === captured) { busyRef.current = false; setSaving(false); } }
  };

  const currentStrip = <div className="mm-location-strip"><MapPin aria-hidden="true" /><span>{siteName(state, activeSiteId)} · {step === "sub" ? group?.name : draftLocation || group?.name}</span></div>;
  const identity = selectedFish ? <div className="mm-fish-identity"><span>当前鱼只</span><strong>{product(selectedFish)?.name || "未命名商品"}</strong><p>{selectedFish.code ? `编号 ${selectedFish.code}` : `库存编号 ${selectedFish.id}`} · {product(selectedFish)?.size || "规格未填"}</p></div> : <p role="alert" className="mm-error">这条鱼已离开当前子缸，请返回重新选择。</p>;
  const attachmentPreview = (photos: string[], videos: string[]) => <div className="mm-attachments">{photos.map((src, index) => <MediaPreviewTrigger key={`p:${index}`} src={src} title={`照片 ${index + 1}`} ariaLabel={`预览照片 ${index + 1}`} allowDownload={false}><ImageWithFallback src={src} alt={`照片 ${index + 1}`} className="size-24 object-cover" /></MediaPreviewTrigger>)}{videos.map((src, index) => <MediaPreviewTrigger key={`v:${index}`} src={src} mediaType="video" title={`视频 ${index + 1}`} ariaLabel={`预览视频 ${index + 1}`} allowDownload={false} className="mm-video-preview"><Camera /><span>视频 {index + 1}</span></MediaPreviewTrigger>)}</div>;
  const historyRows = <>{historyLoading ? <p role="status" className="mm-empty">正在读取你的记录…</p> : historyError ? <div role="alert" className="mm-empty"><p>{historyError}</p><Button variant="outline" onClick={() => setHistoryVersion(value => value + 1)}>重新加载</Button></div> : history.length ? <><div className="mm-history-list">{history.map(record => <button key={record.id} className="mm-history-row" onClick={() => { setDetail(record); setReturnStep(step || "action"); move("detail"); }}><span className="mm-history-icon">{record.kind === "fish" ? <Fish /> : record.kind === "water" ? <FlaskConical /> : <ClipboardList />}</span><span><strong>{record.title}</strong>{record.waterValues && <small>{record.waterValues.map(value => `${mobileWaterDisplayValue(value.value, value.precision)} ${value.unit}${value.testMethod ? ` · ${value.testMethod}` : ""}`).join("；")}</small>}<small>{record.kind === "fish" ? record.fishLabel : record.location}</small>{record.sourceLocation && <small>{record.inherited ? "来源：" : "原登记位置："}{record.sourceLocation}</small>}<small>{formatBioRecordTime(record.date)}</small></span><ChevronRight /></button>)}</div>{historyTruncated && <p className="mm-note">这里只显示最近 30 条记录。</p>}</> : <p className="mm-empty">这里还没有你的记录。完成维护后，记录会出现在这里。</p>}</>;

  let title = "选择子缸", progress = "", content: ReactNode = null, footer: ReactNode = null;
  if (step === "tasks") {
    title = "待办计划";
    content = <><h2>{siteName(state, activeSiteId)} · 我的待办</h2><p className="mm-lead">选择任务，记录实际完成情况。未指派任务可由你接手。</p>{plans.error && <p className="mm-error" role="alert">{plans.error}</p>}<Button variant="outline" disabled={plans.loading || plans.saving} onClick={() => void plans.refresh()}><RefreshCw />刷新待办</Button>{pendingLink && <aside className="mm-task-context"><strong>有一条已保存的记录等待关联</strong><p>请重试完成原任务。若任务已取消、变更或无法继续，可保留记录并解除这次关联。</p><Button variant="outline" disabled={blocked} onClick={() => move("taskUnlink")}>记录已保存，解除任务关联</Button></aside>}{plans.loading && !plans.snapshot ? <p className="mm-empty">正在读取待办…</p> : <div className="mm-task-list">{pendingTasks.map(task => <article key={task.id}><div><strong>{task.title}</strong><p>{task.targetType === "fish" ? `${task.productName || "鱼只"} · ${task.fishCode || task.stockItemId}` : task.tankName} · {maintenanceOperationLabel(task.type, task.targetType || "group")}</p><small>{task.dueDate} {task.dueTime} · {task.assignedTo ? plans.snapshot?.assignees?.find(person => person.username === task.assignedTo)?.name || task.assignedTo : "待接手"}</small>{task.notes && <p className="mm-task-notes">{task.notes}</p>}{task.targetUnavailable && <p className="mm-error">{task.targetUnavailableReason}</p>}</div><Button disabled={blocked || !permission.canCreate || !plans.snapshot?.permissions.canUpdate || (pendingLink?.taskId !== task.id && (task.targetUnavailable || task.dueDate > maintenanceToday()))} onClick={() => void beginTask(task)}>{pendingLink?.taskId === task.id ? "记录已保存，重试完成" : task.status === "in_progress" ? "继续记录" : task.dueDate > maintenanceToday() ? "未到执行日期" : "开始执行"}</Button></article>)}</div>}{!plans.loading && !pendingTasks.length && <p className="mm-empty">目前没有你的待办计划。</p>}</>;
  } else if (step === "taskUnlink") {
    title = "解除本次任务关联";
    content = <><h2>保留记录，解除关联？</h2><p className="mm-lead">已经保存的维护记录仍可在“我的维护记录”查看。本操作只解除本机待重试的关联，不删除记录，也不把任务标记为完成。</p></>;
    footer = <div className="mm-actions"><Button className="mm-next" onClick={() => move("tasks")}>返回继续核对</Button><Button variant="outline" className="mm-next" onClick={() => { setPendingLink(null); setTaskCompletion(null); setActiveTask(null); setDraft(freshDraft()); try { sessionStorage.removeItem(taskStorageKey); } catch {} move("tasks"); }}>保留记录，解除关联</Button></div>;
  } else if (step === "taskResult") {
    title = "维护记录已保存";
    content = <div className="mm-loss-success"><CheckCircle2 /><h2>记录已保存</h2><p>正在将本次记录关联到“{activeTask?.title}”。重试只完成计划，不会再次保存维护记录。</p>{plans.error && <p className="mm-error" role="alert">{plans.error}</p>}</div>;
    footer = <Button className="mm-next" disabled={blocked || !taskCompletion} onClick={() => { if (taskCompletion) void finishTask(taskCompletion); }}>{plans.saving ? "正在完成任务…" : "重试完成任务"}</Button>;
  } else if (step === "lossList") {
    title = "选择报损鱼只"; progress = "1 / 3";
    content = <>{currentStrip}<h2>哪些鱼需要报损？</h2><p className="mm-lead">只选择 {sub?.name} 已损耗的鱼，可选一条或多条。</p><label className="mm-search"><Search /><Input aria-label="搜索报损鱼只" value={fishSearch} onChange={event => setFishSearch(event.target.value)} placeholder="输入鱼只编号或商品名" /></label><p className="mm-selection-count">已选 {lossDraft.selectedIds.length} 条</p>{lossDraft.photos.length > 0 && <p className="mm-note">更改选鱼后，需要重新拍摄这次报损的照片。</p>}<div className="mm-fish-list mm-loss-pick">{visibleFish.map(item => <button key={item.id} aria-pressed={lossDraft.selectedIds.includes(item.id)} onClick={() => setLossDraft(current => ({ ...current, selectedIds: current.selectedIds.includes(item.id) ? current.selectedIds.filter(id => id !== item.id) : [...current.selectedIds, item.id] }))}><span className="mm-fish-icon">{product(item)?.imageUrl ? <ImageWithFallback src={product(item)!.imageUrl} alt="" className="size-12 object-cover" /> : <Fish />}</span><span><strong>{product(item)?.name || "鱼只"}</strong><small>{item.code ? `编号 ${item.code}` : `库存 ${item.id}`}</small></span><span className="mm-check" aria-hidden="true">{lossDraft.selectedIds.includes(item.id) && <Check />}</span></button>)}</div>{!visibleFish.length && <p className="mm-empty">没有可选鱼只。已出库、移缸在途和已报损的鱼不在此列表。</p>}</>;
    footer = <Button className="mm-next" disabled={blocked || !lossDraft.selectedIds.length} onClick={prepareLossPhotos}>下一步：拍照</Button>;
  } else if (step === "lossPhoto") {
    title = "拍摄报损照片"; progress = "2 / 3";
    content = <>{currentStrip}<h2>给这 {lossDraft.items.length} 条鱼拍照</h2><p className="mm-lead">照片必填，请拍清楚本次报损的鱼。</p><details className="mm-loss-selected"><summary>查看已选鱼只 · {lossDraft.items.length} 条<ChevronRight /></summary><ul>{lossDraft.items.map(item => <li key={item.expected.id}>{item.label}</li>)}</ul></details><MobileMaintenanceMedia key={lossDraft.id} photos={lossDraft.photos} videos={[]} photosOnly onChange={value => { setLossDraft(current => ({ ...current, photos: value.photos })); setError(""); }} onBusyChange={setUploading} disabled={saving} /><label className="mm-field mm-loss-date"><span>损耗日期</span><Input type="date" aria-label="损耗日期" value={lossDraft.date} max={nowDatetimeLocal().slice(0, 10)} disabled={blocked} onChange={event => setLossDraft(current => ({ ...current, date: event.target.value }))} /></label><label className="mm-field"><span>原因 <small>选填，可事后补</small></span><Textarea aria-label="损耗原因" maxLength={2000} value={lossDraft.reason} disabled={blocked} onChange={event => setLossDraft(current => ({ ...current, reason: event.target.value }))} placeholder="不确定原因可以先留空" /></label></>;
    footer = <Button className="mm-next" disabled={blocked} onClick={() => { const problem = mobileLossValidation(lossDraft.items, lossDraft.date, nowDatetimeLocal().slice(0, 10), lossDraft.photos); if (problem) { setError(problem); bodyRef.current?.scrollTo({ top: 0 }); } else move("lossConfirm"); }}>{uploading ? "照片上传中…" : "下一步：确认报损"}</Button>;
  } else if (step === "lossConfirm") {
    title = "确认报损"; progress = "3 / 3";
    content = <><h2>确认报损 {lossDraft.items.length} 条？</h2><p className="mm-lead">保存后，这些鱼将从在缸库存中扣除。</p><dl className="mm-summary"><div><dt>缸位</dt><dd>{siteName(state, activeSiteId)} · {location}</dd></div><div><dt>鱼只</dt><dd>{lossDraft.items.map(item => item.label).join("\n")}</dd></div><div><dt>损耗日期</dt><dd>{lossDraft.date}</dd></div><div><dt>原因</dt><dd>{lossDraft.reason.trim() || "待补原因（可以先报损）"}</dd></div><div><dt>凭证照片</dt><dd>{lossDraft.photos.length} 张</dd></div><div><dt>记录人</dt><dd>{displayName}</dd></div></dl>{attachmentPreview(lossDraft.photos, [])}{lossDraft.orderNos.length > 0 && <p className="mm-loss-warning">涉及订单 {lossDraft.orderNos.join("、")}，请在订单页面另行处理；本次不会自动退款或退鱼。</p>}{lossAttempt.current && <p className="mm-note">重试会核对同一次报损，不会重复扣库存。</p>}</>;
    footer = <Button className="mm-next" variant="destructive" disabled={blocked} onClick={() => void submitLoss()}>{saving ? "正在保存…" : lossAttempt.current ? "重试确认保存结果" : `确认报损 ${lossDraft.items.length} 条`}</Button>;
  } else if (step === "lossResult") {
    title = "报损已保存";
    content = <div className="mm-loss-success"><CheckCircle2 /><h2>已报损 {lossDraft.items.length} 条</h2><p>库存已扣减，{lossDraft.photos.length} 张照片已保存在报损记录中。</p>{!lossDraft.reason.trim() && <p>原因尚未填写，之后可在“我的报损”里补充。</p>}{lossDraft.orderNos.length > 0 && <p className="mm-loss-warning">关联订单 {lossDraft.orderNos.join("、")} 需在订单页面另行处理。</p>}</div>;
    footer = <div className="mm-actions"><Button className="mm-next" onClick={startLoss}>继续报损这个子缸</Button><Button variant="outline" className="mm-next" onClick={() => openLossHistory(!lossDraft.reason.trim())}>查看我的报损</Button></div>;
  } else if (step === "lossHistory") {
    title = "我的报损";
    content = <><h2>{siteName(state, activeSiteId)} · 我的报损</h2><p className="mm-lead">鱼已损耗后，照片和记录仍可在这里查看。</p><div className="mm-loss-tabs"><button aria-pressed={!lossHistoryMissing} onClick={() => setLossHistoryMissing(false)}>全部报损</button><button aria-pressed={lossHistoryMissing} onClick={() => setLossHistoryMissing(true)}>待补原因</button></div>{historyLoading ? <p role="status" className="mm-empty">正在读取报损记录…</p> : historyError ? <div className="mm-empty"><p role="alert">{historyError}</p><Button variant="outline" onClick={() => setHistoryVersion(value => value + 1)}>重新加载</Button></div> : lossRows.length ? <><div className="mm-history-list">{lossRows.map(record => <button key={record.id} className="mm-history-row" onClick={() => { setLossDetail(record); move("lossDetail"); }}><span className="mm-history-icon"><AlertTriangle /></span><span><strong>{lossLabel(record)}</strong><small>{lossLocation(record)}</small><small>{record.date.slice(0, 10)} · {record.proofPhotos?.length || 0} 张照片</small><small>{record.reason?.trim() ? record.reason : "待补原因"}</small></span><ChevronRight /></button>)}</div>{historyTruncated && <p className="mm-note">这里只显示最近 100 条，请使用“待补原因”查看尚未补充的记录。</p>}</> : <p className="mm-empty">{lossHistoryMissing ? "没有待补原因的报损。" : "还没有你的报损记录。"}</p>}</>;
  } else if (step === "lossDetail" && lossDetail) {
    title = "报损记录";
    content = <><h2>{lossLabel(lossDetail)}</h2><dl className="mm-summary"><div><dt>损耗日期</dt><dd>{lossDetail.date.slice(0, 10)}</dd></div><div><dt>缸位</dt><dd>{lossLocation(lossDetail)}</dd></div><div><dt>记录人</dt><dd>{operatorLabel(lossDetail.operator)}</dd></div><div><dt>原因</dt><dd>{lossDetail.reason?.trim() || "待补原因"}</dd></div>{lossDetail.reasonUpdatedAt && <div><dt>原因更新</dt><dd>{operatorLabel(lossDetail.reasonUpdatedBy || "")} · {formatBioRecordTime(mobileMaintenanceHistoryTime(lossDetail.reasonUpdatedAt))}</dd></div>}</dl>{attachmentPreview(lossDetail.proofPhotos || [], [])}{!lossDetail.proofPhotos?.length && <p className="mm-note">这条历史报损没有照片。</p>}</>;
    footer = (permission.canUpdate || lossPermission.canUpdate) ? <Button className="mm-next" onClick={() => { setReasonText(lossDetail.reason || ""); move("lossReason"); }}>{lossDetail.reason?.trim() ? "修改原因" : "补充原因"}</Button> : null;
  } else if (step === "lossReason" && lossDetail) {
    title = "补充损耗原因";
    content = <><h2>{lossLabel(lossDetail)}</h2><p className="mm-lead">补充原因只更新记录，不会再次扣库存。</p><label className="mm-field"><span>损耗原因</span><Textarea aria-label="补充损耗原因" maxLength={2000} value={reasonText} disabled={blocked} onChange={event => setReasonText(event.target.value)} placeholder="填写核实后的原因" /></label></>;
    footer = <Button className="mm-next" disabled={blocked} onClick={() => void submitLossReason()}>{saving ? "正在保存…" : "保存原因"}</Button>;
  } else if (step === "groupAction") {
    title = "当前缸组"; content = <><div className="mm-location-focus mm-group-focus"><span>{siteName(state, activeSiteId)} · 整个缸组</span><strong>{group?.name || "缸组已移除"}</strong><button onClick={() => move(null)}>更换缸组</button></div><h2>这次做什么？</h2><p className="mm-lead">缸维护记录整个缸组；拍摄或治疗某条鱼，请选单鱼。</p><div className="mm-actions">
      <button className="mm-action primary" disabled={!permission.canCreate || !group} onClick={() => { setSubId(""); setDraft(freshDraft("group")); move("tankType"); }}><ClipboardList /><span><strong>记录缸组维护</strong><small>喂食、换水、观察、水质、下药</small></span><ChevronRight /></button>
      <button className="mm-action" disabled={!permission.canCreate || !group} onClick={() => { setSubId(""); setDraft(freshDraft("fish")); move("sub"); }}><Fish /><span><strong>记录单鱼 / 拍照视频</strong><small>先选子缸定位，再选具体鱼只</small></span><ChevronRight /></button>
      {canReportLoss && <button className="mm-action mm-loss-entry" onClick={() => { setSubId(""); setDraft(freshDraft()); move("sub"); }}><AlertTriangle /><span><strong>报损</strong><small>先选子缸，再选鱼和拍照</small></span><ChevronRight /></button>}
    </div><div className="mm-section-title"><h3>我在这个缸组的记录</h3><button aria-label="刷新我的维护记录" onClick={() => setHistoryVersion(value => value + 1)}><RefreshCw /></button></div>{historyRows}</>;
  } else if (step === "sub") {
    content = <>{currentStrip}<h2>鱼在哪个子缸？</h2><p className="mm-lead">子缸仅用来定位鱼，缸维护统一记录在缸组。</p><div className="mm-sub-grid">{group?.subTanks.map(tank => <button key={tank.id} onClick={() => { setSubId(tank.id); setHistoryAll(false); setFishSearch(""); if (draft.scope === "fish") move("fishList"); else { setLossDraft(freshLossDraft()); move("lossList"); } }}><strong>{tank.name}</strong><span>{state.stock.filter(item => item.subTankId === tank.id && isPhysicallyInTank(item, outIds)).length} 条在缸鱼</span></button>)}</div>{!group?.subTanks.length && <p className="mm-empty">这个缸组还没有子缸，请先在缸组管理中配置。</p>}</>;
  } else if (step === "action") {
    title = "当前缸位"; content = <>{currentStrip}<h2>继续记录</h2><div className="mm-actions"><button className="mm-action" onClick={() => { setDraft(freshDraft("fish")); setFishSearch(""); move("fishList"); }}><Fish /><span><strong>记录单鱼 / 拍照视频</strong><small>{sub?.name}</small></span><ChevronRight /></button><button className="mm-action" onClick={() => { setSubId(""); setDraft(freshDraft()); move("tankType"); }}><ClipboardList /><span><strong>记录缸组维护</strong><small>{group?.name} · 整个缸组</small></span><ChevronRight /></button>{canReportLoss && <button className="mm-action mm-loss-entry" onClick={startLoss}><AlertTriangle /><span><strong>继续报损</strong><small>选鱼、拍照，原因可事后补</small></span><ChevronRight /></button>}</div></>;
  } else if (step === "tankType") {
    title = "缸组维护"; content = <>{currentStrip}<h2>给整个缸组记录什么？</h2><div className="mm-actions">{[...types, { label: "水质", Icon: FlaskConical }, { label: "下药", Icon: Droplets }].map(({ label, Icon }) => <button className="mm-action" key={label} onClick={() => { setSubId(""); setDraft({ ...freshDraft("group"), kind: label }); move(label === "水质" ? "waterParameter" : "form"); }}><Icon /><span><strong>{label === "水质" ? "测水质" : label === "下药" ? "水体下药" : label}</strong></span><ChevronRight /></button>)}</div></>;
  } else if (step === "waterParameter") {
    title = "选择水质参数"; progress = "1 / 3";
    content = <>{currentStrip}<h2>这次测了哪一项？</h2><p className="mm-lead">点选一个参数，再填写测量结果。</p>
      {draft.waterValue && <p className="mm-note">更换参数后，需要重新填写数值和测试方法。</p>}
      <div className="mm-water-parameters">{sortedWaterParameters.map(parameter => <button key={parameter.id} aria-pressed={draft.waterParameterId === parameter.id} onClick={() => {
        setDraft(current => ({ ...current, waterParameterId: parameter.id, ...(current.waterParameterId === parameter.id ? {} : { waterValue: "", waterMethod: "" }) })); move("waterForm");
      }}><span><strong>{parameter.name}</strong><small>{parameter.unit}{commonWaterIds.includes(parameter.id) ? " · 常用" : ""}</small></span><ChevronRight aria-hidden="true" /></button>)}</div>
      {!waterParameters.length && <p className="mm-empty">暂未配置水质参数，请联系管理员添加。</p>}</>;
  } else if (step === "waterForm") {
    title = "填写测量结果"; progress = "2 / 3";
    const parsedValue = parseMobileWaterValue(draft.waterValue);
    const roundedValue = waterParameter && parsedValue.value !== null ? mobileWaterDisplayValue(parsedValue.value, waterParameter.precision) : "";
    content = <>{currentStrip}<h2>{waterParameter?.name || "参数已移除"}</h2><p className="mm-lead">填写仪器或试剂读到的数值。</p>
      <div className="mm-field"><span>测量数值 <small>{waterParameter?.unit}</small></span><span className="mm-water-value-input"><button type="button" aria-label="切换数值正负号" disabled={blocked} onClick={() => setDraft(current => ({ ...current, waterValue: toggleMobileWaterValueSign(current.waterValue) }))}>±</button><Input aria-label="水质测量数值" type="text" inputMode="decimal" autoComplete="off" value={draft.waterValue} disabled={blocked || !waterParameter} onChange={event => { setDraft(current => ({ ...current, waterValue: event.target.value })); setError(""); }} placeholder="填写数值，0 也可记录" /><span>{waterParameter?.unit}</span></span></div>
      {waterParameter && parsedValue.value !== null && Number(roundedValue) !== parsedValue.value && <p className="mm-note">按当前精度将记录为 {roundedValue} {waterParameter.unit}（{waterParameter.precision} 位小数）。</p>}
      {(Boolean(waterParameter?.testMethods?.length) || Boolean(draft.waterMethod)) && <label className="mm-field"><span>测试方法 <small>选填</small></span><select aria-label="水质测试方法" className="mm-water-method" disabled={blocked} value={draft.waterMethod} onChange={event => setDraft(current => ({ ...current, waterMethod: event.target.value }))}><option value="">未选择</option>{draft.waterMethod && !waterParameter?.testMethods?.includes(draft.waterMethod) && <option value={draft.waterMethod} disabled>原方法已移除，请重新选择</option>}{(waterParameter?.testMethods || []).map(method => <option key={method} value={method}>{method}</option>)}</select></label>}
      <label className="mm-field"><span>测量时间</span><Input aria-label="水质测量时间" type="datetime-local" step="1" value={draft.date} disabled={blocked} onChange={event => setDraft(current => ({ ...current, date: event.target.value }))} /></label>
      <details className="mm-water-extra"><summary>添加备注、照片或视频 <span>选填</span><ChevronRight aria-hidden="true" /></summary><div><label className="mm-field"><span>备注</span><Textarea aria-label="水质备注" value={draft.text} maxLength={5000} disabled={blocked} onChange={event => setDraft(current => ({ ...current, text: event.target.value }))} placeholder="可记录测量情况" /></label><MobileMaintenanceMedia key={draft.id} photos={draft.photos} videos={draft.videos} onChange={value => setDraft(current => ({ ...current, ...value }))} onBusyChange={setUploading} disabled={saving} /></div></details></>;
    footer = <Button className="mm-next" disabled={blocked || !waterParameter} onClick={() => { const problem = validate(); if (problem) { setError(problem); bodyRef.current?.scrollTo({ top: 0 }); } else move("confirm"); }}>{uploading ? "附件上传中…" : "下一步：确认记录"}</Button>;
  } else if (step === "fishList") {
    title = "选择这个缸里的鱼"; content = <>{currentStrip}<h2>要记录哪条鱼？</h2><p className="mm-lead">这里只显示 {sub?.name} 当前在缸的鱼。</p><label className="mm-search"><Search /><Input aria-label="搜索当前子缸的鱼" value={fishSearch} onChange={event => setFishSearch(event.target.value)} placeholder="输入编号或商品名" /></label><div className="mm-fish-list">{visibleFish.map(item => <button key={item.id} onClick={() => { setDraft(freshDraft("fish", item.id)); move("fishAction"); }}><span className="mm-fish-icon">{product(item)?.imageUrl ? <ImageWithFallback src={product(item)!.imageUrl} alt="" className="size-12 object-cover" /> : <Fish />}</span><span><strong>{product(item)?.name || "未命名商品"}</strong><small>{item.code ? `编号 ${item.code}` : `库存 ${item.id}`} · {product(item)?.size || "规格未填"}</small></span><ChevronRight /></button>)}</div>{!tankFish.length ? <p className="mm-empty">这个子缸当前没有在缸鱼，仍然可以返回记录缸维护。</p> : !visibleFish.length && <p className="mm-empty">当前子缸没有匹配的鱼，请换一个编号或商品名。</p>}</>;
  } else if (step === "fishAction") {
    title = "单鱼记录"; content = <>{currentStrip}{identity}<h2>给这条鱼记录什么？</h2><div className="mm-actions">{[{ kind: "拍照／视频", Icon: Camera, note: "记录这条鱼的画面" }, { kind: "观察", Icon: Eye, note: "记录状态、摄食及其他情况" }, { kind: "治疗", Icon: ClipboardList, note: "记录实际治疗与用药，可附图片视频" }, { kind: "其他", Icon: MoreHorizontal, note: "记录这条鱼的其他情况" }].map(({ kind, Icon, note }) => <button className="mm-action" key={kind} disabled={!selectedFish} onClick={() => { setDraft(value => ({ ...value, kind })); move("form"); }}><Icon /><span><strong>{kind}</strong><small>{note}</small></span><ChevronRight /></button>)}</div></>;
  } else if (step === "form") {
    title = draft.scope === "group" ? `记录${draft.kind === "下药" ? "水体下药" : draft.kind}` : draft.scope === "fish" ? `单鱼${draft.kind}` : `记录${draft.kind}`; progress = draft.scope === "group" ? "1 / 2" : "2 / 3";
    content = <>{currentStrip}{draft.scope === "fish" && identity}{draft.scope === "group" && <p className="mm-lead">{draft.kind === "下药" ? "本次下药作用于整个缸组的共用水体。" : "本次维护记录整个缸组，不区分子缸。"}</p>}{draft.scope === "fish" && draft.kind === "治疗" && <p className="mm-note mm-scope-note">这里记录这条鱼的个体处理。向共用水体下药，请在缸组登记。</p>}<label className="mm-field"><span>记录时间</span><Input type="datetime-local" step="1" value={draft.date} disabled={blocked} onChange={event => setDraft(value => ({ ...value, date: event.target.value }))} /></label>{(draft.kind === "治疗" || draft.kind === "下药") && <label className="mm-field"><span>实际药品及用量 {draft.scope !== "group" && <small>选填</small>}</span><Input value={draft.medicine} maxLength={500} disabled={blocked} onChange={event => setDraft(value => ({ ...value, medicine: event.target.value }))} placeholder="填写实际使用的药品、用量" /></label>}<label className="mm-field"><span>{draft.kind === "拍照／视频" ? "补充说明" : draft.kind === "治疗" ? "治疗情况" : draft.kind === "下药" ? "下药记录" : "实际情况"}{draft.kind === "拍照／视频" && <small>选填</small>}</span><Textarea value={draft.text} maxLength={5000} disabled={blocked} onChange={event => setDraft(value => ({ ...value, text: event.target.value }))} placeholder={draft.kind === "治疗" ? "记录症状、处理过程和观察结果" : draft.kind === "下药" ? "填写本次下药原因、操作和观察情况" : "填写实际情况"} /></label><MobileMaintenanceMedia key={draft.id} photos={draft.photos} videos={draft.videos} onChange={value => setDraft(current => ({ ...current, ...value }))} onBusyChange={setUploading} disabled={saving} /></>;
    footer = <Button className="mm-next" disabled={blocked} onClick={() => { const problem = validate(); if (problem) { setError(problem); bodyRef.current?.scrollTo({ top: 0 }); } else move("confirm"); }}>{uploading ? "附件上传中…" : "下一步：确认记录"}</Button>;
  } else if (step === "confirm") {
    title = "确认记录"; progress = draft.scope === "group" && !isWaterDraft ? "2 / 2" : "3 / 3"; content = <><h2>核对一下，就完成了</h2><dl className="mm-summary"><div><dt>{draft.scope === "group" ? "作用范围" : "缸位"}</dt><dd>{siteName(state, activeSiteId)} · {draftLocation}</dd></div>{draft.scope === "fish" && <div><dt>鱼只</dt><dd>{fishLabel(selectedFish)}</dd></div>}<div><dt>类型</dt><dd>{draft.kind}</dd></div><div><dt>时间</dt><dd>{formatBioRecordTime(draft.date)}</dd></div><div><dt>记录人</dt><dd>{displayName}</dd></div>{isWaterDraft && waterMeasurement ? <><div><dt>参数</dt><dd>{waterMeasurement.parameterName}</dd></div><div><dt>测量结果</dt><dd className="mm-water-result">{mobileWaterDisplayValue(waterMeasurement.value, waterMeasurement.precision)} <span>{waterMeasurement.unit}</span></dd></div><div><dt>测试方法</dt><dd>{waterMeasurement.testMethod || "未填写"}</dd></div>{draft.text.trim() && <div><dt>备注</dt><dd>{draft.text.trim()}</dd></div>}</> : <div><dt>内容</dt><dd>{draftText || "照片／视频记录"}</dd></div>}</dl>{attachmentPreview(draft.photos, draft.videos)}<p className="mm-note">{isWaterDraft ? "保存为整个缸组的水质记录，所有子缸共用这一水体。" : draft.scope === "group" ? "保存为整个缸组的维护记录，不仅限于某个子缸。" : draft.scope === "fish" ? "保存后进入这条鱼的维护历史。" : "保存为整个缸组的维护记录。"}</p></>;
    footer = <Button className="mm-next" disabled={blocked} onClick={() => void save()}>{saving ? "正在保存…" : "保存记录"}</Button>;
  } else if (step === "history") {
    title = "我的维护记录"; content = <><h2>{historyAll ? `${siteName(state, activeSiteId)} · 我的记录` : location}</h2><p className="mm-lead">只显示由你登记的缸维护、水质和单鱼记录。</p>{historyRows}</>;
  } else if (step === "detail" && detail) {
    title = "记录详情"; content = <><h2>{detail.title}</h2><p className="mm-lead">{detail.fishLabel || detail.location}</p><dl className="mm-summary"><div><dt>记录时间</dt><dd>{formatBioRecordTime(detail.date)}</dd></div><div><dt>记录人</dt><dd>{operatorLabel(detail.operator)}</dd></div><div><dt>{detail.kind === "water" ? "作用范围" : "缸位"}</dt><dd>{detail.location}</dd></div>{detail.sourceLocation && <div><dt>{detail.inherited ? "记录来源" : "原登记位置"}</dt><dd>{detail.sourceLocation}{!detail.inherited && "（仅保留历史录入位置）"}</dd></div>}{detail.waterValues?.map((value, index) => <div key={`${value.parameterId}:${index}`}><dt>{value.parameterName}</dt><dd><strong className="mm-water-result">{mobileWaterDisplayValue(value.value, value.precision)} <span>{value.unit}</span></strong><small className="mm-water-method-note">测试方法：{value.testMethod || "未填写"}</small></dd></div>)}{(!detail.waterValues || detail.text) && <div><dt>{detail.waterValues ? "备注" : "内容"}</dt><dd>{detail.text || "照片／视频记录"}</dd></div>}</dl>{attachmentPreview(detail.photos, detail.videos)}</>;
  } else if (step === "discard") {
    title = "退出这次记录"; content = <div className="mm-discard"><ClipboardList /><h2>记录还没有保存</h2><p>继续填写，或放弃这次内容。已保存的记录不会受影响。</p></div>; footer = <div className="mm-actions"><Button className="mm-next" onClick={() => move(returnStep)}>继续填写</Button><Button variant="ghost" className="min-h-12 text-destructive" onClick={() => { resetDrafts(); move(discardTo); }}>放弃这次记录</Button></div>;
  }

  if (!canRead) return <p className="mm-empty">当前账号没有维护操作权限，请联系管理员。</p>;
  if (activeSiteId === "all") return <p className="mm-empty">请先在顶部选择你所在的场地，再选择缸位。</p>;
  return <section className="mobile-maintenance" aria-label="手机维护工作台"><div className="mm-intro"><h2>你在哪个缸？</h2><p>先选缸组，再选择维护内容。</p><span>{displayName} · {siteName(state, activeSiteId)}</span></div><Button variant="outline" className="mm-my-history mm-task-entry" onClick={() => { plans.setError(""); void plans.refresh(); move("tasks"); }}><ClipboardList />待办计划{pendingTasks.length ? ` · ${pendingTasks.length}` : ""}<ChevronRight /></Button><label className="mm-search"><Search /><Input aria-label="搜索缸号" placeholder="输入缸号" value={groupSearch} onChange={event => setGroupSearch(event.target.value)} /></label><div className="mm-tank-list">{groups.filter(value => value.name.toLowerCase().includes(groupSearch.trim().toLowerCase())).map(value => <button key={value.id} onClick={() => { setGroupId(value.id); setSubId(""); setDraft(freshDraft()); move("groupAction"); }}><span className="mm-tank-icon"><Droplets /></span><span><strong>{value.name}</strong><small>{value.subTanks.length} 个子缸</small></span><ChevronRight /></button>)}</div>{!groups.length && <p className="mm-empty">当前场地还没有缸组，请先配置缸位。</p>}<Button variant="ghost" className="mm-my-history" onClick={() => { setHistoryAll(true); move("history"); }}><ClipboardList />查看我的维护记录<ChevronRight /></Button>
    <Button variant="outline" className="mm-my-history" onClick={() => openLossHistory(false)}><AlertTriangle />我的报损 / 待补原因<ChevronRight /></Button>
    <Dialog open={step !== null} onOpenChange={open => { if (!open) close(); }}><DialogContent className="mobile-maintenance-dialog" onEscapeKeyDown={event => { event.preventDefault(); close(); }} onInteractOutside={event => event.preventDefault()}><header className="mm-dialog-head" data-no-dialog-drag><button aria-label="返回上一步" disabled={blocked} onClick={back}><ArrowLeft /></button><div><DialogTitle>{title}</DialogTitle>{progress && <span>{progress}</span>}</div><button aria-label="关闭维护记录" disabled={blocked} onClick={close}><X /></button></header><DialogDescription className="sr-only">先选择缸组和操作。缸维护记录整个缸组，单鱼维护再选择子缸定位鱼只。</DialogDescription><div className="mm-dialog-body" ref={bodyRef}>{error && <p role="alert" className="mm-error">{error}</p>}{activeTask && step !== "taskResult" && <aside className="mm-task-context"><strong>正在执行：{activeTask.title}</strong>{activeTask.notes && <p>{activeTask.notes}</p>}<small>请填写实际情况，保存后完成此任务。</small></aside>}{content}</div>{footer && <footer className="mm-dialog-footer">{footer}</footer>}</DialogContent></Dialog>
  </section>;
}
