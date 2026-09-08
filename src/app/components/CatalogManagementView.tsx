import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Image as ImageIcon,
  ListFilter,
  RotateCcw,
  Save,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  SPECIES_MAJOR_CATEGORIES,
  normalizeSpeciesCategoryMajorMap,
  useStore,
} from "../store";
import type { Product, Species, SpeciesMajorCategoryKey } from "../store";
import {
  copyPublicCatalogPolicy,
  getPublicCatalogProductDisplayCap,
  MAX_PUBLIC_CATALOG_DISPLAY_CAP,
  normalizePublicCatalogPolicy,
  publicCatalogPolicyFingerprint,
} from "../utils/publicCatalogPolicy";
import type { PublicCatalogPolicy } from "../utils/publicCatalogPolicy";
import { confirmWrite } from "../utils/writeConfirm";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Switch } from "./ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

type ProductSummary = {
  product: Product;
  species?: Species;
  majorCategoryKey: SpeciesMajorCategoryKey;
  hiddenReason: "major" | "species" | "product" | null;
  displayCap?: number;
};

type CatalogRuleTab = "major" | "species" | "product";

const PAGE_SIZE = 20;

type CatalogDraftSession = {
  baselinePolicy: PublicCatalogPolicy;
  draft: PublicCatalogPolicy;
};

// Preserve an administrator's unsaved rules while they visit another module.
// The cache is memory-only and scoped to the signed-in account.
const catalogDraftSessions = new Map<string, CatalogDraftSession>();

function uniqueCount(values: readonly string[]) {
  return new Set(values).size;
}

function policyRuleCount(policy: PublicCatalogPolicy) {
  return uniqueCount(policy.hiddenMajorCategoryKeys) +
    uniqueCount(policy.hiddenSpeciesIds) +
    uniqueCount(policy.hiddenProductIds) +
    Object.keys(policy.productDisplayCaps).length;
}

function includesSearch(fields: unknown[], search: string) {
  const term = search.trim().toLocaleLowerCase("zh-CN");
  if (!term) return true;
  return fields.some((field) => String(field ?? "").toLocaleLowerCase("zh-CN").includes(term));
}

function SearchField({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <label className="relative block w-full sm:max-w-sm">
      <span className="sr-only">{label}</span>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="!h-[44px] !min-h-[44px] pl-9 pr-[44px] sm:!h-9 sm:!min-h-9 sm:pr-9"
        aria-label={label}
      />
      {value && (
        <button
          type="button"
          className="absolute right-0 top-1/2 flex !size-[44px] -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:right-1 sm:!size-8"
          onClick={() => onChange("")}
          aria-label={`清空${label}`}
        >
          <X className="size-4" />
        </button>
      )}
    </label>
  );
}

function ProductCapInput({
  id,
  value,
  disabled,
  ariaLabel,
  onCommit,
  className = "",
}: {
  id?: string;
  value?: number;
  disabled: boolean;
  ariaLabel: string;
  onCommit: (value: string) => void;
  className?: string;
}) {
  const [text, setText] = useState(value ? String(value) : "");

  useEffect(() => {
    setText(value ? String(value) : "");
  }, [value]);

  const commit = () => {
    const normalized = text.trim();
    if (!normalized || Number(normalized) === 0) {
      setText("");
      onCommit("");
      return;
    }
    const cap = Number(normalized);
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > MAX_PUBLIC_CATALOG_DISPLAY_CAP) {
      toast.error(`显示数量请输入 1 至 ${MAX_PUBLIC_CATALOG_DISPLAY_CAP.toLocaleString("zh-CN")} 的整数`);
      setText(value ? String(value) : "");
      return;
    }
    setText(String(cap));
    onCommit(String(cap));
  };

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={text}
      onChange={(event) => {
        if (/^\d*$/.test(event.target.value)) setText(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setText(value ? String(value) : "");
        }
      }}
      placeholder="全部"
      className={`!h-[44px] !min-h-[44px] sm:!h-9 sm:!min-h-9 ${className}`}
      disabled={disabled}
      aria-label={ariaLabel}
    />
  );
}

