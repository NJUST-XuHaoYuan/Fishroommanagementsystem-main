const { fetchCatalog, fetchBioRecords } = require("../../utils/api");
const {
  buildViewModel,
  findSpecimen,
  filterSpecimens,
  groupSpecimens,
  normalizeTimeline
} = require("../../utils/catalog");
const {
  beginPublicCatalogRequest,
  isCurrentPublicCatalogRequest,
  startPublicCatalogRefresh,
  stopPublicCatalogRefresh
} = require("../../utils/public-catalog-refresh");

Page({
  data: {
    loading: true,
    error: "",
    stockItemId: "",
    groupMode: false,
    members: [],
    memberLoading: false,
    specimen: null,
    timeline: [],
    imagePreview: []
  },

  onLoad(options) {
    const stockItemId = decodeURIComponent(options.stockItemId || "");
    this.setData({ stockItemId, groupMode: options.group === "1" });
    this.loadDetail(stockItemId);
  },

  onShow() {
    startPublicCatalogRefresh(this, () => this.loadDetail(this.data.stockItemId, { force: true, refreshing: true }));
  },

  onHide() {
    stopPublicCatalogRefresh(this);
  },

  onUnload() {
    stopPublicCatalogRefresh(this);
  },

  onPullDownRefresh() {
    this.loadDetail(this.data.stockItemId, { force: true, refreshing: true });
  },

  async ensureViewModel(force, requestGeneration) {
    const app = getApp();
    const cacheTtl = 60 * 1000;
    const cacheIsFresh = app.globalData.catalogViewModel
      && Date.now() - Number(app.globalData.loadedAt || 0) < cacheTtl;
    if (!force && cacheIsFresh) return app.globalData.catalogViewModel;
    const catalog = await fetchCatalog();
    const viewModel = buildViewModel(catalog);
    if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return null;
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
    const requestGeneration = beginPublicCatalogRequest(this);

    this.setData({
      loading: !options.refreshing,
      error: ""
    });

    try {
      const viewModel = await this.ensureViewModel(Boolean(options.force), requestGeneration);
      if (!viewModel || !isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      const specimen = findSpecimen(viewModel, stockItemId);
      if (!specimen) throw new Error("这个个体当前没有公开库存");
      const group = this.data.groupMode
        ? groupSpecimens(filterSpecimens(viewModel, { productId: specimen.productId }, "all"))
          .find((item) => item.members.some((member) => member.id === stockItemId))
        : null;
      const members = group ? group.members : [];
      const records = await fetchBioRecords(stockItemId);
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      const timeline = normalizeTimeline(records, specimen);
      const imagePreview = [
        specimen.image,
        ...timeline.reduce((list, item) => list.concat(item.photos || []), [])
      ].filter(Boolean);

      this.setData({
        loading: false,
        specimen,
        stockItemId,
        members,
        timeline,
        imagePreview
      });
    } catch (error) {
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      const app = getApp();
      app.globalData.catalog = null;
      app.globalData.catalogViewModel = null;
      app.globalData.loadedAt = 0;
      this.setData({
        loading: false,
        error: error && error.message || "详情加载失败",
        specimen: null,
        members: [],
        timeline: [],
        imagePreview: []
      });
    } finally {
      if (isCurrentPublicCatalogRequest(this, requestGeneration)) {
        this.setData({ memberLoading: false });
        wx.stopPullDownRefresh();
      }
    }
  },

  onRetry() {
    this.loadDetail(this.data.stockItemId, { force: true });
  },

  onMemberTap(event) {
    const stockItemId = event.currentTarget.dataset.id;
    if (stockItemId === this.data.stockItemId || !this.data.members.some((item) => item.id === stockItemId)) return;
    this.setData({ memberLoading: true });
    return this.loadDetail(stockItemId, { refreshing: true });
  },

  onCopyCode() {
    if (this.data.memberLoading) return;
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
      path: `/pages/detail/index?stockItemId=${encodeURIComponent(this.data.stockItemId || "")}${this.data.groupMode ? "&group=1" : ""}`,
      imageUrl: specimen && specimen.image || undefined
    };
  }
});
