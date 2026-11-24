import { configuredPaymentMethods, resolvePaymentMethodSnapshot } from "./payment-utils.mjs";
import { isPlatformPaymentChannel, platformPaymentChannelForOrderSource } from "./order-source-rules.mjs";

export const usesOrderCashier = order => order?.orderFormSchemaVersion === 4;

export function cashierMethodAllowedForOrder(method, order) {
  const platform = platformPaymentChannelForOrderSource(order?.source);
  return platform ? method?.channel === platform : Boolean(method?.channel) && !isPlatformPaymentChannel(method.channel);
}

export function orderCashierPaymentMethods(settings, order) {
  return configuredPaymentMethods(settings).filter(method => usesOrderCashier(order)
    ? cashierMethodAllowedForOrder(method, order) : method.channel === order.paymentChannel);
}

export function resolveOrderCashierMethod(settings, order, incoming, current = {}) {
  if (!String(incoming?.paymentMethodId ?? "").trim()) throw new Error("请选择本次收退款的付款方式");
  const method = resolvePaymentMethodSnapshot(settings, incoming, current);
  if (!cashierMethodAllowedForOrder(method, order)) throw new Error("本次付款方式与订单来源不一致，请重新选择");
  return method;
}
