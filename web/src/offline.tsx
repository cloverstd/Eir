import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { registerSW } from "virtual:pwa-register";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  HardDrive,
  RefreshCw,
  Settings,
  Share,
  Smartphone,
  WifiOff,
} from "lucide-react";
import { TimeSeriesChart } from "./components/TimeSeriesChart";
import { DateField } from "./components/DatePicker";
import { Empty, SelectField } from "./components/forms";
import { api, date, networkRead, isOffline, connectionState } from "./api";
import { metricNames } from "./healthDomain";
import { useRealtime } from "./realtime";
import { usePWAInstall } from "./pwa";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import { Label } from "./components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/ui/table";

import {
  offlineEnabled,
  readSnapshot,
  saveSnapshot,
  cacheRead,
  cachedPaths,
} from "./offlineData";
import type { Snapshot } from "./offlineData";

const storage = readSnapshot;

export function OfflineControls({ settings }: { settings: boolean }) {
  const [enabled, setEnabled] = useState(() => offlineEnabled());
  const [message, setMessage] = useState("");
  const [update, setUpdate] = useState(false);
  const [refresh, setRefresh] = useState<() => void>(() => () => {});
  const { version } = useRealtime();
  const [refreshTick, setRefreshTick] = useState(0);
  const { canPrompt, isStandalone, isIOS, installing, install } =
    usePWAInstall();

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState !== "hidden") setRefreshTick((v) => v + 1);
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);

  useEffect(() => {
    const reload = registerSW({
      onNeedRefresh() {
        setUpdate(true);
      },
    });
    setRefresh(() => () => {
      void reload(true);
    });
    // Long-lived home-screen apps also check after returning to the foreground.
    const check = () => {
      if (
        !navigator.onLine ||
        document.visibilityState === "hidden" ||
        !("serviceWorker" in navigator)
      )
        return;
      void navigator.serviceWorker
        .getRegistration()
        .then((registration) => registration?.update())
        .catch(() => {});
    };
    window.addEventListener("online", check);
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, 60 * 60 * 1000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  useEffect(() => {
    let stopped = false,
      inflight = false,
      pending = false;
    const controller = new AbortController();
    const sync = async () => {
      if (document.visibilityState === "hidden" || stopped) return;
      if (inflight) {
        pending = true;
        return;
      }
      inflight = true;
      try {
        if (!enabled) {
          await networkRead("members", controller.signal);
          connectionState(false);
          return;
        }
        const snapshot = await networkRead(
          "offline/snapshot",
          controller.signal,
        );
        if (stopped || !offlineEnabled()) return;
        const previous = await readSnapshot();
        const changed =
          previous &&
          (previous.instance_id !== snapshot.instance_id ||
            previous.data_epoch !== snapshot.data_epoch);
        const paths = changed ? [] : await cachedPaths();
        await saveSnapshot(snapshot);
        setMessage("最近同步：" + date(snapshot.synced_at));
        for (const path of paths) {
          if (stopped) break;
          try {
            const value = await networkRead(path, controller.signal);
            if (!stopped) await cacheRead(path, value);
          } catch {
            /* Keep explicit unavailable state on next read. */
          }
        }
      } catch {
        if (!stopped) setMessage("同步失败，保留上次完整本机数据");
      } finally {
        inflight = false;
        if (pending && !stopped) {
          pending = false;
          void sync();
        }
      }
    };
    const trigger = () => void sync();
    const disconnected = () => connectionState(true);
    window.addEventListener("offline", disconnected);
    const first = setTimeout(trigger, 500),
      timer = setInterval(trigger, 5 * 60 * 1000);
    window.addEventListener("eir-offline-sync-request", trigger);
    window.addEventListener("online", trigger);
    window.addEventListener("eir-data-written", trigger);
    document.addEventListener("visibilitychange", trigger);
    return () => {
      window.removeEventListener("offline", disconnected);
      stopped = true;
      controller.abort();
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener("eir-offline-sync-request", trigger);
      window.removeEventListener("online", trigger);
      window.removeEventListener("eir-data-written", trigger);
      document.removeEventListener("visibilitychange", trigger);
    };
  }, [enabled]);

  useEffect(() => {
    window.dispatchEvent(new Event("eir-offline-sync-request"));
  }, [version, refreshTick]);

  const [offline, setOffline] = useState(isOffline());
  const [lastSync, setLastSync] = useState("");
  useEffect(() => {
    const updateStatus = () => {
      setOffline(isOffline());
      void readSnapshot()
        .then((s) => setLastSync(s?.synced_at || ""))
        .catch(() => {});
    };
    updateStatus();
    window.addEventListener("eir-connection-changed", updateStatus);
    window.addEventListener("eir-offline-updated", updateStatus);
    return () => {
      window.removeEventListener("eir-connection-changed", updateStatus);
      window.removeEventListener("eir-offline-updated", updateStatus);
    };
  }, []);

  const change = async () => {
    const next = !enabled;
    localStorage.setItem("eir-offline-enabled", String(next));
    setEnabled(next);
    if (!next) {
      await saveSnapshot(null);
      setMessage("本机离线数据已清除");
    }
  };

  return (
    <>
      {offline && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-200/90 bg-amber-50/90 px-4 py-3 text-sm text-amber-950 shadow-2xs"
        >
          <div className="flex min-w-0 items-start gap-2.5">
            <WifiOff className="mt-0.5 size-4 shrink-0 text-amber-600" />
            <p className="leading-6">
              正在查看本机数据 ·{" "}
              {lastSync ? "最后同步 " + date(lastSync) : "尚未完成同步"}
              。测量数据限最近 90 天；新增、编辑和设备控制需联网。
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0 rounded-xl border-amber-300 bg-white/85 text-amber-950 hover:bg-white"
            onClick={() => setRefreshTick((v) => v + 1)}
          >
            <RefreshCw className="size-3.5" />
            重试连接
          </Button>
        </div>
      )}

      <div hidden={!settings} className="grid gap-5 lg:grid-cols-2">
        <Card className="health-card gap-4 py-5">
          <CardHeader className="px-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                  <Smartphone className="size-4" />
                </span>
                <div className="space-y-0.5">
                  <CardTitle className="text-base">应用安装（PWA）</CardTitle>
                  <CardDescription className="text-xs">
                    支持手机主屏幕与电脑桌面独立窗口运行
                  </CardDescription>
                </div>
              </div>
              {isStandalone && (
                <Badge className="gap-1 rounded-full bg-emerald-50 text-emerald-700 hover:bg-emerald-50">
                  <CheckCircle2 className="size-3" />
                  已安装
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3.5 px-5 text-sm">
            {isStandalone ? (
              <p className="rounded-xl bg-emerald-50/60 px-3.5 py-2.5 text-xs leading-5 text-emerald-900">
                当前正以独立应用模式运行，支持全屏无地址栏体验、桌面快捷入口及推送通知。
              </p>
            ) : (
              <>
                {canPrompt && (
                  <Button
                    className="rounded-xl"
                    disabled={installing}
                    onClick={() => void install()}
                  >
                    <Download className="size-4" />
                    {installing ? "正在呼出安装…" : "安装 Eir 到本机"}
                  </Button>
                )}
                <div className="space-y-2 rounded-xl bg-muted/50 p-3.5 text-xs leading-5 text-muted-foreground">
                  <p className="flex items-start gap-2 text-foreground">
                    <Share className="mt-0.5 size-3.5 shrink-0 text-blue-600" />
                    <span>
                      iPhone：在 Safari 分享菜单中选择“添加到主屏幕”。
                    </span>
                  </p>
                  {!isIOS && !canPrompt && (
                    <p>
                      桌面浏览器 / Android：在地址栏右侧或浏览器菜单中选择「安装应用」或「添加到主屏幕」。
                    </p>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="health-card gap-4 py-5">
          <CardHeader className="px-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                  <HardDrive className="size-4" />
                </span>
                <div className="space-y-0.5">
                  <CardTitle className="text-base">离线数据保存</CardTitle>
                  <CardDescription className="text-xs">
                    断网或离开家庭内网时仍可查阅最近 90 天指标
                  </CardDescription>
                </div>
              </div>
              <Badge
                variant={enabled ? "secondary" : "outline"}
                className={
                  enabled
                    ? "rounded-full bg-emerald-50 text-emerald-700"
                    : "rounded-full text-muted-foreground"
                }
              >
                {enabled ? "已开启" : "未开启"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 px-5">
            <p className="text-xs leading-5 text-muted-foreground">
              离线保存全家最近 90
              天的指标，以及成员资料和已查看的数据列表。应用打开时每 5
              分钟自动同步，回到前台或恢复网络时立即检查。不保存医疗文件原件；设备上的其他使用者也能查看。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={enabled ? "outline" : "default"}
                size="sm"
                className="rounded-xl"
                onClick={() =>
                  void change().catch(() => setMessage("本机存储不可用"))
                }
              >
                {enabled ? "关闭并清除离线数据" : "开启离线保存"}
              </Button>
              {enabled && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-xl"
                  onClick={() => setRefreshTick((v) => v + 1)}
                >
                  <RefreshCw className="size-3.5" />
                  立即同步
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="rounded-xl"
                asChild
              >
                <Link to="/offline">查看离线数据</Link>
              </Button>
            </div>
            {message && (
              <p
                role="status"
                className="rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
              >
                {message}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {update && (
        <div
          role="status"
          className="fixed inset-x-4 bottom-20 z-40 mx-auto flex max-w-md items-center justify-between gap-3 rounded-2xl border border-blue-200 bg-card/95 px-4 py-3 shadow-lg backdrop-blur-xl md:inset-x-auto md:right-6 md:bottom-6"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <RefreshCw className="size-4 text-primary" />
            <span>发现新版本</span>
          </div>
          <Button size="sm" className="rounded-xl" onClick={refresh}>
            新版本可用，刷新应用
          </Button>
        </div>
      )}
    </>
  );
}

export function OfflinePage() {
  const location = useLocation();
  const focus = new URLSearchParams(location.search).get("measurement_id");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [member, setMember] = useState(""),
    [kind, setKind] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");

  useEffect(() => {
    let alive = true;
    const read = () => {
      void storage()
        .then((value) => {
          if (alive) setSnapshot(value);
        })
        .catch(() => {
          if (alive) setError("无法读取本机存储");
        });
    };
    read();
    window.addEventListener("eir-offline-updated", read);
    return () => {
      alive = false;
      window.removeEventListener("eir-offline-updated", read);
    };
  }, []);

  const rows = (snapshot?.observations ?? []).filter(
    (row) =>
      (!member || row.member_id === member) &&
      (!kind || row.kind === kind) &&
      Date.parse(row.measured_at) >= Date.now() - 90 * 86400000 &&
      (!from || row.measured_at.slice(0, 10) >= from) &&
      (!to || row.measured_at.slice(0, 10) <= to),
  );

  const chartKinds = Object.keys(metricNames).filter((k) => !kind || kind === k);

  return (
    <div className="space-y-5">
      <Card className="health-card gap-4 py-5">
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 px-4 sm:px-5">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                离线数据 · 只读
              </h2>
              <Badge
                variant="secondary"
                className="rounded-full bg-emerald-50 text-xs font-normal text-emerald-700"
              >
                最近 90 天快照
              </Badge>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              {error ||
                (!snapshot
                  ? "尚无离线数据，请联网后在系统管理开启保存。"
                  : "截至 " +
                    date(snapshot.synced_at) +
                    "，仅包含同步时最近 90 天的数据。")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="rounded-xl" asChild>
              <Link to="/settings">
                <Settings className="size-3.5" />
                离线设置
              </Link>
            </Button>
            <Button size="sm" variant="secondary" className="rounded-xl" asChild>
              <Link to="/">
                <ArrowLeft className="size-3.5" />
                返回在线首页
              </Link>
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 px-4 sm:px-5">
          {focus && (
            <p
              role="status"
              className="rounded-xl border border-blue-200/80 bg-blue-50/70 px-3.5 py-2.5 text-xs text-blue-950"
            >
              {snapshot?.observations.some((r) => r.source_record_id === focus)
                ? "通知测量已包含在以下本机记录中"
                : "通知中的测量尚未同步到本机，请连接服务后查看。"}
            </p>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
              家庭成员
              <SelectField
                aria-label="成员"
                value={member}
                onChange={(e) => setMember(e.target.value)}
              >
                <option value="">全家成员</option>
                {snapshot?.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </SelectField>
            </Label>
            <Label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
              指标类型
              <SelectField
                aria-label="指标"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                <option value="">所有指标</option>
                {Object.entries(metricNames).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </SelectField>
            </Label>
            <Label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
              开始日期
              <DateField
                type="date"
                aria-label="开始日期"
                value={from}
                min={snapshot?.window_start.slice(0, 10)}
                max={snapshot?.synced_at.slice(0, 10)}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Label>
            <Label className="grid min-w-0 gap-1.5 text-xs text-muted-foreground">
              结束日期
              <DateField
                type="date"
                aria-label="结束日期"
                value={to}
                min={from || snapshot?.window_start.slice(0, 10)}
                max={snapshot?.synced_at.slice(0, 10)}
                onChange={(e) => setTo(e.target.value)}
              />
            </Label>
          </div>
        </CardContent>
      </Card>

      {chartKinds.some((k) => rows.some((r) => r.kind === k)) && (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          {chartKinds.map((k) => {
            const points = rows.filter((r) => r.kind === k);
            if (!points.length) return null;
            return (
              <Card key={k} className="health-card min-w-0 gap-2 py-4 sm:py-5">
                <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 sm:px-5">
                  <CardTitle className="text-sm font-semibold">
                    {metricNames[k]}
                  </CardTitle>
                  {member && (
                    <Badge
                      variant="secondary"
                      className="rounded-full font-normal tabular-nums"
                    >
                      缓存中最新：{points[0].value}
                      {points[0].value_secondary != null
                        ? "/" + points[0].value_secondary
                        : ""}{" "}
                      {points[0].unit}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="min-w-0 px-2.5 sm:px-4">
                  <TimeSeriesChart
                    label={metricNames[k]}
                    unit={points[0].unit}
                    highlightWeekendsAndHolidays={k === "weight"}
                    series={(snapshot?.members ?? [])
                      .filter((m) => !member || m.id === member)
                      .flatMap((m) => {
                        const values = points
                          .filter((r) => r.member_id === m.id)
                          .sort(
                            (a, b) =>
                              Date.parse(a.measured_at) -
                              Date.parse(b.measured_at),
                          );
                        return [
                          {
                            id: m.id,
                            name: m.name,
                            data: values.map(
                              (r) =>
                                [
                                  Date.parse(r.measured_at),
                                  Number(r.value),
                                ] as [number, number],
                            ),
                          },
                          ...(k === "blood_pressure"
                            ? [
                                {
                                  id: m.id + "-diastolic",
                                  name: m.name + " 舒张压",
                                  lineType: "dashed" as const,
                                  data: values.map(
                                    (r) =>
                                      [
                                        Date.parse(r.measured_at),
                                        Number(r.value_secondary),
                                      ] as [number, number],
                                  ),
                                },
                              ]
                            : []),
                        ];
                      })}
                  />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="health-card gap-3 py-5">
        <CardHeader className="flex flex-row items-center justify-between gap-2 px-4 sm:px-5">
          <div className="space-y-0.5">
            <CardTitle className="text-base">本机缓存明细</CardTitle>
            <CardDescription className="text-xs">
              共 {rows.length} 条离线记录
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {!rows.length ? (
            <div className="px-4 sm:px-5">
              <Empty>当前筛选条件下暂无本机离线记录</Empty>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/35 hover:bg-muted/35">
                  <TableHead className="pl-4 sm:pl-5">成员</TableHead>
                  <TableHead>指标</TableHead>
                  <TableHead>读数</TableHead>
                  <TableHead className="pr-4 sm:pr-5">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow
                    key={row.id}
                    className={
                      row.source_record_id === focus ? "bg-blue-50/70" : ""
                    }
                  >
                    <TableCell className="pl-4 font-medium sm:pl-5">
                      {
                        snapshot?.members.find((m) => m.id === row.member_id)
                          ?.name
                      }
                    </TableCell>
                    <TableCell>{metricNames[row.kind]}</TableCell>
                    <TableCell className="font-semibold tabular-nums">
                      {row.value}
                      {row.value_secondary != null
                        ? "/" + row.value_secondary
                        : ""}{" "}
                      {row.unit}
                      {row.estimated ? "（估算）" : ""}
                    </TableCell>
                    <TableCell className="pr-4 text-xs text-muted-foreground sm:pr-5">
                      {date(row.measured_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
