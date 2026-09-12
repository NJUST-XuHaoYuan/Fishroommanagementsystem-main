import type { ViewKey } from "../components/Layout";

export type LinkedOrderSourceView = Extract<ViewKey, "stockIn" | "daily" | "notifications">;

type LinkedOrderNavigationInput = {
  orderId: string;
  requestedSiteId?: string;
  cachedOrderSiteId?: string;
  activeSiteId: string;
  sourceView: ViewKey;
  canAccessSite: (siteId: string) => boolean;
};

export function buildLinkedOrderNavigation(input: LinkedOrderNavigationInput): {
  orderId: string;
  targetSiteId: string;
  returnView?: LinkedOrderSourceView;
  returnSiteId: string;
} | null {
  const orderId = input.orderId.trim();
  // A freshly fetched reference can locate an order before the orders page loads.
  // Explicit invalid/forbidden sites must never fall back to another site.
  const targetSiteId = (input.requestedSiteId ?? input.cachedOrderSiteId ?? input.activeSiteId).trim();
  if (!orderId || !targetSiteId || !input.canAccessSite(targetSiteId)) return null;
  const sourceView = input.sourceView;
  const returnView = sourceView === "stockIn" || sourceView === "daily" ||
    sourceView === "notifications"
    ? sourceView
    : undefined;
  return { orderId, targetSiteId, returnView, returnSiteId: input.activeSiteId };
}
