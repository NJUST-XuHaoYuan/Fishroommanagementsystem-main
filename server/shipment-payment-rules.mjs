import { verifiedPaymentTotals } from "./payment-utils.mjs";

const MONEY_EPSILON = 0.005;

function money(value) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

export function verifiedNetPaymentAmount(payments = []) {
  const totals = verifiedPaymentTotals(payments);
  return money(totals.received - totals.refunded);
}

export function shipmentPaymentGate(order = {}, amountDue = 0) {
  const due = Math.max(0, money(amountDue));
  const verifiedAmount = verifiedNetPaymentAmount(order?.payments);
  const outstandingAmount = Math.max(0, money(due - verifiedAmount));

  if (String(order?.source ?? "").trim() === "平台下单") {
    return {
      status: "platform_exempt",
      amountDue: due,
      verifiedAmount,
      outstandingAmount: 0,
      approvedAmount: 0,
      canShip: true,
    };
  }

  if (outstandingAmount <= MONEY_EPSILON) {
    return {
      status: "verified",
      amountDue: due,
      verifiedAmount,
      outstandingAmount: 0,
      approvedAmount: 0,
      canShip: true,
    };
  }

  if (String(order?.source ?? "").trim() === "线下") {
    return {
      status: "offline_credit",
      amountDue: due,
      verifiedAmount,
      outstandingAmount,
      approvedAmount: outstandingAmount,
      canShip: true,
    };
  }

  const approval = order?.creditSaleApproval;
  const approvedAmount = approval?.confirmedAt && approval?.confirmedBy
    ? Math.max(0, money(approval.amount))
    : 0;
  if (approvedAmount + MONEY_EPSILON >= outstandingAmount) {
    return {
      status: "credit_approved",
      amountDue: due,
      verifiedAmount,
      outstandingAmount,
      approvedAmount,
      canShip: true,
    };
  }

  return {
    status: "confirmation_required",
    amountDue: due,
    verifiedAmount,
    outstandingAmount,
    approvedAmount,
    canShip: false,
  };
}
