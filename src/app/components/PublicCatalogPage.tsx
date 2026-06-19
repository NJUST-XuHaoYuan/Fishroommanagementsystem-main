import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Camera, Check, ClipboardCheck, ClipboardList, Clock, Copy, Hash, MapPin, PackageCheck, Search } from "lucide-react";
import { initialState, Product, Species, StockItem, BioRecord } from "../store";
import { ImageWithFallback } from "./figma/ImageWithFallback";
import { buildPublicSelectionCode } from "../utils/publicSelectionCode";

type PublicCatalogData = {
  speciesCategories: string[];
  species: Species[];
  products: PublicProduct[];
  stock: PublicStockItem[];
  bioRecords: PublicBioRecord[];
};

type PublicProduct = Pick<Product, "id" | "speciesId" | "name" | "size" | "origin" | "imageUrl" | "defaultPrice">;

type PublicStockItem = Pick<StockItem, "id" | "productId" | "status" | "inDate"> &
  Partial<Pick<StockItem, "sold" | "lost" | "basePrice" | "code">> & {
    tankGroupName?: string;
    subTankName?: string;
    tankLocation?: string;
  };

type PublicBioRecord = Pick<BioRecord, "id" | "stockItemId" | "date" | "text"> &
  Partial<Pick<BioRecord, "photos" | "videos" | "sourceType" | "tankGroupName" | "subTankName" | "operator">>;

type PremiumCategoryKey =
  | "clownfish"
  | "tangs"
  | "angelfish"
  | "wrasses"
  | "gobies"
  | "butterflyfish"
  | "rare";

type PremiumCategory = {
  key: PremiumCategoryKey;
  label: string;
  description: string;
  image: string;
  match: string[];
};

type SpeciesCard = {
  species: Species;
  products: PublicProduct[];
  availableSpecimens: Specimen[];
  priceRange: string;
  latestArrival: string;
};

type CategorySummary = {
  key: string;
  label: string;
  description: string;
  image: string;
  species: number;
  specimens: number;
};

type SpecimenImageKind = "individual" | "product" | "reference";

type SpecimenImage = {
  src: string;
  kind: SpecimenImageKind;
  label: string;
  hasIndividualPhoto: boolean;
  hasRealPhoto: boolean;
};

type Specimen = {
  id: string;
  product: PublicProduct;
  species?: Species;
  stock?: PublicStockItem;
  bioRecord?: PublicBioRecord;
  image: string;
  imageKind: SpecimenImageKind;
  imageLabel: string;
  hasIndividualPhoto: boolean;
  hasRealPhoto: boolean;
  fallbackImage: string;
  price: number;
  size: string;
  daysInStore: number;
  statusLabel: string;
  locationLabel: string;
  arrivalDate: string;
  available: boolean;
};

type PublicBioTimelineEvent =
  | { type: "stock_in"; date: string }
  | { type: "record"; record: PublicBioRecord };

const fallbackCatalog: PublicCatalogData = {
  speciesCategories: initialState.speciesCategories,
  species: initialState.species,
  products: initialState.products,
  stock: initialState.stock.filter((item) => !item.sold && !item.lost && item.status !== "sick"),
  bioRecords: initialState.bioRecords,
};

const marinePhotos = {
  localFish: "/assets/catalog-line-fish.jpg",
  localCoral: "/assets/catalog-line-coral.jpg",
  clownfish: "https://upload.wikimedia.org/wikipedia/commons/f/f6/Clown_fish_in_the_Andaman_Coral_Reef.jpg",
  blueTang: "https://upload.wikimedia.org/wikipedia/commons/1/13/Paletten-Doktorfisch_M%C3%BCnster.JPG",
  yellowTang: "https://upload.wikimedia.org/wikipedia/commons/5/5e/Zebrasoma_flavescens_Luc_Viatour.jpg",
  angelfish: "https://upload.wikimedia.org/wikipedia/commons/2/29/Emperor_Angelfish%2C_Western_form_-_Pomacanthus_imperator_1.jpg",
  wrasse: "https://upload.wikimedia.org/wikipedia/commons/e/e1/Vieille_coquette_%28Labrus_mixtus%29_%28Ifremer_00563-67488_-_23544%29_%28cropped_2%29.jpg",
  goby: "https://upload.wikimedia.org/wikipedia/commons/5/53/Cryptocentrus_cinctus.JPG",
  butterflyfish: "https://upload.wikimedia.org/wikipedia/commons/9/9f/Raccoon_butterflyfish.jpg",
  rare: "https://upload.wikimedia.org/wikipedia/commons/d/dd/Pterois_sphex.jpg",
};

const heroCarouselImages = Array.from(
  { length: 14 },
  (_, index) => `/assets/hero-carousel/hero-${String(index + 1).padStart(2, "0")}.jpg`
);

const premiumCategories: PremiumCategory[] = [
  {
    key: "clownfish",
    label: "小丑鱼",
    description: "人工繁育和稳定开口个体，适合从容入门。",
    image: marinePhotos.clownfish,
    match: ["雀鲷", "小丑", "clown", "amphiprion"],
  },
  {
    key: "tangs",
    label: "倒吊",
    description: "开阔水域型鱼只，重点看体态、色泽和日常记录。",
    image: marinePhotos.blueTang,
    match: ["刺尾", "倒吊", "吊", "tang", "zebrasoma", "paracanthurus"],
  },
  {
    key: "angelfish",
    label: "神仙鱼",
    description: "轮廓强、存在感高，适合成熟系统和收藏型水族箱。",
    image: marinePhotos.angelfish,
    match: ["神仙", "angel"],
  },
  {
    key: "wrasses",
    label: "隆头鱼",
    description: "游姿活跃，按个体状态和混养脾气筛选。",
    image: marinePhotos.wrasse,
    match: ["隆头", "wrasse"],
  },
  {
    key: "gobies",
    label: "虾虎鱼",
    description: "体型小、辨识度高，适合精致海水系统。",
    image: marinePhotos.goby,
    match: ["虾虎", "goby"],
  },
  {
    key: "butterflyfish",
    label: "蝶鱼",
    description: "线条优雅，对饲养经验和缸体稳定性要求更高。",
    image: marinePhotos.butterflyfish,
    match: ["蝴蝶", "butterfly"],
  },
  {
    key: "rare",
    label: "珍稀个体",
    description: "少见到货和高辨识度个体，适合认真挑选。",
    image: marinePhotos.rare,
    match: ["海马", "狮子", "石斑", "rare", "collector"],
  },
];

const filterOptions = [
  { key: "all", label: "全部" },
  { key: "quarantined", label: "入缸14天+" },
  { key: "eating", label: "已开口" },
];

