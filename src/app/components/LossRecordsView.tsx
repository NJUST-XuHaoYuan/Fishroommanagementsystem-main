import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, StockLossRecord } from "../store";
import { DataTable } from "./common";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { CalendarDays, Check, ChevronDown, Eye, Image as ImageIcon, Search, X } from "lucide-react";
import { toast } from "sonner";
import { resolveMediaUrl } from "../utils/media";

type SearchOption = {
  value: string;
  label: string;
  description?: string;
  keywords?: string;
  imageUrl?: string;
};

function SearchableFilter({
  value,
  options,
  placeholder,
  searchPlaceholder,
  onChange,
}: {
  value: string;
  options: SearchOption[];
  placeholder: string;
  searchPlaceholder: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) =>
      [option.label, option.description, option.keywords]
        .some((part) => String(part ?? "").toLowerCase().includes(term))
    );
  }, [options, q]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const pick = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
    setQ("");
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-input-background px-3 py-2 text-left text-sm"
        onClick={() => {
          setOpen((next) => !next);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
      >
        <span className={selected && value !== "all" ? "truncate text-foreground" : "truncate text-muted-foreground"}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-md border bg-popover shadow-lg">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder={searchPlaceholder}
                className="h-8 pl-8 text-sm"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setOpen(false);
                    setQ("");
                  }
                }}
              />
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">无匹配结果</div>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent ${
                    option.value === value ? "bg-accent/60" : ""
                  }`}
                  onClick={() => pick(option.value)}
                >
                  <Check className={`size-3.5 shrink-0 ${option.value === value ? "text-sky-600 opacity-100" : "opacity-0"}`} />
                  {option.imageUrl && (
                    <div className="size-7 shrink-0 overflow-hidden rounded border bg-muted">
                      <ImageWithFallback src={option.imageUrl} alt="" className="size-full object-cover" />
                    </div>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description && (
                      <span className="block truncate text-xs text-muted-foreground">{option.description}</span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type LossRow = StockLossRecord & {
  productId: string;
  speciesId: string;
  batchId: string;
  subTankId: string;
  productName: string;
  productSize: string;
  productOrigin: string;
  speciesName: string;
  speciesScientificName: string;
  speciesCategory: string;
  speciesCommonNames: string;
  batchNo: string;
  supplier: string;
  arrivalDate: string;
  batchNotes: string;
  batchBioFee: number;
  batchShippingFee: number;
  tankName: string;
  tankGroupName: string;
  subTankName: string;
  tankLocation: string;
  inDate: string;
  basePrice: number;
  photos: string[];
  productSearch: string;
  batchSearch: string;
  tankSearch: string;
};

export function LossRecordsView() {
  const { state } = useStore();
  const [viewing, setViewing] = useState<LossRow | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [batchId, setBatchId] = useState("all");
  const [speciesId, setSpeciesId] = useState("all");
  const [productId, setProductId] = useState("all");
  const [subTankId, setSubTankId] = useState("all");
  const [proofStatus, setProofStatus] = useState("all");
  const now = new Date();
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");

  const product = (id: string) => state.products.find((p) => p.id === id);
  const species = (id: string) => state.species.find((s) => s.id === id);
  const batch = (id: string) => state.batches.find((b) => b.id === id);
  const stockItem = (id: string) => state.stock.find((s) => s.id === id);

  const changeStartDate = (value: string) => {
    if (value && value > today) {
      toast.error("开始日期不能晚于今天");
      return;
    }
    setStartDate(value);
    if (endDate && value && endDate < value) setEndDate("");
  };
  const changeEndDate = (value: string) => {
    if (value && value > today) {
      toast.error("结束日期不能晚于今天");
      return;
    }
    if (startDate && value && value < startDate) {
      toast.error("结束日期不能早于开始日期");
      return;
    }
    setEndDate(value);
  };

  const tankName = (subTankId: string) => {
    for (const group of state.tankGroups) {
      const tank = group.subTanks.find((t) => t.id === subTankId);
      if (tank) return `${group.name} / ${tank.name}`;
    }
    return "未知缸位";
  };

  const tankMeta = (subTankId: string, snapshot?: Partial<StockLossRecord>) => {
    for (const group of state.tankGroups) {
      const tank = group.subTanks.find((t) => t.id === subTankId);
      if (tank) {
        return {
          tankName: `${group.name} / ${tank.name}`,
          tankGroupName: group.name,
          subTankName: tank.name,
          tankLocation: group.location,
        };
      }
    }
    if (snapshot?.tankName || snapshot?.tankGroupName || snapshot?.subTankName || snapshot?.subTankId) {
      const tankName = snapshot.tankName
        || [snapshot.tankGroupName, snapshot.subTankName].filter(Boolean).join(" / ")
        || `已删除缸位（${snapshot.subTankId}）`;
      return {
        tankName,
        tankGroupName: snapshot.tankGroupName ?? "",
        subTankName: snapshot.subTankName ?? "",
        tankLocation: snapshot.tankLocation ?? "",
      };
    }
    return {
      tankName: "未知缸位",
      tankGroupName: "",
      subTankName: "",
      tankLocation: "",
    };
  };

  const rows = useMemo<LossRow[]>(() => {
    const explicitIds = new Set((state.lossRecords ?? []).map((r) => r.stockItemId));
    const fallbackRecords: StockLossRecord[] = state.stock
      .filter((item) => item.lost && !explicitIds.has(item.id))
      .map((item) => ({
        id: `loss-${item.id}`,
        stockItemId: item.id,
        date: item.lossDate ?? item.inDate,
        reason: item.lossReason ?? "",
        proofPhotos: item.lossProof ?? [],
        operator: "",
      }));

    return [...(state.lossRecords ?? []), ...fallbackRecords]
      .map((record) => {
        const item = stockItem(record.stockItemId);
        const p = item ? product(item.productId) : undefined;
        const sp = p ? species(p.speciesId) : undefined;
        const b = item ? batch(item.batchId) : undefined;
        const photos = record.proofPhotos?.length ? record.proofPhotos : item?.lossProof ?? [];
        const tank = record.subTankId
          ? tankMeta(record.subTankId, record)
          : item ? tankMeta(item.subTankId, record) : tankMeta("", record);
        const speciesCommonNames = sp?.commonNames?.join("、") ?? "";
        const productSearch = [
          p?.name,
          p?.size,
          p?.origin,
          sp?.name,
          sp?.scientificName,
          sp?.category,
          speciesCommonNames,
          item?.basePrice,
          item?.inDate,
        ].filter(Boolean).join(" ");
        const batchSearch = [
          b?.batchNo,
          b?.supplier,
          b?.arrivalDate,
          b?.bioFee,
          b?.shippingFee,
          b?.notes,
        ].filter(Boolean).join(" ");
        const tankSearch = [
          tank.tankName,
          tank.tankGroupName,
          tank.subTankName,
          tank.tankLocation,
        ].filter(Boolean).join(" ");
        return {
          ...record,
          productId: item?.productId ?? "",
          speciesId: p?.speciesId ?? "",
          batchId: item?.batchId ?? "",
          subTankId: record.subTankId ?? item?.subTankId ?? "",
          productName: p?.name ?? "未知商品",
          productSize: p?.size ?? "",
          productOrigin: p?.origin ?? "",
          speciesName: sp?.name ?? "",
          speciesScientificName: sp?.scientificName ?? "",
          speciesCategory: sp?.category ?? "",
          speciesCommonNames,
          batchNo: b?.batchNo ?? "未知批次",
          supplier: b?.supplier ?? "",
          arrivalDate: b?.arrivalDate ?? "",
          batchNotes: b?.notes ?? "",
          batchBioFee: b?.bioFee ?? 0,
          batchShippingFee: b?.shippingFee ?? 0,
          tankName: tank.tankName,
          tankGroupName: tank.tankGroupName,
          subTankName: tank.subTankName,
          tankLocation: tank.tankLocation,
          inDate: item?.inDate ?? "",
          basePrice: item?.basePrice ?? 0,
          photos,
          productSearch,
          batchSearch,
          tankSearch,
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [state.lossRecords, state.stock, state.products, state.species, state.batches, state.tankGroups]);

  const productOptions = useMemo(() => {
    const products = state.products.filter((p) => speciesId === "all" || p.speciesId === speciesId);
    return [
      { value: "all", label: "全部商品" },
      ...products.map((p) => {
        const sp = species(p.speciesId);
        return {
          value: p.id,
          label: p.name,
          description: [p.size, p.origin, sp?.name].filter(Boolean).join(" / "),
          keywords: [p.name, p.size, p.origin, sp?.name, sp?.scientificName, sp?.category, sp?.commonNames?.join(" ")].filter(Boolean).join(" "),
          imageUrl: p.imageUrl,
        };
      }),
    ];
  }, [speciesId, state.products, state.species]);
  const speciesOptions = useMemo(
    () => [
      { value: "all", label: "全部物种" },
      ...state.species.map((item) => ({
        value: item.id,
        label: item.name,
        description: [item.category, item.scientificName].filter(Boolean).join(" / "),
        keywords: [item.name, item.category, item.scientificName, item.commonNames.join(" ")].filter(Boolean).join(" "),
        imageUrl: item.imageUrl,
      })),
    ],
    [state.species]
  );
  const subTankOptions = useMemo(
    () => [
      { value: "all", label: "全部缸位" },
      ...state.tankGroups.flatMap((group) =>
        group.subTanks.map((tank) => ({
          value: tank.id,
          label: `${group.name} / ${tank.name}`,
          description: group.location || undefined,
          keywords: [group.name, tank.name, group.location].filter(Boolean).join(" "),
        }))
      ),
    ],
    [state.tankGroups]
  );
  const batchOptions = useMemo(
    () => [
      { value: "all", label: "全部批次" },
      ...[...state.batches]
        .sort((a, b) => {
          const byDate = b.arrivalDate.localeCompare(a.arrivalDate);
          return byDate || b.batchNo.localeCompare(a.batchNo);
        })
        .map((batch) => ({
          value: batch.id,
          label: batch.batchNo,
          description: `${batch.supplier || "未知供应商"} / ${batch.arrivalDate}`,
          keywords: [batch.batchNo, batch.supplier, batch.arrivalDate, batch.bioFee, batch.shippingFee, batch.notes].filter(Boolean).join(" "),
        })),
    ],
    [state.batches]
  );

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (startDate && row.date < startDate) return false;
      if (endDate && row.date > endDate) return false;
      if (batchId !== "all" && row.batchId !== batchId) return false;
      if (speciesId !== "all" && row.speciesId !== speciesId) return false;
      if (productId !== "all" && row.productId !== productId) return false;
      if (subTankId !== "all" && row.subTankId !== subTankId) return false;
      if (proofStatus === "with" && row.photos.length === 0) return false;
      if (proofStatus === "none" && row.photos.length > 0) return false;
      return true;
    });
  }, [batchId, endDate, productId, proofStatus, rows, speciesId, startDate, subTankId]);

  const hasFilters =
    !!startDate ||
    !!endDate ||
    batchId !== "all" ||
    speciesId !== "all" ||
    productId !== "all" ||
    subTankId !== "all" ||
    proofStatus !== "all";

  const resetFilters = () => {
    setStartDate("");
    setEndDate("");
    setBatchId("all");
    setSpeciesId("all");
    setProductId("all");
    setSubTankId("all");
    setProofStatus("all");
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>损耗记录</h2>
        <p className="text-sm text-muted-foreground">追溯每条损耗鱼的来源、缸位、原因和照片凭证</p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="font-medium">采购损耗筛选</div>
          <div className="flex items-center gap-2">
            <Button
              variant={startDate === today && endDate === today ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setStartDate(today);
                setEndDate(today);
              }}
            >
              <CalendarDays className="mr-1 size-3.5" />
              查看今日
            </Button>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                <X className="mr-1 size-3.5" />
                清除筛选
              </Button>
            )}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="grid gap-2">
            <Label>损耗开始日期</Label>
            <Input
              type="date"
              value={startDate}
              max={endDate && endDate < today ? endDate : today}
              onChange={(e) => changeStartDate(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>损耗结束日期</Label>
            <Input
              type="date"
              value={endDate}
              min={startDate || undefined}
              max={today}
              onChange={(e) => changeEndDate(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label>采购批次</Label>
            <SearchableFilter
              value={batchId}
              options={batchOptions}
              placeholder="全部批次"
              searchPlaceholder="搜批次号、供应商、到货日期..."
              onChange={setBatchId}
            />
          </div>
          <div className="grid gap-2">
            <Label>物种</Label>
            <SearchableFilter
              value={speciesId}
              options={speciesOptions}
              placeholder="全部物种"
              searchPlaceholder="搜物种、俗名、学名、分类..."
              onChange={(value) => {
                setSpeciesId(value);
                setProductId("all");
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label>商品 / 品种</Label>
            <SearchableFilter
              value={productId}
              options={productOptions}
              placeholder="全部商品"
              searchPlaceholder="搜商品、规格、产地、物种..."
              onChange={setProductId}
            />
          </div>
          <div className="grid gap-2">
            <Label>损耗缸位</Label>
            <SearchableFilter
              value={subTankId}
              options={subTankOptions}
              placeholder="全部缸位"
              searchPlaceholder="搜缸组、子缸、位置..."
              onChange={setSubTankId}
            />
          </div>
          <div className="grid gap-2">
            <Label>凭证状态</Label>
            <Select value={proofStatus} onValueChange={setProofStatus}>
              <SelectTrigger><SelectValue placeholder="全部" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="with">有照片凭证</SelectItem>
                <SelectItem value="none">缺少照片凭证</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <DataTable
        data={filteredRows}
        searchKeys={["date", "productSearch", "batchSearch", "tankSearch", "reason", "operator"]}
        searchPlaceholder="搜索日期、商品规格产地、物种俗名学名、批次供应商、缸位位置、原因..."
        pageSize={10}
        columns={[
          { key: "date", title: "损耗日期", width: "110px" },
          {
            key: "productName",
            title: "商品",
            render: (row) => (
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{row.productName}</span>
                <span className="text-xs text-muted-foreground">
                  {[row.productSize && `规格 ${row.productSize}`, row.productOrigin && `产地 ${row.productOrigin}`, `售价 ¥${row.basePrice.toFixed(2)}`].filter(Boolean).join(" / ")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[row.speciesName, row.speciesScientificName].filter(Boolean).join(" / ") || "未知物种"}
                </span>
                {row.speciesCommonNames && (
                  <span className="text-xs text-muted-foreground">俗名：{row.speciesCommonNames}</span>
                )}
              </div>
            ),
          },
          {
            key: "tankName",
            title: "损耗缸位",
            render: (row) => (
              <div className="flex flex-col">
                <span>{row.tankName}</span>
                {row.tankLocation && <span className="text-xs text-muted-foreground">{row.tankLocation}</span>}
              </div>
            ),
          },
          {
            key: "batchNo",
            title: "采购批次",
            render: (row) => (
              <div className="flex flex-col gap-0.5">
                <span>{row.batchNo}</span>
                <span className="text-xs text-muted-foreground">
                  {[row.supplier, row.arrivalDate].filter(Boolean).join(" / ") || "无供应商信息"}
                </span>
                <span className="text-xs text-muted-foreground">
                  货款 ¥{row.batchBioFee.toFixed(2)} / 运费 ¥{row.batchShippingFee.toFixed(2)}
                </span>
              </div>
            ),
          },
          {
            key: "reason",
            title: "原因",
            render: (row) => row.reason || <span className="text-muted-foreground">未填写</span>,
          },
          {
            key: "photos",
            title: "凭证",
            width: "90px",
            render: (row) => (
              <Badge variant={row.photos.length ? "secondary" : "destructive"} className="gap-1">
                <ImageIcon className="size-3" />
                {row.photos.length}
              </Badge>
            ),
          },
          {
            key: "operator",
            title: "操作人",
            width: "100px",
            render: (row) => row.operator || <span className="text-muted-foreground">未知</span>,
          },
        ]}
        actions={(row) => (
          <Button size="sm" variant="outline" onClick={() => setViewing(row)}>
            <Eye className="size-3.5 mr-1" />
            查看
          </Button>
        )}
      />

      <Dialog open={!!viewing} onOpenChange={(open) => !open && setViewing(null)}>
        <DialogContent aria-describedby={undefined} className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>损耗详情</DialogTitle>
          </DialogHeader>
          {viewing && (
            <div className="grid gap-4 py-2">
              <div className="grid gap-3 rounded-lg border p-4 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs text-muted-foreground">商品</div>
                  <div className="font-medium">{viewing.productName}</div>
                  <div className="text-xs text-muted-foreground">
                    {[viewing.productSize && `规格 ${viewing.productSize}`, viewing.productOrigin && `产地 ${viewing.productOrigin}`].filter(Boolean).join(" / ") || "-"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">物种</div>
                  <div>{viewing.speciesName || "-"}</div>
                  <div className="text-xs text-muted-foreground">
                    {[viewing.speciesCategory, viewing.speciesScientificName].filter(Boolean).join(" / ") || "-"}
                  </div>
                  {viewing.speciesCommonNames && (
                    <div className="text-xs text-muted-foreground">俗名：{viewing.speciesCommonNames}</div>
                  )}
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">损耗日期</div>
                  <div>{viewing.date}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">操作人</div>
                  <div>{viewing.operator || "未知"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">损耗缸位</div>
                  <div>{viewing.tankName}</div>
                  {viewing.tankLocation && <div className="text-xs text-muted-foreground">{viewing.tankLocation}</div>}
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">采购批次</div>
                  <div>{viewing.batchNo}{viewing.supplier ? ` / ${viewing.supplier}` : ""}</div>
                  <div className="text-xs text-muted-foreground">
                    {[viewing.arrivalDate, `货款 ¥${viewing.batchBioFee.toFixed(2)}`, `运费 ¥${viewing.batchShippingFee.toFixed(2)}`].filter(Boolean).join(" / ")}
                  </div>
                  {viewing.batchNotes && <div className="text-xs text-muted-foreground">备注：{viewing.batchNotes}</div>}
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">入库日期</div>
                  <div>{viewing.inDate || "-"}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">销售默认价</div>
                  <div>¥{viewing.basePrice.toFixed(2)}</div>
                </div>
              </div>

              <div className="rounded-lg border p-4 text-sm">
                <div className="mb-2 text-xs text-muted-foreground">损耗原因</div>
                <div className="whitespace-pre-wrap">{viewing.reason || "未填写"}</div>
              </div>

              <div className="rounded-lg border p-4">
                <div className="mb-3 text-sm font-medium">照片凭证</div>
                {viewing.photos.length === 0 ? (
                  <div className="text-sm text-muted-foreground">暂无照片凭证</div>
                ) : (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {viewing.photos.map((src, index) => (
                      <button
                        key={index}
                        type="button"
                        onClick={async () => {
                          const preview = window.open("about:blank", "_blank", "noopener,noreferrer");
                          try {
                            const url = await resolveMediaUrl(src);
                            if (preview && url) preview.location.href = url;
                            else if (url) window.open(url, "_blank", "noopener,noreferrer");
                          } catch {
                            preview?.close();
                            toast.error("照片打开失败，请刷新后重试");
                          }
                        }}
                        className="block aspect-square overflow-hidden rounded-md border bg-muted"
                      >
                        <ImageWithFallback src={src} alt={`损耗凭证 ${index + 1}`} className="size-full object-cover" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewing(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
