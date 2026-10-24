import { isOffline } from "./api";
import { DateField, DateRangePicker } from "./components/DatePicker";
import { ConfirmAction } from "./lifecycle";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Textarea } from "./components/ui/textarea";
import { Label } from "./components/ui/label";
import { Card } from "./components/ui/card";
import { Badge } from "./components/ui/badge";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "./components/ui/table";
import { SelectField } from "./components/forms";
import { Link, useLocation } from "react-router";
import { useQueryState, useRouteNavigation } from "./routing";
import { routeForPath } from "./routingDomain";
import { useEffect, useMemo, useState } from "react";
import { TimeSeriesChart } from "./components/TimeSeriesChart";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs";
import { ProfileFields } from "./body";
import { memberProfile } from "./bodyDomain";
import {
  metricNames,
  historyNames,
  documentNames,
  healthQuery,
  memberAge,
} from "./healthDomain";
type Row = Record<string, any>;
type Props = {
  members: Row[];
  refresh: number;
  api: (
    path: string,
    method?: string,
    body?: unknown,
    signal?: AbortSignal,
  ) => Promise<any>;
  action: (fn: () => Promise<unknown>, message?: string) => Promise<void>;
  busy: boolean;
};
const date = (value: any) =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "时间未知";
const fields = (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<
    string,
    string
  >;
};
function Pages({
  page,
  total,
  setPage,
}: {
  page: number;
  total: number;
  setPage: (n: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-3 py-2 text-xs text-muted-foreground">
      <Button
        disabled={page === 1}
        onClick={() => setPage(page - 1)}
        variant="outline"
      >
        上一页
      </Button>
      <span>
        第 {page} 页 · 共 {total} 条
      </span>
      <Button
        disabled={page * 50 >= total}
        onClick={() => setPage(page + 1)}
        variant="outline"
      >
        下一页
      </Button>
    </div>
  );
}
function BasicForm({
  member,
  onSave,
  busy,
}: {
  member?: Row;
  onSave: (v: Row) => void;
  busy: boolean;
}) {
  return (
    <form
      className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start"
      onSubmit={(e) => onSave(memberProfile(fields(e)))}
    >
      <Label className="grid min-w-0 gap-2 text-sm">
        姓名
        <Input
          name="name"
          required
          maxLength={100}
          defaultValue={member?.name || ""}
        />
      </Label>
      <ProfileFields key={member?.id || "new"} member={member} />
      <Label className="grid min-w-0 gap-2 text-sm">
        血型
        <SelectField name="blood_type" defaultValue={member?.blood_type || ""}>
          <option value="">暂不填写</option>
          {["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </SelectField>
      </Label>
      <Label className="grid min-w-0 gap-2 text-sm sm:col-span-2">
        备注
        <Textarea
          name="notes"
          rows={3}
          maxLength={4000}
          defaultValue={member?.notes || ""}
        />
      </Label>
      <Button disabled={busy}>保存成员资料</Button>
    </form>
  );
}
function MetricChart({ rows }: { rows: Row[] }) {
  const times = [...new Set(rows.map((r) => r.time))].sort();
  const groups = [
    ...new Set(
      rows.map((r) => `${r.kind}|${r.estimated}|${r.age_approximate}`),
    ),
  ];
  const series = groups.flatMap((key) => {
    const values = rows.filter(
        (r) => `${r.kind}|${r.estimated}|${r.age_approximate}` === key,
      ),
      first = values[0];
    const name =
      (metricNames[first.kind] || first.kind) +
      (first.estimated ? "（估算）" : "") +
      (first.age_approximate ? " · 年龄近似" : "");
    const result = [
      {
        id: key,
        name,
        data: times.map(
          (t) =>
            [Date.parse(t), values.find((v) => v.time === t)?.mean ?? null] as [
              number,
              number | null,
            ],
        ),
      },
    ];
    if (first.kind === "blood_pressure")
      result.push({
        id: key + ":diastolic",
        name: "舒张压",
        data: times.map(
          (t) =>
            [
              Date.parse(t),
              values.find((v) => v.time === t)?.mean_secondary ?? null,
            ] as [number, number | null],
        ),
      });
    return result;
  });
  return (
    <TimeSeriesChart
      series={series}
      unit={rows[0]?.unit || ""}
      label="身体指标历史趋势"
    />
  );
}
export function HealthProfiles({ members, refresh, api, action, busy }: Props) {
  const [historyFormKey, setHistoryFormKey] = useState(0),
    [metricFormKey, setMetricFormKey] = useState(0);
  const [historyOptions, setHistoryOptions] = useState<Row[]>([]),
    [historySearch, setHistorySearch] = useState(""),
    [linkedHistory, setLinkedHistory] = useState("");
  const { memberId: selected, section } = routeForPath(useLocation().pathname);
  const navigation = useRouteNavigation();
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState<Row[]>([]),
    [documents, setDocuments] = useState<Row[]>([]),
    [rows, setRows] = useState<Row[]>([]),
    [stats, setStats] = useState<Row[]>([]),
    [metrics, setMetrics] = useState<Row[]>([]);
  const [statsPage, setStatsPage] = useQueryState("stats_page", 1),
    [statsTotal, setStatsTotal] = useState(0);
  const [historyTotal, setHistoryTotal] = useState(0),
    [documentTotal, setDocumentTotal] = useState(0),
    [total, setTotal] = useState(0),
    [page, setPage] = useQueryState("page", 1),
    [historyPage, setHistoryPage] = useQueryState("history_page", 1),
    [documentPage, setDocumentPage] = useQueryState("document_page", 1);
  const [kind, setKind] = useQueryState("kind", "weight", [
      "page",
      "stats_page",
      "history_page",
    ]),
    [historyKind, setHistoryKind] = useQueryState("history_kind", "", [
      "page",
      "stats_page",
      "history_page",
    ]),
    [source, setSource] = useQueryState("source", "", [
      "page",
      "stats_page",
      "history_page",
    ]),
    [from, setFrom] = useQueryState("from", "", [
      "page",
      "stats_page",
      "history_page",
    ]),
    [to, setTo] = useQueryState("to", "", [
      "page",
      "stats_page",
      "history_page",
    ]),
    [group, setGroup] = useQueryState("group", "day", [
      "page",
      "stats_page",
      "history_page",
    ]);
  const [editHistory, setEditHistory] = useState<Row | null>(null),
    [editMetric, setEditMetric] = useState<Row | null>(null),
    [editDocument, setEditDocument] = useState<Row | null>(null),
    [preview, setPreview] = useState<Row | null>(null),
    [previewPage, setPreviewPage] = useState(1),
    [text, setText] = useState("");
  const [newMetric, setNewMetric] = useState("weight"),
    [newHistory, setNewHistory] = useState("condition"),
    [error, setError] = useState("");
  const member = members.find((m) => m.id === selected);
  const [period, setPeriod] = useQueryState(
    "period",
    from || to ? "custom" : "all",
    ["page", "stats_page"],
  );
  const queryNow = useMemo(() => Date.now(), [period, refresh]);
  const query = healthQuery(
    selected,
    kind,
    page,
    from,
    to,
    group,
    source,
    period,
    queryNow,
  );
  useEffect(() => {
    const controller = new AbortController();
    api("health/metrics", "GET", undefined, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setMetrics(rows);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [api]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const controller = new AbortController();
    api(
      `health/history?member_id=${selected}&page_size=200&search=${encodeURIComponent(historySearch)}`,
      "GET",
      undefined,
      controller.signal,
    )
      .then((v) => active && setHistoryOptions(v.items))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      controller.abort();
    };
  }, [selected, refresh, historySearch, api]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const controller = new AbortController();
    Promise.all([
      api(
        `health/history?member_id=${selected}&page=${historyPage}&page_size=50${historyKind ? `&kind=${historyKind}` : ""}`,
        "GET",
        undefined,
        controller.signal,
      ),
      api(
        `health/documents?member_id=${selected}&page=${documentPage}&page_size=50`,
        "GET",
        undefined,
        controller.signal,
      ),
      api("health/observations?" + query, "GET", undefined, controller.signal),
      api(
        "health/statistics?" +
          healthQuery(
            selected,
            kind,
            statsPage,
            from,
            to,
            group,
            source,
            period,
            queryNow,
          ).replace("page_size=50", "page_size=200"),
        "GET",
        undefined,
        controller.signal,
      ),
    ])
      .then(([h, d, o, s]) => {
        if (active) {
          setHistory(h.items);
          setHistoryTotal(h.total);
          setDocuments(d.items);
          setDocumentTotal(d.total);
          setRows(o.items);
          setTotal(o.total);
          setStats(s.items);
          setStatsTotal(s.total);
          setError("");
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    selected,
    refresh,
    api,
    query,
    historyPage,
    documentPage,
    historyKind,
    statsPage,
  ]);
  const open = (id: string) => {
    navigation.go(`/members/${id}/basic`);
    setPreview(null);
    setEditHistory(null);
    setEditMetric(null);
    setEditDocument(null);
    setCreating(false);
  };
  if (selected && !member)
    return (
      <Card className="gap-4 p-5 shadow-none">
        <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
          成员未找到
        </h2>
        <Link to="/members">返回成员列表</Link>
      </Card>
    );
  if (!member)
    return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
            家人的健康档案
          </h2>
          <Button onClick={() => setCreating(!creating)}>
            {creating ? "收起" : "添加成员"}
          </Button>
        </div>
        {creating && (
          <Card className="gap-4 p-5 shadow-none">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              添加家庭成员
            </h2>
            <BasicForm
              busy={busy}
              onSave={(values) =>
                action(async () => {
                  const m = await api("members", "POST", values);
                  open(m.id);
                }, "成员已添加")
              }
            />
          </Card>
        )}
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          {members.map((m) => (
            <Card className="gap-4 p-5 shadow-none" key={m.id}>
              <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
                {m.name}
              </h2>
              <p className="text-sm leading-6 text-muted-foreground">
                {memberAge(m)} · {m.blood_type || "血型未填写"}
              </p>
              <p className="text-sm leading-6 text-muted-foreground">
                {m.height_cm ? `${m.height_cm} cm` : "身高未填写"}
              </p>
              <Button asChild variant="outline">
                <Link to={`/members/${m.id}/basic`}>查看健康档案</Link>
              </Button>
            </Card>
          ))}
        </div>
        {!members.length && (
          <p className="text-sm leading-6 text-muted-foreground">
            先添加家人，再补充健康资料与测量记录。
          </p>
        )}
      </>
    );
  const metric = metrics.find(
    (m) => m.kind === (editMetric?.kind || newMetric),
  );
  const saveDoc = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    action(async () => {
      if (editDocument) {
        await api(
          `members/${selected}/documents/${editDocument.id}`,
          "PUT",
          Object.fromEntries(data),
        );
        setEditDocument(null);
      } else {
        await api(`members/${selected}/documents`, "POST", data);
        form.reset();
      }
    }, "医疗文件已保存");
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
            {member.name}的健康档案
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            {memberAge(member)}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/members">返回成员列表</Link>
        </Button>
      </div>
      <Tabs
        value={section}
        onValueChange={(value) =>
          navigation.go(`/members/${selected}/${value}`)
        }
      >
        <div className="max-w-full overflow-x-auto">
          <TabsList className="w-max">
            {[
              ["basic", "基本资料"],
              ["history", "健康经历"],
              ["metrics", "身体指标"],
              ["documents", "医疗文件"],
            ].map(([id, label]) => (
              <TabsTrigger key={id} value={id}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
      {error && (
        <p className="text-sm leading-6 text-destructive" role="alert">
          {error}
        </p>
      )}
      {section === "basic" && (
        <Card className="gap-4 p-5 shadow-none">
          <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
            基本资料
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            出生年月可单独填写；完整日期用于更精确的年龄计算。修改资料不自动改变历史体脂计算快照。
          </p>
          <BasicForm
            key={member.id}
            member={member}
            busy={busy}
            onSave={(v) => action(() => api(`members/${selected}`, "PUT", v))}
          />
        </Card>
      )}
      {section === "history" && (
        <>
          <Card className="gap-4 p-5 shadow-none">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              {editHistory ? "编辑健康经历" : "补充健康经历"}
            </h2>
            <form
              className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start"
              key={editHistory?.id || `new-${historyFormKey}`}
              onSubmit={(e) => {
                const v = fields(e);
                const details = Object.fromEntries(
                  [
                    "reaction",
                    "severity",
                    "dose",
                    "frequency",
                    "relative",
                    "ended_on",
                  ]
                    .filter((k) => v[k])
                    .map((k) => [k, v[k]]),
                );
                action(async () => {
                  await api(
                    `members/${selected}/history${editHistory ? `/${editHistory.id}` : ""}`,
                    editHistory ? "PUT" : "POST",
                    {
                      kind: v.kind,
                      title: v.title,
                      occurred_on: v.occurred_on,
                      status: v.status,
                      notes: v.notes,
                      details,
                    },
                  );
                  setEditHistory(null);
                  setHistoryFormKey((v) => v + 1);
                }, "健康经历已保存");
              }}
            >
              <Label className="grid min-w-0 gap-2 text-sm">
                类型
                <SelectField
                  name="kind"
                  value={editHistory?.kind || newHistory}
                  onChange={(e) => {
                    if (editHistory)
                      setEditHistory({ ...editHistory, kind: e.target.value });
                    else setNewHistory(e.target.value);
                  }}
                >
                  {Object.entries(historyNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </SelectField>
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                名称
                <Input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={editHistory?.title || ""}
                />
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                发生／开始日期
                <DateField
                  type="date"
                  name="occurred_on"
                  defaultValue={editHistory?.occurred_on?.slice(0, 10) || ""}
                />
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                状态
                <SelectField
                  name="status"
                  defaultValue={editHistory?.status || "unknown"}
                >
                  <option value="unknown">未注明</option>
                  <option value="active">目前仍有</option>
                  <option value="resolved">已结束</option>
                </SelectField>
              </Label>
              {(editHistory?.kind || newHistory) === "allergy" && (
                <>
                  <Label className="grid min-w-0 gap-2 text-sm">
                    反应
                    <Input
                      name="reaction"
                      defaultValue={editHistory?.details?.reaction || ""}
                    />
                  </Label>
                  <Label className="grid min-w-0 gap-2 text-sm">
                    严重程度（自述）
                    <Input
                      name="severity"
                      defaultValue={editHistory?.details?.severity || ""}
                    />
                  </Label>
                </>
              )}
              {(editHistory?.kind || newHistory) === "medication" && (
                <>
                  <Label className="grid min-w-0 gap-2 text-sm">
                    剂量（按原处方记录）
                    <Input
                      name="dose"
                      defaultValue={editHistory?.details?.dose || ""}
                    />
                  </Label>
                  <Label className="grid min-w-0 gap-2 text-sm">
                    频次
                    <Input
                      name="frequency"
                      defaultValue={editHistory?.details?.frequency || ""}
                    />
                  </Label>
                  <Label className="grid min-w-0 gap-2 text-sm">
                    结束日期
                    <DateField
                      name="ended_on"
                      type="date"
                      defaultValue={editHistory?.details?.ended_on || ""}
                    />
                  </Label>
                </>
              )}
              {(editHistory?.kind || newHistory) === "family" && (
                <Label className="grid min-w-0 gap-2 text-sm">
                  亲属关系
                  <Input
                    name="relative"
                    defaultValue={editHistory?.details?.relative || ""}
                  />
                </Label>
              )}
              <Label className="grid min-w-0 gap-2 text-sm sm:col-span-2">
                说明
                <Textarea
                  name="notes"
                  maxLength={4000}
                  defaultValue={editHistory?.notes || ""}
                />
              </Label>
              <div className="flex flex-wrap items-start gap-2">
                <Button disabled={busy}>保存健康经历</Button>
                {editHistory && (
                  <Button
                    type="button"
                    onClick={() => setEditHistory(null)}
                    variant="outline"
                  >
                    取消编辑
                  </Button>
                )}
              </div>
            </form>
          </Card>
          <Card className="gap-4 p-5 shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
                健康经历
              </h2>
              <Label className="grid min-w-0 gap-2 text-sm">
                筛选类型
                <SelectField
                  value={historyKind}
                  onChange={(e) => {
                    setHistoryKind(e.target.value);
                    setHistoryPage(1);
                  }}
                >
                  <option value="">全部</option>
                  {Object.entries(historyNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </SelectField>
              </Label>
            </div>
            {history.map((h) => (
              <article
                className="space-y-3 border-b py-5 last:border-0"
                key={h.id}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">{h.title}</h3>
                  <Badge className="text-xs">{historyNames[h.kind]}</Badge>
                </div>
                <p className="text-sm leading-6 text-muted-foreground">
                  {h.occurred_on?.slice(0, 10) || "时间未注明"} ·{" "}
                  {
                    (
                      {
                        active: "目前仍有",
                        resolved: "已结束",
                        unknown: "状态未注明",
                      } as Row
                    )[h.status]
                  }
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  {h.notes}
                </p>
                <dl className="grid grid-cols-[auto_1fr] [&>div]:contents gap-x-4 gap-y-2 text-sm">
                  {Object.entries(h.details || {}).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-muted-foreground">
                        {
                          (
                            {
                              reaction: "反应",
                              severity: "程度",
                              dose: "剂量",
                              frequency: "频次",
                              relative: "亲属",
                              ended_on: "结束日期",
                            } as Row
                          )[k]
                        }
                      </dt>
                      <dd className="min-w-0 break-words">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="flex flex-wrap items-start gap-2">
                  <Button
                    onClick={() => {
                      setEditHistory(h);
                      setNewHistory(h.kind);
                    }}
                    variant="outline"
                  >
                    编辑经历
                  </Button>
                  <Button
                    onClick={() => {
                      navigation.go(`/members/${selected}/documents`);
                      setEditDocument(null);
                      setLinkedHistory(h.id);
                    }}
                    variant="outline"
                  >
                    管理关联文件
                  </Button>
                  <ConfirmAction
                    label="删除经历"
                    description={`删除“${h.title}”？关联文件会保留。`}
                    busy={busy}
                    action={action}
                    run={() =>
                      api(`members/${selected}/history/${h.id}`, "DELETE")
                    }
                  />
                </div>
              </article>
            ))}
            {!history.length && (
              <p className="text-sm leading-6 text-muted-foreground">
                尚未记录。未填写不代表没有相关病史。
              </p>
            )}
            <Pages
              page={historyPage}
              total={historyTotal}
              setPage={setHistoryPage}
            />
          </Card>
        </>
      )}
      {section === "metrics" && (
        <>
          <Card className="gap-4 p-5 shadow-none">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              {editMetric ? "编辑手动指标" : "记录身体指标"}
            </h2>
            <form
              className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start"
              key={editMetric?.id || `new-${metricFormKey}`}
              onSubmit={(e) => {
                const v = fields(e);
                action(async () => {
                  await api(
                    `members/${selected}/observations${editMetric ? `/${editMetric.source_record_id}` : ""}`,
                    editMetric ? "PUT" : "POST",
                    {
                      kind: v.kind,
                      value: Number(v.value),
                      value_secondary: v.value_secondary
                        ? Number(v.value_secondary)
                        : null,
                      measured_at: new Date(
                        v.measured_at + ":00+08:00",
                      ).toISOString(),
                      notes: v.notes,
                    },
                  );
                  setEditMetric(null);
                  setMetricFormKey((v) => v + 1);
                }, "指标已保存");
              }}
            >
              <Label className="grid min-w-0 gap-2 text-sm">
                指标
                <SelectField
                  name="kind"
                  value={editMetric?.kind || newMetric}
                  onChange={(e) => {
                    if (editMetric)
                      setEditMetric({ ...editMetric, kind: e.target.value });
                    else setNewMetric(e.target.value);
                  }}
                >
                  {metrics.map((m) => (
                    <option key={m.kind} value={m.kind}>
                      {metricNames[m.kind]}（{m.unit}）
                    </option>
                  ))}
                </SelectField>
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                {metric?.kind === "blood_pressure" ? "收缩压" : "数值"}（
                {metric?.unit}）
                <Input
                  name="value"
                  type="number"
                  step="any"
                  min={metric?.min}
                  max={metric?.max}
                  required
                  defaultValue={editMetric?.value ?? ""}
                />
              </Label>
              {metric?.kind === "blood_pressure" && (
                <Label className="grid min-w-0 gap-2 text-sm">
                  舒张压（mmHg）
                  <Input
                    name="value_secondary"
                    type="number"
                    min={10}
                    max={300}
                    required
                    defaultValue={editMetric?.value_secondary ?? ""}
                  />
                </Label>
              )}
              <Label className="grid min-w-0 gap-2 text-sm">
                测量时间（上海时间）
                <DateField
                  name="measured_at"
                  type="datetime-local"
                  required
                  defaultValue={
                    editMetric?.measured_at
                      ? new Date(
                          new Date(editMetric.measured_at).getTime() + 28800000,
                        )
                          .toISOString()
                          .slice(0, 16)
                      : new Date(Date.now() + 28800000)
                          .toISOString()
                          .slice(0, 16)
                  }
                />
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                备注
                <Input
                  name="notes"
                  maxLength={4000}
                  defaultValue={editMetric?.notes || ""}
                />
              </Label>
              <div className="flex flex-wrap items-start gap-2">
                <Button disabled={busy}>保存指标</Button>
                {editMetric && (
                  <Button
                    type="button"
                    onClick={() => setEditMetric(null)}
                    variant="outline"
                  >
                    取消编辑
                  </Button>
                )}
              </div>
            </form>
          </Card>
          <Card className="gap-4 p-5 shadow-none">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              身体指标趋势
            </h2>
            <div className="flex flex-wrap items-end gap-3 [&>label]:w-full [&>label]:sm:w-44">
              <Label className="grid min-w-0 gap-2 text-sm">
                指标
                <SelectField
                  value={kind}
                  onChange={(e) => setKind(e.target.value)}
                >
                  {Object.entries(metricNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </SelectField>
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                来源
                <SelectField
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="">全部来源</option>
                  <option value="manual">手动记录</option>
                  <option value="device">设备采集</option>
                </SelectField>
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm sm:col-span-2">
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
              <Label className="grid min-w-0 gap-2 text-sm">
                汇总
                <SelectField
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="day">按日</option>
                  <option value="week">按周</option>
                  <option value="month">按月</option>
                </SelectField>
              </Label>
            </div>
            <p className="text-sm leading-6 text-muted-foreground">
              BMI
              根据体重和当时已记录的身高计算；无历史身高时使用记录当时的成员身高，保存快照后不随资料修改变化。估算值会单独标注。
            </p>
            <MetricChart rows={stats} />
            {statsTotal > 200 && (
              <div className="flex flex-wrap items-center justify-end gap-3 py-2 text-xs text-muted-foreground">
                <Button
                  disabled={statsPage === 1}
                  onClick={() => setStatsPage(statsPage - 1)}
                  variant="outline"
                >
                  统计上一页
                </Button>
                <span>
                  统计第 {statsPage} 页 · 共 {statsTotal} 组
                </span>
                <Button
                  disabled={statsPage * 200 >= statsTotal}
                  onClick={() => setStatsPage(statsPage + 1)}
                  variant="outline"
                >
                  统计下一页
                </Button>
              </div>
            )}
            <div className="min-w-0 max-w-full overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>测量时间</TableHead>
                    <TableHead>数值</TableHead>
                    <TableHead>来源与说明</TableHead>
                    <TableHead>操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((o) => (
                    <TableRow key={o.id}>
                      <TableCell className="align-top">
                        {date(o.measured_at)}
                      </TableCell>
                      <TableCell className="align-top">
                        {Number(o.value).toFixed(2)}
                        {o.value_secondary != null
                          ? ` / ${Number(o.value_secondary).toFixed(2)}`
                          : ""}{" "}
                        {o.unit}
                      </TableCell>
                      <TableCell className="align-top">
                        {o.source === "device" ? "设备采集" : "手动记录"}
                        {o.estimated ? " · 估算" : ""}
                        {o.age_approximate ? " · 年龄近似" : ""}
                        <small className="block text-xs leading-5 text-muted-foreground">
                          {o.notes}
                        </small>
                      </TableCell>
                      <TableCell className="align-top">
                        {o.source === "manual" && !o.estimated && (
                          <div className="flex flex-wrap items-start gap-2">
                            <Button
                              onClick={() => setEditMetric(o)}
                              variant="link"
                            >
                              编辑指标
                            </Button>
                            <ConfirmAction
                              label="删除指标"
                              description="删除这条手动记录？"
                              busy={busy}
                              action={action}
                              run={() =>
                                api(
                                  `members/${selected}/observations/${o.source_record_id}`,
                                  "DELETE",
                                )
                              }
                            />
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {!rows.length && (
              <p className="text-sm leading-6 text-muted-foreground">
                暂无该指标记录。
              </p>
            )}
            <Pages page={page} total={total} setPage={setPage} />
          </Card>
        </>
      )}
      {section === "documents" && (
        <>
          <Card className="gap-4 p-5 shadow-none">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              {editDocument ? "编辑文件资料" : "添加医疗文件"}
            </h2>
            <form
              className="grid min-w-0 items-end gap-4 sm:grid-cols-2 [&>button]:justify-self-start"
              key={editDocument?.id || "new"}
              onSubmit={saveDoc}
            >
              <Label className="grid min-w-0 gap-2 text-sm">
                标题
                <Input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={editDocument?.title || ""}
                />
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                类型
                <SelectField
                  name="category"
                  defaultValue={editDocument?.category || "report"}
                >
                  {Object.entries(documentNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </SelectField>
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                检查日期
                <DateField
                  name="recorded_on"
                  type="date"
                  defaultValue={editDocument?.recorded_on?.slice(0, 10) || ""}
                />
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                医疗机构
                <Input
                  name="institution"
                  maxLength={200}
                  defaultValue={editDocument?.institution || ""}
                />
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                搜索关联经历
                <Input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="按标题搜索"
                />
              </Label>
              <Label className="grid min-w-0 gap-2 text-sm">
                关联健康经历
                <SelectField
                  name="history_id"
                  value={
                    editDocument ? editDocument.history_id || "" : linkedHistory
                  }
                  onChange={(e) => {
                    if (editDocument)
                      setEditDocument({
                        ...editDocument,
                        history_id: e.target.value,
                      });
                    else setLinkedHistory(e.target.value);
                  }}
                >
                  <option value="">不关联</option>
                  {historyOptions.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.title}
                    </option>
                  ))}
                </SelectField>
              </Label>
              {!editDocument && (
                <Label className="grid min-w-0 gap-2 text-sm">
                  原件（默认最大 25 MiB）
                  <Input
                    name="file"
                    type="file"
                    required
                    accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,.heic,.heif"
                  />
                </Label>
              )}
              <Label className="grid min-w-0 gap-2 text-sm sm:col-span-2">
                摘要
                <Textarea
                  name="summary"
                  maxLength={8000}
                  rows={3}
                  defaultValue={editDocument?.summary || ""}
                />
              </Label>
              <div className="flex flex-wrap items-start gap-2">
                <Button disabled={busy}>
                  {busy ? "正在保存…" : "保存医疗文件"}
                </Button>
                {editDocument && (
                  <Button
                    type="button"
                    onClick={() => setEditDocument(null)}
                    variant="outline"
                  >
                    取消编辑
                  </Button>
                )}
              </div>
            </form>
            <p className="text-sm leading-6 text-muted-foreground">
              原件完整保留；PDF 可选取的文字供 AI
              读取。照片和扫描件通过页面预览读取。
            </p>
          </Card>
          <Card className="gap-4 p-5 shadow-none">
            <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
              医疗文件
            </h2>
            {documents.map((d) => (
              <article
                className="space-y-3 border-b py-5 last:border-0"
                key={d.id}
              >
                <h3 className="text-sm font-semibold">{d.title}</h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  {documentNames[d.category] || d.category} ·{" "}
                  {d.recorded_on?.slice(0, 10) || "日期未注明"} ·{" "}
                  {d.institution || "机构未注明"}
                </p>
                <p className="text-sm leading-6 text-muted-foreground">
                  {d.summary}
                </p>
                <small className="block text-xs leading-5 text-muted-foreground">
                  {d.filename} · {(d.size / 1048576).toFixed(2)} MiB ·{" "}
                  {d.page_count} 页
                </small>
                <div className="flex flex-wrap items-start gap-2">
                  <Button
                    onClick={() => {
                      if (isOffline()) {
                        setError("医疗文件原件未缓存在本机，请联网后预览");
                        return;
                      }
                      setPreview(d);
                      setPreviewPage(1);
                      setText("");
                    }}
                    variant="outline"
                  >
                    预览文件
                  </Button>
                  <Button asChild variant="outline">
                    <a
                      onClick={(e) => {
                        if (isOffline()) {
                          e.preventDefault();
                          setError("医疗文件原件需要联网下载");
                        }
                      }}
                      href={`/api/v1/documents/${d.id}/download`}
                    >
                      下载原件
                    </a>
                  </Button>
                  <Button onClick={() => setEditDocument(d)} variant="outline">
                    编辑文件信息
                  </Button>
                  <ConfirmAction
                    label="删除文件"
                    description={`删除“${d.title}”及原件？`}
                    busy={busy}
                    action={action}
                    run={async () => {
                      await api(
                        `members/${selected}/documents/${d.id}`,
                        "DELETE",
                      );
                      if (preview?.id === d.id) setPreview(null);
                    }}
                  />
                </div>
              </article>
            ))}
            {!documents.length && (
              <p className="text-sm leading-6 text-muted-foreground">
                暂无医疗文件。
              </p>
            )}
            <Pages
              page={documentPage}
              total={documentTotal}
              setPage={setDocumentPage}
            />
          </Card>
          {preview && (
            <Card className="gap-4 p-5 shadow-none">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="min-w-0 break-words text-base font-semibold tracking-tight">
                  {preview.title} · 第 {previewPage} / {preview.page_count} 页
                </h2>
                <Button onClick={() => setPreview(null)} variant="outline">
                  关闭预览
                </Button>
              </div>
              <img
                className="mx-auto block h-auto max-w-full rounded-lg border"
                src={`/api/v1/documents/${preview.id}/pages/${previewPage}`}
                alt={`${preview.title}第${previewPage}页`}
              />
              <div className="flex flex-wrap items-start gap-2">
                <Button
                  disabled={previewPage <= 1}
                  onClick={() => setPreviewPage(previewPage - 1)}
                  variant="outline"
                >
                  上一页
                </Button>
                <Button
                  disabled={previewPage >= preview.page_count}
                  onClick={() => setPreviewPage(previewPage + 1)}
                  variant="outline"
                >
                  下一页
                </Button>
                <Button
                  onClick={() =>
                    action(async () => {
                      const v = await api(`documents/${preview.id}/text`);
                      setText(
                        v.text || "该文件没有可选取文字，请查看页面预览。",
                      );
                    }, "已读取文件文字")
                  }
                  variant="outline"
                >
                  查看文件文字
                </Button>
              </div>
              {text && (
                <pre className="max-w-full max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-xs">
                  {text}
                </pre>
              )}
            </Card>
          )}
        </>
      )}
    </>
  );
}