const normalizePublicBioRecords = (value: unknown): PublicBioRecord[] =>
  Array.isArray(value)
    ? value.map((record) => ({
        ...(record as PublicBioRecord),
        photos: Array.isArray((record as PublicBioRecord)?.photos)
          ? (record as PublicBioRecord).photos?.map(String).filter(Boolean)
          : [],
        videos: Array.isArray((record as PublicBioRecord)?.videos)
          ? (record as PublicBioRecord).videos?.map(String).filter(Boolean)
          : [],
      }))
    : [];

const normalizeCatalog = (value: Partial<PublicCatalogData> | null | undefined): PublicCatalogData => ({
  speciesCategories: Array.isArray(value?.speciesCategories) ? value.speciesCategories : fallbackCatalog.speciesCategories,
  species: Array.isArray(value?.species) ? value.species : fallbackCatalog.species,
  products: Array.isArray(value?.products) ? value.products : fallbackCatalog.products,
  stock: Array.isArray(value?.stock) ? value.stock : fallbackCatalog.stock,
  bioRecords: Array.isArray(value?.bioRecords) ? normalizePublicBioRecords(value.bioRecords) : fallbackCatalog.bioRecords,
});

function displayImageUrl(src?: string, width = 1400) {
  if (!src) return "";
  try {
    const url = new URL(src);
    if (url.hostname.includes("images.unsplash.com")) {
      url.searchParams.set("w", String(width));
      url.searchParams.set("auto", "format");
      url.searchParams.set("fit", "crop");
      return url.toString();
    }
  } catch {
    return src;
  }
  return src;
}

function isDemoImage(src?: string) {
  if (!src) return true;
  try {
    return new URL(src).hostname.includes("images.unsplash.com");
  } catch {
    return false;
  }
}

function originalImageUrl(src?: string) {
  const value = String(src ?? "").trim();
  if (!value) return "";
  try {
    const url = new URL(value, "https://public.local");
    return url.searchParams.get("url") ?? value;
  } catch {
    return value;
  }
}

function isReferenceCatalogImage(src?: string) {
  const value = originalImageUrl(src);
  if (!value) return true;
  if (value.startsWith("/assets/catalog-line-")) return true;
  try {
    const url = new URL(value, "https://public.local");
    const host = url.hostname;
    const path = url.pathname;
    return (
      host.includes("cdn.aquaml.com") ||
      host.includes("upload.wikimedia.org") ||
      host.includes("images.unsplash.com") ||
      path.includes("/fishroom/auto/") ||
      path.includes("/assets/catalog-line-")
    );
  } catch {
    return false;
  }
}

function buildSpecimenImage(src: string, kind: SpecimenImageKind, label: string): SpecimenImage {
  return {
    src: displayImageUrl(src, 1200),
    kind,
    label,
    hasIndividualPhoto: kind === "individual",
    hasRealPhoto: kind === "individual" || kind === "product",
  };
}

function speciesCategoryName(species?: Species) {
  return String(species?.category ?? "").trim() || "未分类";
}

function categoryFallbackImage(categoryName: string, species?: Species) {
  const haystack = [
    categoryName,
    species?.name,
    species?.scientificName,
    ...(Array.isArray(species?.commonNames) ? species.commonNames : []),
  ].join(" ").toLowerCase();
  if (haystack.includes("珊瑚") || haystack.includes("活石") || haystack.includes("虾") || haystack.includes("蟹")) {
    return marinePhotos.localCoral;
  }
  if (haystack.includes("耗材") || haystack.includes("活性炭")) {
    return marinePhotos.localCoral;
  }
  return marinePhotos.localFish;
}

function firstBioPhoto(record?: PublicBioRecord) {
  return (Array.isArray(record?.photos) ? record.photos : [])
    .map((src) => String(src ?? "").trim())
    .find(Boolean);
}

function categoryDescription(categoryName: string, counts: { species: number; specimens: number }) {
  if (categoryName.includes("珊瑚")) return "后台珊瑚分类中的公开可售项目。";
  if (categoryName.includes("耗材")) return "后台耗材分类中的公开可售项目。";
  if (categoryName.includes("活石")) return "后台活石分类中的公开可售项目。";
  if (categoryName.includes("虾") || categoryName.includes("蟹")) return "后台甲壳类分类中的公开可售个体。";
  return `${counts.species} 个物种，${counts.specimens} 条可售个体，数据来自管理系统。`;
}

function specimenImage(
  product: PublicProduct | undefined,
  species: Species | undefined,
  category: PremiumCategory,
  bioRecord?: PublicBioRecord
) {
  const individualImage = firstBioPhoto(bioRecord);
  if (individualImage) return buildSpecimenImage(individualImage, "individual", "个体实拍");

  const productImage = String(product?.imageUrl ?? "").trim();
  if (productImage && !isDemoImage(productImage) && !isReferenceCatalogImage(productImage)) {
    return buildSpecimenImage(productImage, "product", "商品图");
  }

  const managedImage = [product?.imageUrl, species?.imageUrl].find((src) => src && !isDemoImage(src));
  if (managedImage) return buildSpecimenImage(managedImage, "reference", "图库参考");

  const haystack = [
    product?.name,
    species?.name,
    species?.scientificName,
    ...(Array.isArray(species?.commonNames) ? species.commonNames : []),
  ].join(" ").toLowerCase();
  if (haystack.includes("黄金") || haystack.includes("yellow") || haystack.includes("flavescens")) {
    return buildSpecimenImage(marinePhotos.yellowTang, "reference", "图库参考");
  }
  if (haystack.includes("蓝倒吊") || haystack.includes("blue") || haystack.includes("hepatus")) {
    return buildSpecimenImage(marinePhotos.blueTang, "reference", "图库参考");
  }
  if (haystack.includes("小丑") || haystack.includes("clown") || haystack.includes("amphiprion")) {
    return buildSpecimenImage(marinePhotos.clownfish, "reference", "图库参考");
  }
  return buildSpecimenImage(category.image, "reference", "图库参考");
}

function formatMoney(value?: number) {
  return `¥${Math.max(0, Number(value ?? 0)).toLocaleString("zh-CN")}`;
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through to the textarea fallback for browsers that expose the API but deny it.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function formatDate(value?: string) {
  return value ? value.slice(0, 10) : "待确认";
}

function daysSince(value?: string) {
  if (!value) return 14;
  const start = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(start.getTime())) return 14;
  const diff = Date.now() - start.getTime();
  return Math.max(1, Math.floor(diff / 86_400_000));
}

function categoryForSpecies(species?: Species): PremiumCategory {
  if (!species) return premiumCategories[0];
  const haystack = [
    species.name,
    species.scientificName,
    species.category,
    ...(Array.isArray(species.commonNames) ? species.commonNames : []),
  ].join(" ").toLowerCase();
  return premiumCategories.find((category) =>
    category.match.some((token) => haystack.includes(token.toLowerCase()))
  ) ?? premiumCategories[6];
}

