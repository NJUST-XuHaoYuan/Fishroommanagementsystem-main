const SITE_OPTIONS = [
  { id: "all", label: "全部" },
  { id: "nanjing", label: "南京" },
  { id: "jiangyin", label: "江阴" }
];
const STORAGE_KEY = "marineForest.catalogSiteId";

function findSite(id) {
  return SITE_OPTIONS.find((site) => site.id === id) || null;
}

function appData() {
  try {
    return typeof getApp === "function" ? getApp().globalData : null;
  } catch (error) {
    return null;
  }
}

function setSiteSelection(id) {
  const site = findSite(id);
  if (!site) return null;
  const data = appData();
  if (data) data.catalogSiteFilterId = site.id;
  try {
    if (typeof wx !== "undefined" && typeof wx.setStorageSync === "function") {
      wx.setStorageSync(STORAGE_KEY, site.id);
    }
  } catch (error) {
    // Storage can be unavailable; the current app still retains the selection.
  }
  return site;
}

function getSiteSelection(explicitSiteId) {
  if (findSite(explicitSiteId)) return setSiteSelection(explicitSiteId);
  const data = appData();
  const current = findSite(data && data.catalogSiteFilterId);
  if (current) return current;
  try {
    if (typeof wx !== "undefined" && typeof wx.getStorageSync === "function") {
      const stored = findSite(wx.getStorageSync(STORAGE_KEY));
      if (stored) {
        if (data) data.catalogSiteFilterId = stored.id;
        return stored;
      }
    }
  } catch (error) {
    // A storage read failure must not prevent browsing the public catalogue.
  }
  return SITE_OPTIONS[0];
}

module.exports = { SITE_OPTIONS, getSiteSelection, setSiteSelection };
