import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ClipboardCheck,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  InventoryAdjustmentDraft,
  InventoryAdjustmentLine,
  StockChangeRequest,
  StockItem,
  uid,
  useStore,
} from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { getInventoryHiddenStockIds, isVisibleInStockInventory } from "../utils/inventory";
import { orderItemKeepsInventory } from "../utils/stockOrders";
import { matchesSite } from "../utils/sites";
import { usePermission } from "../utils/permissions";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

type NormalizedAdjustment = {
  lines: InventoryAdjustmentLine[];
  addCount: number;
  removeCount: number;
  tankCount: number;
};

function formatDraftTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value.replace("T", " ").slice(0, 16)
    : date.toLocaleString("zh-CN", { hour12: false });
}

function normalizeAdjustmentLines(lines: InventoryAdjustmentLine[]): NormalizedAdjustment {
  const totals = new Map<string, { line: InventoryAdjustmentLine; delta: number }>();
  lines.forEach((line) => {
    const quantity = Number(line.quantity ?? 0);
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    const key = [line.subTankId, line.productId, line.batchId].join("\0");
    const current = totals.get(key) ?? { line, delta: 0 };
    current.delta += line.direction === "remove" ? -quantity : quantity;
    totals.set(key, current);
  });
  const normalized = [...totals.values()]
    .filter((item) => item.delta !== 0)
    .map(({ line, delta }) => ({
      ...line,
      id: line.id || uid("adjust-line"),
      direction: delta < 0 ? "remove" as const : "add" as const,
      quantity: Math.abs(delta),
    }));
  return {
    lines: normalized,
    addCount: normalized.filter((line) => line.direction === "add").reduce((sum, line) => sum + line.quantity, 0),
    removeCount: normalized.filter((line) => line.direction === "remove").reduce((sum, line) => sum + line.quantity, 0),
    tankCount: new Set(normalized.map((line) => line.subTankId)).size,
  };
}