function productPrice(product?: PublicProduct, stock?: PublicStockItem) {
  return Math.max(0, Number(stock?.basePrice || product?.defaultPrice || 0));
}

function stockStatusLabel(status?: string) {
  if (status === "feeding") return "已开口";
  if (status === "sick") return "疾病";
  return "正常";
}

function stockStatusClass(status?: string) {
  if (status === "feeding") return "border-[oklch(0.72_0.105_82)] bg-[oklch(0.95_0.035_82)] text-[oklch(0.38_0.08_75)]";
  if (status === "sick") return "border-[oklch(0.74_0.12_20)] bg-[oklch(0.96_0.035_20)] text-[oklch(0.42_0.12_20)]";
  return "border-[oklch(0.68_0.075_190)] bg-[oklch(0.93_0.028_190)] text-[oklch(0.32_0.075_190)]";
}

function stockLocation(stock?: PublicStockItem) {
  const group = String(stock?.tankGroupName ?? "").trim();
  const subTank = String(stock?.subTankName ?? "").trim();
  if (group && subTank) return `${group} / ${subTank}`;
  if (group) return group;
  return String(stock?.tankLocation ?? "").trim() || "到店确认";
}

function normalizeBioRecordTime(value?: string) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00`;
  return trimmed.slice(0, 16);
}

function formatBioRecordTime(value?: string) {
  const normalized = normalizeBioRecordTime(value);
  if (!normalized) return "待确认";
  return normalized.includes("T") ? normalized.replace("T", " ") : normalized;
}

function isDailyLogRecord(record?: PublicBioRecord) {
  return String(record?.sourceType ?? "") === "dailyLog";
}

function availabilityForProduct(stock: PublicStockItem[], productId: string) {
  return stock.filter((item) => item.productId === productId && !item.sold && !item.lost && item.status !== "sick");
}

function priceRangeFromValues(values: number[]) {
  const prices = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (prices.length === 0) return "到店确认";
  if (prices[0] === prices[prices.length - 1]) return formatMoney(prices[0]);
  return `${formatMoney(prices[0])} - ${formatMoney(prices[prices.length - 1])}`;
}

function priceRange(products: PublicProduct[]) {
  return priceRangeFromValues(products.map((product) => productPrice(product)));
}

function specimenId(stock: PublicStockItem | undefined, product: PublicProduct, index: number) {
  const code = String(stock?.code ?? "").trim();
  if (code) return code;
  const source = String(stock?.id ?? product.id ?? `fish-${index + 1}`).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return `MF-${source.padStart(4, "0").slice(0, 6)}`;
}

function firstBioRecord(records: PublicBioRecord[], stockId?: string) {
  return records
    .filter((record) => record.stockItemId === stockId)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
}

export function PublicCatalogPage() {
  const [catalog, setCatalog] = useState<PublicCatalogData>(fallbackCatalog);
  const [detailBioRecordsByStockId, setDetailBioRecordsByStockId] = useState<Map<string, PublicBioRecord[]>>(() => new Map());
  const [detailLoadingStockId, setDetailLoadingStockId] = useState("");
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [heroImageIndex, setHeroImageIndex] = useState(0);
  const [selectedCategoryKey, setSelectedCategoryKey] = useState("");
  const [selectedSpeciesId, setSelectedSpeciesId] = useState("");
  const [selectedSpecimenId, setSelectedSpecimenId] = useState("");
  const [copiedSelectionCode, setCopiedSelectionCode] = useState(false);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/public/catalog", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return normalizeCatalog(result.catalog ?? result.data ?? result);
      })
      .then((nextCatalog) => {
        if (cancelled) return;
        setCatalog(nextCatalog);
        setCatalogLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setCatalog(fallbackCatalog);
        setCatalogLoaded(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (heroCarouselImages.length < 2) return;
    const interval = window.setInterval(() => {
      setHeroImageIndex((index) => (index + 1) % heroCarouselImages.length);
    }, 5500);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (heroCarouselImages.length < 2) return;
    const nextSrc = heroCarouselImages[(heroImageIndex + 1) % heroCarouselImages.length];
    const preload = new window.Image();
    preload.src = nextSrc;
  }, [heroImageIndex]);

  const productBySpecies = useMemo(() => {
    const map = new Map<string, PublicProduct[]>();
    catalog.products.forEach((product) => {
      const current = map.get(product.speciesId) ?? [];
      current.push(product);
      map.set(product.speciesId, current);
    });
    return map;
  }, [catalog.products]);

  const bioRecordsByStockId = useMemo(() => {
    const map = new Map<string, PublicBioRecord[]>();
    catalog.bioRecords.forEach((record) => {
      const stockItemId = String(record.stockItemId ?? "").trim();
      if (!stockItemId) return;
      const current = map.get(stockItemId) ?? [];
      current.push(record);
      map.set(stockItemId, current);
    });
    map.forEach((records) => {
      records.sort((a, b) =>
        String(b.date ?? "").localeCompare(String(a.date ?? "")) ||
        String(a.id ?? "").localeCompare(String(b.id ?? ""))
      );
    });
    return map;
  }, [catalog.bioRecords]);

  const bioRecordByStockId = useMemo(() => {
    const map = new Map<string, PublicBioRecord>();
    bioRecordsByStockId.forEach((records, stockItemId) => {
      if (records[0]) map.set(stockItemId, records[0]);
    });
    return map;
  }, [bioRecordsByStockId]);

  const bioMediaRecordByStockId = useMemo(() => {
    const map = new Map<string, PublicBioRecord>();
    bioRecordsByStockId.forEach((records, stockItemId) => {
      const mediaRecord = records.find((record) => firstBioPhoto(record));
      if (mediaRecord) map.set(stockItemId, mediaRecord);
    });
    return map;
  }, [bioRecordsByStockId]);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, { species: number; specimens: number; sample?: Species }>();
    catalog.species.forEach((species) => {
      const categoryName = speciesCategoryName(species);
      const products = productBySpecies.get(species.id) ?? [];
      const specimenCount = products.reduce((sum, product) => sum + availabilityForProduct(catalog.stock, product.id).length, 0);
      const current = counts.get(categoryName) ?? { species: 0, specimens: 0, sample: species };
      counts.set(categoryName, {
        species: products.length > 0 ? current.species + 1 : current.species,
        specimens: current.specimens + specimenCount,
        sample: current.sample ?? species,
      });
    });
    return counts;
  }, [catalog.species, catalog.stock, productBySpecies]);

  const specimens = useMemo<Specimen[]>(() => {
    const speciesById = new Map(catalog.species.map((species) => [species.id, species]));
    const all: Specimen[] = [];
    catalog.products.forEach((product, productIndex) => {
      const species = speciesById.get(product.speciesId);
      const category = categoryForSpecies(species);
      const fallbackImage = displayImageUrl(categoryFallbackImage(speciesCategoryName(species), species), 1200);
      const availableStock = availabilityForProduct(catalog.stock, product.id);
      const stockItems = availableStock.length > 0
        ? [...availableStock].sort((a, b) =>
            String(b.inDate ?? "").localeCompare(String(a.inDate ?? "")) ||
            String(a.id ?? "").localeCompare(String(b.id ?? ""))
          )
        : [undefined];
      stockItems.forEach((stock, stockIndex) => {
        const daysInStore = daysSince(stock?.inDate);
        const bioRecord = stock?.id ? bioRecordByStockId.get(stock.id) : undefined;
        const bioMediaRecord = stock?.id ? bioMediaRecordByStockId.get(stock.id) : undefined;
        const photo = specimenImage(product, species, category, bioMediaRecord ?? bioRecord);
        all.push({
          id: specimenId(stock, product, productIndex + stockIndex),
          product,
          species,
          stock,
          bioRecord,
          image: photo.src,
          imageKind: photo.kind,
          imageLabel: photo.label,
          hasIndividualPhoto: photo.hasIndividualPhoto,
          hasRealPhoto: photo.hasRealPhoto,
          fallbackImage,
          price: productPrice(product, stock),
          size: product.size || "待确认",
          daysInStore,
          statusLabel: stockStatusLabel(stock?.status),
          locationLabel: stockLocation(stock),
          arrivalDate: formatDate(stock?.inDate),
          available: Boolean(stock),
        });
      });
    });
    return all;
  }, [bioMediaRecordByStockId, bioRecordByStockId, catalog.products, catalog.species, catalog.stock]);

  const speciesCards = useMemo<SpeciesCard[]>(() => {
    return catalog.species
      .map((species) => {
        const products = productBySpecies.get(species.id) ?? [];
        const speciesSpecimens = specimens.filter((specimen) => specimen.species?.id === species.id && specimen.available);
        const latestArrival = speciesSpecimens
          .map((specimen) => specimen.stock?.inDate ?? "")
          .filter(Boolean)
          .sort((a, b) => String(b).localeCompare(String(a)))[0];
        return {
          species,
          products,
          availableSpecimens: speciesSpecimens,
          priceRange: priceRangeFromValues(
            speciesSpecimens.length > 0 ? speciesSpecimens.map((specimen) => specimen.price) : products.map((product) => productPrice(product))
          ),
          latestArrival: formatDate(latestArrival),
        };
      })
      .filter((card) => card.products.length > 0);
  }, [catalog.species, productBySpecies, specimens]);

  const catalogCategories = useMemo<CategorySummary[]>(() => {
    const orderedNames = catalog.speciesCategories
      .map((item) => String(item ?? "").trim())
      .filter(Boolean);
    const extraNames = [...categoryCounts.keys()]
      .filter((name) => !orderedNames.includes(name))
      .sort((a, b) => a.localeCompare(b, "zh-CN"));
    return [...orderedNames, ...extraNames]
      .filter((name, index, list) => list.indexOf(name) === index)
      .filter((name) => (categoryCounts.get(name)?.specimens ?? 0) > 0)
      .map((name) => {
        const counts = categoryCounts.get(name) ?? { species: 0, specimens: 0 };
        const representative = specimens.find((specimen) => speciesCategoryName(specimen.species) === name);
        return {
          key: name,
          label: name,
          description: categoryDescription(name, counts),
          image: representative?.image ?? categoryFallbackImage(name, counts.sample),
          species: counts.species,
          specimens: counts.specimens,
        };
      });
  }, [catalog.speciesCategories, categoryCounts, specimens]);

  const selectedCategory =
    catalogCategories.find((category) => category.key === selectedCategoryKey) ??
    catalogCategories[0] ??
    {
      key: "",
      label: "后台分类",
      description: "管理系统中暂时没有公开可售分类。",
      image: marinePhotos.localFish,
      species: 0,
      specimens: 0,
    };
  const visibleSpecies = speciesCards.filter(
    (card) => speciesCategoryName(card.species) === selectedCategory.key && card.availableSpecimens.length > 0
  );

  useEffect(() => {
    if (catalogCategories.some((category) => category.key === selectedCategoryKey)) return;
    setSelectedCategoryKey(catalogCategories[0]?.key ?? "");
  }, [catalogCategories, selectedCategoryKey]);

  useEffect(() => {
    if (visibleSpecies.some((card) => card.species.id === selectedSpeciesId)) return;
    setSelectedSpeciesId(visibleSpecies[0]?.species.id ?? "");
  }, [selectedSpeciesId, visibleSpecies]);

  const selectedSpecies = visibleSpecies.find((card) => card.species.id === selectedSpeciesId) ?? visibleSpecies[0];
  const specimenOptions = specimens.filter((specimen) => specimen.species?.id === selectedSpecies?.species.id && specimen.available);
  const filteredSpecimens = specimenOptions.filter((specimen) => {
    if (filter === "all") return true;
    if (filter === "quarantined") return specimen.daysInStore >= 14;
    if (filter === "eating") return specimen.stock?.status === "feeding";
    return true;
  });

  useEffect(() => {
    const source = filteredSpecimens.length > 0 ? filteredSpecimens : specimenOptions;
    if (source.some((specimen) => specimen.id === selectedSpecimenId)) return;
    setSelectedSpecimenId(source[0]?.id ?? "");
  }, [filteredSpecimens, selectedSpecimenId, specimenOptions]);

  const selectedSpecimen =
    specimens.find((specimen) => specimen.id === selectedSpecimenId) ??
    filteredSpecimens[0];

  const selectedStockId = selectedSpecimen?.stock?.id ?? "";
  const selectedSelectionCode = buildPublicSelectionCode(selectedStockId);

  useEffect(() => {
    setCopiedSelectionCode(false);
  }, [selectedSelectionCode]);

  const copySelectedSelectionCode = async () => {
    if (!selectedSelectionCode) return;
    try {
      await copyText(selectedSelectionCode);
      setCopiedSelectionCode(true);
    } catch {
      setCopiedSelectionCode(false);
    }
  };

  useEffect(() => {
    if (!catalogLoaded || !selectedStockId || detailBioRecordsByStockId.has(selectedStockId)) return;
    let cancelled = false;
    setDetailLoadingStockId(selectedStockId);
    fetch(`/api/public/bio-records?stockItemId=${encodeURIComponent(selectedStockId)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return normalizePublicBioRecords(result.bioRecords ?? result.data ?? []);
      })
      .then((records) => {
        if (cancelled) return;
        setDetailBioRecordsByStockId((current) => {
          const next = new Map(current);
          next.set(selectedStockId, records);
          return next;
        });
      })
      .catch(() => {
        if (cancelled) return;
        setDetailBioRecordsByStockId((current) => {
          const next = new Map(current);
          next.set(selectedStockId, bioRecordsByStockId.get(selectedStockId) ?? []);
          return next;
        });
      })
      .finally(() => {
        if (!cancelled) setDetailLoadingStockId("");
      });
    return () => {
      cancelled = true;
    };
  }, [bioRecordsByStockId, catalogLoaded, detailBioRecordsByStockId, selectedStockId]);

  const selectedBioRecords = selectedStockId
    ? detailBioRecordsByStockId.get(selectedStockId) ?? bioRecordsByStockId.get(selectedStockId) ?? []
    : [];
  const selectedDetailImage = useMemo<SpecimenImage | undefined>(() => {
    if (!selectedSpecimen) return undefined;
    const detailMediaRecord = selectedBioRecords.find((record) => firstBioPhoto(record));
    return detailMediaRecord
      ? specimenImage(selectedSpecimen.product, selectedSpecimen.species, categoryForSpecies(selectedSpecimen.species), detailMediaRecord)
      : undefined;
  }, [selectedBioRecords, selectedSpecimen]);
  const selectedTimeline = useMemo<PublicBioTimelineEvent[]>(() => {
    if (!selectedSpecimen?.stock) return [];
    return [
      { type: "stock_in", date: selectedSpecimen.stock.inDate },
      ...selectedBioRecords
        .slice()
        .sort((a, b) =>
          String(a.date ?? "").localeCompare(String(b.date ?? "")) ||
          String(a.id ?? "").localeCompare(String(b.id ?? ""))
        )
        .map((record) => ({ type: "record" as const, record })),
    ];
  }, [selectedBioRecords, selectedSpecimen]);
  const selectedBio = firstBioRecord(selectedBioRecords, selectedStockId) ?? selectedSpecimen?.bioRecord;

  const scrollToCatalog = () => {
    document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <main className="min-h-[100dvh] bg-[#03101f] text-[#f4f8fb]">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#03101f]/86 backdrop-blur-xl">
        <div className="flex h-20 w-full items-center justify-start px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <div className="grid size-16 place-items-center rounded-2xl border border-cyan-300/25 bg-white/8 shadow-[0_16px_42px_rgba(30,230,239,0.08)]">
              <img src="/assets/brand-logo.jpg" alt="海水鱼廊" className="size-14 rounded-xl object-contain" />
            </div>
            <div className="text-lg font-semibold tracking-normal text-white">海水生物超市</div>
          </div>
        </div>
      </header>

      <section className="relative min-h-[calc(100dvh-5rem)] overflow-hidden">
        {heroCarouselImages.map((src, index) => (
          <ImageWithFallback
            key={src}
            src={src}
            fallbackSrc={marinePhotos.localFish}
            alt="海水鱼廊图册照片"
            disableMediaProxy
            className={`absolute inset-0 h-full w-full object-cover transition-[opacity,transform] duration-[1200ms] ease-out motion-reduce:transition-none ${
              index === heroImageIndex ? "scale-100 opacity-70" : "scale-[1.025] opacity-0"
            }`}
            loading={index === heroImageIndex ? "eager" : "lazy"}
          />
        ))}
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_74%_42%,rgba(16,211,222,0.18),transparent_28%),linear-gradient(90deg,rgba(3,16,31,0.98)_0%,rgba(3,16,31,0.76)_42%,rgba(3,16,31,0.18)_100%)]" />
        <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 gap-1.5" aria-hidden="true">
          {heroCarouselImages.map((_, index) => (
            <span
              key={index}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                index === heroImageIndex ? "w-6 bg-[#1ee6ef]" : "w-1.5 bg-white/38"
              }`}
            />
          ))}
        </div>
        <div className="relative mx-auto flex min-h-[calc(100dvh-5rem)] max-w-7xl items-center px-4 py-14 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <h1 className="max-w-[18ch] text-5xl font-semibold leading-[1.04] tracking-normal text-white sm:text-6xl lg:text-7xl">
              <span className="block">按真实库存</span>
              <span className="block">挑选海水生物</span>
            </h1>
            <p className="mt-6 max-w-[34rem] text-xl leading-8 text-[#d4e2ea] sm:text-2xl sm:leading-9">
              每一条鱼都可查看养护及检疫记录
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={scrollToCatalog}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#1ee6ef] px-6 text-sm font-semibold text-[#03101f] shadow-[0_18px_44px_rgba(30,230,239,0.18)] transition hover:bg-[#75f5f8] active:translate-y-px"
              >
                开始选鱼
                <ArrowRight className="size-4" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section id="catalog" className="scroll-mt-20 bg-[oklch(0.965_0.006_215)] py-12 text-[oklch(0.22_0.018_230)] sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="border-b border-[oklch(0.84_0.01_220)] pb-7">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <div className="text-sm font-medium text-[oklch(0.42_0.018_225)]">公开库存选择</div>
                <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-normal text-[oklch(0.18_0.018_230)] sm:text-4xl">
                  先看品种，再挑具体个体
                </h2>
                <p className="mt-4 max-w-[42rem] text-sm leading-7 text-[oklch(0.42_0.014_225)]">
                  分类、品种、个体和养护记录来自管理系统。选中某一条后，右侧直接生成可复制给客服的选鱼码。
                </p>
              </div>
              <div className="grid grid-cols-3 overflow-hidden rounded-2xl border border-[oklch(0.84_0.01_220)] bg-white text-sm shadow-[0_18px_45px_rgba(22,34,40,0.06)]">
                <div className="border-r border-[oklch(0.88_0.008_220)] px-4 py-3">
                  <div className="text-[0.7rem] text-[oklch(0.52_0.012_225)]">大类</div>
                  <div className="mt-1 font-semibold text-[oklch(0.2_0.018_230)]">{catalogCategories.length}</div>
                </div>
                <div className="border-r border-[oklch(0.88_0.008_220)] px-4 py-3">
                  <div className="text-[0.7rem] text-[oklch(0.52_0.012_225)]">品种</div>
                  <div className="mt-1 font-semibold text-[oklch(0.2_0.018_230)]">{visibleSpecies.length}</div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[0.7rem] text-[oklch(0.52_0.012_225)]">当前个体</div>
                  <div className="mt-1 font-semibold text-[oklch(0.2_0.018_230)]">{filteredSpecimens.length}</div>
                </div>
              </div>
            </div>
          </div>

          <div className="mt-8 grid items-start gap-7 lg:grid-cols-[13.5rem_minmax(0,1fr)] xl:grid-cols-[13.5rem_minmax(0,1fr)_25rem]">
            <aside className="rounded-2xl border border-[oklch(0.84_0.01_220)] bg-white p-3 shadow-[0_18px_45px_rgba(22,34,40,0.05)] lg:sticky lg:top-24 lg:self-start">
              <div className="flex items-center gap-2 rounded-xl bg-[oklch(0.955_0.006_215)] px-3 py-2.5 text-sm font-medium text-[oklch(0.36_0.016_225)]">
                <Search className="size-4 text-[oklch(0.48_0.075_190)]" />
                大类筛选
              </div>
              <div className="mt-3 grid max-h-[calc(100dvh-10rem)] gap-1.5 overflow-y-auto pr-1">
                {catalogCategories.map((category) => {
                  const active = selectedCategoryKey === category.key;
                  return (
                    <button
                      key={category.key}
                      type="button"
                      onClick={() => setSelectedCategoryKey(category.key)}
                      className={`rounded-xl px-3 py-2.5 text-left transition active:translate-y-px ${
                        active
                          ? "bg-[oklch(0.22_0.018_230)] text-white shadow-[0_10px_24px_rgba(22,34,40,0.16)]"
                          : "text-[oklch(0.34_0.016_225)] hover:bg-[oklch(0.955_0.006_215)]"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold">{category.label}</span>
                        {active && <Check className="size-3.5 shrink-0 text-[oklch(0.78_0.105_190)]" />}
                      </div>
                      <div className={`mt-1 text-xs ${active ? "text-white/68" : "text-[oklch(0.54_0.012_225)]"}`}>
                        {category.specimens} 条在售
                      </div>
                    </button>
                  );
                })}
              </div>
            </aside>

            <section className="min-w-0 space-y-6">
              <div className="overflow-hidden rounded-3xl border border-[oklch(0.84_0.01_220)] bg-white shadow-[0_24px_70px_rgba(22,34,40,0.06)]">
                <div className="grid gap-0 lg:grid-cols-[10rem_minmax(0,1fr)]">
                  <div className="relative hidden min-h-40 overflow-hidden bg-[oklch(0.91_0.008_215)] lg:block">
                    <ImageWithFallback
                      src={displayImageUrl(selectedCategory.image, 900)}
                      fallbackSrc={marinePhotos.localFish}
                      alt={selectedCategory.label}
                      disableMediaProxy
                      className="h-full w-full object-cover"
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
                  </div>
                  <div className="p-5 sm:p-6">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-[oklch(0.48_0.075_190)]">当前大类</div>
                        <h3 className="mt-2 text-2xl font-semibold text-[oklch(0.18_0.018_230)]">{selectedCategory.label}</h3>
                        <p className="mt-2 max-w-[42rem] text-sm leading-6 text-[oklch(0.42_0.014_225)]">{selectedCategory.description}</p>
                      </div>
                      <div className="rounded-full border border-[oklch(0.84_0.01_220)] px-3 py-1.5 text-xs font-semibold text-[oklch(0.34_0.016_225)]">
                        {visibleSpecies.length} 个品种
                      </div>
                    </div>
                    {visibleSpecies.length === 0 ? (
                      <div className="mt-5 rounded-2xl border border-dashed border-[oklch(0.78_0.012_220)] bg-[oklch(0.97_0.004_215)] p-5 text-sm text-[oklch(0.42_0.014_225)]">
                        这个大类暂时没有公开在售品种。
                      </div>
                    ) : (
                      <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
                        {visibleSpecies.map((card) => {
                          const active = selectedSpecies?.species.id === card.species.id;
                          return (
                            <button
                              key={card.species.id}
                              type="button"
                              onClick={() => setSelectedSpeciesId(card.species.id)}
                              className={`min-w-[12rem] rounded-2xl border px-3.5 py-3 text-left transition active:translate-y-px ${
                                active
                                  ? "border-[oklch(0.48_0.075_190)] bg-[oklch(0.93_0.028_190)] text-[oklch(0.2_0.018_230)]"
                                  : "border-[oklch(0.86_0.009_220)] bg-[oklch(0.985_0.002_220)] text-[oklch(0.34_0.016_225)] hover:border-[oklch(0.64_0.035_195)] hover:bg-white"
                              }`}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="truncate text-sm font-semibold">{card.species.name}</div>
                                  {card.species.scientificName && (
                                    <div className="mt-0.5 truncate text-xs italic text-[oklch(0.5_0.014_225)]">{card.species.scientificName}</div>
                                  )}
                                </div>
                                {active && <Check className="size-4 shrink-0 text-[oklch(0.42_0.075_190)]" />}
                              </div>
                              <div className="mt-2 text-xs text-[oklch(0.48_0.014_225)]">{card.availableSpecimens.length} 条个体 · {card.priceRange}</div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="rounded-3xl border border-[oklch(0.84_0.01_220)] bg-white p-4 shadow-[0_24px_70px_rgba(22,34,40,0.06)] sm:p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-[oklch(0.48_0.075_190)]">当前品种</div>
                    <h3 className="mt-2 text-2xl font-semibold text-[oklch(0.18_0.018_230)]">{selectedSpecies?.species.name ?? "选择品种"}</h3>
                    {selectedSpecies?.species.scientificName && (
                      <p className="mt-1 text-sm italic text-[oklch(0.48_0.014_225)]">{selectedSpecies.species.scientificName}</p>
                    )}
                    <p className="mt-3 max-w-[42rem] text-sm leading-6 text-[oklch(0.42_0.014_225)]">
                      {selectedSpecies
                        ? `${selectedSpecies.availableSpecimens.length} 条真实库存个体，最近到货 ${selectedSpecies.latestArrival}。`
                        : "先选择一个品种，再查看具体库存个体。"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-2 xl:items-end">
                    {selectedSpecies && (
                      <div className="rounded-full bg-[oklch(0.24_0.018_230)] px-4 py-2 text-sm font-semibold text-white">
                        {selectedSpecies.priceRange}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2 xl:justify-end">
                      {filterOptions.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => setFilter(item.key)}
                          className={`h-9 rounded-full border px-4 text-xs font-semibold transition active:translate-y-px ${
                            filter === item.key
                              ? "border-[oklch(0.48_0.075_190)] bg-[oklch(0.48_0.075_190)] text-white"
                              : "border-[oklch(0.84_0.01_220)] bg-white text-[oklch(0.38_0.016_225)] hover:border-[oklch(0.64_0.035_195)]"
                          }`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {filteredSpecimens.length === 0 ? (
                  <EmptyState text="当前筛选下没有可展示个体。" />
                ) : (
                  <div className="mt-5 grid gap-4 md:grid-cols-2">
                    {filteredSpecimens.map((specimen) => {
                      const active = specimen.id === selectedSpecimen?.id;
                      return (
                        <button
                          key={specimen.id}
                          type="button"
                          onClick={() => setSelectedSpecimenId(specimen.id)}
                          className={`overflow-hidden rounded-2xl border text-left transition hover:-translate-y-0.5 active:translate-y-px ${
                            active
                              ? "border-[oklch(0.48_0.075_190)] bg-white shadow-[0_18px_42px_rgba(41,117,116,0.16)]"
                              : "border-[oklch(0.86_0.009_220)] bg-[oklch(0.99_0.002_220)] hover:border-[oklch(0.64_0.035_195)]"
                          }`}
                        >
                          <SpecimenImageFrame
                            src={specimen.image}
                            fallbackSrc={specimen.fallbackImage}
                            alt={`${specimen.id} ${specimen.product.name}`}
                            label={specimen.imageLabel}
                            hasIndividualPhoto={specimen.hasIndividualPhoto}
                            className="aspect-[1.32/1]"
                            imageClassName="transition duration-300 hover:scale-[1.025]"
                          />
                          <div className="p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-xs font-semibold text-[oklch(0.45_0.075_190)]">{specimen.id}</div>
                                <h4 className="mt-1 truncate text-lg font-semibold text-[oklch(0.18_0.018_230)]">{specimen.product.name}</h4>
                              </div>
                              <div className="shrink-0 text-lg font-semibold text-[oklch(0.27_0.018_230)]">{formatMoney(specimen.price)}</div>
                            </div>
                            <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                              <SpecLine label="尺寸" value={specimen.size} />
                              <SpecLine label="状态" value={specimen.statusLabel} />
                              <SpecLine label="入库" value={specimen.arrivalDate} />
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

            <SpecimenDetailPanel
              specimen={selectedSpecimen}
              detailImage={selectedDetailImage}
              timeline={selectedTimeline}
              latestBio={selectedBio}
              loading={detailLoadingStockId === selectedStockId}
              selectionCode={selectedSelectionCode}
              copied={copiedSelectionCode}
              onCopy={copySelectedSelectionCode}
            />
          </div>
        </div>
      </section>

      <footer className="border-t border-[oklch(0.84_0.01_220)] bg-[oklch(0.965_0.006_215)] py-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 text-sm text-[oklch(0.45_0.014_225)] sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>海水鱼廊 / 每一条在售个体以后台库存为准</div>
        </div>
      </footer>
    </main>
  );
}

function SpecLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[oklch(0.52_0.012_225)]">{label}</div>
      <div className="mt-1 break-words font-semibold text-[oklch(0.22_0.018_230)]">{value}</div>
    </div>
  );
}

function SpecimenImageFrame({
  src,
  fallbackSrc,
  alt,
  label,
  hasIndividualPhoto,
  className = "",
  imageClassName = "",
}: {
  src: string;
  fallbackSrc: string;
  alt: string;
  label: string;
  hasIndividualPhoto: boolean;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div className={`relative overflow-hidden bg-[oklch(0.91_0.008_215)] ${className}`}>
      <ImageWithFallback
        src={src}
        fallbackSrc={fallbackSrc}
        fallbackAlt="图库参考图"
        alt={alt}
        disableMediaProxy
        className={`h-full w-full object-cover ${hasIndividualPhoto ? "" : "opacity-[0.72] saturate-[0.72] grayscale-[0.12]"} ${imageClassName}`}
      />
      <div
        className={`absolute left-3 top-3 rounded-full border px-2.5 py-1 text-[0.68rem] font-semibold shadow-[0_10px_24px_rgba(22,34,40,0.12)] ${
          hasIndividualPhoto
            ? "border-[oklch(0.68_0.075_190)] bg-white/90 text-[oklch(0.32_0.075_190)]"
            : "border-[oklch(0.82_0.03_85)] bg-white/90 text-[oklch(0.38_0.07_78)]"
        }`}
      >
        {label}
      </div>
      {!hasIndividualPhoto && (
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-white/92 via-white/66 to-transparent px-3 pb-3 pt-10">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-[oklch(0.84_0.01_220)] bg-white/90 px-2.5 py-1 text-[0.68rem] font-semibold text-[oklch(0.34_0.016_225)]">
            <Camera className="size-3" />
            暂无个体实拍
          </div>
        </div>
      )}
    </div>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[oklch(0.86_0.009_220)] bg-[oklch(0.985_0.002_220)] p-3">
      <div className="text-xs text-[oklch(0.52_0.012_225)]">{label}</div>
      <div className="mt-1 break-words font-semibold text-[oklch(0.2_0.018_230)]">{value}</div>
    </div>
  );
}

function PublicBioTimeline({ events }: { events: PublicBioTimelineEvent[] }) {
  return (
    <div className="mt-6">
      <div className="mb-4 flex items-center gap-2 text-xs font-semibold text-[oklch(0.42_0.014_225)]">
        <Clock className="size-4 text-[oklch(0.42_0.075_190)]" />
        生物时间轴
      </div>
      {events.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[oklch(0.78_0.012_220)] bg-[oklch(0.975_0.003_215)] p-4 text-sm text-[oklch(0.42_0.014_225)]">
          暂无公开记录。
        </div>
      ) : (
        <div className="relative pl-5">
          <div className="absolute left-[0.35rem] top-2 bottom-2 w-px bg-[oklch(0.84_0.01_220)]" />
          <div className="grid gap-4">
            {events.map((event, index) => {
              const isStockIn = event.type === "stock_in";
              const record = event.type === "record" ? event.record : undefined;
              const isDailyLog = isDailyLogRecord(record);
              const label = isStockIn ? "入库" : isDailyLog ? "缸组养护" : "观察/治疗记录";
              const icon = isStockIn ? (
                <PackageCheck className="size-3.5" />
              ) : isDailyLog ? (
                <ClipboardList className="size-3.5" />
              ) : (
                <Camera className="size-3.5" />
              );
              const tone = isStockIn
                ? "border-[oklch(0.82_0.035_235)] bg-[oklch(0.965_0.016_235)] text-[oklch(0.28_0.04_235)]"
                : isDailyLog
                  ? "border-[oklch(0.78_0.07_190)] bg-[oklch(0.955_0.026_190)] text-[oklch(0.28_0.065_190)]"
                  : "border-[oklch(0.78_0.08_150)] bg-[oklch(0.96_0.026_150)] text-[oklch(0.28_0.06_150)]";
              const dot = isStockIn ? "bg-[oklch(0.64_0.08_235)]" : isDailyLog ? "bg-[oklch(0.48_0.075_190)]" : "bg-[oklch(0.55_0.09_150)]";
              return (
                <div key={isStockIn ? `stock-${index}` : record?.id ?? index} className="relative">
                  <div className={`absolute -left-[1.08rem] top-3 size-3 rounded-full border-2 border-white ${dot}`} />
                  <div className={`rounded-2xl border p-4 text-sm leading-6 ${tone}`}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs font-semibold">
                        {icon}
                        {label}
                      </div>
                      <div className="text-xs text-[oklch(0.48_0.014_225)]">
                        {formatBioRecordTime(isStockIn ? event.date : record?.date)}
                      </div>
                    </div>
                    {!isStockIn && (
                      <>
                        {record?.text && <p className="text-[oklch(0.2_0.018_230)]">{record.text}</p>}
                        {isDailyLog && (
                          <p className="mt-1 text-xs text-[oklch(0.38_0.075_190)]">
                            来自养护日志
                            {record?.tankGroupName ? ` · ${record.tankGroupName}` : ""}
                            {record?.subTankName ? ` / ${record.subTankName}` : ""}
                            {record?.operator ? ` · ${record.operator}` : ""}
                          </p>
                        )}
                        {Array.isArray(record?.photos) && record.photos.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {record.photos.slice(0, 4).map((src, photoIndex) => (
                              <div key={`${record.id}-photo-${photoIndex}`} className="size-16 overflow-hidden rounded-lg border border-[oklch(0.84_0.01_220)] bg-[oklch(0.91_0.008_215)]">
                                <ImageWithFallback
                                  src={src}
                                  fallbackSrc={marinePhotos.localFish}
                                  alt={`${label}照片${photoIndex + 1}`}
                                  disableMediaProxy
                                  className="h-full w-full object-cover"
                                />
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SpecimenDetailPanel({
  specimen,
  detailImage,
  timeline,
  latestBio,
  loading,
  selectionCode,
  copied,
  onCopy,
}: {
  specimen?: Specimen;
  detailImage?: SpecimenImage;
  timeline: PublicBioTimelineEvent[];
  latestBio?: PublicBioRecord;
  loading: boolean;
  selectionCode: string;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!specimen) {
    return (
      <aside className="rounded-3xl border border-[oklch(0.84_0.01_220)] bg-white p-5 shadow-[0_24px_70px_rgba(22,34,40,0.06)] xl:sticky xl:top-24 xl:self-start">
        <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed border-[oklch(0.78_0.012_220)] bg-[oklch(0.975_0.003_215)] p-6 text-center text-sm text-[oklch(0.42_0.014_225)]">
          请选择一个具体个体查看养护记录。
        </div>
      </aside>
    );
  }

  const displayImage = detailImage ?? {
    src: specimen.image,
    label: specimen.imageLabel,
    hasIndividualPhoto: specimen.hasIndividualPhoto,
  };

  return (
    <aside className="rounded-3xl border border-[oklch(0.84_0.01_220)] bg-white p-4 shadow-[0_24px_70px_rgba(22,34,40,0.08)] xl:sticky xl:top-24 xl:self-start">
      <SpecimenImageFrame
        src={displayImage.src}
        fallbackSrc={specimen.fallbackImage}
        alt={`${specimen.id} 个体详情`}
        label={displayImage.label}
        hasIndividualPhoto={displayImage.hasIndividualPhoto}
        className="aspect-[4/3] rounded-2xl"
      />

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs font-semibold text-[oklch(0.48_0.075_190)]">个体详情</div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${stockStatusClass(specimen.stock?.status)}`}>
          {specimen.statusLabel}
        </span>
      </div>
      <h3 className="mt-3 text-2xl font-semibold leading-tight text-[oklch(0.18_0.018_230)]">{specimen.product.name}</h3>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-[oklch(0.42_0.014_225)]">
        <span className="inline-flex items-center gap-1.5">
          <Hash className="size-3.5 text-[oklch(0.48_0.075_190)]" />
          {specimen.id}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="size-3.5 text-[oklch(0.54_0.07_78)]" />
          {specimen.locationLabel}
        </span>
      </div>

      <div className="mt-5 flex items-center justify-between rounded-2xl bg-[oklch(0.22_0.018_230)] px-4 py-3 text-white shadow-[0_16px_36px_rgba(22,34,40,0.16)]">
        <span className="text-sm text-white/70">售价</span>
        <span className="text-2xl font-semibold">{formatMoney(specimen.price)}</span>
      </div>

      <div className="mt-4 rounded-2xl border border-[oklch(0.78_0.07_190)] bg-[oklch(0.955_0.026_190)] p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[oklch(0.34_0.075_190)]">选鱼码</div>
            <div className="mt-1 break-all font-mono text-sm text-[oklch(0.18_0.018_230)]">{selectionCode || "暂无可复制编码"}</div>
          </div>
          <button
            type="button"
            onClick={onCopy}
            disabled={!selectionCode}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-[oklch(0.22_0.018_230)] px-4 text-xs font-semibold text-white transition hover:bg-[oklch(0.3_0.018_230)] disabled:cursor-not-allowed disabled:opacity-45 active:translate-y-px"
          >
            {copied ? <ClipboardCheck className="size-4" /> : <Copy className="size-4" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <DetailTile label="尺寸" value={specimen.size} />
        <DetailTile label="状态" value={specimen.statusLabel} />
        <DetailTile label="入库日期" value={specimen.arrivalDate} />
        <DetailTile label="入缸天数" value={`${specimen.daysInStore} 天`} />
        <DetailTile label="缸位" value={specimen.locationLabel} />
        <DetailTile label="售价" value={formatMoney(specimen.price)} />
        <DetailTile label="产地" value={specimen.product.origin || "待确认"} />
      </div>

      <div className="mt-5 rounded-2xl border border-[oklch(0.82_0.03_85)] bg-[oklch(0.97_0.018_85)] p-4 text-sm leading-6 text-[oklch(0.34_0.055_80)]">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[oklch(0.38_0.07_78)]">
          <Clock className="size-4" />
          最近养护及检疫记录
        </div>
        <p className="text-[oklch(0.28_0.04_78)]">
          {loading ? "正在同步维护记录..." : latestBio?.text || "暂无公开维护记录。"}
        </p>
        {latestBio?.date && (
          <div className="mt-2 text-xs text-[oklch(0.44_0.055_78)]">
            {formatBioRecordTime(latestBio.date)}
            {latestBio.operator ? ` · ${latestBio.operator}` : ""}
          </div>
        )}
      </div>

      <PublicBioTimeline events={timeline} />
    </aside>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="mt-5 grid min-h-36 place-items-center rounded-2xl border border-dashed border-[oklch(0.78_0.012_220)] bg-[oklch(0.975_0.003_215)] p-6 text-center text-sm text-[oklch(0.42_0.014_225)]">
      {text}
    </div>
  );
}
