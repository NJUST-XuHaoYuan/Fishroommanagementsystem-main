import { Tag } from "lucide-react";
import type { Order } from "../store";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type AcquisitionOrderFields = Pick<Order,
  "id" | "isAcquisitionOrder" | "acquisitionOrderUpdatedAt" | "acquisitionOrderUpdatedBy" | "acquisitionOrderUpdatedByName"
>;

/** Apply only this operation's fields; never reinsert an order removed from the current view. */
export function mergeAcquisitionOrderTags<T extends AcquisitionOrderFields>(orders: T[], incoming: AcquisitionOrderFields): T[] {
  return orders.map((order) => {
    if (order.id !== incoming.id) return order;
    const currentVersion = Date.parse(order.acquisitionOrderUpdatedAt ?? "") || 0;
    const incomingVersion = Date.parse(incoming.acquisitionOrderUpdatedAt ?? "") || 0;
    if (currentVersion > incomingVersion) return order;
    return {
      ...order,
      isAcquisitionOrder: incoming.isAcquisitionOrder,
      acquisitionOrderUpdatedAt: incoming.acquisitionOrderUpdatedAt,
      acquisitionOrderUpdatedBy: incoming.acquisitionOrderUpdatedBy,
      acquisitionOrderUpdatedByName: incoming.acquisitionOrderUpdatedByName,
    };
  });
}

export function OrderAcquisitionBadge({ marked }: { marked?: boolean }) {
  if (marked !== true) return null;
  return (
    <Badge variant="outline" className="border-teal-200 bg-teal-50 text-teal-800">
      <Tag aria-hidden="true" />获新订单
    </Badge>
  );
}

export function OrderAcquisitionTag({
  order,
  isAdmin,
  saving,
  error,
  updatedAtLabel,
  onToggle,
}: {
  order: Pick<Order, "id" | "isAcquisitionOrder" | "acquisitionOrderUpdatedBy" | "acquisitionOrderUpdatedByName">;
  isAdmin: boolean;
  saving: boolean;
  error: string;
  updatedAtLabel: string;
  onToggle: () => void;
}) {
  if (!isAdmin && order.isAcquisitionOrder !== true) return null;
  const marked = order.isAcquisitionOrder === true;
  const helperId = `order-acquisition-help-${order.id}`;
  const operator = order.acquisitionOrderUpdatedByName || order.acquisitionOrderUpdatedBy;

  return (
    <section aria-label="获新订单标记" className="border-b pb-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">订单标记</span>
            {marked ? <OrderAcquisitionBadge marked /> : <span className="text-muted-foreground">未标记</span>}
          </div>
          <p id={helperId} className="mt-1 text-xs leading-relaxed text-muted-foreground">
            由管理员手动标记，立即保存；不影响金额、状态或提成。
          </p>
          {operator && updatedAtLabel && (
            <p className="mt-1 break-words text-xs text-muted-foreground">
              最近调整：{operator} · {updatedAtLabel}
            </p>
          )}
        </div>
        {isAdmin && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10 w-full sm:w-auto"
            aria-describedby={helperId}
            aria-busy={saving}
            disabled={saving}
            onClick={onToggle}
          >
            <Tag className="size-3.5" aria-hidden="true" />
            {saving ? "保存中…" : marked ? "取消获新标记" : "标记为获新订单"}
          </Button>
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    </section>
  );
}
