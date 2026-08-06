export function countsAsCompletionShipment(shipment = {}) {
  return shipment?.status !== "preparing";
}

export function shipmentIsResolvedForCompletion(shipment = {}) {
  return shipment?.status === "delivered" || shipment?.status === "damaged";
}
