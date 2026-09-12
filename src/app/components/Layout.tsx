import { ComponentType, ReactNode, useEffect, useState } from "react";
import { useStore } from "../store";
import { authJsonHeaders, clearAuthSession } from "../utils/authSession";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "./ui/sheet";
import {
  Fish,
  PackageSearch,
  Wrench,
  ChevronRight,
  LogOut,
  LayoutDashboard,
  ShoppingBag,
  Cloud,
  CloudOff,
  Loader2,
  Users,
  ScrollText,
  Menu,
  UserCircle,
  MapPin,
  CircleDollarSign,
  Settings,
  WalletCards,
  Inbox,
  FlaskConical,
  Truck,
  Tags,
} from "lucide-react";
import { normalizeSiteId, siteName, visibleSitesForUser } from "../utils/sites";
import { AIAssistantPanel } from "./AIAssistantPanel";
import { NotificationNavBadge, useNotificationUnreadCount } from "./NotificationCenter";
import { usePermission } from "../utils/permissions";
import { canAccessDashboard, resolveDashboardView } from "../utils/dashboardAccess";

export type ViewKey =
  | "dashboard"
  | "notifications"
  | "species"
  | "products"
  | "tankGroups"
  | "batches"
  | "stockIn"
  | "daily"
  | "lossRecords"
  | "customers"
  | "orders"
  | "catalogManagement"
  | "finance"
  | "categorySettings"
  | "paymentMethods"
  | "shippingCarriers"
  | "waterQualitySettings"
  | "permissions"
  | "profile"
  | "operationLogs";

type NavItem = { key: ViewKey; label: string; adminOnly?: boolean };
type NavSection = { title: string; icon: ComponentType<{ className?: string }>; items: NavItem[] };

const NAV: NavSection[] = [
  {
    title: "品名管理",
    icon: Fish,
    items: [
      { key: "species", label: "物种管理" },
      { key: "products", label: "商品管理" },
    ],
  },
  {
    title: "库存管理",
    icon: PackageSearch,
    items: [
      { key: "tankGroups", label: "缸组管理" },
      { key: "batches", label: "采购批次" },
      { key: "stockIn", label: "库存明细" },
    ],
  },
  {
    title: "维护管理",
    icon: Wrench,
    items: [
      { key: "daily", label: "日常管理" },
      { key: "lossRecords", label: "损耗记录" },
    ],
  },
  {
    title: "销售管理",
    icon: ShoppingBag,
    items: [
      { key: "customers", label: "客户管理" },
      { key: "orders", label: "订单管理" },
      { key: "catalogManagement", label: "鱼单管理", adminOnly: true },
    ],
  },
  {
    title: "财务管理",
    icon: CircleDollarSign,
    items: [
      { key: "finance", label: "财务台账" },
    ],
  },
];

type Props = {
  view: ViewKey;
  setView: (v: ViewKey) => void;
  children: ReactNode;
  saveStatus: "idle" | "saving" | "saved" | "error";
};

