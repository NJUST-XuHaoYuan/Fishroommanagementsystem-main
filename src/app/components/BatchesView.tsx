import { useMemo, useState } from "react";
import { isPaymentVerified, useStore, Order, PurchaseBatch, Shipment, StockItem, uid } from "../store";
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

function countsAsActiveShipment(shipment: Shipment): boolean {
  return shipment.status !== "preparing" && !(shipment.status === "damaged" && shipment.damageResolution === "reship");
}

function calcBatchPaymentAmount(order: Order): number {
  return (Array.isArray(order.payments) ? order.payments : []).reduce(
    (sum, payment) => !isPaymentVerified(payment)
      ? sum
      : payment.type === "refund"
      ? sum - Number(payment.amount || 0)
      : sum + Number(payment.amount || 0),
    0
  );
}

function getBatchBillableShippingFee(order: Order, shipments: Shipment[]): number {
  const activeShipments = shipments.filter((shipment) =>
    shipment.orderId === order.id && countsAsActiveShipment(shipment)
  );
  if (activeShipments.length === 0) return Number(order.shippingFee || 0);
  return activeShipments.reduce((sum, shipment) => sum + Number(shipment.actualShippingFee || 0), 0);
}

function collectDamageRefundShareByStockId(shipments: Shipment[]): Map<string, number> {
  const refundShareByStockId = new Map<string, number>();
  for (const shipment of shipments) {
    if (shipment.status !== "damaged" || shipment.damageResolution !== "refund") continue;
    const itemIds = (shipment.damageItemStockIds?.length ? shipment.damageItemStockIds : shipment.itemStockIds) ?? [];
    if (itemIds.length === 0) continue;
    const refundAmount = Number(shipment.damageRefundAmount ?? 0);
    if (!(refundAmount > 0)) continue;
    const share = refundAmount / itemIds.length;
    for (const stockItemId of itemIds) {
      refundShareByStockId.set(stockItemId, (refundShareByStockId.get(stockItemId) ?? 0) + share);
    }
  }
  return refundShareByStockId;
}

