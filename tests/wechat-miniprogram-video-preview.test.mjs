import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const catalogSource = await readFile(
  new URL("../wechat-miniprogram/utils/catalog.js", import.meta.url),
  "utf8"
);
const previewSource = await readFile(
  new URL("../wechat-miniprogram/utils/card-video-preview.js", import.meta.url),
  "utf8"
);
const productsPageSource = await readFile(
  new URL("../wechat-miniprogram/pages/products/index.js", import.meta.url),
  "utf8"
);
const specimensPageSource = await readFile(
  new URL("../wechat-miniprogram/pages/specimens/index.js", import.meta.url),
  "utf8"
);
const productsTemplate = await readFile(
  new URL("../wechat-miniprogram/pages/products/index.wxml", import.meta.url),
  "utf8"
);
const specimensTemplate = await readFile(
  new URL("../wechat-miniprogram/pages/specimens/index.wxml", import.meta.url),
  "utf8"
);
const appStyles = await readFile(
  new URL("../wechat-miniprogram/app.wxss", import.meta.url),
  "utf8"
);

function loadCommonJs(source, dependencies = {}, globals = {}) {
  const context = {
    module: { exports: {} },
    exports: {},
    require(specifier) {
      if (!(specifier in dependencies)) throw new Error(`Unexpected dependency: ${specifier}`);
      return dependencies[specifier];
    },
    ...globals
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

function catalogFixture(records) {
  return {
    speciesCategories: ["神仙鱼"],
    speciesCategoryMajorMap: { 神仙鱼: "marineFish" },
    species: [{
      id: "species-1",
      name: "汤臣神仙鱼",
      scientificName: "Chaetodontoplus mesoleucus",
      category: "神仙鱼",
      imageUrl: "/species-default.jpg"
    }],
    products: [{
      id: "product-1",
      speciesId: "species-1",
      name: "汤臣神仙鱼",
      size: "M",
      origin: "印尼",
      imageUrl: "/product-default.jpg",
      defaultPrice: 880
    }],
    stock: [{
      id: "stock-189",
      productId: "product-1",
      code: "189",
      status: "healthy",
      inDate: "2026-08-01"
    }],
    bioRecords: records
  };
}

test("catalog view model uses a generated preview while preferring the newest real fish photo", () => {
  const { buildViewModel } = loadCommonJs(catalogSource, {
    "./api": { getApiBaseUrl: () => "https://fish.example" }
  }, { Date, encodeURIComponent });
  const viewModel = buildViewModel(catalogFixture([
    {
      id: "old-photo",
      stockItemId: "stock-189",
      date: "2026-08-06T10:00:00Z",
      photos: ["/uploads/old-photo.jpg"]
    },
    {
      id: "latest-video",
      stockItemId: "stock-189",
      date: "2026-08-18T10:00:00Z",
      videos: ["/uploads/original-1.mp4", "/uploads/original-2.mp4"],
      videoPosters: ["", "/uploads/poster-2.webp"],
      videoPreviews: ["", "/uploads/preview-2.mp4"]
    }
  ]));

  const specimen = viewModel.specimens[0];
  assert.equal(specimen.image, "https://fish.example/uploads/old-photo.jpg");
  assert.equal(specimen.fallbackImage, "https://fish.example/product-default.jpg");
  assert.equal(specimen.previewVideo, "https://fish.example/uploads/preview-2.mp4");
  assert.equal(specimen.hasVideoPreview, true);
  assert.equal(specimen.hasMaintenanceMedia, true);
  assert.equal(viewModel.productCards[0].image, "https://fish.example/product-default.jpg");
  assert.equal(viewModel.productCards[0].previewVideo, "");
  assert.equal(viewModel.productCards[0].hasVideoPreview, false);
  assert.equal(viewModel.speciesCards[0].image, specimen.image, "species card must prefer real specimen media");

  const videoOnly = buildViewModel(catalogFixture([{
    id: "video-only",
    stockItemId: "stock-189",
    date: "2026-08-18T10:00:00Z",
    videos: ["/uploads/original.mp4"],
    videoPosters: ["/uploads/generated-poster.jpg"],
    videoPreviews: ["/uploads/generated-preview.mp4"]
  }]));
  assert.equal(videoOnly.specimens[0].image, "https://fish.example/uploads/generated-poster.jpg");
  assert.equal(videoOnly.specimens[0].previewVideo, "https://fish.example/uploads/generated-preview.mp4");
});

test("preview without a poster falls back to the newest real photo and never to the original video", () => {
  const { buildViewModel } = loadCommonJs(catalogSource, {
    "./api": { getApiBaseUrl: () => "https://fish.example" }
  }, { Date, encodeURIComponent });
  const viewModel = buildViewModel(catalogFixture([
    {
      id: "old-photo",
      stockItemId: "stock-189",
      date: "2026-08-06T10:00:00Z",
      photos: ["/uploads/real-fish.jpg"]
    },
    {
      id: "latest-video",
      stockItemId: "stock-189",
      date: "2026-08-18T10:00:00Z",
      videos: ["/uploads/original-15mb.mp4"],
      videoPreviews: ["/uploads/preview-small.mp4"]
    }
  ]));

  assert.equal(viewModel.specimens[0].image, "https://fish.example/uploads/real-fish.jpg");
  assert.equal(viewModel.specimens[0].previewVideo, "https://fish.example/uploads/preview-small.mp4");

  const withoutGeneratedPreview = buildViewModel(catalogFixture([
    {
      id: "old-photo",
      stockItemId: "stock-189",
      date: "2026-08-06T10:00:00Z",
      photos: ["/uploads/real-fish.jpg"]
    },
    {
      id: "latest-video",
      stockItemId: "stock-189",
      date: "2026-08-18T10:00:00Z",
      videos: ["/uploads/original-15mb.mp4"]
    }
  ]));
  assert.equal(withoutGeneratedPreview.specimens[0].hasVideoPreview, false);
  assert.equal(withoutGeneratedPreview.specimens[0].previewVideo, "");
  assert.equal(withoutGeneratedPreview.specimens[0].image, "https://fish.example/uploads/real-fish.jpg");

  const posterOnly = buildViewModel(catalogFixture([
    {
      id: "latest-video",
      stockItemId: "stock-189",
      date: "2026-08-18T10:00:00Z",
      videos: ["/uploads/original-15mb.mp4"],
      videoPosters: ["/uploads/generated-poster.webp"]
    }
  ]));
  assert.equal(posterOnly.specimens[0].hasVideoPreview, false);
  assert.equal(posterOnly.specimens[0].image, "https://fish.example/uploads/generated-poster.webp");
});

test("card preview controller keeps one player, stops off-screen, and pauses on teardown", () => {
  const players = [];
  const observers = [];
  const wx = {
    createVideoContext(id) {
      const player = {
        id,
        playCount: 0,
        pauseCount: 0,
        play() { this.playCount += 1; },
        pause() { this.pauseCount += 1; }
      };
      players.push(player);
      return player;
    },
    showToast() {}
  };
  const {
    handleCardImageError,
    stopCardVideoPreview,
    toggleCardVideoPreview
  } = loadCommonJs(previewSource, {}, { wx });
  const page = {
    data: { activePreviewId: "" },
    setData(update, callback) {
      Object.assign(this.data, update);
      if (callback) callback();
    },
    createIntersectionObserver() {
      const observer = {
        disconnected: false,
        relativeToViewport() { return this; },
        observe(selector, callback) {
          this.selector = selector;
          this.callback = callback;
        },
        disconnect() { this.disconnected = true; }
      };
      observers.push(observer);
      return observer;
    }
  };

  toggleCardVideoPreview(page, { currentTarget: { dataset: { id: "one", preview: "/one.mp4" } } });
  assert.equal(page.data.activePreviewId, "one");
  assert.equal(players[0].id, "card-video-preview-player");
  assert.equal(players[0].playCount, 1);
  assert.equal(observers[0].selector, ".active-card-video");

  toggleCardVideoPreview(page, { currentTarget: { dataset: { id: "two", preview: "/two.mp4" } } });
  assert.equal(page.data.activePreviewId, "two");
  assert.equal(players[0].pauseCount, 1, "switching cards must pause the previous player");
  assert.equal(observers[0].disconnected, true);
  assert.equal(players[1].playCount, 1);

  observers[1].callback({ intersectionRatio: 0 });
  assert.equal(page.data.activePreviewId, "", "leaving the viewport must remove the video component");
  assert.equal(players[1].pauseCount, 1);

  stopCardVideoPreview(page, { clearData: false });

  page.data.products = [{
    id: "one",
    image: "/generated-poster.jpg",
    fallbackImage: "/real-photo.jpg"
  }];
  handleCardImageError(page, { currentTarget: { dataset: { id: "one" } } }, "products");
  assert.equal(page.data.products[0].image, "/real-photo.jpg");
  assert.equal(page.data.products[0].fallbackImage, "");
});

test("specimen cards create muted previews only after an explicit tap", () => {
  for (const template of [specimensTemplate]) {
    assert.match(template, /wx:if="\{\{activePreviewId === item\.id\}\}"[\s\S]*?<video|<video[\s\S]*?wx:if="\{\{activePreviewId === item\.id\}\}"/);
    assert.match(template, /src="\{\{item\.previewVideo\}\}"/);
    assert.match(template, /poster="\{\{item\.image\}\}"/);
    assert.match(template, /autoplay="\{\{true\}\}"/);
    assert.match(template, /muted="\{\{true\}\}"/);
    assert.match(template, /loop="\{\{true\}\}"/);
    assert.match(template, /controls="\{\{false\}\}"/);
    assert.match(template, /catchtap="onPreviewToggle"/);
    assert.match(template, /<video[\s\S]*?catchtap="on(?:Product|Specimen)Tap"/);
    assert.match(template, /<image[\s\S]*?binderror="onCardImageError"/);
    assert.match(template, /aria-label="\{\{activePreviewId === item\.id \? '暂停' : '播放'\}\}/);
    assert.doesNotMatch(template, /src="\{\{item\.videos?/);
  }

  for (const pageSource of [specimensPageSource]) {
    assert.match(pageSource, /onHide\(\)[\s\S]*?stopCardVideoPreview\(this\)/);
    assert.match(pageSource, /onUnload\(\)[\s\S]*?stopCardVideoPreview\(this, \{ clearData: false \}\)/);
    assert.match(pageSource, /onPreviewToggle\(event\)[\s\S]*?toggleCardVideoPreview\(this, event\)/);
    assert.match(pageSource, /onCardImageError\(event\)[\s\S]*?handleCardImageError\(this, event, "(?:products|specimens)"\)/);
  }

  assert.match(previewSource, /createIntersectionObserver/);
  assert.match(previewSource, /intersectionRatio/);
});

test("specimen preview buttons opt out of native full-width sizing", () => {
  for (const template of [specimensTemplate]) {
    const button = template.match(/<button\b[^>]*class="media-preview-toggle[^>]*>/)?.[0];
    assert.ok(button, "each card list must have a preview toggle");
    assert.match(button, /size="mini"/, "exclude the native default-size button rule");
  }

  const rule = appStyles.match(/\.media-preview-toggle\[size="mini"\]\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule, "scope dimensions above native button attribute selector specificity");
  for (const property of ["width", "height", "min-width", "min-height", "max-width", "max-height"]) {
    assert.match(rule, new RegExp(`(?:^|[;\\s])${property}:\\s*88rpx;`));
  }
  assert.match(rule, /margin:\s*0;/);
  assert.match(rule, /padding:\s*0;/);
  assert.match(rule, /border-radius:\s*50%;/);
});

test("product cards show only default images without a video player or play control", () => {
  assert.doesNotMatch(productsTemplate, /<video|onPreviewToggle|media-preview-toggle/);
  assert.doesNotMatch(productsPageSource, /toggleCardVideoPreview|activePreviewId/);
  assert.match(productsTemplate, /src="\{\{item.image\}\}"/);
  assert.match(productsTemplate, /binderror="onCardImageError"/);
});