export function InventoryAdjustmentDialog() {
  const { state, activeSiteId, setActiveSiteId, saveStockChange } = useStore();
  const permission = usePermission("stockIn");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [draft, setDraft] = useState<InventoryAdjustmentDraft | null>(null);
  const [lines, setLines] = useState<InventoryAdjustmentLine[]>([]);
  const [notes, setNotes] = useState("");
  const [submitPreview, setSubmitPreview] = useState<NormalizedAdjustment | null>(null);
  const [duplicateRequest, setDuplicateRequest] = useState<{
    payload: StockChangeRequest;
    createdAt?: string;
    status?: string;
  } | null>(null);

  const concreteSiteId = activeSiteId === "all" ? "" : activeSiteId;
  const siteGroups = useMemo(
    () => state.tankGroups.filter((group) => !concreteSiteId || matchesSite(group, concreteSiteId)),
    [concreteSiteId, state.tankGroups],
  );
  const tankOptions = useMemo(
    () => siteGroups.flatMap((group) => group.subTanks.map((tank) => ({
      id: tank.id,
      label: group.name === tank.name ? tank.name : `${group.name} / ${tank.name}`,
    }))),
    [siteGroups],
  );
  const siteBatches = useMemo(
    () => state.batches
      .filter((batch) => !concreteSiteId || matchesSite(batch, concreteSiteId))
      .sort((left, right) => right.arrivalDate.localeCompare(left.arrivalDate) || right.batchNo.localeCompare(left.batchNo)),
    [concreteSiteId, state.batches],
  );
  const products = useMemo(
    () => [...state.products].sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
    [state.products],
  );
  const hiddenStockIds = useMemo(
    () => getInventoryHiddenStockIds(state.shipments, state.orders),
    [state.orders, state.shipments],
  );
  const visibleStock = useMemo(
    () => state.stock.filter((item) => isVisibleInStockInventory(item, hiddenStockIds)),
    [hiddenStockIds, state.stock],
  );

  const stockCannotRemove = (item: StockItem) => {
    const shipmentLocked = state.shipments.some((shipment) =>
      shipment.status !== "preparing" && (shipment.itemStockIds ?? []).includes(item.id)
    );
    const orderLocked = state.orders.some((order) =>
      !["cancelled", "pending", "confirmed"].includes(order.status) &&
      order.items.some((orderItem) => orderItem.stockItemId === item.id && orderItemKeepsInventory(orderItem))
    );
    return shipmentLocked || orderLocked;
  };

  const removableStockForLine = (line: InventoryAdjustmentLine) => visibleStock
    .filter((item) =>
      item.subTankId === line.subTankId &&
      item.productId === line.productId &&
      item.batchId === line.batchId &&
      !stockCannotRemove(item)
    )
    .sort((left, right) => String(left.code || left.id).localeCompare(String(right.code || right.id), "zh-CN"));

  const defaultLine = (): InventoryAdjustmentLine => ({
    id: uid("adjust-line"),
    subTankId: tankOptions[0]?.id ?? "",
    productId: products[0]?.id ?? "",
    batchId: siteBatches[0]?.id ?? "",
    direction: permission.canCreate ? "add" : "remove",
    quantity: 1,
  });

  const loadDraft = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/stock/adjustment-draft", { headers: authJsonHeaders() });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "盘库草稿加载失败");
      const loaded = result.draft as InventoryAdjustmentDraft | null;
      if (!loaded && !concreteSiteId) {
        toast.error("请先在右上角选择具体场地，再开始盘库");
        return;
      }
      setDraft(loaded);
      setLines(Array.isArray(loaded?.lines) ? loaded.lines : []);
      setNotes(String(loaded?.notes ?? ""));
      if (loaded?.siteId && loaded.siteId !== activeSiteId) {
        setActiveSiteId(loaded.siteId);
        toast.info("已切换到草稿对应场地");
      }
      setOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "盘库草稿加载失败");
    } finally {
      setLoading(false);
    }
  };

  const saveDraft = async () => {
    if (!concreteSiteId) return toast.error("请选择具体场地");
    if (lines.length === 0) return toast.error("至少添加一条盘库调整");
    setSavingDraft(true);
    try {
      const response = await fetch("/api/stock/adjustment-draft", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({
          action: "save",
          draft: { id: draft?.id, siteId: concreteSiteId, lines, notes },
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "盘库草稿保存失败");
      setDraft(result.draft);
      toast.success("盘库进度已保存，下次打开会自动继续");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "盘库草稿保存失败");
    } finally {
      setSavingDraft(false);
    }
  };

  const discardDraft = async () => {
    setSavingDraft(true);
    try {
      const response = await fetch("/api/stock/adjustment-draft", {
        method: "POST",
        headers: authJsonHeaders(),
        body: JSON.stringify({ action: "delete" }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || "草稿清除失败");
      setDraft(null);
      setLines([]);
      setNotes("");
      toast.success("盘库草稿已清除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "草稿清除失败");
    } finally {
      setSavingDraft(false);
    }
  };

  const updateLine = (id: string, patch: Partial<InventoryAdjustmentLine>) => {
    setLines((current) => current.map((line) => line.id === id ? { ...line, ...patch } : line));
  };

  const validateLines = (): NormalizedAdjustment | null => {
    if (lines.length === 0) {
      toast.error("至少添加一条盘库调整");
      return null;
    }
    for (const line of lines) {
      if (!line.subTankId || !line.productId || !line.batchId) {
        toast.error("请补全每一行的缸位、商品和采购批次");
        return null;
      }
      if (!Number.isInteger(Number(line.quantity)) || Number(line.quantity) <= 0) {
        toast.error("调整数量必须是大于 0 的整数");
        return null;
      }
      if (line.direction === "add" && !permission.canCreate) {
        toast.error("当前账号没有新增库存权限");
        return null;
      }
      if (line.direction === "remove" && !permission.canDelete) {
        toast.error("当前账号没有删除库存权限");
        return null;
      }
    }
    const normalized = normalizeAdjustmentLines(lines);
    if (normalized.lines.length === 0) {
      toast.error("增减数量相互抵消，没有需要提交的调整");
      return null;
    }
    for (const line of normalized.lines.filter((item) => item.direction === "remove")) {
      const available = removableStockForLine(line).length;
      if (line.quantity > available) {
        const tank = tankOptions.find((item) => item.id === line.subTankId)?.label ?? line.subTankId;
        const product = products.find((item) => item.id === line.productId)?.name ?? line.productId;
        toast.error(`${tank} 的 ${product} 最多可减少 ${available} 条`);
        return null;
      }
    }
    return normalized;
  };

  const buildChangePayload = (normalized: NormalizedAdjustment): StockChangeRequest | null => {
    const upsert: StockItem[] = [];
    const deleteIds: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    for (const line of normalized.lines) {
      if (line.direction === "remove") {
        deleteIds.push(...removableStockForLine(line).slice(0, line.quantity).map((item) => item.id));
        continue;
      }
      const product = products.find((item) => item.id === line.productId);
      const batch = siteBatches.find((item) => item.id === line.batchId);
      const basePrice = Number(product?.defaultPrice ?? 0);
      if (!(basePrice > 0)) {
        toast.error(`${product?.name || "所选商品"}没有有效的默认售价，无法增加库存`);
        return null;
      }
      for (let index = 0; index < line.quantity; index += 1) {
        upsert.push({
          id: uid(),
          siteId: concreteSiteId,
          productId: line.productId,
          batchId: line.batchId,
          subTankId: line.subTankId,
          status: "healthy",
          inDate: batch?.arrivalDate || today,
          basePrice: Number(basePrice.toFixed(2)),
          commissionRate: 0,
          code: "",
          notes: notes.trim() ? `盘库增加：${notes.trim()}` : "盘库增加",
        });
      }
    }
    return {
      ...(upsert.length > 0 ? { upsert } : {}),
      ...(deleteIds.length > 0 ? { deleteIds } : {}),
      adjustmentContext: {
        kind: "inventory_adjustment",
        draftId: draft?.id,
        lines: normalized.lines,
      },
    };
  };

  const performSubmit = async (payload: StockChangeRequest, confirmDuplicate = false) => {
    if (submitting) return;
    setSubmitting(true);
    const result = await saveStockChange({ ...payload, confirmDuplicate });
    setSubmitting(false);
    if (result.duplicateConfirmationRequired) {
      setDuplicateRequest({
        payload,
        createdAt: result.duplicate?.createdAt,
        status: result.duplicate?.status,
      });
      return;
    }
    if (!result.ok) {
      toast.error(result.error || "盘库调整提交失败，请重试");
      return;
    }
    setDuplicateRequest(null);
    setSubmitPreview(null);
    setDraft(null);
    setLines([]);
    setNotes("");
    setOpen(false);
    toast.success(result.message || (result.pendingApproval ? "盘库调整已提交审批" : "盘库调整已执行"));
  };

  const confirmSubmit = () => {
    const normalized = submitPreview ?? validateLines();
    if (!normalized) return;
    const payload = buildChangePayload(normalized);
    if (!payload) return;
    setSubmitPreview(null);
    void performSubmit(payload);
  };

  const summary = useMemo(() => normalizeAdjustmentLines(lines), [lines]);

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => void loadDraft()} disabled={loading}>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <ClipboardCheck className="size-3.5" />}
        盘库调整
      </Button>

      <Dialog open={open} onOpenChange={(nextOpen) => {
        if (!submitting && !savingDraft) setOpen(nextOpen);
      }}>
        <DialogContent className="flex max-h-[92dvh] flex-col overflow-hidden sm:max-w-6xl">
          <DialogHeader>
            <DialogTitle>多缸盘库调整</DialogTitle>
            <DialogDescription>
              在同一张盘库单中登记多个缸位的增减，最后统一提交审批。
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            {draft && (
              <div className="flex flex-col gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  已自动载入唯一草稿，最后保存于 {formatDraftTime(draft.updatedAt)}。
                </div>
                <Button type="button" size="sm" variant="ghost" className="justify-start text-sky-800" onClick={() => void discardDraft()} disabled={savingDraft}>
                  <RotateCcw className="size-3.5" />清除草稿
                </Button>
              </div>
            )}

            <div className="grid grid-cols-3 divide-x rounded-md border bg-muted/25 text-center">
              <div className="px-2 py-2.5">
                <div className="text-xs text-muted-foreground">涉及缸位</div>
                <div className="mt-0.5 font-semibold">{summary.tankCount}</div>
              </div>
              <div className="px-2 py-2.5">
                <div className="text-xs text-muted-foreground">增加</div>
                <div className="mt-0.5 font-semibold text-emerald-700">+{summary.addCount}</div>
              </div>
              <div className="px-2 py-2.5">
                <div className="text-xs text-muted-foreground">减少</div>
                <div className="mt-0.5 font-semibold text-red-700">-{summary.removeCount}</div>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>盘库明细</Label>
                <Button type="button" size="sm" variant="outline" onClick={() => setLines((current) => [...current, defaultLine()])}>
                  <Plus className="size-3.5" />添加一行
                </Button>
              </div>
              {lines.length === 0 ? (
                <div className="rounded-md border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
                  暂无调整，点击“添加一行”选择缸位、商品、批次和增减数量。
                </div>
              ) : (
                <div className="grid gap-2">
                  {lines.map((line) => {
                    const selectedProduct = products.find((item) => item.id === line.productId);
                    const selectedBatch = siteBatches.find((item) => item.id === line.batchId);
                    const removableCount = line.direction === "remove" ? removableStockForLine(line).length : 0;
                    return (
                      <div key={line.id} className="grid gap-3 rounded-md border bg-card p-3 lg:grid-cols-[104px_1.15fr_1.15fr_1.35fr_90px_36px] lg:items-end">
                        <div className="grid gap-1.5">
                          <Label className="text-xs">调整</Label>
                          <Select value={line.direction} onValueChange={(value: "add" | "remove") => updateLine(line.id, { direction: value })}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {permission.canCreate && <SelectItem value="add">增加</SelectItem>}
                              {permission.canDelete && <SelectItem value="remove">减少</SelectItem>}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1.5">
                          <Label className="text-xs">缸位</Label>
                          <Select value={line.subTankId} onValueChange={(value) => updateLine(line.id, { subTankId: value })}>
                            <SelectTrigger><SelectValue placeholder="选择缸位" /></SelectTrigger>
                            <SelectContent>
                              {tankOptions.map((tank) => <SelectItem key={tank.id} value={tank.id}>{tank.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1.5">
                          <Label className="text-xs">商品 / 产地</Label>
                          <Select value={line.productId} onValueChange={(value) => updateLine(line.id, { productId: value })}>
                            <SelectTrigger><SelectValue placeholder="选择商品" /></SelectTrigger>
                            <SelectContent>
                              {products.map((product) => (
                                <SelectItem key={product.id} value={product.id}>
                                  {product.name}{product.origin ? ` · ${product.origin}` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1.5">
                          <Label className="text-xs">批次日期 / 供应商</Label>
                          <Select value={line.batchId} onValueChange={(value) => updateLine(line.id, { batchId: value })}>
                            <SelectTrigger><SelectValue placeholder="选择采购批次" /></SelectTrigger>
                            <SelectContent>
                              {siteBatches.map((batch) => (
                                <SelectItem key={batch.id} value={batch.id}>
                                  {batch.batchNo} · {batch.arrivalDate} · {batch.supplier}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-1.5">
                          <Label className="text-xs">数量</Label>
                          <Input
                            type="number"
                            min={1}
                            max={1000}
                            value={line.quantity || ""}
                            onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) })}
                          />
                        </div>
                        <Button type="button" size="icon" variant="ghost" className="text-red-600" title="删除此行" onClick={() => setLines((current) => current.filter((item) => item.id !== line.id))}>
                          <Trash2 className="size-4" />
                        </Button>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground lg:col-start-2 lg:col-span-5">
                          {selectedProduct && <span>{selectedProduct.name}{selectedProduct.origin ? `（${selectedProduct.origin}）` : ""}</span>}
                          {selectedBatch && <span>· {selectedBatch.batchNo} / {selectedBatch.arrivalDate} / {selectedBatch.supplier}</span>}
                          {line.direction === "remove" && (
                            <Badge variant="outline" className={line.quantity > removableCount ? "border-red-200 text-red-700" : ""}>
                              当前可减 {removableCount} 条
                            </Badge>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="inventory-adjustment-notes">盘库说明</Label>
              <Textarea
                id="inventory-adjustment-notes"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                maxLength={1000}
                rows={3}
                placeholder="可填写盘点原因、现场情况或需要审批人关注的事项"
              />
            </div>
          </div>

          <DialogFooter className="border-t pt-3">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting || savingDraft}>关闭</Button>
            <Button type="button" variant="outline" onClick={() => void saveDraft()} disabled={submitting || savingDraft}>
              {savingDraft ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存进度
            </Button>
            <Button type="button" onClick={() => {
              const validated = validateLines();
              if (validated) setSubmitPreview(validated);
            }} disabled={submitting || savingDraft}>
              <ClipboardCheck className="size-4" />统一提交
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!submitPreview} onOpenChange={(nextOpen) => !nextOpen && !submitting && setSubmitPreview(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认统一提交盘库调整</AlertDialogTitle>
            <AlertDialogDescription>
              本次涉及 {submitPreview?.tankCount ?? 0} 个缸位，增加 {submitPreview?.addCount ?? 0} 条、减少 {submitPreview?.removeCount ?? 0} 条。
              {permission.isAdmin ? "提交后将直接执行。" : "提交后等待管理员审批，批准前不会修改库存。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>返回检查</AlertDialogCancel>
            <AlertDialogAction onClick={(event) => { event.preventDefault(); confirmSubmit(); }} disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCheck className="size-4" />}
              确认提交
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!duplicateRequest} onOpenChange={(nextOpen) => !nextOpen && !submitting && setDuplicateRequest(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-5 text-amber-600" />检测到重复申请
            </AlertDialogTitle>
            <AlertDialogDescription>
              10 分钟内提交过完全相同的盘库调整
              {duplicateRequest?.createdAt ? `（${formatDraftTime(duplicateRequest.createdAt)}）` : ""}。
              {duplicateRequest?.status === "pending"
                ? "原申请仍在等待审批，继续确认不会重复创建第二条申请。"
                : "如现场确实再次发生了相同变化，可继续提交。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                if (duplicateRequest) void performSubmit(duplicateRequest.payload, true);
              }}
              disabled={submitting}
            >
              {submitting ? <Loader2 className="size-4 animate-spin" /> : duplicateRequest?.status === "pending" ? <RotateCcw className="size-4" /> : <Plus className="size-4" />}
              {duplicateRequest?.status === "pending" ? "沿用原申请" : "仍要提交"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
