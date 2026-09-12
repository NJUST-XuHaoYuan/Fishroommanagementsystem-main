import { useEffect, useMemo, useState } from "react";
import { useStore, PurchaseBatch, uid } from "../store";
import { DataTable } from "./common";
import { Button } from "./ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "./ui/alert-dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { toast } from "sonner";
import { readAndCompressImage } from "../utils/imageUtils";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { authJsonHeaders } from "../utils/authSession";
import { BatchDetailsView } from "./BatchDetailsView";

type BatchDetailRequest = { batchId: string; siteId: string };
type BatchesViewProps = {
  onOpenOrder?: (orderId: string, siteId?: string) => void;
  detailRequest?: BatchDetailRequest | null;
  onDetailRequestChange?: (request: BatchDetailRequest | null) => void;
};

type BatchRevenueMetric = {
  batchId: string;
  earliestStockInDate?: string;
  salesNet: number;
  pendingReceived: number;
  verifiedReceived: number;
  platformReceived: number;
  gross: number;
  discount: number;
  refundAdjustment: number;
  itemCount: number;
  orderCount: number;
  platformOrderCount: number;
};

type BatchRevenueResponse = {
  ok: boolean;
  metrics?: BatchRevenueMetric[];
  diagnostics?: {
    unassignedItemCount?: number;
    unassignedSalesNet?: number;
  };
  error?: string;
};

const EMPTY_SALES_STATS: BatchRevenueMetric = {
  batchId: "",
  salesNet: 0,
  pendingReceived: 0,
  verifiedReceived: 0,
  platformReceived: 0,
  gross: 0,
  discount: 0,
  refundAdjustment: 0,
  itemCount: 0,
  orderCount: 0,
  platformOrderCount: 0,
};

function money(value: number) {
  const amount = Number.isFinite(value) ? value : 0;
  return `${amount < 0 ? "-" : ""}¥${Math.abs(amount).toFixed(2)}`;
}

