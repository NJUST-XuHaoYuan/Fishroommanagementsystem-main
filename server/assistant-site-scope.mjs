export const ASSISTANT_ALL_SITE_ID = "all";

function normalized(value) {
  return String(value ?? "").trim();
}

export function resolveAssistantSiteScope({
  requestedSiteId = ASSISTANT_ALL_SITE_ID,
  accessRole = "staff",
  visibleSiteIds = [],
} = {}) {
  const requested = normalized(requestedSiteId) || ASSISTANT_ALL_SITE_ID;
  if (accessRole === "admin" || requested === ASSISTANT_ALL_SITE_ID) return requested;
  const allowed = new Set((Array.isArray(visibleSiteIds) ? visibleSiteIds : [])
    .map(normalized)
    .filter(Boolean));
  if (!allowed.has(requested)) throw new Error("无权查看该场地的 AI 助手数据");
  return requested;
}
