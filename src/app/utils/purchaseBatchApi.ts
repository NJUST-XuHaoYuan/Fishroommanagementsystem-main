import type { OperationLog, PurchaseBatch, Store } from "../store";
import { isNewCustomerSessionCurrent, type NewCustomerSession } from "./newCustomerEvidence";

export function applyBatchApiResult(
  setState: (value: Store | ((current: Store) => Store)) => void,
  result: { batch: PurchaseBatch; operationLog?: OperationLog },
  options: { session: NewCustomerSession; shouldApply?: (current: Store) => boolean },
) {
  setState(current => {
    if (!isNewCustomerSessionCurrent(options.session, current.user) || (options.shouldApply && !options.shouldApply(current))) return current;
    const previous = current.batches.find(batch => batch.id === result.batch.id);
    if ((previous?.costingRevision ?? 0) > (result.batch.costingRevision ?? 0)) return current;
    return { ...current,
      batches: previous ? current.batches.map(batch => batch.id === result.batch.id ? result.batch : batch) : [result.batch, ...current.batches],
      operationLogs: result.operationLog && !current.operationLogs.some(log => log.id === result.operationLog!.id)
        ? [result.operationLog, ...current.operationLogs].slice(0, 1000) : current.operationLogs,
    };
  });
}
