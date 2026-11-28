import { useEffect, useMemo, useRef, useState } from "react";
import {
  DailyLog,
  normalizeWaterQualityParameters,
  uid,
  useStore,
  waterQualityParameterIdsForGroup,
  WaterQualityMeasurement,
  WaterQualityRecord,
  WaterQualityParameterSetting,
} from "../store";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { ClipboardList, FlaskConical, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatBioRecordTime, isoToDatetimeLocal, normalizeBioRecordTime, nowDatetimeLocal } from "../utils/localDateTime";
import { PreciseDateTimeInput } from "./PreciseDateTimeInput";
import { captureNewCustomerSession, isNewCustomerSessionCurrent } from "../utils/newCustomerEvidence";
import { MediaPreviewTrigger } from "./MediaPreviewDialog";

type WaterRecordDraft = {
  id: string;
  newId?: string;
  original?: WaterQualityRecord;
  tankGroupId: string;
  measuredAt: string;
  values: Record<string, string>;
  methods: Record<string, string>;
  notes: string;
};

type WaterQualityRecordsPanelProps = {
  maintenanceLogs?: DailyLog[];
  groupFilter?: string;
  onGroupFilterChange?: (groupId: string) => void;
  getMaintenanceGroupId?: (log: DailyLog) => string;
  onCreateMaintenance?: (groupId: string) => void;
  onEditMaintenance?: (log: DailyLog) => void;
  onDeleteMaintenance?: (log: DailyLog) => void;
  maintenanceSaving?: boolean;
  viewMode?: "page" | "tank";
};

type UnifiedTankRecord =
  | { kind: "maintenance"; id: string; tankGroupId: string; timestamp: number; log: DailyLog }
  | { kind: "water"; id: string; tankGroupId: string; timestamp: number; record: WaterQualityRecord };

function localDate(value: string) {
  return isoToDatetimeLocal(value).slice(0, 10);
}

function formatMeasuredAt(value: string) {
  const local = isoToDatetimeLocal(value);
  return local ? local.replace("T", " ") : "—";
}

export function formatMeasurement(measurement: WaterQualityMeasurement) {
  const precision = Math.max(0, Math.min(4, Math.trunc(Number(measurement.precision ?? 0))));
  const value = Number(measurement.value);
  return `${measurement.parameterName || measurement.parameterId} ${Number.isFinite(value) ? value.toFixed(precision) : "—"} ${measurement.unit}${measurement.testMethod ? ` · ${measurement.testMethod}` : ""}`;
}

/** A renamed or deleted setting must never overwrite a historical measurement. */
export function waterQualityDraftParameters(parameters: WaterQualityParameterSetting[], configuredIds: string[], record?: WaterQualityRecord) {
  const configured = new Map(parameters.map(parameter => [parameter.id, parameter]));
  const history = new Map((record?.values ?? []).map(measurement => [measurement.parameterId, measurement]));
  return [...new Set([...configuredIds, ...history.keys()])].flatMap(id => {
    const current = configured.get(id), previous = history.get(id);
    if (!previous) return current ? [current] : [];
    return [{ id, name: previous.parameterName, unit: previous.unit, precision: previous.precision,
      testMethods: [...new Set([...(current?.testMethods ?? []), ...(previous.testMethod ? [previous.testMethod] : [])])] }];
  });
}

function WaterRecordMedia({ record }: { record: WaterQualityRecord }) {
  if (!record.photos?.length && !record.videos?.length) return null;
  return <div className="mt-2 flex flex-wrap gap-2">{(record.photos ?? []).map((src, index) => <MediaPreviewTrigger key={`photo-${src}`} src={src} mediaType="image" title="水质记录照片" ariaLabel={`预览水质照片 ${index + 1}`} className="inline-flex min-h-11 items-center rounded-md border px-3 text-xs">照片 {index + 1}</MediaPreviewTrigger>)}{(record.videos ?? []).map((src, index) => <MediaPreviewTrigger key={`video-${src}`} src={src} mediaType="video" title="水质记录视频" ariaLabel={`预览水质视频 ${index + 1}`} className="inline-flex min-h-11 items-center rounded-md border px-3 text-xs">视频 {index + 1}</MediaPreviewTrigger>)}</div>;
}

