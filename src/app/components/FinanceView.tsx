import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PaymentRecord, PaymentType, uid, useStore } from "../store";
import { authJsonHeaders } from "../utils/authSession";
import { uploadOriginalMedia, resolveMediaUrl } from "../utils/media";
import { usePermission } from "../utils/permissions";
import { confirmWrite } from "../utils/writeConfirm";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
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

type FinanceOrderRow = {
  id: string;
  siteId: string;
  orderNo: string;
  douyinOrderNo: string;
  date: string;
  source: string;
  customerName: string;
  contactPerson: string;
  logisticsStatus: string;
  financeStatus: string;
  receivable: number;
  received: number;
  refunded: number;
  balance: number;
  platformFees: number;
  netSettlement: number;
  settlementCount: number;
  commissionRate: number;
  commissionBase: number;
  minimumReturnTotal: number;
  commissionCap: number;
  commissionAmount: number;
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
  account: string;
  proof: string[];
  notes: string;
};

function money(value: number) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function localDatetimeValue() {
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000);
  return now.toISOString().slice(0, 16);
}

function displayDatetime(value: string) {
  if (!value) return "—";
  return value.replace("T", " ").slice(0, 16);
}

function sourceLabel(source: string) {
  if (source === "平台下单") return "抖音";
  if (source === "私域线上") return "线上私域";
  if (source === "线下") return "线下自提";
  return source || "未标注";
}

