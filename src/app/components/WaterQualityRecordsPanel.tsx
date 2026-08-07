import { useMemo, useState } from "react";
import {
  DailyLog,
  normalizeWaterQualityParameters,
  uid,
  useStore,
  waterQualityParameterIdsForGroup,
  WaterQualityMeasurement,
  WaterQualityRecord,
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

type WaterRecordDraft = {
  id: string;
  tankGroupId: string;
  measuredAt: string;
  values: Record<string, string>;
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

function formatMeasurement(measurement: WaterQualityMeasurement) {
  const precision = Math.max(0, Math.min(4, Math.trunc(Number(measurement.precision ?? 0))));
  const value = Number(measurement.value);
  return `${measurement.parameterName || measurement.parameterId} ${Number.isFinite(value) ? value.toFixed(precision) : "—"} ${measurement.unit}`;
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
}: WaterQualityRecordsPanelProps = {}) {
  const { state, saveWaterQualityRecord } = useStore();
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
  const today = nowDatetimeLocal().slice(0, 10);
  const now = nowDatetimeLocal();

  const groupById = useMemo(
    () => new Map(state.tankGroups.map((group) => [group.id, group])),
    [state.tankGroups]
  );
  const parameterById = useMemo(
    () => new Map(parameters.map((parameter) => [parameter.id, parameter])),
    [parameters]
  );
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
    const editingRecord = draft.id
      ? state.waterQualityRecords.find((record) => record.id === draft.id)
      : null;
    const historical = new Map((editingRecord?.values ?? []).map((measurement) => [
      measurement.parameterId,
      {
        id: measurement.parameterId,
        name: measurement.parameterName,
        unit: measurement.unit,
        precision: measurement.precision,
      },
    ]));
    return [...new Set([...configuredIds, ...historical.keys()])].flatMap((id) => {
      const parameter = parameterById.get(id) ?? historical.get(id);
      return parameter ? [parameter] : [];
    });
  }, [draft?.id, draft?.tankGroupId, groupById, parameterById, parameters, state.waterQualityRecords]);

  const openNewRecord = (tankGroupId?: string) => {
    if (!permission.requirePermission("create")) return;
    const selectedGroupId = tankGroupId || (groupFilter !== "all" ? groupFilter : state.tankGroups.length === 1 ? state.tankGroups[0].id : "");
    setDraft({
      id: "",
      tankGroupId: selectedGroupId,
      measuredAt: nowDatetimeLocal(),
      values: {},
      notes: "",
    });
    setDialogOpen(true);
  };

  const openEditRecord = (record: WaterQualityRecord) => {
    if (!permission.requirePermission("update")) return;
    setDraft({
      id: record.id,
      tankGroupId: record.tankGroupId,
      measuredAt: isoToDatetimeLocal(record.measuredAt),
      values: Object.fromEntries(record.values.map((measurement) => [
        measurement.parameterId,
        String(measurement.value),
      ])),
      notes: record.notes,
    });
    setDialogOpen(true);
  };

  const saveRecord = async () => {
    if (!draft || saving) return;
    if (!draft.tankGroupId) return toast.error("请选择缸组");
    if (!draft.measuredAt) return toast.error("请选择测量时间");
    if (draft.measuredAt > now) return toast.error("测量时间不能晚于当前时间");
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
    const action = draft.id ? "修改" : "新增";
    if (!confirmWrite(action, `${action}一条缸组水质测量记录。`)) return;
    const record: WaterQualityRecord = {
      id: draft.id || `water-${uid()}`,
      tankGroupId: draft.tankGroupId,
      measuredAt: new Date(draft.measuredAt).toISOString(),
      values: values.map(({ parameterId, value }) => {
        const parameter = draftParameters.find((item) => item.id === parameterId)!;
        return {
          parameterId,
          value,
          parameterName: parameter.name,
          unit: parameter.unit,
          precision: parameter.precision,
        };
      }),
      operator: state.user?.username ?? "",
      notes: draft.notes.trim(),
    };
    setSaving(true);
    const ok = await saveWaterQualityRecord({ record });
    setSaving(false);
    if (!ok) return toast.error("水质记录保存失败，请重试");
    setDialogOpen(false);
    setDraft(null);
    toast.success("水质记录已保存");
  };

  const deleteRecord = async (record: WaterQualityRecord) => {
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `删除 ${formatMeasuredAt(record.measuredAt)} 的水质记录。`)) return;
    setSaving(true);
    const ok = await saveWaterQualityRecord({ deleteId: record.id });
    setSaving(false);
    if (!ok) return toast.error("水质记录删除失败，请重试");
    toast.success("水质记录已删除");
  };

  const hasFilter = groupFilter !== "all" || recordTypeFilter !== "all" || Boolean(startDate) || Boolean(endDate);
  const canManage = permission.canUpdate || permission.canDelete;
  const isRecordSaving = saving || maintenanceSaving;

  const createMaintenance = () => {
    if (!onCreateMaintenance) return;
    if (groupFilter === "all") return toast.error("请先选择缸组，再新增养护日志");
    onCreateMaintenance(groupFilter);
  };

  return (
    <div className="flex flex-col gap-4">
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
                <td className="px-4 py-3 text-sm font-medium">{groupById.get(item.tankGroupId)?.name ?? "已删除缸组"}</td>
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
                  <div className="truncate text-sm font-semibold">{groupById.get(item.tankGroupId)?.name ?? "已删除缸组"}</div>
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
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm font-medium">{item.log.action || "未填写操作"}</div>
            )}
            {(item.kind === "water" ? item.record.notes : item.log.notes) && (
              <div className="whitespace-pre-wrap text-sm text-muted-foreground">{item.kind === "water" ? item.record.notes : item.log.notes}</div>
            )}
          </div>
        ))}
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => {
        setDialogOpen(open);
        if (!open) setDraft(null);
      }}>
        <DialogContent aria-describedby={undefined} className="max-h-[88vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="size-5 text-cyan-700" />
              {draft?.id ? "编辑水质记录" : "录入水质"}
            </DialogTitle>
          </DialogHeader>
          {draft && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>缸组<span className="ml-0.5 text-red-500">*</span></Label>
                  <Select
                    value={draft.tankGroupId}
                    disabled={Boolean(draft.id)}
                    onValueChange={(tankGroupId) => setDraft({ ...draft, tankGroupId, values: {} })}
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
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="grid gap-2">
                <Label>备注</Label>
                <Textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
              </div>
            </div>
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
