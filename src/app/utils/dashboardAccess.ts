import type { ViewKey } from "../components/Layout";
import type { User } from "../store";

export function canAccessDashboard(user: User): boolean {
  return user?.role === "admin";
}

/** Daily management remains readable to staff under the existing menu policy. */
export function resolveDashboardView(requestedView: ViewKey, user: User): ViewKey {
  return requestedView === "dashboard" && !canAccessDashboard(user)
    ? "daily"
    : requestedView;
}
