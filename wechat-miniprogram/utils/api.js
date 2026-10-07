const config = require("./config");
const PUBLIC_SITE_NAMES = { nanjing: "南京", jiangyin: "江阴" };
const SITE_LOAD_ERROR = "所在地加载失败，请重试";

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function getApiBaseUrl() {
  const app = typeof getApp === "function" ? getApp() : null;
  return trimSlash(app && app.globalData && app.globalData.apiBaseUrl || config.apiBaseUrl);
}

function getSiteId() {
  const app = typeof getApp === "function" ? getApp() : null;
  return app && app.globalData && app.globalData.siteId || config.siteId || "all";
}

function buildUrl(path, params) {
  const baseUrl = getApiBaseUrl();
  const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;
  const query = Object.assign({}, params || {});
  const keys = Object.keys(query).filter((key) => query[key] !== undefined && query[key] !== null && query[key] !== "");
  const search = keys
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(query[key]))}`)
    .join("&");
  return `${baseUrl}${normalizedPath}${search ? `?${search}` : ""}`;
}

function request(path, params) {
  const url = buildUrl(path, params);
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method: "GET",
      timeout: 12000,
      header: {
        Accept: "application/json"
      },
      success(response) {
        const status = Number(response.statusCode || 0);
        const data = response.data || {};
        if (status >= 200 && status < 300) {
          resolve(data);
          return;
        }
        reject(new Error(data.error || data.message || `请求失败 ${status}`));
      },
      fail(error) {
        reject(new Error(error && error.errMsg || "网络请求失败"));
      }
    });
  });
}

function catalogFromResponse(data) {
  return data.catalog || data.data || data || {};
}

function checkedCatalogStock(catalog, siteId) {
  if (!Array.isArray(catalog && catalog.stock)) throw new Error(SITE_LOAD_ERROR);
  const seen = new Set();
  catalog.stock.forEach((item) => {
    const id = String(item && item.id || "").trim();
    const declaredSiteId = String(item && item.siteId || "").trim();
    if (!id || seen.has(id) || (siteId !== "all" && declaredSiteId && declaredSiteId !== siteId)) {
      throw new Error(SITE_LOAD_ERROR);
    }
    seen.add(id);
  });
  return catalog.stock;
}

async function fetchCatalog() {
  // Visibility rules are evaluated by the server. Fail closed when the request
  // fails so a stale response can never reveal a product that was just hidden.
  const siteId = String(getSiteId()).trim() || "all";
  const data = await request("/api/public/catalog", { siteId });
  const catalog = catalogFromResponse(data);
  const stock = checkedCatalogStock(catalog, siteId);
  if (stock.every((item) => String(item.siteId || "").trim())) return catalog;

  if (Object.prototype.hasOwnProperty.call(PUBLIC_SITE_NAMES, siteId)) {
    return {
      ...catalog,
      stock: stock.map((item) => String(item.siteId || "").trim() ? item : {
        ...item, siteId, siteName: PUBLIC_SITE_NAMES[siteId]
      })
    };
  }
  if (siteId !== "all") throw new Error(SITE_LOAD_ERROR);

  try {
    // Older APIs already provide city-scoped public catalogs. Join only their
    // IDs onto this response; never add stock or retain a mapping across loads.
    const scopes = Object.keys(PUBLIC_SITE_NAMES);
    const scopedCatalogs = await Promise.all(scopes.map(async (scope) => {
      const response = await request("/api/public/catalog", { siteId: scope });
      return checkedCatalogStock(catalogFromResponse(response), scope);
    }));
    const siteByStockId = new Map();
    scopedCatalogs.forEach((items, index) => items.forEach((item) => {
      const id = String(item.id).trim();
      if (siteByStockId.has(id)) throw new Error(SITE_LOAD_ERROR);
      siteByStockId.set(id, scopes[index]);
    }));
    return {
      ...catalog,
      stock: stock.map((item) => {
        const declaredSiteId = String(item.siteId || "").trim();
        const resolvedSiteId = siteByStockId.get(String(item.id).trim());
        if (declaredSiteId) {
          if ((resolvedSiteId && resolvedSiteId !== declaredSiteId) ||
            (!resolvedSiteId && Object.prototype.hasOwnProperty.call(PUBLIC_SITE_NAMES, declaredSiteId))) {
            throw new Error(SITE_LOAD_ERROR);
          }
          return item;
        }
        if (!resolvedSiteId) throw new Error(SITE_LOAD_ERROR);
        return { ...item, siteId: resolvedSiteId, siteName: PUBLIC_SITE_NAMES[resolvedSiteId] };
      })
    };
  } catch (error) {
    throw new Error(SITE_LOAD_ERROR);
  }
}

async function fetchBioRecords(stockItemId) {
  const data = await request("/api/public/bio-records", {
    siteId: getSiteId(),
    stockItemId
  });
  return Array.isArray(data.bioRecords) ? data.bioRecords : [];
}

module.exports = {
  buildUrl,
  fetchCatalog,
  fetchBioRecords,
  getApiBaseUrl,
  getSiteId
};
