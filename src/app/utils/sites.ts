import type { Store, User } from "../store";

export const DEFAULT_SITE_ID = "nanjing";
export const ALL_SITE_ID = "all";

export const DEFAULT_SITES = [
  { id: "jiangyin", name: "江阴" },
  { id: "nanjing", name: "南京" },
  { id: "beijing", name: "北京" },
] as const;

export type SiteScopeId = typeof ALL_SITE_ID | string;

export function normalizeSiteId(value: unknown): string {
  const id = String(value ?? "").trim();
  return id || DEFAULT_SITE_ID;
}

export function normalizeSiteScope(value: unknown): SiteScopeId {
  const id = String(value ?? "").trim();
  return id === ALL_SITE_ID ? ALL_SITE_ID : normalizeSiteId(id);
}

export function getSites(state?: Partial<Store>) {
  const rawSites = Array.isArray(state?.sites) ? state?.sites : [];
  const merged = [...DEFAULT_SITES.map((site) => ({ ...site }))];
  rawSites.forEach((site) => {
    const id = normalizeSiteId(site?.id);
    const name = String(site?.name ?? "").trim() || id;
    if (!merged.some((item) => item.id === id)) merged.push({ id, name });
  });
  return merged;
}

export function normalizeVisibleSiteIds(value: unknown, sites: readonly { id: string }[] = DEFAULT_SITES): string[] {
  if (!Array.isArray(value)) return [];
  const allowedIds = new Set(sites.map((site) => normalizeSiteId(site.id)));
  const normalized: string[] = [];
  value.forEach((item) => {
    const rawId = String(item ?? "").trim();
    const id = rawId ? normalizeSiteId(rawId) : "";
    if (!id || (allowedIds.size > 0 && !allowedIds.has(id)) || normalized.includes(id)) return;
    normalized.push(id);
  });
  return normalized;
}

export function visibleSitesForUser(user: User, state?: Partial<Store>) {
  const sites = getSites(state);
  if (!user || user.role === "admin") return sites;
  const visibleSiteIds = normalizeVisibleSiteIds(user.visibleSiteIds, sites);
  if (visibleSiteIds.length === 0) return [];
  const allowedIds = new Set(visibleSiteIds);
  return sites.filter((site) => allowedIds.has(site.id));
}

export function canUserAccessSite(user: User, state: Partial<Store> | undefined, siteId: unknown): boolean {
  const normalizedSiteId = normalizeSiteId(siteId);
  return visibleSitesForUser(user, state).some((site) => site.id === normalizedSiteId);
}

export function siteName(state: Partial<Store> | undefined, siteId: unknown): string {
  const id = normalizeSiteId(siteId);
  return getSites(state).find((site) => site.id === id)?.name ?? id;
}

export function matchesSite(item: { siteId?: string } | null | undefined, siteId: SiteScopeId): boolean {
  if (siteId === ALL_SITE_ID) return true;
  return normalizeSiteId(item?.siteId) === siteId;
}

export function withSite<T extends object>(item: T, siteId: string): T & { siteId: string } {
  return { ...item, siteId: normalizeSiteId((item as { siteId?: string }).siteId ?? siteId) };
}
