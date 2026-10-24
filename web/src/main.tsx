import { PushSettings, FocusMeasurement } from "./push";
import { OfflineControls, OfflinePage } from "./offline";
import { useCallback, useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, useLocation, useNavigate } from "react-router";
import {
  Activity,
  Heart,
  HeartPulse,
  Scale,
  Radio,
  Users,
  Upload,
  Settings,
  X,
} from "lucide-react";
import { RoutingProvider } from "./routing";
import { pagePaths, routeForPath } from "./routingDomain";
import { api } from "./api";
import type { Row } from "./api";
import { RealtimeProvider, useAPI, useRealtime } from "./realtime";
import { MeasurementsPage } from "./measurements";
import { Management } from "./management";
import { HealthProfiles } from "./health";
import { Operations, ResetAction } from "./lifecycle";
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
import "./style.css";

const pages = [
 {id:"offline",label:"离线数据",icon:Heart,description:"查看本机保存的最近 90 天健康指标"},
  {
    id: "overview",
    label: "家庭概览",
    icon: Activity,
    description: "家人的最新读数与健康趋势",
  },
  {
    id: "data",
    label: "血压数据",
    icon: HeartPulse,
    description: "查看每一次血压与脉搏变化",
  },
  {
    id: "body",
    label: "体重与体脂",
    icon: Scale,
    description: "记录体重与估算体脂的变化",
  },
  {
    id: "devices",
    label: "设备",
    icon: Radio,
    description: "管理采集端与家中的测量设备",
  },
  {
    id: "members",
    label: "家庭成员",
    icon: Users,
    description: "为每位家人保管健康资料",
  },
  {
    id: "firmware",
    label: "固件升级",
    icon: Upload,
    description: "管理固件与采集端升级进度",
  },
  {
    id: "settings",
    label: "系统管理",
    icon: Settings,
    description: "查看操作进度与管理数据重置",
  },
];
function Navigation({ page }: { page: string }) {
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b p-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg">
              <Link to="/" onClick={() => setOpenMobile(false)}>
                <img
                  src="/icon-anime-v1-192.png"
                  alt=""
                  className="size-8 shrink-0 rounded-lg"
                />
                <span className="grid gap-0.5">
                  <strong className="text-base tracking-tight">Eir</strong>
                  <span className="text-xs text-muted-foreground">
                    家庭健康空间
                  </span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="mb-2 mt-3">家庭空间</SidebarGroupLabel>
          <SidebarMenu>
            {pages.map((item) => (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  asChild
                  isActive={page === item.id}
                  tooltip={item.label}
                  className="h-10"
                >
                  <Link
                    to={pagePaths[item.id]}
                    onClick={() => setOpenMobile(false)}
                    aria-current={page === item.id ? "page" : undefined}
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t px-4 py-4 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        <span>家庭内网 · 数据由你保管</span>
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
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>数据重置</CardTitle>
          <CardDescription>
            先预览影响范围，再确认执行。已有备份和导出文件不受影响。
          </CardDescription>
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
        <Alert variant="destructive">
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
  const navigate = useNavigate();
  const initialConnection = useRef(true);
  useEffect(() => {
    if (!initialConnection.current || members.loading) return;
    initialConnection.current = false;
    if (members.error && page !== "offline") navigate("/offline" + location.search, {replace:true});
  }, [members.loading, members.error, navigate, page, location.search]);
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
  return (
    <SidebarProvider>
      <Navigation page={page} />
      <SidebarInset className="min-w-0 bg-background">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <SidebarTrigger aria-label="展开或收起导航" />
            <Separator orientation="vertical" className="h-4" />
            <span className="truncate text-sm font-medium">
              {current?.label || "页面未找到"}
            </span>
          </div>
          <Badge
            variant="outline"
            className="shrink-0 gap-1.5 bg-card font-normal text-muted-foreground"
            role="status"
          >
            <span
              className={`size-1.5 rounded-full ${status === "connected" ? "bg-emerald-500" : "bg-amber-500"}`}
            />
            {page === "offline" ? "本机数据" : status === "connected"
              ? "实时同步"
              : status === "connecting"
                ? "连接中"
                : "正在重连"}
          </Badge>
        </header>
        <main className="mx-auto w-full max-w-[1680px] min-w-0 flex-1 space-y-6 px-4 py-6 sm:px-6 sm:py-8 lg:px-8">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">
              {current?.label || "页面未找到"}
            </h1>
            {page !== "overview" && (
              <p className="text-sm text-muted-foreground">
                {current?.description || "该地址暂时没有对应页面。"}
              </p>
            )}
          </div>
          {page !== "offline" && (error || members.error || devices.error) && (
            <Alert variant="destructive">
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
            <Alert>
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
          {page === "settings" && <PushSettings members={members.data}/>}
          {page !== "offline" && members.error && <Link to="/offline">无法连接服务，查看本机离线数据</Link>}
          {members.loading && !members.loaded ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-60" />
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton className="h-32" key={i} />
                ))}
              </div>
              <Skeleton className="h-80" />
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
                <Card>
                  <CardHeader>
                    <CardTitle>页面未找到</CardTitle>
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
          <footer className="flex flex-wrap justify-between gap-2 border-t pt-5 text-xs text-muted-foreground">
            <span>Eir · 家庭健康管理</span>
            {page !== "overview" && (
              <span>所有测量时间以 Asia/Shanghai 显示</span>
            )}
          </footer>
        </main>
      </SidebarInset>
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
