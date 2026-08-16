const config = require("./utils/config");

App({
  globalData: {
    apiBaseUrl: config.apiBaseUrl,
    siteId: config.siteId,
    catalog: null,
    catalogViewModel: null,
    loadedAt: 0
  }
});
