module.exports = {
  // 正式环境统一通过备案域名访问，避免小程序客户端拦截裸 IP 或 HTTP 请求。
  apiBaseUrl: "https://www.marineforest.com.cn",
  siteId: "all",
  // 暂时隐藏“我的”和客服会话入口；首页独立展示客服微信号。
  showCustomerTools: false,
  serviceWechatId: "marineforest2024",
  cacheTtlMs: 60 * 1000
};
