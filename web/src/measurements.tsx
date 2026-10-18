import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  Activity,
  ArrowDownToLine,
  HeartPulse,
  Scale,
  Droplets,
  RotateCcw,
} from "lucide-react";
import { api, date, number } from "./api";
import type { Row } from "./api";
import { useResource } from "./realtime";
import { useQueryState } from "./routing";
import { measurementCorrection, measurementQuery } from "./domain";
import {
  bodyFatStatus,
  bodyFatValue,
  scaleProfile,
  deviceLabel,
} from "./bodyDomain";
import {
  applyZoom,
  loadSeries,
  metricSeries,
  referenceFor,
  zoomRange,
} from "./chartDomain";
import type { Metric, TimeRange } from "./chartDomain";
import { TimeSeriesChart } from "./components/TimeSeriesChart";
import { SelectField, CheckboxField, Empty } from "./components/forms";
import { Button } from "./components/ui/button";
import { DateRangePicker } from "./components/DatePicker";
import { Textarea } from "./components/ui/textarea";
import { Label } from "./components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "./components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Skeleton } from "./components/ui/skeleton";
import { Badge } from "./components/ui/badge";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
} from "./components/ui/pagination";

type Props = {
  mode: "overview" | "data" | "body";
  members: Row[];
  devices: Row[];
  revision: number;
  busy: boolean;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
};
const titles: Record<Metric, string> = {
  weight: "体重",
  body_fat: "估算体脂率",
  blood_pressure: "血压",
  pulse: "脉搏",
};
const units: Record<Metric, string> = {
  weight: "kg",
  body_fat: "%",
  blood_pressure: "mmHg",
  pulse: "次/分",
};
const icons = {
  weight: Scale,
  body_fat: Droplets,
  blood_pressure: HeartPulse,
  pulse: Activity,
};
const allMetrics: Metric[] = ["weight", "body_fat", "blood_pressure", "pulse"];
function LatestCards({ items, metrics }: { items: Row[]; metrics: Metric[] }) {
  return (
    <div
      className={`grid grid-cols-2 gap-3 ${metrics.length === 4 ? "xl:grid-cols-4" : ""}`}
    >
      {metrics.map((metric) => {
        const row = items.find((item) => item.metric === metric),
          Icon = icons[metric];
        return (
          <Card key={metric} className="gap-3 py-4 shadow-none">
            <CardHeader className="flex flex-row items-center justify-between gap-2 px-4">
              <CardDescription className="text-xs font-medium">
                {titles[metric]}
              </CardDescription>
              <Icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="space-y-2 px-4">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-2xl font-semibold tracking-tight tabular-nums sm:text-3xl">
                  {row
                    ? metric === "blood_pressure"
                      ? `${number(row.value, 0)}/${number(row.value_secondary, 0)}`
                      : number(row.value, metric === "weight" ? 2 : 1)
                    : "—"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {units[metric]}
                </span>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {row ? date(row.measured_at) : "暂无有效测量"}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
function MetricPlot({
  metric,
  rows,
  member,
  range,
  domain,
  onRangeChange,
}: {
  metric: Metric;
  rows: Row[];
  member: Row;
  range?: TimeRange;
  domain?: TimeRange;
  onRangeChange: (range: TimeRange) => void;
}) {
  const series = useMemo(() => metricSeries(rows, metric), [rows, metric]);
  const reference = useMemo(
    () => referenceFor(metric, member),
    [metric, member],
  );
  return (
    <Card className="min-w-0 gap-2 py-5 shadow-none">
      <CardHeader className="px-5">
        <CardTitle className="text-sm font-medium">
          {titles[metric]}趋势
        </CardTitle>
        <CardDescription className="text-xs">
          {member.name} · {units[metric]} · 原始测量
        </CardDescription>
      </CardHeader>
      <CardContent className="min-w-0 px-2 sm:px-4">
        {series.some((s) => s.data.some((p) => p[1] !== null)) ? (
          <TimeSeriesChart
            series={series}
            unit={units[metric]}
            label={`${member.name}的${titles[metric]}趋势`}
            memberName={member.name}
            reference={reference}
            range={range}
            domain={domain}
            onRangeChange={onRangeChange}
          />
        ) : (
          <div className="p-3">
            <Empty>当前时间范围暂无有效{titles[metric]}数据</Empty>
          </div>
        )}
      </CardContent>
      <div className="px-5 text-xs leading-5 text-muted-foreground">
        {reference ? (
          <>
            <a
              href={reference.url}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-dotted underline-offset-4"
            >
              {reference.label}
              {reference.band &&
                ` · ${number(reference.band[0])}–${number(reference.band[1])} ${units[metric]}`}
            </a>
            <span className="mt-1 block">
              依据成员当前资料 · {reference.source}
            </span>
          </>
        ) : (
          "成员资料不足或不在成人参考适用范围，暂不显示参考带。"
        )}
        {metric === "body_fat" && (
          <span className="mt-1 block">
            体脂由设备读数及个人资料估算，缺测保持断点。
          </span>
        )}
      </div>
    </Card>
  );
}
export function MeasurementsPage({
  mode,
  members,
  devices,
  revision,
  busy,
  action,
}: Props) {
  const overview = mode === "overview",
    body = mode === "body",
    kind = body ? "body_composition" : "blood_pressure";
  const resets = ["page", "zoom_from", "zoom_to"];
  const [member, setMember] = useQueryState("member_id", "", resets),
    [device, setDevice] = useQueryState("device_id", "", resets);
  const [period, setPeriod] = useQueryState(
      "period",
      overview ? "30" : "all",
      resets,
    ),
    [from, setFrom] = useQueryState("from", "", resets),
    [to, setTo] = useQueryState("to", "", resets);
  const [unassigned, setUnassigned] = useQueryState(
      "unassigned",
      false,
      resets,
    ),
    [page, setPage] = useQueryState("page", 1);
  const [zoomFrom, setZoomFrom] = useQueryState("zoom_from", "", ["page"]),
    [zoomTo, setZoomTo] = useQueryState("zoom_to", "", ["page"]);
  const range = zoomRange(zoomFrom, zoomTo);
  const [editing, setEditing] = useState<Row | null>(null);
  // The rolling boundary is stable while paging/zooming, and advances on data refresh.
  const now = useMemo(() => Date.now(), [period, revision]);
  const scope = {
    member,
    device: overview ? "" : device,
    unassigned: overview ? false : unassigned,
    period,
    from,
    to,
    group: "day",
    page: 1,
  };
  const query = measurementQuery({ ...scope, kind }, now);
  const seriesQuery = new URLSearchParams(query);
  seriesQuery.delete("page");
  seriesQuery.delete("page_size");
  const latestQuery = new URLSearchParams();
  if (member) latestQuery.set("member_id", member);
  if (!overview) latestQuery.set("kind", kind);
  if (!overview && device) latestQuery.set("device_id", device);
  if (!overview && unassigned) latestQuery.set("unassigned", "true");
  const latest = useResource<Row[]>(
    "latest:" + latestQuery,
    async (signal) =>
      (
        await api(
          "measurements/latest?" + latestQuery,
          "GET",
          undefined,
          signal,
        )
      ).items,
    [],
    revision,
  );
  const curves = useResource<Row[]>(
    "series:" + mode + ":" + seriesQuery,
    async (signal) => {
      const read = (path: string) => api(path, "GET", undefined, signal);
      const first = await loadSeries(seriesQuery.toString(), read);
      if (!overview) return first;
      const second = new URLSearchParams(seriesQuery);
      second.set("kind", "body_composition");
      return first.concat(await loadSeries(second.toString(), read));
    },
    [],
    revision,
  );
  const tableQuery = new URLSearchParams(applyZoom(query, range));
  tableQuery.set("page", String(page));
  const table = useResource<{ items: Row[]; total: number }>(
    overview ? null : "table:" + tableQuery,
    (signal) => api("measurements?" + tableQuery, "GET", undefined, signal),
    { items: [], total: 0 },
    revision,
  );
  const filteredMembers = member
    ? members.filter((m) => m.id === member)
    : members;
  const groups =
    !overview && unassigned
      ? [{ id: null, name: "待归属测量" }]
      : filteredMembers;
  const pending =
    !overview &&
    !unassigned &&
    !member &&
    (curves.data.some((row) => row.member_id == null) ||
      latest.data.some((row) => row.member_id == null));
  const displayGroups = pending
    ? [...groups, { id: null, name: "待归属测量" }]
    : groups;
  const metrics: Metric[] = overview
    ? allMetrics
    : body
      ? ["weight", "body_fat"]
      : ["blood_pressure", "pulse"];
  const times = curves.data.map((row) => Date.parse(row.measured_at));
  const min = times.reduce((a, b) => Math.min(a, b), Infinity),
    max = times.reduce((a, b) => Math.max(a, b), -Infinity);
  const domain = Number.isFinite(min)
    ? { from: min, to: max > min ? max : min + 60000 }
    : undefined;
  const changeRange = (value: TimeRange) => {
    setZoomFrom(new Date(value.from).toISOString());
    setZoomTo(new Date(value.to).toISOString());
  };
  const error = latest.error || curves.error || table.error;
  return (
    <div className="space-y-6">
      {overview && (
        <Tabs
          value={member || "all"}
          onValueChange={(value) => {
            setMember(value === "all" ? "" : value);
            setUnassigned(false);
          }}
        >
          <div className="max-w-full overflow-x-auto pb-1">
            <TabsList className="h-10 w-max">
              <TabsTrigger value="all" className="px-5">
                全员
              </TabsTrigger>
              {members.map((m) => (
                <TabsTrigger key={m.id} value={m.id} className="px-5">
                  {m.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {!overview && (
          <>
            <Label className="grid w-full gap-2 text-xs sm:w-44">
              家庭成员
              <SelectField
                value={member}
                onChange={(e) => {
                  setMember(e.target.value);
                  setUnassigned(false);
                }}
              >
                <option value="">全部成员</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </SelectField>
            </Label>
            <Label className="grid w-full gap-2 text-xs sm:w-48">
              {body ? "体脂秤" : "血压计"}
              <SelectField
                value={device}
                onChange={(e) => setDevice(e.target.value)}
              >
                <option value="">{body ? "全部体脂秤" : "全部血压计"}</option>
                {devices
                  .filter((d) =>
                    body
                      ? d.profile === scaleProfile
                      : d.profile !== scaleProfile,
                  )
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {deviceLabel(d)}
                    </option>
                  ))}
              </SelectField>
            </Label>
          </>
        )}
        <Label className="grid w-full gap-2 text-xs sm:w-auto">
          时间范围
          <DateRangePicker
            period={period}
            from={from}
            to={to}
            onChange={(value) => {
              setPeriod(value.period);
              setFrom(value.from);
              setTo(value.to);
            }}
          />
        </Label>
        {!overview && (
          <Label className="flex h-9 items-center gap-2">
            <CheckboxField
              type="checkbox"
              checked={unassigned}
              onChange={(e) => {
                setUnassigned(e.target.checked);
                if (e.target.checked) {
                  setMember("");
                  setPeriod("all");
                }
              }}
            />
            待归属
          </Label>
        )}
        {range && (
          <Button
            variant="outline"
            onClick={() => {
              setZoomFrom("");
              setZoomTo("");
            }}
          >
            <RotateCcw className="size-3.5" />
            恢复完整范围
          </Button>
        )}
        <span
          className="pb-2 text-xs text-muted-foreground sm:ml-auto"
          aria-live="polite"
        >
          {curves.loading
            ? "正在加载完整历史…"
            : overview
              ? "新测量自动同步"
              : `${curves.data.length} 个测量点`}
        </span>
      </div>
      {range && (
        <p className="text-xs text-muted-foreground">
          当前视野：{date(range.from)} — {date(range.to)}
          {!overview && " · 测量记录及导出已联动"}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>
            数据暂时无法更新，保留上次成功读取的结果。{error}
          </AlertDescription>
        </Alert>
      )}
      {member && !filteredMembers.length ? (
        <Empty>
          成员未找到。
          <Button variant="link" onClick={() => setMember("")}>
            返回全员
          </Button>
        </Empty>
      ) : !members.length && !unassigned ? (
        <Empty>
          还没有家庭成员。
          <Button variant="link" asChild>
            <Link to="/members">添加家人</Link>
          </Button>
        </Empty>
      ) : (
        displayGroups.map((m) => (
          <section key={m.id || "unassigned"} className="space-y-4">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold tracking-tight">{m.name}</h2>
              <Badge
                variant="outline"
                className="font-normal text-muted-foreground"
              >
                最新设备测量
              </Badge>
            </div>
            {latest.loading && !latest.data.length ? (
              <div className="grid grid-cols-2 gap-3">
                <Skeleton className="h-32" />
                <Skeleton className="h-32" />
              </div>
            ) : (
              <LatestCards
                items={latest.data.filter((row) => row.member_id === m.id)}
                metrics={metrics}
              />
            )}
            <div className="grid min-w-0 gap-4 xl:grid-cols-2">
              {metrics.map((metric) =>
                curves.loading && !curves.data.length ? (
                  <Skeleton key={metric} className="h-96" />
                ) : (
                  <MetricPlot
                    key={metric}
                    metric={metric}
                    rows={curves.data.filter((row) => row.member_id === m.id)}
                    member={m}
                    range={range}
                    domain={domain}
                    onRangeChange={changeRange}
                  />
                ),
              )}
            </div>
          </section>
        ))
      )}
      {!overview && (
        <Card className="gap-4 py-5 shadow-none">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 px-5">
            <div className="space-y-1">
              <CardTitle className="text-base">
                {body ? "称重记录" : "测量记录"}
              </CardTitle>
              <CardDescription>
                {table.data.total} 条 · 保留原始测量
                {table.loading && " · 更新中…"}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a href={"/api/v1/measurements/export.csv?" + tableQuery}>
                <ArrowDownToLine className="size-4" />
                导出 CSV
              </a>
            </Button>
          </CardHeader>
          <CardContent className="px-0">
            {!table.data.items.length ? (
              <div className="px-5">
                <Empty>
                  {table.loading ? "正在读取测量记录…" : "暂无符合条件的记录"}
                </Empty>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">测量时间</TableHead>
                    <TableHead>成员 / {body ? "体脂秤" : "血压计"}</TableHead>
                    {body ? (
                      <>
                        <TableHead>体重</TableHead>
                        <TableHead>估算体脂率</TableHead>
                      </>
                    ) : (
                      <>
                        <TableHead>血压</TableHead>
                        <TableHead>脉搏</TableHead>
                      </>
                    )}
                    <TableHead>备注</TableHead>
                    <TableHead className="pr-5 text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.data.items.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="pl-5">
                        <span className="block">{date(row.measured_at)}</span>
                        <small className="block text-xs text-muted-foreground">
                          收到于 {date(row.received_at)}
                        </small>
                      </TableCell>
                      <TableCell>
                        {row.member_name || "待归属"}
                        <small className="block text-xs text-muted-foreground">
                          {devices.find((d) => d.id === row.device_id)
                            ? deviceLabel(
                                devices.find((d) => d.id === row.device_id)!,
                              )
                            : row.device_name}
                        </small>
                      </TableCell>
                      {body ? (
                        <>
                          <TableCell className="font-medium tabular-nums">
                            {number(row.weight_kg, 2)} kg
                            {row.weight_valid === false && (
                              <small className="block text-xs text-muted-foreground">
                                未锁定 · 不计入趋势
                              </small>
                            )}
                          </TableCell>
                          <TableCell>
                            {bodyFatValue(row) === null
                              ? "—"
                              : `${number(row.body_fat_pct)} %`}
                            <small className="block text-xs text-muted-foreground">
                              {bodyFatStatus(row.body_fat_status)}
                            </small>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell className="font-medium tabular-nums">
                            {row.systolic}/{row.diastolic}{" "}
                            <small className="text-muted-foreground">
                              mmHg
                            </small>
                          </TableCell>
                          <TableCell>
                            {row.pulse}{" "}
                            <small className="text-muted-foreground">
                              次/分
                            </small>
                          </TableCell>
                        </>
                      )}
                      <TableCell className="max-w-48 truncate">
                        {row.notes || "—"}
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(row)}
                        >
                          详情 / 编辑
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
          <Pagination className="justify-end px-5">
            <PaginationContent>
              <PaginationItem>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </Button>
              </PaginationItem>
              <PaginationItem className="px-3 text-xs text-muted-foreground">
                第 {page} / {Math.max(1, Math.ceil(table.data.total / 50))} 页
              </PaginationItem>
              <PaginationItem>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page * 50 >= table.data.total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </Button>
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </Card>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>测量详情与归属</DialogTitle>
            <DialogDescription>
              {editing && devices.find((d) => d.id === editing.device_id)
                ? deviceLabel(devices.find((d) => d.id === editing!.device_id)!)
                : editing?.device_name}{" "}
              · {date(editing?.measured_at)}
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <>
              <p className="text-lg font-semibold tabular-nums">
                {body
                  ? `${number(editing.weight_kg, 2)} kg · ${bodyFatValue(editing) === null ? "体脂缺测" : `估算体脂 ${number(editing.body_fat_pct)} %`}`
                  : `${editing.systolic}/${editing.diastolic} mmHg · ${editing.pulse} 次/分`}
              </p>
              {body && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                  <dt className="text-muted-foreground">原始 ADC</dt>
                  <dd>{editing.raw_adcs?.join(" / ") || "未取得"}</dd>
                  <dt className="text-muted-foreground">估算算法</dt>
                  <dd>{editing.algorithm_version || "未计算"}</dd>
                  <dt className="text-muted-foreground">资料快照</dt>
                  <dd>
                    {editing.profile_snapshot?.height_cm || "—"} cm ·{" "}
                    {editing.profile_snapshot?.age_approximate ? "约 " : ""}
                    {editing.profile_snapshot?.age ?? "—"} 岁 · ADC{" "}
                    {Number(editing.adc_index) + 1}
                  </dd>
                </dl>
              )}
              <form
                key={editing.id}
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = Object.fromEntries(
                    new FormData(event.currentTarget),
                  );
                  void action(async () => {
                    await api(
                      "measurements/" + editing.id,
                      "PATCH",
                      measurementCorrection(
                        editing.member_id,
                        String(values.member_id),
                        String(values.notes),
                      ),
                    );
                    setEditing(null);
                  }, "测量归属与备注已保存");
                }}
              >
                <Label className="grid gap-2">
                  所属成员
                  <SelectField
                    name="member_id"
                    defaultValue={editing.member_id || ""}
                  >
                    <option value="">待归属</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </SelectField>
                </Label>
                <Label className="grid gap-2">
                  备注
                  <Textarea
                    name="notes"
                    defaultValue={editing.notes || ""}
                    rows={3}
                    maxLength={4000}
                  />
                </Label>
                <p className="text-xs text-muted-foreground">
                  原始测量值保持留存。调整称重归属会按所选成员资料重新计算体脂。
                </p>
                <Button disabled={busy} type="submit">
                  保存更正
                </Button>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