function RuleStateBadge({ summary }: { summary: ProductSummary }) {
  if (summary.hiddenReason === "major") {
    return <Badge variant="secondary">随类型隐藏</Badge>;
  }
  if (summary.hiddenReason === "species") {
    return <Badge variant="secondary">随物种隐藏</Badge>;
  }
  if (summary.hiddenReason === "product") {
    return <Badge variant="secondary">商品规则隐藏</Badge>;
  }
  const cap = summary.displayCap;
  return (
    <Badge
      variant="outline"
      className={cap ? "border-amber-300 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-800"}
    >
      {cap ? `上限 ${cap} 条` : "展示全部"}
    </Badge>
  );
}

function PageNavigator({
  page,
  totalItems,
  onChange,
}: {
  page: number;
  totalItems: number;
  onChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t px-4 py-3 text-sm text-muted-foreground">
      <span>第 {page} / {totalPages} 页</span>
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" className="!min-h-[44px] sm:!min-h-8" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          上一页
        </Button>
        <Button type="button" size="sm" variant="outline" className="!min-h-[44px] sm:!min-h-8" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
          下一页
        </Button>
      </div>
    </div>
  );
}

export function CatalogManagementView() {
  const { state, saveStateTransform } = useStore();
  const canEdit = state.user?.role === "admin";
  const draftSessionKey = canEdit ? state.user?.username ?? "" : "";
  const savedPolicy = useMemo(
    () => normalizePublicCatalogPolicy(state.publicCatalogPolicy),
    [state.publicCatalogPolicy]
  );
  const savedPolicyFingerprint = useMemo(() => publicCatalogPolicyFingerprint(savedPolicy), [savedPolicy]);
  const initialDraftSession = draftSessionKey ? catalogDraftSessions.get(draftSessionKey) : undefined;
  const [baselinePolicy, setBaselinePolicy] = useState<PublicCatalogPolicy>(() =>
    copyPublicCatalogPolicy(initialDraftSession?.baselinePolicy ?? savedPolicy)
  );
  const [draft, setDraft] = useState<PublicCatalogPolicy>(() =>
    copyPublicCatalogPolicy(initialDraftSession?.draft ?? savedPolicy)
  );
  const [remotePolicyChanged, setRemotePolicyChanged] = useState(() => Boolean(
    initialDraftSession &&
    publicCatalogPolicyFingerprint(initialDraftSession.baselinePolicy) !== savedPolicyFingerprint
  ));
  const lastSeenSavedPolicyFingerprint = useRef(savedPolicyFingerprint);
  const [saving, setSaving] = useState(false);
  const [speciesSearch, setSpeciesSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [speciesPage, setSpeciesPage] = useState(1);
  const [productPage, setProductPage] = useState(1);
  const [productFilter, setProductFilter] = useState<"all" | "hidden" | "limited">("all");
  const [activeRuleTab, setActiveRuleTab] = useState<CatalogRuleTab>("major");

  const normalizedDraft = useMemo(() => normalizePublicCatalogPolicy(draft), [draft]);
  const baselinePolicyFingerprint = useMemo(() => publicCatalogPolicyFingerprint(baselinePolicy), [baselinePolicy]);
  const changed = publicCatalogPolicyFingerprint(normalizedDraft) !== baselinePolicyFingerprint;

  useLayoutEffect(() => {
    if (!draftSessionKey) return;
    if (!changed) {
      catalogDraftSessions.delete(draftSessionKey);
      return;
    }
    catalogDraftSessions.set(draftSessionKey, {
      baselinePolicy: copyPublicCatalogPolicy(baselinePolicy),
      draft: copyPublicCatalogPolicy(normalizedDraft),
    });
  }, [baselinePolicy, changed, draftSessionKey, normalizedDraft]);

  useEffect(() => {
    if (lastSeenSavedPolicyFingerprint.current === savedPolicyFingerprint) return;
    lastSeenSavedPolicyFingerprint.current = savedPolicyFingerprint;
    if (changed) {
      setRemotePolicyChanged(true);
      return;
    }
    const latestPolicy = copyPublicCatalogPolicy(savedPolicy);
    setBaselinePolicy(latestPolicy);
    setDraft(copyPublicCatalogPolicy(latestPolicy));
    setRemotePolicyChanged(false);
  }, [changed, savedPolicy, savedPolicyFingerprint]);
  const majorMap = useMemo(
    () => normalizeSpeciesCategoryMajorMap(state.speciesCategories, state.speciesCategoryMajorMap),
    [state.speciesCategories, state.speciesCategoryMajorMap]
  );
  const speciesById = useMemo(
    () => new Map(state.species.map((species) => [species.id, species])),
    [state.species]
  );
  const productSummaries = useMemo<ProductSummary[]>(() => state.products
    .map((product) => {
      const species = speciesById.get(product.speciesId);
      const majorCategoryKey = majorMap[species?.category ?? ""] ?? "marineFish";
      const cap = getPublicCatalogProductDisplayCap(normalizedDraft, product.id);
      const majorRuleHidden = normalizedDraft.hiddenMajorCategoryKeys.includes(majorCategoryKey);
      const speciesRuleHidden = normalizedDraft.hiddenSpeciesIds.includes(product.speciesId);
      const productRuleHidden = normalizedDraft.hiddenProductIds.includes(product.id);
      const hiddenReason: ProductSummary["hiddenReason"] = majorRuleHidden
        ? "major"
        : speciesRuleHidden
          ? "species"
          : productRuleHidden
            ? "product"
            : null;
      return {
        product,
        species,
        majorCategoryKey,
        hiddenReason,
        displayCap: cap,
      };
    })
    .sort((left, right) =>
      (left.species?.name ?? "").localeCompare(right.species?.name ?? "", "zh-CN") ||
      left.product.name.localeCompare(right.product.name, "zh-CN")
    ), [majorMap, normalizedDraft, speciesById, state.products]);

  const activeProductSummaries = productSummaries.filter((summary) => !summary.product.archivedAt);

  const filteredSpecies = useMemo(() => state.species
    .filter((species) => includesSearch([
      species.name,
      species.scientificName,
      species.category,
      ...(species.commonNames ?? []),
    ], speciesSearch))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")), [speciesSearch, state.species]);

  const filteredProducts = useMemo(() => activeProductSummaries.filter((summary) => {
    if (!includesSearch([
      summary.product.name,
      summary.product.size,
      summary.product.origin,
      summary.species?.name,
      summary.species?.scientificName,
      summary.species?.category,
    ], productSearch)) return false;
    if (productFilter === "hidden") return Boolean(summary.hiddenReason);
    if (productFilter === "limited") return getPublicCatalogProductDisplayCap(normalizedDraft, summary.product.id) !== undefined;
    return true;
  }), [activeProductSummaries, normalizedDraft.productDisplayCaps, productFilter, productSearch]);

  const clampedSpeciesPage = Math.min(speciesPage, Math.max(1, Math.ceil(filteredSpecies.length / PAGE_SIZE)));
  const clampedProductPage = Math.min(productPage, Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE)));
  const visibleSpecies = filteredSpecies.slice((clampedSpeciesPage - 1) * PAGE_SIZE, clampedSpeciesPage * PAGE_SIZE);
  const visibleProducts = filteredProducts.slice((clampedProductPage - 1) * PAGE_SIZE, clampedProductPage * PAGE_SIZE);

  const updateHidden = (
    key: "hiddenMajorCategoryKeys" | "hiddenProductIds" | "hiddenSpeciesIds",
    id: string,
    hidden: boolean
  ) => {
    if (!canEdit || saving) return;
    setDraft((current) => ({
      ...current,
      [key]: hidden
        ? [...new Set([...current[key], id])]
        : current[key].filter((item) => item !== id),
    }));
  };

  const updateProductCap = (productId: string, value: string) => {
    if (!canEdit || saving) return;
    const parsed = Number(value);
    setDraft((current) => {
      const entries = Object.entries(current.productDisplayCaps)
        .filter(([existingProductId]) => existingProductId !== productId);
      if (value.trim() && parsed !== 0 && Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_PUBLIC_CATALOG_DISPLAY_CAP) {
        entries.push([productId, parsed]);
      }
      const caps = Object.fromEntries(entries);
      return { ...current, productDisplayCaps: caps };
    });
  };

  const resetDraft = () => setDraft(copyPublicCatalogPolicy(baselinePolicy));
  const loadLatestPolicy = () => {
    const latestPolicy = copyPublicCatalogPolicy(savedPolicy);
    setBaselinePolicy(latestPolicy);
    setDraft(copyPublicCatalogPolicy(latestPolicy));
    setRemotePolicyChanged(false);
    lastSeenSavedPolicyFingerprint.current = savedPolicyFingerprint;
  };
  const clearAllRules = () => setDraft(copyPublicCatalogPolicy(undefined));

  const save = async () => {
    if (saving || !canEdit) return;
    if (remotePolicyChanged) {
      toast.error("鱼单规则已被其他管理员更新，请先载入最新规则再修改");
      return;
    }
    const nextPolicy = normalizePublicCatalogPolicy(draft);
    if (!confirmWrite("修改", "保存鱼单展示规则；新的公开网站和小程序请求会立即按新规则生成目录和库存数量。")) return;
    setSaving(true);
    const ok = await saveStateTransform((latest) => ({
      ...latest,
      publicCatalogPolicy: nextPolicy,
    }));
    setSaving(false);
    if (!ok) return toast.error("鱼单规则未保存。可能已有其他管理员更新，请刷新页面后重新确认");
    const storedPolicy = copyPublicCatalogPolicy(nextPolicy);
    setBaselinePolicy(storedPolicy);
    setDraft(copyPublicCatalogPolicy(storedPolicy));
    setRemotePolicyChanged(false);
    lastSeenSavedPolicyFingerprint.current = publicCatalogPolicyFingerprint(storedPolicy);
    toast.success("鱼单规则已保存；新请求立即生效，已打开的公开页面和小程序会在约 1 分钟内刷新");
  };

  if (!canEdit) {
    return <div className="p-6 text-sm text-muted-foreground">鱼单规则为全局配置，仅管理员可以访问。</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3 sm:p-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 pb-8">
        <header className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ListFilter className="size-5 text-teal-700" />
              <h1 className="text-xl font-semibold text-foreground">鱼单管理</h1>
              {changed && <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">有未保存修改</Badge>}
            </div>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              控制客户在公开网站和小程序看到的类型、物种、商品和库存数量。规则对所有场地生效。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" className="!min-h-[44px] sm:!min-h-9" onClick={resetDraft} disabled={!changed || saving}>
              <RotateCcw className="size-4" />撤销修改
            </Button>
            <Button
              type="button"
              variant="outline"
              className="!min-h-[44px] sm:!min-h-9"
              onClick={clearAllRules}
              disabled={!canEdit || saving || policyRuleCount(normalizedDraft) === 0}
            >
              清空规则
            </Button>
            <Button type="button" className="!min-h-[44px] sm:!min-h-9" onClick={() => void save()} disabled={!canEdit || !changed || saving || remotePolicyChanged}>
              <Save className="size-4" />{saving ? "保存中…" : "保存规则"}
            </Button>
          </div>
        </header>

        {remotePolicyChanged && (
          <section className="flex flex-col gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 sm:flex-row sm:items-center sm:justify-between" role="alert">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <div className="text-sm font-semibold">鱼单规则已被其他管理员更新</div>
                <p className="mt-0.5 text-xs leading-5">你的未保存草稿仍保留。为避免覆盖他人的修改，请载入最新规则后重新确认。</p>
              </div>
            </div>
            <Button type="button" variant="outline" className="!min-h-[44px] border-amber-400 bg-white hover:bg-amber-100 sm:!min-h-9" onClick={loadLatestPolicy}>
              载入最新规则
            </Button>
          </section>
        )}

        <section className="overflow-hidden rounded-md border bg-card" aria-label="已设置的鱼单规则概览">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">已设置的鱼单规则</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">下列设置统一控制公开网站和小程序鱼单中的展示范围与库存数量</p>
            </div>
            <Badge variant="outline">规则全局生效</Badge>
          </div>
          <div className="grid divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 xl:grid-cols-4" aria-live="polite">
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">隐藏类型</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{normalizedDraft.hiddenMajorCategoryKeys.length} 个</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">隐藏物种</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{normalizedDraft.hiddenSpeciesIds.length} 个</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">直接隐藏商品</div>
              <div className="mt-1 text-lg font-semibold tabular-nums">{normalizedDraft.hiddenProductIds.length} 款</div>
            </div>
            <div className="px-4 py-3">
              <div className="text-xs text-muted-foreground">设置数量上限</div>
              <div className="mt-1 text-lg font-semibold tabular-nums text-teal-800">{Object.keys(normalizedDraft.productDisplayCaps).length} 款</div>
            </div>
          </div>
        </section>

        <Tabs
          value={activeRuleTab}
          onValueChange={(value) => setActiveRuleTab(value as CatalogRuleTab)}
          className="gap-4"
        >
          <TabsList
            className="h-auto w-full justify-start overflow-x-auto rounded-md border bg-muted/50 p-1 sm:w-fit"
            aria-label="鱼单规则设置方式"
          >
            <TabsTrigger
              value="major"
              className="!min-h-[44px] rounded-md px-3 text-muted-foreground hover:bg-background/70 hover:text-foreground data-[state=active]:bg-primary data-[state=active]:font-semibold data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm dark:data-[state=active]:bg-primary dark:data-[state=active]:text-primary-foreground sm:!min-h-9"
            >
              按类型
              <span className={`min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] ${activeRuleTab === "major" ? "bg-primary-foreground/15 text-primary-foreground" : "bg-background text-muted-foreground"}`}>
                {normalizedDraft.hiddenMajorCategoryKeys.length}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="species"
              className="!min-h-[44px] rounded-md px-3 text-muted-foreground hover:bg-background/70 hover:text-foreground data-[state=active]:bg-primary data-[state=active]:font-semibold data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm dark:data-[state=active]:bg-primary dark:data-[state=active]:text-primary-foreground sm:!min-h-9"
            >
              按物种
              <span className={`min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] ${activeRuleTab === "species" ? "bg-primary-foreground/15 text-primary-foreground" : "bg-background text-muted-foreground"}`}>
                {normalizedDraft.hiddenSpeciesIds.length}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="product"
              className="!min-h-[44px] rounded-md px-3 text-muted-foreground hover:bg-background/70 hover:text-foreground data-[state=active]:bg-primary data-[state=active]:font-semibold data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm dark:data-[state=active]:bg-primary dark:data-[state=active]:text-primary-foreground sm:!min-h-9"
            >
              按商品
              <span className={`min-w-5 rounded-full px-1.5 py-0.5 text-center text-[11px] ${activeRuleTab === "product" ? "bg-primary-foreground/15 text-primary-foreground" : "bg-background text-muted-foreground"}`}>
                {uniqueCount([
                  ...normalizedDraft.hiddenProductIds,
                  ...Object.keys(normalizedDraft.productDisplayCaps),
                ])}
              </span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="major">
            <section className="overflow-hidden rounded-md border bg-card">
              <div className="border-b px-4 py-3">
                <h2 className="font-semibold">类型展示</h2>
                <p className="mt-1 text-sm text-muted-foreground">类型指海水鱼、珊瑚、无脊椎和耗材。关闭后，其下所有物种、商品和库存都不会对外展示。</p>
              </div>
              <div className="divide-y">
                {SPECIES_MAJOR_CATEGORIES.map((category) => {
                  const hidden = normalizedDraft.hiddenMajorCategoryKeys.includes(category.key);
                  const summaries = activeProductSummaries.filter((summary) => summary.majorCategoryKey === category.key);
                  const speciesCount = state.species.filter((species) =>
                    (majorMap[species.category] ?? "marineFish") === category.key
                  ).length;
                  return (
                    <div key={category.key} className="flex min-h-16 items-center gap-3 px-4 py-3">
                      <div className={`flex size-9 shrink-0 items-center justify-center rounded-md ${hidden ? "bg-muted text-muted-foreground" : "bg-teal-50 text-teal-800"}`}>
                        {hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{category.label}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{speciesCount} 个物种 · {summaries.length} 款商品</div>
                      </div>
                      <label className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-end gap-2 text-sm sm:min-w-0">
                        <span className="hidden text-muted-foreground sm:inline">{hidden ? "已隐藏" : "展示"}</span>
                        <Switch
                          checked={!hidden}
                          onCheckedChange={(visible) => updateHidden("hiddenMajorCategoryKeys", category.key, !visible)}
                          disabled={!canEdit || saving}
                          aria-label={`${category.label}对外${hidden ? "已隐藏" : "展示"}`}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </section>
          </TabsContent>

          <TabsContent value="species">
            <section className="overflow-hidden rounded-md border bg-card">
              <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold">物种展示</h2>
                  <p className="mt-1 text-sm text-muted-foreground">按名称、俗名或学名查找；上级类型关闭时仍以类型规则为准。</p>
                </div>
                <SearchField
                  value={speciesSearch}
                  onChange={(value) => { setSpeciesSearch(value); setSpeciesPage(1); }}
                  placeholder="搜索物种、俗名或学名"
                  label="搜索物种"
                />
              </div>
              {visibleSpecies.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">没有符合条件的物种。</div>
              ) : (
                <div className="divide-y">
                  {visibleSpecies.map((species) => {
                    const majorKey = majorMap[species.category] ?? "marineFish";
                    const parentHidden = normalizedDraft.hiddenMajorCategoryKeys.includes(majorKey);
                    const hidden = normalizedDraft.hiddenSpeciesIds.includes(species.id);
                    return (
                      <div key={species.id} className="flex min-h-16 items-center gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{species.name}</span>
                            <Badge variant="outline">{species.category || "未分类"}</Badge>
                            {parentHidden && <Badge variant="secondary">所属类型已隐藏</Badge>}
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {[species.scientificName, ...(species.commonNames ?? []).slice(0, 2)].filter(Boolean).join(" · ") || "暂无别名或学名"}
                          </div>
                        </div>
                        <label className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-end gap-2 text-sm sm:min-w-0">
                          <span className="hidden text-muted-foreground sm:inline">{hidden ? "已隐藏" : "展示"}</span>
                          <Switch
                            checked={!hidden}
                            onCheckedChange={(visible) => updateHidden("hiddenSpeciesIds", species.id, !visible)}
                            disabled={!canEdit || saving}
                            aria-label={`${species.name}对外${hidden ? "已隐藏" : "展示"}`}
                          />
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
              <PageNavigator page={clampedSpeciesPage} totalItems={filteredSpecies.length} onChange={setSpeciesPage} />
            </section>
          </TabsContent>

          <TabsContent value="product">
            <section className="overflow-hidden rounded-md border bg-card">
              <div className="flex flex-col gap-3 border-b px-4 py-3 xl:flex-row xl:items-center xl:justify-between">
                <div>
                  <h2 className="font-semibold">商品展示与库存上限</h2>
                  <p className="mt-1 text-sm text-muted-foreground">留空表示显示全部，填写正整数后只显示该数量；0 会清除数量限制。</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <label className="fishroom-control flex h-[44px] items-center rounded-md border bg-background px-2 sm:h-9">
                    <span className="sr-only">筛选商品规则</span>
                    <select
                      value={productFilter}
                      onChange={(event) => { setProductFilter(event.target.value as typeof productFilter); setProductPage(1); }}
                      className="h-full bg-transparent text-sm outline-none"
                      aria-label="筛选商品规则"
                    >
                      <option value="all">全部商品</option>
                      <option value="hidden">当前隐藏</option>
                      <option value="limited">已设数量</option>
                    </select>
                  </label>
                  <SearchField
                    value={productSearch}
                    onChange={(value) => { setProductSearch(value); setProductPage(1); }}
                    placeholder="搜索商品、物种、产地"
                    label="搜索商品"
                  />
                </div>
              </div>

              {visibleProducts.length === 0 ? (
                <div className="px-4 py-12 text-center text-sm text-muted-foreground">没有符合条件的商品。</div>
              ) : (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <table className="w-full min-w-[720px] table-fixed text-sm">
                      <thead className="bg-muted/50 text-left">
                        <tr>
                          <th className="px-4 py-3 font-semibold">商品</th>
                          <th className="w-40 px-4 py-3 text-center font-semibold">生效状态</th>
                          <th className="w-48 px-4 py-3 text-center font-semibold">显示数量上限</th>
                          <th className="w-28 px-4 py-3 text-center font-semibold">鱼单展示</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {visibleProducts.map((summary) => {
                          const productHidden = normalizedDraft.hiddenProductIds.includes(summary.product.id);
                          const cap = getPublicCatalogProductDisplayCap(normalizedDraft, summary.product.id);
                          const inheritedHidden = summary.hiddenReason === "major" || summary.hiddenReason === "species";
                          return (
                            <tr key={summary.product.id}>
                              <td className="px-4 py-3">
                                <div className="font-medium">{summary.product.name}</div>
                                <div className="mt-1 truncate text-xs text-muted-foreground">
                                  {[summary.species?.name, summary.species?.category, summary.product.size, summary.product.origin].filter(Boolean).join(" · ")}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-center"><RuleStateBadge summary={summary} /></td>
                              <td className="px-4 py-3">
                                <div className="flex items-center justify-center gap-2">
                                  <ProductCapInput
                                    value={cap}
                                    onCommit={(value) => updateProductCap(summary.product.id, value)}
                                    className="w-24 text-center tabular-nums"
                                    disabled={!canEdit || saving || productHidden || inheritedHidden}
                                    ariaLabel={`${summary.product.name}显示数量上限`}
                                  />
                                  {cap && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      onClick={() => updateProductCap(summary.product.id, "")}
                                      disabled={!canEdit || saving}
                                      aria-label={`清除${summary.product.name}显示数量上限`}
                                      title="恢复显示全部"
                                    >
                                      <X className="size-4" />
                                    </Button>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <Switch
                                  checked={!productHidden}
                                  onCheckedChange={(visible) => updateHidden("hiddenProductIds", summary.product.id, !visible)}
                                  disabled={!canEdit || saving}
                                  aria-label={`${summary.product.name}${productHidden ? "不在鱼单展示" : "在鱼单展示"}`}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="divide-y md:hidden">
                    {visibleProducts.map((summary) => {
                      const productHidden = normalizedDraft.hiddenProductIds.includes(summary.product.id);
                      const cap = getPublicCatalogProductDisplayCap(normalizedDraft, summary.product.id);
                      const inheritedHidden = summary.hiddenReason === "major" || summary.hiddenReason === "species";
                      return (
                        <div key={summary.product.id} className="p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-medium">{summary.product.name}</div>
                              <div className="mt-1 text-xs text-muted-foreground">{[summary.species?.name, summary.product.size, summary.product.origin].filter(Boolean).join(" · ")}</div>
                            </div>
                            <label className="flex min-h-[44px] shrink-0 items-center justify-end gap-2 text-sm">
                              <span className="text-muted-foreground">{productHidden ? "不在鱼单" : "在鱼单"}</span>
                              <Switch
                                checked={!productHidden}
                                onCheckedChange={(visible) => updateHidden("hiddenProductIds", summary.product.id, !visible)}
                                disabled={!canEdit || saving}
                                aria-label={`${summary.product.name}${productHidden ? "不在鱼单展示" : "在鱼单展示"}`}
                              />
                            </label>
                          </div>
                          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                            <RuleStateBadge summary={summary} />
                          </div>
                          <div className="mt-3 flex items-center gap-2">
                            <label className="shrink-0 text-sm text-muted-foreground" htmlFor={`product-cap-${summary.product.id}`}>显示上限</label>
                            <ProductCapInput
                              id={`product-cap-${summary.product.id}`}
                              value={cap}
                              onCommit={(value) => updateProductCap(summary.product.id, value)}
                              className="max-w-32 text-center tabular-nums"
                              disabled={!canEdit || saving || productHidden || inheritedHidden}
                              ariaLabel={`${summary.product.name}显示数量上限`}
                            />
                            {cap && (
                              <Button type="button" variant="ghost" size="sm" className="!min-h-[44px]" onClick={() => updateProductCap(summary.product.id, "")} disabled={!canEdit || saving}>
                                清除
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              <PageNavigator page={clampedProductPage} totalItems={filteredProducts.length} onChange={setProductPage} />
            </section>
          </TabsContent>
        </Tabs>

        <section className="rounded-md border bg-card px-4 py-4" aria-labelledby="catalog-fill-rule-title">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-teal-50 text-teal-800">
              <ImageIcon className="size-4" />
            </div>
            <div className="min-w-0">
              <h2 id="catalog-fill-rule-title" className="font-semibold">限量展示与自动补位</h2>
              <p className="mt-1 max-w-4xl text-sm leading-6 text-muted-foreground">
                商品设定显示上限后，先选有维护照片或视频的库存，再按最新维护时间排序；同时刻的库存随机选择，剩余名额按库存顺序补足。库存出库、售出、损耗或变为病鱼后，系统会在下一次公开鱼单请求时自动补位，不需要重新保存规则。
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
