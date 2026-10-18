import { DurationPicker } from "./components/DatePicker";
import { deviceLabel } from "./bodyDomain";
import { Button } from "./components/ui/button";
import { Label } from "./components/ui/label";
import { Card } from "./components/ui/card";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { useQueryState } from "./routing";
import { signalFresh, signalLevel, signalLinkState } from "./signalDomain";
import { useAPI, useRealtime } from "./realtime";
import { TimeSeriesChart } from "./components/TimeSeriesChart";
import type { ChartSeries } from "./chartDomain";
import type { Row } from "./api";
const Context = createContext<{
  rows: Row[];
  version: number;
  now: number;
  error: string;
}>({ rows: [], version: 0, now: 0, error: "" });
export function SignalProvider({ children }: { children: ReactNode }) {
  const { version, signalsVersion } = useRealtime();
  const resource = useAPI<Row[]>("signals/latest", [], signalsVersion);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <Context.Provider
      value={{
        rows: resource.data,
        version: version + signalsVersion,
        now,
        error: resource.error,
      }}
    >
      {children}
    </Context.Provider>
  );
}
const date = (s: string) =>
  new Date(s).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
export function SignalValue({
  collector,
  device,
  compact = false,
}: {
  collector?: Row;
  device?: Row;
  compact?: boolean;
}) {
  const { rows, now, error } = useContext(Context);
  const kind = device ? "ble" : "wifi";
  const row = rows.find(
    (r) =>
      r.collector_id === collector?.id &&
      r.kind === kind &&
      (!device || r.device_id === device.id),
  );
  const legacy = !device && !collector?.status?.capabilities?.signals;
  const heartbeatRSSI = collector?.status?.rssi ?? collector?.status?.wifi_rssi;
  const fallback =
    legacy && typeof heartbeatRSSI === "number" && heartbeatRSSI !== 0
      ? heartbeatRSSI
      : null;
  const rssi = row ? row.rssi : fallback;
  const at = row?.sampled_at || (legacy ? collector?.last_seen : null);
  const online = row
    ? row.online && now - Date.parse(collector?.last_seen || 0) < 90000
    : collector?.online;
  const fresh = signalFresh(at, now) && (!row || row.fresh);
  const level = signalLevel(rssi);
  const q = new URLSearchParams({
    signal_collector_id: collector?.id || "",
    signal_kind: kind,
  });
  if (device) q.set("signal_device_id", device.id);
  let state = !collector
    ? "尚未关联采集端"
    : !online
      ? "采集端离线"
      : !at
        ? "尚未观测"
        : !fresh
          ? "最近信号，已过期"
          : rssi == null
            ? "信号不可用"
            : device
              ? signalLinkState(row?.source, !!row?.connected)
              : "Wi-Fi 已连接";
  if (device && at && !fresh && online) state += " · 设备可能休眠";
  return (
    <div
      className={
        "flex min-w-0 flex-col gap-1.5 text-sm" +
        (compact ? "text-xs" : "") +
        (!fresh || !online ? "text-muted-foreground" : "")
      }
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-5 items-end gap-0.5" aria-hidden="true">
          {[1, 2, 3, 4].map((n) => (
            <i
              key={n}
              className={n <= level.bars ? "bg-foreground" : ""}
              style={{ height: 4 + n * 3 }}
            />
          ))}
        </span>
        <strong>{rssi == null ? "—" : `${rssi} dBm`}</strong>
        <span>{rssi == null ? "" : level.label}</span>
      </span>
      {compact && (!fresh || !online) && (
        <small className="block text-xs leading-5 text-muted-foreground">
          {state}
        </small>
      )}
      {!compact && (
        <>
          <small className="block text-xs leading-5 text-muted-foreground">
            {device ? "蓝牙" : "Wi-Fi"} · {state}
          </small>
          <small className="block text-xs leading-5 text-muted-foreground">
            {at ? `采样于 ${date(at)}` : "等待设备上报"}
            {row
              ? ` · ${{ wifi: "接入点", advertisement: "广播", connection: "连接" }[row.source as string] || row.source}`
              : ""}
          </small>
          {legacy && (
            <small className="block text-xs leading-5 text-muted-foreground">
              心跳数据 · 升级固件后支持完整信号监测
            </small>
          )}
          {error && (
            <small
              role="status"
              className="block text-xs leading-5 text-muted-foreground"
            >
              {error}，显示上次数据
            </small>
          )}
          {collector && <Link to={"/devices?" + q}>查看趋势 →</Link>}
        </>
      )}
    </div>
  );
}
export function SignalHistory({
  collectors,
  devices,
}: {
  collectors: Row[];
  devices: Row[];
}) {
  const [collector] = useQueryState("signal_collector_id", ""),
    [kind] = useQueryState("signal_kind", ""),
    [device] = useQueryState("signal_device_id", "");
  const [range, setRange] = useQueryState("signal_range", "1h");
  const { version } = useContext(Context),
    location = useLocation();
  const valid =
    !!collectors.find((c) => c.id === collector) &&
    ["wifi", "ble"].includes(kind) &&
    (kind === "wifi" ||
      !!devices.find((d) => d.id === device && d.collector_id === collector));
  const q = new URLSearchParams({ collector_id: collector, kind, range });
  if (kind === "ble") q.set("device_id", device);
  const resource = useAPI<{
    items: Row[];
  }>(valid ? "signals/history?" + q : null, { items: [] }, version);
  const rows = resource.data.items;
  const series: ChartSeries[] = [
    ["平均", "mean"],
    ["最弱", "min"],
    ["最强", "max"],
  ].map(([name, key]) => ({
    id: key,
    name,
    data: rows.map((r) => [Date.parse(r.time), r[key]]),
  }));
  if (!collector) return null;
  const close = new URLSearchParams(location.search);
  for (const key of [
    "signal_collector_id",
    "signal_kind",
    "signal_device_id",
    "signal_range",
  ])
    close.delete(key);
  return (
    <Card className="space-y-4 gap-4 p-5 shadow-none scroll-mt-20">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
          信号趋势 ·{" "}
          {kind === "ble"
            ? devices.find((d) => d.id === device)
              ? deviceLabel(devices.find((d) => d.id === device)!)
              : "已移除设备"
            : collectors.find((c) => c.id === collector)?.name}{" "}
          · {kind === "ble" ? "蓝牙" : "Wi-Fi"}
        </h2>
        <Button asChild variant="link">
          <Link to={{ pathname: "/devices", search: close.toString() }}>
            收起
          </Link>
        </Button>
      </div>
      {!valid ? (
        <p className="text-sm leading-6 text-muted-foreground">
          信号链路未找到，请重新选择设备。
        </p>
      ) : (
        <>
          <Label className="grid min-w-0 gap-2 text-sm">
            时间范围
            <DurationPicker value={range} onChange={setRange} />
          </Label>
          <p className="text-sm leading-6 text-muted-foreground">
            每 5 秒采样，保留 7 天。信号等级用于比较摆放位置。
          </p>
          {resource.error && (
            <p role="alert" className="text-sm leading-6 text-muted-foreground">
              {resource.error}
            </p>
          )}
          {!rows.some((r) => r.count > 0) && (
            <p className="text-sm leading-6 text-muted-foreground">
              该时段暂无信号记录，等待设备上报。
            </p>
          )}
          <TimeSeriesChart
            series={series}
            unit="dBm"
            label="信号强度历史趋势，缺测区间断开"
          />
        </>
      )}
    </Card>
  );
}
