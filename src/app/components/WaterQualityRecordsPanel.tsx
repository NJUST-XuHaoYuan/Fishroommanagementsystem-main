import { useMemo, useState } from "react";
import {
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
import { FlaskConical, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

type WaterRecordDraft = {
  id: string;
  tankGroupId: string;
  measuredAt: string;
  values: Record<string, string>;
  notes: string;
};

function nowDatetimeLocal() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function toDatetimeLocal(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function localDate(value: string) {
  return toDatetimeLocal(value).slice(0, 10);
}

function formatMeasuredAt(value: string) {
  const local = toDatetimeLocal(value);
  return local ? local.replace("T", " ") : "—";
}

function formatMeasurement(measurement: WaterQualityMeasurement) {
  const precision = Math.max(0, Math.min(4, Math.trunc(Number(measurement.precision ?? 0))));
  const value = Number(measurement.value);
  return `${measurement.parameterName || measurement.parameterId} ${Number.isFinite(value) ? value.toFixed(precision) : "—"} ${measurement.unit}`;
}

export function WaterQualityRecordsPanel() {
  const { state, saveWaterQualityRecord } = useStore();
  const permission = usePermission("daily");
  const parameters = useMemo(
    () => normalizeWaterQualityParameters(state.systemSettings),
    [state.systemSettings]
  );
  const [groupFilter, setGroupFilter] = useState("all");
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
  const filteredRecords = useMemo(() => [...state.waterQualityRecords]
    .filter((record) => {
      if (groupFilter !== "all" && record.tankGroupId !== groupFilter) return false;
      const date = localDate(record.measuredAt);
      if (startDate && date < startDate) return false;
      if (endDate && date > endDate) return false;
      return true;
    })
    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt)),
  [state.waterQualityRecords, groupFilter, startDate, endDate]);

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
      measuredAt: toDatetimeLocal(record.measuredAt),
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

  const hasFilter = groupFilter !== "all" || Boolean(startDate) || Boolean(endDate);
  const canManage = permission.canUpdate || permission.canDelete;

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
                setStartDate("");
                setEndDate("");
              }}
            >
              清除筛选
            </Button>
          )}
        </div>
        {permission.canCreate && (
          <Button className="w-full sm:w-auto" onClick={() => openNewRecord()} disabled={state.tankGroups.length === 0}>
            <Plus className="size-4" />
            录入水质
          </Button>
        )}
      </div>

      <div className="hidden overflow-hidden rounded-lg border bg-card md:block">
        <table className="w-full table-fixed">
          <thead className="bg-muted/50">
            <tr>
              <th className="w-40 px-4 py-3 text-left text-sm font-semibold">测量时间</th>
              <th className="w-36 px-4 py-3 text-left text-sm font-semibold">缸组</th>
              <th className="px-4 py-3 text-left text-sm font-semibold">测量结果</th>
              <th className="w-28 px-4 py-3 text-left text-sm font-semibold">操作员</th>
              <th className="w-48 px-4 py-3 text-left text-sm font-semibold">备注</th>
              {canManage && <th className="w-32 px-4 py-3 text-right text-sm font-semibold">操作</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredRecords.length === 0 ? (
              <tr><td colSpan={canManage ? 6 : 5} className="px-4 py-12 text-center text-sm text-muted-foreground">暂无水质记录</td></tr>
            ) : filteredRecords.map((record) => (
              <tr key={record.id} className="align-top">
                <td className="px-4 py-3 text-sm">{formatMeasuredAt(record.measuredAt)}</td>
                <td className="px-4 py-3 text-sm font-medium">{groupById.get(record.tankGroupId)?.name ?? "已删除缸组"}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {record.values.map((measurement) => (
                      <Badge key={measurement.parameterId} variant="secondary" className="font-normal">
                        {formatMeasurement(measurement)}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3 text-sm">{record.operator || "—"}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{record.notes || "—"}</td>
                {canManage && (
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {permission.canUpdate && (
                        <Button type="button" size="icon" variant="ghost" onClick={() => openEditRecord(record)} disabled={saving} title="编辑水质记录">
                          <Pencil className="size-4" />
                        </Button>
                      )}
                      {permission.canDelete && (
                        <Button type="button" size="icon" variant="ghost" className="text-red-600" onClick={() => void deleteRecord(record)} disabled={saving} title="删除水质记录">
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
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">暂无水质记录</div>
        ) : filteredRecords.map((record) => (
          <div key={record.id} className="grid gap-3 p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{groupById.get(record.tankGroupId)?.name ?? "已删除缸组"}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{formatMeasuredAt(record.measuredAt)} · {record.operator || "—"}</div>
              </div>
              {canManage && (
                <div className="flex shrink-0 gap-1">
                  {permission.canUpdate && (
                    <Button type="button" size="icon" variant="ghost" onClick={() => openEditRecord(record)} disabled={saving} title="编辑水质记录">
                      <Pencil className="size-4" />
                    </Button>
                  )}
                  {permission.canDelete && (
                    <Button type="button" size="icon" variant="ghost" className="text-red-600" onClick={() => void deleteRecord(record)} disabled={saving} title="删除水质记录">
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {record.values.map((measurement) => (
                <div key={measurement.parameterId} className="rounded-md border bg-muted/30 px-2.5 py-2">
                  <div className="truncate text-xs text-muted-foreground">{measurement.parameterName}</div>
                  <div className="mt-0.5 text-sm font-semibold">
                    {Number(measurement.value).toFixed(Math.max(0, Math.min(4, Math.trunc(Number(measurement.precision ?? 0)))))} <span className="text-xs font-normal text-muted-foreground">{measurement.unit}</span>
                  </div>
                </div>
              ))}
            </div>
            {record.notes && <div className="text-sm text-muted-foreground">{record.notes}</div>}
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
                  <Input
                    type="datetime-local"
                    max={now}
                    value={draft.measuredAt}
                    onChange={(event) => setDraft({ ...draft, measuredAt: event.target.value })}
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