function financeStatusClass(status: string) {
  if (status === "已核销") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "有差异" || status === "待退款") return "border-rose-200 bg-rose-50 text-rose-700";
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
  const permission = usePermission("finance");
  const [editingPaymentId, setEditingPaymentId] = useState("");
  const [paymentFormOpen, setPaymentFormOpen] = useState(false);
  const [savingPayment, setSavingPayment] = useState(false);
  const [savingCommission, setSavingCommission] = useState(false);
  const [commissionRate, setCommissionRate] = useState(1);
  const [draft, setDraft] = useState<PaymentDraft>({
    id: "",
    type: "balance",
    amount: 0,
    time: localDatetimeValue(),
    account: "",
    proof: [],
    notes: "",
  });

  useEffect(() => {
    if (!open || !order) return;
    setCommissionRate(order.commissionRate);
    setPaymentFormOpen(false);
    setEditingPaymentId("");
  }, [open, order?.id, order?.commissionRate]);

  const resetPaymentForm = () => {
    setEditingPaymentId("");
    setDraft({
      id: "",
      type: "balance",
      amount: 0,
      time: localDatetimeValue(),
      account: "",
      proof: [],
      notes: "",
    });
    setPaymentFormOpen(false);
  };

  const startAddPayment = () => {
    if (!permission.requirePermission("create")) return;
    setEditingPaymentId("");
    setDraft({
      id: "",
      type: "balance",
      amount: 0,
      time: localDatetimeValue(),
      account: "",
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
      account: payment.account ?? "",
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
      <DialogContent aria-describedby={undefined} className="max-h-[92vh] max-w-4xl overflow-y-auto p-0">
        <DialogHeader className="border-b px-4 py-4 sm:px-6">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{order?.orderNo ?? "订单财务"}</span>
            {order && (
              <Badge variant="outline" className={financeStatusClass(order.financeStatus)}>
                {order.financeStatus}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>
        {order && (
          <div className="flex flex-col gap-5 px-4 py-4 sm:px-6">
            <div className="finance-mobile-two-columns grid grid-cols-2 overflow-hidden rounded-lg border md:grid-cols-4">
              {[
                ["订单应收", money(order.receivable)],
                ["已收", money(order.received)],
                ["已退", money(order.refunded)],
                ["余额", money(order.balance)],
              ].map(([label, value]) => (
                <div key={label} className="border-b p-3 last:border-b-0 even:border-l md:border-b-0 md:border-l md:first:border-l-0">
                  <div className="text-xs text-muted-foreground">{label}</div>
                  <div className="mt-1 text-base font-semibold tabular-nums">{value}</div>
                </div>
              ))}
            </div>

            <section className="border-b pb-5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">负责人提成</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    按商品折后金额 × 比例计算，且不超过最低回厂价以上的可提成空间。
                  </p>
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
                        className="h-8 w-24 text-right"
                      />
                      %
                    </span>
                  </label>
                  <Button size="sm" onClick={saveCommission} disabled={savingCommission || !permission.canUpdate}>
                    {savingCommission ? <Loader2 className="size-4 animate-spin" /> : "保存"}
                  </Button>
                </div>
              </div>
              <div className="grid gap-2 text-sm sm:grid-cols-4">
                <div><span className="text-muted-foreground">负责人：</span>{order.contactPerson || "—"}</div>
                <div><span className="text-muted-foreground">计算基数：</span>{money(order.commissionBase)}</div>
                <div><span className="text-muted-foreground">提成上限：</span>{money(order.commissionCap)}</div>
                <div className="font-semibold text-emerald-700"><span className="font-normal text-muted-foreground">负责人提成：</span>{money(order.commissionAmount)}</div>
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold">资金流水</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    抖音结算由对账导入；私域和线下资金由财务专员补录。
                  </p>
                </div>
                {!paymentFormOpen && permission.canCreate && (
                  <Button size="sm" variant="outline" onClick={startAddPayment}>
                    <Plus className="size-4" /> 新增流水
                  </Button>
                )}
              </div>

              {paymentFormOpen && (
                <div className="mb-4 grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2">
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
                    <Label>资金账户</Label>
                    <Input
                      value={draft.account}
                      onChange={(event) => setDraft((current) => ({ ...current, account: event.target.value }))}
                      placeholder="微信、支付宝、银行账户"
                    />
                  </div>
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label>备注</Label>
                    <Textarea
                      value={draft.notes}
                      onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))}
                      rows={2}
                      placeholder="填写资金用途、付款人或差异原因"
                    />
                  </div>
                  <div className="grid gap-1.5 sm:col-span-2">
                    <Label>凭证</Label>
                    <ProofUploader
                      images={draft.proof}
                      onChange={(proof) => setDraft((current) => ({ ...current, proof }))}
                    />
                  </div>
                  <div className="flex justify-end gap-2 sm:col-span-2">
                    <Button variant="outline" size="sm" onClick={resetPaymentForm}>取消</Button>
                    <Button size="sm" onClick={savePayment} disabled={savingPayment}>
                      {savingPayment && <Loader2 className="size-4 animate-spin" />}
                      {editingPaymentId ? "保存修改" : "保存流水"}
                    </Button>
                  </div>
                </div>
              )}

              <div className="divide-y rounded-lg border">
                {order.payments.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    暂无手工资金流水
                  </div>
                ) : (
                  [...order.payments]
                    .sort((left, right) => String(right.time).localeCompare(String(left.time)))
                    .map((payment) => (
                      <div key={payment.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2 text-sm">
                            {payment.type === "refund"
                              ? <ArrowUpRight className="size-4 text-rose-600" />
                              : <ArrowDownLeft className="size-4 text-emerald-600" />}
                            <span className="font-medium">{PAYMENT_LABELS[payment.type]}</span>
                            <span className={payment.type === "refund" ? "font-semibold text-rose-700" : "font-semibold text-emerald-700"}>
                              {payment.type === "refund" ? "−" : "+"}{money(payment.amount)}
                            </span>
                            <span className="text-xs text-muted-foreground">{displayDatetime(payment.time)}</span>
                          </div>
                          {(payment.account || payment.notes) && (
                            <div className="mt-1 truncate text-xs text-muted-foreground">
                              {[payment.account ? `账户：${payment.account}` : "", payment.notes].filter(Boolean).join(" · ")}
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
                        <div className="flex shrink-0 items-center gap-1">
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
        )}
        <DialogFooter className="border-t px-4 py-3 sm:px-6">
          <Button variant="outline" onClick={() => onOpenChange(false)}>关闭</Button>
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
  const [ledgerMode, setLedgerMode] = useState<"orders" | "transactions">("orders");
  const [selectedOrderId, setSelectedOrderId] = useState("");
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
  const normalizedSearch = search.trim().toLowerCase();
  const filteredOrders = useMemo(() => (data?.orders ?? []).filter((order) => {
    if (financeFilter !== "all" && order.financeStatus !== financeFilter) return false;
    if (!normalizedSearch) return true;
    return [
      order.orderNo,
      order.douyinOrderNo,
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
      transaction.account,
      transaction.notes,
    ].some((value) => String(value ?? "").toLowerCase().includes(normalizedSearch));
  }), [data?.transactions, normalizedSearch]);
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
            逐单核对应收、收款、退款、平台扣费和负责人提成
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
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <label className="relative min-w-0 sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="订单号、客户或负责人"
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
                    <SelectItem value="已核销">已核销</SelectItem>
                    <SelectItem value="待退款">待退款</SelectItem>
                    <SelectItem value="有差异">有差异</SelectItem>
                  </SelectContent>
                </Select>
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
                  <table className="w-full min-w-[980px] text-sm [&_td]:px-2 [&_th]:px-2">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2.5 text-left font-medium">订单</th>
                        <th className="px-3 py-2.5 text-left font-medium">客户 / 来源</th>
                        <th className="px-3 py-2.5 text-left font-medium">负责人</th>
                        <th className="px-3 py-2.5 text-right font-medium">应收</th>
                        <th className="px-3 py-2.5 text-right font-medium">已收</th>
                        <th className="px-3 py-2.5 text-right font-medium">已退</th>
                        <th className="px-3 py-2.5 text-right font-medium">平台费用</th>
                        <th className="px-3 py-2.5 text-right font-medium">余额</th>
                        <th className="px-3 py-2.5 text-right font-medium">负责人提成</th>
                        <th className="px-3 py-2.5 text-left font-medium">物流</th>
                        <th className="px-3 py-2.5 text-left font-medium">财务</th>
                        <th className="px-3 py-2.5 text-right font-medium">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filteredOrders.map((order) => (
                        <tr key={order.id} className="hover:bg-muted/20">
                          <td className="px-3 py-2.5">
                            <div className="font-medium">{order.orderNo}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">{order.date}</div>
                          </td>
                          <td className="px-3 py-2.5">
                            <div>{order.customerName}</div>
                            <div className="mt-0.5 text-xs text-muted-foreground">{sourceLabel(order.source)}</div>
                          </td>
                          <td className="px-3 py-2.5">{order.contactPerson || "—"}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{money(order.receivable)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-emerald-700">{money(order.received)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums text-rose-700">{money(order.refunded)}</td>
                          <td className="px-3 py-2.5 text-right tabular-nums">{money(order.platformFees)}</td>
                          <td className={`px-3 py-2.5 text-right font-medium tabular-nums ${order.balance > 0.01 ? "text-amber-700" : order.balance < -0.01 ? "text-rose-700" : ""}`}>
                            {money(order.balance)}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <div className="font-medium tabular-nums">{money(order.commissionAmount)}</div>
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
                          <div className="mt-1 text-xs text-muted-foreground">
                            {sourceLabel(order.source)} · {order.contactPerson || "未指定负责人"} · {order.logisticsStatus}
                          </div>
                        </div>
                        <Badge variant="outline" className={financeStatusClass(order.financeStatus)}>
                          {order.financeStatus}
                        </Badge>
                      </div>
                      <div className="finance-mobile-two-columns mt-3 grid grid-cols-4 gap-2 text-xs sm:grid-cols-4">
                        <div><div className="text-muted-foreground">应收</div><div className="mt-0.5 font-medium">{money(order.receivable)}</div></div>
                        <div><div className="text-muted-foreground">已收</div><div className="mt-0.5 font-medium text-emerald-700">{money(order.received)}</div></div>
                        <div><div className="text-muted-foreground">余额</div><div className="mt-0.5 font-medium">{money(order.balance)}</div></div>
                        <div><div className="text-muted-foreground">提成</div><div className="mt-0.5 font-medium">{money(order.commissionAmount)}</div></div>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )
          ) : filteredTransactions.length === 0 ? (
            <EmptyState>暂无符合条件的手工资金流水</EmptyState>
          ) : (
            <>
              <div className="hidden overflow-x-auto rounded-lg border bg-card md:block">
                <table className="w-full min-w-[860px] text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2.5 text-left font-medium">时间</th>
                      <th className="px-3 py-2.5 text-left font-medium">订单</th>
                      <th className="px-3 py-2.5 text-left font-medium">客户 / 负责人</th>
                      <th className="px-3 py-2.5 text-left font-medium">类型</th>
                      <th className="px-3 py-2.5 text-right font-medium">金额</th>
                      <th className="px-3 py-2.5 text-left font-medium">账户</th>
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
                        <td className="px-3 py-2.5">{transaction.account || "—"}</td>
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
                      {transaction.customerName} · {transaction.contactPerson || "未指定负责人"}
                    </div>
                    {(transaction.account || transaction.notes || transaction.proof.length > 0) && (
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {[transaction.account, transaction.notes, transaction.proof.length > 0 ? `凭证 ${transaction.proof.length} 张` : ""].filter(Boolean).join(" · ")}
                      </div>
                    )}
                  </button>
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

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-md">
          <DialogHeader>
            <DialogTitle>负责人提成设置</DialogTitle>
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
