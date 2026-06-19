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
    batchNo?: string;
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

type Specimen = {
  id: string;
  product: PublicProduct;
  species?: Species;
  stock?: PublicStockItem;
  bioRecord?: PublicBioRecord;
  image: string;
  fallbackImage: string;
  price: number;
  size: string;
  daysInStore: number;
  statusLabel: string;
  locationLabel: string;
  batchNo: string;
  arrivalDate: string;
  available: boolean;
};

type PublicBioTimelineEvent =
  | { type: "stock_in"; date: string; batchNo: string }
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
  { key: "available", label: "可预订" },
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

function specimenPhoto(
  product: PublicProduct | undefined,
  species: Species | undefined,
  category: PremiumCategory,
  bioRecord?: PublicBioRecord
) {
  const individualImage = firstBioPhoto(bioRecord);
  if (individualImage) return individualImage;

  const managedImage = [product?.imageUrl, species?.imageUrl].find((src) => src && !isDemoImage(src));
  if (managedImage) return managedImage;

  const haystack = [
    product?.name,
    species?.name,
    species?.scientificName,
    ...(Array.isArray(species?.commonNames) ? species.commonNames : []),
  ].join(" ").toLowerCase();
  if (haystack.includes("黄金") || haystack.includes("yellow") || haystack.includes("flavescens")) {
    return marinePhotos.yellowTang;
  }
  if (haystack.includes("蓝倒吊") || haystack.includes("blue") || haystack.includes("hepatus")) {
    return marinePhotos.blueTang;
  }
  if (haystack.includes("小丑") || haystack.includes("clown") || haystack.includes("amphiprion")) {
    return marinePhotos.clownfish;
  }
  return category.image;
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
  if (status === "feeding") return "border-[#d3b56f]/40 bg-[#d3b56f]/12 text-[#f3df9d]";
  if (status === "sick") return "border-rose-300/35 bg-rose-500/12 text-rose-100";
  return "border-[#1ee6ef]/35 bg-[#1ee6ef]/10 text-[#8deef4]";
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
        all.push({
          id: specimenId(stock, product, productIndex + stockIndex),
          product,
          species,
          stock,
          bioRecord,
          image: displayImageUrl(specimenPhoto(product, species, category, bioMediaRecord ?? bioRecord), 1200),
          fallbackImage,
          price: productPrice(product, stock),
          size: product.size || "待确认",
          daysInStore,
          statusLabel: stockStatusLabel(stock?.status),
          locationLabel: stockLocation(stock),
          batchNo: String(stock?.batchNo ?? "").trim() || "—",
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
    if (filter === "available") return specimen.available;
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
  const selectedTimeline = useMemo<PublicBioTimelineEvent[]>(() => {
    if (!selectedSpecimen?.stock) return [];
    return [
      { type: "stock_in", date: selectedSpecimen.stock.inDate, batchNo: selectedSpecimen.batchNo },
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
  const heroImage = heroCarouselImages[heroImageIndex] ?? marinePhotos.localFish;

  const scrollToCatalog = () => {
    document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <main className="min-h-[100dvh] bg-[#03101f] text-[#f4f8fb]">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-[#03101f]/86 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-4">
            <div className="grid size-16 place-items-center rounded-2xl border border-cyan-300/25 bg-white/8 shadow-[0_16px_42px_rgba(30,230,239,0.08)]">
              <img src="/assets/brand-logo.jpg" alt="海水鱼廊" className="size-14 rounded-xl object-contain" />
            </div>
            <div>
              <div className="text-lg font-semibold tracking-normal text-white">海水鱼廊</div>
              <div className="text-xs text-[#8faabc]">单体鱼选购</div>
            </div>
          </div>
        </div>
      </header>

      <section className="relative min-h-[calc(100dvh-5rem)] overflow-hidden">
        <ImageWithFallback
          key={heroImage}
          src={heroImage}
          fallbackSrc={marinePhotos.localFish}
          alt="海水鱼廊图册照片"
          disableMediaProxy
          className="absolute inset-0 h-full w-full object-cover opacity-70 transition-opacity duration-700"
          loading="eager"
        />
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
              按真实库存个体挑选海水生物
            </h1>
            <p className="mt-6 max-w-[32rem] text-base leading-7 text-[#bfd0db]">
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

      <section id="catalog" className="border-t border-white/10 bg-[#061725] py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold leading-tight text-white sm:text-4xl">按大类浏览</h2>
            <p className="mt-4 max-w-[39rem] text-sm leading-7 text-[#91a8b8]">
              先在侧边栏选大类，再选品种，页面内直接切换到具体库存个体。
            </p>
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[18rem_minmax(0,1fr)_26rem]">
            <aside className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-4 lg:sticky lg:top-24 lg:self-start">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#041321] px-4 py-3 text-sm text-[#91a8b8]">
                <Search className="size-4 text-[#1ee6ef]" />
                大类
              </div>
              <div className="mt-4 grid gap-2">
                {catalogCategories.map((category) => {
                  const active = selectedCategoryKey === category.key;
                  return (
                    <button
                      key={category.key}
                      type="button"
                      onClick={() => setSelectedCategoryKey(category.key)}
                      className={`rounded-xl border px-4 py-3 text-left transition active:translate-y-px ${
                        active
                          ? "border-[#1ee6ef]/65 bg-[#123450] text-white"
                          : "border-white/10 bg-[#0b2033] text-[#a9bfce] hover:border-white/20 hover:text-white"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold">{category.label}</span>
                        {active && <Check className="size-4 text-[#1ee6ef]" />}
                      </div>
                      <div className="mt-1 text-xs text-[#7893a6]">{category.specimens} 条在售</div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-5 text-xs font-semibold text-[#91a8b8]">
                <span>品种</span>
                <span>{visibleSpecies.length}</span>
              </div>
              <div className="mt-3 grid gap-2">
                {visibleSpecies.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-white/15 bg-[#0b2033]/72 p-4 text-sm text-[#91a8b8]">
                    这个大类暂时没有公开在售品种。
                  </div>
                ) : (
                  visibleSpecies.map((card) => {
                    const active = selectedSpecies?.species.id === card.species.id;
                    return (
                      <button
                        key={card.species.id}
                        type="button"
                        onClick={() => setSelectedSpeciesId(card.species.id)}
                        className={`grid grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-3 rounded-xl border p-2 text-left transition active:translate-y-px ${
                          active
                            ? "border-[#1ee6ef]/65 bg-[#123450] text-white"
                            : "border-white/10 bg-[#0b2033] text-[#a9bfce] hover:border-white/20 hover:text-white"
                        }`}
                      >
                        <div className="aspect-square overflow-hidden rounded-lg bg-[#102b42]">
                          <ImageWithFallback
                            src={card.availableSpecimens[0]?.image ?? displayImageUrl(specimenPhoto(card.products[0], card.species, categoryForSpecies(card.species)), 900)}
                            fallbackSrc={categoryFallbackImage(speciesCategoryName(card.species), card.species)}
                            alt={card.species.name}
                            disableMediaProxy
                            className="h-full w-full object-cover"
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold">{card.species.name}</div>
                          <div className="mt-0.5 truncate text-xs text-[#7893a6]">{card.availableSpecimens.length} 条 · {card.priceRange}</div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </aside>

            <section className="grid gap-6">
              <div className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-xs font-semibold text-[#1ee6ef]">{selectedCategory.label}</div>
                    <h3 className="mt-2 text-2xl font-semibold text-white">{selectedSpecies?.species.name ?? "暂无在售品种"}</h3>
                    {selectedSpecies?.species.scientificName && (
                      <p className="mt-1 text-sm italic text-[#7893a6]">{selectedSpecies.species.scientificName}</p>
                    )}
                    <p className="mt-3 max-w-[42rem] text-sm leading-6 text-[#91a8b8]">
                      {selectedSpecies
                        ? `${selectedSpecies.availableSpecimens.length} 条真实库存个体，最近到货 ${selectedSpecies.latestArrival}。`
                        : selectedCategory.description}
                    </p>
                  </div>
                  {selectedSpecies && (
                    <div className="rounded-xl border border-[#d3b56f]/20 bg-[#d3b56f]/8 px-4 py-3 text-sm font-semibold text-[#f3df9d]">
                      {selectedSpecies.priceRange}
                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="text-2xl font-semibold text-white">选择具体个体</h3>
                    <p className="mt-2 text-sm text-[#91a8b8]">选中后右侧直接展示养护、检疫和选鱼码。</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {filterOptions.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => setFilter(item.key)}
                        className={`h-9 rounded-full border px-4 text-xs font-semibold transition active:translate-y-px ${
                          filter === item.key
                            ? "border-[#1ee6ef] bg-[#1ee6ef] text-[#03101f]"
                            : "border-white/10 bg-[#061725] text-[#a9bfce] hover:border-white/25 hover:text-white"
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
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
                          className={`overflow-hidden rounded-[1.1rem] border bg-[#0b2033] text-left transition hover:-translate-y-0.5 active:translate-y-px ${
                            active ? "border-[#1ee6ef]/70 shadow-[0_24px_48px_rgba(30,230,239,0.08)]" : "border-white/10 hover:border-white/22"
                          }`}
                        >
                          <div className="aspect-[1.28/1] overflow-hidden bg-[#102b42]">
                            <ImageWithFallback
                              src={specimen.image}
                              fallbackSrc={specimen.fallbackImage}
                              alt={`${specimen.id} ${specimen.product.name}`}
                              disableMediaProxy
                              className="h-full w-full object-cover transition duration-500 hover:scale-[1.035]"
                            />
                          </div>
                          <div className="p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="text-xs font-semibold text-[#1ee6ef]">{specimen.id}</div>
                                <h4 className="mt-1 text-lg font-semibold text-white">{specimen.product.name}</h4>
                              </div>
                              <div className="text-lg font-semibold text-[#f3df9d]">{formatMoney(specimen.price)}</div>
                            </div>
                            <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-[#a9bfce]">
                              <SpecLine label="尺寸" value={specimen.size} />
                              <SpecLine label="状态" value={specimen.statusLabel} />
                              <SpecLine label="缸位" value={specimen.locationLabel} />
                              <SpecLine label="入缸" value={`${specimen.daysInStore} 天`} />
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

      <footer className="border-t border-white/10 bg-[#020b15] py-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 text-sm text-[#7893a6] sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>海水鱼廊 / 每一条在售个体以后台库存为准</div>
        </div>
      </footer>
    </main>
  );
}

function SpecLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[#607c90]">{label}</div>
      <div className="mt-1 break-words font-semibold text-[#dbe8ee]">{value}</div>
    </div>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-white/10 bg-[#0b2033] p-3">
      <div className="text-xs text-[#7893a6]">{label}</div>
      <div className="mt-1 break-words font-semibold text-white">{value}</div>
    </div>
  );
}

function PublicBioTimeline({ events }: { events: PublicBioTimelineEvent[] }) {
  return (
    <div className="mt-6">
      <div className="mb-4 flex items-center gap-2 text-xs font-semibold text-[#91a8b8]">
        <Clock className="size-4 text-[#1ee6ef]" />
        生物时间轴
      </div>
      {events.length === 0 ? (
        <div className="rounded-[1.1rem] border border-dashed border-white/15 bg-[#0b2033]/72 p-4 text-sm text-[#91a8b8]">
          暂无公开记录。
        </div>
      ) : (
        <div className="relative pl-5">
          <div className="absolute left-[0.35rem] top-2 bottom-2 w-px bg-white/12" />
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
                ? "border-sky-300/24 bg-sky-300/8 text-sky-100"
                : isDailyLog
                  ? "border-[#1ee6ef]/24 bg-[#1ee6ef]/8 text-[#d6fbff]"
                  : "border-emerald-300/24 bg-emerald-300/8 text-emerald-100";
              const dot = isStockIn ? "bg-sky-300" : isDailyLog ? "bg-[#1ee6ef]" : "bg-emerald-300";
              return (
                <div key={isStockIn ? `stock-${index}` : record?.id ?? index} className="relative">
                  <div className={`absolute -left-[1.08rem] top-3 size-3 rounded-full border-2 border-[#081b2c] ${dot}`} />
                  <div className={`rounded-[1.1rem] border p-4 text-sm leading-6 ${tone}`}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs font-semibold">
                        {icon}
                        {label}
                      </div>
                      <div className="text-xs text-[#91a8b8]">
                        {formatBioRecordTime(isStockIn ? event.date : record?.date)}
                      </div>
                    </div>
                    {isStockIn ? (
                      <p className="text-[#c6d7e0]">批次：{event.batchNo || "—"}</p>
                    ) : (
                      <>
                        {record?.text && <p className="text-white">{record.text}</p>}
                        {isDailyLog && (
                          <p className="mt-1 text-xs text-[#8deef4]">
                            来自养护日志
                            {record?.tankGroupName ? ` · ${record.tankGroupName}` : ""}
                            {record?.subTankName ? ` / ${record.subTankName}` : ""}
                            {record?.operator ? ` · ${record.operator}` : ""}
                          </p>
                        )}
                        {Array.isArray(record?.photos) && record.photos.length > 0 && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            {record.photos.slice(0, 4).map((src, photoIndex) => (
                              <div key={`${record.id}-photo-${photoIndex}`} className="size-16 overflow-hidden rounded-lg border border-white/10 bg-[#102b42]">
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
  timeline,
  latestBio,
  loading,
  selectionCode,
  copied,
  onCopy,
}: {
  specimen?: Specimen;
  timeline: PublicBioTimelineEvent[];
  latestBio?: PublicBioRecord;
  loading: boolean;
  selectionCode: string;
  copied: boolean;
  onCopy: () => void;
}) {
  if (!specimen) {
    return (
      <aside className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-5 xl:sticky xl:top-24 xl:self-start">
        <div className="grid min-h-72 place-items-center rounded-[1.1rem] border border-dashed border-white/15 bg-[#0b2033]/72 p-6 text-center text-sm text-[#91a8b8]">
          请选择一个具体个体查看养护记录。
        </div>
      </aside>
    );
  }

  return (
    <aside className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-4 xl:sticky xl:top-24 xl:self-start">
      <div className="aspect-[4/3] overflow-hidden rounded-[1.1rem] bg-[#102b42]">
        <ImageWithFallback
          src={specimen.image}
          fallbackSrc={specimen.fallbackImage}
          alt={`${specimen.id} 个体详情`}
          disableMediaProxy
          className="h-full w-full object-cover"
        />
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs font-semibold text-[#1ee6ef]">个体详情</div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${stockStatusClass(specimen.stock?.status)}`}>
          {specimen.statusLabel}
        </span>
      </div>
      <h3 className="mt-3 text-2xl font-semibold leading-tight text-white">{specimen.product.name}</h3>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-[#91a8b8]">
        <span className="inline-flex items-center gap-1.5">
          <Hash className="size-3.5 text-[#1ee6ef]" />
          {specimen.id}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="size-3.5 text-[#d3b56f]" />
          {specimen.locationLabel}
        </span>
      </div>

      <div className="mt-5 flex items-center justify-between rounded-xl border border-[#d3b56f]/20 bg-[#d3b56f]/8 px-4 py-3">
        <span className="text-sm text-[#d6c996]">预订价</span>
        <span className="text-2xl font-semibold text-[#f3df9d]">{formatMoney(specimen.price)}</span>
      </div>

      <div className="mt-5 rounded-xl border border-[#1ee6ef]/20 bg-[#1ee6ef]/8 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[#8deef4]">选鱼码</div>
            <div className="mt-1 break-all font-mono text-sm text-white">{selectionCode || "暂无可复制编码"}</div>
          </div>
          <button
            type="button"
            onClick={onCopy}
            disabled={!selectionCode}
            className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-[#1ee6ef] px-4 text-xs font-semibold text-[#03101f] transition hover:bg-[#75f5f8] disabled:cursor-not-allowed disabled:opacity-45 active:translate-y-px"
          >
            {copied ? <ClipboardCheck className="size-4" /> : <Copy className="size-4" />}
            {copied ? "已复制" : "复制"}
          </button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <DetailTile label="尺寸" value={specimen.size} />
        <DetailTile label="状态" value={specimen.statusLabel} />
        <DetailTile label="批次" value={specimen.batchNo} />
        <DetailTile label="入库日期" value={specimen.arrivalDate} />
        <DetailTile label="入缸天数" value={`${specimen.daysInStore} 天`} />
        <DetailTile label="缸位" value={specimen.locationLabel} />
        <DetailTile label="售价" value={formatMoney(specimen.price)} />
        <DetailTile label="产地" value={specimen.product.origin || "待确认"} />
      </div>

      <div className="mt-5 rounded-[1.1rem] border border-[#d3b56f]/20 bg-[#d3b56f]/8 p-4 text-sm leading-6 text-[#d6c996]">
        <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-[#f3df9d]">
          <Clock className="size-4" />
          最近养护及检疫记录
        </div>
        <p className="text-[#e2d8ab]">
          {loading ? "正在同步维护记录..." : latestBio?.text || "暂无公开维护记录。"}
        </p>
        {latestBio?.date && (
          <div className="mt-2 text-xs text-[#a99554]">
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
    <div className="mt-5 grid min-h-36 place-items-center rounded-[1.1rem] border border-dashed border-white/15 bg-[#0b2033]/72 p-6 text-center text-sm text-[#91a8b8]">
      {text}
    </div>
  );
}
