const { fetchCatalog } = require("../../utils/api");
const { buildViewModel } = require("../../utils/catalog");
const { getNavigationMetrics } = require("../../utils/navigation");
const { SITE_OPTIONS, getSiteSelection, setSiteSelection } = require("../../utils/site-filter");
const {
  beginPublicCatalogRequest,
  isCurrentPublicCatalogRequest,
  startPublicCatalogRefresh,
  stopPublicCatalogRefresh
} = require("../../utils/public-catalog-refresh");

Page({
  data: {
    loading: true,
    refreshing: false,
    error: "",
    majorGroups: [],
    totalProducts: 0,
    totalSpecimens: 0,
    selectedSiteId: "all",
    selectedSiteName: "全部",
    siteOptions: SITE_OPTIONS,
    ...getNavigationMetrics()
  },

  onLoad(options = {}) {
    const site = getSiteSelection(options.siteId);
    this.setData({ selectedSiteId: site.id, selectedSiteName: site.label });
    this.loadCatalog();
  },

  onShow() {
    const site = getSiteSelection();
    if (site.id !== this.data.selectedSiteId) {
      this.setData({ selectedSiteId: site.id, selectedSiteName: site.label });
      this.applySiteFilter();
    }
    startPublicCatalogRefresh(this, () => this.loadCatalog({ force: true, refreshing: true }));
  },

  onHide() {
    stopPublicCatalogRefresh(this);
  },

  onUnload() {
    stopPublicCatalogRefresh(this);
  },

  onPullDownRefresh() {
    this.loadCatalog({ force: true, refreshing: true });
  },

  async loadCatalog(options = {}) {
    const app = getApp();
    const requestGeneration = beginPublicCatalogRequest(this);
    const now = Date.now();
    const cachedViewModel = app.globalData.catalogViewModel;
    const cacheTtl = 60 * 1000;
    const useCache = !options.force
      && app.globalData.catalog
      && cachedViewModel
      && Array.isArray(cachedViewModel.majorGroups)
      && now - Number(app.globalData.loadedAt || 0) < cacheTtl;

    this.setData({
      loading: !this.catalog || !options.refreshing,
      refreshing: Boolean(options.refreshing),
      error: ""
    });

    try {
      const catalog = useCache ? app.globalData.catalog : await fetchCatalog();
      const viewModel = useCache
        ? cachedViewModel
        : buildViewModel(catalog);
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;

      app.globalData.catalog = catalog;
      app.globalData.catalogViewModel = viewModel;
      if (!useCache) app.globalData.loadedAt = Date.now();
      this.catalog = catalog;
      this.fullViewModel = viewModel;
      this.applySiteFilter();
      this.setData({ loading: false, refreshing: false });
    } catch (error) {
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      app.globalData.catalog = null;
      app.globalData.catalogViewModel = null;
      app.globalData.loadedAt = 0;
      this.catalog = null;
      this.fullViewModel = null;
      this.setData({
        loading: false,
        refreshing: false,
        error: error && error.message || "公开目录加载失败",
        majorGroups: [],
        totalProducts: 0,
        totalSpecimens: 0
      });
    } finally {
      if (isCurrentPublicCatalogRequest(this, requestGeneration)) wx.stopPullDownRefresh();
    }
  },

  applySiteFilter() {
    if (!this.catalog || !this.fullViewModel) return;
    const viewModel = this.data.selectedSiteId === "all"
      ? this.fullViewModel
      : buildViewModel(this.catalog, this.data.selectedSiteId);
    this.setData({
      majorGroups: viewModel.majorGroups,
      totalProducts: viewModel.totalProducts,
      totalSpecimens: viewModel.totalSpecimens
    });
  },

  onSiteTap(event) {
    const site = setSiteSelection(event.currentTarget.dataset.siteId);
    if (!site || site.id === this.data.selectedSiteId) return;
    this.setData({ selectedSiteId: site.id, selectedSiteName: site.label });
    if (this.catalog) this.applySiteFilter();
    else if (!this.data.loading) this.loadCatalog({ force: true });
  },

  onClearSite() {
    this.onSiteTap({ currentTarget: { dataset: { siteId: "all" } } });
  },

  onMinorCategoryTap(event) {
    const category = event.currentTarget.dataset.category;
    const majorKey = event.currentTarget.dataset.majorKey;
    if (!category) return;
    wx.navigateTo({
      url: `/pages/products/index?category=${encodeURIComponent(category)}&majorKey=${encodeURIComponent(majorKey || "")}&siteId=${encodeURIComponent(this.data.selectedSiteId)}`
    });
  },

  onRetry() {
    this.loadCatalog({ force: true });
  },

  onAccountTap() {
    wx.navigateTo({ url: "/pages/account/index" });
  },

  onShareAppMessage() {
    return {
      title: `海洋森林 · 生物选购${this.data.selectedSiteId === "all" ? "" : " · " + this.data.selectedSiteName}`,
      path: `/pages/catalog/index?siteId=${encodeURIComponent(this.data.selectedSiteId)}`
    };
  }
});
