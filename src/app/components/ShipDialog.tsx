import { useState, useEffect } from "react";
import { Order, OrderItem } from "../store";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import { toast } from "sonner";
import { PackageCheck, Truck, MapPin, Info, CheckSquare, Square, AlertCircle } from "lucide-react";

function todayDateString(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export type ShipFormData = {
  shipDate: string;
  shipMethod: "express" | "pickup";
  carrier: string;
  trackingNo: string;
  actualShippingFee: number;
  notes: string;
  selectedItemIds: string[]; // stockItemIds included in this shipment
};

type ItemMeta = {
  stockItemId: string;
  productId: string;
  price: number;
  productName: string;
  tankName: string;
};

export function ShipDialog({
  order,
  open,
  onOpenChange,
  onShip,
  unshippedItems,      // items not yet in any shipment
  getProductName,
  getTankName,
  balance,             // amountDue - amountPaid (must be ~0 to allow shipping)
}: {
  order: Order | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onShip: (data: ShipFormData) => boolean | Promise<boolean>;
  unshippedItems: OrderItem[];
  getProductName: (productId: string) => string;
  getTankName: (stockItemId: string) => string;
  balance: number;     // positive = unpaid, negative = overpaid
}) {
  const todayStr = todayDateString();

  const [shipDate, setShipDate] = useState(todayStr);
  const [shipMethod, setShipMethod] = useState<"express" | "pickup">("express");
  const [carrier, setCarrier] = useState("");
  const [trackingNo, setTrackingNo] = useState("");
  const [actualShippingFee, setActualShippingFee] = useState(0);
  const [notes, setNotes] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const itemMetas: ItemMeta[] = unshippedItems.map((i) => ({
    stockItemId: i.stockItemId,
    productId: i.productId,
    price: i.price,
    productName: getProductName(i.productId),
    tankName: getTankName(i.stockItemId),
  }));

  useEffect(() => {
    if (open && order) {
      setShipDate(todayStr);
      setShipMethod("express");
      setCarrier("");
      setTrackingNo("");
      setActualShippingFee(order.shippingFee ?? 0);
      setNotes("");
      setSelectedIds(new Set(unshippedItems.map((i) => i.stockItemId)));
    }
  }, [open, order?.id]); // eslint-disable-line

  if (!order) return null;

  const paymentBlocked = Math.abs(balance) > 0.005;
  const preCollected = order.shippingFee ?? 0;
  const feeDiff = actualShippingFee - preCollected;

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    if (selectedIds.size === itemMetas.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(itemMetas.map((i) => i.stockItemId)));
  };

  const changeShipMethod = (method: "express" | "pickup") => {
    setShipMethod(method);
    if (method === "pickup") {
      setActualShippingFee(0);
      return;
    }
    setActualShippingFee(order.shippingFee ?? 0);
  };

  const confirm = async () => {
    if (paymentBlocked) return toast.error("应付与已付金额不相等，请先完成付款再出库");
    if (!shipDate) return toast.error("请填写出库日期");
    if (shipDate < order.date) return toast.error("出库日期不能早于下单日期");
    if (shipDate > todayStr) return toast.error("出库日期不能晚于今天");
    if (shipMethod === "express" && !carrier.trim()) return toast.error("请填写快递公司");
    if (selectedIds.size === 0) return toast.error("请至少选择一件商品进行出库");
    setSaving(true);
    const ok = await onShip({ shipDate, shipMethod, carrier, trackingNo, actualShippingFee, notes, selectedItemIds: [...selectedIds] });
    setSaving(false);
    if (ok !== false) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="max-w-none sm:max-w-none w-[min(92vw,680px)] max-h-[90vh] min-h-0 flex flex-col"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck className="size-4 text-sky-600" />
            出库 — {order.orderNo}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4 py-1 pr-1 pb-3">

          {/* Payment block warning */}
          {paymentBlocked && (
            <div className="flex items-start gap-2 rounded-lg px-3 py-3 bg-red-50 border border-red-200 text-sm text-red-700">
              <AlertCircle className="size-4 mt-0.5 shrink-0" />
              <div>
                <strong>无法出库：</strong>
                {balance > 0
                  ? `客户尚欠款 ¥${balance.toFixed(2)}，请先收清货款再出库。`
                  : `已多付 ¥${Math.abs(balance).toFixed(2)}，请先退款再出库。`}
              </div>
            </div>
          )}

          {/* Item selection */}
          <div className="rounded-lg border bg-card">
            <div className="flex items-center justify-between px-3 py-2 bg-muted/40 border-b rounded-t-lg">
              <span className="text-xs font-medium text-muted-foreground">
                本次出库商品（{selectedIds.size}/{itemMetas.length}）
              </span>
              <button
                type="button"
                onClick={toggleAll}
                className="text-xs text-sky-600 hover:text-sky-700 font-medium flex items-center gap-1"
              >
                {selectedIds.size === itemMetas.length
                  ? <><CheckSquare className="size-3.5" /> 取消全选</>
                  : <><Square className="size-3.5" /> 全选</>}
              </button>
            </div>
            <div
              className="block overflow-y-auto rounded-b-lg"
              style={{ maxHeight: "min(22rem, 42vh)", paddingBottom: "1rem", scrollPaddingBottom: "1rem" }}
            >
              {itemMetas.map((item) => {
                const checked = selectedIds.has(item.stockItemId);
                return (
                  <button
                    key={item.stockItemId}
                    type="button"
                    onClick={() => toggleItem(item.stockItemId)}
                    className={`w-full min-h-16 flex items-center gap-3 px-3 py-3 text-left border-b transition-colors ${checked ? "bg-sky-50" : "hover:bg-muted/30"}`}
                  >
                    {checked
                      ? <CheckSquare className="size-4 text-sky-600 shrink-0" />
                      : <Square className="size-4 text-muted-foreground shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{item.productName}</div>
                      <div className="text-xs text-muted-foreground">{item.tankName}</div>
                    </div>
                    <div className="text-sm text-right shrink-0">¥{item.price.toFixed(2)}</div>
                  </button>
                );
              })}
              {itemMetas.length === 0 && (
                <div className="px-3 py-4 text-sm text-center text-muted-foreground">无待发货商品</div>
              )}
            </div>
          </div>

          {/* Shipping method */}
          <div className="grid gap-2">
            <Label>物流方式<span className="text-red-500 ml-0.5">*</span></Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => changeShipMethod("express")}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                  shipMethod === "express"
                    ? "border-sky-500 bg-sky-50 text-sky-700"
                    : "hover:bg-muted/60 text-muted-foreground"
                }`}
              >
                <Truck className="size-4" /> 快递寄送
              </button>
              <button
                type="button"
                onClick={() => changeShipMethod("pickup")}
                className={`flex-1 flex items-center justify-center gap-2 rounded-lg border py-2.5 text-sm font-medium transition-colors ${
                  shipMethod === "pickup"
                    ? "border-emerald-500 bg-emerald-50 text-emerald-700"
                    : "hover:bg-muted/60 text-muted-foreground"
                }`}
              >
                <MapPin className="size-4" /> 上门自取
              </button>
            </div>
          </div>

          {/* Express fields */}
          {shipMethod === "express" && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label className="text-sm">快递公司<span className="text-red-500 ml-0.5">*</span></Label>
                <Input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="如：顺丰速运" />
              </div>
            </div>
          )}

          {/* Date + actual fee */}
          <div className={shipMethod === "express" ? "grid grid-cols-2 gap-3" : "grid gap-3"}>
            <div className="grid gap-1.5">
              <Label className="text-sm">出库日期<span className="text-red-500 ml-0.5">*</span></Label>
              <Input
                type="date"
                value={shipDate}
                min={order.date}
                max={todayStr}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value && value < order.date) {
                    toast.error("出库日期不能早于下单日期");
                    return;
                  }
                  if (value && value > todayStr) {
                    toast.error("出库日期不能晚于今天");
                    return;
                  }
                  setShipDate(value);
                }}
              />
            </div>
            {shipMethod === "express" && (
              <div className="grid gap-1.5">
                <Label className="text-sm">实际运费（¥）</Label>
                <Input
                  type="number" min={0} step={0.01}
                  value={actualShippingFee || ""}
                  placeholder="0"
                  onChange={(e) => setActualShippingFee(Number(e.target.value))}
                />
              </div>
            )}
          </div>

          {/* Fee diff hint */}
          {shipMethod === "express" && Math.abs(feeDiff) > 0.005 && (
            <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${
              feeDiff > 0
                ? "bg-amber-50 text-amber-800 border border-amber-200"
                : "bg-sky-50 text-sky-800 border border-sky-200"
            }`}>
              <Info className="size-4 mt-0.5 shrink-0" />
              <div>
                {feeDiff > 0
                  ? <>实际运费比预收多 <strong>¥{feeDiff.toFixed(2)}</strong>，出库后会计入应收账款。</>
                  : <>实际运费比预收少 <strong>¥{Math.abs(feeDiff).toFixed(2)}</strong>，出库后会计入应收账款。</>}
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="grid gap-1.5">
            <Label className="text-sm">备注</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="特殊要求…" />
          </div>
        </div>

        <DialogFooter className="border-t pt-3 shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={confirm} disabled={paymentBlocked || saving}>
            <PackageCheck className="size-4 mr-1" />
            {saving ? "保存中..." : "确认出库"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
