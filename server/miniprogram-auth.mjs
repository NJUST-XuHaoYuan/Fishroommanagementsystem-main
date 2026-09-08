import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

export const MINI_PRIVACY_VERSION = "2026-09-09";
export const MINI_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class MiniAuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export const MINI_AUTH_SCHEMA = `
  CREATE TABLE IF NOT EXISTS mini_customers (
    id UUID PRIMARY KEY,
    app_id TEXT NOT NULL,
    identity_hash TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (app_id, identity_hash)
  );
  CREATE TABLE IF NOT EXISTS mini_customer_sessions (
    token_hash TEXT PRIMARY KEY,
    customer_id UUID NOT NULL REFERENCES mini_customers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mini_customer_sessions_customer_idx
    ON mini_customer_sessions (customer_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS mini_customer_sessions_expiry_idx
    ON mini_customer_sessions (expires_at);
`;

const hashToken = (token) => createHash("sha256").update(token).digest("hex");
const customerView = (id) => ({ id, label: `访客 ${id.replaceAll("-", "").slice(0, 8).toUpperCase()}` });

export async function exchangeMiniProgramCode({ appId, appSecret, code, fetchImpl = fetch }) {
  const url = new URL("https://api.weixin.qq.com/sns/jscode2session");
  url.search = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: "authorization_code" });
  let data;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: "error" });
    if (!response.ok) throw new Error("upstream unavailable");
    data = await response.json();
  } catch (_) {
    // Never expose the request URL, credential, code, session_key or upstream error.
    throw new MiniAuthError(502, "微信登录服务暂时不可用，请稍后重试");
  }
  if ([40029, 40163].includes(Number(data.errcode))) {
    throw new MiniAuthError(400, "微信登录已失效，请重新点击登录");
  }
  if (Number(data.errcode) || typeof data.openid !== "string" || !/^[A-Za-z0-9_-]{10,128}$/.test(data.openid)) {
    throw new MiniAuthError(502, "微信登录暂未完成，请稍后重试");
  }
  return data.openid;
}

