export type BatchSale = {
  orderId: string;
  orderNo: string;
  siteId?: string;
  date?: string;
  price: number | null;
  status: string;
  kind?: "sale" | "replacement" | "originalReplaced";
  note?: string;
};

// Missing historical facts must stay missing, including the difference between 0 and null.
export function batchPrice(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "价格未记录";
}

export function batchRecordDate(value?: string | null) {
  if (!value) return "未记录";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const normalized = value.replace(" ", "T");
  const zoned = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized) ? `${normalized}+08:00` : normalized;
  const date = new Date(zoned);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

export function batchSaleLabel(sale: Pick<BatchSale, "kind" | "status">) {
  if (sale.kind === "replacement") return "补发关联";
  if (sale.kind === "originalReplaced") return "原鱼订单（已补发）";
  return ({ cancelled: "已取消订单", pending: "待确认订单", confirmed: "已确认订单", shipped: "已发货订单", completed: "已完成订单", damaged: "售后订单" } as Record<string, string>)[sale.status] || "关联订单";
}
