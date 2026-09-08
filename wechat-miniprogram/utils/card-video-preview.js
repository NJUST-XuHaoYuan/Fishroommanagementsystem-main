const CARD_VIDEO_PLAYER_ID = "card-video-preview-player";
const ACTIVE_VIDEO_SELECTOR = ".active-card-video";

function disconnectObserver(page) {
  if (page.__cardVideoObserver && typeof page.__cardVideoObserver.disconnect === "function") {
    page.__cardVideoObserver.disconnect();
  }
  page.__cardVideoObserver = null;
}

function pausePlayer(page) {
  if (page.__cardVideoContext && typeof page.__cardVideoContext.pause === "function") {
    page.__cardVideoContext.pause();
  }
  page.__cardVideoContext = null;
}

function stopCardVideoPreview(page, options = {}) {
  disconnectObserver(page);
  pausePlayer(page);
  if (options.clearData === false || !page.data || !page.data.activePreviewId) return;
  page.setData({ activePreviewId: "" });
}

function observeActiveVideo(page, itemId) {
  disconnectObserver(page);
  if (typeof page.createIntersectionObserver !== "function") return;
  const observer = page.createIntersectionObserver({ thresholds: [0, 0.01] });
  page.__cardVideoObserver = observer;
  observer.relativeToViewport().observe(ACTIVE_VIDEO_SELECTOR, (result) => {
    if (Number(result && result.intersectionRatio) > 0) return;
    if (page.data && page.data.activePreviewId === itemId) stopCardVideoPreview(page);
  });
}

function toggleCardVideoPreview(page, event) {
  const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
  const itemId = String(dataset.id || "").trim();
  const preview = String(dataset.preview || "").trim();
  if (!itemId || !preview) return;

  if (page.data && page.data.activePreviewId === itemId) {
    stopCardVideoPreview(page);
    return;
  }

  disconnectObserver(page);
  pausePlayer(page);
  page.setData({ activePreviewId: itemId }, () => {
    if (!page.data || page.data.activePreviewId !== itemId) return;
    if (typeof wx.createVideoContext === "function") {
      page.__cardVideoContext = wx.createVideoContext(CARD_VIDEO_PLAYER_ID, page);
      if (page.__cardVideoContext && typeof page.__cardVideoContext.play === "function") {
        page.__cardVideoContext.play();
      }
    }
    observeActiveVideo(page, itemId);
  });
}

function handleCardVideoError(page) {
  stopCardVideoPreview(page);
  wx.showToast({
    title: "视频预览暂不可用",
    icon: "none"
  });
}

function handleCardImageError(page, event, collectionKey) {
  const dataset = event && event.currentTarget && event.currentTarget.dataset || {};
  const itemId = String(dataset.id || "").trim();
  const key = String(collectionKey || "").trim();
  const items = page && page.data && page.data[key];
  if (!itemId || !key || !Array.isArray(items)) return;

  let changed = false;
  const nextItems = items.map((item) => {
    if (!item || String(item.id || "") !== itemId) return item;
    const fallbackImage = String(item.fallbackImage || "").trim();
    changed = true;
    return {
      ...item,
      image: fallbackImage && fallbackImage !== item.image ? fallbackImage : "",
      fallbackImage: ""
    };
  });
  if (changed) page.setData({ [key]: nextItems });
}

module.exports = {
  CARD_VIDEO_PLAYER_ID,
  handleCardImageError,
  handleCardVideoError,
  stopCardVideoPreview,
  toggleCardVideoPreview
};
