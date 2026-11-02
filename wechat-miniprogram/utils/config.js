module.exports = {
  // 正式环境统一通过备案域名访问，避免小程序客户端拦截裸 IP 或 HTTP 请求。
  apiBaseUrl: "https://www.marineforest.com.cn",
  siteId: "all",
  // 暂时隐藏“我的”和客服入口，保留账号与客服功能以便恢复。
  showCustomerTools: false,
  cacheTtlMs: 60 * 1000
};
