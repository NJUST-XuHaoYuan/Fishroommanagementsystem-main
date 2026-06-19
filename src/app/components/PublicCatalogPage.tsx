import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Check, ChevronRight, Search } from "lucide-react";
import { initialState, Product, Species, StockItem, BioRecord } from "../store";
import { ImageWithFallback } from "./figma/ImageWithFallback";

type PublicCatalogData = {
  speciesCategories: string[];
  species: Species[];
  products: Product[];
  stock: PublicStockItem[];
  bioRecords: BioRecord[];
};

type PublicStockItem = Pick<StockItem, "id" | "productId" | "status" | "inDate"> &
  Partial<Pick<StockItem, "sold" | "lost" | "notes" | "basePrice" | "code">>;

type PublicCatalogPageProps = {
  onStaffLogin?: () => void;
};

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
  products: Product[];
  availableSpecimens: Specimen[];
  difficulty: string;
  temperament: string;
  reefSafe: string;
  tankSize: string;
  priceRange: string;
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
  product: Product;
  species?: Species;
  stock?: PublicStockItem;
  image: string;
  fallbackImage: string;
  price: number;
  size: string;
  sex: string;
  quarantineDays: number;
  feedingStatus: string;
  temperament: string;
  reefSafe: string;
  tankSize: string;
  arrivalDate: string;
  available: boolean;
};

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
    description: "开阔水域型鱼只，重点看体态、色泽和摄食状态。",
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
    description: "体型小而有性格，适合精致珊瑚系统。",
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

const shelfLabels = ["新到个体", "新手友好", "珊瑚缸友好", "收藏级", "已检疫个体"];
const filterOptions = [
  { key: "all", label: "全部" },
  { key: "available", label: "可预订" },
  { key: "quarantined", label: "已检疫" },
  { key: "eating", label: "已开口" },
];

