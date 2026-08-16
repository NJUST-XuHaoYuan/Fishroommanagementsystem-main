const { fetchCatalog, fetchBioRecords } = require("../../utils/api");
const {
  buildViewModel,
  findSpecimen,
  normalizeTimeline
} = require("../../utils/catalog");

Page({
  data: {
    loading: true,
    error: "",
    stockItemId: "",
    specimen: null,
    timeline: [],
    imagePreview: []
  },

  onLoad(options) {
    const stockItemId = decodeURIComponent(options.stockItemId || "");
    this.setData({ stockItemId });
    this.loadDetail(stockItemId);
  },

  onPullDownRefresh() {
    this.loadDetail(this.data.stockItemId, { force: true, refreshing: true });
  },

  async ensureViewModel(force) {
    const app = getApp();
    if (!force && app.globalData.catalogViewModel) return app.globalData.catalogViewModel;
    const catalog = await fetchCatalog();
    const viewModel = buildViewModel(catalog);
    app.globalData.catalog = catalog;
    app.globalData.catalogViewModel = viewModel;
    app.globalData.loadedAt = Date.now();
    return viewModel;
  },

  async loadDetail(stockItemId, options = {}) {
    if (!stockItemId) {
      this.setData({
        loading: false,
        error: "缺少个体编号"
      });
      return;
    }

    this.setData({
      loading: !options.refreshing,
      error: ""
    });

    try {
      const viewModel = await this.ensureViewModel(Boolean(options.force));
      const specimen = findSpecimen(viewModel, stockItemId);
      if (!specimen) throw new Error("这个个体当前没有公开库存");
      const records = await fetchBioRecords(stockItemId);
      const timeline = normalizeTimeline(records, specimen);
      const imagePreview = [
        specimen.image,
        ...timeline.reduce((list, item) => list.concat(item.photos || []), [])
      ].filter(Boolean);

      this.setData({
        loading: false,
        specimen,
        timeline,
        imagePreview
      });
    } catch (error) {
      this.setData({
        loading: false,
        error: error && error.message || "详情加载失败"
      });
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  onRetry() {
    this.loadDetail(this.data.stockItemId, { force: true });
  },

  onCopyCode() {
    const code = this.data.specimen && this.data.specimen.selectionCode;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success() {
        wx.showToast({
          title: "已复制选鱼码",
          icon: "success"
        });
      }
    });
  },

  onPreviewImage(event) {
    const src = event.currentTarget.dataset.src;
    const urls = this.data.imagePreview || [];
    if (!src || !urls.length) return;
    wx.previewImage({
      current: src,
      urls
    });
  },

  onShareAppMessage() {
    const specimen = this.data.specimen;
    return {
      title: specimen ? `${specimen.speciesName} · ${specimen.displayCode}` : "海水鱼廊个体详情",
      path: `/pages/detail/index?stockItemId=${encodeURIComponent(this.data.stockItemId || "")}`,
      imageUrl: specimen && specimen.image || undefined
    };
  }
});
