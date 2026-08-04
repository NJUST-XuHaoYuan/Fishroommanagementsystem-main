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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  Check,
  FlaskConical,
  ListChecks,
  Plus,
  Save,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

type SettingsSection = "parameters" | "groups";

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
  const [section, setSection] = useState<SettingsSection>("parameters");
  const [parameters, setParameters] = useState(() => copyParameters(savedParameters));
  const [assignments, setAssignments] = useState<Record<string, string[]>>(() => savedAssignments);
  const [selectedGroupId, setSelectedGroupId] = useState(() => state.tankGroups[0]?.id ?? "");
  const [groupQuery, setGroupQuery] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setParameters(copyParameters(savedParameters));
    setAssignments(savedAssignments);
  }, [savedParameters, savedAssignments]);

  useEffect(() => {
    if (state.tankGroups.some((group) => group.id === selectedGroupId)) return;
    setSelectedGroupId(state.tankGroups[0]?.id ?? "");
  }, [selectedGroupId, state.tankGroups]);

  const changed = JSON.stringify(parameters) !== JSON.stringify(savedParameters) ||
    JSON.stringify(assignments) !== JSON.stringify(savedAssignments);
  const selectedGroup = state.tankGroups.find((group) => group.id === selectedGroupId);
  const selectedIds = selectedGroup ? assignments[selectedGroup.id] ?? [] : [];
  const filteredGroups = useMemo(() => {
    const term = groupQuery.trim().toLocaleLowerCase("zh-CN");
    if (!term) return state.tankGroups;
    return state.tankGroups.filter((group) =>
      `${group.name} ${group.location ?? ""}`.toLocaleLowerCase("zh-CN").includes(term)
    );
  }, [groupQuery, state.tankGroups]);

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
        ? parameters.map((parameter) => parameter.id)
          .filter((id) => id === parameterId || currentIds.includes(id))
        : currentIds.filter((id) => id !== parameterId);
      return { ...current, [groupId]: nextIds };
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
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <FlaskConical className="size-5 text-cyan-700" />
              <h1 className="text-xl font-semibold">水质参数管理</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">先维护参数定义，再为每个缸组选择日常关注项</p>
          </div>
          <div className="flex items-center gap-2">
            {section === "parameters" && (
              <Button variant="outline" onClick={addParameter} disabled={saving}>
                <Plus className="size-4" />新增参数
              </Button>
            )}
            <Button onClick={() => void save()} disabled={!changed || saving}>
              <Save className="size-4" />{saving ? "保存中..." : "保存配置"}
            </Button>
          </div>
        </div>

        <div
          role="tablist"
          aria-label="水质参数配置"
          className="water-settings-mobile-tabs grid w-full grid-cols-2 gap-1 rounded-md border bg-muted/40 p-1 sm:w-[21rem]"
        >
          <Button
            type="button"
            role="tab"
            aria-selected={section === "parameters"}
            variant={section === "parameters" ? "default" : "ghost"}
            size="sm"
            className="h-8"
            onClick={() => setSection("parameters")}
          >
            <Settings2 className="size-4" />参数项目
          </Button>
          <Button
            type="button"
            role="tab"
            aria-selected={section === "groups"}
            variant={section === "groups" ? "default" : "ghost"}
            size="sm"
            className="h-8"
            onClick={() => setSection("groups")}
          >
            <ListChecks className="size-4" />缸组关注项
          </Button>
        </div>

        {section === "parameters" && (
          <section className="overflow-hidden rounded-md border bg-card">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <h2 className="text-base font-semibold">参数项目</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">名称、单位和小数位数会作为测量记录的显示规则</p>
              </div>
              <Badge variant="secondary">{parameters.length} 项</Badge>
            </div>
            <div className="hidden sm:block">
              <table className="w-full table-fixed text-sm">
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="w-[38%] px-4 py-3 font-semibold">参数名称</th>
                    <th className="w-[32%] px-4 py-3 font-semibold">单位</th>
                    <th className="w-40 px-4 py-3 font-semibold">小数位数</th>
                    <th className="w-20 px-4 py-3 text-center font-semibold">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {parameters.map((parameter) => (
                    <tr key={parameter.id}>
                      <td className="px-4 py-3">
                        <Input value={parameter.name} onChange={(event) => updateParameter(parameter.id, { name: event.target.value })} placeholder="例如：温度" />
                      </td>
                      <td className="px-4 py-3">
                        <Input value={parameter.unit} onChange={(event) => updateParameter(parameter.id, { unit: event.target.value })} placeholder="例如：mg/L" />
                      </td>
                      <td className="px-4 py-3">
                        <Input type="number" min={0} max={4} step={1} value={parameter.precision} onChange={(event) => updateParameter(parameter.id, { precision: Number(event.target.value) })} />
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Button type="button" variant="ghost" size="icon" onClick={() => removeParameter(parameter.id)} disabled={parameters.length <= 1 || saving} title="删除参数">
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
                  <Input value={parameter.name} onChange={(event) => updateParameter(parameter.id, { name: event.target.value })} placeholder="参数名称" className="col-span-2" />
                  <Input value={parameter.unit} onChange={(event) => updateParameter(parameter.id, { unit: event.target.value })} placeholder="单位" />
                  <div className="flex items-center gap-2">
                    <Input type="number" min={0} max={4} step={1} value={parameter.precision} onChange={(event) => updateParameter(parameter.id, { precision: Number(event.target.value) })} aria-label={`${parameter.name || "水质参数"}小数位数`} />
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeParameter(parameter.id)} disabled={parameters.length <= 1 || saving} title="删除参数">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {section === "groups" && (
          <section className="grid min-h-[34rem] flex-1 overflow-hidden rounded-md border bg-card lg:grid-cols-[18rem_minmax(0,1fr)]">
            <aside className="hidden min-h-0 flex-col border-r bg-muted/15 lg:flex">
              <div className="border-b p-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={groupQuery} onChange={(event) => setGroupQuery(event.target.value)} placeholder="搜索缸组或位置" className="pl-9" />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {filteredGroups.map((group) => {
                  const ids = assignments[group.id] ?? [];
                  const selected = group.id === selectedGroupId;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      className={`mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2.5 text-left ${selected ? "bg-slate-900 text-white" : "hover:bg-muted"}`}
                      onClick={() => setSelectedGroupId(group.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{group.name}</span>
                        <span className={`block truncate text-xs ${selected ? "text-white/65" : "text-muted-foreground"}`}>{group.location || "未填写位置"}</span>
                      </span>
                      <span className={`shrink-0 text-xs ${selected ? "text-white/70" : "text-muted-foreground"}`}>{ids.length} 项</span>
                    </button>
                  );
                })}
              </div>
            </aside>

            <div className="flex min-h-0 flex-col">
              <div className="border-b p-3 lg:hidden">
                <div className="relative mb-2">
                  <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input value={groupQuery} onChange={(event) => setGroupQuery(event.target.value)} placeholder="搜索缸组或位置" className="pl-9" />
                </div>
                <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                  <SelectTrigger className="h-11"><SelectValue placeholder="选择缸组" /></SelectTrigger>
                  <SelectContent>
                    {filteredGroups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name} · {assignments[group.id]?.length ?? 0} 项</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {!selectedGroup ? (
                <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">当前场地暂无可配置缸组</div>
              ) : (
                <>
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5">
                    <div>
                      <h2 className="text-base font-semibold">{selectedGroup.name}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">{selectedGroup.location || "未填写位置"} · 已关注 {selectedIds.length} 项</p>
                    </div>
                    <div className="flex gap-1">
                      <Button type="button" size="sm" variant="outline" onClick={() => setAssignments((current) => ({ ...current, [selectedGroup.id]: parameters.map((parameter) => parameter.id) }))}>全选</Button>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setAssignments((current) => ({ ...current, [selectedGroup.id]: [] }))}>清空</Button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-5">
                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                      {parameters.map((parameter) => {
                        const checked = selectedIds.includes(parameter.id);
                        return (
                          <label
                            key={parameter.id}
                            className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                              checked ? "border-cyan-400 bg-cyan-50 text-cyan-950" : "bg-background hover:border-slate-400"
                            }`}
                          >
                            <Checkbox checked={checked} onCheckedChange={(value) => toggleAssignment(selectedGroup.id, parameter.id, value === true)} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{parameter.name || "未命名参数"}</span>
                              <span className="block truncate text-xs text-muted-foreground">{parameter.unit || "未填写单位"} · 保留 {parameter.precision} 位小数</span>
                            </span>
                            {checked && <Check className="size-4 shrink-0 text-cyan-700" />}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
