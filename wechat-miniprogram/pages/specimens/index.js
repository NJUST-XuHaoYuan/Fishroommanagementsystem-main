const { fetchCatalog } = require("../../utils/api");
const {
  buildViewModel,
  filterSpecimens,
  findProduct
} = require("../../utils/catalog");

const filterOptions = [
  { key: "all", label: "全部" },
  { key: "quarantined", label: "入缸14天+" },
  { key: "feeding", label: "已开口" }
];

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
    error: "",
    productId: "",
    speciesId: "",
    context: null,
    specimens: [],
    activeFilter: "all",
    filterOptions
  },

  onLoad(options) {
    this.setData({
      productId: decodeOption(options.productId),
      speciesId: decodeOption(options.speciesId)
    });
    this.loadSpecimens();
  },

  onPullDownRefresh() {
    this.loadSpecimens({ force: true, refreshing: true });
  },

  async loadSpecimens(options = {}) {
    const productId = this.data.productId;
    const speciesId = this.data.speciesId;
    if (!productId && !speciesId) {
      this.setData({ loading: false, error: "缺少商品编号" });
      return;
    }

    const app = getApp();
    const now = Date.now();
    const cacheTtl = 60 * 1000;
    const cachedViewModel = app.globalData.catalogViewModel;
    const useCache = !options.force
      && cachedViewModel
      && Array.isArray(cachedViewModel.productCards)
      && now - Number(app.globalData.loadedAt || 0) < cacheTtl;

    this.setData({
      loading: !options.refreshing,
      error: ""
    });

    try {
      const catalog = useCache ? app.globalData.catalog : await fetchCatalog();
      const viewModel = useCache ? cachedViewModel : buildViewModel(catalog);
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
        priceRange: product.priceText
      } : species;

      app.globalData.catalog = catalog;
      app.globalData.catalogViewModel = viewModel;
      app.globalData.loadedAt = now;
      this.viewModel = viewModel;

      wx.setNavigationBarTitle({ title: context.name });
      this.setData({ context });
      this.applyFilter("all");
    } catch (error) {
      this.setData({
        loading: false,
        error: error && error.message || "可选个体加载失败"
      });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  applyFilter(filterKey) {
    if (!this.viewModel) return;
    const activeFilter = filterKey || "all";
    const specimens = filterSpecimens(this.viewModel, {
      productId: this.data.productId,
      speciesId: this.data.productId ? "" : this.data.speciesId
    }, activeFilter);
    this.setData({
      loading: false,
      activeFilter,
      specimens
    });
  },

  onFilterTap(event) {
    this.applyFilter(event.currentTarget.dataset.key || "all");
  },

  onSpecimenTap(event) {
    const stockItemId = event.currentTarget.dataset.id;
    if (!stockItemId) return;
    wx.navigateTo({
      url: `/pages/detail/index?stockItemId=${encodeURIComponent(stockItemId)}`
    });
  },

  onRetry() {
    this.loadSpecimens({ force: true });
  },

  onShareAppMessage() {
    const context = this.data.context;
    const query = this.data.productId
      ? `productId=${encodeURIComponent(this.data.productId)}`
      : `speciesId=${encodeURIComponent(this.data.speciesId || "")}`;
    return {
      title: context ? `${context.name} · 可选个体` : "海水生物鱼单",
      path: `/pages/specimens/index?${query}`,
      imageUrl: context && context.image || undefined
    };
  }
});