export function BatchesView() {
  const { state, saveStateTransform } = useStore();
  const [editing, setEditing] = useState<PurchaseBatch | null>(null);
  const [open, setOpen] = useState(false);
  const [del, setDel] = useState<PurchaseBatch | null>(null);
  const [detail, setDetail] = useState<PurchaseBatch | null>(null);
  const [proofPreview, setProofPreview] = useState<{ url: string; title: string } | null>(null);
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

  const itemCount = (id: string) => state.stock.filter((s) => s.batchId === id).length;
  const earliestStockInDate = (id: string) =>
    state.stock
      .filter((s) => s.batchId === id && s.inDate)
      .map((s) => s.inDate)
      .sort()[0];
  const maxArrivalDate = editing?.id ? earliestStockInDate(editing.id) : undefined;
  const arrivalDateMax = maxArrivalDate && maxArrivalDate < today ? maxArrivalDate : today;
  const totalCost = (batch: PurchaseBatch) => (batch.bioFee + batch.shippingFee).toFixed(2);
  const lossProofs = (batch: PurchaseBatch | null) =>
    Array.isArray(batch?.lossProof) ? batch.lossProof : [];
  const batchSalesStats = useMemo(() => {
    const stockList = Array.isArray(state.stock) ? state.stock : [];
    const orderList = Array.isArray(state.orders) ? state.orders : [];
    const shipmentList = Array.isArray(state.shipments) ? state.shipments : [];
    const stockById = new Map<string, StockItem>(stockList.map((item) => [item.id, item]));
    const refundShareByStockId = collectDamageRefundShareByStockId(shipmentList);
    const map = new Map<string, {
      gross: number;
      discount: number;
      refundAdjustment: number;
      received: number;
      itemCount: number;
      orderCount: number;
      orderIds: Set<string>;
    }>();

    for (const order of orderList) {
      if (order.status === "cancelled") continue;
      const items = Array.isArray(order.items) ? order.items : [];
      if (items.length === 0) continue;
      const discountPerItem = Number(order.discount ?? 0) / items.length;
      const adjustedItems = items.map((item) => {
        const gross = Number(item.price ?? 0);
        const refundAdjustment = refundShareByStockId.get(item.stockItemId) ?? 0;
        return {
          item,
          stockItem: stockById.get(item.stockItemId),
          gross,
          discount: discountPerItem,
          refundAdjustment,
          adjustedAmount: Math.max(0, gross - discountPerItem - refundAdjustment),
        };
      });
      const productDue = adjustedItems.reduce((sum, item) => sum + item.adjustedAmount, 0);
      if (productDue <= 0) continue;

      const orderDue = productDue +
        getBatchBillableShippingFee(order, shipmentList) +
        Number(order.packagingFee ?? 0);
      const netPaid = Math.max(0, calcBatchPaymentAmount(order));
      const paidProductPool = orderDue > 0
        ? Math.min(productDue, netPaid * (productDue / orderDue))
        : 0;

      for (const itemStats of adjustedItems) {
        const stockItem = itemStats.stockItem;
        if (!stockItem?.batchId) continue;
        const current = map.get(stockItem.batchId) ?? {
          gross: 0,
          discount: 0,
          refundAdjustment: 0,
          received: 0,
          itemCount: 0,
          orderCount: 0,
          orderIds: new Set<string>(),
        };
        current.gross += itemStats.gross;
        current.discount += itemStats.discount;
        current.refundAdjustment += itemStats.refundAdjustment;
        current.received += paidProductPool * (itemStats.adjustedAmount / productDue);
        current.itemCount += 1;
        current.orderIds.add(order.id);
        current.orderCount = current.orderIds.size;
        map.set(stockItem.batchId, current);
      }
    }

    return map;
  }, [state.orders, state.shipments, state.stock]);
  const salesStats = (batchId: string) => batchSalesStats.get(batchId) ?? {
    gross: 0,
    discount: 0,
    refundAdjustment: 0,
    received: 0,
    itemCount: 0,
    orderCount: 0,
    orderIds: new Set<string>(),
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

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>采购批次管理</h2>
        <p className="text-sm text-muted-foreground">记录每次采购的批次信息，作为库存明细的来源</p>
      </div>
      <DataTable
        data={state.batches}
        searchKeys={["batchNo", "supplier", "date"]}
        searchPlaceholder="搜索批次号、供应商..."
        onAdd={permission.canCreate ? () => { setEditing(empty()); setOpen(true); } : undefined}
        addLabel="新增批次"
        columns={[
          { key: "batchNo", title: "批次号" },
          { key: "supplier", title: "供应商" },
          { key: "arrivalDate", title: "到货日期" },
          { key: "bioFee", title: "生物费用(¥)", render: (r) => r.bioFee.toFixed(2) },
          { key: "shippingFee", title: "运输费用(¥)", render: (r) => r.shippingFee.toFixed(2) },
          { key: "totalCost", title: "合计(¥)", render: (r) => (r.bioFee + r.shippingFee).toFixed(2) },
          { key: "received", title: "实收金额(¥)", render: (r) => salesStats(r.id).received.toFixed(2) },
          { key: "stockedCount", title: "入库数量", render: (r) => `${r.stockedCount} 条` },
          { key: "lossCount", title: "报损数量", render: (r) => `${r.lossCount} 条` },
          { key: "notes", title: "备注" },
        ]}
        actions={(row) => (
          <div className="flex justify-end gap-2" onDoubleClick={(event) => event.stopPropagation()}>
            <Button size="sm" variant="outline" onClick={() => setDetail(row)}>详情</Button>
            {permission.canUpdate && <Button size="sm" variant="outline" onClick={() => { setEditing({ ...row, lossProof: lossProofs(row) }); setOpen(true); }}>编辑</Button>}
            {permission.canDelete && <Button size="sm" variant="ghost" className="text-red-600" onClick={() => setDel(row)}>删除</Button>}
          </div>
        )}
        onRowDoubleClick={(row) => setDetail(row)}
      />

      <Dialog open={!!detail} onOpenChange={(nextOpen) => !nextOpen && setDetail(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-2xl">
          <DialogHeader><DialogTitle>批次详情</DialogTitle></DialogHeader>
          {detail && (
            <div className="grid gap-4 py-2">
              {(() => {
                const stats = salesStats(detail.id);
                return (
                  <div className="rounded-lg border bg-sky-50/70 p-3">
                    <div className="text-xs text-sky-700">批次实收金额</div>
                    <div className="mt-1 text-2xl font-semibold text-sky-800">¥{stats.received.toFixed(2)}</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                      <span>销售商品：{stats.itemCount} 条</span>
                      <span>关联订单：{stats.orderCount} 单</span>
                      <span>折扣分摊：-¥{stats.discount.toFixed(2)}</span>
                      <span>退款调整：-¥{stats.refundAdjustment.toFixed(2)}</span>
                    </div>
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
