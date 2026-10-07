const { fetchCatalog, fetchBioRecords } = require("../../utils/api");
const { returnToParent } = require("../../utils/navigation");
const { specimenContactCard } = require("../../utils/contact-card");
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
  publicMediaNeedsRefresh,
  startPublicCatalogRefresh,
  stopPublicCatalogRefresh
} = require("../../utils/public-catalog-refresh");

Page({
  data: {
    loading: true,
    refreshing: false,
    error: "",
    stockItemId: "",
    groupMode: false,
    members: [],
    contactCard: null,
    specimen: null,
    timeline: [],
    imagePreview: [],
    imageGeneration: 0,
    imageErrorCount: 0,
    videoOpeningId: "",
    videoErrorId: "",
    videoErrorText: ""
  },

  onLoad(options) {
    const stockItemId = decodeURIComponent(options.stockItemId || "");
    this.setData({ stockItemId, groupMode: options.group === "1" });
    this.loadDetail(stockItemId);
  },

  onShow() {
    this.__detailUnloaded = false;
    this.__videoOpenGeneration = Number(this.__videoOpenGeneration || 0) + 1;
    this.__openingTimelineVideo = false;
    this.setData({ videoOpeningId: "" });
    startPublicCatalogRefresh(this, () => this.loadDetail(this.data.stockItemId, { force: true, refreshing: true }));
  },

  onHide() {
    stopPublicCatalogRefresh(this);
    // Remove media nodes before iOS can restore them with yesterday's URLs.
    // The foreground request remounts them only after fresh data arrives.
    this.setData({ loading: true });
  },

  onUnload() {
    this.__detailUnloaded = true;
    this.__videoOpenGeneration = Number(this.__videoOpenGeneration || 0) + 1;
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
      loading: !options.refreshing || this.data.loading,
      refreshing: Boolean(options.refreshing),
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

      const currentImageSources = new Set([
        ...imagePreview,
        ...timeline.reduce((list, item) => list.concat((item.videoItems || []).map((video) => video.poster)), [])
      ].filter(Boolean));
      // Background updates keep unchanged image nodes, including failed ones.
      // Clear their failures only after a load event or a manual remount.
      this.__failedImageSources = options.refreshing
        ? new Set(Array.from(this.__failedImageSources || []).filter((src) => currentImageSources.has(src)))
        : new Set();
      this.setData({
        loading: false,
        refreshing: false,
        specimen,
        stockItemId,
        members,
        timeline,
        imagePreview,
        imageGeneration: this.data.imageGeneration + 1,
        imageErrorCount: this.__failedImageSources.size,
        videoErrorId: "",
        videoErrorText: "",
        contactCard: specimenContactCard(specimen, members.length || 1)
      });
    } catch (error) {
      if (!isCurrentPublicCatalogRequest(this, requestGeneration)) return;
      const app = getApp();
      app.globalData.catalog = null;
      app.globalData.catalogViewModel = null;
      app.globalData.loadedAt = 0;
      this.__failedImageSources = new Set();
      this.setData({
        loading: false,
        refreshing: false,
        error: error && error.message || "详情加载失败",
        specimen: null,
        members: [],
        contactCard: null,
        timeline: [],
        imagePreview: [],
        imageErrorCount: 0,
        videoOpeningId: "",
        videoErrorId: "",
        videoErrorText: ""
      });
    } finally {
      if (isCurrentPublicCatalogRequest(this, requestGeneration)) {
        wx.stopPullDownRefresh();
      }
    }
  },

  onRetry() {
    this.loadDetail(this.data.stockItemId, { force: true });
  },

  onBackTap() {
    const specimen = this.data.specimen;
    const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
    const parent = pages[pages.length - 2];
    if (specimen && parent && parent.route === "pages/specimens/index"
      && parent.data && !parent.data.productId && parent.data.speciesId === specimen.speciesId) {
      returnToParent("pages/specimens/index", { speciesId: specimen.speciesId });
      return;
    }
    const productId = specimen && specimen.productId;
    returnToParent(productId ? "pages/specimens/index" : "pages/catalog/index", productId ? { productId } : {});
  },

  onPreviewImage(event) {
    if (this.__detailUnloaded || this.data.loading || this.data.error) return;
    if (this.data.refreshing) {
      wx.showToast({ title: "正在更新媒体，请稍后重试", icon: "none" });
      return;
    }
    const src = event.currentTarget.dataset.src;
    const urls = this.data.imagePreview || [];
    if (!src || !urls.includes(src)) return;
    if (urls.some((url) => publicMediaNeedsRefresh(url))) {
      wx.showToast({ title: "正在更新图片，请稍后再点", icon: "none" });
      void this.loadDetail(this.data.stockItemId, { force: true, refreshing: true });
      return;
    }
    wx.previewImage({
      current: src,
      urls
    });
  },

  onDetailImageError(event) {
    this.updateDetailImageState(event, true);
  },

  onDetailImageLoad(event) {
    this.updateDetailImageState(event, false);
  },

  updateDetailImageState(event, failed) {
    if (this.__detailUnloaded || this.data.loading || this.data.error) return;
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const src = String(dataset.src || "");
    if (!src || Number(dataset.imageGeneration) !== this.data.imageGeneration) return;
    const currentSource = this.data.specimen && this.data.specimen.image === src
      || this.data.timeline.some((record) => (record.photos || []).includes(src)
        || (record.videoItems || []).some((video) => video.poster === src));
    if (!currentSource) return;
    const failures = this.__failedImageSources || (this.__failedImageSources = new Set());
    if (failed) failures.add(src);
    else failures.delete(src);
    if (this.data.imageErrorCount !== failures.size) this.setData({ imageErrorCount: failures.size });
  },

  onReloadDetailImages() {
    if (this.__detailUnloaded || this.data.loading || this.data.refreshing || !this.data.imageErrorCount) return;
    // The loading branch unmounts failed images so even unchanged URLs retry.
    return this.loadDetail(this.data.stockItemId, { force: true });
  },

  onPlayTimelineVideo(event) {
    if (this.__detailUnloaded || this.__openingTimelineVideo || this.data.loading || this.data.error) return;
    // A foreground refresh may still be replacing expired signed media URLs.
    // Keep native preview on a subsequent user tap, after current data arrives.
    if (this.data.refreshing) {
      wx.showToast({ title: "正在更新媒体，请稍后重试", icon: "none" });
      return;
    }
    const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
    const record = this.data.timeline.find((item) => item.id === dataset.recordId);
    const video = record && (record.videoItems || []).find((item) => item.index === Number(dataset.videoIndex));
    if (!video) {
      wx.showToast({ title: "视频记录已更新，请重新加载", icon: "none" });
      return;
    }
    // A throttled timer or a late resume must not hand the native player an
    // expired address. Keep the viewer call on the next synchronous user tap.
    if (publicMediaNeedsRefresh(video.src, Date.now(), 2 * 60 * 1000)
      || (video.poster && publicMediaNeedsRefresh(video.poster))) {
      wx.showToast({ title: "正在更新视频，请稍后再点", icon: "none" });
      void this.loadDetail(this.data.stockItemId, { force: true, refreshing: true });
      return;
    }
    if (typeof wx.previewMedia !== "function") {
      this.setData({ videoErrorId: video.id, videoErrorText: "当前微信版本不支持视频预览，请升级微信后重试。" });
      return;
    }

    const generation = Number(this.__videoOpenGeneration || 0) + 1;
    this.__videoOpenGeneration = generation;
    this.__openingTimelineVideo = true;
    this.setData({ videoOpeningId: video.id, videoErrorId: "", videoErrorText: "" });
    const isCurrent = () => !this.__detailUnloaded && this.__videoOpenGeneration === generation;
    const finish = () => {
      if (!isCurrent()) return;
      this.__openingTimelineVideo = false;
      this.setData({ videoOpeningId: "" });
    };
    const fail = (error) => {
      if (!isCurrent() || /cancel/i.test(String(error && error.errMsg || ""))) return;
      this.setData({
        videoErrorId: video.id,
        videoErrorText: "视频暂时无法打开，请重新加载视频后再试。"
      });
    };
    const source = { url: video.src, type: "video" };
    if (video.poster) source.poster = video.poster;
    try {
      // Open directly from the tap. The native viewer is independent of the
      // timeline's periodic refresh and does not mount an iOS player per row.
      wx.previewMedia({ sources: [source], current: 0, fail, complete: finish });
    } catch (error) {
      fail(error);
      finish();
    }
  },

  onReloadTimelineVideos() {
    this.loadDetail(this.data.stockItemId, { force: true, refreshing: true });
  },

  onShareAppMessage() {
    const specimen = this.data.specimen;
    return {
      title: specimen ? `${specimen.productName} · 库存 ${this.data.members.length || 1} ${specimen.unit}` : "商品详情",
      path: `/pages/detail/index?stockItemId=${encodeURIComponent(this.data.stockItemId || "")}${this.data.groupMode ? "&group=1" : ""}`,
      imageUrl: specimen && specimen.image || undefined
    };
  }
});