export function WaterQualityRecordsPanel({
  maintenanceLogs = [],
  groupFilter: controlledGroupFilter,
  onGroupFilterChange,
  getMaintenanceGroupId = (log) => log.tankGroupId ?? "",
  onCreateMaintenance,
  onEditMaintenance,
  onDeleteMaintenance,
  maintenanceSaving = false,
  viewMode = "page",
}: WaterQualityRecordsPanelProps = {}) {
  const { state, activeSiteId, saveWaterQualityRecord } = useStore();
  const context = `${activeSiteId}:${state.user?.username || ""}:${state.user?.role || ""}:${captureNewCustomerSession()?.key || ""}`;
  const currentContext = useRef(context); currentContext.current = context;
  const viewer = useRef(state.user); viewer.current = state.user;
  const mounted = useRef(true);
  const saveLock = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const permission = usePermission("daily");
  const parameters = useMemo(
    () => normalizeWaterQualityParameters(state.systemSettings),
    [state.systemSettings]
  );
  const [internalGroupFilter, setInternalGroupFilter] = useState("all");
  const groupFilter = controlledGroupFilter ?? internalGroupFilter;
  const setGroupFilter = (groupId: string) => {
    onGroupFilterChange?.(groupId);
    if (controlledGroupFilter === undefined) setInternalGroupFilter(groupId);
  };
  const [recordTypeFilter, setRecordTypeFilter] = useState<"all" | "maintenance" | "water">("all");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState<WaterRecordDraft | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(null); setDialogOpen(false); }, [context]);
  const today = nowDatetimeLocal().slice(0, 10);
  const now = nowDatetimeLocal();

  const groupById = useMemo(
    () => new Map(state.tankGroups.map((group) => [group.id, group])),
    [state.tankGroups]
  );
  const recordScope = (record: Pick<WaterQualityRecord, "tankGroupId" | "subTankId" | "recordedFromSubTankId">) => {
    const group = groupById.get(record.tankGroupId);
    const sourceId = record.recordedFromSubTankId || record.subTankId;
    const source = sourceId ? group?.subTanks.find(tank => tank.id === sourceId)?.name || "已删除子缸" : "";
    return `${group?.name ?? "已删除缸组"} / 共用水体${source ? `（原登记位置：${source}）` : ""}`;
  };
  const filteredRecords = useMemo<UnifiedTankRecord[]>(() => {
    const waterRecords: UnifiedTankRecord[] = state.waterQualityRecords.map((record) => ({
      kind: "water",
      id: record.id,
      tankGroupId: record.tankGroupId,
      timestamp: Date.parse(record.measuredAt) || 0,
      record,
    }));
    const logRecords: UnifiedTankRecord[] = maintenanceLogs.flatMap((log) => {
      const tankGroupId = getMaintenanceGroupId(log);
      if (!tankGroupId) return [];
      return [{
        kind: "maintenance" as const,
        id: log.id,
        tankGroupId,
        timestamp: Date.parse(normalizeBioRecordTime(log.date)) || 0,
        log,
      }];
    });
    return [...waterRecords, ...logRecords]
      .filter((item) => {
        if (groupFilter !== "all" && item.tankGroupId !== groupFilter) return false;
        if (recordTypeFilter !== "all" && item.kind !== recordTypeFilter) return false;
        const date = item.kind === "water"
          ? localDate(item.record.measuredAt)
          : normalizeBioRecordTime(item.log.date).slice(0, 10);
        if (startDate && date < startDate) return false;
        if (endDate && date > endDate) return false;
        return true;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [state.waterQualityRecords, maintenanceLogs, getMaintenanceGroupId, groupFilter, recordTypeFilter, startDate, endDate]);

  const draftParameters = useMemo(() => {
    if (!draft?.tankGroupId) return [];
    const group = groupById.get(draft.tankGroupId);
    const configuredIds = waterQualityParameterIdsForGroup(group, parameters);
    return waterQualityDraftParameters(parameters, configuredIds, draft.original);
  }, [draft?.original, draft?.tankGroupId, groupById, parameters]);

  const openNewRecord = (tankGroupId?: string) => {
    if (!permission.requirePermission("create")) return;
    const selectedGroupId = tankGroupId || (groupFilter !== "all" ? groupFilter : state.tankGroups.length === 1 ? state.tankGroups[0].id : "");
    setDraft({
      id: "",
      newId: `water-${uid()}`,
      tankGroupId: selectedGroupId,
      measuredAt: nowDatetimeLocal(),
      values: {},
      methods: {},
      notes: "",
    });
    setDialogOpen(true);
  };

  const openEditRecord = (record: WaterQualityRecord) => {
    if (!permission.requirePermission("update")) return;
    setDraft({
      id: record.id,
      original: record,
      tankGroupId: record.tankGroupId,
      measuredAt: isoToDatetimeLocal(record.measuredAt),
      values: Object.fromEntries(record.values.map((measurement) => [
        measurement.parameterId,
        String(measurement.value),
      ])),
      methods: Object.fromEntries(record.values.map(measurement => [measurement.parameterId, measurement.testMethod || ""])),
      notes: record.notes,
    });
    setDialogOpen(true);
  };

  const saveRecord = async () => {
    if (!draft || saveLock.current || !permission.requirePermission(draft.id ? "update" : "create")) return;
    if (!draft.tankGroupId) return toast.error("请选择缸组");
    if (!draft.measuredAt) return toast.error("请选择测量时间");
    if (!Number.isFinite(Date.parse(draft.measuredAt))) return toast.error("请选择有效测量时间");
    if (draft.measuredAt > nowDatetimeLocal()) return toast.error("测量时间不能晚于当前时间");
    const values = draftParameters.flatMap((parameter) => {
      const rawValue = String(draft.values[parameter.id] ?? "").trim();
      if (!rawValue) return [];
      const value = Number(rawValue);
      return Number.isFinite(value) ? [{ parameterId: parameter.id, value }] : [];
    });
    const invalidParameter = draftParameters.find((parameter) => {
      const rawValue = String(draft.values[parameter.id] ?? "").trim();
      return rawValue && !Number.isFinite(Number(rawValue));
    });
    if (invalidParameter) return toast.error(`请填写「${invalidParameter.name}」的有效数值`);
    if (values.length === 0) return toast.error("请至少填写一项水质测量值");
    const invalidMethod = draftParameters.find(parameter => draft.methods[parameter.id] && !parameter.testMethods.includes(draft.methods[parameter.id]));
    if (invalidMethod) return toast.error(`「${invalidMethod.name}」的测试方法已变化，请重新选择`);
    const action = draft.id ? "修改" : "新增";
    if (!confirmWrite(action, `${action}一条缸组水质测量记录。`)) return;
    const record: WaterQualityRecord = {
      ...draft.original,
      id: draft.id || draft.newId || `water-${uid()}`,
      siteId: draft.original?.siteId || groupById.get(draft.tankGroupId)?.siteId,
      tankGroupId: draft.tankGroupId,
      scope: "group",
      subTankId: undefined,
      recordedFromSubTankId: draft.original?.recordedFromSubTankId || draft.original?.subTankId,
      measuredAt: new Date(draft.measuredAt).toISOString(),
      values: values.map(({ parameterId, value }) => {
        const parameter = draftParameters.find((item) => item.id === parameterId)!;
        return {
          parameterId,
          value,
          parameterName: parameter.name,
          unit: parameter.unit,
          precision: parameter.precision,
          testMethod: draft.methods[parameterId] || "",
        };
      }),
      operator: state.user?.username ?? "",
      notes: draft.notes.trim(),
    };
    const session = captureNewCustomerSession();
    const current = () => mounted.current && currentContext.current === context && isNewCustomerSessionCurrent(session, viewer.current);
    if (!current()) return toast.error("登录状态已变化，请重新打开记录。");
    saveLock.current = true; setSaving(true);
    try {
      const ok = await saveWaterQualityRecord({ record, ...(!draft.id ? { createOnly: true } : {}) });
      if (!current()) return;
      if (!ok) return toast.error("水质记录保存失败，请重试");
      setDialogOpen(false); setDraft(null);
      toast.success("水质记录已保存");
    } finally { saveLock.current = false; if (mounted.current) setSaving(false); }
  };

  const deleteRecord = async (record: WaterQualityRecord) => {
    if (saveLock.current || !permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `删除 ${formatMeasuredAt(record.measuredAt)} 的水质记录。`)) return;
    const session = captureNewCustomerSession();
    const current = () => mounted.current && currentContext.current === context && isNewCustomerSessionCurrent(session, viewer.current);
    if (!current()) return toast.error("登录状态已变化，请重新打开记录。");
    saveLock.current = true; setSaving(true);
    try {
      const ok = await saveWaterQualityRecord({ deleteId: record.id });
      if (!current()) return;
      if (!ok) return toast.error("水质记录删除失败，请重试");
      toast.success("水质记录已删除");
    } finally { saveLock.current = false; if (mounted.current) setSaving(false); }
  };

  const hasFilter = groupFilter !== "all" || recordTypeFilter !== "all" || Boolean(startDate) || Boolean(endDate);
  const canManage = permission.canUpdate || permission.canDelete;
  const isRecordSaving = saving || maintenanceSaving;
  const isTankView = viewMode === "tank";

  const createMaintenance = () => {
    if (!onCreateMaintenance) return;
    if (groupFilter === "all") return toast.error("请先选择缸组，再新增养护日志");
    onCreateMaintenance(groupFilter);
  };

  return (
    <div className="flex flex-col gap-4">
      {isTankView ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-sm font-medium">共 {filteredRecords.length} 条记录</div>
            <div className="mt-0.5 text-xs text-muted-foreground">养护日志和水质记录按时间从新到旧排列</div>
          </div>
          {permission.canCreate && (
            <div className="grid grid-cols-2 gap-2 sm:flex">
              {onCreateMaintenance && (
                <Button variant="outline" onClick={createMaintenance} disabled={state.tankGroups.length === 0}>
                  <ClipboardList className="size-4" />
                  新增养护
                </Button>
              )}
              <Button onClick={() => openNewRecord()} disabled={state.tankGroups.length === 0}>
                <FlaskConical className="size-4" />
                录入水质
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
            <div className="col-span-2 grid gap-1.5 sm:col-span-1">
              <Label className="text-xs">缸组</Label>
              <Select value={groupFilter} onValueChange={setGroupFilter}>
                <SelectTrigger className="w-full sm:w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部缸组</SelectItem>
                  {state.tankGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 grid gap-1.5 sm:col-span-1">
              <Label className="text-xs">记录类型</Label>
              <Select value={recordTypeFilter} onValueChange={(value: "all" | "maintenance" | "water") => setRecordTypeFilter(value)}>
                <SelectTrigger className="w-full sm:w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部记录</SelectItem>
                  <SelectItem value="maintenance">养护日志</SelectItem>
                  <SelectItem value="water">水质记录</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">开始日期</Label>
              <Input
                type="date"
                value={startDate}
                max={endDate || today}
                onChange={(event) => {
                  const value = event.target.value;
                  setStartDate(value);
                  if (endDate && value && endDate < value) setEndDate("");
                }}
                className="w-full sm:w-40"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs">结束日期</Label>
              <Input
                type="date"
                value={endDate}
                min={startDate || undefined}
                max={today}
                onChange={(event) => setEndDate(event.target.value)}
                className="w-full sm:w-40"
              />
            </div>
            {hasFilter && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setGroupFilter("all");
                  setRecordTypeFilter("all");
                  setStartDate("");
                  setEndDate("");
                }}
              >
                清除筛选
              </Button>
            )}
          </div>
          {permission.canCreate && (
            <div className="grid grid-cols-2 gap-2 sm:flex">
              {onCreateMaintenance && (
                <Button variant="outline" onClick={createMaintenance} disabled={state.tankGroups.length === 0}>
                  <ClipboardList className="size-4" />
                  新增养护
                </Button>
              )}
              <Button onClick={() => openNewRecord()} disabled={state.tankGroups.length === 0}>
                <FlaskConical className="size-4" />
                录入水质
              </Button>
            </div>
          )}
        </div>
      )}

      {isTankView ? (
        <div className="divide-y overflow-hidden rounded-lg border bg-card">
          {filteredRecords.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">该缸暂无养护或水质记录</div>
          ) : filteredRecords.map((item) => (
            <div key={`${item.kind}-${item.id}`} className="grid gap-2.5 p-3 sm:p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="secondary" className={item.kind === "water" ? "gap-1 bg-cyan-50 text-cyan-800" : "gap-1"}>
                    {item.kind === "water" ? <FlaskConical className="size-3" /> : <ClipboardList className="size-3" />}
                    {item.kind === "water" ? "水质" : "养护"}
                  </Badge>
                  <span className="text-sm font-semibold tabular-nums">
                    {item.kind === "water" ? formatMeasuredAt(item.record.measuredAt) : formatBioRecordTime(item.log.date)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {item.kind === "water" ? item.record.operator || "—" : item.log.operator || "—"}
                  </span>
                  {item.kind === "water" && <span className="text-xs text-muted-foreground">{recordScope(item.record)}</span>}
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-2 sm:justify-end">
                    {permission.canUpdate && (item.kind === "water" || onEditMaintenance) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => item.kind === "water" ? openEditRecord(item.record) : onEditMaintenance?.(item.log)}
                        disabled={isRecordSaving}
                      >
                        <Pencil className="size-3.5" />
                        编辑
                      </Button>
                    )}
                    {permission.canDelete && (item.kind === "water" || onDeleteMaintenance) && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        onClick={() => item.kind === "water" ? void deleteRecord(item.record) : onDeleteMaintenance?.(item.log)}
                        disabled={isRecordSaving}
                      >
                        <Trash2 className="size-3.5" />
                        删除
                      </Button>
                    )}
                  </div>
                )}
              </div>
              {item.kind === "water" ? (
                <div className="flex flex-wrap gap-1.5">
                  {item.record.values.map((measurement) => (
                    <Badge key={measurement.parameterId} variant="secondary" className="font-normal">
                      {formatMeasurement(measurement)}
                    </Badge>
                  ))}
                </div>
              ) : (
                <div className="text-sm font-medium">{item.log.action || "未填写操作"}</div>
              )}
              {(item.kind === "water" ? item.record.notes : item.log.notes) && (
                <div className="whitespace-pre-wrap text-sm text-muted-foreground">{item.kind === "water" ? item.record.notes : item.log.notes}</div>
              )}
              {item.kind === "water" && <WaterRecordMedia record={item.record} />}
            </div>
          ))}
        </div>
      ) : (
      <>
      <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
        <table className="w-full table-fixed">
          <thead className="bg-muted/50">
            <tr>
              <th className="w-44 px-4 py-3 text-left text-sm font-semibold">记录时间</th>
              <th className="w-36 px-4 py-3 text-left text-sm font-semibold">缸组</th>
              <th className="w-28 px-4 py-3 text-left text-sm font-semibold">类型</th>
              <th className="px-4 py-3 text-left text-sm font-semibold">记录内容</th>
              <th className="w-28 px-4 py-3 text-left text-sm font-semibold">操作员</th>
              <th className="w-48 px-4 py-3 text-left text-sm font-semibold">备注</th>
              {canManage && <th className="w-32 px-4 py-3 text-right text-sm font-semibold">操作</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredRecords.length === 0 ? (
              <tr><td colSpan={canManage ? 7 : 6} className="px-4 py-12 text-center text-sm text-muted-foreground">暂无养护或水质记录</td></tr>
            ) : filteredRecords.map((item) => (
              <tr key={`${item.kind}-${item.id}`} className="align-top">
                <td className="px-4 py-3 text-sm tabular-nums">
                  {item.kind === "water" ? formatMeasuredAt(item.record.measuredAt) : formatBioRecordTime(item.log.date)}
                </td>
                <td className="px-4 py-3 text-sm font-medium">{item.kind === "water" ? recordScope(item.record) : groupById.get(item.tankGroupId)?.name ?? "已删除缸组"}</td>
                <td className="px-4 py-3">
                  <Badge variant="secondary" className={item.kind === "water" ? "gap-1 bg-cyan-50 text-cyan-800" : "gap-1"}>
                    {item.kind === "water" ? <FlaskConical className="size-3" /> : <ClipboardList className="size-3" />}
                    {item.kind === "water" ? "水质" : "养护"}
                  </Badge>
                </td>
                <td className="px-4 py-3">
                  {item.kind === "water" ? (
                    <div className="flex flex-wrap gap-1.5">
                      {item.record.values.map((measurement) => (
                        <Badge key={measurement.parameterId} variant="secondary" className="font-normal">
                          {formatMeasurement(measurement)}
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm font-medium">{item.log.action || "未填写操作"}</div>
                  )}
                  {item.kind === "water" && <WaterRecordMedia record={item.record} />}
                </td>
                <td className="px-4 py-3 text-sm">{item.kind === "water" ? item.record.operator || "—" : item.log.operator || "—"}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{item.kind === "water" ? item.record.notes || "—" : item.log.notes || "—"}</td>
                {canManage && (
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {permission.canUpdate && (item.kind === "water" || onEditMaintenance) && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => item.kind === "water" ? openEditRecord(item.record) : onEditMaintenance?.(item.log)}
                          disabled={isRecordSaving}
                          title={item.kind === "water" ? "编辑水质记录" : "编辑养护日志"}
                        >
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      {permission.canDelete && (item.kind === "water" || onDeleteMaintenance) && (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="text-red-600"
                          onClick={() => item.kind === "water" ? void deleteRecord(item.record) : onDeleteMaintenance?.(item.log)}
                          disabled={isRecordSaving}
                          title={item.kind === "water" ? "删除水质记录" : "删除养护日志"}
                        >
                          <Trash2 className="size-4" />
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

      <div className="divide-y overflow-hidden rounded-lg border bg-card md:hidden">
        {filteredRecords.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">暂无养护或水质记录</div>
        ) : filteredRecords.map((item) => (
          <div key={`${item.kind}-${item.id}`} className="grid gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="text-sm font-semibold">{item.kind === "water" ? recordScope(item.record) : groupById.get(item.tankGroupId)?.name ?? "已删除缸组"}</div>
                  <Badge variant="secondary" className={item.kind === "water" ? "shrink-0 gap-1 bg-cyan-50 text-cyan-800" : "shrink-0 gap-1"}>
                    {item.kind === "water" ? <FlaskConical className="size-3" /> : <ClipboardList className="size-3" />}
                    {item.kind === "water" ? "水质" : "养护"}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {item.kind === "water" ? formatMeasuredAt(item.record.measuredAt) : formatBioRecordTime(item.log.date)} · {item.kind === "water" ? item.record.operator || "—" : item.log.operator || "—"}
                </div>
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-1">
                  {permission.canUpdate && (item.kind === "water" || onEditMaintenance) && (
                    <Button type="button" size="icon" variant="ghost" onClick={() => item.kind === "water" ? openEditRecord(item.record) : onEditMaintenance?.(item.log)} disabled={isRecordSaving} title={item.kind === "water" ? "编辑水质记录" : "编辑养护日志"}>
                      <Pencil className="size-4" />
                    </Button>
                  )}
                  {permission.canDelete && (item.kind === "water" || onDeleteMaintenance) && (
                    <Button type="button" size="icon" variant="ghost" className="text-red-600" onClick={() => item.kind === "water" ? void deleteRecord(item.record) : onDeleteMaintenance?.(item.log)} disabled={isRecordSaving} title={item.kind === "water" ? "删除水质记录" : "删除养护日志"}>
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              )}
            </div>
            {item.kind === "water" ? (
              <div className="grid grid-cols-2 gap-2">
                {item.record.values.map((measurement) => (
                  <div key={measurement.parameterId} className="rounded-md border bg-muted/30 px-2.5 py-2">
                    <div className="truncate text-xs text-muted-foreground">{measurement.parameterName}</div>
                    <div className="mt-0.5 text-sm font-semibold">
                      {Number(measurement.value).toFixed(Math.max(0, Math.min(4, Math.trunc(Number(measurement.precision ?? 0)))))} <span className="text-xs font-normal text-muted-foreground">{measurement.unit}</span>
                    </div>
                    {measurement.testMethod && <div className="mt-1 break-words text-xs text-muted-foreground">{measurement.testMethod}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm font-medium">{item.log.action || "未填写操作"}</div>
            )}
            {(item.kind === "water" ? item.record.notes : item.log.notes) && (
              <div className="whitespace-pre-wrap text-sm text-muted-foreground">{item.kind === "water" ? item.record.notes : item.log.notes}</div>
            )}
            {item.kind === "water" && <WaterRecordMedia record={item.record} />}
          </div>
        ))}
      </div>
      </>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => {
        if (saveLock.current) return;
        setDialogOpen(open);
        if (!open) setDraft(null);
      }}>
        <DialogContent aria-describedby={undefined} className="max-h-[88vh] max-w-2xl overflow-y-auto" onEscapeKeyDown={event => { if (saveLock.current) event.preventDefault(); }} onPointerDownOutside={event => { if (saveLock.current) event.preventDefault(); }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="size-5 text-cyan-700" />
              {draft?.id ? "编辑水质记录" : "录入水质"}
            </DialogTitle>
          </DialogHeader>
          {draft && (
            <fieldset disabled={saving} className="grid min-w-0 gap-4 py-2">
              <p className="text-sm text-muted-foreground">水质记录属于整个缸组的共用水体。{draft.original && <>原记录：{recordScope(draft.original)}。已有测量沿用当时的名称、单位和小数位数。</>}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>缸组<span className="ml-0.5 text-red-500">*</span></Label>
                  <Select
                    value={draft.tankGroupId}
                    disabled={Boolean(draft.id) || isTankView}
                    onValueChange={(tankGroupId) => setDraft({ ...draft, tankGroupId, values: {}, methods: {} })}
                  >
                    <SelectTrigger><SelectValue placeholder="请选择缸组" /></SelectTrigger>
                    <SelectContent>
                      {state.tankGroups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>测量时间<span className="ml-0.5 text-red-500">*</span></Label>
                  <PreciseDateTimeInput
                    max={now}
                    value={draft.measuredAt}
                    onChange={(measuredAt) => setDraft({ ...draft, measuredAt })}
                  />
                </div>
              </div>

              {!draft.tankGroupId ? (
                <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">请选择缸组</div>
              ) : draftParameters.length === 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">当前缸组未配置水质关注项</div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {draftParameters.map((parameter) => {
                    const step = parameter.precision === 0 ? "1" : (1 / 10 ** parameter.precision).toFixed(parameter.precision);
                    return (
                      <div key={parameter.id} className="grid gap-2">
                        <Label htmlFor={`water-value-${parameter.id}`}>{parameter.name}</Label>
                        <div className="relative">
                          <Input
                            id={`water-value-${parameter.id}`}
                            type="number"
                            inputMode="decimal"
                            step={step}
                            value={draft.values[parameter.id] ?? ""}
                            onChange={(event) => setDraft({
                              ...draft,
                              values: { ...draft.values, [parameter.id]: event.target.value },
                            })}
                            className="pr-20"
                          />
                          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{parameter.unit}</span>
                        </div>
                        {parameter.testMethods.length > 0 && <label className="grid gap-1.5 text-xs text-muted-foreground">测试方法（选填）<select aria-label={`${parameter.name}测试方法`} className="fishroom-control min-h-11 w-full rounded-md border bg-background px-3 text-sm text-foreground" value={draft.methods[parameter.id] || ""} onChange={event => setDraft({ ...draft, methods: { ...draft.methods, [parameter.id]: event.target.value } })}><option value="">未选择</option>{parameter.testMethods.map(method => <option key={method} value={method}>{method}</option>)}</select></label>}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="grid gap-2">
                <Label>备注</Label>
                <Textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
              </div>
              {draft.original && <WaterRecordMedia record={draft.original} />}
            </fieldset>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>取消</Button>
            <Button onClick={() => void saveRecord()} disabled={saving || !draft?.tankGroupId || draftParameters.length === 0}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
