import { useMemo, useState } from "react";
import { isPersonnelResigned, Order, PaymentType, Shipment, useStore } from "../store";
import { DataTable } from "./common";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "./ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "./ui/select";
import { toast } from "sonner";
import { Eye, KeyRound } from "lucide-react";
import { confirmWrite } from "../utils/writeConfirm";

const PAYMENT_TYPE_LABEL: Record<PaymentType, string> = {
  deposit: "定金",
  balance: "尾款",
  shipping_fee: "运费补款",
  refund: "退款",
  other: "其他",
};

function countsAsActiveShipment(shipment: Shipment): boolean {
  return shipment.status !== "preparing" && !(shipment.status === "damaged" && shipment.damageResolution === "reship");
}

function getBillableShippingFee(order: Order, shipments: Shipment[] = []): number {
  const activeShipments = shipments.filter((shipment) =>
    shipment.orderId === order.id && countsAsActiveShipment(shipment)
  );
  if (activeShipments.length === 0) return order.shippingFee ?? 0;
  return activeShipments.reduce((sum, shipment) => sum + (shipment.actualShippingFee ?? 0), 0);
}

function calcAmountDue(order: Order, shipments: Shipment[] = []): number {
  const items = order.items.reduce((sum, item) => sum + item.price, 0);
  return items + getBillableShippingFee(order, shipments) + (order.packagingFee ?? 0) - (order.discount ?? 0);
}

function calcAmountPaid(order: Order): number {
  return (order.payments ?? []).reduce(
    (sum, payment) => payment.type === "refund" ? sum - payment.amount : sum + payment.amount,
    0
  );
}

function formatDateTime(value: string): string {
  return value ? value.replace("T", " ") : "—";
}

