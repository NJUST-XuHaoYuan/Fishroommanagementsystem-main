import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
const mediaSource = await readFile(new URL("../src/app/utils/media.ts", import.meta.url), "utf8");
const dailySource = await readFile(new URL("../src/app/components/DailyView.tsx", import.meta.url), "utf8");
const ordersSource = await readFile(new URL("../src/app/components/OrdersView.tsx", import.meta.url), "utf8");

function routeBlock(path) {
  const marker = `if (url.pathname === "${path}"`;
  const start = serverSource.indexOf(marker);
  assert.notEqual(start, -1, `missing route ${path}`);
  const remaining = serverSource.slice(start + marker.length);
  const nextMatch = /\n\s+if \(url\.pathname === /.exec(remaining);
  const nextRoute = nextMatch ? start + marker.length + nextMatch.index : -1;
  return serverSource.slice(start, nextRoute === -1 ? serverSource.length : nextRoute);
}

test("bio media download signs only an exact authorized record reference", () => {
  const block = routeBlock("/api/bio-records/media-download-url");
  assert.match(block, /requireBioRecordMediaDownloadAccess/);
  assert.match(block, /stockItemId/);
  assert.match(block, /recordId/);
  assert.match(block, /mediaType/);
  assert.match(block, /response-content-disposition/);
  assert.match(block, /expires:\s*5 \* 60/);
  assert.match(block, /Cache-Control": "no-store, private/);

  const authorizationStart = serverSource.indexOf("async function requireBioRecordMediaDownloadAccess");
  const authorizationEnd = serverSource.indexOf("\nfunction imagePreviewQuery", authorizationStart);
  const authorization = serverSource.slice(authorizationStart, authorizationEnd);
  assert.match(authorization, /target_stock AS MATERIALIZED/);
  assert.match(authorization, /target_record AS MATERIALIZED/);
  assert.match(authorization, /record_item ->> 'stockItemId'/);
  assert.match(authorization, /matchingTankGroups\.length > 1/);
  assert.match(authorization, /tankSiteId !== directSiteId/);
  assert.match(authorization, /matchingSites\.length !== 1/);
  assert.match(authorization, /canAccessBioStockSite/);
  assert.match(authorization, /record\[field\].*some/);
});

test("local media supports attachment downloads and byte ranges without buffering the full file", () => {
  const start = serverSource.indexOf("async function serveUpload");
  const end = serverSource.indexOf("\nlet autoOrderTransitionTimer", start);
  const block = serverSource.slice(start, end);
  assert.match(block, /Content-Disposition/);
  assert.match(block, /Accept-Ranges/);
  assert.match(block, /Content-Range/);
  assert.match(block, /Content-Length/);
  assert.match(block, /createReadStream\(finalPath, \{ start, end \}\)\.pipe\(res\)/);
  assert.match(block, /res\.writeHead\(416/);
});

test("record video downloads use a direct authorized URL instead of the Blob path", () => {
  assert.match(mediaSource, /authorizedBioMediaDownloadUrl/);
  assert.match(mediaSource, /\/api\/bio-records\/media-download-url/);
  assert.match(mediaSource, /stockItemId/);
  assert.match(mediaSource, /recordId/);
  assert.match(mediaSource, /mobileWindow\.location\.replace\(downloadUrl\)/);
  assert.match(mediaSource, /platform === "MacIntel"/);
  assert.match(mediaSource, /useMobileWindow && !mobileWindow/);
  assert.match(mediaSource, /当前浏览器阻止打开下载页/);
  for (const source of [dailySource, ordersSource]) {
    assert.match(source, /min-h-11/);
    assert.match(source, /保存视频/);
    assert.match(source, /recordId:/);
    assert.doesNotMatch(source, /video-[^\n]+mediaType: "video" \}\)/);
  }
});