// Customer identities and opaque sessions are separate from staff accounts,
// staff cookies, app_state, orders and management permissions.
export function createMiniProgramAuth({ pool, appId = "", appSecret = "", identitySecret = "", readBody,
  fetchImpl = fetch, now = Date.now }) {
  const configured = /^wx[0-9a-f]{16}$/.test(appId) && Boolean(appSecret) && identitySecret.length >= 32;
  let schemaPromise;
  let rateWindow = 0;
  let totalAttempts = 0;
  const addressAttempts = new Map();
  const pendingCodes = new Set();

  async function ensureSchema() {
    if (!schemaPromise) schemaPromise = (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(732684120)");
        await client.query(MINI_AUTH_SCHEMA);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    })().catch((error) => { schemaPromise = null; throw error; });
    return schemaPromise;
  }

  function limitLogin(req) {
    const window = Math.floor(now() / 60000);
    if (window !== rateWindow) {
      rateWindow = window; totalAttempts = 0; addressAttempts.clear();
    }
    // Do not trust caller-supplied X-Forwarded-For. The global bound also limits
    // cardinality when deployed without a reverse proxy.
    const address = req.socket?.remoteAddress || "unknown";
    const attempts = (addressAttempts.get(address) || 0) + 1;
    if (++totalAttempts > 120 || attempts > 30) throw new MiniAuthError(429, "登录请求较多，请一分钟后重试");
    addressAttempts.set(address, attempts);
  }

  function readToken(req) {
    const match = /^Bearer (mfs_[A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || "");
    if (!match) throw new MiniAuthError(401, "请先微信登录");
    return hashToken(match[1]);
  }

  async function session(req) {
    const tokenHash = readToken(req);
    await ensureSchema();
    const { rows } = await pool.query(`
      SELECT c.id, s.expires_at FROM mini_customer_sessions s
      JOIN mini_customers c ON c.id = s.customer_id
      WHERE s.token_hash = $1 AND c.app_id = $2 AND s.expires_at > $3`,
    [tokenHash, appId, new Date(now())]);
    if (!rows[0]) throw new MiniAuthError(401, "登录已过期，请重新登录");
    return { tokenHash, id: rows[0].id, expiresAt: new Date(rows[0].expires_at).getTime() };
  }

  async function login(req) {
    limitLogin(req);
    if (!configured) throw new MiniAuthError(503, "微信登录尚未开通，仍可浏览鱼单和咨询客服");
    if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) {
      throw new MiniAuthError(415, "登录请求格式不正确");
    }
    let body;
    try { body = JSON.parse(await readBody(req, 1024)); }
    catch (_) { throw new MiniAuthError(400, "登录请求格式不正确"); }
    if (body?.privacyVersion !== MINI_PRIVACY_VERSION) throw new MiniAuthError(400, "请先阅读并同意最新的隐私说明");
    if (typeof body.code !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.code)) {
      throw new MiniAuthError(400, "微信登录凭证无效，请重新登录");
    }
    const codeHash = hashToken(body.code);
    if (pendingCodes.has(codeHash)) throw new MiniAuthError(409, "登录正在处理，请勿重复提交");
    pendingCodes.add(codeHash);
    try {
      const openId = await exchangeMiniProgramCode({ appId, appSecret, code: body.code, fetchImpl });
      const identityHash = createHmac("sha256", identitySecret).update(`mini-customer-v1:${appId}:${openId}`).digest("hex");
      const token = `mfs_${randomBytes(32).toString("base64url")}`;
      const expiresAt = now() + MINI_SESSION_TTL_MS;
      await ensureSchema();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const { rows } = await client.query(`
          INSERT INTO mini_customers (id, app_id, identity_hash, consent_version)
          VALUES ($1, $2, $3, $4) ON CONFLICT (app_id, identity_hash)
          DO UPDATE SET last_login_at = now(), consent_version = EXCLUDED.consent_version RETURNING id`,
        [randomUUID(), appId, identityHash, MINI_PRIVACY_VERSION]);
        const id = rows[0].id;
        await client.query("DELETE FROM mini_customer_sessions WHERE expires_at <= $1", [new Date(now())]);
        await client.query("INSERT INTO mini_customer_sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, $3)",
          [hashToken(token), id, new Date(expiresAt)]);
        await client.query(`DELETE FROM mini_customer_sessions WHERE customer_id = $1 AND token_hash NOT IN (
          SELECT token_hash FROM mini_customer_sessions WHERE customer_id = $1
          ORDER BY created_at DESC, token_hash DESC LIMIT 5)`, [id]);
        await client.query("COMMIT");
        return { token, expiresAt, customer: customerView(id) };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    } finally { pendingCodes.delete(codeHash); }
  }

  async function handle(req, url) {
    const path = url.pathname;
    if (!path.startsWith("/api/mini/")) return null;
    const reply = (status, body) => ({ status, body, headers: { "Cache-Control": "no-store" } });
    try {
      if (path === "/api/mini/config" && req.method === "GET") {
        return reply(200, { ok: true, loginEnabled: configured, privacyVersion: MINI_PRIVACY_VERSION });
      }
      if (path === "/api/mini/login" && req.method === "POST") {
        return reply(200, { ok: true, ...await login(req) });
      }
      if (path === "/api/mini/session" && req.method === "GET") {
        const current = await session(req);
        return reply(200, { ok: true, customer: customerView(current.id), expiresAt: current.expiresAt });
      }
      if (path === "/api/mini/logout" && req.method === "POST") {
        const tokenHash = readToken(req);
        await ensureSchema();
        await pool.query(`DELETE FROM mini_customer_sessions s USING mini_customers c
          WHERE s.customer_id = c.id AND c.app_id = $1 AND s.token_hash = $2`, [appId, tokenHash]);
        return reply(200, { ok: true });
      }
      if (path === "/api/mini/account/delete" && req.method === "POST") {
        const current = await session(req);
        await pool.query("DELETE FROM mini_customers WHERE id = $1 AND app_id = $2", [current.id, appId]);
        return reply(200, { ok: true });
      }
      return reply(404, { ok: false, error: "接口不存在" });
    } catch (error) {
      return reply(error instanceof MiniAuthError ? error.status : 503,
        { ok: false, error: error instanceof MiniAuthError ? error.message : "账号服务暂时不可用，请稍后重试" });
    }
  }
  return { handle };
}
