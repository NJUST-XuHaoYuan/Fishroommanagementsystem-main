import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const localServerPath = fileURLToPath(new URL("./local-server.mjs", import.meta.url));
const pgLoaderPath = fileURLToPath(new URL("./test-support/pg-stub-loader.mjs", import.meta.url));

const databaseFixture = {
  revision: 91,
  state: {
    _publicCatalogPolicySchemaVersion: 1,
    sites: [
      { id: "nanjing", name: "南京" },
      { id: "jiangyin", name: "江阴" },
    ],
    personnel: [],
    tankGroups: [{
      id: "group-nj",
      siteId: "nanjing",
      name: "一号缸组",
      subTanks: [{ id: "tank-nj", name: "A1" }],
    }, {
      id: "group-jy",
      siteId: "jiangyin",
      name: "二号缸组",
      subTanks: [{ id: "tank-jy", name: "B1" }],
    }],
    speciesCategories: ["刺尾鱼科", "LPS 珊瑚", "虾虎鱼科"],
    speciesCategoryMajorMap: {
      刺尾鱼科: "marineFish",
      "LPS 珊瑚": "coral",
      虾虎鱼科: "marineFish",
    },
    publicCatalogPolicy: {
      hiddenMajorCategoryKeys: ["coral"],
      hiddenProductIds: ["hidden-product"],
      hiddenSpeciesIds: ["species-hidden"],
      productDisplayCaps: {
        "gold-tang": 1,
        "plain-tang": 1,
        "tie-tang": 1,
        "reservation-tang": 2,
      },
    },
    species: [
      { id: "species-gold", name: "黄金吊", category: "刺尾鱼科" },
      { id: "species-coral", name: "火炬珊瑚", category: "LPS 珊瑚" },
      { id: "species-hidden", name: "隐藏虾虎", category: "虾虎鱼科" },
    ],
    products: [
      {
        id: "gold-tang",
        speciesId: "species-gold",
        name: "黄金吊 5-7cm",
        publicVisible: false,
        defaultPrice: 680,
      },
      {
        id: "plain-tang",
        speciesId: "species-gold",
        name: "无维护记录黄金吊",
        publicVisible: true,
        defaultPrice: 620,
      },
      {
        id: "tie-tang",
        speciesId: "species-gold",
        name: "同刻维护记录黄金吊",
        publicVisible: true,
        defaultPrice: 720,
      },
      {
        id: "hidden-major-product",
        speciesId: "species-coral",
        name: "按类型隐藏的火炬",
        publicVisible: true,
        defaultPrice: 520,
      },
      {
        id: "hidden-species-product",
        speciesId: "species-hidden",
        name: "按物种隐藏的虾虎",
        publicVisible: true,
        defaultPrice: 320,
      },
      {
        id: "hidden-product",
        speciesId: "species-gold",
        name: "按商品隐藏的黄金吊",
        publicVisible: true,
        defaultPrice: 660,
      },
      {
        id: "eligibility-tang",
        speciesId: "species-gold",
        name: "公开资格边界黄金吊",
        publicVisible: true,
        defaultPrice: 610,
      },
      {
        id: "reservation-tang",
        speciesId: "species-gold",
        name: "订单占用边界黄金吊",
        publicVisible: true,
        defaultPrice: 640,
      },
      {
        id: "archived-tang",
        speciesId: "species-gold",
        name: "已停用黄金吊",
        publicVisible: true,
        archivedAt: "2026-09-05T12:00:00+08:00",
        defaultPrice: 600,
      },
    ],
    stock: [
      { id: "fish-new", productId: "gold-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy" },
      { id: "fish-old", productId: "gold-tang", siteId: "jiangyin", subTankId: "tank-jy", status: "healthy" },
      { id: "fish-none", productId: "gold-tang", siteId: "jiangyin", subTankId: "tank-jy", status: "healthy" },
      { id: "plain-first", productId: "plain-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy" },
      { id: "plain-second", productId: "plain-tang", siteId: "jiangyin", subTankId: "tank-jy", status: "healthy" },
      { id: "tie-a", productId: "tie-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy" },
      { id: "tie-b", productId: "tie-tang", siteId: "jiangyin", subTankId: "tank-jy", status: "healthy" },
      { id: "hidden-major-stock", productId: "hidden-major-product", siteId: "nanjing", subTankId: "tank-nj", status: "healthy" },
      { id: "hidden-species-stock", productId: "hidden-species-product", siteId: "nanjing", subTankId: "tank-nj", status: "healthy" },
      { id: "hidden-product-stock", productId: "hidden-product", siteId: "nanjing", subTankId: "tank-nj", status: "healthy" },
      { id: "sold-stock", productId: "eligibility-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy", sold: true },
      { id: "lost-stock", productId: "eligibility-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy", lost: true },
      { id: "shipped-stock", productId: "eligibility-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy" },
      { id: "reserved-active", productId: "reservation-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy", sold: false },
      { id: "released-cancelled", productId: "reservation-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy", sold: false },
      { id: "released-removed", productId: "reservation-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy", sold: false },
      { id: "archived-stock", productId: "archived-tang", siteId: "nanjing", subTankId: "tank-nj", status: "healthy" },
    ],
    orders: [
      {
        id: "active-reservation-order",
        siteId: "nanjing",
        status: "pending",
        items: [{ stockItemId: "reserved-active" }],
      },
      {
        id: "cancelled-reservation-order",
        siteId: "nanjing",
        status: "cancelled",
        items: [{ stockItemId: "released-cancelled" }],
      },
      {
        id: "removed-reservation-order",
        siteId: "nanjing",
        status: "pending",
        items: [{ stockItemId: "released-removed", inventoryRemovedAt: "2026-09-03T10:00:00+08:00" }],
      },
    ],
    shipments: [{
      id: "shipped-public-stock",
      siteId: "nanjing",
      status: "shipped",
      itemStockIds: ["shipped-stock"],
    }],
    bioRecords: [
      {
        id: "bio-new",
        stockItemId: "fish-new",
        date: "2026-09-04T12:00:00+08:00",
        text: "状态良好",
        photos: ["/uploads/fish-new.jpg"],
        videos: [],
      },
      {
        id: "bio-old",
        stockItemId: "fish-old",
        date: "2026-09-01T12:00:00+08:00",
        text: "较早记录",
        photos: ["/uploads/fish-old.jpg"],
        videos: [],
      },
      {
        id: "bio-tie-a",
        stockItemId: "tie-a",
        date: "2026-09-04T12:00:00+08:00",
        text: "同一时刻 A",
        photos: ["/uploads/tie-a.jpg"],
        videos: [],
      },
      {
        id: "bio-tie-b",
        stockItemId: "tie-b",
        date: "2026-09-04T04:00:00Z",
        text: "同一时刻 B",
        photos: [],
        videos: ["/uploads/tie-b.mp4"],
      },
      {
        id: "released-photo",
        stockItemId: "released-cancelled",
        date: "2026-09-01T09:00:00+08:00",
        text: "真实维护照片",
        photos: ["/uploads/released-cancelled.jpg"],
        videos: [],
      },
      {
        id: "released-video",
        stockItemId: "released-cancelled",
        date: "2026-09-02T09:00:00+08:00",
        text: "较新的维护视频",
        photos: [],
        videos: ["/uploads/released-cancelled.mp4"],
      },
    ],
  },
};

