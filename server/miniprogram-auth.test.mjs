import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createMiniProgramAuth, exchangeMiniProgramCode, MINI_PRIVACY_VERSION } from "./miniprogram-auth.mjs";

const config = { appId: "wx1111111111111111", appSecret: "test-secret", identitySecret: "test-only-stable-identity-secret-000" };
const request = (path, method = "GET", headers = {}, body = {}) => [{ method, headers, body, socket: { remoteAddress: "127.0.0.1" } }, new URL(path, "https://example.test")];
const noDatabase = { connect() { throw new Error("must not connect"); } };
const readBody = async (req) => JSON.stringify(req.body);

test("code exchange only returns OpenID; rejects expired codes and suppresses upstream secrets", async () => {
  const args = { ...config, code: "temporarycode", fetchImpl: async (url, options) => {
    assert.equal(url.origin, "https://api.weixin.qq.com");
    assert.equal(url.searchParams.get("js_code"), "temporarycode");
    assert.equal(options.redirect, "error");
    return { ok: true, json: async () => ({ openid: "openid-test123", session_key: "never-return", unionid: "never-collect" }) };
  } };
  assert.equal(await exchangeMiniProgramCode(args), "openid-test123");
  for (const errcode of [40029, 40163]) {
    await assert.rejects(exchangeMiniProgramCode({ ...args, fetchImpl: async () => ({ ok: true, json: async () => ({ errcode }) }) }), { status: 400 });
  }
  await assert.rejects(exchangeMiniProgramCode({ ...args, fetchImpl: async () => { throw new Error("secret-code-and-url"); } }),
    (error) => error.status === 502 && !error.message.includes("secret"));
  for (const data of [{ errcode: 40013, errmsg: "secret" }, {}, { openid: {} }, { openid: "bad" }]) {
    await assert.rejects(exchangeMiniProgramCode({ ...args, fetchImpl: async () => ({ ok: true, json: async () => data }) }), { status: 502 });
  }
});

test("unconfigured login fails honestly and never creates fake accounts", async () => {
  const api = createMiniProgramAuth({ pool: noDatabase, readBody });
  assert.equal((await api.handle(...request("/api/mini/config"))).body.loginEnabled, false);
  assert.equal((await api.handle(...request("/api/mini/login", "POST"))).status, 503);
  assert.equal(await api.handle(...request("/api/orders")), null);
  assert.equal((await api.handle(...request("/api/mini/orders"))).status, 404);
});

test("requests need consent, a valid one-time code and JSON; staff cookies/tokens cannot authenticate customers", async () => {
  const api = createMiniProgramAuth({ ...config, pool: noDatabase, readBody });
  assert.equal((await api.handle(...request("/api/mini/login", "POST"))).status, 415);
  for (const body of [{}, { code: "validcode" }, { code: {}, privacyVersion: MINI_PRIVACY_VERSION }, { code: "bad", privacyVersion: MINI_PRIVACY_VERSION }]) {
    assert.equal((await api.handle(...request("/api/mini/login", "POST", { "content-type": "application/json" }, body))).status, 400);
  }
  for (const headers of [{}, { cookie: "fishroom_auth=staff" }, { authorization: "Bearer admin-token.signature" }]) {
    assert.equal((await api.handle(...request("/api/mini/session", "GET", headers))).status, 401);
    assert.equal((await api.handle(...request("/api/mini/account/delete", "POST", headers))).status, 401);
  }
  assert.equal((await api.handle(...request("/api/mini/account/delete", "GET"))).status, 404);
});

test("login rate limits ignore spoofed forwarding headers, and recover in next window", async () => {
  let time = 60000;
  const api = createMiniProgramAuth({ pool: noDatabase, readBody, now: () => time });
  for (let i = 0; i < 30; i++) assert.equal((await api.handle(...request("/api/mini/login", "POST", { "x-forwarded-for": String(i) }))).status, 503);
  assert.equal((await api.handle(...request("/api/mini/login", "POST"))).status, 429);
  time += 60000;
  assert.equal((await api.handle(...request("/api/mini/login", "POST"))).status, 503);
});

test("public customer routes are dispatched separately, before any staff authentication or full state initialization", async () => {
  const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async function handleApi"));
  assert.ok(handler.indexOf("miniProgramAuth.handle(req, url)") < handler.indexOf("authenticateApiRequest(req)"));
  assert.ok(handler.indexOf("miniProgramAuth.handle(req, url)") < handler.indexOf("await ensureSchema()"));
  assert.match(handler, /miniResponse\.headers\);\s*return;/);
  assert.match(source, /payload\.username/);
});

