const text = value => String(value ?? "").trim();

/** Cloud test must never silently fall back to the production database. */
export function validateCloudTestEnvironment(env = process.env) {
  const enabled = env.FISHROOM_CLOUD_TEST === "true";
  if (!enabled) return false;
  if (env.PGHOST !== "database" || env.PGDATABASE !== "fishroom_test" || env.PGUSER !== "fishroom_test" ||
      text(env.DATABASE_URL) || text(env.PGHOSTADDR) || (text(env.PGPORT) && text(env.PGPORT) !== "5432")) {
    throw new Error("CLOUD_TEST_DATABASE_TARGET_REFUSED");
  }
  return true;
}

const anonymousRoutes = new Set([
  "POST /api/auth/login", "POST /api/auth/logout", "GET /api/health", "GET /api/version",
]);

/** Public media handlers normally set public caches. Never cache a private test copy. */
function privateResponse(res) {
  const writeHead = res.writeHead;
  res.writeHead = function (statusCode, reasonOrHeaders, headers) {
    const reason = typeof reasonOrHeaders === "string" ? reasonOrHeaders : undefined;
    const supplied = reason ? headers : reasonOrHeaders;
    const pairs = Array.isArray(supplied)
      ? Array.from({ length: Math.floor(supplied.length / 2) }, (_, index) => [supplied[index * 2], supplied[index * 2 + 1]])
      : Object.entries(supplied || {});
    const clean = Object.fromEntries(pairs.filter(([key]) => !/^access-control-/i.test(key) && !/^cache-control$/i.test(key)));
    for (const key of res.getHeaderNames()) if (/^access-control-/i.test(key)) res.removeHeader(key);
    clean["Cache-Control"] = "no-store, private";
    return reason ? writeHead.call(this, statusCode, reason, clean) : writeHead.call(this, statusCode, clean);
  };
}

/** Runs before API dispatch, including Mini Program auth and public media handlers. */
export function createCloudTestRequestGuard({ enabled, authenticate, sendJson }) {
  return async (req, res, url) => {
    if (!enabled || (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/uploads/"))) return false;
    privateResponse(res);
    // Preflight contains no protected data; do not grant cross-origin access.
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return true; }
    if (anonymousRoutes.has(`${req.method} ${url.pathname}`)) return false;
    const auth = req.auth || await authenticate(req);
    if (!auth) {
      sendJson(req, res, 401, { ok: false, error: "请先登录云端测试环境", code: "CLOUD_TEST_AUTH_REQUIRED" });
      return true;
    }
    req.auth = auth;
    return false;
  };
}