let child;
let baseUrl;
let uploadDir;
let childOutput = "";

async function unusedPort() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServerStart(process, timeoutMs = 10_000) {
  if (childOutput.includes("Local Fishroom API/static server:")) return;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdout.off("data", onStdout);
      process.off("exit", onExit);
      callback(value);
    };
    const onStdout = (chunk) => {
      if (String(chunk).includes("Local Fishroom API/static server:")) finish(resolve);
    };
    const onExit = (code, signal) => finish(reject, new Error(
      `local-server exited before listening (code=${code}, signal=${signal})\n${childOutput}`
    ));
    const timer = setTimeout(() => finish(reject, new Error(
      `timed out waiting for local-server\n${childOutput}`
    )), timeoutMs);
    process.stdout.on("data", onStdout);
    process.once("exit", onExit);
  });
}

async function publicGet(path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, body: await response.json() };
}

before(async () => {
  const port = await unusedPort();
  uploadDir = await mkdtemp(join(tmpdir(), "fishroom-public-policy-route-test-"));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [
    "--no-warnings",
    "--experimental-loader",
    pgLoaderPath,
    localServerPath,
  ], {
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      AUTH_SESSION_SECRET: "example-public-policy-route-integration-secret",
      UPLOAD_DIR: uploadDir,
      TRANSCODE_VIDEO_UPLOADS: "false",
      FISHROOM_TEST_DATABASE_FIXTURE_JSON: JSON.stringify(databaseFixture),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { childOutput += chunk; });
  child.stderr.on("data", (chunk) => { childOutput += chunk; });
  await waitForServerStart(child);
});

