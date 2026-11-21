import { PushSettings, FocusMeasurement } from "./push";
import { OfflineControls, OfflinePage } from "./offline";
import { useCallback, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, useLocation } from "react-router";
import {
  Activity,
  Download,
  HardDrive,
  HeartPulse,
  Scale,
  Radio,
  Users,
  Upload,
  Settings,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
  X,
} from "lucide-react";
import { RoutingProvider } from "./routing";
import { pagePaths, routeForPath } from "./routingDomain";
import { api, isOffline } from "./api";
import type { Row } from "./api";
import { RealtimeProvider, useAPI, useRealtime } from "./realtime";
import { usePWAInstall } from "./pwa";
import { MeasurementsPage } from "./measurements";
import { Management } from "./management";
import { HealthProfiles } from "./health";
import { Operations, ResetAction } from "./lifecycle";
import { MobileBottomNav } from "./components/MobileNav";
import { Button } from "./components/ui/button";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Badge } from "./components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./components/ui/card";
import { Skeleton } from "./components/ui/skeleton";
import { Separator } from "./components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar";
import { TooltipProvider } from "./components/ui/tooltip";
import { cn } from "./lib/utils";
import "./style.css";

type PageDef = {
  id: string;
  label: string;
  group: "health" | "system";
  icon: typeof Activity;
  iconAccent: string;
  description: string;
};

const pages: PageDef[] = [
  {
    id: "overview",
    label: "家庭概览",
    group: "health",
    icon: Activity,
    iconAccent: "text-blue-600",
    description: "家人的最新读数与健康趋势",
  },
  {
    id: "data",
    label: "血压数据",
    group: "health",
    icon: HeartPulse,
    iconAccent: "text-rose-500",
    description: "查看每一次血压与脉搏变化",
  },
  {
    id: "body",
    label: "体重与体脂",
    group: "health",
    icon: Scale,
    iconAccent: "text-teal-600",
    description: "记录体重与估算体脂的变化",
  },
  {
    id: "members",
    label: "家庭成员",
    group: "health",
    icon: Users,
    iconAccent: "text-violet-600",
    description: "为每位家人保管健康资料",
  },
  {
    id: "devices",
    label: "设备",
    group: "system",
    icon: Radio,
    iconAccent: "text-blue-600",
    description: "管理采集端与家中的测量设备",
  },
  {
    id: "firmware",
    label: "固件升级",
    group: "system",
    icon: Upload,
    iconAccent: "text-indigo-600",
    description: "管理固件与采集端升级进度",
  },
  {
    id: "offline",
    label: "离线数据",
    group: "system",
    icon: HardDrive,
    iconAccent: "text-emerald-600",
    description: "查看本机保存的最近 90 天健康指标",
  },
  {
    id: "settings",
    label: "系统管理",
    group: "system",
    icon: Settings,
    iconAccent: "text-slate-600",
    description: "管理 PWA 安装、离线同步、通知与数据重置",
  },
];

const healthPages = pages.filter((p) => p.group === "health");
const systemPages = pages.filter((p) => p.group === "system");

