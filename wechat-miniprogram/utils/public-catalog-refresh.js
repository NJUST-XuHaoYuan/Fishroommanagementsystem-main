const PUBLIC_CATALOG_REFRESH_MS = 60 * 1000;

function stopPublicCatalogRefresh(page) {
  if (!page) return;
  if (page.__publicCatalogRefreshTimer !== null && page.__publicCatalogRefreshTimer !== undefined) {
    clearInterval(page.__publicCatalogRefreshTimer);
  }
  page.__publicCatalogRefreshTimer = null;
  page.__publicCatalogIsVisible = false;
  page.__publicCatalogRequestGeneration = Number(page.__publicCatalogRequestGeneration || 0) + 1;
}

function startPublicCatalogRefresh(page, refresh) {
  if (!page || typeof refresh !== "function") return;
  if (page.__publicCatalogRefreshTimer !== null && page.__publicCatalogRefreshTimer !== undefined) {
    clearInterval(page.__publicCatalogRefreshTimer);
  }
  page.__publicCatalogIsVisible = true;

  const hasShownBefore = Boolean(page.__publicCatalogHasShown);
  page.__publicCatalogHasShown = true;
  if (hasShownBefore) void refresh();

  page.__publicCatalogRefreshTimer = setInterval(() => {
    void refresh();
  }, PUBLIC_CATALOG_REFRESH_MS);
}

function beginPublicCatalogRequest(page) {
  const generation = Number(page && page.__publicCatalogRequestGeneration || 0) + 1;
  if (page) page.__publicCatalogRequestGeneration = generation;
  return generation;
}

function isCurrentPublicCatalogRequest(page, generation) {
  return Boolean(page) &&
    page.__publicCatalogIsVisible !== false &&
    Number(page.__publicCatalogRequestGeneration || 0) === Number(generation);
}

module.exports = {
  PUBLIC_CATALOG_REFRESH_MS,
  beginPublicCatalogRequest,
  isCurrentPublicCatalogRequest,
  startPublicCatalogRefresh,
  stopPublicCatalogRefresh
};
