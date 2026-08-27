export const MAX_ACTUAL_SHIPPING_FEE = 100000;

export function roundShippingFee(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function normalizedPositiveShippingFee(value: unknown): number | null {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_ACTUAL_SHIPPING_FEE) return null;
  const cents = amount * 100;
  const roundedCents = Math.round(cents);
  if (Math.abs(cents - roundedCents) > 1e-7) return null;
  return roundedCents / 100;
}

export function canUseActualShippingFeeApi(
  shipment: { shipMethod?: string },
  shippingFeeMode: string
): boolean {
  return String(shipment.shipMethod ?? "express") === "express" && ["prepaid", "free"].includes(shippingFeeMode);
}

export function canApplyActualShippingFeeResponse(
  shipments: Array<{ id: string }>,
  shipmentId: string,
  requestSequence: number,
  currentRequestSequence: number
): boolean {
  return requestSequence === currentRequestSequence
    && shipments.some((shipment) => shipment.id === shipmentId);
}

export function actualShippingFeePayload(
  shipment: { id: string; actualShippingFee?: number },
  value: unknown
): { shipmentId: string; actualShippingFee: number; expectedActualShippingFee: number } | null {
  const actualShippingFee = normalizedPositiveShippingFee(value);
  if (!shipment.id || actualShippingFee === null) return null;
  return {
    shipmentId: shipment.id,
    actualShippingFee,
    expectedActualShippingFee: roundShippingFee(shipment.actualShippingFee ?? 0) ?? 0,
  };
}
