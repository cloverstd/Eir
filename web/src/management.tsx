import { DateField } from "./components/DatePicker";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./components/ui/table";
import { SelectField, CheckboxField } from "./components/forms";
import { useEffect, useState } from "react";
import type React from "react";
import {
  Plus,
  Users,
  Radio,
  Scale,
  HeartPulse,
  ChevronDown,
} from "lucide-react";
import { api, date } from "./api";
import type { Row } from "./api";
import { useResource } from "./realtime";
import { scaleProfile, scaleNumber, deviceLabel } from "./bodyDomain";
import { isHistoryStart } from "./domain";
import { SignalProvider, SignalValue, SignalHistory } from "./signals";
import {
  Discovered,
  CollectorActions,
  DeviceActions,
  ConfirmAction,
  Operations,
} from "./lifecycle";
import { Empty, Disclosure } from "./components/forms";
import { Button } from "./components/ui/button";
import {
  Card,
  CardHeader,
  CardContent,
  CardFooter,
  CardTitle,
  CardDescription,
} from "./components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import { Badge } from "./components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { Alert, AlertDescription } from "./components/ui/alert";

type Props = {
  page: string;
  members: Row[];
  revision: number;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  busy: boolean;
};

function form(e: React.FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<
    string,
    string
  >;
}

function safeDebugURL(s: Row | undefined) {
  if (!s) return;
  try {
    const u = new URL(s.debug_url || (s.ip ? `http://${s.ip}` : ""));
    if (["http:", "https:"].includes(u.protocol)) return u.href;
  } catch {}
}

