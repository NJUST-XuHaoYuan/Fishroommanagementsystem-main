const config = require("./config");

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

async function fetchCatalog() {
  const data = await request("/api/public/catalog", { siteId: getSiteId() });
  return data.catalog || data.data || data || {};
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
