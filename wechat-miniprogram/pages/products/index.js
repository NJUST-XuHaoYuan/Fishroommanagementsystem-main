const { fetchCatalog } = require("../../utils/api");
const {
  buildViewModel,
  filterProducts
} = require("../../utils/catalog");
const { getNavigationMetrics } = require("../../utils/navigation");
const {
  beginPublicCatalogRequest,
  isCurrentPublicCatalogRequest,
  startPublicCatalogRefresh,
  stopPublicCatalogRefresh
} = require("../../utils/public-catalog-refresh");

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
    keyword: "",
    products: [],
    filteredSpecimenCount: 0,
    ...getNavigationMetrics()
  },

  onLoad(options) {
    this.setData({
      categoryKey: decodeOption(options.category),
      majorKey: decodeOption(options.majorKey)
    });
    this.loadProducts();
  },

  onShow() {
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
      this.setData({ loading: false, error: "缺少小类信息" });
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
      loading: !options.refreshing,
      refreshing: Boolean(options.refreshing),
      error: ""
    });

    try {
      const catalog = useCache ? app.globalData.catalog : await fetchCatalog();
      const viewModel = useCache ? cachedViewModel : buildViewModel(catalog);
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      const categoryInfo = viewModel.categories.find((item) => item.key === categoryKey);
      if (!categoryInfo) throw new Error("这个小类当前没有公开可选商品");
      const major = viewModel.majorGroups.find((item) => item.key === categoryInfo.majorKey)
        || viewModel.majorGroups.find((item) => item.key === this.data.majorKey);

      app.globalData.catalog = catalog;
      app.globalData.catalogViewModel = viewModel;
      if (!useCache) app.globalData.loadedAt = Date.now();
      this.viewModel = viewModel;

      this.setData({
        categoryInfo,
        majorKey: categoryInfo.majorKey,
        majorLabel: major && major.label || "商品分类"
      });
      this.applyFilter(this.data.keyword);
    } catch (error) {
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      app.globalData.catalog = null;
      app.globalData.catalogViewModel = null;
      app.globalData.loadedAt = 0;
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

  applyFilter(keyword) {
    if (!this.viewModel) return;
    const nextKeyword = keyword || "";
    const products = filterProducts(this.viewModel, this.data.categoryKey, nextKeyword);
    this.setData({
      loading: false,
      refreshing: false,
      keyword: nextKeyword,
      products,
      filteredSpecimenCount: products.reduce((total, item) => total + item.specimenCount, 0)
    });
  },

  onSearchInput(event) {
    this.applyFilter(event.detail.value || "");
  },

  onClearSearch() {
    this.applyFilter("");
  },

  onBackTap() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }
    wx.reLaunch({ url: "/pages/catalog/index" });
  },

  onProductTap(event) {
    const productId = event.currentTarget.dataset.id;
    if (!productId) return;
    wx.navigateTo({
      url: `/pages/specimens/index?productId=${encodeURIComponent(productId)}`
    });
  },

  onRetry() {
    this.loadProducts({ force: true });
  },

  onShareAppMessage() {
    const categoryInfo = this.data.categoryInfo;
    const firstProduct = this.data.products[0];
    return {
      title: categoryInfo ? `${categoryInfo.label} · 在售商品` : "海水生物鱼单",
      path: `/pages/products/index?category=${encodeURIComponent(this.data.categoryKey || "")}&majorKey=${encodeURIComponent(this.data.majorKey || "")}`,
      imageUrl: firstProduct && firstProduct.image || undefined
    };
  }
});
