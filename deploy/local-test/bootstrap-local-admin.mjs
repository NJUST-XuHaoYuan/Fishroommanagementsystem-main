import { randomBytes, scryptSync } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { missingPersonnelRecordFields } from "../../server/personnel-rules.mjs";

export const LOCAL_ADMIN_ID = "local-test-admin";
const modules = ["species", "products", "tankGroups", "batches", "stockIn", "daily", "lossRecords", "customers", "orders", "finance", "accounts"];
const text = value => String(value ?? "").trim();
const fail = code => { throw Object.assign(new Error(code), { safeCode: code }); };

/** Reject alternate targets before constructing a database client. */
export function localTestDatabaseOptions(env = process.env) {
  if (env.PGHOST !== "database" || env.PGDATABASE !== "fishroom_test" || text(env.DATABASE_URL) || text(env.PGHOSTADDR) ||
      (text(env.PGPORT) && text(env.PGPORT) !== "5432")) fail("LOCAL_TEST_DATABASE_TARGET_REFUSED");
  if (env.PGUSER !== "fishroom_test" || !text(env.PGPASSWORD)) fail("LOCAL_TEST_DATABASE_CREDENTIALS_REQUIRED");
  return { host: "database", port: 5432, database: "fishroom_test", user: "fishroom_test", password: env.PGPASSWORD,
    ssl: false, connectionTimeoutMillis: 10000, application_name: "fishroom-local-test-maintenance" };
}

export function validateLocalCredentials(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.username !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value.username) || typeof value.password !== "string" ||
      value.password.length < 12 || value.password.length > 512) fail("LOCAL_TEST_LOGIN_FILE_INVALID");
  return { username: value.username, password: value.password };
}

export function planLocalAdministrator(state, rawCredentials, { now = new Date(), salt = randomBytes(16).toString("base64url") } = {}) {
  const credentials = validateLocalCredentials(rawCredentials);
  if (!state || typeof state !== "object" || !Array.isArray(state.personnel) || !Array.isArray(state.sites)) fail("LOCAL_TEST_COPY_SCHEMA_INVALID");
  const existing = state.personnel.filter(person => text(person?.id) === LOCAL_ADMIN_ID);
  if (existing.length > 1 || (existing.length && existing[0].localTestAccount !== true)) fail("LOCAL_TEST_ADMIN_ID_CONFLICT");
  const usernameKey = value => text(value).normalize("NFKC").toLowerCase();
  if (state.personnel.some(person => text(person?.id) !== LOCAL_ADMIN_ID &&
      usernameKey(person?.username) === usernameKey(credentials.username))) fail("LOCAL_TEST_USERNAME_CONFLICT");
  if ((Array.isArray(state.retiredPersonnelUsernames) ? state.retiredPersonnelUsernames : [])
    .some(value => usernameKey(typeof value === "string" ? value : value?.username) === usernameKey(credentials.username))) fail("LOCAL_TEST_USERNAME_RETIRED");
  if (state.personnel.some(person => text(person?.id) !== LOCAL_ADMIN_ID && text(person?.name) === "本地测试管理员")) fail("LOCAL_TEST_ADMIN_NAME_CONFLICT");
  const siteIds = [...new Set(state.sites.map(site => text(site?.id)).filter(Boolean))];
  if (!siteIds.length) fail("LOCAL_TEST_SITES_REQUIRED");
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const previous = existing[0];
  const usedNos = new Set(state.personnel.filter(person => text(person?.id) !== LOCAL_ADMIN_ID).map(person => text(person?.personnelNo)));
  let personnelNo = text(previous?.personnelNo) || "LOCAL-TEST-ADMIN";
  if (usedNos.has(personnelNo)) fail("LOCAL_TEST_PERSONNEL_NO_CONFLICT");
  const hash = scryptSync(credentials.password, salt, 32).toString("base64url");
  const administrator = {
    id: LOCAL_ADMIN_ID, personnelNo, name: "本地测试管理员", username: credentials.username,
    password: `scrypt$1$${salt}$${hash}`, localTestAccount: true,
    sessionVersion: Number.isSafeInteger(previous?.sessionVersion) ? previous.sessionVersion + 1 : 0,
    accountEnabled: true, accessRole: "admin", employmentStatus: "active", resignedAt: "",
    department: "本地测试", role: "管理员", hireDate: text(previous?.hireDate) || day,
    siteIds, visibleSiteIds: [],
    permissions: Object.fromEntries(modules.map(module => [module, { create: true, update: true, delete: true }])),
    gender: "", nativePlace: "", birthMonth: "", educationLevel: "", phone: "", email: "", wechat: "", address: "",
    emergencyContact: "", emergencyPhone: "", idCardNo: "", bankAccountName: "", bankAccountNo: "", bankName: "",
    idCardFrontAttachment: null, idCardBackAttachment: null, educationProofAttachment: null,
    profileRevision: 0, notes: "仅用于本机隔离测试；原人员及业务数据保持原样。",
  };
  // Employment/account requirements must be complete; never invent identity or bank documents for a test login.
  const required = new Set(["name", "department", "role", "hireDate", "siteIds", "systemAccount"]);
  if (missingPersonnelRecordFields(administrator).some(field => required.has(field))) fail("LOCAL_TEST_ADMIN_PROFILE_INVALID");
  return { personnel: previous ? state.personnel.map(person => person === previous ? administrator : person) : [...state.personnel, administrator], created: !previous };
}

export async function bootstrapLocalAdministrator(env = process.env) {
  const options = localTestDatabaseOptions(env);
  let handle;
  try {
    handle = await open(env.LOCAL_TEST_CREDENTIALS_PATH || "/run/local-test/login.json", constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 16384) fail("LOCAL_TEST_LOGIN_FILE_INVALID");
    let parsed;
    try { parsed = JSON.parse(await handle.readFile("utf8")); } catch { fail("LOCAL_TEST_LOGIN_FILE_INVALID"); }
    const credentials = validateLocalCredentials(parsed);
    const { Client } = await import("pg");
    const client = new Client(options);
    try {
      await client.connect();
      await client.query("BEGIN");
      const identity = (await client.query("SELECT current_database() AS database, current_user AS username")).rows[0];
      if (identity?.database !== "fishroom_test" || identity?.username !== "fishroom_test") fail("LOCAL_TEST_DATABASE_IDENTITY_REFUSED");
      const rows = (await client.query("SELECT data FROM public.app_state WHERE id = $1 FOR UPDATE", ["main"])).rows;
      if (rows.length !== 1) fail("LOCAL_TEST_MAIN_STATE_REQUIRED");
      const planned = planLocalAdministrator(rows[0].data, credentials);
      await client.query("UPDATE public.app_state SET data = jsonb_set(data, '{personnel}', $2::jsonb, true), updated_at = now() WHERE id = $1", ["main", JSON.stringify(planned.personnel)]);
      await client.query("COMMIT");
      return { ok: true, localAdministrator: planned.created ? "created" : "updated", personnelCount: planned.personnel.length };
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { await client.end().catch(() => undefined); }
  } finally { await handle?.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await bootstrapLocalAdministrator())); }
  catch (error) { console.error(JSON.stringify({ ok: false, error: error.safeCode || "LOCAL_TEST_ADMIN_BOOTSTRAP_FAILED" })); process.exitCode = 1; }
}
