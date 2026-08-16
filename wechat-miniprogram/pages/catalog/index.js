const { fetchCatalog } = require("../../utils/api");
const { buildViewModel } = require("../../utils/catalog");
const { getNavigationMetrics } = require("../../utils/navigation");

Page({
  data: {
    loading: true,
    refreshing: false,
    error: "",
    majorGroups: [],
    totalProducts: 0,
    totalSpecimens: 0,
    ...getNavigationMetrics()
  },

  onLoad() {
    this.loadCatalog();
  },

  onPullDownRefresh() {
    this.loadCatalog({ force: true, refreshing: true });
  },

  async loadCatalog(options = {}) {
    const app = getApp();
    const now = Date.now();
    const cachedViewModel = app.globalData.catalogViewModel;
    const cacheTtl = 60 * 1000;
    const useCache = !options.force
      && app.globalData.catalog
      && cachedViewModel
      && Array.isArray(cachedViewModel.majorGroups)
      && now - Number(app.globalData.loadedAt || 0) < cacheTtl;

    this.setData({
      loading: !options.refreshing,
      refreshing: Boolean(options.refreshing),
      error: ""
    });

    try {
      const catalog = useCache ? app.globalData.catalog : await fetchCatalog();
      const viewModel = useCache
        ? cachedViewModel
        : buildViewModel(catalog);

      app.globalData.catalog = catalog;
      app.globalData.catalogViewModel = viewModel;
      app.globalData.loadedAt = now;

      this.setData({
        loading: false,
        refreshing: false,
        majorGroups: viewModel.majorGroups,
        totalProducts: viewModel.totalProducts,
        totalSpecimens: viewModel.totalSpecimens
      });
    } catch (error) {
      this.setData({
        loading: false,
        refreshing: false,
        error: error && error.message || "公开目录加载失败"
      });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  onMinorCategoryTap(event) {
    const category = event.currentTarget.dataset.category;
    const majorKey = event.currentTarget.dataset.majorKey;
    if (!category) return;
    wx.navigateTo({
      url: `/pages/products/index?category=${encodeURIComponent(category)}&majorKey=${encodeURIComponent(majorKey || "")}`
    });
  },

  onRetry() {
    this.loadCatalog({ force: true });
  },

  onShareAppMessage() {
    return {
      title: "海水生物鱼单",
      path: "/pages/catalog/index"
    };
  }
});
