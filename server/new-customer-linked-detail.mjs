import { resolveUniqueOrderMutationTarget } from "./order-shipment-mutation-targets.mjs";
import { buildReadonlyOrderDetail } from "./purchase-batch-details.mjs";

const text = (value) => String(value ?? "").trim();
const list = (value) => Array.isArray(value) ? value : [];
const fail = (statusCode, code, message) => { throw Object.assign(new Error(message), { statusCode, code }); };
const statusLabels = { pending: "未完成", confirmed: "已确认", shipped: "发货中", completed: "已完成", cancelled: "已取消", damaged: "已报损" };

/** Read-only approval navigation. No client-supplied customer/site IDs are authority. */
export function buildNewCustomerLinkedDetail(state, { orderId, targetOrderId, kind, visibleSiteIds }, feeBreakdownForOrder) {
  if (!["order", "customer"].includes(kind)) fail(400, "NEW_CUSTOMER_DETAIL_KIND_INVALID", "请选择查看订单或客户资料");
  const sites = list(state.sites);
  const visible = new Set(list(visibleSiteIds).map(text));
  const authorizedSite = (order) => {
    const siteId = text(order.siteId);
    const matches = sites.filter((site) => text(site.id) === siteId);
    if (!siteId || matches.length !== 1 || !visible.has(siteId)) fail(403, "SITE_FORBIDDEN", "不能查看未授权场地的订单");
    return matches[0];
  };
  const { order: contextOrder } = resolveUniqueOrderMutationTarget(state, orderId);
  authorizedSite(contextOrder);
  const customerId = text(contextOrder.customerId);
  const base = { ok: true, kind, approvalOrderId: text(contextOrder.id) };
  if (kind === "order") {
    const { order } = resolveUniqueOrderMutationTarget(state, text(targetOrderId) || text(contextOrder.id));
    const site = authorizedSite(order);
    if (text(order.id) !== text(contextOrder.id) && (!customerId || text(order.customerId) !== customerId)) {
      fail(404, "NEW_CUSTOMER_LINKED_ORDER_NOT_FOUND", "订单不属于该客户或无权查看");
    }
    // Restrict the presentation context too: unrelated malformed data must not
    // expose or prevent inspection of an otherwise authorized order.
    const productIds = new Set(list(order.items).map((item) => text(item.productId)));
    const products = list(state.products).filter((item) => productIds.has(text(item.id)));
    const speciesIds = new Set(products.map((item) => text(item.speciesId)));
    return { ...base, order: buildReadonlyOrderDetail({
      products, species: list(state.species).filter((item) => speciesIds.has(text(item.id))),
      shipments: list(state.shipments).filter((item) => text(item.orderId) === text(order.id)),
      customers: list(state.customers).filter((item) => text(item.id) === text(order.customerId)),
    }, order, feeBreakdownForOrder, { siteName: text(site.name), includeReviewContext: true }) };
  }
  if (!customerId) fail(404, "NEW_CUSTOMER_CUSTOMER_UNLINKED", "该订单未关联客户档案，请先核对订单中的客户识别信息");
  const customers = list(state.customers).filter((customer) => text(customer.id) === customerId);
  if (customers.length === 0) fail(404, "NEW_CUSTOMER_CUSTOMER_NOT_FOUND", "关联客户档案已不存在，请先核对客户资料");
  if (customers.length !== 1) fail(409, "NEW_CUSTOMER_CUSTOMER_NOT_UNIQUE", "客户编号不唯一，无法安全查看，请联系管理员核对");
  const customer = Object.fromEntries(["id", "name", "customerType", "addedDate", "phone", "wechat", "douyin", "source", "address", "notes"].map((key) => [key, text(customers[0][key])]));
  const orderCounts = new Map();
  for (const order of list(state.orders)) orderCounts.set(text(order.id), (orderCounts.get(text(order.id)) ?? 0) + 1);
  const orders = list(state.orders).filter((order) => text(order.customerId) === customerId && visible.has(text(order.siteId)))
    .map((order) => {
      const site = authorizedSite(order);
      if (!text(order.id) || orderCounts.get(text(order.id)) !== 1) fail(409, "ORDER_ID_NOT_UNIQUE", "关联订单编号不唯一，无法安全查看，请联系管理员核对");
      return { id: text(order.id), orderNo: text(order.orderNo), date: text(order.date), createdAt: text(order.createdAt),
        status: text(order.status), statusLabel: statusLabels[order.status] || text(order.status), siteId: text(site.id), siteName: text(site.name) };
    }).sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date) || a.id.localeCompare(b.id));
  return { ...base, customer, orders };
}