test("real Postgres login, repeat login, tenant isolation, revocation, expiration and account deletion", {
  skip: !process.env.FISHROOM_TEST_MINI_BACKEND,
}, async () => {
  const source = await readFile(new URL("./miniprogram-auth.mjs", import.meta.url), "utf8");
  const script = `
    import pg from 'pg';
    import assert from 'node:assert/strict';
    const {createMiniProgramAuth, MINI_PRIVACY_VERSION, MINI_SESSION_TTL_MS} = await import('data:text/javascript;base64,${Buffer.from(source).toString("base64")}');
    const schema = 'mini_auth_test_' + Date.now();
    const base = process.env.DATABASE_URL ? {connectionString: process.env.DATABASE_URL} : {
      host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER,
      password: process.env.PGPASSWORD, database: process.env.PGDATABASE
    };
    const admin = new pg.Pool(base);
    await admin.query('CREATE SCHEMA ' + schema);
    const pool = new pg.Pool({...base, options: '-c search_path=' + schema});
    try {
      let time = Date.now();
      const options = {...${JSON.stringify(config)}, pool, now:()=>time, readBody:async(req)=>JSON.stringify(req.body),
        fetchImpl:async()=>({ok:true,json:async()=>({openid:'openid-real-fixture',session_key:'secret-upstream-key'})})};
      const api = createMiniProgramAuth(options);
      async function call(path, method='GET', token='', body={}) {
        return api.handle({method,headers:{'content-type':'application/json',authorization:'Bearer '+token},body,socket:{remoteAddress:'local'}},new URL('https://example.test/api/mini/'+path));
      }
      const first = await call('login','POST','',{code:'unique-code-first',privacyVersion:MINI_PRIVACY_VERSION});
      assert.equal(first.status,200,JSON.stringify(first));
      assert.ok(!JSON.stringify(first).includes('openid') && !JSON.stringify(first).includes('session_key'));
      const token = first.body.token;
      assert.equal((await call('session','GET',token)).body.customer.id,first.body.customer.id);
      const second = await call('login','POST','',{code:'unique-code-second',privacyVersion:MINI_PRIVACY_VERSION});
      assert.equal(second.body.customer.id,first.body.customer.id);
      const stored = await pool.query('SELECT * FROM mini_customer_sessions');
      assert.equal(stored.rowCount,2);
      assert.ok(!JSON.stringify(stored.rows).includes(token));
      const otherApp = createMiniProgramAuth({...options,appId:'wx2222222222222222'});
      const denied = await otherApp.handle({method:'GET',headers:{authorization:'Bearer '+token}},new URL('https://example.test/api/mini/session'));
      assert.equal(denied.status,401);
      assert.equal((await call('logout','POST',token)).status,200);
      assert.equal((await call('session','GET',token)).status,401);
      assert.equal((await call('session','GET',second.body.token)).status,200);
      assert.equal((await call('account/delete','POST',second.body.token)).status,200);
      assert.equal((await pool.query('SELECT * FROM mini_customers')).rowCount,0);
      assert.equal((await pool.query('SELECT * FROM mini_customer_sessions')).rowCount,0);
      const tokens=[];
      for(let i=0;i<7;i++) tokens.push((await call('login','POST','',{code:'unique-code-'+i,privacyVersion:MINI_PRIVACY_VERSION})).body.token);
      assert.equal((await pool.query('SELECT * FROM mini_customer_sessions')).rowCount,5);
      assert.equal((await call('session','GET',tokens[0])).status,401);
      assert.equal((await call('session','GET',tokens[6])).status,200);
      time += MINI_SESSION_TTL_MS + 1;
      assert.equal((await call('session','GET',tokens[6])).status,401);
      console.log('Postgres customer auth lifecycle passed');
    } finally {
      await pool.end();
      await admin.query('DROP SCHEMA '+schema+' CASCADE');
      await admin.end();
    }
  `;
  const output = execFileSync("docker", ["exec", "-i", "-w", "/app", process.env.FISHROOM_TEST_MINI_BACKEND, "node", "--input-type=module"], { input: script, timeout: 30000 });
  assert.match(output.toString(), /lifecycle passed/);
});
