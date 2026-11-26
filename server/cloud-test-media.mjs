import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

const MAX_MAP_BYTES = 32 * 1024 * 1024;
const MAX_MAP_ENTRIES = 50_000;
const fail = (message, statusCode = 503) => { throw Object.assign(new Error(message), { statusCode }); };
const validCosHost = host => /^[a-z0-9][a-z0-9-]*-\d+\.cos\.[a-z0-9-]+\.myqcloud\.com$/i.test(host);

function mediaUrl(value) {
  if (typeof value !== "string" || !value || value.length > 16_384 || /[\u0000-\u0020\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || !validCosHost(url.hostname)) return null;
    return url;
  } catch { return null; }
}

function parseMap(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { fail("测试环境历史媒体索引暂不可用"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Number.isFinite(Date.parse(parsed.generatedAt)) ||
      !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) fail("测试环境历史媒体索引格式不正确");
  const entries = Object.entries(parsed.entries);
  if (entries.length > MAX_MAP_ENTRIES) fail("测试环境历史媒体索引超过限制");
  const validated = new Map();
  for (const [source, entry] of entries) {
    const original = mediaUrl(source), signed = mediaUrl(entry?.url);
    if (!original || !signed || original.hostname !== signed.hostname || original.pathname !== signed.pathname ||
        typeof entry.expiresAt !== "number" || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= 0) {
      fail("测试环境历史媒体索引含无效地址");
    }
    validated.set(source, { url: entry.url, expiresAt: entry.expiresAt });
  }
  return validated;
}

/** Read-only signed GET links supplied by the host; no COS credentials or network writes. */
export function createCloudTestMediaResolver({ path, now = Date.now }) {
  let cachedStamp = "", cachedEntries = new Map();
  return async source => {
    if (!mediaUrl(source)) fail("历史媒体地址不在测试副本中", 404);
    let info;
    try { info = await lstat(path); } catch { fail("测试环境历史媒体索引尚未就绪"); }
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_MAP_BYTES) fail("测试环境历史媒体索引不可用");
    const stamp = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    if (stamp !== cachedStamp) {
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const actual = await file.stat();
        if (!actual.isFile() || actual.size <= 0 || actual.size > MAX_MAP_BYTES) fail("测试环境历史媒体索引不可用");
        const raw = await file.readFile("utf8");
        if (Buffer.byteLength(raw) > MAX_MAP_BYTES) fail("测试环境历史媒体索引超过限制");
        cachedEntries = parseMap(raw);
        cachedStamp = `${actual.ino}:${actual.mtimeMs}:${actual.ctimeMs}:${actual.size}`;
      } catch (error) {
        if (error.statusCode) throw error;
        fail("测试环境历史媒体索引暂不可用");
      } finally { await file?.close(); }
    }
    const entry = cachedEntries.get(source);
    if (!entry) fail("这份测试副本没有对应历史媒体", 404);
    const expiresIn = Math.floor((entry.expiresAt - now()) / 1000);
    if (expiresIn < 60) fail("历史媒体查看链接已过期，请刷新测试环境媒体索引");
    return { url: entry.url, expiresIn };
  };
}