after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    let shutdownTimer;
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => { shutdownTimer = setTimeout(resolve, 2_000); }),
    ]);
    clearTimeout(shutdownTimer);
    if (child.exitCode === null && child.signalCode === null) {
      const forcedExit = once(child, "exit");
      child.kill("SIGKILL");
      await forcedExit;
    }
  }
  if (uploadDir) await rm(uploadDir, { recursive: true, force: true });
});

test("the public catalog exposes only the cap winner chosen by latest maintenance media", async () => {
  const { response, body } = await publicGet("/api/public/catalog?siteId=all");
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(body.ok, true);
  assert.deepEqual(
    body.catalog.stock.filter((item) => item.productId === "gold-tang").map((item) => item.id),
    ["fish-new"],
    JSON.stringify(body.catalog)
  );
  assert.deepEqual(
    body.catalog.bioRecords.filter((item) => item.stockItemId.startsWith("fish-")).map((item) => item.stockItemId),
    ["fish-new"]
  );
  assert.equal(body.catalog.products.some((item) => item.id === "gold-tang"), true);
  assert.equal(body.catalog.products.some((item) => item.id === "archived-tang"), false);
  assert.equal(body.catalog.stock.some((item) => item.id === "archived-stock"), false);
});

test("a compact video-only latest record retains the fish's newest real photo for its idle card", async () => {
  const { response, body } = await publicGet("/api/public/catalog?siteId=all");
  assert.equal(response.status, 200, JSON.stringify(body));
  const record = body.catalog.bioRecords.find((item) => item.stockItemId === "released-cancelled");
  assert.equal(record.id, "released-video");
  assert.deepEqual(record.photos, ["/uploads/released-cancelled.jpg"]);
  assert.deepEqual(record.videos, ["/uploads/released-cancelled.mp4"]);
  assert.match(record.videoPosters[0], /^\/api\/public\/media\/video-derivative\?/);
  assert.match(record.videoPreviews[0], /^\/api\/public\/media\/video-derivative\?/);
});

