function normalizedId(value) {
  return String(value ?? "").trim();
}

export function productReferenceSummary(state = {}, productId = "") {
  const targetId = normalizedId(productId);
  if (!targetId) return { stockCount: 0, orderCount: 0 };

  const stockCount = (Array.isArray(state.stock) ? state.stock : [])
    .filter((item) => normalizedId(item?.productId) === targetId)
    .length;
  const orderCount = (Array.isArray(state.orders) ? state.orders : [])
    .filter((order) => (Array.isArray(order?.items) ? order.items : [])
      .some((item) => normalizedId(item?.productId) === targetId))
    .length;

  return { stockCount, orderCount };
}

export function productDeleteDisposition(state = {}, productId = "", productName = "该商品") {
  const references = productReferenceSummary(state, productId);
  if (references.stockCount === 0 && references.orderCount === 0) {
    return {
      mode: "deleted",
      references,
      message: `商品「${String(productName || "该商品").trim()}」已删除。`,
    };
  }

  const details = [];
  if (references.stockCount > 0) details.push(`${references.stockCount} 条库存记录`);
  if (references.orderCount > 0) details.push(`${references.orderCount} 个订单`);
  return {
    mode: "archived",
    references,
    message: `商品「${String(productName || "该商品").trim()}」已关联${details.join("和")}，已停用并从使用中列表移除，历史记录继续保留。`,
  };
}
