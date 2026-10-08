const config = require("./utils/config");
const { createUpdateController } = require("./utils/update");

App({
  onLaunch() {
    if (!this._updateController) this._updateController = createUpdateController(wx);
  },
  onShow() {
    if (this._updateController) this._updateController.onShow();
  },
  onHide() {
    if (this._updateController) this._updateController.onHide();
  },
  globalData: {
    apiBaseUrl: config.apiBaseUrl,
    siteId: config.siteId,
    catalog: null,
    catalogViewModel: null,
    loadedAt: 0
  }
});