export function PersonalCenterView() {
  const { state, changePersonnelPassword } = useStore();
  const user = state.user;
  const currentAccount = useMemo(
    () => (state.personnel ?? []).find((person) => person.username === user?.username),
    [state.personnel, user?.username]
  );
  const currentContactName = currentAccount?.name || user?.username || "";
  const isAdmin = user?.role === "admin" || currentAccount?.accessRole === "admin";
  const activePersonnel = useMemo(
    () => (state.personnel ?? []).filter((person) => !isPersonnelResigned(person)),
    [state.personnel]
  );

  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [adminTargetId, setAdminTargetId] = useState(currentAccount?.id ?? "");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminConfirmPassword, setAdminConfirmPassword] = useState("");
  const [viewOrder, setViewOrder] = useState<Order | null>(null);

  const customerName = (id: string) => state.customers.find((customer) => customer.id === id)?.name ?? "—";
  const productName = (id: string) => {
    const product = state.products.find((item) => item.id === id);
    if (!product) return "—";
    return [product.name, product.size, product.origin].filter(Boolean).join(" / ");
  };

  const completedRows = useMemo(() => {
    return (state.orders ?? [])
      .filter((order) => order.status === "completed" && order.contactPerson === currentContactName)
      .map((order) => {
        const customer = order.source === "平台下单"
          ? `抖音订单 ${order.douyinOrderNo || ""}`.trim()
          : customerName(order.customerId);
        const products = order.items.map((item) => productName(item.productId)).join(" ");
        return {
          ...order,
          customerName: customer,
          productSummary: products,
          amountDue: calcAmountDue(order, state.shipments),
          amountPaid: calcAmountPaid(order),
          searchText: [
            order.orderNo,
            order.date,
            customer,
            products,
            order.notes,
            order.payments?.map((payment) => payment.notes).join(" "),
          ].filter(Boolean).join(" "),
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date) || b.orderNo.localeCompare(a.orderNo));
  }, [currentContactName, state.orders, state.shipments, state.customers, state.products]);

  const changeOwnPassword = async () => {
    if (!currentAccount) return toast.error("找不到当前账户");
    if (!oldPassword) return toast.error("请输入原密码");
    if (!newPassword.trim()) return toast.error("请输入新密码");
    if (newPassword.length < 6) return toast.error("新密码至少 6 位");
    if (newPassword !== confirmPassword) return toast.error("两次输入的新密码不一致");

    if (!confirmWrite("修改", "将修改当前登录账户的密码。")) return;
    const ok = await changePersonnelPassword({ oldPassword, newPassword });
    if (!ok) return toast.error("保存失败，请重试");
    setOldPassword("");
    setNewPassword("");
    setConfirmPassword("");
    toast.success("密码已修改");
  };

  const adminChangePassword = async () => {
    if (!isAdmin) return;
    const target = activePersonnel.find((person) => person.id === adminTargetId);
    if (!target) return toast.error("请选择人员");
    if (!adminPassword.trim()) return toast.error("请输入新密码");
    if (adminPassword.length < 6) return toast.error("新密码至少 6 位");
    if (adminPassword !== adminConfirmPassword) return toast.error("两次输入的新密码不一致");

    if (!confirmWrite("修改", `将修改「${target.name || target.username}」的密码。`)) return;
    const ok = await changePersonnelPassword({ targetId: target.id, newPassword: adminPassword });
    if (!ok) return toast.error("保存失败，请重试");
    setAdminPassword("");
    setAdminConfirmPassword("");
    toast.success(`已修改 ${target.name || target.username} 的密码`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2>个人中心</h2>
        <p className="text-sm text-muted-foreground">修改登录密码，查看自己作为对接人的已完成销售记录</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(320px,420px)_1fr]">
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-sky-100 text-sky-700">
                <KeyRound className="size-5" />
              </div>
              <div>
                <h3>修改我的密码</h3>
                <p className="text-sm text-muted-foreground">
                  当前账户：{currentAccount?.name || user?.username}
                </p>
              </div>
            </div>
            <div className="grid gap-3">
              <div className="grid gap-2">
                <Label>原密码</Label>
                <Input
                  type="password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="grid gap-2">
                <Label>新密码</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="grid gap-2">
                <Label>确认新密码</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  onKeyDown={(e) => e.key === "Enter" && changeOwnPassword()}
                />
              </div>
              <Button onClick={changeOwnPassword}>保存我的密码</Button>
            </div>
          </Card>

          {isAdmin && (
            <Card className="p-5">
              <div className="mb-4">
                <h3>管理员重置密码</h3>
                <p className="text-sm text-muted-foreground">管理员可以修改所有人员的登录密码</p>
              </div>
              <div className="grid gap-3">
                <div className="grid gap-2">
                  <Label>人员</Label>
                  <Select value={adminTargetId} onValueChange={setAdminTargetId}>
                    <SelectTrigger>
                      <SelectValue placeholder="选择人员" />
                    </SelectTrigger>
                    <SelectContent>
	                      {activePersonnel.map((person) => (
                        <SelectItem key={person.id} value={person.id}>
                          {person.name || person.username}（{person.username}）
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label>新密码</Label>
                  <Input
                    type="password"
                    value={adminPassword}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <div className="grid gap-2">
                  <Label>确认新密码</Label>
                  <Input
                    type="password"
                    value={adminConfirmPassword}
                    onChange={(e) => setAdminConfirmPassword(e.target.value)}
                    autoComplete="new-password"
                    onKeyDown={(e) => e.key === "Enter" && adminChangePassword()}
                  />
                </div>
                <Button variant="outline" onClick={adminChangePassword}>重置选中人员密码</Button>
              </div>
            </Card>
          )}
        </div>

        <Card className="p-5">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <h3>我的已完成销售记录</h3>
              <p className="text-sm text-muted-foreground">只显示对接人为「{currentContactName || "—"}」的已完成订单</p>
            </div>
            <Badge variant="secondary">{completedRows.length} 单</Badge>
          </div>
          <DataTable
            data={completedRows}
            pageSize={6}
            searchKeys={["searchText"]}
            searchPlaceholder="搜索订单号、客户、商品、备注..."
            columns={[
              { key: "orderNo", title: "订单号" },
              { key: "date", title: "下单日期" },
              { key: "customerName", title: "客户" },
              { key: "items", title: "商品数", render: (row) => `${row.items.length} 条` },
              { key: "amountDue", title: "应收", render: (row) => `¥${row.amountDue.toFixed(2)}` },
              {
                key: "amountPaid",
                title: "实收",
                render: (row) => (
                  <span className={row.amountPaid + 0.005 >= row.amountDue ? "text-emerald-600" : "text-orange-500"}>
                    ¥{row.amountPaid.toFixed(2)}
                  </span>
                ),
              },
            ]}
            actions={(row) => (
              <Button size="sm" variant="outline" onClick={() => setViewOrder(row)}>
                <Eye className="mr-1 size-3.5" />
                查看
              </Button>
            )}
          />
        </Card>
      </div>

      <Dialog open={!!viewOrder} onOpenChange={(open) => !open && setViewOrder(null)}>
        <DialogContent aria-describedby={undefined} className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>销售记录详情</DialogTitle>
          </DialogHeader>
          {viewOrder && (
            <div className="grid gap-4">
              <div className="grid gap-2 rounded-lg border bg-slate-50 p-4 text-sm md:grid-cols-3">
                <div><span className="text-muted-foreground">订单号：</span>{viewOrder.orderNo}</div>
                <div>
                  <span className="text-muted-foreground">{viewOrder.source === "平台下单" ? "抖音订单：" : "客户："}</span>
                  {viewOrder.source === "平台下单"
                    ? viewOrder.douyinOrderNo || "—"
                    : customerName(viewOrder.customerId)}
                </div>
                <div><span className="text-muted-foreground">下单日期：</span>{viewOrder.date}</div>
                <div><span className="text-muted-foreground">对接人：</span>{viewOrder.contactPerson || "—"}</div>
                <div><span className="text-muted-foreground">应收：</span>¥{calcAmountDue(viewOrder, state.shipments).toFixed(2)}</div>
                <div><span className="text-muted-foreground">实收：</span>¥{calcAmountPaid(viewOrder).toFixed(2)}</div>
              </div>

              <div className="rounded-lg border">
                <div className="border-b bg-muted/50 px-4 py-2 text-sm font-medium">商品明细</div>
                <div className="divide-y">
                  {viewOrder.items.map((item) => (
                    <div key={item.stockItemId} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1fr_120px_140px]">
                      <span>{productName(item.productId)}</span>
                      <span className="text-muted-foreground">库存：{item.stockItemId}</span>
                      <span className="font-medium text-sky-700">¥{item.price.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-lg border">
                <div className="border-b bg-muted/50 px-4 py-2 text-sm font-medium">资金记录</div>
                <div className="divide-y">
                  {(viewOrder.payments ?? []).length === 0 ? (
                    <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无资金记录</div>
                  ) : (
                    [...(viewOrder.payments ?? [])].sort((a, b) => a.time.localeCompare(b.time)).map((payment) => (
                      <div key={payment.id} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[140px_100px_100px_1fr]">
                        <span>{formatDateTime(payment.time)}</span>
                        <span>{PAYMENT_TYPE_LABEL[payment.type]}</span>
                        <span className={payment.type === "refund" ? "text-red-600" : "text-emerald-600"}>
                          {payment.type === "refund" ? "-" : "+"}¥{payment.amount.toFixed(2)}
                        </span>
                        <span className="text-muted-foreground">{payment.notes || "—"}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {viewOrder.notes && (
                <div className="rounded-lg border bg-slate-50 p-3 text-sm">
                  <span className="text-muted-foreground">订单备注：</span>{viewOrder.notes}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewOrder(null)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