function SaveStatus({ saveStatus }: { saveStatus: Props["saveStatus"] }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {saveStatus === "saving" && (
        <>
          <Loader2 className="size-3.5 animate-spin" />
          <span>保存中…</span>
        </>
      )}
      {saveStatus === "saved" && (
        <>
          <Cloud className="size-3.5 text-emerald-500" />
          <span className="text-emerald-600">已保存</span>
        </>
      )}
      {saveStatus === "error" && (
        <>
          <CloudOff className="size-3.5 text-red-500" />
          <span className="text-red-500">保存失败</span>
        </>
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="fishroom-brand flex items-center gap-3 px-3.5">
      <div className="fishroom-brand-mark size-10 overflow-hidden shrink-0">
        <img src="/assets/brand-logo.jpg" alt="Marine Forest" className="size-full object-contain p-1" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-[14px] font-semibold text-foreground">海水鱼房</div>
        <div className="mt-0.5 text-xs text-muted-foreground">库存 · 维护 · 销售</div>
      </div>
    </div>
  );
}

export function Layout({ view, setView, children, saveStatus }: Props) {
  const { state, activeSiteId, setActiveSiteId, setState } = useStore();
  const financePermission = usePermission("finance");
  const user = state.user!;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const notificationUnreadCount = useNotificationUnreadCount();
  const sites = visibleSitesForUser(user, state);
  const activeSiteName = sites.find((site) => site.id === normalizeSiteId(activeSiteId))?.name ?? siteName(state, activeSiteId);
  const currentAccount = (state.personnel ?? []).find((person) => person.username === user.username);
  const canSeeFinance = financePermission.isAdmin ||
    financePermission.canCreate ||
    financePermission.canUpdate ||
    financePermission.canDelete;

  useEffect(() => {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const root = document.documentElement;
    const visualViewport = window.visualViewport;
    let viewportFrame = 0;

    const updateViewportMetrics = () => {
      window.cancelAnimationFrame(viewportFrame);
      viewportFrame = window.requestAnimationFrame(() => {
        const viewportHeight = Math.max(1, visualViewport?.height ?? window.innerHeight);
        const viewportTop = Math.max(0, visualViewport?.offsetTop ?? 0);
        const viewportBottomGap = Math.max(0, window.innerHeight - viewportTop - viewportHeight);
        root.style.setProperty("--fishroom-viewport-height", `${Math.round(viewportHeight)}px`);
        root.style.setProperty("--fishroom-viewport-top", `${Math.round(viewportTop)}px`);
        root.style.setProperty("--fishroom-viewport-bottom-gap", `${Math.round(viewportBottomGap)}px`);
      });
    };

    window.scrollTo(0, 0);
    root.classList.add("fishroom-admin-shell");
    document.body.classList.add("fishroom-admin-shell");
    updateViewportMetrics();
    window.addEventListener("resize", updateViewportMetrics);
    window.addEventListener("orientationchange", updateViewportMetrics);
    visualViewport?.addEventListener("resize", updateViewportMetrics);
    visualViewport?.addEventListener("scroll", updateViewportMetrics);

    return () => {
      window.cancelAnimationFrame(viewportFrame);
      window.removeEventListener("resize", updateViewportMetrics);
      window.removeEventListener("orientationchange", updateViewportMetrics);
      visualViewport?.removeEventListener("resize", updateViewportMetrics);
      visualViewport?.removeEventListener("scroll", updateViewportMetrics);
      root.classList.remove("fishroom-admin-shell");
      root.style.removeProperty("--fishroom-viewport-height");
      root.style.removeProperty("--fishroom-viewport-top");
      root.style.removeProperty("--fishroom-viewport-bottom-gap");
      document.body.classList.remove("fishroom-admin-shell");
      window.scrollTo(scrollX, scrollY);
    };
  }, []);

  const currentLabel =
    view === "dashboard"
      ? "首页"
      : view === "notifications"
        ? "站内信中心"
      : view === "profile"
        ? "个人中心"
      : view === "permissions"
        ? "人员与权限"
      : view === "categorySettings"
        ? "分类管理"
      : view === "operationLogs"
        ? "操作日志"
      : view === "paymentMethods"
        ? "付款方式管理"
      : view === "shippingCarriers"
        ? "订单与物流设置"
      : view === "waterQualitySettings"
        ? "水质参数管理"
      : NAV.flatMap((s) => s.items).find((i) => i.key === view)?.label ?? "";

  const currentSection =
    view === "dashboard"
      ? null
      : view === "notifications"
        ? null
      : view === "profile"
        ? "个人中心"
      : view === "permissions"
        ? "后台管理"
      : view === "categorySettings"
        ? "后台管理"
      : view === "operationLogs"
        ? "日志管理"
      : view === "paymentMethods"
        ? "后台管理"
      : view === "shippingCarriers"
        ? "后台管理"
      : view === "waterQualitySettings"
        ? "后台管理"
      : NAV.find((s) => s.items.some((i) => i.key === view))?.title;

  const navigate = (nextView: ViewKey) => {
    setView(resolveDashboardView(nextView, user));
    setMobileNavOpen(false);
  };

  const navButtonClass = (active: boolean, level: "main" | "sub" = "sub") =>
    [
      "fishroom-nav-button flex items-center text-left transition-colors",
      level === "main" ? "is-main" : "is-sub",
      active ? "is-active" : "",
      level === "main"
        ? "gap-2 px-2.5 py-2 text-sm font-semibold"
        : "justify-between px-2.5 py-1.5 text-[13px]",
    ].join(" ");

  const NavContent = () => (
    <>
      <Brand />
      <nav className="flex-1 overflow-y-auto px-2.5 py-3 flex flex-col gap-2">
        {canAccessDashboard(user) && (
          <button
            onClick={() => navigate("dashboard")}
            className={navButtonClass(view === "dashboard", "main")}
          >
            <LayoutDashboard className="size-4 shrink-0" />
            <span>首页概览</span>
          </button>
        )}
        <button
          onClick={() => navigate("notifications")}
          className={navButtonClass(view === "notifications", "main")}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Inbox className="size-4 shrink-0" />
            <span>站内信中心</span>
          </span>
          <NotificationNavBadge unreadCount={notificationUnreadCount} />
        </button>
        {NAV.filter((section) => section.title !== "财务管理" || canSeeFinance).map((section) => {
          const Icon = section.icon;
          return (
            <div key={section.title} className="fishroom-nav-section">
              <div className="fishroom-nav-title">
                <span className="fishroom-nav-title-icon">
                  <Icon className="size-3.5 shrink-0" />
                </span>
                <span>{section.title}</span>
              </div>
              {section.items.filter((item) => !item.adminOnly || user.role === "admin").map((item) => (
                <button
                  key={item.key}
                  onClick={() => navigate(item.key)}
                  className={navButtonClass(view === item.key)}
                >
                  <span>{item.label}</span>
                  {view === item.key && <ChevronRight className="size-4 shrink-0" />}
                </button>
              ))}
            </div>
          );
        })}
        {user.role === "admin" && (
          <>
            <div className="fishroom-nav-section">
              <div className="fishroom-nav-title">
                <span className="fishroom-nav-title-icon">
                  <Settings className="size-3.5 shrink-0" />
                </span>
                <span>后台管理</span>
              </div>
              <button
                onClick={() => navigate("categorySettings")}
                className={navButtonClass(view === "categorySettings")}
              >
                <span className="flex items-center gap-2"><Tags className="size-3.5" />分类管理</span>
                {view === "categorySettings" && <ChevronRight className="size-3.5 shrink-0" />}
              </button>
              <button
                onClick={() => navigate("permissions")}
                className={navButtonClass(view === "permissions")}
              >
                <span className="flex items-center gap-2"><Users className="size-3.5" />人员与权限</span>
                {view === "permissions" && <ChevronRight className="size-3.5 shrink-0" />}
              </button>
              <button
                onClick={() => navigate("paymentMethods")}
                className={navButtonClass(view === "paymentMethods")}
              >
                <span className="flex items-center gap-2"><WalletCards className="size-3.5" />付款方式管理</span>
                {view === "paymentMethods" && <ChevronRight className="size-3.5 shrink-0" />}
              </button>
              <button
                onClick={() => navigate("shippingCarriers")}
                className={navButtonClass(view === "shippingCarriers")}
              >
                <span className="flex items-center gap-2"><Truck className="size-3.5" />订单与物流设置</span>
                {view === "shippingCarriers" && <ChevronRight className="size-3.5 shrink-0" />}
              </button>
              <button
                onClick={() => navigate("waterQualitySettings")}
                className={navButtonClass(view === "waterQualitySettings")}
              >
                <span className="flex items-center gap-2"><FlaskConical className="size-3.5" />水质参数管理</span>
                {view === "waterQualitySettings" && <ChevronRight className="size-3.5 shrink-0" />}
              </button>
            </div>
            <div className="fishroom-nav-section">
              <div className="fishroom-nav-title">
                <span className="fishroom-nav-title-icon">
                  <ScrollText className="size-3.5 shrink-0" />
                </span>
                <span>日志管理</span>
              </div>
              <button
                onClick={() => navigate("operationLogs")}
                className={navButtonClass(view === "operationLogs")}
              >
                <span>操作日志</span>
                {view === "operationLogs" && <ChevronRight className="size-3.5 shrink-0" />}
              </button>
            </div>
          </>
        )}
      </nav>
      <div className="fishroom-sidebar-footer border-t p-2.5 flex flex-col gap-2 bg-sidebar">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <div className="text-sm font-medium truncate">{currentAccount?.name || user.username}</div>
            {currentAccount?.name && currentAccount.name !== user.username && (
              <div className="truncate text-[11px] text-muted-foreground">账号：{user.username}</div>
            )}
            <Badge variant="secondary" className="fishroom-status-pill w-fit text-xs">
              {user.role === "admin" ? "管理员" : "店员"}
            </Badge>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate("profile")}
              className={`fishroom-sidebar-profile-action ${view === "profile" ? "is-active" : ""}`}
              title="个人中心"
              aria-label="个人中心"
            >
              <UserCircle className="size-3.5" />
              <span>个人中心</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                void fetch("/api/auth/logout", { method: "POST", headers: authJsonHeaders() }).catch(() => undefined);
                clearAuthSession();
                setState((s) => ({ ...s, user: null }));
              }}
              className="fishroom-sidebar-action"
              title="退出"
              aria-label="退出"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </>
  );

  const SiteSelector = ({ compact = false }: { compact?: boolean }) => (
    <label className={[
      "fishroom-control flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs text-muted-foreground",
      compact ? "max-w-[140px]" : "",
    ].join(" ")}>
      <MapPin className="size-3.5 shrink-0 text-sky-600" />
      {!compact && <span className="shrink-0">场地</span>}
      <select
        value={normalizeSiteId(activeSiteId)}
        onChange={(event) => setActiveSiteId(event.target.value)}
        className="min-w-0 bg-transparent text-sm font-medium text-foreground outline-none"
        title="切换当前场地"
      >
        {sites.map((site) => (
          <option key={site.id} value={site.id}>{site.name}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="fishroom-app flex size-full min-h-0 overflow-hidden">
      <aside className="fishroom-sidebar hidden w-64 shrink-0 lg:flex lg:flex-col">
        <NavContent />
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-[84vw] max-w-[320px] gap-0 p-0">
          <SheetTitle className="sr-only">移动端菜单</SheetTitle>
          <div className="flex h-full flex-col">
            <NavContent />
          </div>
        </SheetContent>
      </Sheet>

      <main className="flex-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
        <header className="fishroom-topbar sticky top-0 z-30 flex min-h-[3.25rem] items-center justify-between gap-3 px-3 py-2 text-sm lg:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileNavOpen(true)}
              className="fishroom-mobile-menu-trigger shrink-0 lg:hidden"
              title="打开菜单"
              aria-label="打开菜单"
            >
              <Menu className="size-5" />
            </Button>
            <div className="min-w-0 lg:hidden">
              {currentSection && (
                <div className="truncate text-[11px] leading-4 text-muted-foreground">
                  {currentSection}
                </div>
              )}
              <div className="truncate font-semibold text-foreground">{currentLabel}</div>
            </div>
            <div className="hidden items-center gap-2 lg:flex">
              {currentSection && (
                <>
                  <span className="text-muted-foreground">{currentSection}</span>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </>
              )}
              <span className="font-semibold text-foreground">{currentLabel}</span>
            </div>
          </div>
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <div className="lg:hidden"><SiteSelector compact /></div>
            <div className="hidden text-xs text-muted-foreground lg:block">当前：{activeSiteName}</div>
            <div className="hidden lg:block"><SiteSelector /></div>
            <div className="fishroom-mobile-save-status">
              <SaveStatus saveStatus={saveStatus} />
            </div>
          </div>
        </header>

        <div
          className="fishroom-content min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-3 sm:p-4 lg:p-5"
          data-testid="app-scroll-region"
        >
          {children}
        </div>
      </main>
      {view !== "catalogManagement" && <AIAssistantPanel />}
    </div>
  );
}
