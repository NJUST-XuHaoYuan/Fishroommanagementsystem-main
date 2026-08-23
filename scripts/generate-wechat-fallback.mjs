import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const miniProgramRoot = path.join(repoRoot, "wechat-miniprogram");
const assetDir = path.join(miniProgramRoot, "assets", "fallback-products");
const modulePath = path.join(miniProgramRoot, "utils", "fallback-catalog.js");
const apiBaseUrl = String(process.env.FISHROOM_PUBLIC_API_URL || "http://129.211.211.201:8787").replace(/\/+$/, "");
const sourceFile = process.argv[2] ? path.resolve(process.argv[2]) : "";
const bioRecordsFile = process.argv[3] ? path.resolve(process.argv[3]) : "";

function resolveImageUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return new URL(raw, `${apiBaseUrl}/`).toString();
}

function stableImageKey(value) {
  const url = new URL(resolveImageUrl(value));
  if (url.pathname === "/api/public/media/cos") {
    return url.searchParams.get("url") || url.toString();
  }
  url.search = "";
  return url.toString();
}

async function readCatalog() {
  if (sourceFile) {
    const payload = JSON.parse(await readFile(sourceFile, "utf8"));
    return payload.catalog || payload.data || payload;
  }
  const response = await fetch(`${apiBaseUrl}/api/public/catalog?siteId=all`, {
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
  const payload = await response.json();
  return payload.catalog || payload.data || payload;
}

function compactBioRecord(record) {
  const value = {
    id: String(record?.id || ""),
    stockItemId: String(record?.stockItemId || ""),
    date: String(record?.date || "")
  };
  for (const key of ["text", "sourceType", "tankGroupName", "subTankName", "tankLocation", "operator"]) {
    const text = String(record?.[key] || "").trim();
    if (text) value[key] = text;
  }
  const photoCount = Array.isArray(record?.photos)
    ? record.photos.length
    : Math.max(0, Number(record?.photoCount) || 0);
  const videoCount = Array.isArray(record?.videos)
    ? record.videos.length
    : Math.max(0, Number(record?.videoCount) || 0);
  if (photoCount) value.photoCount = photoCount;
  if (videoCount) value.videoCount = videoCount;
  return value;
}

async function readBioRecords(catalog) {
  if (bioRecordsFile) {
    const payload = JSON.parse(await readFile(bioRecordsFile, "utf8"));
    return Array.isArray(payload) ? payload : Array.isArray(payload.bioRecords) ? payload.bioRecords : [];
  }

  const stockItemIds = [...new Set(
    (Array.isArray(catalog.stock) ? catalog.stock : [])
      .map((item) => String(item?.id || ""))
      .filter(Boolean)
  )];
  const records = [];
  const failures = [];
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < stockItemIds.length) {
      const stockItemId = stockItemIds[cursor];
      cursor += 1;
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/public/bio-records?siteId=all&stockItemId=${encodeURIComponent(stockItemId)}`,
          { signal: AbortSignal.timeout(30000) }
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (Array.isArray(payload.bioRecords)) records.push(...payload.bioRecords);
      } catch (error) {
        failures.push(`${stockItemId}: ${error.message}`);
      }
      completed += 1;
      if (completed % 100 === 0 || completed === stockItemIds.length) {
        console.log(`Loaded maintenance records for ${completed}/${stockItemIds.length} stock items`);
      }
    }
  }

  await Promise.all(Array.from({ length: 16 }, () => worker()));
  if (failures.length) {
    throw new Error(`Failed to load maintenance records (${failures.slice(0, 3).join(", ")})`);
  }
  return records;
}

async function createThumbnail(sourceUrl, outputPath, tempDir) {
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
  const sourcePath = path.join(tempDir, `${createHash("sha1").update(sourceUrl).digest("hex")}.source`);
  await writeFile(sourcePath, Buffer.from(await response.arrayBuffer()));
  const result = spawnSync("/usr/bin/sips", [
    "-Z", "160",
    "-s", "format", "jpeg",
    "-s", "formatOptions", "40",
    sourcePath,
    "--out", outputPath
  ], { stdio: "ignore" });
  if (result.status !== 0) throw new Error("Thumbnail conversion failed");
}

const catalog = structuredClone(await readCatalog());
const completeBioRecords = await readBioRecords(catalog);
const tempDir = await mkdtemp(path.join(tmpdir(), "fishroom-mini-fallback-"));
await rm(assetDir, { recursive: true, force: true });
await mkdir(assetDir, { recursive: true });

const localImageBySource = new Map();
let imageCount = 0;
for (const product of Array.isArray(catalog.products) ? catalog.products : []) {
  const source = String(product.imageUrl || "").trim();
  if (!source) continue;
  const stableKey = stableImageKey(source);
  let localPath = localImageBySource.get(stableKey);
  if (!localPath) {
    const fileName = `${createHash("sha1").update(stableKey).digest("hex").slice(0, 16)}.jpg`;
    const outputPath = path.join(assetDir, fileName);
    try {
      await createThumbnail(resolveImageUrl(source), outputPath, tempDir);
      localPath = `/assets/fallback-products/${fileName}`;
      localImageBySource.set(stableKey, localPath);
      imageCount += 1;
    } catch (error) {
      console.warn(`Skipped image for ${product.id}: ${error.message}`);
      localPath = "";
    }
  }
  product.imageUrl = localPath;
}

const firstProductImageBySpecies = new Map();
for (const product of Array.isArray(catalog.products) ? catalog.products : []) {
  if (product.imageUrl && !firstProductImageBySpecies.has(product.speciesId)) {
    firstProductImageBySpecies.set(product.speciesId, product.imageUrl);
  }
}
for (const species of Array.isArray(catalog.species) ? catalog.species : []) {
  species.imageUrl = firstProductImageBySpecies.get(species.id) || "";
  // The mini program does not render long species descriptions. Excluding them
  // keeps the offline catalog below the main-package size limit.
  delete species.description;
}
const uniqueBioRecords = new Map();
for (const record of completeBioRecords) {
  const compact = compactBioRecord(record);
  if (!compact.stockItemId || !compact.id) continue;
  uniqueBioRecords.set(`${compact.stockItemId}|${compact.id}`, compact);
}
catalog.bioRecords = [...uniqueBioRecords.values()].sort((a, b) =>
  a.date.localeCompare(b.date) || a.id.localeCompare(b.id)
);
for (const record of catalog.bioRecords) {
  // Record IDs are only list keys. The mini program recreates stable fallback
  // keys at runtime, avoiding thousands of non-user-facing IDs in the package.
  delete record.id;
}

const banner = "// Generated by scripts/generate-wechat-fallback.mjs. Do not edit manually.\n";
await writeFile(modulePath, `${banner}module.exports = ${JSON.stringify(catalog)};\n`, "utf8");
await rm(tempDir, { recursive: true, force: true });

console.log(JSON.stringify({
  images: imageCount,
  products: Array.isArray(catalog.products) ? catalog.products.length : 0,
  stock: Array.isArray(catalog.stock) ? catalog.stock.length : 0,
  bioRecords: catalog.bioRecords.length
}));
