/** Restrict a workbench's payment choices to the orders already in its scope. */
export function paymentClaimsForOrderScope<
  Candidate extends { candidates: Array<{ orderId: string }> },
  CashOrder extends { orderId: string },
>(
  data: { candidates: Candidate[]; cashOrders: CashOrder[] },
  orderIds: ReadonlySet<string> | null,
): { candidates: Candidate[]; cashOrders: CashOrder[] } {
  if (orderIds === null) return data;
  return {
    candidates: data.candidates.flatMap(candidate => {
      const candidates = candidate.candidates.filter(order => orderIds.has(order.orderId));
      return candidates.length ? [{ ...candidate, candidates }] : [];
    }),
    cashOrders: data.cashOrders.filter(order => orderIds.has(order.orderId)),
  };
}