const normalizeCatalog = (value: Partial<PublicCatalogData> | null | undefined): PublicCatalogData => ({
  speciesCategories: Array.isArray(value?.speciesCategories) ? value.speciesCategories : fallbackCatalog.speciesCategories,
  species: Array.isArray(value?.species) ? value.species : fallbackCatalog.species,
  products: Array.isArray(value?.products) ? value.products : fallbackCatalog.products,
  stock: Array.isArray(value?.stock) ? value.stock : fallbackCatalog.stock,
  bioRecords: Array.isArray(value?.bioRecords) ? value.bioRecords : fallbackCatalog.bioRecords,
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

function categoryDescription(categoryName: string, counts: { species: number; specimens: number }) {
  if (categoryName.includes("珊瑚")) return "后台珊瑚分类中的公开可售项目。";
  if (categoryName.includes("耗材")) return "后台耗材分类中的公开可售项目。";
  if (categoryName.includes("活石")) return "后台活石分类中的公开可售项目。";
  if (categoryName.includes("虾") || categoryName.includes("蟹")) return "后台甲壳类分类中的公开可售个体。";
  return `${counts.species} 个物种，${counts.specimens} 条可售个体，数据来自管理系统。`;
}

function specimenPhoto(product: Product | undefined, species: Species | undefined, category: PremiumCategory) {
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

function productPrice(product?: Product, stock?: PublicStockItem) {
  return Math.max(0, Number(stock?.basePrice || product?.defaultPrice || 0));
}

function temperamentFor(category: PremiumCategoryKey) {
  if (category === "tangs") return "活跃";
  if (category === "angelfish" || category === "butterflyfish") return "略强势";
  if (category === "wrasses") return "好动";
  return "温和";
}

function difficultyFor(category: PremiumCategoryKey) {
  if (category === "clownfish" || category === "gobies") return "新手友好";
  if (category === "tangs" || category === "wrasses") return "进阶";
  return "高阶";
}

function tankSizeFor(category: PremiumCategoryKey) {
  if (category === "tangs") return "90 加仑以上";
  if (category === "angelfish" || category === "butterflyfish") return "120 加仑以上";
  if (category === "wrasses") return "55 加仑以上";
  return "30 加仑以上";
}

function reefSafeFor(category: PremiumCategoryKey) {
  if (category === "angelfish" || category === "butterflyfish") return "谨慎混养";
  return "适合";
}

function feedingStatus(status?: string) {
  if (status === "feeding") return "已吃颗粒";
  if (status === "healthy") return "已吃冻饵";
  return "每日观察";
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

function priceRange(products: Product[]) {
  return priceRangeFromValues(products.map((product) => productPrice(product)));
}

function specimenId(stock: PublicStockItem | undefined, product: Product, index: number) {
  const code = String(stock?.code ?? "").trim();
  if (code) return code;
  const source = String(stock?.id ?? product.id ?? `fish-${index + 1}`).replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return `MF-${source.padStart(4, "0").slice(0, 6)}`;
}

function firstBioRecord(records: BioRecord[], stockId?: string) {
  return records
    .filter((record) => record.stockItemId === stockId)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
}

export function PublicCatalogPage({ onStaffLogin }: PublicCatalogPageProps) {
  const [catalog, setCatalog] = useState<PublicCatalogData>(fallbackCatalog);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedCategoryKey, setSelectedCategoryKey] = useState("");
  const [selectedSpeciesId, setSelectedSpeciesId] = useState("");
  const [selectedSpecimenId, setSelectedSpecimenId] = useState("");
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
        setLoadError(false);
      })
      .catch(() => {
        if (cancelled) return;
        setCatalog(fallbackCatalog);
        setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const productBySpecies = useMemo(() => {
    const map = new Map<string, Product[]>();
    catalog.products.forEach((product) => {
      const current = map.get(product.speciesId) ?? [];
      current.push(product);
      map.set(product.speciesId, current);
    });
    return map;
  }, [catalog.products]);

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
      const stockItems = availableStock.length > 0 ? availableStock : [undefined];
      stockItems.forEach((stock, stockIndex) => {
        const quarantineDays = daysSince(stock?.inDate);
        all.push({
          id: specimenId(stock, product, productIndex + stockIndex),
          product,
          species,
          stock,
          image: displayImageUrl(specimenPhoto(product, species, category), 1200),
          fallbackImage,
          price: productPrice(product, stock),
          size: product.size || "待确认",
          sex: "未判定",
          quarantineDays,
          feedingStatus: feedingStatus(stock?.status),
          temperament: temperamentFor(category.key),
          reefSafe: reefSafeFor(category.key),
          tankSize: tankSizeFor(category.key),
          arrivalDate: formatDate(stock?.inDate),
          available: Boolean(stock),
        });
      });
    });
    return all;
  }, [catalog.products, catalog.species, catalog.stock]);

  const speciesCards = useMemo<SpeciesCard[]>(() => {
    return catalog.species
      .map((species) => {
        const category = categoryForSpecies(species);
        const products = productBySpecies.get(species.id) ?? [];
        const speciesSpecimens = specimens.filter((specimen) => specimen.species?.id === species.id && specimen.available);
        return {
          species,
          products,
          availableSpecimens: speciesSpecimens,
          difficulty: difficultyFor(category.key),
          temperament: temperamentFor(category.key),
          reefSafe: reefSafeFor(category.key),
          tankSize: tankSizeFor(category.key),
          priceRange: priceRangeFromValues(
            speciesSpecimens.length > 0 ? speciesSpecimens.map((specimen) => specimen.price) : products.map((product) => productPrice(product))
          ),
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
        return {
          key: name,
          label: name,
          description: categoryDescription(name, counts),
          image: categoryFallbackImage(name, counts.sample),
          species: counts.species,
          specimens: counts.specimens,
        };
      });
  }, [catalog.speciesCategories, categoryCounts]);

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
  const visibleSpecies = speciesCards.filter((card) => speciesCategoryName(card.species) === selectedCategory.key);

  useEffect(() => {
    if (catalogCategories.some((category) => category.key === selectedCategoryKey)) return;
    setSelectedCategoryKey(catalogCategories[0]?.key ?? "");
  }, [catalogCategories, selectedCategoryKey]);

  useEffect(() => {
    if (visibleSpecies.some((card) => card.species.id === selectedSpeciesId)) return;
    setSelectedSpeciesId(visibleSpecies[0]?.species.id ?? "");
  }, [selectedSpeciesId, visibleSpecies]);

  const selectedSpecies = visibleSpecies.find((card) => card.species.id === selectedSpeciesId) ?? visibleSpecies[0] ?? speciesCards[0];
  const specimenOptions = specimens.filter((specimen) => specimen.species?.id === selectedSpecies?.species.id);
  const filteredSpecimens = specimenOptions.filter((specimen) => {
    if (filter === "all") return true;
    if (filter === "quarantined") return specimen.quarantineDays >= 14;
    if (filter === "eating") return specimen.feedingStatus.includes("吃");
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
    filteredSpecimens[0] ??
    specimens[0];

  const selectedBio = firstBioRecord(catalog.bioRecords, selectedSpecimen?.stock?.id);
  const heroSpecimen = selectedSpecimen ?? specimens[0];
  const featureShelves = shelfLabels.map((label, index) => ({
    label,
    specimen: specimens[index % Math.max(1, specimens.length)],
  }));

  const scrollToCatalog = () => {
    document.getElementById("catalog")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scrollToArrivals = () => {
    document.getElementById("new-arrivals")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
          <nav className="hidden items-center gap-7 text-sm text-[#a9bfce] lg:flex" aria-label="主导航">
            <button type="button" onClick={scrollToArrivals} className="transition hover:text-white">新到个体</button>
            <button type="button" onClick={scrollToCatalog} className="transition hover:text-white">在售个体</button>
            <span className="text-[#d3b56f]">已检疫</span>
          </nav>
        </div>
      </header>

      <section className="relative min-h-[calc(100dvh-5rem)] overflow-hidden">
        <ImageWithFallback
          src={heroSpecimen?.image || displayImageUrl(marinePhotos.blueTang, 1800)}
          fallbackSrc={heroSpecimen?.fallbackImage ?? marinePhotos.localFish}
          alt={heroSpecimen?.product.name ?? "海水鱼个体"}
          disableMediaProxy
          className="absolute inset-0 h-full w-full object-cover opacity-70"
          loading="eager"
        />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_74%_42%,rgba(16,211,222,0.18),transparent_28%),linear-gradient(90deg,rgba(3,16,31,0.98)_0%,rgba(3,16,31,0.76)_42%,rgba(3,16,31,0.18)_100%)]" />
        <div className="relative mx-auto flex min-h-[calc(100dvh-5rem)] max-w-7xl items-center px-4 py-14 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <h1 className="max-w-[16ch] text-5xl font-semibold leading-[1.02] tracking-normal text-white sm:text-6xl lg:text-7xl">
              按真实个体
              <br className="hidden sm:block" />
              挑选海水鱼。
            </h1>
            <p className="mt-6 max-w-[32rem] text-base leading-7 text-[#bfd0db]">
              先选大类，再看物种，最后锁定每一条鱼。
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
              <button
                type="button"
                onClick={scrollToArrivals}
                className="inline-flex h-12 items-center justify-center rounded-full border border-[#d3b56f]/55 bg-[#071b2d]/60 px-6 text-sm font-semibold text-[#f3df9d] transition hover:border-[#f3df9d] hover:text-white active:translate-y-px"
              >
                查看新到
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-[#061725] py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold leading-tight text-white sm:text-4xl">按大类浏览</h2>
            <p className="mt-4 max-w-[38rem] text-sm leading-7 text-[#91a8b8]">
              大类保持清晰，所有数量来自管理系统中的在缸可售库存。
            </p>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {catalogCategories.map((category, index) => {
              return (
                <button
                  key={category.key}
                  type="button"
                  onClick={() => {
                    setSelectedCategoryKey(category.key);
                    scrollToCatalog();
                  }}
                  className={`group relative min-h-72 overflow-hidden rounded-[1.25rem] border border-white/10 bg-[#0b2033] text-left transition hover:-translate-y-1 hover:border-cyan-300/40 ${
                    index === 0 || index === 6 ? "xl:col-span-2" : ""
                  }`}
                >
                  <ImageWithFallback
                    src={displayImageUrl(category.image, 1400)}
                    fallbackSrc={marinePhotos.localFish}
                    alt={category.label}
                    disableMediaProxy
                    className="absolute inset-0 h-full w-full object-cover opacity-54 transition duration-500 group-hover:scale-[1.035] group-hover:opacity-70"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#03101f] via-[#03101f]/45 to-transparent" />
                  <div className="relative flex h-full min-h-72 flex-col justify-end p-6">
                    <h3 className="text-3xl font-semibold text-white">{category.label}</h3>
                    <p className="mt-3 max-w-[24rem] text-sm leading-6 text-[#c5d4dd]">{category.description}</p>
                    <div className="mt-5 flex flex-wrap gap-3 text-xs font-semibold text-[#f3df9d]">
                      <span>{category.species} 个物种</span>
                      <span>{category.specimens} 条在售</span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section id="new-arrivals" className="bg-[#03101f] py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-3xl font-semibold leading-tight text-white sm:text-4xl">精选陈列</h2>
              <p className="mt-4 max-w-[36rem] text-sm leading-7 text-[#91a8b8]">
                按到货、难度、珊瑚缸适配和收藏价值快速查看。
              </p>
            </div>
            <div className="rounded-full border border-cyan-300/20 bg-cyan-300/8 px-4 py-2 text-xs font-semibold text-[#8deef4]">
              {isLoading ? "正在同步库存" : loadError ? "当前显示预览数据" : "已同步管理系统库存"}
            </div>
          </div>
          <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {featureShelves.map(({ label, specimen }) => (
              <article key={label} className="overflow-hidden rounded-[1.25rem] border border-white/10 bg-[#081b2c]">
                <div className="aspect-[4/3] overflow-hidden bg-[#0f2a40]">
                  <ImageWithFallback
                    src={specimen?.image}
                    fallbackSrc={specimen?.fallbackImage ?? marinePhotos.localFish}
                    alt={specimen?.product.name ?? label}
                    disableMediaProxy
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="p-4">
                  <h3 className="text-sm font-semibold text-white">{label}</h3>
                  <p className="mt-2 text-xs leading-5 text-[#91a8b8]">
                    {specimen?.product.name ?? "个体列表待同步"}
                  </p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="catalog" className="border-t border-white/10 bg-[#061725] py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold leading-tight text-white sm:text-4xl">挑选在售个体</h2>
            <p className="mt-4 max-w-[39rem] text-sm leading-7 text-[#91a8b8]">
              从大类到物种，再到具体单体，库存与后台管理系统保持同源。
            </p>
          </div>

          <div className="mt-8 grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
            <aside className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-4 lg:sticky lg:top-24 lg:self-start">
              <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#041321] px-4 py-3 text-sm text-[#91a8b8]">
                <Search className="size-4 text-[#1ee6ef]" />
                按大类筛选
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
            </aside>

            <div className="grid gap-6">
              <section className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-4 sm:p-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h3 className="text-2xl font-semibold text-white">{selectedCategory.label}</h3>
                    <p className="mt-2 max-w-[40rem] text-sm leading-6 text-[#91a8b8]">{selectedCategory.description}</p>
                  </div>
                  <div className="text-sm font-semibold text-[#f3df9d]">{visibleSpecies.length} 个物种</div>
                </div>
                {visibleSpecies.length === 0 ? (
                  <EmptyState text="这个大类暂时没有公开在售物种。" />
                ) : (
                  <div className="mt-5 grid gap-4 xl:grid-cols-2">
                    {visibleSpecies.map((card) => {
                      const active = selectedSpecies?.species.id === card.species.id;
                      return (
                        <button
                          key={card.species.id}
                          type="button"
                          onClick={() => setSelectedSpeciesId(card.species.id)}
                          className={`grid overflow-hidden rounded-[1.1rem] border bg-[#0b2033] text-left transition hover:-translate-y-0.5 active:translate-y-px sm:grid-cols-[11rem_minmax(0,1fr)] ${
                            active ? "border-[#1ee6ef]/65 shadow-[0_22px_48px_rgba(30,230,239,0.09)]" : "border-white/10 hover:border-white/22"
                          }`}
                        >
                          <div className="aspect-[4/3] overflow-hidden bg-[#102b42] sm:aspect-auto">
                            <ImageWithFallback
                              src={displayImageUrl(specimenPhoto(card.products[0], card.species, categoryForSpecies(card.species)), 900)}
                              fallbackSrc={categoryFallbackImage(speciesCategoryName(card.species), card.species)}
                              alt={card.species.name}
                              disableMediaProxy
                              className="h-full w-full object-cover"
                            />
                          </div>
                          <div className="p-4">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <h4 className="text-lg font-semibold text-white">{card.species.name}</h4>
                                <p className="mt-1 text-xs text-[#7893a6]">{card.species.scientificName}</p>
                              </div>
                              {active && <Check className="size-4 text-[#1ee6ef]" />}
                            </div>
                            <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-[#a9bfce]">
                              <SpecLine label="饲养难度" value={card.difficulty} />
                              <SpecLine label="性格" value={card.temperament} />
                              <SpecLine label="珊瑚缸" value={card.reefSafe} />
                              <SpecLine label="价格" value={card.priceRange} />
                            </div>
                            <div className="mt-4 text-xs font-semibold text-[#f3df9d]">{card.availableSpecimens.length} 条个体在售</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </section>

              <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
                <div className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-4 sm:p-5">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h3 className="text-2xl font-semibold text-white">单体个体</h3>
                      <p className="mt-2 text-sm text-[#91a8b8]">选择具体那一条，再确认预订。</p>
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
                                <SpecLine label="检疫" value={`${specimen.quarantineDays} 天`} />
                                <SpecLine label="摄食" value={specimen.feedingStatus} />
                                <SpecLine label="状态" value={specimen.available ? "可预订" : "到店确认"} />
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <SpecimenPreview specimen={selectedSpecimen} />
              </section>
            </div>
          </div>
        </div>
      </section>

      <section className="border-t border-white/10 bg-[#03101f] py-12 sm:py-16">
        <div className="mx-auto grid max-w-7xl gap-6 px-4 sm:px-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)] lg:px-8">
          <div className="overflow-hidden rounded-[1.5rem] border border-white/10 bg-[#081b2c] p-4">
            <div className="grid gap-4 sm:grid-cols-[1fr_0.7fr]">
              <div className="aspect-[4/3] overflow-hidden rounded-[1.1rem] bg-[#102b42]">
                <ImageWithFallback
                  src={selectedSpecimen?.image}
                  fallbackSrc={selectedSpecimen?.fallbackImage ?? marinePhotos.localFish}
                  alt={selectedSpecimen?.product.name ?? "选中个体"}
                  disableMediaProxy
                  className="h-full w-full object-cover"
                />
              </div>
              <div className="grid gap-4">
                <div className="overflow-hidden rounded-[1.1rem] bg-[#102b42]">
                  <ImageWithFallback
                    src={displayImageUrl(specimenPhoto(selectedSpecimen?.product, selectedSpecimen?.species, categoryForSpecies(selectedSpecimen?.species)), 900)}
                    fallbackSrc={selectedSpecimen?.fallbackImage ?? marinePhotos.localFish}
                    alt={selectedSpecimen?.species?.name ?? "物种参考"}
                    disableMediaProxy
                    className="h-full min-h-44 w-full object-cover"
                  />
                </div>
                <div className="rounded-[1.1rem] border border-white/10 bg-[#0b2033] p-5">
                  <div className="text-xs font-semibold text-[#1ee6ef]">可提供视频确认</div>
                  <p className="mt-3 text-sm leading-6 text-[#91a8b8]">
                    预订前可确认摄食视频，并沟通混养建议。
                  </p>
                </div>
              </div>
            </div>
          </div>

          <aside className="rounded-[1.5rem] border border-white/10 bg-[#081b2c] p-6">
            <div className="text-xs font-semibold text-[#1ee6ef]">个体详情</div>
            <h2 className="mt-3 text-3xl font-semibold leading-tight text-white">{selectedSpecimen?.product.name ?? "选中个体"}</h2>
            <div className="mt-2 text-sm text-[#91a8b8]">{selectedSpecimen?.id}</div>
            <div className="mt-6 text-4xl font-semibold text-[#f3df9d]">{formatMoney(selectedSpecimen?.price)}</div>
            <div className="mt-6 grid grid-cols-2 gap-3 text-sm">
              <DetailTile label="准确尺寸" value={selectedSpecimen?.size ?? "待确认"} />
              <DetailTile label="性别" value={selectedSpecimen?.sex ?? "未判定"} />
              <DetailTile label="检疫天数" value={`${selectedSpecimen?.quarantineDays ?? 0} 天`} />
              <DetailTile label="摄食状态" value={selectedSpecimen?.feedingStatus ?? "观察中"} />
              <DetailTile label="性格" value={selectedSpecimen?.temperament ?? "温和"} />
              <DetailTile label="珊瑚缸" value={selectedSpecimen?.reefSafe ?? "谨慎混养"} />
              <DetailTile label="建议缸体" value={selectedSpecimen?.tankSize ?? "到店确认"} />
              <DetailTile label="到货日期" value={selectedSpecimen?.arrivalDate ?? "待确认"} />
            </div>
            <div className="mt-6 rounded-[1.1rem] border border-[#d3b56f]/20 bg-[#d3b56f]/8 p-4 text-sm leading-6 text-[#d6c996]">
              {selectedBio?.text || "预订前会再次核对摄食、体表、混养对象和发货时间。"}
            </div>
            <div className="mt-6 grid gap-3">
              <button
                type="button"
                className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-[#1ee6ef] px-5 text-sm font-semibold text-[#03101f] transition hover:bg-[#75f5f8] active:translate-y-px"
              >
                预订这条鱼
                <ChevronRight className="size-4" />
              </button>
              <button
                type="button"
                className="inline-flex h-12 items-center justify-center rounded-full border border-[#d3b56f]/55 px-5 text-sm font-semibold text-[#f3df9d] transition hover:border-[#f3df9d] hover:text-white active:translate-y-px"
              >
                咨询混养建议
              </button>
            </div>
          </aside>
        </div>
      </section>

      <footer className="border-t border-white/10 bg-[#020b15] py-8">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 text-sm text-[#7893a6] sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>海水鱼廊 / 每一条在售个体以后台库存为准</div>
          <button
            type="button"
            onClick={onStaffLogin}
            className="w-fit rounded-full border border-white/10 px-4 py-2 text-sm font-semibold text-[#a9bfce] transition hover:border-cyan-300/35 hover:text-white active:translate-y-px"
          >
            员工登录
          </button>
        </div>
      </footer>
    </main>
  );
}

function SpecLine({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[#607c90]">{label}</div>
      <div className="mt-1 font-semibold text-[#dbe8ee]">{value}</div>
    </div>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#0b2033] p-3">
      <div className="text-xs text-[#7893a6]">{label}</div>
      <div className="mt-1 font-semibold text-white">{value}</div>
    </div>
  );
}

function SpecimenPreview({ specimen }: { specimen?: Specimen }) {
  if (!specimen) return <EmptyState text="请选择一个个体查看预览。" />;

  return (
    <aside className="rounded-[1.25rem] border border-white/10 bg-[#081b2c] p-4 xl:sticky xl:top-24 xl:self-start">
      <div className="aspect-[4/3] overflow-hidden rounded-[1.1rem] bg-[#102b42]">
        <ImageWithFallback
          src={specimen.image}
          fallbackSrc={specimen.fallbackImage}
          alt={`${specimen.id} 个体预览`}
          disableMediaProxy
          className="h-full w-full object-cover"
        />
      </div>
      <div className="mt-5">
        <div className="text-xs font-semibold text-[#1ee6ef]">{specimen.id}</div>
        <h3 className="mt-2 text-2xl font-semibold leading-tight text-white">{specimen.product.name}</h3>
        <p className="mt-3 text-sm leading-6 text-[#91a8b8]">
          右侧预览同步展示检疫、摄食和预订信息。
        </p>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <DetailTile label="尺寸" value={specimen.size} />
        <DetailTile label="检疫" value={`${specimen.quarantineDays} 天`} />
        <DetailTile label="摄食" value={specimen.feedingStatus} />
        <DetailTile label="状态" value={specimen.available ? "可预订" : "到店确认"} />
      </div>
      <div className="mt-5 flex items-center justify-between rounded-xl border border-[#d3b56f]/20 bg-[#d3b56f]/8 px-4 py-3">
        <span className="text-sm text-[#d6c996]">预订价</span>
        <span className="text-2xl font-semibold text-[#f3df9d]">{formatMoney(specimen.price)}</span>
      </div>
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
