import { useEffect, useMemo, useState } from "react";
import {
  normalizeWaterQualityParameters,
  uid,
  useStore,
  waterQualityParameterIdsForGroup,
  WaterQualityParameterSetting,
} from "../store";
import { confirmWrite } from "../utils/writeConfirm";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { ChevronDown, FlaskConical, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

function copyParameters(parameters: WaterQualityParameterSetting[]) {
  return parameters.map((parameter) => ({ ...parameter }));
}

export function WaterQualitySettingsView() {
  const { state, saveWaterQualitySettings } = useStore();
  const savedParameters = useMemo(
    () => normalizeWaterQualityParameters(state.systemSettings),
    [state.systemSettings]
  );
  const savedAssignments = useMemo(() => Object.fromEntries(
    state.tankGroups.map((group) => [
      group.id,
      waterQualityParameterIdsForGroup(group, savedParameters),
    ])
  ), [state.tankGroups, savedParameters]);
  const [parameters, setParameters] = useState(() => copyParameters(savedParameters));
  const [assignments, setAssignments] = useState<Record<string, string[]>>(() => savedAssignments);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setParameters(copyParameters(savedParameters));
    setAssignments(savedAssignments);
  }, [savedParameters, savedAssignments]);

  const changed = JSON.stringify(parameters) !== JSON.stringify(savedParameters) ||
    JSON.stringify(assignments) !== JSON.stringify(savedAssignments);

  const updateParameter = (id: string, patch: Partial<WaterQualityParameterSetting>) => {
    setParameters((current) => current.map((parameter) =>
      parameter.id === id ? { ...parameter, ...patch } : parameter
    ));
  };

  const addParameter = () => {
    setParameters((current) => [...current, {
      id: `water-${uid()}`,
      name: "",
      unit: "mg/L",
      precision: 1,
    }]);
  };

  const removeParameter = (id: string) => {
    setParameters((current) => current.filter((parameter) => parameter.id !== id));
    setAssignments((current) => Object.fromEntries(
      Object.entries(current).map(([groupId, parameterIds]) => [
        groupId,
        parameterIds.filter((parameterId) => parameterId !== id),
      ])
    ));
  };

  const toggleAssignment = (groupId: string, parameterId: string, checked: boolean) => {
    setAssignments((current) => {
      const currentIds = current[groupId] ?? [];
      const nextIds = checked
        ? parameters
            .map((parameter) => parameter.id)
            .filter((id) => id === parameterId || currentIds.includes(id))
        : currentIds.filter((id) => id !== parameterId);
      return { ...current, [groupId]: nextIds };
    });
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const save = async () => {
    if (state.user?.role !== "admin" || saving) return;
    if (parameters.length === 0) return toast.error("请至少保留一个水质参数");
    const normalized = parameters.map((parameter) => ({
      ...parameter,
      name: parameter.name.trim(),
      unit: parameter.unit.trim(),
      precision: Math.trunc(Number(parameter.precision)),
    }));
    const missingName = normalized.find((parameter) => !parameter.name);
    if (missingName) return toast.error("请填写水质参数名称");
    const missingUnit = normalized.find((parameter) => !parameter.unit);
    if (missingUnit) return toast.error(`请填写「${missingUnit.name}」的单位`);
    const invalidPrecision = normalized.find((parameter) =>
      !Number.isInteger(parameter.precision) || parameter.precision < 0 || parameter.precision > 4
    );
    if (invalidPrecision) return toast.error(`「${invalidPrecision.name}」的精度必须是 0 至 4 的整数`);
    const duplicateName = normalized.find((parameter, index) =>
      normalized.findIndex((candidate) => candidate.name.toLocaleLowerCase("zh-CN") === parameter.name.toLocaleLowerCase("zh-CN")) !== index
    );
    if (duplicateName) return toast.error(`水质参数名称不能重复：${duplicateName.name}`);
    if (!confirmWrite("修改", "保存水质参数和各缸组关注项配置。")) return;
    setSaving(true);
    const ok = await saveWaterQualitySettings({
      parameters: normalized,
      assignments: state.tankGroups.map((group) => ({
        groupId: group.id,
        parameterIds: assignments[group.id] ?? [],
      })),
    });
    setSaving(false);
    if (!ok) return toast.error("水质参数配置保存失败，请重试");
    setParameters(copyParameters(normalized));
    toast.success("水质参数配置已保存");
  };

  if (state.user?.role !== "admin") {
    return <div className="p-6 text-sm text-muted-foreground">当前账户无权访问水质参数管理。</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3 sm:p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <FlaskConical className="size-5 text-cyan-700" />
              <h1 className="text-xl font-semibold">水质参数管理</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">参数定义与缸组关注范围</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={addParameter} disabled={saving}>
              <Plus className="size-4" />
              新增参数
            </Button>
            <Button onClick={() => void save()} disabled={!changed || saving}>
              <Save className="size-4" />
              {saving ? "保存中..." : "保存配置"}
            </Button>
          </div>
        </div>

        <section className="overflow-hidden rounded-md border bg-card">
          <div className="border-b px-4 py-3">
            <h2 className="text-base font-semibold">参数项</h2>
          </div>
          <div className="hidden sm:block">
            <table className="w-full table-fixed text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="w-[34%] px-4 py-3 font-semibold">参数名称</th>
                  <th className="w-[30%] px-4 py-3 font-semibold">单位</th>
                  <th className="w-40 px-4 py-3 font-semibold">小数位数</th>
                  <th className="w-20 px-4 py-3 text-center font-semibold">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {parameters.map((parameter) => (
                  <tr key={parameter.id}>
                    <td className="px-4 py-3">
                      <Input
                        value={parameter.name}
                        onChange={(event) => updateParameter(parameter.id, { name: event.target.value })}
                        placeholder="例如：温度"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        value={parameter.unit}
                        onChange={(event) => updateParameter(parameter.id, { unit: event.target.value })}
                        placeholder="例如：mg/L"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Input
                        type="number"
                        min={0}
                        max={4}
                        step={1}
                        value={parameter.precision}
                        onChange={(event) => updateParameter(parameter.id, { precision: Number(event.target.value) })}
                      />
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removeParameter(parameter.id)}
                        disabled={parameters.length <= 1 || saving}
                        title="删除参数"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="divide-y sm:hidden">
            {parameters.map((parameter) => (
              <div key={parameter.id} className="grid grid-cols-2 gap-3 p-4">
                <Input
                  value={parameter.name}
                  onChange={(event) => updateParameter(parameter.id, { name: event.target.value })}
                  placeholder="参数名称"
                  className="col-span-2"
                />
                <Input
                  value={parameter.unit}
                  onChange={(event) => updateParameter(parameter.id, { unit: event.target.value })}
                  placeholder="单位"
                />
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={0}
                    max={4}
                    step={1}
                    value={parameter.precision}
                    onChange={(event) => updateParameter(parameter.id, { precision: Number(event.target.value) })}
                    aria-label={`${parameter.name || "水质参数"}小数位数`}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeParameter(parameter.id)}
                    disabled={parameters.length <= 1 || saving}
                    title="删除参数"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-md border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <h2 className="text-base font-semibold">缸组关注项</h2>
            <Badge variant="secondary">{state.tankGroups.length} 个缸组</Badge>
          </div>
          {state.tankGroups.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">当前场地暂无缸组</div>
          ) : (
            <div className="divide-y">
              {state.tankGroups.map((group) => {
                const selectedIds = assignments[group.id] ?? [];
                const selectedParameters = parameters.filter((parameter) => selectedIds.includes(parameter.id));
                const expanded = expandedGroupIds.has(group.id);
                return (
                  <div key={group.id}>
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => toggleGroup(group.id)}
                      className="relative grid w-full gap-2 px-4 py-3 pr-10 text-left transition-colors hover:bg-muted/30 sm:grid-cols-[13rem_minmax(0,1fr)_auto] sm:items-center sm:pr-4"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{group.name}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">{group.location || "未填写位置"}</div>
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {selectedParameters.length === 0 ? (
                          <span className="text-xs text-muted-foreground">未选择关注项</span>
                        ) : (
                          <>
                            {selectedParameters.slice(0, 5).map((parameter) => (
                              <Badge key={parameter.id} variant="secondary" className="font-normal">{parameter.name}</Badge>
                            ))}
                            {selectedParameters.length > 5 && (
                              <span className="text-xs text-muted-foreground">+{selectedParameters.length - 5}</span>
                            )}
                          </>
                        )}
                      </div>
                      <ChevronDown className={`absolute right-4 top-4 size-4 text-muted-foreground transition-transform sm:static ${expanded ? "rotate-180" : ""}`} />
                    </button>
                    {expanded && (
                      <div className="border-t bg-muted/20 px-4 py-3">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <span className="text-xs text-muted-foreground">已选 {selectedIds.length} 项</span>
                          <div className="flex gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setAssignments((current) => ({
                                ...current,
                                [group.id]: parameters.map((parameter) => parameter.id),
                              }))}
                            >
                              全选
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => setAssignments((current) => ({ ...current, [group.id]: [] }))}
                            >
                              清空
                            </Button>
                          </div>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                          {parameters.map((parameter) => {
                            const checked = selectedIds.includes(parameter.id);
                            return (
                              <label
                                key={parameter.id}
                                className={`flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                                  checked ? "border-cyan-300 bg-cyan-50 text-cyan-950" : "bg-background"
                                }`}
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={(value) => toggleAssignment(group.id, parameter.id, value === true)}
                                />
                                <span className="min-w-0 flex-1 truncate">{parameter.name}</span>
                                <span className="shrink-0 text-xs text-muted-foreground">{parameter.unit}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
