const { buildUrl, getApiBaseUrl } = require("./api");

const PRIVACY_VERSION = "2026-09-09";
let memorySession = null;
let memorySessionKey = "";
let loginPending = null;
const storageKey = () => `marineforest.customer.v1:${getApiBaseUrl()}`;

function clearSession() {
  memorySession = null;
  memorySessionKey = "";
  try { wx.removeStorageSync(storageKey()); } catch (_) {}
}

function savedSession() {
  let value = memorySessionKey === storageKey() ? memorySession : null;
  if (!value) {
    try { value = wx.getStorageSync(storageKey()); } catch (_) {}
  }
  if (!value || !/^mfs_[A-Za-z0-9_-]{43}$/.test(value.token || "")
    || !value.customer || typeof value.customer.id !== "string" || Number(value.expiresAt) <= Date.now()
    || !Number.isFinite(Number(value.expiresAt))) {
    clearSession();
    return null;
  }
  return value;
}

function request(path, method = "GET", data, authenticated = false) {
  const session = authenticated ? savedSession() : null;
  if (authenticated && !session) return Promise.reject(Object.assign(new Error("请先微信登录"), { status: 401 }));
  return new Promise((resolve, reject) => wx.request({
    url: buildUrl(`/api/mini/${path}`), method, data, timeout: 12000,
    header: { "Content-Type": "application/json", Accept: "application/json",
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
    success(response) {
      const status = Number(response.statusCode);
      const body = response.data || {};
      if (status >= 200 && status < 300 && body.ok === true) return resolve(body);
      if (status === 401) clearSession();
      const unavailable = status === 404 || (path === "config" && status === 401);
      reject(Object.assign(new Error(unavailable ? "账号服务尚未上线，仍可浏览鱼单和咨询客服" : body.error || "账号服务暂时不可用"), { status }));
    },
    fail() { reject(new Error("网络连接失败，请稍后重试")); }
  }));
}

async function login(privacyAccepted) {
  if (!privacyAccepted) throw new Error("请先阅读并同意隐私说明");
  if (loginPending) return loginPending;
  loginPending = (async () => {
    const configuration = await request("config");
    if (!configuration.loginEnabled) throw new Error("微信登录尚未开通，仍可浏览鱼单和咨询客服");
    if (configuration.privacyVersion !== PRIVACY_VERSION) throw new Error("隐私说明已更新，请更新小程序后登录");
    const code = await new Promise((resolve, reject) => wx.login({
      timeout: 10000,
      success(result) { result.code ? resolve(result.code) : reject(new Error("未获取到微信登录凭证，请重试")); },
      fail() { reject(new Error("微信登录未完成，请重试")); }
    }));
    const result = await request("login", "POST", { code, privacyVersion: PRIVACY_VERSION });
    if (!/^mfs_[A-Za-z0-9_-]{43}$/.test(result.token || "") || !result.customer || !result.customer.id
      || !Number.isFinite(Number(result.expiresAt)) || Number(result.expiresAt) <= Date.now()) {
      throw new Error("登录信息无效，请重试");
    }
    const value = { token: result.token, expiresAt: result.expiresAt, customer: result.customer };
    memorySession = value;
    memorySessionKey = storageKey();
    try { wx.setStorageSync(storageKey(), value); } catch (_) {}
    return result.customer;
  })();
  try { return await loginPending; } finally { loginPending = null; }
}

async function currentCustomer() {
  if (!savedSession()) return null;
  const result = await request("session", "GET", undefined, true);
  return result.customer;
}

async function endSession(deleteAccount = false) {
  try {
    await request(deleteAccount ? "account/delete" : "logout", "POST", undefined, true);
    clearSession();
  } catch (error) {
    if (error.status === 401 && !deleteAccount) { clearSession(); return; }
    throw error;
  }
}

module.exports = { PRIVACY_VERSION, login, currentCustomer, endSession };
