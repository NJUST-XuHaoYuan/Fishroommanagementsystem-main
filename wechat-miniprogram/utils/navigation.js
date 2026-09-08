function safeNumber(value, fallback) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function getNavigationMetrics() {
  let windowInfo = {};
  let menuButton = {};
  try {
    windowInfo = wx.getWindowInfo();
  } catch (error) {
    windowInfo = {};
  }
  try {
    menuButton = wx.getMenuButtonBoundingClientRect();
  } catch (error) {
    menuButton = {};
  }

  const statusBarHeight = safeNumber(windowInfo.statusBarHeight, 20);
  const windowWidth = safeNumber(windowInfo.windowWidth, 375);
  const menuTop = safeNumber(menuButton.top, statusBarHeight + 6);
  const menuHeight = safeNumber(menuButton.height, 32);
  const measuredHeight = Math.max(44, (menuTop - statusBarHeight) * 2 + menuHeight);
  const navBarHeight = Math.max(52, measuredHeight);
  const menuLeft = safeNumber(menuButton.left, windowWidth - 96);
  const menuRightPadding = Math.max(96, windowWidth - menuLeft + 10);

  return {
    statusBarHeight,
    navBarHeight,
    navigationHeight: statusBarHeight + navBarHeight,
    menuRightPadding
  };
}

function returnToParent(route, params = {}) {
  const query = Object.keys(params).map((key) => `${key}=${encodeURIComponent(params[key])}`).join("&");
  const url = `/${route}${query ? `?${query}` : ""}`;
  const fallback = () => wx.redirectTo({ url, fail: () => wx.reLaunch({ url: "/pages/catalog/index" }) });
  const pages = getCurrentPages();
  for (let index = pages.length - 2; index >= 0; index -= 1) {
    const page = pages[index];
    const matches = Object.keys(params).every((key) => {
      const value = String(page.options && page.options[key] || "");
      try { return decodeURIComponent(value) === String(params[key]); } catch (_) { return value === String(params[key]); }
    });
    if (page.route === route && matches) {
      wx.navigateBack({ delta: pages.length - 1 - index, fail: fallback });
      return;
    }
  }
  fallback();
}

module.exports = { getNavigationMetrics, returnToParent };
