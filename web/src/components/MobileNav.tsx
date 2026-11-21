import { useState } from "react";
import { Link } from "react-router";
import {
  Activity,
  ChevronRight,
  Download,
  HardDrive,
  HeartPulse,
  LayoutGrid,
  Radio,
  Scale,
  Settings,
  Smartphone,
  Upload,
  Users,
} from "lucide-react";
import { pagePaths } from "../routingDomain";
import { usePWAInstall } from "../pwa";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";

const primaryTabs = [
  { id: "overview", label: "概览", icon: Activity, activeColor: "text-blue-600" },
  { id: "data", label: "血压", icon: HeartPulse, activeColor: "text-rose-500" },
  { id: "body", label: "体重", icon: Scale, activeColor: "text-teal-600" },
  { id: "members", label: "档案", icon: Users, activeColor: "text-violet-600" },
];

const moreItems = [
  {
    id: "devices",
    label: "设备",
    description: "管理采集端、血压计与体脂秤",
    icon: Radio,
    iconStyle: "bg-blue-50 text-blue-600",
  },
  {
    id: "firmware",
    label: "固件升级",
    description: "上传固件并跟踪远程 OTA 进度",
    icon: Upload,
    iconStyle: "bg-indigo-50 text-indigo-600",
  },
  {
    id: "offline",
    label: "离线数据",
    description: "查看本机保存的最近 90 天指标",
    icon: HardDrive,
    iconStyle: "bg-emerald-50 text-emerald-600",
  },
  {
    id: "settings",
    label: "系统管理",
    description: "PWA 安装、离线同步、通知与重置",
    icon: Settings,
    iconStyle: "bg-slate-100 text-slate-700",
  },
];

export function MobileBottomNav({ page }: { page: string }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const { canPrompt, isStandalone, isIOS, installing, install } =
    usePWAInstall();
  const inMore = moreItems.some((item) => item.id === page);

  return (
    <>
      <nav
        aria-label="底部主导航"
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-border/80 bg-card/90 backdrop-blur-xl md:hidden"
      >
        <div className="mx-auto grid h-16 max-w-lg grid-cols-5 items-center px-1.5">
          {primaryTabs.map((item) => {
            const active = page === item.id;
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                to={pagePaths[item.id]}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 text-[11px] font-medium transition-colors",
                  active
                    ? item.activeColor
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                    active && "bg-primary/10",
                  )}
                >
                  <Icon className="size-5" strokeWidth={active ? 2.25 : 1.85} />
                </span>
                <span className="leading-none">{item.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-expanded={moreOpen}
            aria-label="更多功能"
            className={cn(
              "flex flex-col items-center justify-center gap-0.5 rounded-xl py-1.5 text-[11px] font-medium transition-colors",
              inMore || moreOpen
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                (inMore || moreOpen) && "bg-primary/10",
              )}
            >
              <LayoutGrid
                className="size-5"
                strokeWidth={inMore || moreOpen ? 2.25 : 1.85}
              />
            </span>
            <span className="leading-none">更多</span>
          </button>
        </div>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className="safe-bottom rounded-t-3xl border-t px-4 pt-3 pb-6"
        >
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-muted-foreground/25" />
          <SheetHeader className="px-1 pb-2 text-left">
            <SheetTitle className="text-base">设备与系统</SheetTitle>
            <SheetDescription className="text-xs">
              管理硬件设备、离线数据、通知与系统设置
            </SheetDescription>
          </SheetHeader>
          <div className="mt-2 space-y-1.5">
            {moreItems.map((item) => {
              const Icon = item.icon;
              const active = page === item.id;
              return (
                <Link
                  key={item.id}
                  to={pagePaths[item.id]}
                  onClick={() => setMoreOpen(false)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-3.5 rounded-2xl border p-3 transition-colors",
                    active
                      ? "border-primary/30 bg-primary/5"
                      : "border-transparent bg-muted/45 hover:bg-muted/70",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-xl",
                      item.iconStyle,
                    )}
                  >
                    <Icon className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                      {item.label}
                      {active && (
                        <Badge
                          variant="secondary"
                          className="h-5 px-1.5 text-[10px] font-normal text-primary"
                        >
                          当前
                        </Badge>
                      )}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {item.description}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
                </Link>
              );
            })}
          </div>

          {!isStandalone && (canPrompt || isIOS) && (
            <div className="mt-4 rounded-2xl border border-blue-200/70 bg-blue-50/70 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-600">
                    <Smartphone className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      安装 Eir 到主屏幕
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {canPrompt
                        ? "全屏独立窗口，支持离线与通知"
                        : "在 Safari 分享菜单选择“添加到主屏幕”"}
                    </p>
                  </div>
                </div>
                {canPrompt && (
                  <Button
                    size="sm"
                    disabled={installing}
                    onClick={() => void install()}
                  >
                    <Download className="size-3.5" />
                    安装
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
