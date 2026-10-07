const { fetchCatalog } = require("../../utils/api");
const { returnToParent } = require("../../utils/navigation");
const {
  buildViewModel,
  filterSpecimens,
  groupSpecimens,
  findProduct
} = require("../../utils/catalog");
const {
  beginPublicCatalogRequest,
  isCurrentPublicCatalogRequest,
  publicMediaNeedsRefresh,
  startPublicCatalogRefresh,
  stopPublicCatalogRefresh
} = require("../../utils/public-catalog-refresh");
const {
  handleCardImageError,
  handleCardVideoError,
  stopCardVideoPreview,
  toggleCardVideoPreview
} = require("../../utils/card-video-preview");

function decodeOption(value) {
  try {
    return decodeURIComponent(value || "");
  } catch (error) {
    return String(value || "");
  }
}

const SITE_OPTIONS = [
  { id: "all", label: "全部" },
  { id: "nanjing", label: "南京" },
  { id: "jiangyin", label: "江阴" }
];

Page({
  data: {
    loading: true,
    refreshing: false,
    error: "",
    productId: "",
    speciesId: "",
    context: null,
    parentCategory: "",
    unit: "条",
    specimens: [],
    filteredSpecimenCount: 0,
    selectedSiteId: "all",
    selectedSiteName: "全部",
    siteDataReady: false,
    siteOptions: SITE_OPTIONS.map((item) => ({ ...item, count: 0 })),
    activePreviewId: ""
  },

  onLoad(options) {
    const siteId = decodeOption(options.siteId);
    const site = SITE_OPTIONS.find((item) => item.id === siteId) || SITE_OPTIONS[0];
    this.setData({
      productId: decodeOption(options.productId),
      speciesId: decodeOption(options.speciesId),
      selectedSiteId: site.id,
      selectedSiteName: site.label
    });
    this.loadSpecimens();
  },

  onShow() {
    startPublicCatalogRefresh(this, () => this.loadSpecimens({ force: true, refreshing: !this.data.loading }));
  },

  onHide() {
    stopPublicCatalogRefresh(this);
    stopCardVideoPreview(this);
    // Unmount signed media before the page can resume with expired sources.
    this.setData({ loading: true, refreshing: false });
  },

  onUnload() {
    stopPublicCatalogRefresh(this);
    stopCardVideoPreview(this, { clearData: false });
  },

  onPullDownRefresh() {
    this.loadSpecimens({ force: true, refreshing: true });
  },

  async loadSpecimens(options = {}) {
    if (this.__publicCatalogIsVisible === false) return;
    stopCardVideoPreview(this);
    const productId = this.data.productId;
    const speciesId = this.data.speciesId;
    if (!productId && !speciesId) {
      this.setData({ loading: false, error: "缺少商品编号" });
      return;
    }

    const app = getApp();
    const requestGeneration = beginPublicCatalogRequest(this);
    const now = Date.now();
    const cacheTtl = 60 * 1000;
    const cachedViewModel = app.globalData.catalogViewModel;
    const useCache = !options.force
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
      const product = productId ? findProduct(viewModel, productId) : null;
      const species = speciesId
        ? viewModel.speciesCards.find((item) => item.id === speciesId)
        : null;
      if (productId && !product) throw new Error("这个商品当前没有公开库存");
      if (!productId && !species) throw new Error("这个品种当前没有公开库存");

      const context = product ? {
        name: product.name,
        subtitle: `${product.speciesName} · ${product.size} · ${product.origin}`,
        image: product.image,
        specimenCount: product.specimenCount,
        priceRange: product.priceText,
        priceNote: product.priceNote
      } : species;

      app.globalData.catalog = catalog;
      app.globalData.catalogViewModel = viewModel;
      if (!useCache) app.globalData.loadedAt = Date.now();
      this.viewModel = viewModel;

      wx.setNavigationBarTitle({ title: context.name });
      this.setData({ context, parentCategory: (product || species).category,
        unit: viewModel.categories.find((item) => item.key === (product || species).category)?.unit || "条" });
      this.showAllStock();
      this.setData({ loading: false, refreshing: false });
    } catch (error) {
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      app.globalData.catalog = null;
      app.globalData.catalogViewModel = null;
      app.globalData.loadedAt = 0;
      this.viewModel = null;
      this.setData({
        loading: false,
        refreshing: false,
        error: error && error.message || "可选个体加载失败",
        context: null,
        specimens: [],
        filteredSpecimenCount: 0,
        siteDataReady: false,
        siteOptions: SITE_OPTIONS.map((item) => ({ ...item, count: 0 }))
      });
    } finally {
      if (isCurrentPublicCatalogRequest(this, requestGeneration)) wx.stopPullDownRefresh();
    }
  },

  showAllStock() {
    if (!this.viewModel) return;
    stopCardVideoPreview(this);
    const selection = {
      productId: this.data.productId,
      speciesId: this.data.productId ? "" : this.data.speciesId
    };
    const allSpecimens = filterSpecimens(this.viewModel, selection, "all");
    const siteDataReady = allSpecimens.every((item) => Boolean(item.siteId));
    const specimens = !siteDataReady && this.data.selectedSiteId !== "all" ? [] : filterSpecimens(this.viewModel, {
      ...selection, siteId: this.data.selectedSiteId
    }, "all");
    this.setData({
      specimens: groupSpecimens(specimens),
      filteredSpecimenCount: specimens.length,
      siteDataReady,
      siteOptions: SITE_OPTIONS.map((item) => ({
        ...item,
        count: allSpecimens.filter((specimen) => item.id === "all" || specimen.siteId === item.id).length
      }))
    });
  },

  onSiteTap(event) {
    const siteId = event.currentTarget.dataset.siteId;
    const site = SITE_OPTIONS.find((item) => item.id === siteId);
    if (!site || site.id === this.data.selectedSiteId || !this.viewModel) return;
    if (site.id !== "all" && !this.data.siteDataReady) return;
    this.setData({ selectedSiteId: site.id, selectedSiteName: site.label });
    this.showAllStock();
  },

  onClearSite() {
    this.setData({ selectedSiteId: "all", selectedSiteName: "全部" });
    this.showAllStock();
  },

  onBackTap() {
    const category = this.data.parentCategory;
    returnToParent(category ? "pages/products/index" : "pages/catalog/index", category ? { category } : {});
  },

  onSpecimenTap(event) {
    stopCardVideoPreview(this);
    const stockItemId = event.currentTarget.dataset.id;
    if (!stockItemId) return;
    const group = this.data.specimens.find((item) => item.id === stockItemId);
    wx.navigateTo({
      url: `/pages/detail/index?stockItemId=${encodeURIComponent(stockItemId)}${group && group.grouped ? "&group=1" : ""}`
    });
  },

  onRetry() {
    this.loadSpecimens({ force: true });
  },

  onPreviewToggle(event) {
    if (this.__publicCatalogIsVisible === false || this.data.loading || this.data.refreshing || this.data.error) return;
    const id = String(event && event.currentTarget && event.currentTarget.dataset.id || "");
    const item = this.data.specimens.find((entry) => String(entry.id) === id);
    if (item && publicMediaNeedsRefresh(item.previewVideo)) {
      wx.showToast({ title: "正在更新视频，请稍后再点", icon: "none" });
      void this.loadSpecimens({ force: true, refreshing: true });
      return;
    }
    toggleCardVideoPreview(this, event);
  },

  onPreviewError(event) {
    handleCardVideoError(this, event);
  },

  onCardImageError(event) {
    handleCardImageError(this, event, "specimens");
  },

  onShareAppMessage() {
    const context = this.data.context;
    const query = this.data.productId
      ? `productId=${encodeURIComponent(this.data.productId)}`
      : `speciesId=${encodeURIComponent(this.data.speciesId || "")}`;
    return {
      title: context ? `${context.name} · ${this.data.selectedSiteId === "all" ? "可选个体" : this.data.selectedSiteName + "库存"}` : "海水生物鱼单",
      path: `/pages/specimens/index?${query}${this.data.selectedSiteId === "all" ? "" : `&siteId=${encodeURIComponent(this.data.selectedSiteId)}`}`,
      imageUrl: context && context.image || undefined
    };
  }
});
