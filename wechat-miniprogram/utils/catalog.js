const { getApiBaseUrl } = require("./api");

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DEFAULT_MAJOR_CATEGORIES = [
  { key: "marineFish", label: "海水鱼", tone: "marine", unit: "条" },
  { key: "coral", label: "珊瑚", tone: "coral", unit: "件" },
  { key: "invertebrate", label: "无脊椎", tone: "invertebrate", unit: "只" },
  { key: "consumable", label: "耗材", tone: "consumable", unit: "件" }
];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return String(value || "").trim();
}

function number(value) {
  const next = Number(value || 0);
  return Number.isFinite(next) ? next : 0;
}

function unique(values) {
  const seen = {};
  return values.filter((value) => {
    const key = text(value);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function absoluteUrl(src) {
  const value = text(src);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/assets/")) return value;
  if (value.startsWith("/")) return `${getApiBaseUrl()}${value}`;
  return value;
}

function firstPhoto(record) {
  const photos = asArray(record && record.photos).map(absoluteUrl).filter(Boolean);
  return photos[0] || "";
}

function firstVideoPreview(record) {
  const previews = asArray(record && record.videoPreviews).map(absoluteUrl);
  const previewIndex = previews.findIndex(Boolean);
  const posters = asArray(record && record.videoPosters).map(absoluteUrl);
  const fallbackPoster = text(record && record.videoPoster);
  return {
    poster: previewIndex >= 0
      ? posters[previewIndex] || fallbackPoster
      : posters.find(Boolean) || fallbackPoster,
    preview: previewIndex >= 0 ? previews[previewIndex] : ""
  };
}

function compareMediaRecency(left, right) {
  const maintenanceDelta = Number(Boolean(right && right.hasMaintenanceMedia))
    - Number(Boolean(left && left.hasMaintenanceMedia));
  if (maintenanceDelta) return maintenanceDelta;
  return text(right && right.mediaDate).localeCompare(text(left && left.mediaDate));
}

function representativeSpecimen(specimens) {
  return asArray(specimens)
    .filter((item) => item && item.image)
    .slice()
    .sort(compareMediaRecency)[0] || null;
}

function stockLocation(stock) {
  const group = text(stock && stock.tankGroupName);
  const sub = text(stock && stock.subTankName);
  if (group && sub) return `${group} / ${sub}`;
  return group || sub || text(stock && stock.tankLocation) || "到店在缸";
}

function statusLabel(status) {
  if (status === "feeding") return "已开口";
  if (status === "sick") return "观察中";
  return "状态稳定";
}

function formatDate(value) {
  const raw = text(value);
  if (!raw) return "待确认";
  return raw.slice(0, 10);
}

function formatDateTime(value) {
  const raw = text(value);
  if (!raw) return "待确认";
  const normalized = raw.replace("T", " ");
  return normalized.length > 10 ? normalized.slice(0, 19) : normalized.slice(0, 10);
}

function daysSince(value) {
  const raw = text(value);
  if (!raw) return 0;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
}

function formatMoney(value) {
  const amount = number(value);
  if (!amount) return "价格待询";
  return `¥${Math.round(amount).toLocaleString("zh-CN")}`;
}

function utf8Bytes(value) {
  const encoded = encodeURIComponent(String(value || ""));
  const bytes = [];
  for (let index = 0; index < encoded.length; index += 1) {
    const char = encoded[index];
    if (char === "%") {
      bytes.push(parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0));
    }
  }
  return bytes;
}

function base64Url(value) {
  const bytes = utf8Bytes(value);
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const triple = (a << 16) | ((b || 0) << 8) | (c || 0);
    output += BASE64_CHARS[(triple >> 18) & 63];
    output += BASE64_CHARS[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_CHARS[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_CHARS[triple & 63] : "=";
  }
  return output.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function buildPublicSelectionCode(stockItemId) {
  const normalized = text(stockItemId);
  return normalized ? `MFISH-${base64Url(normalized)}` : "";
}

function normalizeCatalog(value) {
  const catalog = value || {};
  const categoryMajorMap = catalog.speciesCategoryMajorMap && typeof catalog.speciesCategoryMajorMap === "object"
    ? catalog.speciesCategoryMajorMap
    : {};
  return {
    majorCategories: asArray(catalog.majorCategories).map((item) => ({
      key: text(item && item.key),
      label: text(item && item.label)
    })).filter((item) => item.key),
    speciesCategories: asArray(catalog.speciesCategories).map(text).filter(Boolean),
    speciesCategoryMajorMap: Object.keys(categoryMajorMap).reduce((result, key) => {
      const category = text(key);
      const majorKey = text(categoryMajorMap[key]);
      if (category && majorKey) result[category] = majorKey;
      return result;
    }, {}),
    species: asArray(catalog.species).map((item) => ({
      id: text(item.id),
      name: text(item.name),
      scientificName: text(item.scientificName),
      category: text(item.category),
      commonNames: asArray(item.commonNames).map(text).filter(Boolean),
      description: text(item.description),
      imageUrl: absoluteUrl(item.imageUrl)
    })).filter((item) => item.id),
    products: asArray(catalog.products).map((item) => ({
      id: text(item.id),
      speciesId: text(item.speciesId),
      name: text(item.name),
      size: text(item.size),
      origin: text(item.origin),
      imageUrl: absoluteUrl(item.imageUrl),
      defaultPrice: number(item.defaultPrice)
    })).filter((item) => item.id && item.speciesId),
    stock: asArray(catalog.stock).map((item) => ({
      id: text(item.id),
      productId: text(item.productId),
      code: text(item.code),
      status: text(item.status),
      inDate: text(item.inDate),
      basePrice: number(item.basePrice),
      tankGroupName: text(item.tankGroupName),
      subTankName: text(item.subTankName),
      tankLocation: text(item.tankLocation)
    })).filter((item) => item.id && item.productId),
    bioRecords: asArray(catalog.bioRecords).map((item, index) => {
      const photos = asArray(item.photos).map(absoluteUrl).filter(Boolean);
      const videos = asArray(item.videos).map(absoluteUrl).filter(Boolean);
      const videoPosters = asArray(item.videoPosters).map(absoluteUrl);
      const videoPreviews = asArray(item.videoPreviews).map(absoluteUrl);
      const legacyPoster = absoluteUrl(item.posterUrl || item.poster || item.videoPoster);
      const legacyPreview = absoluteUrl(item.previewVideoUrl || item.previewVideo || item.previewUrl);
      return {
        id: text(item.id) || `fallback-${text(item.stockItemId)}-${index}`,
        stockItemId: text(item.stockItemId),
        date: text(item.date),
        text: text(item.text),
        sourceType: text(item.sourceType),
        tankGroupName: text(item.tankGroupName),
        subTankName: text(item.subTankName),
        tankLocation: text(item.tankLocation),
        operator: text(item.operator),
        photoCount: Math.max(number(item.photoCount), photos.length),
        videoCount: Math.max(number(item.videoCount), videos.length),
        photos,
        videos,
        videoPosters: videoPosters.length ? videoPosters : legacyPoster ? [legacyPoster] : [],
        videoPreviews: videoPreviews.length ? videoPreviews : legacyPreview ? [legacyPreview] : [],
        videoPoster: legacyPoster
      };
    }).filter((item) => item.stockItemId)
  };
}

function priceRange(values) {
  const prices = values.map(number).filter((value) => value > 0).sort((a, b) => a - b);
  if (!prices.length) return "价格待询";
  const min = prices[0];
  const max = prices[prices.length - 1];
  return min === max ? formatMoney(min) : `${formatMoney(min)}-${formatMoney(max)}`;
}

function inferMajorKey(category, categoryMajorMap) {
  const normalized = text(category);
  const mapped = text(categoryMajorMap && categoryMajorMap[normalized]);
  if (mapped) return mapped;
  if (/珊瑚/.test(normalized)) return "coral";
  if (/耗材/.test(normalized)) return "consumable";
  if (/虾|蟹|贝|螺|海星|无脊椎/.test(normalized)) return "invertebrate";
  return "marineFish";
}

function buildMajorDefinitions(normalized) {
  const providedByKey = {};
  normalized.majorCategories.forEach((item) => {
    providedByKey[item.key] = item;
  });
  return DEFAULT_MAJOR_CATEGORIES.map((item) => ({
    ...item,
    label: providedByKey[item.key] && providedByKey[item.key].label || item.label
  }));
}

function buildViewModel(catalog) {
  const normalized = normalizeCatalog(catalog);
  const majorDefinitions = buildMajorDefinitions(normalized);
  const majorByKey = {};
  const speciesById = {};
  const productsBySpecies = {};
  const stockByProduct = {};
  const latestBioByStock = {};
  const bioByStock = {};

  majorDefinitions.forEach((item) => {
    majorByKey[item.key] = item;
  });
  normalized.species.forEach((item) => {
    speciesById[item.id] = item;
  });
  normalized.products.forEach((item) => {
    if (!productsBySpecies[item.speciesId]) productsBySpecies[item.speciesId] = [];
    productsBySpecies[item.speciesId].push(item);
  });
  normalized.stock.forEach((item) => {
    if (!stockByProduct[item.productId]) stockByProduct[item.productId] = [];
    stockByProduct[item.productId].push(item);
  });
  normalized.bioRecords.forEach((record) => {
    if (!bioByStock[record.stockItemId]) bioByStock[record.stockItemId] = [];
    bioByStock[record.stockItemId].push(record);
    const current = latestBioByStock[record.stockItemId];
    if (!current || record.date > current.date) latestBioByStock[record.stockItemId] = record;
  });

  Object.keys(bioByStock).forEach((stockItemId) => {
    bioByStock[stockItemId].sort((left, right) => right.date.localeCompare(left.date));
  });

  const specimens = [];
  normalized.products.forEach((product) => {
    const species = speciesById[product.speciesId] || {};
    asArray(stockByProduct[product.id]).forEach((stock) => {
      const latestBio = latestBioByStock[stock.id];
      const records = asArray(bioByStock[stock.id]);
      const previewMedia = firstVideoPreview(latestBio);
      const latestPhotoRecord = records.find((record) => firstPhoto(record));
      const latestPhoto = firstPhoto(latestPhotoRecord);
      // Prefer a real maintenance photo for the idle card. Generated video
      // posters are only needed when the fish has never had a photo, which
      // avoids a cold-start transcode stampede on long lists.
      const maintenanceImage = latestPhoto || previewMedia.poster;
      const defaultImage = product.imageUrl || species.imageUrl || "";
      const image = maintenanceImage || product.imageUrl || species.imageUrl || "";
      const mediaDate = previewMedia.poster || previewMedia.preview
        ? text(latestBio && latestBio.date)
        : text(latestPhotoRecord && latestPhotoRecord.date);
      const stockPrice = number(stock.basePrice);
      const defaultPrice = number(product.defaultPrice);
      const price = stockPrice || defaultPrice || 0;
      const isSpecialPrice = stockPrice > 0 && defaultPrice > 0 && stockPrice < defaultPrice;
      specimens.push({
        id: stock.id,
        displayCode: stock.code || stock.id,
        selectionCode: buildPublicSelectionCode(stock.id),
        productId: product.id,
        speciesId: product.speciesId,
        speciesName: species.name || "未命名品种",
        scientificName: species.scientificName || "",
        subtitle: species.scientificName || product.origin || "来源待确认",
        category: species.category || "其他",
        productName: product.name || species.name || "未命名个体",
        size: product.size || "待确认",
        origin: product.origin || "来源待确认",
        image,
        fallbackImage: maintenanceImage && defaultImage !== image ? defaultImage : "",
        previewVideo: previewMedia.preview,
        hasVideoPreview: Boolean(previewMedia.preview),
        hasMaintenanceMedia: Boolean(maintenanceImage || previewMedia.preview),
        mediaDate,
        price,
        priceText: formatMoney(price),
        defaultPrice,
        defaultPriceText: formatMoney(defaultPrice),
        isSpecialPrice,
        status: stock.status || "healthy",
        statusText: statusLabel(stock.status),
        statusClass: stock.status === "feeding" ? "feeding" : stock.status === "sick" ? "sick" : "healthy",
        inDate: stock.inDate,
        arrivalDate: formatDate(stock.inDate),
        daysInStore: daysSince(stock.inDate),
        location: stockLocation(stock),
        latestBioText: latestBio ? latestBio.text : "暂无公开维护记录",
        latestBioDate: latestBio ? formatDate(latestBio.date) : "",
        hasPhoto: Boolean(image)
      });
    });
  });

  const productCards = normalized.products.map((product) => {
    const species = speciesById[product.speciesId] || {};
    const productSpecimens = specimens.filter((item) => item.productId === product.id);
    const featuredSpecimen = representativeSpecimen(productSpecimens);
    const prices = productSpecimens.map((item) => item.price).filter((value) => value > 0);
    const minPrice = prices.length ? Math.min(...prices) : product.defaultPrice;
    const category = species.category || "其他";
    const majorKey = inferMajorKey(category, normalized.speciesCategoryMajorMap);
    return {
      id: product.id,
      speciesId: product.speciesId,
      name: product.name || species.name || "未命名商品",
      speciesName: species.name || "未命名品种",
      scientificName: species.scientificName || "",
      category,
      majorKey,
      size: product.size || "待确认",
      origin: product.origin || "来源待确认",
      image: featuredSpecimen && featuredSpecimen.image || product.imageUrl || species.imageUrl || "",
      fallbackImage: featuredSpecimen && featuredSpecimen.fallbackImage || product.imageUrl || species.imageUrl || "",
      previewVideo: featuredSpecimen && featuredSpecimen.previewVideo || "",
      hasVideoPreview: Boolean(featuredSpecimen && featuredSpecimen.previewVideo),
      specimenCount: productSpecimens.length,
      price: minPrice,
      priceText: formatMoney(minPrice),
      priceNote: minPrice > 0 ? "起" : "",
      keywords: [
        product.name,
        product.size,
        product.origin,
        species.name,
        species.scientificName,
        species.category,
        ...asArray(species.commonNames)
      ].join(" ").toLowerCase()
    };
  }).filter((item) => item.specimenCount > 0);

  const categories = unique([
    ...normalized.speciesCategories,
    ...normalized.species.map((item) => item.category)
  ]).map((category) => {
    const categorySpecimens = specimens.filter((item) => item.category === category);
    const categoryProducts = productCards.filter((item) => item.category === category);
    const speciesIds = unique(categorySpecimens.map((item) => item.speciesId));
    const majorKey = inferMajorKey(category, normalized.speciesCategoryMajorMap);
    const major = majorByKey[majorKey] || DEFAULT_MAJOR_CATEGORIES[0];
    return {
      key: category,
      label: category,
      majorKey,
      tone: major.tone,
      unit: major.unit,
      speciesCount: speciesIds.length,
      productCount: categoryProducts.length,
      specimenCount: categorySpecimens.length
    };
  }).filter((item) => item.specimenCount > 0);

  const majorGroups = majorDefinitions.map((major) => {
    const minorCategories = categories.filter((item) => item.majorKey === major.key);
    const lastRowStart = Math.max(0, minorCategories.length - (minorCategories.length % 2 || 2));
    return {
      ...major,
      categories: minorCategories.map((item, index) => ({
        ...item,
        isLastRow: index >= lastRowStart
      })),
      categoryCount: minorCategories.length,
      productCount: minorCategories.reduce((total, item) => total + item.productCount, 0),
      specimenCount: minorCategories.reduce((total, item) => total + item.specimenCount, 0)
    };
  }).filter((item) => item.specimenCount > 0);

  const speciesCards = normalized.species.map((species) => {
    const speciesSpecimens = specimens.filter((item) => item.speciesId === species.id);
    const speciesProducts = asArray(productsBySpecies[species.id]);
    const featuredSpecimen = representativeSpecimen(speciesSpecimens);
    const commonNamesText = species.commonNames.join(" / ");
    return {
      id: species.id,
      name: species.name || "未命名品种",
      scientificName: species.scientificName,
      category: species.category || "其他",
      commonNamesText,
      subtitle: species.scientificName || commonNamesText || "公开品种",
      description: species.description,
      image: featuredSpecimen ? featuredSpecimen.image : species.imageUrl || "",
      fallbackImage: featuredSpecimen && featuredSpecimen.fallbackImage || species.imageUrl || "",
      previewVideo: featuredSpecimen && featuredSpecimen.previewVideo || "",
      hasVideoPreview: Boolean(featuredSpecimen && featuredSpecimen.previewVideo),
      specimenCount: speciesSpecimens.length,
      productCount: speciesProducts.length,
      priceRange: priceRange(speciesSpecimens.map((item) => item.price)),
      latestArrival: formatDate(speciesSpecimens.map((item) => item.inDate).sort().reverse()[0]),
      keywords: [
        species.name,
        species.scientificName,
        species.category,
        ...species.commonNames,
        ...speciesProducts.map((item) => item.name)
      ].join(" ").toLowerCase()
    };
  }).filter((item) => item.specimenCount > 0);

  return {
    catalog: normalized,
    majorGroups,
    categories,
    productCards,
    speciesCards,
    specimens,
    totalProducts: productCards.length,
    totalSpecies: speciesCards.length,
    totalSpecimens: specimens.length
  };
}

function filterSpecies(viewModel, categoryKey, keyword) {
  const query = text(keyword).toLowerCase();
  return viewModel.speciesCards.filter((item) => {
    const categoryMatched = !categoryKey || item.category === categoryKey;
    const keywordMatched = !query || item.keywords.indexOf(query) >= 0;
    return categoryMatched && keywordMatched;
  });
}

function filterProducts(viewModel, categoryKey, keyword) {
  const query = text(keyword).toLowerCase();
  return viewModel.productCards.filter((item) => {
    const categoryMatched = !categoryKey || item.category === categoryKey;
    const keywordMatched = !query || item.keywords.indexOf(query) >= 0;
    return categoryMatched && keywordMatched;
  });
}

function filterSpecimens(viewModel, selection, filterKey) {
  const criteria = selection && typeof selection === "object"
    ? selection
    : { speciesId: selection };
  const speciesId = text(criteria.speciesId);
  const productId = text(criteria.productId);
  return viewModel.specimens.filter((item) => {
    if (speciesId && item.speciesId !== speciesId) return false;
    if (productId && item.productId !== productId) return false;
    if (filterKey === "quarantined") return item.daysInStore >= 14;
    if (filterKey === "feeding") return item.status === "feeding";
    if (filterKey === "special") return item.isSpecialPrice;
    return true;
  });
}

function findProduct(viewModel, productId) {
  return viewModel.productCards.find((item) => item.id === productId) || null;
}

function findSpecimen(viewModel, stockItemId) {
  return viewModel.specimens.find((item) => item.id === stockItemId) || null;
}

function normalizeTimeline(records, specimen) {
  const events = [];
  if (specimen && specimen.inDate) {
    events.push({
      id: `${specimen.id}-stock-in`,
      date: specimen.inDate,
      dateText: formatDate(specimen.inDate),
      title: "入库",
      text: `${specimen.location} 建立库存记录`,
      photos: [],
      videos: []
    });
  }
  asArray(records).map((item, index) => {
    const photos = asArray(item.photos).map(absoluteUrl).filter(Boolean);
    const videos = asArray(item.videos).map(absoluteUrl).filter(Boolean);
    const photoCount = Math.max(number(item.photoCount), photos.length);
    const videoCount = Math.max(number(item.videoCount), videos.length);
    const mediaParts = [];
    if (photoCount) mediaParts.push(`${photoCount} 张照片`);
    if (videoCount) mediaParts.push(`${videoCount} 个视频`);
    const mediaSummary = mediaParts.join(" · ");
    const tankParts = unique([
      text(item.tankLocation),
      text(item.tankGroupName),
      text(item.subTankName)
    ]);
    const isDailyLog = item.sourceType === "dailyLog";
    return {
      id: text(item.id) || `fallback-${text(item.stockItemId) || text(specimen && specimen.id)}-${index}`,
      date: text(item.date),
      dateText: formatDateTime(item.date),
      title: isDailyLog ? "缸组养护" : "观察/治疗记录",
      text: text(item.text) || (mediaSummary ? `本次记录包含 ${mediaSummary}` : "本次记录未填写文字内容"),
      contextText: tankParts.length ? `${isDailyLog ? "养护缸位" : "记录缸位"}：${tankParts.join(" / ")}` : "",
      mediaSummary,
      mediaUnavailable: photoCount > photos.length || videoCount > videos.length,
      photos,
      videos,
      operator: text(item.operator)
    };
  }).sort((a, b) => a.date.localeCompare(b.date)).forEach((item) => events.push(item));
  return events;
}

module.exports = {
  buildPublicSelectionCode,
  buildViewModel,
  filterProducts,
  filterSpecies,
  filterSpecimens,
  findProduct,
  findSpecimen,
  formatDate,
  formatMoney,
  normalizeTimeline
};