function MeasurementDeviceCard({
  device,
  collector,
  members,
  children,
}: {
  device: Row;
  collector?: Row;
  members: string;
  children: React.ReactNode;
}) {
  const code = scaleNumber(device);
  const isScale = device.profile === scaleProfile;
  return (
    <Collapsible asChild>
      <Card className="health-card min-w-0 gap-4 py-5 transition-shadow hover:shadow-md">
        <CardHeader className="gap-3 px-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div
                className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                  isScale
                    ? "bg-teal-50 text-teal-600"
                    : "bg-rose-50 text-rose-500"
                }`}
              >
                {isScale ? (
                  <Scale className="size-5" />
                ) : (
                  <HeartPulse className="size-5" />
                )}
              </div>
              <div className="min-w-0">
                <CardTitle className="truncate text-base">
                  {device.name}
                </CardTitle>
                <CardDescription className="mt-0.5 text-xs">
                  {isScale ? "体脂秤" : "血压计"} · {device.model}
                </CardDescription>
              </div>
            </div>
            {code && (
              <Badge
                variant="outline"
                className="shrink-0 rounded-lg font-mono text-xs"
              >
                {code}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 px-5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xl bg-muted/40 p-3 text-xs">
            <dt className="text-muted-foreground">所属成员</dt>
            <dd className="truncate font-medium text-foreground">
              {members || "待绑定成员"}
            </dd>
            <dt className="text-muted-foreground">采集端</dt>
            <dd className="truncate">
              {collector?.name || collector?.id || "未分配"}
            </dd>
            <dt className="text-muted-foreground">最近测量</dt>
            <dd>
              {device.last_measured_at
                ? date(device.last_measured_at)
                : "暂无测量"}
            </dd>
          </dl>
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span>蓝牙</span>
            <SignalValue collector={collector} device={device} compact />
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-between gap-2 px-5">
          <Badge
            variant="secondary"
            className={
              device.lifecycle_state === "active"
                ? "rounded-full bg-emerald-50 font-normal text-emerald-700"
                : "rounded-full font-normal"
            }
          >
            {device.lifecycle_state === "active"
              ? "已接入"
              : device.collector_id
                ? "接入中"
                : "未分配"}
          </Badge>
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="group rounded-xl"
              aria-label={`${deviceLabel(device)}的详情与操作`}
            >
              详情与操作
              <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            </Button>
          </CollapsibleTrigger>
        </CardFooter>
        <CollapsibleContent className="border-t border-border/70 px-5 pt-4">
          {children}
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

export function Management({
  page: tab,
  members,
  revision,
  action,
  busy,
}: Props) {
  const paths =
    tab === "devices"
      ? [
          "devices",
          "collectors",
          "bindings",
          "rejections",
          "collectors/discovered",
          "operations",
          "events",
        ]
      : ["collectors", "firmwares", "ota-jobs"];
  const resource = useResource<Record<string, Row[]>>(
    "management:" + tab,
    async (signal) =>
      Object.fromEntries(
        await Promise.all(
          paths.map(async (path) => [
            path,
            await api(path, "GET", undefined, signal),
          ]),
        ),
      ),
    {},
    revision,
  );
  const {
    devices = [],
    collectors = [],
    bindings = [],
    rejections = [],
    operations = [],
    events = [],
    firmwares = [],
  } = resource.data;
  const discovered = resource.data["collectors/discovered"] || [],
    jobs = resource.data["ota-jobs"] || [];
  const [bindingDevice, setBindingDevice] = useState(""),
    [slot, setSlot] = useState("1"),
    [preview, setPreview] = useState<number | null>(null);
  const [scanAddress, setScanAddress] = useState(""),
    [scanCollector, setScanCollector] = useState(""),
    [scanAddressType, setScanAddressType] = useState("0"),
    [scanProfile, setScanProfile] = useState("omron-hem-7374t1"),
    [scanHardware, setScanHardware] = useState("");
  const [adding, setAdding] = useState(false),
    [bindingOpen, setBindingOpen] = useState(false);

  useEffect(() => {
    setPreview(null);
    if (!bindingDevice) return;
    const controller = new AbortController();
    api(
      `bindings/preview?device_id=${encodeURIComponent(bindingDevice)}&user_slot=${devices.find((d) => d.id === bindingDevice)?.profile === scaleProfile ? 0 : slot}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((r) => {
        if (!controller.signal.aborted) setPreview(r.unassigned_count);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [bindingDevice, slot, revision]);

  function command(id: string, type: string, device_id?: string) {
    return action(
      () =>
        api(`collectors/${encodeURIComponent(id)}/commands`, "POST", {
          type,
          ...(device_id ? { device_id } : {}),
        }),
      "指令已提交，请查看设备事件中的执行结果",
    );
  }

  const deviceRow = (d: Row) => (
    <MeasurementDeviceCard
      key={d.id}
      device={d}
      collector={collectors.find((c) => c.id === d.collector_id)}
      members={bindings
        .filter((b) => b.device_id === d.id && !b.effective_to)
        .map((b) => b.member_name)
        .join(" / ")}
    >
      <div className="space-y-4 pt-1">
        <p className="text-xs leading-5 text-muted-foreground">
          {d.profile === scaleProfile
            ? "唤醒体脂秤即可连接；每台秤在下方绑定一位家庭成员。"
            : "配对前请在血压计上长按蓝牙按键进入配对模式。配对会注册此采集端；正常读取不修改设置。"}
        </p>
        <p className="font-mono text-xs text-muted-foreground">
          {d.address} ·{" "}
          {collectors.find((c) => c.id === d.collector_id)?.name ||
            d.collector_id}
        </p>
        {d.profile !== scaleProfile && (
          <div className="flex flex-wrap items-start gap-2">
            <Button
              size="sm"
              className="rounded-xl"
              disabled={
                busy || !collectors.find((c) => c.id === d.collector_id)?.online
              }
              onClick={() => command(d.collector_id, "pair", d.id)}
            >
              配对 / 重新配对
            </Button>
            <Button
              size="sm"
              className="rounded-xl"
              disabled={
                busy || !collectors.find((c) => c.id === d.collector_id)?.online
              }
              onClick={() => command(d.collector_id, "read", d.id)}
              variant="outline"
            >
              诊断读取
            </Button>
            <Button
              size="sm"
              className="rounded-xl"
              disabled={
                busy || !collectors.find((c) => c.id === d.collector_id)?.online
              }
              onClick={() => command(d.collector_id, "backfill", d.id)}
              variant="outline"
            >
              补采遗漏记录
            </Button>
          </div>
        )}
        {d.profile === scaleProfile && (
          <>
            {d.lifecycle_state !== "active" && d.collector_id && (
              <Button
                size="sm"
                className="rounded-xl"
                disabled={
                  busy ||
                  !collectors.find((c) => c.id === d.collector_id)?.online
                }
                onClick={() => command(d.collector_id, "pair", d.id)}
              >
                重试接入验证
              </Button>
            )}
            <Label className="grid min-w-0 gap-2 text-sm">
              体脂估算通道
              <SelectField
                value={d.adc_index}
                disabled={busy}
                onChange={(e) =>
                  action(
                    () =>
                      api("devices/" + d.id, "PATCH", {
                        adc_index: Number(e.target.value),
                      }),
                    "计算通道已保存，仅影响新测量",
                  )
                }
              >
                <option value="0">ADC 1（默认）</option>
                <option value="1">ADC 2</option>
              </SelectField>
            </Label>
            <p className="text-xs leading-5 text-muted-foreground">
              所属成员：
              {bindings.find((b) => b.device_id === d.id && !b.effective_to)
                ?.member_name || "待绑定"}
              {!collectors.find((c) => c.id === d.collector_id)?.status
                ?.capabilities?.signals && (
                <>
                  {" "}
                  ·{" "}
                  {collectors
                    .find((c) => c.id === d.collector_id)
                    ?.status?.devices?.find((v: Row) => v.id === d.id)
                    ?.connected
                    ? "蓝牙已连接"
                    : "等待秤唤醒"}
                </>
              )}
            </p>
          </>
        )}
        <SignalValue
          collector={collectors.find((c) => c.id === d.collector_id)}
          device={d}
        />
        <DeviceActions
          device={d}
          collectors={collectors}
          api={api}
          action={action}
          busy={busy}
        />
        <Button
          size="sm"
          variant="outline"
          className="rounded-xl"
          onClick={() => {
            setBindingDevice(d.id);
            setBindingOpen(true);
          }}
        >
          <Users className="size-4" />
          成员绑定
        </Button>
      </div>
    </MeasurementDeviceCard>
  );

  return (
    <div className="space-y-5">
      {resource.error && (
        <Alert variant="destructive" className="rounded-2xl bg-card">
          <AlertDescription>
            设备数据暂时无法更新，保留上次结果。{resource.error}
          </AlertDescription>
        </Alert>
      )}
      {tab === "devices" && (
        <SignalProvider>
          <div className="health-card flex flex-wrap items-center justify-between gap-3 border bg-card px-4 py-3.5">
            <p className="text-sm text-muted-foreground">
              <strong className="font-semibold text-foreground">
                {collectors.filter((c) => c.online).length}
              </strong>{" "}
              个采集端在线 ·{" "}
              <strong className="font-semibold text-foreground">
                {devices.length}
              </strong>{" "}
              台测量设备
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                className="rounded-xl"
                onClick={() => setBindingOpen(true)}
              >
                <Users className="size-4" />
                成员绑定
              </Button>
              <Button
                size="sm"
                className="rounded-xl"
                onClick={() => setAdding(true)}
              >
                <Plus className="size-4" />
                添加设备
              </Button>
            </div>
          </div>
          <div className="grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
            <section className="min-w-0 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">测量设备</h2>
                <Badge variant="secondary" className="rounded-full font-normal">
                  {devices.length} 台
                </Badge>
              </div>
              {devices.length ? (
                <div className="grid min-w-0 items-start gap-4 sm:grid-cols-2">
                  {devices.map(deviceRow)}
                </div>
              ) : (
                <Empty>还没有测量设备，点击添加设备开始连接。</Empty>
              )}
            </section>
            <section className="min-w-0 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold">采集端</h2>
                <Badge variant="secondary" className="rounded-full font-normal">
                  {collectors.filter((c) => c.online).length} /{" "}
                  {collectors.length} 在线
                </Badge>
              </div>
              {collectors.map((c) => (
                <Card key={c.id} className="health-card gap-4 p-4 sm:p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div
                        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                          c.online
                            ? "bg-blue-50 text-blue-600"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        <Radio className="size-5" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
                          {c.name || c.id}
                        </h2>
                        <p className="text-xs text-muted-foreground">
                          {c.location || "未设置位置"} ·{" "}
                          {
                            devices.filter((d) => d.collector_id === c.id)
                              .length
                          }{" "}
                          台设备
                        </p>
                      </div>
                    </div>
                    <Badge
                      variant={c.online ? "secondary" : "outline"}
                      className={
                        c.online
                          ? "gap-1.5 rounded-full bg-emerald-50 text-emerald-700"
                          : "gap-1.5 rounded-full text-muted-foreground"
                      }
                    >
                      <span
                        className={`size-1.5 rounded-full ${
                          c.online ? "bg-emerald-500" : "bg-muted-foreground/50"
                        }`}
                      />
                      {c.online ? "在线" : "离线"}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/45 px-3 py-2.5">
                    <SignalValue collector={c} compact />
                    <span className="text-xs text-muted-foreground">
                      待上传{" "}
                      <strong className="font-semibold tabular-nums text-foreground">
                        {c.status?.queue_depth ?? c.status?.pending_count ?? 0}
                      </strong>
                    </span>
                  </div>
                  <Disclosure>
                    <summary>采集端设置与维护</summary>
                    <code className="block break-all rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
                      {c.id}
                    </code>
                    <SignalValue collector={c} />
                    <form
                      onSubmit={(e) => {
                        const d = form(e);
                        action(() => api("collectors/" + c.id, "PUT", d));
                      }}
                      className="space-y-4"
                    >
                      <div className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start">
                        <Label className="grid min-w-0 gap-2 text-sm">
                          名称
                          <Input
                            name="name"
                            defaultValue={c.name || ""}
                            required
                          />
                        </Label>
                        <Label className="grid min-w-0 gap-2 text-sm">
                          位置
                          <Input
                            name="location"
                            defaultValue={c.location || ""}
                            placeholder="例如 客厅"
                          />
                        </Label>
                      </div>
                      <Button size="sm" className="rounded-xl" disabled={busy}>
                        保存信息
                      </Button>
                    </form>
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs [&>div]:contents">
                      <dt className="text-muted-foreground">固件</dt>
                      <dd className="min-w-0 break-words font-medium">
                        {c.status?.firmware ||
                          c.status?.firmware_version ||
                          c.status?.version ||
                          "—"}
                      </dd>
                      <dt className="text-muted-foreground">待上传</dt>
                      <dd className="min-w-0 break-words">
                        {c.status?.queue_depth ??
                          c.status?.pending_count ??
                          "—"}
                      </dd>
                      <dt className="text-muted-foreground">体脂秤容量</dt>
                      <dd className="min-w-0 break-words">
                        {c.status?.capabilities?.max_scales
                          ? `${devices.filter((d) => d.collector_id === c.id && d.profile === scaleProfile).length} / ${c.status.capabilities.max_scales} 台`
                          : "请升级固件后接入"}
                      </dd>
                      <dt className="text-muted-foreground">最近在线</dt>
                      <dd className="min-w-0 break-words">
                        {date(c.last_seen)}
                      </dd>
                      <dt className="text-muted-foreground">最近错误</dt>
                      <dd className="min-w-0 break-words">
                        {c.status?.error || c.status?.last_error || "无"}
                      </dd>
                    </dl>
                    <div className="flex flex-wrap items-start gap-2">
                      <Button
                        size="sm"
                        className="rounded-xl"
                        disabled={busy || !c.online}
                        onClick={() => command(c.id, "scan")}
                      >
                        扫描蓝牙设备
                      </Button>
                      {safeDebugURL(c.status) && (
                        <Button
                          size="sm"
                          asChild
                          variant="outline"
                          className="rounded-xl"
                        >
                          <a
                            href={safeDebugURL(c.status)}
                            target="_blank"
                            rel="noreferrer"
                          >
                            本机调试 ↗
                          </a>
                        </Button>
                      )}
                    </div>
                    <CollectorActions
                      collector={c}
                      api={api}
                      action={action}
                      busy={busy}
                    />
                  </Disclosure>
                  {!devices.some((d) => d.collector_id === c.id) && (
                    <p className="text-xs text-muted-foreground">
                      还没有关联的测量设备。
                    </p>
                  )}
                </Card>
              ))}
              {!collectors.length && !resource.loading && (
                <Empty>暂无采集端，联网后可在待添加列表中绑定。</Empty>
              )}
              <Discovered
                rows={discovered}
                api={api}
                action={action}
                busy={busy}
              />
            </section>
          </div>
          <SignalHistory collectors={collectors} devices={devices} />
          <div className="grid min-w-0 items-start gap-4 xl:grid-cols-3">
            <Operations operations={operations} />
            <Disclosure>
              <summary>设备事件与扫描结果 · {events.length}</summary>
              <div className="space-y-3">
                {!events.length ? (
                  <Empty>暂无设备事件</Empty>
                ) : (
                  events.slice(0, 50).map((e) => (
                    <Disclosure key={e.id}>
                      <summary>
                        {date(e.created_at)} · {e.collector_id} ·{" "}
                        {e.type || e.event_type} · {e.status || ""}
                      </summary>
                      {e.error && (
                        <p className="text-sm leading-6 text-destructive">
                          {e.error}
                        </p>
                      )}
                      {Array.isArray(e.data?.devices) &&
                        e.data.devices.map((found: Row) => (
                          <div
                            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-background/60 p-3 text-xs"
                            key={found.address}
                          >
                            <div>
                              <strong className="block text-sm text-foreground">
                                {found.name || "未知设备"}
                              </strong>
                              <span className="font-mono text-muted-foreground">
                                {found.address} · {found.rssi} dBm
                              </span>
                            </div>
                            <Button
                              size="sm"
                              onClick={() => {
                                setScanAddress(found.address || "");
                                setScanProfile(
                                  found.profile || "omron-hem-7374t1",
                                );
                                setScanHardware(found.hardware_id || "");
                                setScanCollector(e.collector_id);
                                setAdding(true);
                                setScanAddressType(
                                  String(found.address_type ?? 0),
                                );
                              }}
                              variant="outline"
                            >
                              选择设备
                            </Button>
                          </div>
                        ))}
                      <pre className="max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted p-3 text-xs">
                        {JSON.stringify(e.data ?? e, null, 2)}
                      </pre>
                    </Disclosure>
                  ))
                )}
              </div>
            </Disclosure>
            <Disclosure>
              <summary>上报拒绝记录 · {rejections.length}</summary>
              <div className="space-y-3">
                {!rejections.length ? (
                  <p className="text-sm leading-6 text-muted-foreground">
                    没有被拒绝的上报记录。
                  </p>
                ) : (
                  rejections.map((r) => (
                    <Disclosure key={r.id}>
                      <summary>
                        {date(r.created_at)} · {r.collector_id} · {r.reason}
                      </summary>
                      <pre className="max-h-96 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted p-3 text-xs">
                        {r.payload}
                      </pre>
                    </Disclosure>
                  ))
                )}
              </div>
            </Disclosure>
          </div>

          <Dialog open={adding} onOpenChange={setAdding}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto rounded-2xl sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>添加测量设备</DialogTitle>
                <DialogDescription>
                  先在设备附近的采集端执行扫描，从事件中核对 BLE
                  地址。每台设备只分配给一个采集端；体脂秤保存后自动分配固定编号（如
                  S001）。
                </DialogDescription>
              </DialogHeader>
              <form
                className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start"
                onSubmit={(e) => {
                  const d = form(e);
                  const f = e.currentTarget;
                  action(async () => {
                    await api("devices", "POST", {
                      ...d,
                      address_type: Number(d.address_type),
                      model:
                        scanProfile === scaleProfile
                          ? "AFU-WL-TZ-A1"
                          : "HEM-7374T1",
                      profile: scanProfile,
                      hardware_id:
                        scanProfile === scaleProfile ? scanHardware : "",
                    });
                    f.reset();
                    setScanAddress("");
                    setScanHardware("");
                    setAdding(false);
                  });
                }}
              >
                <Label className="grid min-w-0 gap-2 text-sm">
                  名称
                  <Input name="name" required placeholder="客厅测量设备" />
                </Label>
                <Label className="grid min-w-0 gap-2 text-sm">
                  采集端
                  <SelectField
                    name="collector_id"
                    required
                    value={scanCollector}
                    onChange={(e) => setScanCollector(e.target.value)}
                  >
                    <option value="">请选择</option>
                    {collectors.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name || c.id}
                      </option>
                    ))}
                  </SelectField>
                </Label>
                <Label className="grid min-w-0 gap-2 text-sm">
                  设备类型
                  <SelectField
                    value={scanProfile}
                    onChange={(e) => {
                      setScanProfile(e.target.value);
                      setScanHardware("");
                    }}
                  >
                    <option value="omron-hem-7374t1">
                      欧姆龙 HEM-7374T1
                    </option>
                    <option value={scaleProfile}>阿福 AFU-WL-TZ-A1</option>
                  </SelectField>
                </Label>
                <Label className="grid min-w-0 gap-2 text-sm">
                  BLE 地址
                  <Input
                    name="address"
                    required
                    value={scanAddress}
                    onChange={(e) => setScanAddress(e.target.value)}
                    pattern="[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}"
                    placeholder="AA:BB:CC:DD:EE:FF"
                  />
                </Label>
                <Label className="grid min-w-0 gap-2 text-sm">
                  地址类型
                  <SelectField
                    name="address_type"
                    value={scanAddressType}
                    onChange={(e) => setScanAddressType(e.target.value)}
                  >
                    <option value="0">Public (0)</option>
                    <option value="1">Random (1)</option>
                  </SelectField>
                </Label>
                {scanProfile === scaleProfile && (
                  <Label className="grid min-w-0 gap-2 text-sm">
                    秤的设备身份
                    <Input
                      required
                      value={scanHardware}
                      onChange={(e) => setScanHardware(e.target.value)}
                      pattern="[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}"
                      placeholder="从扫描结果自动填入"
                    />
                    <small className="block text-xs leading-5 text-muted-foreground">
                      同名秤通过设备身份区分。每块采集端最多 2 台秤。
                    </small>
                  </Label>
                )}
                <Button className="rounded-xl" disabled={busy}>
                  添加测量设备
                </Button>
              </form>
            </DialogContent>
          </Dialog>

          <Dialog open={bindingOpen} onOpenChange={setBindingOpen}>
            <DialogContent className="max-h-[90dvh] overflow-y-auto rounded-2xl sm:max-w-3xl">
              <DialogHeader>
                <DialogTitle>设备成员绑定</DialogTitle>
                <DialogDescription>
                  首次绑定认领未归属历史；换绑按生效时间划分，补采记录仍按测量时间归属。体脂秤绑定整台设备。
                </DialogDescription>
              </DialogHeader>
              <form
                className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start"
                onSubmit={(e) => {
                  const d = form(e);
                  action(() =>
                    api("bindings", "POST", {
                      device_id: d.device_id,
                      user_slot:
                        devices.find((v) => v.id === d.device_id)?.profile ===
                        scaleProfile
                          ? 0
                          : Number(d.user_slot),
                      member_id: d.member_id,
                      claim_history: d.claim_history === "on",
                      ...(d.effective_from
                        ? {
                            effective_from: new Date(
                              d.effective_from + ":00+08:00",
                            ).toISOString(),
                          }
                        : {}),
                    }),
                  );
                }}
              >
                <Label className="grid min-w-0 gap-2 text-sm">
                  设备
                  <SelectField
                    name="device_id"
                    required
                    value={bindingDevice}
                    onChange={(e) => setBindingDevice(e.target.value)}
                  >
                    <option value="">请选择</option>
                    {devices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {deviceLabel(d)}
                      </option>
                    ))}
                  </SelectField>
                </Label>
                {devices.find((d) => d.id === bindingDevice)?.profile !==
                  scaleProfile && (
                  <Label className="grid min-w-0 gap-2 text-sm">
                    用户档位
                    <SelectField
                      name="user_slot"
                      value={slot}
                      onChange={(e) => setSlot(e.target.value)}
                    >
                      <option value="1">用户 1</option>
                      <option value="2">用户 2</option>
                    </SelectField>
                  </Label>
                )}
                <Label className="grid min-w-0 gap-2 text-sm">
                  家庭成员
                  <SelectField name="member_id" required>
                    <option value="">请选择</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </SelectField>
                </Label>
                <Label className="grid min-w-0 gap-2 text-sm">
                  生效时间（上海时间）
                  <DateField type="datetime-local" name="effective_from" />
                  <small className="block text-xs leading-5 text-muted-foreground">
                    留空：首次认领历史，换绑从现在生效
                  </small>
                </Label>
                <Label className="flex flex-row items-center gap-2 text-sm sm:col-span-2">
                  <CheckboxField
                    type="checkbox"
                    name="claim_history"
                    defaultChecked
                  />
                  首次绑定认领历史{" "}
                  {preview !== null && `（${preview} 条待归属）`}
                </Label>
                <Button className="rounded-xl" disabled={busy}>
                  保存绑定
                </Button>
              </form>
              <div className="min-w-0 max-w-full overflow-x-auto rounded-xl border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/35 hover:bg-muted/35">
                      <TableHead>设备</TableHead>
                      <TableHead>用户</TableHead>
                      <TableHead>成员</TableHead>
                      <TableHead>生效时间</TableHead>
                      <TableHead>结束时间</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bindings.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="align-top">
                          {devices.find((d) => d.id === b.device_id)
                            ? deviceLabel(
                                devices.find((d) => d.id === b.device_id)!,
                              )
                            : b.device_id}
                        </TableCell>
                        <TableCell className="align-top">
                          {b.user_slot === 0 ? "整台体脂秤" : b.user_slot}
                        </TableCell>
                        <TableCell className="align-top font-medium">
                          {members.find((m) => m.id === b.member_id)?.name ||
                            b.member_id}
                        </TableCell>
                        <TableCell className="align-top text-xs">
                          {!isHistoryStart(b.effective_from)
                            ? date(b.effective_from)
                            : "全部历史"}
                        </TableCell>
                        <TableCell className="align-top text-xs">
                          {b.effective_to ? date(b.effective_to) : "当前绑定"}
                        </TableCell>
                        <TableCell className="align-top">
                          {!b.effective_to && (
                            <ConfirmAction
                              action={action}
                              busy={busy}
                              label="解绑成员"
                              message="成员绑定已结束，历史归属保留"
                              description="结束当前用户档位的成员绑定。已有记录归属保留，后续测量进入待归属列表。"
                              run={() =>
                                api(
                                  `bindings/${encodeURIComponent(b.id)}/unbind`,
                                  "POST",
                                  {},
                                )
                              }
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </DialogContent>
          </Dialog>
        </SignalProvider>
      )}

      {tab === "firmware" && (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card className="health-card gap-4 p-5">
              <div className="space-y-1">
                <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
                  上传固件
                </h2>
                <p className="text-xs leading-5 text-muted-foreground">
                  选择为 ESP32-C3 构建的应用固件
                  .bin。服务端校验芯片和分区兼容性后才可升级。
                </p>
              </div>
              <form
                className="grid min-w-0 items-end gap-4 [&>button]:justify-self-start"
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = e.currentTarget;
                  const body = new FormData(f);
                  action(async () => {
                    await api("firmwares", "POST", body);
                    f.reset();
                  }, "固件已上传并校验");
                }}
              >
                <Label className="grid min-w-0 gap-2 text-sm">
                  版本
                  <Input name="version" required placeholder="例如 0.1.0" />
                </Label>
                <Label className="grid min-w-0 gap-2 text-sm">
                  固件文件
                  <Input name="file" type="file" accept=".bin" required />
                </Label>
                <Button className="rounded-xl" disabled={busy}>
                  上传固件
                </Button>
              </form>
            </Card>
            <Card className="health-card gap-4 p-5">
              <div className="space-y-1">
                <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
                  远程升级
                </h2>
                <p className="text-xs leading-5 text-muted-foreground">
                  选择在线采集端与目标固件版本下发 OTA 升级任务。
                </p>
              </div>
              <form
                className="grid min-w-0 items-end gap-4 [&>button]:justify-self-start"
                onSubmit={(e) => {
                  const d = form(e);
                  action(
                    () => api("ota-jobs", "POST", d),
                    "升级任务已创建，状态将在下方更新",
                  );
                }}
              >
                <Label className="grid min-w-0 gap-2 text-sm">
                  在线采集端
                  <SelectField name="collector_id" required>
                    <option value="">请选择</option>
                    {collectors
                      .filter((c) => c.online)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name || c.id}
                        </option>
                      ))}
                  </SelectField>
                </Label>
                <Label className="grid min-w-0 gap-2 text-sm">
                  固件版本
                  <SelectField name="firmware_id" required>
                    <option value="">请选择</option>
                    {firmwares.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.version} · {Math.round(f.size / 1024)} KB
                      </option>
                    ))}
                  </SelectField>
                </Label>
                <Button className="rounded-xl" disabled={busy}>
                  开始升级
                </Button>
              </form>
            </Card>
          </div>
          <Card className="health-card gap-4 p-5">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              升级任务
            </h2>
            {!jobs.length ? (
              <Empty>暂无升级任务</Empty>
            ) : (
              <div className="min-w-0 max-w-full overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/35 hover:bg-muted/35">
                      <TableHead>采集端</TableHead>
                      <TableHead>版本</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>创建时间</TableHead>
                      <TableHead>错误</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobs.map((j) => (
                      <TableRow key={j.id}>
                        <TableCell className="align-top font-medium">
                          {collectors.find((c) => c.id === j.collector_id)
                            ?.name || j.collector_id}
                        </TableCell>
                        <TableCell className="align-top font-mono text-xs">
                          {j.version}
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge
                            variant="secondary"
                            className="rounded-full text-xs font-normal"
                          >
                            {(
                              {
                                queued: "等待执行",
                                pending: "等待执行",
                                started: "正在执行",
                                running: "正在执行",
                                succeeded: "升级成功",
                                expired: "指令过期",
                                downloading: "下载中",
                                rebooting: "重启中",
                                success: "升级成功",
                                failed: "失败",
                                rolled_back: "已回滚",
                                completed: "完成",
                              } as Record<string, string>
                            )[j.status] || j.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {date(j.created_at)}
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          {j.error || "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
          <Card className="health-card gap-4 p-5">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              固件库
            </h2>
            {!firmwares.length ? (
              <Empty>上传首个固件以开始</Empty>
            ) : (
              <div className="space-y-3">
                {firmwares.map((f) => (
                  <Disclosure key={f.id}>
                    <summary>
                      {f.version} · {f.chip} · {Math.round(f.size / 1024)} KB
                    </summary>
                    <p className="text-sm leading-6 text-muted-foreground">
                      分区：{f.partition_layout}
                    </p>
                    <code className="block break-all rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
                      SHA-256: {f.sha256}
                    </code>
                  </Disclosure>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
