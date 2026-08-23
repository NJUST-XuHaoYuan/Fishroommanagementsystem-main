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

module.exports = {
  getNavigationMetrics
};
