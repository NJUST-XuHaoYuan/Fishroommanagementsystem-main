function createUpdateController(wxApi) {
  let visible = false;
  let ready = false;
  let failed = false;
  let promptedThisVisit = false;
  let promptOpen = false;
  let applying = false;
  let manager;

  function promptIfNeeded() {
    if (!manager || !visible || promptOpen || promptedThisVisit || applying || (!ready && !failed)) return;

    const offersUpdate = ready;
    promptOpen = true;
    promptedThisVisit = true;
    wxApi.showModal({
      title: offersUpdate ? "发现新版本" : "更新暂未完成",
      content: offersUpdate
        ? "新版本已准备好，重启小程序即可使用。是否现在更新？"
        : "当前版本仍可继续使用。请在网络稳定后重新打开小程序，等待微信下载新版本。",
      showCancel: offersUpdate,
      confirmText: offersUpdate ? "立即更新" : "知道了",
      cancelText: "稍后",
      confirmColor: "#07544e",
      success(result) {
        if (offersUpdate && result.confirm && ready && !applying) {
          applying = true;
          manager.applyUpdate();
        }
      },
      fail() {
        promptedThisVisit = false;
      },
      complete() {
        promptOpen = false;
      }
    });
  }

  const controller = {
    onShow() {
      visible = true;
      if (!promptOpen) promptedThisVisit = false;
      promptIfNeeded();
    },
    onHide() {
      visible = false;
    }
  };

  if (!wxApi || typeof wxApi.getUpdateManager !== "function" || typeof wxApi.showModal !== "function") return controller;

  manager = wxApi.getUpdateManager();
  manager.onUpdateReady(() => {
    ready = true;
    failed = false;
    promptIfNeeded();
  });
  manager.onUpdateFailed(() => {
    if (ready) return;
    failed = true;
    promptIfNeeded();
  });

  return controller;
}

module.exports = { createUpdateController };