export function BatchesView({ onOpenOrder, detailRequest, onDetailRequestChange }: BatchesViewProps = {}) {
  const { state, activeSiteId, saveStateTransform } = useStore();
  const [localDetailRequest, setLocalDetailRequest] = useState<BatchDetailRequest | null>(null);
  const requestedDetail = detailRequest === undefined ? localDetailRequest : detailRequest;
  const openFishDetails = (request: BatchDetailRequest | null) => {
    setLocalDetailRequest(request);
    onDetailRequestChange?.(request);
  };
  const [editing, setEditing] = useState<PurchaseBatch | null>(null);
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<PurchaseBatch | null>(null);
  const [detail, setDetail] = useState<PurchaseBatch | null>(null);
  const [proofPreview, setProofPreview] = useState<{ url: string; title: string } | null>(null);
  const [revenueMetrics, setRevenueMetrics] = useState<BatchRevenueMetric[] | null>(null);
  const [loadedRevenueScopeKey, setLoadedRevenueScopeKey] = useState("");
  const [revenueLoading, setRevenueLoading] = useState(true);
  const [revenueError, setRevenueError] = useState("");
  const [revenueRetry, setRevenueRetry] = useState(0);
  const [revenueDiagnostics, setRevenueDiagnostics] = useState<BatchRevenueResponse["diagnostics"]>();
  const permission = usePermission("batches");

  const today = new Date().toISOString().slice(0, 10);

  const generateBatchNo = () => {
    const year = new Date().getFullYear();
    const existingNos = state.batches
      .map(b => b.batchNo)
      .filter(no => no.startsWith(`PO-${year}-`))
      .map(no => parseInt(no.split('-')[2]) || 0);
    const maxNo = existingNos.length > 0 ? Math.max(...existingNos) : 0;
    return `PO-${year}-${String(maxNo + 1).padStart(3, '0')}`;
  };

  const empty = (): PurchaseBatch => ({
    id: "",
    createdAt: new Date().toISOString(),
    batchNo: generateBatchNo(),
    supplier: "",
    arrivalDate: today,
    bioFee: 0,
    shippingFee: 0,
    stockedCount: 0,
    lossCount: 0,
    lossProof: [],
    commissionMultiplier: 100,
    notes: "",
  });

  const totalCost = (batch: PurchaseBatch) => (batch.bioFee + batch.shippingFee).toFixed(2);
  const lossProofs = (batch: PurchaseBatch | null) =>
    Array.isArray(batch?.lossProof) ? batch.lossProof : [];
  const batchMetricKey = useMemo(
    () => state.batches.map((batch) => batch.id).sort().join("\0"),
    [state.batches]
  );
  const revenueScopeKey = `${activeSiteId}\0${batchMetricKey}`;

  useEffect(() => {
    setRevenueMetrics(null);
    setLoadedRevenueScopeKey("");
    setRevenueDiagnostics(undefined);
    setRevenueError("");
  }, [activeSiteId, batchMetricKey]);

  useEffect(() => {
    const controller = new AbortController();
    setRevenueLoading(true);
    setRevenueError("");
    fetch(`/api/batches/revenue-metrics?siteId=${encodeURIComponent(activeSiteId)}`, {
      headers: authJsonHeaders(),
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as BatchRevenueResponse;
        if (!response.ok || !result.ok) {
          throw new Error(result.error || `HTTP ${response.status}`);
        }
        return result;
      })
      .then((result) => {
        if (controller.signal.aborted) return;
        setRevenueMetrics(Array.isArray(result.metrics) ? result.metrics : []);
        setLoadedRevenueScopeKey(revenueScopeKey);
        setRevenueDiagnostics(result.diagnostics);
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        console.error("Failed to load batch revenue metrics:", error);
        setRevenueError(error instanceof Error ? error.message : "采购批次回款加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setRevenueLoading(false);
      });
    return () => controller.abort();
  }, [activeSiteId, batchMetricKey, revenueRetry, revenueScopeKey]);

  useEffect(() => {
    const refresh = () => setRevenueRetry((value) => value + 1);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 60_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const batchSalesStats = useMemo(
    () => new Map((revenueMetrics ?? []).map((metric) => [metric.batchId, metric])),
    [revenueMetrics]
  );
  const revenueAvailable = revenueMetrics !== null && loadedRevenueScopeKey === revenueScopeKey;
  const salesStats = (batchId: string) =>
    revenueAvailable ? batchSalesStats.get(batchId) ?? EMPTY_SALES_STATS : EMPTY_SALES_STATS;
  const earliestStockInDate = (batchId: string) => salesStats(batchId).earliestStockInDate;
  const maxArrivalDate = editing?.id ? earliestStockInDate(editing.id) : undefined;
  const arrivalDateMax = maxArrivalDate && maxArrivalDate < today ? maxArrivalDate : today;
  const arrivalDateConstraintUnavailable = Boolean(editing?.id) &&
    (!revenueAvailable || revenueLoading || Boolean(revenueError));
  const metricText = (batchId: string, key: "salesNet" | "pendingReceived" | "verifiedReceived") => {
    if (!revenueAvailable) return "—";
    return money(salesStats(batchId)[key]);
  };

  const save = async () => {
    if (!editing) return;
    if (!permission.requirePermission(editing.id ? "update" : "create")) return;
    if (!editing.supplier.trim()) return toast.error("请填写供应商");
    if (!editing.arrivalDate) return toast.error("请选择到货日期");
    if (editing.arrivalDate > today) return toast.error("到货日期不能晚于今天");
    if (maxArrivalDate && editing.arrivalDate > maxArrivalDate) return toast.error("到货日期不能晚于该批次最早入库日期");
    const finalEditing = { ...editing, commissionMultiplier: 100 };
    if (!confirmWrite(editing.id ? "修改" : "新增", editing.id ? "将保存采购批次的修改。" : "将新增一个采购批次。")) return;
    const ok = await saveStateTransform((latest) => {
      const exists = latest.batches.find((b) => b.id === finalEditing.id);
      if (exists) return { ...latest, batches: latest.batches.map((b) => (b.id === finalEditing.id ? finalEditing : b)) };
      return {
        ...latest,
        batches: [...latest.batches, { ...finalEditing, id: uid(), createdAt: new Date().toISOString() }],
      };
    });
    if (!ok) return toast.error("保存失败，请重试");
    setOpen(false);
    toast.success("已保存");
  };

  if (requestedDetail && requestedDetail.siteId === activeSiteId) {
    return <BatchDetailsView key={`${requestedDetail.siteId}:${requestedDetail.batchId}`}
      batchId={requestedDetail.batchId} siteId={requestedDetail.siteId}
      onBack={() => openFishDetails(null)} onOpenOrder={onOpenOrder} />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>采购批次管理</h2>
        <p className="text-sm text-muted-foreground">
          销售净额不含运费和包装费；平台账单匹配后，平台收入计入已核销回款（不扣平台费用）
        </p>
      </div>
      {revenueError && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800 sm:flex-row sm:items-center sm:justify-between">
          <span>
            {revenueAvailable ? "批次回款刷新失败，当前显示上次成功数据" : "批次回款加载失败，当前金额暂不展示"}：{revenueError}
          </span>
          <Button size="sm" variant="outline" onClick={() => setRevenueRetry((value) => value + 1)}>
            重新加载
          </Button>
        </div>
      )}
      {!revenueError && Number(revenueDiagnostics?.unassignedItemCount ?? 0) > 0 && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          有 {revenueDiagnostics?.unassignedItemCount} 条历史订单商品缺少采购批次映射，销售净额 {money(Number(revenueDiagnostics?.unassignedSalesNet ?? 0))} 未计入下方批次。
        </div>
      )}
      <DataTable
        data={state.batches}
        searchKeys={["batchNo", "supplier", "arrivalDate"]}
        searchPlaceholder="搜索批次号、供应商..."
        onAdd={permission.canCreate ? () => { setEditing(empty()); setOpen(true); } : undefined}
        addLabel="新增批次"
        tableMinWidth="960px"
        columns={[
          { key: "batchNo", title: "批次号", width: "8rem", render: (r) => <span className="whitespace-nowrap">{r.batchNo}</span> },
          {
            key: "supplier",
            title: <span className="whitespace-nowrap">供应商 / 备注</span>,
            width: "11rem",
            render: (r) => (
              <div className="min-w-36 max-w-48">
                <div className="whitespace-nowrap">{r.supplier}</div>
                {r.notes && <div className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{r.notes}</div>}
              </div>
            ),
          },
          { key: "arrivalDate", title: "到货日期", width: "7rem", render: (r) => <span className="whitespace-nowrap">{r.arrivalDate}</span> },
          {
            key: "totalCost",
            title: "采购成本",
            width: "7rem",
            render: (r) => (
              <span
                className="whitespace-nowrap tabular-nums"
                title={`生物 ${money(r.bioFee)} · 运输 ${money(r.shippingFee)}`}
              >
                {money(r.bioFee + r.shippingFee)}
              </span>
            ),
          },
          {
            key: "salesNet",
            title: <span className="whitespace-nowrap" title="商品售价减订单折扣和报损退款调整，不含运费与包装费">销售净额</span>,
            width: "7rem",
            render: (r) => <span className="whitespace-nowrap font-medium tabular-nums">{metricText(r.id, "salesNet")}</span>,
          },
          {
            key: "pendingReceived",
            title: <span className="whitespace-nowrap" title="订单中已登记但尚未核销的商品净回款；负数表示待核销退款">待核销回款</span>,
            width: "7rem",
            render: (r) => (
              <span className={`whitespace-nowrap font-medium tabular-nums ${salesStats(r.id).pendingReceived < 0 ? "text-red-700" : "text-amber-700"}`}>
                {metricText(r.id, "pendingReceived")}
              </span>
            ),
          },
          {
            key: "verifiedReceived",
            title: <span className="whitespace-nowrap" title="已核销收款减已核销退款；抖店匹配账单后采用平台收入">已核销回款</span>,
            width: "7rem",
            render: (r) => <span className="whitespace-nowrap font-medium text-emerald-700 tabular-nums">{metricText(r.id, "verifiedReceived")}</span>,
          },
          {
            key: "inventoryCounts",
            title: <span className="whitespace-nowrap">入库 / 报损</span>,
            width: "7rem",
            render: (r) => <span className="whitespace-nowrap">{r.stockedCount} / {r.lossCount} 条</span>,
          },
        ]}
        mobileRender={(row) => {
          const stats = salesStats(row.id);
          const pendingIsRefund = stats.pendingReceived < 0;
          return (
            <div className="grid gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-semibold text-foreground">{row.batchNo}</div>
                  <div className="mt-0.5 truncate text-sm text-muted-foreground">{row.supplier || "未填写供应商"}</div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{row.arrivalDate || "—"}</span>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <div className="text-xs text-muted-foreground">销售净额</div>
                <div className="mt-1 text-lg font-semibold tabular-nums">{metricText(row.id, "salesNet")}</div>
                <div className="batch-mobile-two-columns mt-3 grid grid-cols-2 gap-3 border-t pt-3">
                  <div>
                    <div className="text-xs text-muted-foreground">{pendingIsRefund ? "待核销退款" : "待核销回款"}</div>
                    <div className={`mt-1 font-medium tabular-nums ${pendingIsRefund ? "text-red-700" : "text-amber-700"}`}>
                      {metricText(row.id, "pendingReceived")}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">已核销回款</div>
                    <div className="mt-1 font-medium text-emerald-700 tabular-nums">{metricText(row.id, "verifiedReceived")}</div>
                  </div>
                </div>
              </div>
              <div className="batch-mobile-three-columns grid grid-cols-3 gap-2 text-xs">
                <div><span className="text-muted-foreground">采购成本</span><div className="mt-0.5 font-medium tabular-nums">{money(row.bioFee + row.shippingFee)}</div></div>
                <div><span className="text-muted-foreground">入库</span><div className="mt-0.5 font-medium">{row.stockedCount} 条</div></div>
                <div><span className="text-muted-foreground">报损</span><div className="mt-0.5 font-medium">{row.lossCount} 条</div></div>
              </div>
              {row.notes && <div className="line-clamp-2 text-xs text-muted-foreground">{row.notes}</div>}
            </div>
          );
        }}
        actions={(row) => (
          <div className="flex flex-wrap justify-end gap-2" onDoubleClick={(event) => event.stopPropagation()}>
            <Button size="sm" variant="outline" onClick={() => openFishDetails({ batchId: row.id, siteId: activeSiteId })}>批次明细</Button>
            <Button size="sm" variant="outline" onClick={() => setDetail(row)}>批次资料</Button>
            {permission.canUpdate && <Button size="sm" variant="outline" onClick={() => { setEditing({ ...row, lossProof: lossProofs(row) }); setOpen(true); }}>编辑</Button>}
            {permission.canDelete && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDel(row)}>删除</Button>}
          </div>
        )}
        onRowDoubleClick={(row) => openFishDetails({ batchId: row.id, siteId: activeSiteId })}
      />

      <Dialog open={!!detail} onOpenChange={(nextOpen) => !nextOpen && setDetail(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-2xl">
          <DialogHeader><DialogTitle>批次详情</DialogTitle></DialogHeader>
          {detail && (
            <div className="grid gap-4 py-2">
              {(() => {
                const stats = salesStats(detail.id);
                return (
                  <div className="rounded-lg border p-3">
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-md bg-muted/30 px-3 py-2.5">
                        <div className="text-xs text-muted-foreground">销售净额</div>
                        <div className="mt-1 text-lg font-semibold tabular-nums">{metricText(detail.id, "salesNet")}</div>
                      </div>
                      <div className="rounded-md bg-amber-50 px-3 py-2.5">
                        <div className="text-xs text-amber-800">{stats.pendingReceived < 0 ? "待核销退款" : "待核销回款"}</div>
                        <div className={`mt-1 text-lg font-semibold tabular-nums ${stats.pendingReceived < 0 ? "text-red-700" : "text-amber-800"}`}>
                          {metricText(detail.id, "pendingReceived")}
                        </div>
                      </div>
                      <div className="rounded-md bg-emerald-50 px-3 py-2.5">
                        <div className="text-xs text-emerald-800">已核销回款</div>
                        <div className="mt-1 text-lg font-semibold text-emerald-800 tabular-nums">{metricText(detail.id, "verifiedReceived")}</div>
                      </div>
                    </div>
                    {revenueAvailable ? (
                      <>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                          <span>销售商品：{stats.itemCount} 条</span>
                          <span>关联订单：{stats.orderCount} 单</span>
                          <span>折扣分摊：-{money(stats.discount)}</span>
                          <span>退款调整：-{money(stats.refundAdjustment)}</span>
                        </div>
                        {stats.platformOrderCount > 0 && (
                          <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                            已核销中含平台收入 {money(stats.platformReceived)}（{stats.platformOrderCount} 单，未扣平台费用）
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="mt-3 border-t pt-2 text-xs text-muted-foreground">
                        回款明细{revenueError ? "加载失败" : "加载中"}，暂不展示商品数、订单数、折扣及退款数据
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">批次号</Label>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">{detail.batchNo}</div>
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">到货日期</Label>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">{detail.arrivalDate || "—"}</div>
                </div>
              </div>
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">供应商</Label>
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm break-words">{detail.supplier || "—"}</div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">生物费用</Label>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">¥{detail.bioFee.toFixed(2)}</div>
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">运输费用</Label>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">¥{detail.shippingFee.toFixed(2)}</div>
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">合计费用</Label>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">¥{totalCost(detail)}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">入库数量</Label>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">{detail.stockedCount} 条</div>
                </div>
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">报损数量</Label>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">{detail.lossCount} 条</div>
                </div>
              </div>
              <div className="grid gap-2">
                <Label>报损凭证</Label>
                {lossProofs(detail).length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {lossProofs(detail).map((url, i) => (
                      <button
                        key={i}
                        type="button"
                        className="h-24 w-24 overflow-hidden rounded border bg-muted"
                        onClick={() => setProofPreview({ url, title: `${detail.batchNo} 报损凭证 ${i + 1}` })}
                      >
                        <ImageWithFallback src={url} alt={`报损凭证${i + 1}`} className="size-full object-cover" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-md border bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
                    暂无报损凭证
                  </div>
                )}
              </div>
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">备注</Label>
                <div className="min-h-16 rounded-md border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap">{detail.notes || "—"}</div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetail(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <DialogHeader><DialogTitle>{editing?.id ? "编辑批次" : "新增批次"}</DialogTitle></DialogHeader>
          {editing && (
            <div className="grid gap-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>批次号</Label>
                  <Input value={editing.batchNo} disabled className="bg-muted" />
                </div>
                <div className="grid gap-2">
                  <Label className="text-red-600">*到货日期</Label>
                  <Input
                    type="date"
                    value={editing.arrivalDate}
                    max={arrivalDateMax}
                    disabled={arrivalDateConstraintUnavailable}
                    title={arrivalDateConstraintUnavailable ? "最早入库日期尚未加载，暂不能修改到货日期" : undefined}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value && value > today) {
                        toast.error("到货日期不能晚于今天");
                        return;
                      }
                      if (maxArrivalDate && value > maxArrivalDate) {
                        toast.error("到货日期不能晚于该批次最早入库日期");
                        return;
                      }
                      setEditing({ ...editing, arrivalDate: value });
                    }}
                  />
                  {arrivalDateConstraintUnavailable && (
                    <p className="text-xs text-muted-foreground">最早入库日期尚未加载，其他信息仍可正常修改。</p>
                  )}
                </div>
              </div>
              <div className="grid gap-2">
                <Label className="text-red-600">*供应商</Label>
                <Input value={editing.supplier} onChange={(e) => setEditing({ ...editing, supplier: e.target.value })} placeholder="必填" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>生物费用(¥)</Label>
                  <Input type="number" value={editing.bioFee} onChange={(e) => setEditing({ ...editing, bioFee: Number(e.target.value) })} />
                </div>
                <div className="grid gap-2">
                  <Label>运输费用(¥)</Label>
                  <Input type="number" value={editing.shippingFee} onChange={(e) => setEditing({ ...editing, shippingFee: Number(e.target.value) })} />
                </div>
              </div>
              <div className="grid gap-2">
                <Label>合计费用: ¥{(editing.bioFee + editing.shippingFee).toFixed(2)}</Label>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>入库数量</Label>
                  <Input value={editing.stockedCount} disabled className="bg-muted" />
                </div>
                <div className="grid gap-2">
                  <Label>报损数量</Label>
                  <Input type="number" min="0" value={editing.lossCount} onChange={(e) => setEditing({ ...editing, lossCount: Math.max(0, Number(e.target.value)) })} />
                </div>
              </div>
              <div className="grid gap-2">
                <Label>报损凭证</Label>
                <div className="flex flex-wrap gap-2">
                  {lossProofs(editing).map((url, i) => (
                    <div key={i} className="relative w-20 h-20 border rounded">
                      <button
                        type="button"
                        className="block size-full overflow-hidden rounded"
                        onClick={() => setProofPreview({ url, title: `${editing.batchNo} 报损凭证 ${i + 1}` })}
                      >
                        <ImageWithFallback src={url} alt={`报损凭证${i+1}`} className="w-full h-full object-cover rounded" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing({ ...editing, lossProof: editing.lossProof.filter((_, idx) => idx !== i) })}
                        className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs"
                      >×</button>
                    </div>
                  ))}
                  <label className="w-20 h-20 border-2 border-dashed rounded flex items-center justify-center cursor-pointer hover:bg-muted">
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        files.forEach(async (file) => {
                          try {
                            const needsCompress = file.size > 10 * 1024 * 1024;
                            if (needsCompress) toast.info("图片较大，正在压缩…");
                            const url = await readAndCompressImage(file);
                            if (needsCompress) toast.success("压缩完成");
                            setEditing(prev => prev ? { ...prev, lossProof: [...lossProofs(prev), url] } : prev as PurchaseBatch);
                          } catch {
                            toast.error("图片处理失败，请重试");
                          }
                        });
                      }}
                    />
                    <span className="text-2xl text-muted-foreground">+</span>
                  </label>
                </div>
              </div>
              <div className="grid gap-2">
                <Label>备注</Label>
                <Textarea rows={2} value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
            <Button onClick={save}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!proofPreview} onOpenChange={(nextOpen) => !nextOpen && setProofPreview(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-4xl">
          <DialogHeader><DialogTitle>{proofPreview?.title ?? "报损凭证"}</DialogTitle></DialogHeader>
          {proofPreview && (
            <div className="flex max-h-[72vh] items-center justify-center overflow-hidden rounded-lg border bg-muted/30">
              <ImageWithFallback
                src={proofPreview.url}
                alt={proofPreview.title}
                className="max-h-[72vh] w-full object-contain"
              />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setProofPreview(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!del} onOpenChange={(o) => !o && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除批次</AlertDialogTitle>
            <AlertDialogDescription>确认删除批次「{del?.batchNo}」？</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={async () => {
              if (!del) return;
              if (!permission.requirePermission("delete")) return;
              if (!confirmWrite("删除", `将删除采购批次「${del.batchNo}」。`)) return;
              const deleteId = del.id;
              const ok = await saveStateTransform((latest) => ({ ...latest, batches: latest.batches.filter((b) => b.id !== deleteId) }));
              if (!ok) return toast.error("删除失败，请重试");
              setDel(null);
              toast.success("已删除");
            }}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
