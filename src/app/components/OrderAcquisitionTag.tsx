import { Clock3, History, ShieldCheck, XCircle } from "lucide-react";
import type { Order } from "../store";
import type {
  NewCustomerApprovalDetail,
  NewCustomerApprovalRecord,
  NewCustomerApprovalStatus,
} from "../utils/notificationCenter";
import {
  NewCustomerApprovalPanel,
  type NewCustomerApprovalPanelProps,
  type NewCustomerApprovalUpdatedOrder,
} from "./NewCustomerApprovalPanel";
import { Badge } from "./ui/badge";

export type OrderNewCustomerApprovalFields = {
  id: string;
  newCustomerApproval?: NewCustomerApprovalRecord | null;
};

type LegacyAcquisitionOrderFields = {
  id: string;
  isAcquisitionOrder?: boolean;
  acquisitionOrderUpdatedAt?: string;
  acquisitionOrderUpdatedBy?: string;
  acquisitionOrderUpdatedByName?: string;
};

type AcquisitionOrderFields = OrderNewCustomerApprovalFields & LegacyAcquisitionOrderFields;

/** Merge only approval metadata; a response cannot overwrite current order edits or reinsert a missing order. */
export function mergeNewCustomerApproval<T extends OrderNewCustomerApprovalFields>(
  orders: T[],
  incoming: OrderNewCustomerApprovalFields
): T[] {
  return orders.map((order) => {
    if (order.id !== incoming.id || !Object.prototype.hasOwnProperty.call(incoming, "newCustomerApproval")) return order;
    const currentVersion = Number(order.newCustomerApproval?.version ?? -1);
    const incomingVersion = Number(incoming.newCustomerApproval?.version ?? -1);
    if (Number.isFinite(currentVersion) && Number.isFinite(incomingVersion) && currentVersion > incomingVersion) return order;
    return { ...order, newCustomerApproval: incoming.newCustomerApproval };
  });
}

/** Backward-compatible alias that also preserves the old, non-paying history marker. */
export function mergeAcquisitionOrderTags<T extends AcquisitionOrderFields>(
  orders: T[],
  incoming: AcquisitionOrderFields
): T[] {
  return orders.map((order) => {
    if (order.id !== incoming.id) return order;
    let next = order;
    if (Object.prototype.hasOwnProperty.call(incoming, "newCustomerApproval")) {
      [next] = mergeNewCustomerApproval([next], incoming);
    }
    if (Object.prototype.hasOwnProperty.call(incoming, "isAcquisitionOrder")) {
      const currentVersion = Date.parse(order.acquisitionOrderUpdatedAt ?? "") || 0;
      const incomingVersion = Date.parse(incoming.acquisitionOrderUpdatedAt ?? "") || 0;
      if (currentVersion <= incomingVersion) {
        next = {
          ...next,
          isAcquisitionOrder: incoming.isAcquisitionOrder,
          acquisitionOrderUpdatedAt: incoming.acquisitionOrderUpdatedAt,
          acquisitionOrderUpdatedBy: incoming.acquisitionOrderUpdatedBy,
          acquisitionOrderUpdatedByName: incoming.acquisitionOrderUpdatedByName,
        };
      }
    }
    return next;
  });
}

export function OrderAcquisitionBadge({
  marked,
  approvalStatus,
}: {
  marked?: boolean;
  approvalStatus?: NewCustomerApprovalStatus;
}) {
  if (approvalStatus === "approved") {
    return (
      <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-800">
        <ShieldCheck aria-hidden="true" />新客首单已批准
      </Badge>
    );
  }
  if (approvalStatus === "pending") {
    return (
      <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-800">
        <Clock3 aria-hidden="true" />新客首单待审批
      </Badge>
    );
  }
  if (approvalStatus === "rejected") {
    return (
      <Badge variant="outline" className="border-red-200 bg-red-50 text-red-800">
        <XCircle aria-hidden="true" />新客申请已驳回
      </Badge>
    );
  }
  if (marked !== true) return null;
  return (
    <Badge
      variant="outline"
      className="border-slate-200 bg-slate-50 text-slate-700"
      title="历史获新标记，不作为新规则提成依据"
    >
      <History aria-hidden="true" />历史获新标记
    </Badge>
  );
}

export type OrderAcquisitionTagProps = {
  order: Pick<Order, "id" | "isAcquisitionOrder"> & {
    newCustomerApproval?: NewCustomerApprovalRecord | null;
  };
  initialDetail?: NewCustomerApprovalDetail | null;
  onOrderUpdated?: (order: NewCustomerApprovalUpdatedOrder) => void;
  onApprovalChanged?: NewCustomerApprovalPanelProps["onChanged"];
  /** @deprecated Accepted temporarily so the parent can remove the old toggle wiring independently. */
  isAdmin?: boolean;
  /** @deprecated The new component owns mutation state. */
  saving?: boolean;
  /** @deprecated The new component owns server errors. */
  error?: string;
  /** @deprecated Historical tag timestamps are no longer an approval input. */
  updatedAtLabel?: string;
  /** @deprecated The legacy acquisition-tag endpoint is retired. */
  onToggle?: () => void;
};

export function OrderAcquisitionTag({
  order,
  initialDetail,
  onOrderUpdated,
  onApprovalChanged,
}: OrderAcquisitionTagProps) {
  return (
    <section aria-label="新客首单提成申请" className="border-b pb-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">新客首单提成</h3>
          <p className="mt-1 text-xs text-muted-foreground">负责人发起申请，管理员核验后生效。</p>
        </div>
        <OrderAcquisitionBadge
          marked={order.isAcquisitionOrder}
          approvalStatus={order.newCustomerApproval?.status}
        />
      </div>
      {order.isAcquisitionOrder === true && (
        <div className="mb-3 rounded-md border bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">
          此订单保留“历史获新”标记，仅用于追溯；它不等于新客首单已批准，也不会触发 5% 提成。
        </div>
      )}
      <NewCustomerApprovalPanel
        orderId={order.id}
        initialDetail={initialDetail}
        onOrderUpdated={onOrderUpdated}
        onChanged={onApprovalChanged}
      />
    </section>
  );
}
