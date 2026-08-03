import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  configuredPaymentMethod,
  configuredPaymentMethods,
  PAYMENT_CHANNEL_OPTIONS,
  PaymentChannel,
  PaymentMethodSetting,
  PaymentRecord,
  PaymentType,
  paymentChannelLabel,
  uid,
  useStore,
} from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { uploadOriginalMedia, resolveMediaUrl } from "../utils/media";
import {
  isPlatformOrderSource,
  orderSourceBadgeClass,
  orderSourceLabel,
  platformOrderNoLabel,
} from "../utils/orderSources";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";
import {
  ArrowDownLeft,
  ArrowUpRight,
  FileCheck2,
  FileSpreadsheet,
  History,
  Landmark,
  Link2,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

const PAYMENT_TYPES: PaymentType[] = ["deposit", "balance", "shipping_fee", "refund", "other"];
const PAYMENT_LABELS: Record<PaymentType, string> = {
  deposit: "定金",
  balance: "收款",
  shipping_fee: "运费补款",
  refund: "退款",
  other: "其他",
};

type FinancePayment = PaymentRecord & {
  account?: string;
};

type FinanceOrderItem = {
  stockItemId: string;
  fishCode: string;
  productName: string;
  size: string;
  origin: string;
  price: number;
  minReturnPrice: number;
  inventoryRemoved: boolean;
};

type FinanceOrderRow = {
  id: string;
  siteId: string;
  orderNo: string;
  douyinOrderNo: string;
  platformOrderNo: string;
  date: string;
  orderStatus: string;
  source: string;
  paymentMethodId: string;
  paymentMethodName: string;
  paymentChannel: PaymentChannel | "";
  paymentAccount: string;
  paymentReference: string;
  customerName: string;
  contactPerson: string;
  logisticsStatus: string;
  financeStatus: string;
  receivable: number;
  itemSubtotal: number;
  discount: number;
  goodsNetTotal: number;
  orderShippingFee: number;
  billableShippingFee: number;
  shippingFeeAdjustment: number;
  packagingFee: number;
  damageRefundAdjustment: number;
  calculatedReceivable: number;
  cancellationAdjustment: number;
  received: number;
  refunded: number;
  pendingReceived: number;
  pendingRefunded: number;
  pendingPaymentCount: number;
  balance: number;
  platformIncome: number;
  platformFees: number;
  netSettlement: number;
  settlementCount: number;
  commissionRate: number;
  commissionBase: number;
  minimumReturnTotal: number;
  commissionCap: number;
  commissionAmount: number;
  items: FinanceOrderItem[];
  payments: FinancePayment[];
};

type FinanceTransaction = FinancePayment & {
  orderId: string;
  orderNo: string;
  customerName: string;
  contactPerson: string;
  source: string;
};

type ReconciliationRow = {
  externalOrderNo: string;
  internalOrderId: string;
  internalOrderNo: string;
  contactPerson: string;
  settlementTime: string;
  productName: string;
  settlementCount: number;
  orderTotal: number;
  incomeTotal: number;
  refundTotal: number;
  platformFees: number;
  settlementAmount: number;
  systemReceivable: number | null;
  difference: number | null;
  status: "未匹配" | "已匹配" | "有差异";
  formulaMatches: boolean;
};

type ImportBatch = {
  id: string;
  siteId: string;
  fileName: string;
  fileHash: string;
  importedAt: string;
  importedBy: string;
  rowCount: number;
  matchedCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  totals: Record<string, number>;
};

type FinanceTransfer = {
  id: string;
  siteId: string;
  channel: PaymentChannel;
  sourceAccount: string;
  targetAccount: string;
  expectedAmount: number;
  actualAmount: number;
  difference: number;
  transferredAt: string;
  transactionNo: string;
  status: "pending" | "verified";
  importBatchIds: string[];
  proof: string[];
  notes: string;
  createdAt: string;
  createdBy: string;
  verifiedAt: string;
  verifiedBy: string;
};

type FinanceOverview = {
  settings: { defaultCommissionRate: number };
  summary: {
    receivable: number;
    actualInflow: number;
    refunded: number;
    platformFees: number;
    netSettlement: number;
    unreconciledOrders: number;
    commissionTotal: number;
    unmatchedSettlementCount: number;
  };
  orders: FinanceOrderRow[];
  transactions: FinanceTransaction[];
  reconciliations: ReconciliationRow[];
  importBatches: ImportBatch[];
  transfers: FinanceTransfer[];
};

type PreviewRow = {
  rowNumber: number;
  externalOrderNo: string;
  settlementTime: string;
  productName: string;
  orderTotal: number;
  incomeTotal: number;
  refundTotal: number;
  platformFees: number;
  settlementAmount: number;
  matchedOrderId: string;
  matchedOrderNo: string;
  duplicate: boolean;
  formulaMatches: boolean;
};

type ImportPreview = {
  fileName: string;
  fileHash: string;
  rowCount: number;
  matchedCount: number;
  unmatchedCount: number;
  duplicateCount: number;
  formulaMismatchCount: number;
  duplicateFile: boolean;
  errors: { rowNumber: number; message: string }[];
  totals: {
    orderTotal: number;
    incomeTotal: number;
    refundTotal: number;
    platformFees: number;
    settlementAmount: number;
  };
  rows: PreviewRow[];
};

type PaymentDraft = {
  id: string;
  type: PaymentType;
  amount: number;
  time: string;
  paymentMethodId: string;
  paymentMethodName: string;
  channel: PaymentChannel | "";
  account: string;
  externalTransactionNo: string;
  proof: string[];
  notes: string;
};

type PaymentMethodOption = PaymentMethodSetting & { historical?: boolean };

function historicalFinancePaymentMethodId(scope: string): string {
  return `historical-finance-${scope}`;
}

function paymentMethodDisplayLabel(method: Pick<PaymentMethodSetting, "name" | "channel">): string {
  const channelLabel = paymentChannelLabel(method.channel);
  return method.name === channelLabel ? method.name : `${method.name} · ${channelLabel}`;
}

type TransferDraft = {
  id: string;
  channel: PaymentChannel | "";
  sourceAccount: string;
  targetAccount: string;
  expectedAmount: number;
  actualAmount: number;
  transferredAt: string;
  transactionNo: string;
  importBatchIds: string[];
  proof: string[];
  notes: string;
};

function money(value: number) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function adjustmentMoney(value: number) {
  if (value > 0.005) return `+${money(value)}`;
  if (value < -0.005) return `−${money(Math.abs(value))}`;
  return money(0);
}

function localDatetimeValue() {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return now.toISOString().slice(0, 16);
}

function displayDatetime(value: string) {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

function financeStatusClass(status: string) {
  if (status === "已核销") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "有差异" || status === "待退款") return "border-rose-200 bg-rose-50 text-rose-700";
  if (status === "待核对") return "border-violet-200 bg-violet-50 text-violet-700";
  if (status === "部分收款") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "已取消") return "border-slate-200 bg-slate-50 text-slate-500";
  return "border-amber-200 bg-amber-50 text-amber-700";
}

function reconciliationStatusClass(status: ReconciliationRow["status"]) {
  if (status === "已匹配") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "有差异") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-rose-200 bg-rose-50 text-rose-700";
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...authJsonHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || `HTTP ${response.status}`);
  }
  return result;
}

async function openProofImage(source: string) {
  const popup = window.open("", "_blank");
  const resolved = await resolveMediaUrl(source).catch(() => source);
  if (popup) {
    popup.opener = null;
    popup.location.href = resolved;
  }
}

