const id = (value) => String(value ?? "").trim();
const failure = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });

// Order/shipment site is the financial owner; physical fulfillment follows the
// unique current tank. Resolve from locked state, never a request-supplied site.
export function resolveOrderFulfillmentStock(state = {}, stockId, { visibleSiteIds, expectedLocation } = {}) {
  const requestedId = id(stockId);
  const matches = (Array.isArray(state.stock) ? state.stock : []).filter((item) => id(item?.id) === requestedId);
  if (matches.length !== 1) {
    throw failure(matches.length > 1 ? 409 : 404, matches.length > 1 ? "STOCK_ID_NOT_UNIQUE" : "STOCK_NOT_FOUND",
      matches.length > 1 ? "库存鱼 ID 不唯一，不能安全出库或编辑订单" : "所选库存不存在，请刷新后重试");
  }
  const stock = matches[0];
  const subTankId = id(stock.subTankId);
  const tanks = (Array.isArray(state.tankGroups) ? state.tankGroups : []).flatMap((group) =>
    (Array.isArray(group?.subTanks) ? group.subTanks : [])
      .filter((tank) => subTankId && id(tank?.id) === subTankId).map(() => group));
  if (tanks.length !== 1) {
    throw failure(409, "STOCK_TANK_NOT_UNIQUE", "库存鱼当前缸位不存在或不唯一，请先核对缸位");
  }
  const siteId = id(tanks[0].siteId);
  const sites = (Array.isArray(state.sites) ? state.sites : []).filter((site) => siteId && id(site?.id) === siteId);
  if (sites.length !== 1) throw failure(409, "STOCK_SITE_NOT_UNIQUE", "库存鱼当前场地不存在或不唯一，请先核对缸位");
  if (visibleSiteIds && !visibleSiteIds.map(id).includes(siteId)) {
    throw failure(403, "STOCK_SITE_FORBIDDEN", "无权操作该订单鱼当前所在场地，请联系有相应场地权限的人员处理");
  }
  if (expectedLocation !== undefined && (!expectedLocation || typeof expectedLocation !== "object" ||
      id(expectedLocation.siteId) !== siteId || id(expectedLocation.subTankId) !== subTankId)) {
    throw failure(409, "SHIPMENT_STOCK_LOCATION_CONFLICT", "所选鱼的场地或缸位已发生变化，请刷新后重新确认出库位置");
  }
  return { stock, siteId, subTankId };
}

export function expectedOrderFulfillmentLocation(body = {}, stockId) {
  if (!Object.prototype.hasOwnProperty.call(body, "expectedStockLocations")) return undefined;
  const snapshots = body.expectedStockLocations;
  if (!snapshots || typeof snapshots !== "object" || Array.isArray(snapshots) ||
      !Object.prototype.hasOwnProperty.call(snapshots, id(stockId))) {
    throw failure(409, "SHIPMENT_STOCK_LOCATION_CONFLICT", "缺少所选鱼的出库位置，请刷新后重新确认");
  }
  return snapshots[id(stockId)] ?? null;
}