test("signed derivative delivery supports HEAD, Range and tamper rejection", async () => {
  const catalog = await publicGet("/api/public/catalog?siteId=all");
  const record = catalog.body.catalog.bioRecords.find(
    (item) => item.stockItemId === "released-cancelled"
  );
  const cacheId = createHash("sha256")
    .update("local:released-cancelled.mp4")
    .digest("hex");
  const posterPath = join(uploadDir, ".video-derived", "posters", `${cacheId}.jpg`);
  const previewPath = join(uploadDir, ".video-derived", "previews", `${cacheId}.mp4`);
  await Promise.all([
    mkdir(dirname(posterPath), { recursive: true }),
    mkdir(dirname(previewPath), { recursive: true }),
  ]);
  const poster = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  const preview = Buffer.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  await Promise.all([writeFile(posterPath, poster), writeFile(previewPath, preview)]);

  const posterHead = await fetch(`${baseUrl}${record.videoPosters[0]}`, { method: "HEAD" });
  assert.equal(posterHead.status, 200);
  assert.equal(posterHead.headers.get("content-type"), "image/jpeg");
  assert.equal(Number(posterHead.headers.get("content-length")), poster.length);

  const partial = await fetch(`${baseUrl}${record.videoPreviews[0]}`, {
    headers: { Range: "bytes=4-7" },
  });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 4-7/${preview.length}`);
  assert.equal(Buffer.from(await partial.arrayBuffer()).toString("ascii"), "ftyp");

  const invalidRange = await fetch(`${baseUrl}${record.videoPreviews[0]}`, {
    headers: { Range: "bytes=0-1,4-5" },
  });
  assert.equal(invalidRange.status, 416);

  const tampered = new URL(`${baseUrl}${record.videoPreviews[0]}`);
  tampered.searchParams.set("signature", `${tampered.searchParams.get("signature")}x`);
  const rejected = await fetch(tampered);
  assert.equal(rejected.status, 403);
});

test("encoded path normalization cannot bypass signed video-derivative delivery", async () => {
  const privatePreviewDir = join(uploadDir, ".video-derived", "previews");
  await mkdir(privatePreviewDir, { recursive: true });
  await writeFile(join(privatePreviewDir, "should-stay-private.mp4"), Buffer.from("private-preview"));
  const response = await fetch(
    `${baseUrl}/uploads/ignored/%2e%2e%2f.video-derived/previews/should-stay-private.mp4`
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Upload file not found");
});

test("a post-migration legacy false flag no longer hides a product, while archivedAt still does", async () => {
  const catalog = await publicGet("/api/public/catalog?siteId=all");
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
  assert.equal(catalog.body.catalog.products.some((item) => item.id === "gold-tang"), true);

  const archived = await publicGet(
    "/api/public/bio-records?siteId=all&stockItemId=archived-stock"
  );
  assert.equal(archived.response.status, 404, JSON.stringify(archived.body));
  assert.equal(archived.response.headers.get("cache-control"), "no-store");
});

test("the public detail route returns the cap winner and rejects a capped-out sibling", async () => {
  const visible = await publicGet("/api/public/bio-records?siteId=all&stockItemId=fish-new");
  assert.equal(visible.response.status, 200, JSON.stringify(visible.body));
  assert.equal(visible.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(visible.body.bioRecords.map((record) => record.id), ["bio-new"]);

  const cappedOut = await publicGet("/api/public/bio-records?siteId=all&stockItemId=fish-old");
  assert.equal(cappedOut.response.status, 404, JSON.stringify(cappedOut.body));
  assert.equal(cappedOut.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(cappedOut.body, { ok: false, error: "Stock item is not public" });
});

test("public detail validation errors are also non-cacheable", async () => {
  const invalid = await publicGet("/api/public/bio-records?siteId=all");
  assert.equal(invalid.response.status, 400, JSON.stringify(invalid.body));
  assert.equal(invalid.response.headers.get("cache-control"), "no-store");
});

test("a caller cannot enumerate extra capped stock by requesting each site separately", async () => {
  const nanjing = await publicGet("/api/public/catalog?siteId=nanjing");
  assert.equal(nanjing.response.status, 200, JSON.stringify(nanjing.body));
  assert.deepEqual(
    nanjing.body.catalog.stock.filter((item) => item.productId === "gold-tang").map((item) => item.id),
    ["fish-new"]
  );

  const jiangyin = await publicGet("/api/public/catalog?siteId=jiangyin");
  assert.equal(jiangyin.response.status, 200, JSON.stringify(jiangyin.body));
  assert.deepEqual(
    jiangyin.body.catalog.stock.filter((item) => item.productId === "gold-tang"),
    []
  );

  const directLoser = await publicGet(
    "/api/public/bio-records?siteId=jiangyin&stockItemId=fish-old"
  );
  assert.equal(directLoser.response.status, 404, JSON.stringify(directLoser.body));
});

test("the no-media cap uses stable inventory order and rejects every loser detail", async () => {
  const { response, body } = await publicGet("/api/public/catalog?siteId=all");
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(
    body.catalog.stock.filter((item) => item.productId === "plain-tang").map((item) => item.id),
    ["plain-first"]
  );

  const winner = await publicGet("/api/public/bio-records?siteId=all&stockItemId=plain-first");
  assert.equal(winner.response.status, 200, JSON.stringify(winner.body));
  assert.deepEqual(winner.body.bioRecords, []);

  const loser = await publicGet("/api/public/bio-records?siteId=all&stockItemId=plain-second");
  assert.equal(loser.response.status, 404, JSON.stringify(loser.body));
});

test("equivalent media instants share a stable tie group and only its winner detail is public", async () => {
  const firstCatalog = await publicGet("/api/public/catalog?siteId=all");
  assert.equal(firstCatalog.response.status, 200, JSON.stringify(firstCatalog.body));
  const firstWinnerIds = firstCatalog.body.catalog.stock
    .filter((item) => item.productId === "tie-tang")
    .map((item) => item.id);
  assert.equal(firstWinnerIds.length, 1, JSON.stringify(firstCatalog.body.catalog));

  const secondCatalog = await publicGet("/api/public/catalog?siteId=all");
  assert.equal(secondCatalog.response.status, 200, JSON.stringify(secondCatalog.body));
  assert.deepEqual(
    secondCatalog.body.catalog.stock
      .filter((item) => item.productId === "tie-tang")
      .map((item) => item.id),
    firstWinnerIds
  );

  const winnerId = firstWinnerIds[0];
  const loserId = winnerId === "tie-a" ? "tie-b" : "tie-a";
  const winner = await publicGet(`/api/public/bio-records?siteId=all&stockItemId=${winnerId}`);
  assert.equal(winner.response.status, 200, JSON.stringify(winner.body));
  assert.deepEqual(winner.body.bioRecords.map((record) => record.stockItemId), [winnerId]);

  const loser = await publicGet(`/api/public/bio-records?siteId=all&stockItemId=${loserId}`);
  assert.equal(loser.response.status, 404, JSON.stringify(loser.body));
});

test("direct detail cannot bypass major-type, species, or product hiding", async () => {
  for (const stockItemId of [
    "hidden-major-stock",
    "hidden-species-stock",
    "hidden-product-stock",
  ]) {
    const hidden = await publicGet(
      `/api/public/bio-records?siteId=all&stockItemId=${stockItemId}`
    );
    assert.equal(hidden.response.status, 404, `${stockItemId}: ${JSON.stringify(hidden.body)}`);
    assert.equal(hidden.response.headers.get("cache-control"), "no-store");
  }
});

test("direct detail keeps sold, lost, and shipped inventory private", async () => {
  for (const stockItemId of ["sold-stock", "lost-stock", "shipped-stock"]) {
    const hidden = await publicGet(
      `/api/public/bio-records?siteId=all&stockItemId=${stockItemId}`
    );
    assert.equal(hidden.response.status, 404, `${stockItemId}: ${JSON.stringify(hidden.body)}`);
  }
});

test("active-order inventory is hidden even with sold=false while cancelled and removed items refill", async () => {
  const catalog = await publicGet("/api/public/catalog?siteId=all");
  assert.equal(catalog.response.status, 200, JSON.stringify(catalog.body));
  assert.deepEqual(
    catalog.body.catalog.stock
      .filter((item) => item.productId === "reservation-tang")
      .map((item) => item.id),
    ["released-cancelled", "released-removed"]
  );

  const reserved = await publicGet(
    "/api/public/bio-records?siteId=all&stockItemId=reserved-active"
  );
  assert.equal(reserved.response.status, 404, JSON.stringify(reserved.body));

  for (const stockItemId of ["released-cancelled", "released-removed"]) {
    const released = await publicGet(
      `/api/public/bio-records?siteId=all&stockItemId=${stockItemId}`
    );
    assert.equal(released.response.status, 200, `${stockItemId}: ${JSON.stringify(released.body)}`);
    assert.deepEqual(
      released.body.bioRecords.map((record) => record.id),
      stockItemId === "released-cancelled" ? ["released-photo", "released-video"] : []
    );
  }
});