function Navigation({ page }: { page: string }) {
  const { setOpenMobile } = useSidebar();
  const { canPrompt, installing, install } = usePWAInstall();

  const renderGroup = (label: string, items: PageDef[]) => (
    <SidebarGroup>
      <SidebarGroupLabel className="px-3 text-[11px] font-medium tracking-wider text-muted-foreground/80">
        {label}
      </SidebarGroupLabel>
      <SidebarMenu className="gap-1">
        {items.map((item) => {
          const active = page === item.id;
          return (
            <SidebarMenuItem key={item.id}>
              <SidebarMenuButton
                asChild
                isActive={active}
                tooltip={item.label}
                className={cn(
                  "h-10 rounded-xl px-3 transition-colors",
                  active && "font-semibold shadow-2xs",
                )}
              >
                <Link
                  to={pagePaths[item.id]}
                  onClick={() => setOpenMobile(false)}
                  aria-current={active ? "page" : undefined}
                >
                  <item.icon
                    className={cn(
                      "size-4 transition-colors",
                      active ? item.iconAccent : "text-muted-foreground",
                    )}
                  />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border/80">
      <SidebarHeader className="border-b border-sidebar-border/70 p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              className="rounded-xl hover:bg-muted/60"
            >
              <Link to="/" onClick={() => setOpenMobile(false)}>
                <img
                  src="/icon-anime-v1-192.png"
                  alt=""
                  className="size-9 shrink-0 rounded-xl shadow-xs ring-1 ring-black/5"
                />
                <span className="grid gap-0.5 leading-tight">
                  <strong className="text-base font-bold tracking-tight">
                    Eir
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    家庭健康空间
                  </span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-1 py-2">
        {renderGroup("日常健康", healthPages)}
        {renderGroup("设备与系统", systemPages)}
      </SidebarContent>
      <SidebarFooter className="gap-2.5 border-t border-sidebar-border/70 px-3 py-3 group-data-[collapsible=icon]:hidden">
        {canPrompt && (
          <Button
            size="sm"
            variant="outline"
            className="w-full justify-start gap-2 rounded-xl border-blue-200/80 bg-blue-50/60 text-blue-700 hover:bg-blue-100/70 hover:text-blue-800"
            disabled={installing}
            onClick={() => void install()}
          >
            <Download className="size-3.5" />
            安装桌面应用
          </Button>
        )}
        <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0 text-emerald-600" />
          <span>家庭内网 · 数据由你保管</span>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function SystemSettings({
  revision,
  action,
  busy,
}: {
  revision: number;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  busy: boolean;
}) {
  const operations = useAPI<Row[]>("operations", [], revision);
  return (
    <div className="space-y-5">
      <Card className="health-card border-rose-200/70 bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
              <TriangleAlert className="size-4" />
            </span>
            <div className="space-y-0.5">
              <CardTitle className="text-base">数据重置</CardTitle>
              <CardDescription className="text-xs">
                先预览影响范围，再确认执行。已有备份和导出文件不受影响。
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap items-start gap-3">
          <ResetAction
            api={api}
            action={action}
            busy={busy}
            type="system_reset"
            scope="measurements"
            label="清空健康数据"
          />
          <ResetAction
            api={api}
            action={action}
            busy={busy}
            type="system_reset"
            scope="all"
            label="完整重置 Eir"
          />
        </CardContent>
      </Card>
      {operations.error && (
        <Alert variant="destructive" className="rounded-2xl">
          <AlertDescription>{operations.error}</AlertDescription>
        </Alert>
      )}
      <Operations operations={operations.data} />
    </div>
  );
}

function App() {
  const location = useLocation(),
    route = routeForPath(location.pathname),
    page = route.page;
  const current = pages.find((p) => p.id === page);
  const { status, version } = useRealtime();
  const [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const members = useAPI<Row[]>("members", [], revision);
  useEffect(() => {
    const refresh = () => setRevision((v) => v + 1);
    window.addEventListener("eir-offline-updated", refresh);
    window.addEventListener("eir-connection-changed", refresh);
    return () => {
      window.removeEventListener("eir-offline-updated", refresh);
      window.removeEventListener("eir-connection-changed", refresh);
    };
  }, []);
  useEffect(() => {
    // Prevent pinch-to-zoom on iOS Safari / standalone PWA where viewport
    // user-scalable=no is ignored, while keeping single-finger scroll intact.
    const preventGesture = (event: Event) => event.preventDefault();
    const preventMultiTouch = (event: TouchEvent) => {
      if (event.touches.length > 1) event.preventDefault();
    };
    document.addEventListener("gesturestart", preventGesture, {
      passive: false,
    });
    document.addEventListener("gesturechange", preventGesture, {
      passive: false,
    });
    document.addEventListener("gestureend", preventGesture, { passive: false });
    document.addEventListener("touchstart", preventMultiTouch, {
      passive: false,
    });
    document.addEventListener("touchmove", preventMultiTouch, {
      passive: false,
    });
    return () => {
      document.removeEventListener("gesturestart", preventGesture);
      document.removeEventListener("gesturechange", preventGesture);
      document.removeEventListener("gestureend", preventGesture);
      document.removeEventListener("touchstart", preventMultiTouch);
      document.removeEventListener("touchmove", preventMultiTouch);
    };
  }, []);
  const devices = useAPI<Row[]>(
    ["data", "body"].includes(page) ? "devices" : null,
    [],
    revision,
  );
  const action = useCallback(
    async (fn: () => Promise<unknown>, message = "已保存") => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await fn();
        setNotice(message);
        setRevision((value) => value + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const offlineMode = page === "offline" || isOffline();
  const statusDot = offlineMode
    ? "bg-slate-400"
    : status === "connected"
      ? "bg-emerald-500"
      : "bg-amber-500 animate-pulse";
  const statusLabel = offlineMode
    ? "本机数据"
    : status === "connected"
      ? "实时同步"
      : status === "connecting"
        ? "连接中"
        : "正在重连";

  return (
    <SidebarProvider>
      <Navigation page={page} />
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 shrink-0 border-b border-border/70 bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
          <div className="flex h-13 items-center justify-between gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] md:h-14">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="hidden items-center gap-2.5 md:flex">
                <SidebarTrigger aria-label="展开或收起导航" />
                <Separator orientation="vertical" className="h-4" />
                <span className="text-xs text-muted-foreground">
                  {current?.group === "system" ? "设备与系统" : "日常健康"}
                </span>
                <span className="text-xs text-muted-foreground/50">/</span>
                <span className="truncate text-sm font-medium text-foreground">
                  {current?.label || "页面未找到"}
                </span>
              </div>
              <Link
                to="/"
                className="flex min-w-0 items-center gap-2 md:hidden"
              >
                <img
                  src="/icon-anime-v1-192.png"
                  alt=""
                  className="size-7 shrink-0 rounded-lg shadow-2xs ring-1 ring-black/5"
                />
                <span className="text-base font-bold tracking-tight text-foreground">
                  Eir
                </span>
              </Link>
            </div>
            <Badge
              variant="outline"
              className="shrink-0 gap-1.5 rounded-full border-border/80 bg-card/90 px-2.5 py-1 text-xs font-normal text-muted-foreground shadow-2xs"
              role="status"
            >
              <span className={`size-2 rounded-full ${statusDot}`} />
              {statusLabel}
            </Badge>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1600px] min-w-0 flex-1 space-y-5 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pt-6 sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] md:pb-8 lg:pl-[max(2rem,env(safe-area-inset-left))] lg:pr-[max(2rem,env(safe-area-inset-right))]">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-[1.65rem]">
              {current?.label || "页面未找到"}
            </h1>
            {page !== "overview" && (
              <p className="text-sm text-muted-foreground">
                {current?.description || "该地址暂时没有对应页面。"}
              </p>
            )}
          </div>

          {page !== "offline" && (error || members.error || devices.error) && (
            <Alert variant="destructive" className="rounded-2xl bg-card">
              <AlertDescription className="flex items-start justify-between gap-3">
                <span>{error || members.error || devices.error}</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="关闭错误"
                  onClick={() => setError("")}
                >
                  <X />
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {notice && (
            <Alert className="rounded-2xl border-emerald-200/80 bg-emerald-50/70 text-emerald-950">
              <AlertDescription className="flex items-center justify-between gap-3">
                <span>{notice}</span>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="关闭提示"
                  onClick={() => setNotice("")}
                >
                  <X />
                </Button>
              </AlertDescription>
            </Alert>
          )}

          <FocusMeasurement />
          {page === "offline" && <OfflinePage />}
          <OfflineControls settings={page === "settings"} />
          {page === "settings" && <PushSettings members={members.data} />}
          {page !== "offline" && members.error && (
            <Card className="health-card border-amber-200/80 bg-amber-50/60 py-4">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4">
                <div className="flex items-center gap-2.5 text-sm text-amber-950">
                  <WifiOff className="size-4 shrink-0 text-amber-600" />
                  <span>当前无法连接 Eir 服务，可切换至本机离线快照。</span>
                </div>
                <Button variant="outline" size="sm" asChild className="bg-card">
                  <Link to="/offline">无法连接服务，查看本机离线数据</Link>
                </Button>
              </CardContent>
            </Card>
          )}

          {members.loading && !members.loaded ? (
            <div className="space-y-4">
              <Skeleton className="h-11 w-64 rounded-2xl" />
              <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-5">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Skeleton className="h-32 rounded-2xl" key={i} />
                ))}
              </div>
              <Skeleton className="h-80 rounded-2xl" />
            </div>
          ) : (
            <>
              {["overview", "data", "body"].includes(page) && (
                <MeasurementsPage
                  key={page}
                  mode={page as "overview" | "data" | "body"}
                  members={members.data}
                  devices={devices.data}
                  revision={revision}
                  action={action}
                  busy={busy}
                />
              )}
              {page === "members" && (
                <HealthProfiles
                  key={route.memberId}
                  members={members.data}
                  refresh={revision + version}
                  api={api}
                  action={action}
                  busy={busy}
                />
              )}
              {["devices", "firmware"].includes(page) && (
                <Management
                  key={page}
                  page={page}
                  members={members.data}
                  revision={revision}
                  action={action}
                  busy={busy}
                />
              )}
              {page === "settings" && (
                <SystemSettings
                  revision={revision}
                  action={action}
                  busy={busy}
                />
              )}
              {page === "not-found" && (
                <Card className="health-card">
                  <CardHeader>
                    <CardTitle>页面未找到</CardTitle>
                    <CardDescription>
                      请检查链接地址，或返回家庭概览查看健康数据。
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button asChild>
                      <Link to="/">返回家庭概览</Link>
                    </Button>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          <footer className="flex flex-wrap justify-between gap-2 border-t border-border/60 pt-5 text-xs text-muted-foreground">
            <span>Eir · 家庭健康管理</span>
            {page !== "overview" && (
              <span>所有测量时间以 Asia/Shanghai 显示</span>
            )}
          </footer>
        </main>
      </SidebarInset>
      <MobileBottomNav page={page} />
    </SidebarProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <RoutingProvider>
      <TooltipProvider>
        <RealtimeProvider>
          <App />
        </RealtimeProvider>
      </TooltipProvider>
    </RoutingProvider>
  </BrowserRouter>,
);