function LoadingRows() {
  return (
    <div className="divide-y rounded-lg border bg-card" aria-label="财务数据加载中">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="grid grid-cols-[1.2fr_1fr_1fr] gap-4 px-4 py-3">
          <div className="h-4 animate-pulse rounded bg-muted" />
          <div className="h-4 animate-pulse rounded bg-muted" />
          <div className="h-4 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function ProofUploader({
  images,
  onChange,
}: {
  images: string[];
  onChange: (images: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFiles = async (files: FileList) => {
    setUploading(true);
    const uploaded: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      try {
        uploaded.push(await uploadOriginalMedia(file));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "凭证上传失败");
      }
    }
    onChange([...images, ...uploaded]);
    setUploading(false);
    if (uploaded.length > 0) toast.success(`已上传 ${uploaded.length} 张凭证`);
  };

  return (
    <div className="flex flex-wrap items-start gap-2">
      {images.map((image, index) => (
        <div key={`${image}-${index}`} className="group relative">
          <ImageWithFallback
            src={image}
            alt="资金凭证"
            className="size-14 cursor-pointer rounded-md border object-cover"
            onClick={() => void openProofImage(image)}
          />
          <button
            type="button"
            onClick={() => onChange(images.filter((_, itemIndex) => itemIndex !== index))}
            className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full bg-red-600 text-white opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            aria-label="删除凭证"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="size-14 border-dashed"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        title="上传资金凭证"
      >
        {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => event.target.files && void handleFiles(event.target.files)}
      />
    </div>
  );
}

function OrderFinanceDialog({
  order,
  open,
  onOpenChange,
  onRefresh,
}: {
  order: FinanceOrderRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<void>;
}) {
  const { state } = useStore();
  const permission = usePermission("finance");
  const [editingPaymentId, setEditingPaymentId] = useState("");
  const [paymentFormOpen, setPaymentFormOpen] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [verifyingPaymentId, setVerifyingPaymentId] = useState("");
  const [savingCommission, setSavingCommission] = useState(false);
  const [commissionRate, setCommissionRate] = useState(1);
  const [draft, setDraft] = useState<PaymentDraft>({
    id: "",
    type: "balance",
    amount: 0,
    time: localDatetimeValue(),
    paymentMethodId: "",
    paymentMethodName: "",
    channel: "",
    account: "",
    externalTransactionNo: "",
    proof: [],
    notes: "",
  });

  useEffect(() => {
    if (!open || !order) return;
    setCommissionRate(order.commissionRate);
    setPaymentFormOpen(false);
    setEditingPaymentId("");
  }, [open, order?.id, order?.commissionRate]);

  const availablePaymentMethods = configuredPaymentMethods(state.systemSettings);
  const orderPaymentAccount = String(order?.paymentAccount ?? "").trim();
  const orderPaymentMethod: PaymentMethodOption | null = order?.paymentChannel && orderPaymentAccount
    ? {
        id: order.paymentMethodId || historicalFinancePaymentMethodId(`order-${order.id}`),
        name: order.paymentMethodName || paymentChannelLabel(order.paymentChannel),
        channel: order.paymentChannel,
        account: orderPaymentAccount,
        enabled: Boolean(order.paymentMethodId && availablePaymentMethods.some((method) => method.id === order.paymentMethodId)),
        historical: !order.paymentMethodId || !availablePaymentMethods.some((method) => method.id === order.paymentMethodId),
      }
    : null;
  const paymentMethodOptions = useMemo<PaymentMethodOption[]>(() => {
    if (!draft.paymentMethodId || !draft.channel || !draft.account) return availablePaymentMethods;
    const existingIndex = availablePaymentMethods.findIndex((method) => method.id === draft.paymentMethodId);
    const snapshot: PaymentMethodOption = {
      id: draft.paymentMethodId,
      name: draft.paymentMethodName || paymentChannelLabel(draft.channel),
      channel: draft.channel,
      account: draft.account,
      enabled: existingIndex >= 0,
      historical: draft.paymentMethodId.startsWith("historical-finance-") || existingIndex < 0,
    };
    if (existingIndex < 0) return [snapshot, ...availablePaymentMethods];
    return availablePaymentMethods.map((method, index) => index === existingIndex ? snapshot : method);
  }, [availablePaymentMethods, draft.account, draft.channel, draft.paymentMethodId, draft.paymentMethodName]);

  const defaultPaymentMethod = () =>
    orderPaymentMethod ?? configuredPaymentMethod(state.systemSettings, order?.paymentMethodId || order?.paymentChannel) ?? availablePaymentMethods[0] ?? null;

  const resetPaymentForm = () => {
    const paymentMethod = defaultPaymentMethod();
    setEditingPaymentId("");
    setDraft({
      id: "",
      type: "balance",
      amount: 0,
      time: localDatetimeValue(),
      paymentMethodId: paymentMethod?.id ?? "",
      paymentMethodName: paymentMethod?.name ?? "",
      channel: paymentMethod?.channel ?? "",
      account: paymentMethod?.account ?? "",
      externalTransactionNo: "",
      proof: [],
      notes: "",
    });
    setPaymentFormOpen(false);
  };

  const startAddPayment = () => {
    if (!permission.requirePermission("create")) return;
    const paymentMethod = defaultPaymentMethod();
    setEditingPaymentId("");
    setDraft({
      id: "",
      type: "balance",
      amount: 0,
      time: localDatetimeValue(),
      paymentMethodId: paymentMethod?.id ?? "",
      paymentMethodName: paymentMethod?.name ?? "",
      channel: paymentMethod?.channel ?? "",
      account: paymentMethod?.account ?? "",
      externalTransactionNo: "",
      proof: [],
      notes: "",
    });
    setPaymentFormOpen(true);
  };

  const startEditPayment = (payment: FinancePayment) => {
    if (!permission.requirePermission("update")) return;
    setEditingPaymentId(payment.id);
    setDraft({
      id: payment.id,
      type: payment.type,
      amount: payment.amount,
      time: payment.time,
      paymentMethodId: payment.paymentMethodId || historicalFinancePaymentMethodId(`payment-${payment.id}`),
      paymentMethodName: payment.paymentMethodName || paymentChannelLabel(payment.channel ?? order?.paymentChannel ?? ""),
      channel: payment.channel ?? order?.paymentChannel ?? "",
      account: payment.account ?? "",
      externalTransactionNo: payment.externalTransactionNo ?? "",
      proof: [...(payment.proof ?? [])],
      notes: payment.notes ?? "",
    });
    setPaymentFormOpen(true);
  };

  const savePayment = async () => {
    if (!order || savingPayment) return;
    const action = editingPaymentId ? "update" : "add";
    if (!permission.requirePermission(editingPaymentId ? "update" : "create")) return;
    if (!Number.isFinite(draft.amount) || draft.amount <= 0) {
      toast.error("请输入有效的资金金额");
      return;
    }
    if (!draft.paymentMethodId || !draft.channel) return toast.error("请选择付款方式");
    if (!draft.account.trim()) return toast.error("请填写资金账户");
    if (!confirmWrite(editingPaymentId ? "修改" : "新增", `保存订单 ${order.orderNo} 的${PAYMENT_LABELS[draft.type]}记录。`)) return;
    setSavingPayment(true);
    try {
      await requestJson("/api/orders/payment", {
        method: "POST",
        body: JSON.stringify({
          orderId: order.id,
          action,
          payment: {
            ...draft,
            paymentMethodId: draft.paymentMethodId.startsWith("historical-finance-") ? "" : draft.paymentMethodId,
            id: editingPaymentId || uid(),
            amount: Number(draft.amount),
          },
        }),
      });
      resetPaymentForm();
      await onRefresh();
      toast.success("资金流水已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "资金流水保存失败");
    } finally {
      setSavingPayment(false);
    }
  };

  const deletePayment = async (payment: FinancePayment) => {
    if (!order || !permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `删除订单 ${order.orderNo} 的${PAYMENT_LABELS[payment.type]} ${money(payment.amount)}。`)) return;
    try {
      await requestJson("/api/orders/payment", {
        method: "POST",
        body: JSON.stringify({
          orderId: order.id,
          action: "delete",
          paymentId: payment.id,
        }),
      });
      await onRefresh();
      toast.success("资金流水已删除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "资金流水删除失败");
    }
  };

  const verifyPayment = async (payment: FinancePayment) => {
    if (!order || verifyingPaymentId || !permission.requirePermission("update")) return;
    const path = payment.type === "refund"
      ? payment.refundMethod === "platform" ? "平台退款冲减" : "退款账户出账"
      : "收款到账";
    if (!confirmWrite("核销", `确认订单 ${order.orderNo} 的${path} ${money(payment.amount)} 已真实发生。`)) return;
    setVerifyingPaymentId(payment.id);
    try {
      await requestJson("/api/orders/payment", {
        method: "POST",
        body: JSON.stringify({ orderId: order.id, action: "verify", paymentId: payment.id }),
      });
      await onRefresh();
      toast.success("资金记录已核销");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "资金记录核销失败");
    } finally {
      setVerifyingPaymentId("");
    }
  };

  const saveCommission = async () => {
    if (!order || savingCommission || !permission.requirePermission("update")) return;
    if (!Number.isFinite(commissionRate) || commissionRate < 0 || commissionRate > 100) {
      toast.error("提成比例必须在 0% 到 100% 之间");
      return;
    }
    setSavingCommission(true);
    try {
      await requestJson("/api/finance/order-commission", {
        method: "POST",
        body: JSON.stringify({ orderId: order.id, commissionRate }),
      });
      await onRefresh();
      toast.success("订单提成比例已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "提成比例保存失败");
    } finally {
      setSavingCommission(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="h-[92dvh] max-h-[92dvh] gap-0 overflow-hidden p-0 sm:w-[96vw] sm:max-w-[1440px]"
      >
        <DialogHeader className="border-b px-4 py-3 pr-12 sm:px-6 sm:pr-14">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base sm:text-lg">
            <span>{order?.orderNo ?? "订单财务"}</span>
            {order && <Badge variant="outline" className={orderSourceBadgeClass(order.source)}>{orderSourceLabel(order.source)}</Badge>}
            {order && <Badge variant="outline" className={financeStatusClass(order.financeStatus)}>{order.financeStatus}</Badge>}
          </DialogTitle>
          {order && (
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground sm:text-sm">
              <span>客户：<strong className="font-medium text-foreground">{order.customerName}</strong></span>
              <span>下单日期：<strong className="font-medium text-foreground">{order.date || "—"}</strong></span>
              <span>订单负责人：<strong className="font-medium text-foreground">{order.contactPerson || "—"}</strong></span>
              <span>物流：<strong className="font-medium text-foreground">{order.logisticsStatus}</strong></span>
              <span>付款申报：<strong className="font-medium text-foreground">{order.paymentMethodName || (order.paymentChannel ? paymentChannelLabel(order.paymentChannel) : "未登记")} · {order.paymentAccount || "未登记账户"}</strong></span>
              {order.platformOrderNo && <span>{platformOrderNoLabel(order.source)}：<strong className="font-medium text-foreground">{order.platformOrderNo}</strong></span>}
            </div>
          )}
        </DialogHeader>
        {order && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:overflow-hidden">
            <div className="grid shrink-0 grid-cols-2 border-b bg-muted/20 lg:grid-cols-4">
              {[
                ["订单应收", money(order.receivable)],
                ["已收", money(order.received)],
                ["已退", money(order.refunded)],
                ["余额", money(order.balance)],
              ].map(([label, value]) => (
                <div key={label} className="border-b px-4 py-3 even:border-l lg:border-b-0 lg:border-l lg:first:border-l-0">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-0.5 text-base font-semibold tabular-nums sm:text-lg">{value}</div>
                </div>
              ))}
            </div>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1.35fr)_minmax(390px,0.65fr)]">
              <div className="min-w-0 lg:overflow-y-auto">
                <section className="border-b px-4 py-4 sm:px-6">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold sm:text-base">订单商品</h3>
                      <p className="mt-0.5 text-xs text-muted-foreground">共 {order.items.length} 条，售价与最低回厂价均为下单时记录。</p>
                    </div>
                    <Badge variant="outline">{order.items.length} 条</Badge>
                  </div>

                  <div className="hidden overflow-hidden rounded-md border md:block">
                    <table className="w-full table-fixed text-sm">
                      <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                        <tr>
                          <th className="w-[42%] px-3 py-2 font-medium">商品</th>
                          <th className="w-[22%] px-3 py-2 font-medium">鱼只编码</th>
                          <th className="w-[18%] px-3 py-2 text-right font-medium">售价</th>
                          <th className="w-[18%] px-3 py-2 text-right font-medium">最低回厂价</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {order.items.map((item, index) => (
                          <tr key={`${item.stockItemId}-${index}`}>
                            <td className="px-3 py-2.5">
                              <div className="truncate font-medium" title={item.productName}>{item.productName}</div>
                              {(item.size || item.origin) && (
                                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                  {[item.size, item.origin].filter(Boolean).join(" · ")}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-mono text-xs">{item.fishCode || "—"}</span>
                                {item.inventoryRemoved && <Badge variant="outline" className="text-[10px] text-muted-foreground">已出库</Badge>}
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right font-medium tabular-nums">{money(item.price)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{money(item.minReturnPrice)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="divide-y rounded-md border md:hidden">
                    {order.items.map((item, index) => (
                      <div key={`${item.stockItemId}-${index}`} className="px-3 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{item.productName}</div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {[item.fishCode || "无鱼码", item.size, item.origin].filter(Boolean).join(" · ")}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-sm font-semibold tabular-nums">{money(item.price)}</div>
                            <div className="mt-1 text-xs text-muted-foreground">回厂价 {money(item.minReturnPrice)}</div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                <section className="px-4 py-4 sm:px-6">
                  <div className="mb-3 flex items-center gap-2">
                    <ReceiptText className="size-4 text-muted-foreground" />
                    <h3 className="text-sm font-semibold sm:text-base">订单费用构成</h3>
                  </div>
                  <div className="overflow-hidden rounded-md border">
                    <div className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
                      <span>商品售价小计</span>
                      <span className="font-medium tabular-nums">{money(order.itemSubtotal)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4 border-t px-3 py-2.5 text-sm">
                      <span>订单折扣</span>
                      <span className="tabular-nums text-rose-700">−{money(order.discount)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4 border-y bg-muted/30 px-3 py-2.5 text-sm">
                      <span className="font-medium">商品折后金额</span>
                      <span className="font-semibold tabular-nums">{money(order.goodsNetTotal)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
                      <span>订单运费</span>
                      <span className="tabular-nums">+{money(order.orderShippingFee)}</span>
                    </div>
                    {Math.abs(order.shippingFeeAdjustment) > 0.005 && (
                      <div className="flex items-center justify-between gap-4 border-t px-3 py-2.5 text-sm">
                        <span>
                          实际运费调整
                          <span className="ml-2 text-xs text-muted-foreground">计费运费 {money(order.billableShippingFee)}</span>
                        </span>
                        <span className="tabular-nums">{adjustmentMoney(order.shippingFeeAdjustment)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-4 border-t px-3 py-2.5 text-sm">
                      <span>包装费</span>
                      <span className="tabular-nums">+{money(order.packagingFee)}</span>
                    </div>
                    {order.damageRefundAdjustment > 0.005 && (
                      <div className="flex items-center justify-between gap-4 border-t px-3 py-2.5 text-sm">
                        <span>报损应收调减</span>
                        <span className="tabular-nums text-rose-700">−{money(order.damageRefundAdjustment)}</span>
                      </div>
                    )}
                    {order.cancellationAdjustment < -0.005 && (
                      <div className="flex items-center justify-between gap-4 border-t px-3 py-2.5 text-sm">
                        <span>取消订单冲销</span>
                        <span className="tabular-nums text-rose-700">{adjustmentMoney(order.cancellationAdjustment)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-4 border-t bg-foreground px-3 py-3 text-background">
                      <span className="font-semibold">订单应收</span>
                      <span className="text-lg font-semibold tabular-nums">{money(order.receivable)}</span>
                    </div>
                  </div>
                </section>
              </div>

              <div className="min-w-0 border-t bg-muted/10 lg:overflow-y-auto lg:border-l lg:border-t-0">
                {order.settlementCount > 0 && (
                  <section className="border-b px-4 py-4 sm:px-5">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h3 className="text-sm font-semibold">平台结算费用</h3>
                      <Badge variant="outline">{order.settlementCount} 条结算记录</Badge>
                    </div>
                    <div className="grid grid-cols-2 overflow-hidden rounded-md border bg-background text-sm">
                      {[
                        ["平台收入", order.platformIncome],
                        ["结算前退款", order.refunded],
                        ["平台费用", order.platformFees],
                        ["净结算", order.netSettlement],
                      ].map(([label, value], index) => (
                        <div key={String(label)} className={`px-3 py-2.5 ${index % 2 === 1 ? "border-l" : ""} ${index > 1 ? "border-t" : ""}`}>
                          <div className="text-xs text-muted-foreground">{label}</div>
                          <div className="mt-0.5 font-semibold tabular-nums">{money(Number(value))}</div>
                        </div>
                      ))}
                    </div>
                  </section>
                )}

                <section className="border-b px-4 py-4 sm:px-5">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">订单负责人提成</h3>
                      <p className="mt-1 text-xs text-muted-foreground">按商品折后金额计算，不超过最低回厂价以上空间。</p>
                    </div>
                    <div className="flex items-end gap-2">
                      <label className="grid gap-1 text-xs text-muted-foreground">
                        提成比例
                        <span className="flex items-center gap-1">
                          <Input
                            type="number"
                            min={0}
                            max={100}
                            step={0.1}
                            value={commissionRate}
                            onChange={(event) => setCommissionRate(Number(event.target.value))}
                            className="h-8 w-20 text-right"
                          />
                          %
                        </span>
                      </label>
                      <Button size="sm" onClick={saveCommission} disabled={savingCommission || !permission.canUpdate}>
                        {savingCommission ? <Loader2 className="size-4 animate-spin" /> : "保存"}
                      </Button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-x-5 gap-y-2 text-sm">
                    <div><span className="text-muted-foreground">计算基数：</span>{money(order.commissionBase)}</div>
                    <div><span className="text-muted-foreground">最低回厂：</span>{money(order.minimumReturnTotal)}</div>
                    <div><span className="text-muted-foreground">提成上限：</span>{money(order.commissionCap)}</div>
                    <div className="font-semibold text-emerald-700"><span className="font-normal text-muted-foreground">负责人提成：</span>{money(order.commissionAmount)}</div>
                  </div>
                </section>

                <section className="px-4 py-4 sm:px-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold">资金流水</h3>
                      <p className="mt-1 text-xs text-muted-foreground">私域和线下资金由财务专员补录。</p>
                    </div>
                    {!paymentFormOpen && permission.canCreate && (
                      <Button size="sm" variant="outline" onClick={startAddPayment}>
                        <Plus className="size-4" /> 新增流水
                      </Button>
                    )}
                  </div>

                  {paymentFormOpen && (
                    <div className="mb-4 grid gap-3 rounded-md border bg-background p-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                      <div className="grid gap-1.5">
                        <Label>类型</Label>
                        <Select
                          value={draft.type}
                          onValueChange={(value) => setDraft((current) => ({ ...current, type: value as PaymentType }))}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {PAYMENT_TYPES.map((type) => (
                              <SelectItem key={type} value={type}>{PAYMENT_LABELS[type]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label>金额（元）</Label>
                        <Input
                          type="number"
                          min={0}
                          step={0.01}
                          value={draft.amount || ""}
                          onChange={(event) => setDraft((current) => ({ ...current, amount: Number(event.target.value) }))}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>时间</Label>
                        <Input
                          type="datetime-local"
                          value={draft.time}
                          onChange={(event) => setDraft((current) => ({ ...current, time: event.target.value }))}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label>付款方式</Label>
                        <Select
                          value={draft.paymentMethodId}
                          onValueChange={(value) => {
                            const paymentMethod = paymentMethodOptions.find((method) => method.id === value);
                            if (!paymentMethod) return;
                            setDraft((current) => ({
                              ...current,
                              paymentMethodId: paymentMethod.id,
                              paymentMethodName: paymentMethod.name,
                              channel: paymentMethod.channel,
                              account: paymentMethod.account,
                            }));
                          }}
                        >
                          <SelectTrigger><SelectValue placeholder="请选择付款方式" /></SelectTrigger>
                          <SelectContent>
                            {paymentMethodOptions.map((method) => (
                              <SelectItem key={method.id} value={method.id}>
                                {paymentMethodDisplayLabel(method)}{method.historical ? "（历史）" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-1.5">
                        <Label>资金账户</Label>
                        <div className={`h-10 flex items-center rounded-md border bg-muted/50 px-3 text-sm ${draft.account ? "text-foreground" : "border-red-500 text-red-500"}`}>
                          {draft.account || "未配置，请先到付款方式管理设置"}
                        </div>
                      </div>
                      <div className="grid gap-1.5 sm:col-span-2 lg:col-span-1 xl:col-span-2">
                        <Label>外部流水号</Label>
                        <Input
                          value={draft.externalTransactionNo}
                          onChange={(event) => setDraft((current) => ({ ...current, externalTransactionNo: event.target.value }))}
                          placeholder="选填"
                        />
                      </div>
                      <div className="grid gap-1.5 sm:col-span-2 lg:col-span-1 xl:col-span-2">
                        <Label>备注</Label>
                        <Textarea
                          value={draft.notes}
                          onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                          rows={2}
                          placeholder="填写资金用途、付款人或差异原因"
                        />
                      </div>
                      <div className="grid gap-1.5 sm:col-span-2 lg:col-span-1 xl:col-span-2">
                        <Label>凭证</Label>
                        <ProofUploader
                          images={draft.proof}
                          onChange={(proof) => setDraft((current) => ({ ...current, proof }))}
                        />
                      </div>
                      <div className="flex justify-end gap-2 sm:col-span-2 lg:col-span-1 xl:col-span-2">
                        <Button variant="outline" size="sm" onClick={resetPaymentForm}>取消</Button>
                        <Button size="sm" onClick={savePayment} disabled={savingPayment}>
                          {savingPayment && <Loader2 className="size-4 animate-spin" />}
                          {editingPaymentId ? "保存修改" : "保存流水"}
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="divide-y rounded-md border bg-background">
                    {order.payments.length === 0 ? (
                      <div className="px-4 py-8 text-center text-sm text-muted-foreground">暂无手工资金流水</div>
                    ) : (
                      [...order.payments]
                        .sort((left, right) => String(right.time).localeCompare(String(left.time)))
                        .map((payment) => (
                          <div key={payment.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between lg:flex-col lg:items-stretch xl:flex-row xl:items-center">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                {payment.type === "refund"
                                  ? <ArrowUpRight className="size-4 text-rose-600" />
                                  : <ArrowDownLeft className="size-4 text-emerald-600" />}
                                <span className="font-medium">{PAYMENT_LABELS[payment.type]}</span>
                                <span className={payment.type === "refund" ? "font-semibold text-rose-700" : "font-semibold text-emerald-700"}>
                                  {payment.type === "refund" ? "−" : "+"}{money(payment.amount)}
                                </span>
                                <Badge
                                  variant="outline"
                                  className={payment.verificationStatus === "pending"
                                    ? "border-amber-200 bg-amber-50 text-amber-700"
                                    : "border-emerald-200 bg-emerald-50 text-emerald-700"}
                                >
                                  {payment.verificationStatus === "pending" ? "待核销" : "已核销"}
                                </Badge>
                                <span className="text-xs text-muted-foreground">{displayDatetime(payment.time)}</span>
                              </div>
                              {(payment.channel || payment.account || payment.externalTransactionNo || payment.notes) && (
                                <div className="mt-1 truncate text-xs text-muted-foreground">
                                  {[
                                    payment.paymentMethodName || (payment.channel ? paymentChannelLabel(payment.channel) : ""),
                                    payment.account ? `账户：${payment.account}` : "",
                                    payment.externalTransactionNo ? `流水：${payment.externalTransactionNo}` : "",
                                    payment.type === "refund" ? payment.refundMethod === "platform" ? "平台冲减" : "账户出账" : "",
                                    payment.notes,
                                  ].filter(Boolean).join(" · ")}
                                </div>
                              )}
                              {payment.proof.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {payment.proof.map((image, index) => (
                                    <ImageWithFallback
                                      key={`${payment.id}-proof-${index}`}
                                      src={image}
                                      alt="资金凭证"
                                      className="size-10 cursor-pointer rounded border object-cover"
                                      onClick={() => void openProofImage(image)}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1 self-end">
                              {payment.verificationStatus === "pending" && permission.canUpdate && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-8"
                                  onClick={() => void verifyPayment(payment)}
                                  disabled={verifyingPaymentId === payment.id}
                                >
                                  {verifyingPaymentId === payment.id && <Loader2 className="size-3.5 animate-spin" />}
                                  核销
                                </Button>
                              )}
                              {permission.canUpdate && (
                                <Button size="icon" variant="ghost" className="size-8" onClick={() => startEditPayment(payment)} title="修改流水">
                                  <Pencil className="size-3.5" />
                                </Button>
                              )}
                              {permission.canDelete && (
                                <Button size="icon" variant="ghost" className="size-8 text-rose-600" onClick={() => deletePayment(payment)} title="删除流水">
                                  <Trash2 className="size-3.5" />
                                </Button>
                              )}
                            </div>
                          </div>
                        ))
                    )}
                  </div>
                </section>
              </div>
            </div>
          </div>
        )}
        <DialogFooter className="shrink-0 border-t px-4 py-3 sm:px-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReconciliationLinkDialog({
  row,
  orders,
  siteId,
  open,
  onOpenChange,
  onLinked,
}: {
  row: ReconciliationRow | null;
  orders: FinanceOrderRow[];
  siteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => Promise<void>;
}) {
  const permission = usePermission("finance");
  const [search, setSearch] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setSelectedOrderId("");
  }, [open, row?.externalOrderNo]);

  const candidates = useMemo(() => {
    if (!row) return [];
    const normalized = search.trim().toLowerCase();
    const settlementDate = String(row.settlementTime ?? "").slice(0, 10);
    const settlementTimestamp = Date.parse(`${settlementDate || "1970-01-01"}T00:00:00`);
    return orders
      .filter((order) => order.source === "平台下单" || !isPlatformOrderSource(order.source))
      .filter((order) => !order.douyinOrderNo || order.douyinOrderNo === row.externalOrderNo)
      .filter((order) => !normalized || [
        order.orderNo,
        order.customerName,
        order.contactPerson,
        order.date,
        order.paymentAccount,
      ].some((value) => String(value ?? "").toLowerCase().includes(normalized)))
      .map((order) => {
        const orderTimestamp = Date.parse(`${order.date || "1970-01-01"}T00:00:00`);
        const dayDifference = Number.isFinite(orderTimestamp) && Number.isFinite(settlementTimestamp)
          ? Math.abs(orderTimestamp - settlementTimestamp) / 86_400_000
          : 999;
        const amountDifference = Math.abs(order.receivable - row.incomeTotal);
        const sourcePenalty = order.source === "平台下单" ? 0 : 500;
        return { order, score: amountDifference + dayDifference * 4 + sourcePenalty };
      })
      .sort((left, right) => left.score - right.score || String(right.order.date).localeCompare(String(left.order.date)))
      .slice(0, 60)
      .map((candidate) => candidate.order);
  }, [orders, row, search]);

  const linkOrder = async () => {
    if (!row || !selectedOrderId || saving || !permission.requirePermission("update")) return;
    const selectedOrder = orders.find((order) => order.id === selectedOrderId);
    if (!selectedOrder) return toast.error("请选择系统订单");
    if (!confirmWrite("关联", `将抖音订单 ${row.externalOrderNo} 永久关联到系统订单 ${selectedOrder.orderNo}。`)) return;
    setSaving(true);
    try {
      await requestJson("/api/finance/douyin/link", {
        method: "POST",
        body: JSON.stringify({ siteId, externalOrderNo: row.externalOrderNo, orderId: selectedOrderId }),
      });
      await onLinked();
      onOpenChange(false);
      toast.success("抖音结算已关联系统订单");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "订单关联失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="flex max-h-[92dvh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>关联抖音结算</DialogTitle>
          {row && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="font-mono">{row.externalOrderNo}</span>
              <span>平台收入 {money(row.incomeTotal)}</span>
              <span>结算 {displayDatetime(row.settlementTime)}</span>
            </div>
          )}
        </DialogHeader>
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索系统订单号、客户或订单负责人" className="pl-9" />
        </label>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {candidates.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">没有可关联的系统订单</div>
          ) : (
            <div className="divide-y">
              {candidates.map((order) => {
                const selected = selectedOrderId === order.id;
                return (
                  <button
                    key={order.id}
                    type="button"
                    className={`grid w-full gap-2 px-3 py-3 text-left sm:grid-cols-[minmax(0,1fr)_120px_120px] ${selected ? "bg-sky-50 ring-1 ring-inset ring-sky-300" : "hover:bg-muted/30"}`}
                    onClick={() => setSelectedOrderId(order.id)}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{order.orderNo} · {order.customerName}</span>
                      <span className="mt-1 block truncate text-xs text-muted-foreground">{orderSourceLabel(order.source)} · {order.contactPerson || "未指定负责人"}</span>
                    </span>
                    <span className="text-sm"><span className="text-xs text-muted-foreground">下单</span><br />{order.date || "—"}</span>
                    <span className="text-sm font-medium tabular-nums"><span className="text-xs font-normal text-muted-foreground">订单应收</span><br />{money(order.receivable)}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void linkOrder()} disabled={!selectedOrderId || saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            确认关联
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TransferDialog({
  transfer,
  importBatches,
  transfers,
  siteId,
  open,
  onOpenChange,
  onSaved,
}: {
  transfer: FinanceTransfer | null;
  importBatches: ImportBatch[];
  transfers: FinanceTransfer[];
  siteId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const permission = usePermission("finance");
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<TransferDraft>({
    id: "",
    channel: "douyin",
    sourceAccount: "抖店账户",
    targetAccount: "",
    expectedAmount: 0,
    actualAmount: 0,
    transferredAt: localDatetimeValue(),
    transactionNo: "",
    importBatchIds: [],
    proof: [],
    notes: "",
  });

  useEffect(() => {
    if (!open) return;
    setDraft(transfer ? {
      id: transfer.id,
      channel: transfer.channel,
      sourceAccount: transfer.sourceAccount,
      targetAccount: transfer.targetAccount,
      expectedAmount: transfer.expectedAmount,
      actualAmount: transfer.actualAmount,
      transferredAt: transfer.transferredAt,
      transactionNo: transfer.transactionNo,
      importBatchIds: [...transfer.importBatchIds],
      proof: [...transfer.proof],
      notes: transfer.notes,
    } : {
      id: "",
      channel: "douyin",
      sourceAccount: "抖店账户",
      targetAccount: "",
      expectedAmount: 0,
      actualAmount: 0,
      transferredAt: localDatetimeValue(),
      transactionNo: "",
      importBatchIds: [],
      proof: [],
      notes: "",
    });
  }, [open, transfer?.id]);

  const usedBatchIds = useMemo(() => new Set(
    transfers.filter((item) => item.id !== transfer?.id).flatMap((item) => item.importBatchIds)
  ), [transfers, transfer?.id]);
  const selectableBatches = useMemo(() => importBatches.filter((batch) =>
    !usedBatchIds.has(batch.id) || draft.importBatchIds.includes(batch.id)
  ), [importBatches, usedBatchIds, draft.importBatchIds]);

  const toggleBatch = (batchId: string, checked: boolean) => {
    setDraft((current) => {
      const importBatchIds = checked
        ? [...new Set([...current.importBatchIds, batchId])]
        : current.importBatchIds.filter((id) => id !== batchId);
      const expectedAmount = importBatchIds.reduce((sum, id) => {
        const batch = importBatches.find((item) => item.id === id);
        return sum + Number(batch?.totals?.settlementAmount ?? 0);
      }, 0);
      return {
        ...current,
        importBatchIds,
        expectedAmount,
        actualAmount: current.actualAmount === 0 || Math.abs(current.actualAmount - current.expectedAmount) <= 0.01
          ? expectedAmount
          : current.actualAmount,
      };
    });
  };

  const saveTransfer = async () => {
    if (saving || !permission.requirePermission(transfer ? "update" : "create")) return;
    if (!draft.channel) return toast.error("请选择资金渠道");
    if (!draft.sourceAccount.trim() || !draft.targetAccount.trim()) return toast.error("请填写转出账户和对公到账账户");
    if (!Number.isFinite(draft.actualAmount) || draft.actualAmount <= 0) return toast.error("请输入有效实际到账金额");
    if (!draft.transferredAt) return toast.error("请选择到账时间");
    if (!confirmWrite(transfer ? "修改" : "登记", `${transfer ? "修改" : "登记"}${paymentChannelLabel(draft.channel)}到账批次 ${money(draft.actualAmount)}。`)) return;
    setSaving(true);
    try {
      await requestJson("/api/finance/transfers", {
        method: "POST",
        body: JSON.stringify({
          action: transfer ? "update" : "add",
          id: transfer?.id,
          siteId,
          transfer: {
            ...draft,
            sourceAccount: draft.sourceAccount.trim(),
            targetAccount: draft.targetAccount.trim(),
            transactionNo: draft.transactionNo.trim(),
            notes: draft.notes.trim(),
          },
        }),
      });
      await onSaved();
      onOpenChange(false);
      toast.success("到账批次已保存，待财务确认核销");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "到账批次保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-h-[92dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{transfer ? "修改到账批次" : "登记到账批次"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>资金渠道<span className="ml-0.5 text-red-500">*</span></Label>
            <Select value={draft.channel} onValueChange={(value) => setDraft((current) => ({
              ...current,
              channel: value as PaymentChannel,
              sourceAccount: value === "douyin" && !current.sourceAccount.trim() ? "抖店账户" : current.sourceAccount,
              importBatchIds: value === "douyin" ? current.importBatchIds : [],
            }))}>
              <SelectTrigger><SelectValue placeholder="请选择渠道" /></SelectTrigger>
              <SelectContent>
                {PAYMENT_CHANNEL_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>到账时间<span className="ml-0.5 text-red-500">*</span></Label>
            <Input type="datetime-local" value={draft.transferredAt} onChange={(event) => setDraft((current) => ({ ...current, transferredAt: event.target.value }))} />
          </div>
          <div className="grid gap-1.5">
            <Label>转出账户<span className="ml-0.5 text-red-500">*</span></Label>
            <Input value={draft.sourceAccount} onChange={(event) => setDraft((current) => ({ ...current, sourceAccount: event.target.value }))} placeholder="抖店、微信或支付宝账户" />
          </div>
          <div className="grid gap-1.5">
            <Label>对公到账账户<span className="ml-0.5 text-red-500">*</span></Label>
            <Input value={draft.targetAccount} onChange={(event) => setDraft((current) => ({ ...current, targetAccount: event.target.value }))} placeholder="开户行及尾号" />
          </div>
          {draft.channel === "douyin" && (
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>关联抖店结算批次</Label>
              <div className="max-h-44 divide-y overflow-y-auto rounded-md border">
                {selectableBatches.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">暂无未登记到账的结算批次</div>
                ) : selectableBatches.slice(0, 40).map((batch) => (
                  <label key={batch.id} className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-muted/30">
                    <span className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        checked={draft.importBatchIds.includes(batch.id)}
                        onCheckedChange={(checked) => toggleBatch(batch.id, checked === true)}
                      />
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{batch.fileName}</span>
                        <span className="block text-xs text-muted-foreground">{displayDatetime(batch.importedAt)} · {batch.rowCount} 条</span>
                      </span>
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">{money(Number(batch.totals?.settlementAmount ?? 0))}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-1.5">
            <Label>渠道应到账</Label>
            <Input
              type="number"
              min={0}
              step={0.01}
              value={draft.expectedAmount || ""}
              readOnly={draft.channel === "douyin" && draft.importBatchIds.length > 0}
              onChange={(event) => setDraft((current) => ({ ...current, expectedAmount: Number(event.target.value) }))}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>对公实际到账<span className="ml-0.5 text-red-500">*</span></Label>
            <Input type="number" min={0} step={0.01} value={draft.actualAmount || ""} onChange={(event) => setDraft((current) => ({ ...current, actualAmount: Number(event.target.value) }))} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>银行流水号</Label>
            <Input value={draft.transactionNo} onChange={(event) => setDraft((current) => ({ ...current, transactionNo: event.target.value }))} placeholder="选填" />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>备注</Label>
            <Textarea rows={2} value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>到账凭证</Label>
            <ProofUploader images={draft.proof} onChange={(proof) => setDraft((current) => ({ ...current, proof }))} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={() => void saveTransfer()} disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
      <FileSpreadsheet className="mb-3 size-7" />
      {children}
    </div>
  );
}

export function FinanceView() {
  const { activeSiteId } = useStore();
  const permission = usePermission("finance");
  const canAccess = permission.isAdmin || permission.canCreate || permission.canUpdate || permission.canDelete;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [data, setData] = useState<FinanceOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [financeFilter, setFinanceFilter] = useState("all");
  const [ledgerMode, setLedgerMode] = useState<"orders" | "transactions" | "transfers">("orders");
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [selectedReconciliationNo, setSelectedReconciliationNo] = useState("");
  const [selectedTransferId, setSelectedTransferId] = useState("");
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [verifyingTransferId, setVerifyingTransferId] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [csvPanelOpen, setCsvPanelOpen] = useState(false);
  const [defaultCommissionRate, setDefaultCommissionRate] = useState(1);
  const [savingSettings, setSavingSettings] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvText, setCsvText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);

  const loadOverview = useCallback(async (quiet = false) => {
    if (!canAccess) {
      setLoading(false);
      return;
    }
    if (quiet) setRefreshing(true);
    else {
      setLoading(true);
      setData(null);
    }
    setError("");
    try {
      const result = await requestJson(`/api/finance/overview?siteId=${encodeURIComponent(activeSiteId)}`);
      setData(result as FinanceOverview);
      setDefaultCommissionRate(Number(result.settings?.defaultCommissionRate ?? 1));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "财务数据加载失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activeSiteId, canAccess]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    setCsvFile(null);
    setCsvText("");
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [activeSiteId]);

  const selectedOrder = data?.orders.find((order) => order.id === selectedOrderId) ?? null;
  const selectedReconciliation = data?.reconciliations.find((row) => row.externalOrderNo === selectedReconciliationNo) ?? null;
  const selectedTransfer = data?.transfers.find((transfer) => transfer.id === selectedTransferId) ?? null;
  const normalizedSearch = search.trim().toLowerCase();
  const filteredOrders = useMemo(() => (data?.orders ?? []).filter((order) => {
    if (financeFilter !== "all" && order.financeStatus !== financeFilter) return false;
    if (!normalizedSearch) return true;
    return [
      order.orderNo,
      order.platformOrderNo,
      order.customerName,
      order.contactPerson,
      order.source,
    ].some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch));
  }), [data?.orders, financeFilter, normalizedSearch]);
  const filteredTransactions = useMemo(() => (data?.transactions ?? []).filter((transaction) => {
    if (!normalizedSearch) return true;
    return [
      transaction.orderNo,
      transaction.customerName,
      transaction.contactPerson,
      transaction.channel,
      transaction.account,
      transaction.externalTransactionNo,
      transaction.notes,
    ].some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch));
  }), [data?.transactions, normalizedSearch]);
  const filteredTransfers = useMemo(() => (data?.transfers ?? []).filter((transfer) => {
    if (!normalizedSearch) return true;
    return [
      transfer.sourceAccount,
      transfer.targetAccount,
      transfer.transactionNo,
      transfer.notes,
      paymentChannelLabel(transfer.channel),
    ].some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch));
  }), [data?.transfers, normalizedSearch]);
  const unresolvedReconciliations = useMemo(
    () => (data?.reconciliations ?? []).filter((row) => row.status !== "已匹配"),
    [data?.reconciliations],
  );

  const saveDefaultCommissionRate = async () => {
    if (!permission.requirePermission("update") || savingSettings) return;
    if (!Number.isFinite(defaultCommissionRate) || defaultCommissionRate < 0 || defaultCommissionRate > 100) {
      toast.error("默认提成比例必须在 0% 到 100% 之间");
      return;
    }
    setSavingSettings(true);
    try {
      await requestJson("/api/finance/settings", {
        method: "POST",
        body: JSON.stringify({ defaultCommissionRate }),
      });
      setSettingsOpen(false);
      await loadOverview(true);
      toast.success("默认提成比例已保存");
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "默认提成比例保存失败");
    } finally {
      setSavingSettings(false);
    }
  };

  const chooseCsv = async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      toast.error("请选择 CSV 格式的抖店结算文件");
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast.error("CSV 文件不能超过 12MB");
      return;
    }
    setCsvFile(file);
    setPreview(null);
    setCsvText(await file.text());
  };

  const previewCsv = async () => {
    if (!csvFile || !csvText || previewing) return;
    if (activeSiteId === "all") {
      toast.error("请先选择具体场地再导入抖店账单");
      return;
    }
    setPreviewing(true);
    try {
      const result = await requestJson("/api/finance/douyin/preview", {
        method: "POST",
        body: JSON.stringify({
          siteId: activeSiteId,
          fileName: csvFile.name,
          csvText,
        }),
      });
      setPreview(result as ImportPreview);
      toast.success(`已解析 ${result.rowCount} 条结算记录`);
    } catch (previewError) {
      toast.error(previewError instanceof Error ? previewError.message : "抖店账单解析失败");
    } finally {
      setPreviewing(false);
    }
  };

  const importCsv = async () => {
    if (!csvFile || !csvText || !preview || importing || !permission.requirePermission("create")) return;
    if (!confirmWrite("导入", `导入抖店结算文件「${csvFile.name}」共 ${preview.rowCount} 条记录。`)) return;
    setImporting(true);
    try {
      const result = await requestJson("/api/finance/douyin/import", {
        method: "POST",
        body: JSON.stringify({
          siteId: activeSiteId,
          fileName: csvFile.name,
          csvText,
        }),
      });
      setCsvFile(null);
      setCsvText("");
      setPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadOverview(true);
      toast.success(result.duplicateFile
        ? "该文件已经导入，本次未重复写入"
        : `导入完成：匹配 ${result.matchedCount} 条，未匹配 ${result.unmatchedCount} 条`
      );
    } catch (importError) {
      toast.error(importError instanceof Error ? importError.message : "抖店账单导入失败");
    } finally {
      setImporting(false);
    }
  };

  const openNewTransfer = () => {
    if (!permission.requirePermission("create")) return;
    if (activeSiteId === "all") return toast.error("请先选择具体场地再登记到账批次");
    setSelectedTransferId("");
    setTransferDialogOpen(true);
  };

  const verifyTransfer = async (transfer: FinanceTransfer) => {
    if (verifyingTransferId || !permission.requirePermission("update")) return;
    if (!confirmWrite("核销", `确认 ${paymentChannelLabel(transfer.channel)} 到对公账户的 ${money(transfer.actualAmount)} 已实际到账。`)) return;
    setVerifyingTransferId(transfer.id);
    try {
      await requestJson("/api/finance/transfers", {
        method: "POST",
        body: JSON.stringify({ action: "verify", id: transfer.id }),
      });
      await loadOverview(true);
      toast.success("到账批次已核销");
    } catch (verifyError) {
      toast.error(verifyError instanceof Error ? verifyError.message : "到账批次核销失败");
    } finally {
      setVerifyingTransferId("");
    }
  };

  const deleteTransfer = async (transfer: FinanceTransfer) => {
    if (!permission.requirePermission("delete")) return;
    if (!confirmWrite("删除", `删除 ${paymentChannelLabel(transfer.channel)} 到账批次 ${money(transfer.actualAmount)}。`)) return;
    try {
      await requestJson("/api/finance/transfers", {
        method: "POST",
        body: JSON.stringify({ action: "delete", id: transfer.id }),
      });
      await loadOverview(true);
      toast.success("到账批次已删除");
    } catch (deleteError) {
      toast.error(deleteError instanceof Error ? deleteError.message : "到账批次删除失败");
    }
  };

  if (!canAccess) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        当前账户没有财务模块权限。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2>财务台账</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            逐单核对订单应收、收款、退款、平台扣费和订单负责人提成
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {permission.canCreate && (
            <Button
              variant={csvPanelOpen ? "secondary" : "outline"}
              size="sm"
              onClick={() => setCsvPanelOpen((open) => !open)}
            >
              <Upload className="size-4" /> 导入抖店结算
            </Button>
          )}
          {permission.canUpdate && (
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="size-4" /> 提成设置
            </Button>
          )}
          <Button variant="outline" size="icon" onClick={() => void loadOverview(true)} disabled={refreshing} title="刷新财务数据">
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => void loadOverview()}>重试</Button>
        </div>
      )}

      <section className="order-2 flex flex-col gap-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-1 rounded-md border bg-muted/20 p-1">
              <Button
                size="sm"
                variant={ledgerMode === "orders" ? "default" : "ghost"}
                onClick={() => setLedgerMode("orders")}
                className="h-8"
              >
                <ReceiptText className="size-4" /> 按订单
              </Button>
              <Button
                size="sm"
                variant={ledgerMode === "transactions" ? "default" : "ghost"}
                onClick={() => setLedgerMode("transactions")}
                className="h-8"
              >
                <History className="size-4" /> 资金流水
              </Button>
              <Button
                size="sm"
                variant={ledgerMode === "transfers" ? "default" : "ghost"}
                onClick={() => setLedgerMode("transfers")}
                className="h-8"
              >
                <Landmark className="size-4" /> 到账批次
              </Button>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="relative min-w-0 sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={ledgerMode === "transfers" ? "账户、银行流水号或备注" : "订单号、客户或订单负责人"}
                  className="pl-9"
                />
              </label>
              {ledgerMode === "orders" && (
                <Select value={financeFilter} onValueChange={setFinanceFilter}>
                  <SelectTrigger className="w-full sm:w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部财务状态</SelectItem>
                    <SelectItem value="未核销">未核销</SelectItem>
                    <SelectItem value="部分收款">部分收款</SelectItem>
                    <SelectItem value="待核对">待核对</SelectItem>
                    <SelectItem value="已核销">已核销</SelectItem>
                    <SelectItem value="待退款">待退款</SelectItem>
                    <SelectItem value="有差异">有差异</SelectItem>
                  </SelectContent>
                </Select>
              )}
              {ledgerMode === "transfers" && permission.canCreate && (
                <Button onClick={openNewTransfer}>
                  <Plus className="size-4" />登记到账批次
                </Button>
              )}
            </div>
          </div>

          {loading ? (
            <LoadingRows />
          ) : ledgerMode === "orders" ? (
            filteredOrders.length === 0 ? (
              <EmptyState>没有符合条件的订单财务记录</EmptyState>
            ) : (
              <>
                <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
                  <table className="w-full min-w-[1180px] table-fixed text-sm [&_td]:px-2.5 [&_th]:px-2.5">
                    <colgroup>
                      <col style={{ width: "10%" }} />
                      <col style={{ width: "16%" }} />
                      <col style={{ width: "9%" }} />
                      <col style={{ width: "9%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "7%" }} />
                      <col style={{ width: "7%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "8%" }} />
                      <col style={{ width: "6%" }} />
                      <col style={{ width: "7%" }} />
                      <col style={{ width: "5%" }} />
                    </colgroup>
                    <thead className="bg-muted/50 text-[15px] text-foreground">
                      <tr>
                        <th className="px-3 py-3 text-left font-semibold">订单</th>
                        <th className="px-3 py-3 text-left font-semibold">客户 / 来源</th>
                        <th className="px-3 py-3 text-left font-semibold">订单负责人</th>
                        <th className="px-3 py-3 text-right font-semibold">订单应收</th>
                        <th className="px-3 py-3 text-right font-semibold">已收</th>
                        <th className="px-3 py-3 text-right font-semibold">已退</th>
                        <th className="px-3 py-3 text-right font-semibold">平台费用</th>
                        <th className="px-3 py-3 text-right font-semibold">余额</th>
                        <th className="px-3 py-3 text-right font-semibold leading-5">订单负责人<br />提成</th>
                        <th className="px-3 py-3 text-left font-semibold">物流</th>
                        <th className="px-3 py-3 text-left font-semibold">财务</th>
                        <th className="px-3 py-3 text-right font-semibold">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filteredOrders.map((order) => (
                        <tr key={order.id} className="hover:bg-muted/20">
                          <td className="whitespace-nowrap px-3 py-2.5">
                            <div className="font-medium">{order.orderNo}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">{order.date}</div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="truncate font-medium" title={order.customerName}>{order.customerName}</div>
                            <Badge
                              variant="outline"
                              className={`mt-1 h-6 px-2 py-0 text-[12px] font-medium ${orderSourceBadgeClass(order.source)}`}
                            >
                              {orderSourceLabel(order.source)}
                            </Badge>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5">{order.contactPerson || "—"}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{money(order.receivable)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-emerald-700">{money(order.received)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-rose-700">{money(order.refunded)}</td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">{money(order.platformFees)}</td>
                          <td className={`whitespace-nowrap px-3 py-2.5 text-right font-medium tabular-nums ${order.balance > 0.01 ? "text-amber-700" : order.balance < -0.01 ? "text-rose-700" : ""}`}>
                            {money(order.balance)}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="whitespace-nowrap font-medium tabular-nums">{money(order.commissionAmount)}</div>
                            <div className="text-xs text-muted-foreground">{order.commissionRate}%</div>
                          </td>
                          <td className="px-3 py-2.5 text-muted-foreground">{order.logisticsStatus}</td>
                          <td className="px-3 py-2.5">
                            <Badge variant="outline" className={financeStatusClass(order.financeStatus)}>
                              {order.financeStatus}
                            </Badge>
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <Button size="sm" variant="outline" onClick={() => setSelectedOrderId(order.id)}>
                              处理
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="divide-y rounded-lg border bg-card md:hidden">
                  {filteredOrders.map((order) => (
                    <button
                      key={order.id}
                      type="button"
                      onClick={() => setSelectedOrderId(order.id)}
                      className="w-full px-3 py-3 text-left active:bg-muted/40"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{order.orderNo} · {order.customerName}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <Badge
                              variant="outline"
                              className={`h-6 px-2 py-0 text-[12px] font-medium ${orderSourceBadgeClass(order.source)}`}
                            >
                              {orderSourceLabel(order.source)}
                            </Badge>
                            <span>{order.contactPerson || "未指定订单负责人"}</span>
                            <span>·</span>
                            <span>{order.logisticsStatus}</span>
                          </div>
                        </div>
                        <Badge variant="outline" className={financeStatusClass(order.financeStatus)}>
                          {order.financeStatus}
                        </Badge>
                      </div>
                      <div className="finance-mobile-two-columns mt-3 grid grid-cols-4 gap-2 text-xs sm:grid-cols-4">
                        <div><div className="text-muted-foreground">订单应收</div><div className="mt-0.5 font-medium">{money(order.receivable)}</div></div>
                        <div><div className="text-muted-foreground">已收</div><div className="mt-0.5 font-medium text-emerald-700">{money(order.received)}</div></div>
                        <div><div className="text-muted-foreground">余额</div><div className="mt-0.5 font-medium">{money(order.balance)}</div></div>
                        <div><div className="text-muted-foreground">提成</div><div className="mt-0.5 font-medium">{money(order.commissionAmount)}</div></div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )
          ) : ledgerMode === "transactions" ? (
            filteredTransactions.length === 0 ? (
              <EmptyState>暂无符合条件的手工资金流水</EmptyState>
            ) : (
              <>
              <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 text-left font-medium">时间</th>
                      <th className="px-3 py-2.5 text-left font-medium">订单</th>
                      <th className="px-3 py-2.5 text-left font-medium">客户 / 订单负责人</th>
                      <th className="px-3 py-2.5 text-left font-medium">类型</th>
                      <th className="px-3 py-2.5 text-right font-medium">金额</th>
                      <th className="px-3 py-2.5 text-left font-medium">渠道 / 账户</th>
                      <th className="px-3 py-2.5 text-left font-medium">核销</th>
                      <th className="px-3 py-2.5 text-left font-medium">备注</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredTransactions.map((transaction) => (
                      <tr key={`${transaction.orderId}-${transaction.id}`}>
                        <td className="px-3 py-2.5 text-muted-foreground">{displayDatetime(transaction.time)}</td>
                        <td className="px-3 py-2.5 font-medium">{transaction.orderNo}</td>
                        <td className="px-3 py-2.5">
                          <div>{transaction.customerName}</div>
                          <div className="text-xs text-muted-foreground">{transaction.contactPerson || "—"}</div>
                        </td>
                        <td className="px-3 py-2.5">{PAYMENT_LABELS[transaction.type]}</td>
                        <td className={`px-3 py-2.5 text-right font-medium tabular-nums ${transaction.type === "refund" ? "text-rose-700" : "text-emerald-700"}`}>
                          {transaction.type === "refund" ? "−" : "+"}{money(transaction.amount)}
                        </td>
                        <td className="px-3 py-2.5">
                          <div>{transaction.channel ? paymentChannelLabel(transaction.channel) : "未登记渠道"}</div>
                          <div className="text-xs text-muted-foreground">{transaction.account || "未登记账户"}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant="outline" className={transaction.verificationStatus === "pending" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}>
                            {transaction.verificationStatus === "pending" ? "待核销" : "已核销"}
                          </Badge>
                        </td>
                        <td className="max-w-72 truncate px-3 py-2.5 text-muted-foreground">{transaction.notes || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="divide-y rounded-lg border bg-card md:hidden">
                {filteredTransactions.map((transaction) => (
                  <button
                    key={`${transaction.orderId}-${transaction.id}`}
                    type="button"
                    onClick={() => setSelectedOrderId(transaction.orderId)}
                    className="w-full px-3 py-3 text-left active:bg-muted/40"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium">{PAYMENT_LABELS[transaction.type]} · {transaction.orderNo}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{displayDatetime(transaction.time)}</div>
                      </div>
                      <div className={`shrink-0 font-semibold tabular-nums ${transaction.type === "refund" ? "text-rose-700" : "text-emerald-700"}`}>
                        {transaction.type === "refund" ? "−" : "+"}{money(transaction.amount)}
                      </div>
                    </div>
                    <div className="mt-2 text-xs text-muted-foreground">
                      {transaction.customerName} · {transaction.contactPerson || "未指定订单负责人"}
                    </div>
                    {(transaction.channel || transaction.account || transaction.notes || transaction.proof.length > 0) && (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {[transaction.channel ? paymentChannelLabel(transaction.channel) : "", transaction.account, transaction.verificationStatus === "pending" ? "待核销" : "已核销", transaction.notes, transaction.proof.length > 0 ? `凭证 ${transaction.proof.length} 张` : ""].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </button>
                ))}
              </div>
              </>
            )
          ) : filteredTransfers.length === 0 ? (
            <EmptyState>暂无到账批次记录</EmptyState>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
                <table className="w-full min-w-[980px] text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 text-left font-medium">到账时间</th>
                      <th className="px-3 py-2.5 text-left font-medium">渠道</th>
                      <th className="px-3 py-2.5 text-left font-medium">转出账户</th>
                      <th className="px-3 py-2.5 text-left font-medium">对公到账账户</th>
                      <th className="px-3 py-2.5 text-right font-medium">渠道应到账</th>
                      <th className="px-3 py-2.5 text-right font-medium">实际到账</th>
                      <th className="px-3 py-2.5 text-right font-medium">差异</th>
                      <th className="px-3 py-2.5 text-left font-medium">状态</th>
                      <th className="px-3 py-2.5 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredTransfers.map((transfer) => (
                      <tr key={transfer.id}>
                        <td className="px-3 py-2.5 text-muted-foreground">{displayDatetime(transfer.transferredAt)}</td>
                        <td className="px-3 py-2.5 font-medium">{paymentChannelLabel(transfer.channel)}</td>
                        <td className="px-3 py-2.5">{transfer.sourceAccount}</td>
                        <td className="px-3 py-2.5">{transfer.targetAccount}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">{money(transfer.expectedAmount)}</td>
                        <td className="px-3 py-2.5 text-right font-medium tabular-nums">{money(transfer.actualAmount)}</td>
                        <td className={`px-3 py-2.5 text-right tabular-nums ${Math.abs(transfer.difference) > 0.01 ? "text-amber-700" : "text-muted-foreground"}`}>
                          {adjustmentMoney(transfer.difference)}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant="outline" className={transfer.status === "verified" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                            {transfer.status === "verified" ? "已核销" : "待核销"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex justify-end gap-1">
                            {transfer.status === "pending" && permission.canUpdate && (
                              <Button size="sm" variant="outline" onClick={() => void verifyTransfer(transfer)} disabled={verifyingTransferId === transfer.id}>
                                {verifyingTransferId === transfer.id && <Loader2 className="size-3.5 animate-spin" />}
                                核销
                              </Button>
                            )}
                            {transfer.status === "pending" && permission.canUpdate && (
                              <Button size="icon" variant="ghost" className="size-8" title="修改到账批次" onClick={() => { setSelectedTransferId(transfer.id); setTransferDialogOpen(true); }}>
                                <Pencil className="size-3.5" />
                              </Button>
                            )}
                            {transfer.status === "pending" && permission.canDelete && (
                              <Button size="icon" variant="ghost" className="size-8 text-rose-600" title="删除到账批次" onClick={() => void deleteTransfer(transfer)}>
                                <Trash2 className="size-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="divide-y rounded-lg border bg-card md:hidden">
                {filteredTransfers.map((transfer) => (
                  <div key={transfer.id} className="px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">{paymentChannelLabel(transfer.channel)} · {money(transfer.actualAmount)}</div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{transfer.sourceAccount} → {transfer.targetAccount}</div>
                      </div>
                      <Badge variant="outline" className={transfer.status === "verified" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}>
                        {transfer.status === "verified" ? "已核销" : "待核销"}
                      </Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                      <div><span className="text-muted-foreground">渠道应到</span><div className="font-medium">{money(transfer.expectedAmount)}</div></div>
                      <div><span className="text-muted-foreground">差异</span><div className="font-medium">{adjustmentMoney(transfer.difference)}</div></div>
                      <div><span className="text-muted-foreground">到账时间</span><div className="font-medium">{displayDatetime(transfer.transferredAt)}</div></div>
                    </div>
                    <div className="mt-3 flex justify-end gap-1">
                      {transfer.status === "pending" && permission.canUpdate && (
                        <Button size="sm" variant="outline" onClick={() => void verifyTransfer(transfer)}>核销</Button>
                      )}
                      {transfer.status === "pending" && permission.canUpdate && (
                        <Button size="sm" variant="ghost" onClick={() => { setSelectedTransferId(transfer.id); setTransferDialogOpen(true); }}>修改</Button>
                      )}
                      {transfer.status === "pending" && permission.canDelete && (
                        <Button size="icon" variant="ghost" className="size-8 text-rose-600" onClick={() => void deleteTransfer(transfer)} title="删除到账批次"><Trash2 className="size-3.5" /></Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
      </section>

      {csvPanelOpen && (
        <div className="order-1 flex flex-col gap-4">
          <section className="rounded-lg border bg-card">
            <div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-semibold">导入抖店结算 CSV</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  预览确认后自动写回对应订单；同一文件和重复结算行不会重复写入。
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Upload className="size-4" /> 选择 CSV
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(event) => event.target.files?.[0] && void chooseCsv(event.target.files[0])}
                />
                <Button size="sm" onClick={previewCsv} disabled={!csvFile || previewing}>
                  {previewing ? <Loader2 className="size-4 animate-spin" /> : <FileSpreadsheet className="size-4" />}
                  解析预览
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setCsvPanelOpen(false)}
                  title="收起导入"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </div>
            <div className="px-4 py-3">
              {csvFile ? (
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{csvFile.name}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {(csvFile.size / 1024).toFixed(1)} KB · 当前场地 {activeSiteId}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setCsvFile(null);
                      setCsvText("");
                      setPreview(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    title="移除文件"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
              ) : (
                <div className="py-4 text-center text-sm text-muted-foreground">
                  尚未选择抖店结算文件
                </div>
              )}
            </div>
          </section>

          {preview && (
            <section className="rounded-lg border bg-card">
              <div className="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  <span>记录 <strong>{preview.rowCount}</strong></span>
                  <span className="text-emerald-700">已匹配 <strong>{preview.matchedCount}</strong></span>
                  <span className="text-rose-700">未匹配 <strong>{preview.unmatchedCount}</strong></span>
                  <span className="text-muted-foreground">重复 <strong>{preview.duplicateCount}</strong></span>
                  <span>净结算 <strong>{money(preview.totals.settlementAmount)}</strong></span>
                </div>
                <Button
                  size="sm"
                  onClick={importCsv}
                  disabled={importing || preview.duplicateFile || !permission.canCreate}
                >
                  {importing ? <Loader2 className="size-4 animate-spin" /> : <FileCheck2 className="size-4" />}
                  {preview.duplicateFile ? "该文件已导入" : "确认导入"}
                </Button>
              </div>
              {(preview.unmatchedCount > 0 || preview.formulaMismatchCount > 0 || preview.errors.length > 0) && (
                <div className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-800">
                  未匹配 {preview.unmatchedCount} 条，公式异常 {preview.formulaMismatchCount} 条，解析提示 {preview.errors.length} 条；可导入后继续在下方核对。
                </div>
              )}
              <div className="max-h-80 overflow-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">抖音订单</th>
                      <th className="px-3 py-2 text-left font-medium">系统订单</th>
                      <th className="px-3 py-2 text-left font-medium">商品</th>
                      <th className="px-3 py-2 text-right font-medium">收入</th>
                      <th className="px-3 py-2 text-right font-medium">退款</th>
                      <th className="px-3 py-2 text-right font-medium">平台费用</th>
                      <th className="px-3 py-2 text-right font-medium">净结算</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {preview.rows.map((row) => (
                      <tr key={`${row.rowNumber}-${row.externalOrderNo}`} className={row.duplicate ? "text-muted-foreground" : ""}>
                        <td className="px-3 py-2 font-mono text-xs">{row.externalOrderNo}</td>
                        <td className="px-3 py-2">
                          {row.matchedOrderNo || <span className="text-rose-700">未匹配</span>}
                          {row.duplicate && <span className="ml-2 text-xs">重复</span>}
                        </td>
                        <td className="max-w-72 truncate px-3 py-2">{row.productName}</td>
                        <td className="px-3 py-2 text-right">{money(row.incomeTotal)}</td>
                        <td className="px-3 py-2 text-right text-rose-700">{money(row.refundTotal)}</td>
                        <td className="px-3 py-2 text-right">{money(row.platformFees)}</td>
                        <td className="px-3 py-2 text-right font-medium">{money(row.settlementAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div>
            <h3 className="text-sm font-semibold">需要人工核对</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              这里只保留金额有差异或未找到系统订单的记录；正常匹配结果已自动写入订单台账。
            </p>
          </div>

          {loading ? (
            <LoadingRows />
          ) : unresolvedReconciliations.length === 0 ? (
            <EmptyState>当前没有需要人工核对的抖店结算记录</EmptyState>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
                <table className="w-full min-w-[1040px] text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 text-left font-medium">抖音订单</th>
                      <th className="px-3 py-2.5 text-left font-medium">系统订单</th>
                      <th className="px-3 py-2.5 text-left font-medium">结算时间</th>
                      <th className="px-3 py-2.5 text-right font-medium">系统应收</th>
                      <th className="px-3 py-2.5 text-right font-medium">平台收入</th>
                      <th className="px-3 py-2.5 text-right font-medium">退款</th>
                      <th className="px-3 py-2.5 text-right font-medium">平台费用</th>
                      <th className="px-3 py-2.5 text-right font-medium">净结算</th>
                      <th className="px-3 py-2.5 text-right font-medium">差异</th>
                      <th className="px-3 py-2.5 text-left font-medium">状态</th>
                      <th className="px-3 py-2.5 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {unresolvedReconciliations.map((row) => (
                      <tr key={row.externalOrderNo}>
                        <td className="px-3 py-2.5 font-mono text-xs">{row.externalOrderNo}</td>
                        <td className="px-3 py-2.5">{row.internalOrderNo || "—"}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">{displayDatetime(row.settlementTime)}</td>
                        <td className="px-3 py-2.5 text-right">{row.systemReceivable == null ? "—" : money(row.systemReceivable)}</td>
                        <td className="px-3 py-2.5 text-right">{money(row.incomeTotal)}</td>
                        <td className="px-3 py-2.5 text-right text-rose-700">{money(row.refundTotal)}</td>
                        <td className="px-3 py-2.5 text-right">{money(row.platformFees)}</td>
                        <td className="px-3 py-2.5 text-right font-medium">{money(row.settlementAmount)}</td>
                        <td className={`px-3 py-2.5 text-right font-medium ${Math.abs(row.difference ?? 0) > 0.01 ? "text-amber-700" : ""}`}>
                          {row.difference == null ? "—" : money(row.difference)}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge variant="outline" className={reconciliationStatusClass(row.status)}>
                            {row.status}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {row.status === "未匹配" && permission.canUpdate ? (
                            <Button size="sm" variant="outline" onClick={() => setSelectedReconciliationNo(row.externalOrderNo)}>
                              <Link2 className="size-3.5" />关联订单
                            </Button>
                          ) : row.internalOrderId ? (
                            <Button size="sm" variant="ghost" onClick={() => setSelectedOrderId(row.internalOrderId)}>查看订单</Button>
                          ) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="divide-y rounded-lg border bg-card md:hidden">
                {unresolvedReconciliations.map((row) => (
                  <div key={row.externalOrderNo} className="px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs">{row.externalOrderNo}</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {row.internalOrderNo || "未关联系统订单"} · {displayDatetime(row.settlementTime)}
                        </div>
                      </div>
                      <Badge variant="outline" className={reconciliationStatusClass(row.status)}>
                        {row.status}
                      </Badge>
                    </div>
                    <div className="finance-mobile-three-columns mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div><div className="text-muted-foreground">平台收入</div><div className="mt-0.5 font-medium">{money(row.incomeTotal)}</div></div>
                      <div><div className="text-muted-foreground">平台费用</div><div className="mt-0.5 font-medium">{money(row.platformFees)}</div></div>
                      <div><div className="text-muted-foreground">净结算</div><div className="mt-0.5 font-medium">{money(row.settlementAmount)}</div></div>
                    </div>
                    <div className={`mt-2 text-xs ${Math.abs(row.difference ?? 0) > 0.01 ? "text-amber-700" : "text-muted-foreground"}`}>
                      系统应收 {row.systemReceivable == null ? "—" : money(row.systemReceivable)} · 差异 {row.difference == null ? "—" : money(row.difference)}
                    </div>
                    <div className="mt-3 flex justify-end">
                      {row.status === "未匹配" && permission.canUpdate ? (
                        <Button size="sm" variant="outline" onClick={() => setSelectedReconciliationNo(row.externalOrderNo)}>
                          <Link2 className="size-3.5" />关联订单
                        </Button>
                      ) : row.internalOrderId ? (
                        <Button size="sm" variant="ghost" onClick={() => setSelectedOrderId(row.internalOrderId)}>查看订单</Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {(data?.importBatches.length ?? 0) > 0 && (
            <section className="border-t pt-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <History className="size-4" /> 最近导入
              </div>
              <div className="divide-y rounded-lg border bg-card">
                {data?.importBatches.slice(0, 8).map((batch) => (
                  <div key={batch.id} className="flex flex-col gap-1 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{batch.fileName}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {displayDatetime(batch.importedAt)} · {batch.importedBy}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {batch.rowCount} 条 · 匹配 {batch.matchedCount} · 未匹配 {batch.unmatchedCount} · 重复 {batch.duplicateCount}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      <OrderFinanceDialog
        order={selectedOrder}
        open={!!selectedOrder}
        onOpenChange={(open) => {
          if (!open) setSelectedOrderId("");
        }}
        onRefresh={() => loadOverview(true)}
      />

      <ReconciliationLinkDialog
        row={selectedReconciliation}
        orders={data?.orders ?? []}
        siteId={activeSiteId}
        open={!!selectedReconciliation}
        onOpenChange={(open) => {
          if (!open) setSelectedReconciliationNo("");
        }}
        onLinked={() => loadOverview(true)}
      />

      <TransferDialog
        transfer={selectedTransfer}
        importBatches={data?.importBatches ?? []}
        transfers={data?.transfers ?? []}
        siteId={activeSiteId}
        open={transferDialogOpen}
        onOpenChange={(open) => {
          setTransferDialogOpen(open);
          if (!open) setSelectedTransferId("");
        }}
        onSaved={() => loadOverview(true)}
      />

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle>订单负责人提成设置</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>默认提成比例</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={defaultCommissionRate}
                  onChange={(event) => setDefaultCommissionRate(Number(event.target.value))}
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              默认按商品折后金额计算，并受最低回厂价以上的可提成空间限制。单个订单可以在订单财务详情中覆盖该比例。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>取消</Button>
            <Button onClick={saveDefaultCommissionRate} disabled={savingSettings}>
              {savingSettings && <Loader2 className="size-4 animate-spin" />}
              保存设置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
