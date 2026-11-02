const { fetchCatalog } = require("../../utils/api");
const {
  buildViewModel,
  filterProducts
} = require("../../utils/catalog");
const { getNavigationMetrics, returnToParent } = require("../../utils/navigation");
const { SITE_OPTIONS, getSiteSelection, setSiteSelection } = require("../../utils/site-filter");
const {
  beginPublicCatalogRequest,
  isCurrentPublicCatalogRequest,
  startPublicCatalogRefresh,
  stopPublicCatalogRefresh
} = require("../../utils/public-catalog-refresh");
const { handleCardImageError } = require("../../utils/card-video-preview");

function decodeOption(value) {
  try {
    return decodeURIComponent(value || "");
  } catch (error) {
    return String(value || "");
  }
}

Page({
  data: {
    loading: true,
    refreshing: false,
    error: "",
    categoryKey: "",
    majorKey: "",
    categoryInfo: null,
    majorLabel: "",
    siteOptions: SITE_OPTIONS,
    selectedSiteId: "all",
    selectedSiteName: "全部",
    keyword: "",
    products: [],
    filteredSpecimenCount: 0,
    ...getNavigationMetrics()
  },

  onLoad(options = {}) {
    const site = getSiteSelection(decodeOption(options.siteId));
    this.setData({
      categoryKey: decodeOption(options.category),
      majorKey: decodeOption(options.majorKey),
      selectedSiteId: site.id,
      selectedSiteName: site.label
    });
    this.loadProducts();
  },

  onShow() {
    const site = getSiteSelection();
    if (site.id !== this.data.selectedSiteId) {
      this.setData({ selectedSiteId: site.id, selectedSiteName: site.label });
      this.applySiteFilter();
    }
    startPublicCatalogRefresh(this, () => this.loadProducts({ force: true, refreshing: true }));
  },

  onHide() {
    stopPublicCatalogRefresh(this);
  },

  onUnload() {
    stopPublicCatalogRefresh(this);
  },

  onPullDownRefresh() {
    this.loadProducts({ force: true, refreshing: true });
  },

  async loadProducts(options = {}) {
    const categoryKey = this.data.categoryKey;
    if (!categoryKey) {
      this.setData({ loading: false, refreshing: false, error: "缺少小类信息" });
      wx.stopPullDownRefresh();
      return;
    }

    const app = getApp();
    const requestGeneration = beginPublicCatalogRequest(this);
    const now = Date.now();
    const cachedViewModel = app.globalData.catalogViewModel;
    const cacheTtl = 60 * 1000;
    const useCache = !options.force
      && app.globalData.catalog
      && cachedViewModel
      && Array.isArray(cachedViewModel.productCards)
      && now - Number(app.globalData.loadedAt || 0) < cacheTtl;

    this.setData({
      loading: !this.catalog || !options.refreshing,
      refreshing: Boolean(options.refreshing),
      error: ""
    });

    try {
      const catalog = useCache ? app.globalData.catalog : await fetchCatalog();
      const fullViewModel = useCache ? cachedViewModel : buildViewModel(catalog);
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      const categoryInfo = fullViewModel.categories.find((item) => item.key === categoryKey);
      if (!categoryInfo) throw new Error("这个小类当前没有公开可选商品");

      app.globalData.catalog = catalog;
      app.globalData.catalogViewModel = fullViewModel;
      if (!useCache) app.globalData.loadedAt = Date.now();
      this.catalog = catalog;
      this.fullViewModel = fullViewModel;
      this.applySiteFilter();
      this.setData({ loading: false, refreshing: false, error: "" });
    } catch (error) {
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      app.globalData.catalog = null;
      app.globalData.catalogViewModel = null;
      app.globalData.loadedAt = 0;
      this.catalog = null;
      this.fullViewModel = null;
      this.viewModel = null;
      this.setData({
        loading: false,
        refreshing: false,
        error: error && error.message || "商品列表加载失败",
        categoryInfo: null,
        majorLabel: "",
        products: [],
        filteredSpecimenCount: 0
      });
    } finally {
      if (isCurrentPublicCatalogRequest(this, requestGeneration)) wx.stopPullDownRefresh();
    }
  },

  applySiteFilter() {
    if (!this.catalog || !this.fullViewModel) return;
    const categoryInfo = this.fullViewModel.categories.find((item) => item.key === this.data.categoryKey);
    if (!categoryInfo) return;
    this.viewModel = this.data.selectedSiteId === "all"
      ? this.fullViewModel
      : buildViewModel(this.catalog, this.data.selectedSiteId);
    const siteCategory = this.viewModel.categories.find((item) => item.key === categoryInfo.key);
    const major = this.fullViewModel.majorGroups.find((item) => item.key === categoryInfo.majorKey)
      || this.fullViewModel.majorGroups.find((item) => item.key === this.data.majorKey);
    this.setData({
      categoryInfo: {
        ...categoryInfo,
        speciesCount: siteCategory ? siteCategory.speciesCount : 0,
        productCount: siteCategory ? siteCategory.productCount : 0,
        specimenCount: siteCategory ? siteCategory.specimenCount : 0
      },
      majorKey: categoryInfo.majorKey,
      majorLabel: major && major.label || "商品分类"
    });
    this.applyFilter(this.data.keyword);
  },

  applyFilter(keyword) {
    if (!this.viewModel) return;
    const nextKeyword = keyword || "";
    const products = filterProducts(this.viewModel, this.data.categoryKey, nextKeyword);
    this.setData({
      keyword: nextKeyword,
      products,
      filteredSpecimenCount: products.reduce((total, item) => total + item.specimenCount, 0)
    });
  },

  onSiteTap(event) {
    this.selectSite(event.currentTarget.dataset.siteId);
  },

  onClearSite() {
    this.selectSite("all");
  },

  selectSite(siteId) {
    const site = setSiteSelection(siteId);
    if (!site || site.id === this.data.selectedSiteId) return;
    this.setData({ selectedSiteId: site.id, selectedSiteName: site.label });
    if (this.catalog) {
      this.applySiteFilter();
    } else if (!this.data.loading) {
      this.loadProducts({ force: true });
    }
  },

  onSearchInput(event) {
    this.applyFilter(event.detail.value || "");
  },

  onClearSearch() {
    this.applyFilter("");
  },

  onBackTap() {
    returnToParent("pages/catalog/index");
  },

  onProductTap(event) {
    const productId = event.currentTarget.dataset.id;
    if (!productId) return;
    wx.navigateTo({
      url: `/pages/specimens/index?productId=${encodeURIComponent(productId)}&siteId=${encodeURIComponent(this.data.selectedSiteId)}`
    });
  },

  onRetry() {
    this.loadProducts({ force: true });
  },

  onCardImageError(event) {
    handleCardImageError(this, event, "products");
  },

  onShareAppMessage() {
    const categoryInfo = this.data.categoryInfo;
    const firstProduct = this.data.products[0];
    const scopeLabel = this.data.selectedSiteId === "all" ? "在售商品" : `${this.data.selectedSiteName}在售商品`;
    return {
      title: categoryInfo ? `海洋森林 · ${categoryInfo.label} · ${scopeLabel}` : "海洋森林 · 生物选购",
      path: `/pages/products/index?category=${encodeURIComponent(this.data.categoryKey || "")}&majorKey=${encodeURIComponent(this.data.majorKey || "")}&siteId=${encodeURIComponent(this.data.selectedSiteId)}`,
      imageUrl: firstProduct && firstProduct.image || undefined
    };
  }
});
