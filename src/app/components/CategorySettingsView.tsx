import { useEffect, useMemo, useState } from "react";
import {
  normalizeSpeciesCategoryMajorMap,
  SPECIES_MAJOR_CATEGORIES,
  SpeciesMajorCategoryKey,
  speciesMajorCategoryLabel,
  uid,
  useStore,
} from "../store";
import { confirmWrite } from "../utils/writeConfirm";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Layers3, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

type CategoryDraft = {
  id: string;
  originalName: string;
  name: string;
  majorCategory: SpeciesMajorCategoryKey;
};

function draftsFromState(
  categories: string[],
  majorMap: Record<string, SpeciesMajorCategoryKey>
): CategoryDraft[] {
  return categories.map((name) => ({
    id: `category-${name}`,
    originalName: name,
    name,
    majorCategory: majorMap[name],
  }));
}

export function CategorySettingsView() {
  const { state, saveStateTransform } = useStore();
  const savedMajorMap = useMemo(
    () => normalizeSpeciesCategoryMajorMap(state.speciesCategories, state.speciesCategoryMajorMap),
    [state.speciesCategories, state.speciesCategoryMajorMap]
  );
  const savedDrafts = useMemo(
    () => draftsFromState(state.speciesCategories, savedMajorMap),
    [state.speciesCategories, savedMajorMap]
  );
  const [selectedMajor, setSelectedMajor] = useState<SpeciesMajorCategoryKey>("marineFish");
  const [drafts, setDrafts] = useState<CategoryDraft[]>(() => savedDrafts);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDrafts(savedDrafts);
  }, [savedDrafts]);

  const visibleDrafts = drafts.filter((draft) => draft.majorCategory === selectedMajor);
  const changed = JSON.stringify(drafts.map(({ originalName, name, majorCategory }) => ({ originalName, name, majorCategory }))) !==
    JSON.stringify(savedDrafts.map(({ originalName, name, majorCategory }) => ({ originalName, name, majorCategory })));

  const usageCount = (draft: CategoryDraft) => {
    if (!draft.originalName) return 0;
    return state.species.filter((species) => species.category === draft.originalName).length;
  };

  const updateDraft = (id: string, patch: Partial<CategoryDraft>) => {
    setDrafts((current) => current.map((draft) => draft.id === id ? { ...draft, ...patch } : draft));
  };

  const addCategory = () => {
    const id = `category-new-${uid()}`;
    setDrafts((current) => [...current, {
      id,
      originalName: "",
      name: "",
      majorCategory: selectedMajor,
    }]);
  };

  const moveCategory = (id: string, majorCategory: SpeciesMajorCategoryKey) => {
    updateDraft(id, { majorCategory });
    setSelectedMajor(majorCategory);
  };

  const removeCategory = (draft: CategoryDraft) => {
    const count = usageCount(draft);
    if (count > 0) {
      toast.error(`「${draft.name || draft.originalName}」仍关联 ${count} 个物种，请先调整物种的小类`);
      return;
    }
    setDrafts((current) => current.filter((item) => item.id !== draft.id));
  };

  const save = async () => {
    if (state.user?.role !== "admin" || saving) return;
    const normalized = drafts.map((draft) => ({ ...draft, name: draft.name.trim() }));
    if (normalized.some((draft) => !draft.name)) return toast.error("请填写小类名称");
    const duplicate = normalized.find((draft, index) =>
      normalized.findIndex((candidate) => candidate.name.toLocaleLowerCase("zh-CN") === draft.name.toLocaleLowerCase("zh-CN")) !== index
    );
    if (duplicate) return toast.error(`小类名称不能重复：${duplicate.name}`);
    const removedInUse = savedDrafts.find((saved) =>
      !normalized.some((draft) => draft.originalName === saved.originalName) && usageCount(saved) > 0
    );
    if (removedInUse) return toast.error(`「${removedInUse.originalName}」仍有关联物种，不能删除`);
    if (!confirmWrite("修改", "保存四大类下的小类名称与归属；小类重命名会同步更新关联物种。")) return;

    const baselineNames = new Set(savedDrafts.map((draft) => draft.originalName).filter(Boolean));
    const renamed = new Map(
      normalized
        .filter((draft) => draft.originalName && draft.originalName !== draft.name)
        .map((draft) => [draft.originalName, draft.name])
    );
    setSaving(true);
    const ok = await saveStateTransform((latest) => {
      const concurrentCategories = (latest.speciesCategories ?? []).filter((name) => !baselineNames.has(name));
      const nextCategories = [
        ...normalized.map((draft) => draft.name),
        ...concurrentCategories.filter((name) => !normalized.some((draft) => draft.name === name)),
      ];
      const latestMajorMap = normalizeSpeciesCategoryMajorMap(latest.speciesCategories, latest.speciesCategoryMajorMap);
      const nextMajorMap: Record<string, SpeciesMajorCategoryKey> = Object.fromEntries([
        ...normalized.map((draft) => [draft.name, draft.majorCategory] as const),
        ...concurrentCategories
          .filter((name) => !normalized.some((draft) => draft.name === name))
          .map((name) => [name, latestMajorMap[name]] as const),
      ]);
      return {
        ...latest,
        speciesCategories: nextCategories,
        speciesCategoryMajorMap: nextMajorMap,
        species: latest.species.map((species) => ({
          ...species,
          category: renamed.get(species.category) ?? species.category,
        })),
      };
    });
    setSaving(false);
    if (!ok) return toast.error("分类配置保存失败，请重试");
    toast.success("分类配置已保存");
  };

  if (state.user?.role !== "admin") {
    return <div className="p-6 text-sm text-muted-foreground">当前账户无权访问分类管理。</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3 sm:p-6">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Layers3 className="size-5 text-teal-700" />
              <h1 className="text-xl font-semibold">分类管理</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">四个大类固定维护；原有分类作为小类，可调整名称和所属大类</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={addCategory} disabled={saving}>
              <Plus className="size-4" />新增小类
            </Button>
            <Button onClick={() => void save()} disabled={!changed || saving}>
              <Save className="size-4" />{saving ? "保存中..." : "保存配置"}
            </Button>
          </div>
        </div>

        <div role="tablist" aria-label="商品大类" className="grid grid-cols-2 overflow-hidden rounded-md border bg-card sm:grid-cols-4">
          {SPECIES_MAJOR_CATEGORIES.map((category) => {
            const selected = selectedMajor === category.key;
            const smallCategoryCount = drafts.filter((draft) => draft.majorCategory === category.key).length;
            const speciesCount = drafts
              .filter((draft) => draft.majorCategory === category.key)
              .reduce((total, draft) => total + usageCount(draft), 0);
            return (
              <button
                key={category.key}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`min-h-20 border-b px-4 py-3 text-left transition-colors sm:border-b-0 sm:border-r last:border-r-0 ${selected ? "bg-slate-900 text-white" : "hover:bg-muted/60"}`}
                onClick={() => setSelectedMajor(category.key)}
              >
                <span className="block text-base font-semibold">{category.label}</span>
                <span className={`mt-1 block text-xs ${selected ? "text-white/70" : "text-muted-foreground"}`}>
                  {smallCategoryCount} 个小类 · {speciesCount} 个物种
                </span>
              </button>
            );
          })}
        </div>

        <section className="overflow-hidden rounded-md border bg-card">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
            <div>
              <h2 className="text-base font-semibold">{speciesMajorCategoryLabel(selectedMajor)}的小类</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">商品先归属物种，物种再通过小类归入当前大类</p>
            </div>
            <Badge variant="secondary">{visibleDrafts.length} 个</Badge>
          </div>

          {visibleDrafts.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">当前大类还没有小类</p>
              <Button variant="outline" size="sm" onClick={addCategory}>
                <Plus className="size-4" />新增小类
              </Button>
            </div>
          ) : (
            <>
              <div className="hidden sm:block">
                <table className="w-full table-fixed text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-4 py-3 font-semibold">小类名称</th>
                      <th className="w-56 px-4 py-3 font-semibold">所属大类</th>
                      <th className="w-32 px-4 py-3 text-center font-semibold">关联物种</th>
                      <th className="w-20 px-4 py-3 text-center font-semibold">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {visibleDrafts.map((draft) => (
                      <tr key={draft.id}>
                        <td className="px-4 py-3">
                          <Input value={draft.name} onChange={(event) => updateDraft(draft.id, { name: event.target.value })} placeholder="例如：刺尾鱼科" />
                        </td>
                        <td className="px-4 py-3">
                          <Select value={draft.majorCategory} onValueChange={(value) => moveCategory(draft.id, value as SpeciesMajorCategoryKey)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {SPECIES_MAJOR_CATEGORIES.map((category) => <SelectItem key={category.key} value={category.key}>{category.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-4 py-3 text-center text-muted-foreground">{usageCount(draft)} 个</td>
                        <td className="px-4 py-3 text-center">
                          <Button type="button" variant="ghost" size="icon" onClick={() => removeCategory(draft)} title={usageCount(draft) > 0 ? "请先调整关联物种" : "删除小类"}>
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="divide-y sm:hidden">
                {visibleDrafts.map((draft) => (
                  <div key={draft.id} className="grid gap-3 p-4">
                    <Input value={draft.name} onChange={(event) => updateDraft(draft.id, { name: event.target.value })} placeholder="小类名称" />
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
                      <Select value={draft.majorCategory} onValueChange={(value) => moveCategory(draft.id, value as SpeciesMajorCategoryKey)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {SPECIES_MAJOR_CATEGORIES.map((category) => <SelectItem key={category.key} value={category.key}>{category.label}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button type="button" variant="ghost" size="icon" onClick={() => removeCategory(draft)} title="删除小类">
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">关联 {usageCount(draft)} 个物种</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
