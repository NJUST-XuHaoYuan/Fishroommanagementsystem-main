import { ComponentType, ReactNode, useState } from "react";
import { useStore } from "../store";
import { clearAuthSession } from "../utils/authSession";
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
} from "lucide-react";
import { getSites, normalizeSiteId, siteName } from "../utils/sites";

export type ViewKey =
  | "dashboard"
  | "species"
  | "products"
  | "tankGroups"
  | "batches"
  | "stockIn"
  | "daily"
  | "lossRecords"
  | "customers"
  | "orders"
  | "permissions"
  | "accounts"
  | "profile"
  | "operationLogs";

type NavItem = { key: ViewKey; label: string };
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
      { key: "stockIn", label: "商品入库" },
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
    <div className="p-4 border-b flex items-center gap-3">
      <div className="size-10 overflow-hidden rounded-xl border bg-white shrink-0">
        <img src="/assets/brand-logo.jpg" alt="Marine Forest" className="size-full object-contain p-1" />
      </div>
      <div className="min-w-0">
        <div className="font-medium truncate">海水鱼房</div>
        <div className="text-xs text-muted-foreground">管理系统</div>
      </div>
    </div>
  );
}

export function Layout({ view, setView, children, saveStatus }: Props) {
  const { state, activeSiteId, setActiveSiteId, setState } = useStore();
  const user = state.user!;
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const sites = getSites(state);
  const activeSiteName = siteName(state, activeSiteId);

  const currentLabel =
    view === "dashboard"
      ? "首页"
      : view === "profile"
        ? "个人中心"
      : view === "permissions"
        ? "权限管理"
      : view === "accounts"
        ? "账号密码管理"
      : view === "operationLogs"
        ? "操作日志"
      : NAV.flatMap((s) => s.items).find((i) => i.key === view)?.label ?? "";

  const currentSection =
    view === "dashboard"
      ? null
      : view === "profile"
        ? "个人中心"
      : view === "permissions" || view === "accounts"
        ? "人员管理"
      : view === "operationLogs"
        ? "日志管理"
      : NAV.find((s) => s.items.some((i) => i.key === view))?.title;

  const navigate = (nextView: ViewKey) => {
    setView(nextView);
    setMobileNavOpen(false);
  };

  const navButtonClass = (active: boolean, level: "main" | "sub" = "sub") =>
    [
      "flex w-full items-center rounded-md text-left transition-colors",
      active ? "bg-sky-100 text-sky-700" : "hover:bg-muted",
      level === "main"
        ? "gap-2 px-3 py-2.5 text-base font-medium"
        : "justify-between px-8 py-2 text-sm",
    ].join(" ");

  const NavContent = () => (
    <>
      <Brand />
      <nav className="flex-1 overflow-y-auto p-3 flex flex-col gap-4">
        <button
          onClick={() => navigate("dashboard")}
          className={navButtonClass(view === "dashboard", "main")}
        >
          <LayoutDashboard className="size-4 shrink-0" />
          <span>首页概览</span>
        </button>
        <button
          onClick={() => navigate("profile")}
          className={navButtonClass(view === "profile", "main")}
        >
          <UserCircle className="size-4 shrink-0" />
          <span>个人中心</span>
        </button>
        {NAV.map((section) => {
          const Icon = section.icon;
          return (
            <div key={section.title} className="flex flex-col gap-1">
              <div className="px-3 py-1 text-base font-semibold text-foreground flex items-center gap-2">
                <Icon className="size-4 shrink-0" />
                {section.title}
              </div>
              {section.items.map((item) => (
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
            <div className="flex flex-col gap-1">
              <div className="px-3 py-1 text-base font-semibold text-foreground flex items-center gap-2">
                <Users className="size-4 shrink-0" />
                人员管理
              </div>
              <button
                onClick={() => navigate("permissions")}
                className={navButtonClass(view === "permissions")}
              >
                <span>权限管理</span>
                {view === "permissions" && <ChevronRight className="size-3.5 shrink-0" />}
              </button>
              <button
                onClick={() => navigate("accounts")}
                className={navButtonClass(view === "accounts")}
              >
                <span>账号密码管理</span>
                {view === "accounts" && <ChevronRight className="size-3.5 shrink-0" />}
              </button>
            </div>
            <div className="flex flex-col gap-1">
              <div className="px-3 py-1 text-base font-semibold text-foreground flex items-center gap-2">
                <ScrollText className="size-4 shrink-0" />
                日志管理
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
      <div className="border-t p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <div className="text-sm truncate">{user.username}</div>
            <Badge variant="secondary" className="w-fit text-xs">
              {user.role === "admin" ? "管理员" : "店员"}
            </Badge>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              clearAuthSession();
              setState((s) => ({ ...s, user: null }));
            }}
            title="退出"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </>
  );

  const SiteSelector = ({ compact = false }: { compact?: boolean }) => (
    <label className={[
      "flex items-center gap-2 rounded-md border bg-white px-2 py-1.5 text-xs text-muted-foreground",
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
    <div className="fishroom-app size-full min-h-screen flex bg-slate-50">
      <aside className="hidden w-64 shrink-0 bg-white border-r lg:flex lg:flex-col">
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

      <main className="flex-1 flex min-w-0 flex-col overflow-hidden">
        <header className="sticky top-0 z-30 h-14 bg-white border-b px-3 flex items-center justify-between gap-3 text-sm lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileNavOpen(true)}
              className="shrink-0"
              title="打开菜单"
            >
              <Menu className="size-5" />
            </Button>
            <div className="min-w-0">
              {currentSection && (
                <div className="truncate text-[11px] leading-4 text-muted-foreground">
                  {currentSection}
                </div>
              )}
              <div className="truncate font-medium text-foreground">{currentLabel}</div>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <SiteSelector compact />
            <SaveStatus saveStatus={saveStatus} />
          </div>
        </header>

        <header className="hidden h-14 bg-white border-b px-6 lg:flex items-center justify-between text-sm">
          <div className="flex items-center gap-2">
            {currentSection && (
              <>
                <span className="text-muted-foreground">{currentSection}</span>
                <ChevronRight className="size-4 text-muted-foreground" />
              </>
            )}
            <span className="font-medium text-foreground">{currentLabel}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground">当前：{activeSiteName}</div>
            <SiteSelector />
            <SaveStatus saveStatus={saveStatus} />
          </div>
        </header>

        <div className="fishroom-content flex-1 overflow-auto p-3 sm:p-4 lg:p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
