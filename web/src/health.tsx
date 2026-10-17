import {Link,useLocation} from "react-router";
import {useQueryState,useRouteNavigation} from "./routing";
import {routeForPath} from "./routingDomain";
import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts/core";
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
  api: (path: string, method?: string, body?: unknown) => Promise<any>;
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
    <div className="pagination">
      <button
        className="secondary"
        disabled={page === 1}
        onClick={() => setPage(page - 1)}
      >
        上一页
      </button>
      <span>
        第 {page} 页 · 共 {total} 条
      </span>
      <button
        className="secondary"
        disabled={page * 50 >= total}
        onClick={() => setPage(page + 1)}
      >
        下一页
      </button>
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
      className="form-grid"
      onSubmit={(e) => onSave(memberProfile(fields(e)))}
    >
      <label>
        姓名
        <input
          name="name"
          required
          maxLength={100}
          defaultValue={member?.name || ""}
        />
      </label>
      <ProfileFields key={member?.id || "new"} member={member} />
      <label>
        血型
        <select name="blood_type" defaultValue={member?.blood_type || ""}>
          <option value="">暂不填写</option>
          {["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </label>
      <label className="wide-field">
        备注
        <textarea
          name="notes"
          rows={3}
          maxLength={4000}
          defaultValue={member?.notes || ""}
        />
      </label>
      <button disabled={busy}>保存成员资料</button>
    </form>
  );
}
function MetricChart({ rows }: { rows: Row[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
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
      const lines = [
        {
          name,
          type: "line",
          connectNulls: false,
          data: times.map(
            (t) => values.find((v) => v.time === t)?.mean ?? null,
          ),
        },
      ];
      if (first.kind === "blood_pressure")
        lines.push({
          name: "舒张压",
          type: "line",
          connectNulls: false,
          data: times.map(
            (t) => values.find((v) => v.time === t)?.mean_secondary ?? null,
          ),
        });
      return lines;
    });
    chart.setOption({
      color: ["#0c6657", "#cd925b", "#67a994"],
      tooltip: { trigger: "axis" },
      legend: { bottom: 0 },
      grid: { left: 50, right: 20, top: 20, bottom: 70 },
      xAxis: {
        type: "category",
        data: times.map((t) =>
          new Date(t).toLocaleDateString("zh-CN", {
            timeZone: "Asia/Shanghai",
          }),
        ),
      },
      yAxis: { type: "value", scale: true, name: rows[0]?.unit || "" },
      series,
    });
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [rows]);
  return (
    <div ref={ref} className="chart" role="img" aria-label="身体指标历史趋势" />
  );
}
export function HealthProfiles({ members, refresh, api, action, busy }: Props) {
  const [historyFormKey, setHistoryFormKey] = useState(0),
    [metricFormKey, setMetricFormKey] = useState(0);
  const [historyOptions, setHistoryOptions] = useState<Row[]>([]),
    [historySearch, setHistorySearch] = useState(""),
    [linkedHistory, setLinkedHistory] = useState("");
  const {memberId:selected,section}=routeForPath(useLocation().pathname);
  const navigation=useRouteNavigation();
  const [creating,setCreating]=useState(false);
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
  const [kind, setKind] = useQueryState("kind", "weight", ["page","stats_page","history_page"]),
    [historyKind, setHistoryKind] = useQueryState("history_kind", "", ["page","stats_page","history_page"]),
    [source, setSource] = useQueryState("source", "", ["page","stats_page","history_page"]),
    [from, setFrom] = useQueryState("from", "", ["page","stats_page","history_page"]),
    [to, setTo] = useQueryState("to", "", ["page","stats_page","history_page"]),
    [group, setGroup] = useQueryState("group", "day", ["page","stats_page","history_page"]);
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
  const query = healthQuery(selected, kind, page, from, to, group, source);
  useEffect(() => {
    api("health/metrics")
      .then(setMetrics)
      .catch((e) => setError(e.message));
  }, [api]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    api(
      `health/history?member_id=${selected}&page_size=200&search=${encodeURIComponent(historySearch)}`,
    )
      .then((v) => active && setHistoryOptions(v.items))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [selected, refresh, historySearch, api]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    Promise.all([
      api(
        `health/history?member_id=${selected}&page=${historyPage}&page_size=50${historyKind ? `&kind=${historyKind}` : ""}`,
      ),
      api(
        `health/documents?member_id=${selected}&page=${documentPage}&page_size=50`,
      ),
      api("health/observations?" + query),
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
          ).replace("page_size=50", "page_size=200"),
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
  if (selected && !member) return <section className="panel"><h2>成员未找到</h2><Link to="/members">返回成员列表</Link></section>;
  if (!member)
    return (
      <>
        <div className="section-title">
          <h2>家人的健康档案</h2>
          <button onClick={() => setCreating(!creating)}>
            {creating ? "收起" : "添加成员"}
          </button>
        </div>
        {creating && (
          <section className="panel">
            <h2>添加家庭成员</h2>
            <BasicForm
              busy={busy}
              onSave={(values) =>
                action(async () => {
                  const m = await api("members", "POST", values);
                  open(m.id);
                }, "成员已添加")
              }
            />
          </section>
        )}
        <div className="cards">
          {members.map((m) => (
            <section className="panel" key={m.id}>
              <h2>{m.name}</h2>
              <p>
                {memberAge(m)} · {m.blood_type || "血型未填写"}
              </p>
              <p>{m.height_cm ? `${m.height_cm} cm` : "身高未填写"}</p>
              <Link className="button secondary" to={`/members/${m.id}/basic`}>查看健康档案</Link>
            </section>
          ))}
        </div>
        {!members.length && <p>先添加家人，再补充健康资料与测量记录。</p>}
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
      <div className="section-title">
        <div>
          <h2>{member.name}的健康档案</h2>
          <p>{memberAge(member)}</p>
        </div>
        <Link className="button secondary" to="/members">返回成员列表</Link>
      </div>
      <div className="profile-tabs" role="tablist" aria-label="健康档案分类">
        {[
          ["basic", "基本资料"],
          ["history", "健康经历"],
          ["metrics", "身体指标"],
          ["documents", "医疗文件"],
        ].map(([id, label]) => (
          <Link
            to={`/members/${selected}/${id}`}
            role="tab"
            aria-selected={section === id}
            className={section === id ? "" : "secondary"}
            key={id}
          >
            {label}
          </Link>
        ))}
      </div>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {section === "basic" && (
        <section className="panel">
          <h2>基本资料</h2>
          <p>
            出生年月可单独填写；完整日期用于更精确的年龄计算。修改资料不自动改变历史体脂计算快照。
          </p>
          <BasicForm
            key={JSON.stringify([
              member.id,
              member.birth_date,
              member.birth_month,
              member.height_cm,
              member.blood_type,
              member.sex,
              member.notes,
              member.name,
            ])}
            member={member}
            busy={busy}
            onSave={(v) => action(() => api(`members/${selected}`, "PUT", v))}
          />
        </section>
      )}
      {section === "history" && (
        <>
          <section className="panel">
            <h2>{editHistory ? "编辑健康经历" : "补充健康经历"}</h2>
            <form
              className="form-grid"
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
              <label>
                类型
                <select
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
                </select>
              </label>
              <label>
                名称
                <input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={editHistory?.title || ""}
                />
              </label>
              <label>
                发生／开始日期
                <input
                  type="date"
                  name="occurred_on"
                  defaultValue={editHistory?.occurred_on?.slice(0, 10) || ""}
                />
              </label>
              <label>
                状态
                <select
                  name="status"
                  defaultValue={editHistory?.status || "unknown"}
                >
                  <option value="unknown">未注明</option>
                  <option value="active">目前仍有</option>
                  <option value="resolved">已结束</option>
                </select>
              </label>
              {(editHistory?.kind || newHistory) === "allergy" && (
                <>
                  <label>
                    反应
                    <input
                      name="reaction"
                      defaultValue={editHistory?.details?.reaction || ""}
                    />
                  </label>
                  <label>
                    严重程度（自述）
                    <input
                      name="severity"
                      defaultValue={editHistory?.details?.severity || ""}
                    />
                  </label>
                </>
              )}
              {(editHistory?.kind || newHistory) === "medication" && (
                <>
                  <label>
                    剂量（按原处方记录）
                    <input
                      name="dose"
                      defaultValue={editHistory?.details?.dose || ""}
                    />
                  </label>
                  <label>
                    频次
                    <input
                      name="frequency"
                      defaultValue={editHistory?.details?.frequency || ""}
                    />
                  </label>
                  <label>
                    结束日期
                    <input
                      name="ended_on"
                      type="date"
                      defaultValue={editHistory?.details?.ended_on || ""}
                    />
                  </label>
                </>
              )}
              {(editHistory?.kind || newHistory) === "family" && (
                <label>
                  亲属关系
                  <input
                    name="relative"
                    defaultValue={editHistory?.details?.relative || ""}
                  />
                </label>
              )}
              <label className="wide-field">
                说明
                <textarea
                  name="notes"
                  maxLength={4000}
                  defaultValue={editHistory?.notes || ""}
                />
              </label>
              <div className="actions">
                <button disabled={busy}>保存健康经历</button>
                {editHistory && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setEditHistory(null)}
                  >
                    取消编辑
                  </button>
                )}
              </div>
            </form>
          </section>
          <section className="panel">
            <div className="section-title">
              <h2>健康经历</h2>
              <label>
                筛选类型
                <select
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
                </select>
              </label>
            </div>
            {history.map((h) => (
              <article className="health-entry" key={h.id}>
                <div className="section-title">
                  <h3>{h.title}</h3>
                  <span className="badge">{historyNames[h.kind]}</span>
                </div>
                <p>
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
                <p>{h.notes}</p>
                <dl>
                  {Object.entries(h.details || {}).map(([k, v]) => (
                    <div key={k}>
                      <dt>
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
                      <dd>{String(v)}</dd>
                    </div>
                  ))}
                </dl>
                <div className="actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setEditHistory(h);
                      setNewHistory(h.kind);
                    }}
                  >
                    编辑经历
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      navigation.go(`/members/${selected}/documents`);
                      setEditDocument(null);
                      setLinkedHistory(h.id);
                    }}
                  >
                    管理关联文件
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`删除“${h.title}”？关联文件会保留。`))
                        action(() =>
                          api(`members/${selected}/history/${h.id}`, "DELETE"),
                        );
                    }}
                  >
                    删除经历
                  </button>
                </div>
              </article>
            ))}
            {!history.length && <p>尚未记录。未填写不代表没有相关病史。</p>}
            <Pages
              page={historyPage}
              total={historyTotal}
              setPage={setHistoryPage}
            />
          </section>
        </>
      )}
      {section === "metrics" && (
        <>
          <section className="panel">
            <h2>{editMetric ? "编辑手动指标" : "记录身体指标"}</h2>
            <form
              className="form-grid"
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
              <label>
                指标
                <select
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
                </select>
              </label>
              <label>
                {metric?.kind === "blood_pressure" ? "收缩压" : "数值"}（
                {metric?.unit}）
                <input
                  name="value"
                  type="number"
                  step="any"
                  min={metric?.min}
                  max={metric?.max}
                  required
                  defaultValue={editMetric?.value ?? ""}
                />
              </label>
              {metric?.kind === "blood_pressure" && (
                <label>
                  舒张压（mmHg）
                  <input
                    name="value_secondary"
                    type="number"
                    min={10}
                    max={300}
                    required
                    defaultValue={editMetric?.value_secondary ?? ""}
                  />
                </label>
              )}
              <label>
                测量时间（上海时间）
                <input
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
              </label>
              <label>
                备注
                <input
                  name="notes"
                  maxLength={4000}
                  defaultValue={editMetric?.notes || ""}
                />
              </label>
              <div className="actions">
                <button disabled={busy}>保存指标</button>
                {editMetric && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setEditMetric(null)}
                  >
                    取消编辑
                  </button>
                )}
              </div>
            </form>
          </section>
          <section className="panel">
            <h2>身体指标趋势</h2>
            <div className="filters">
              <label>
                指标
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {Object.entries(metricNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                来源
                <select
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                >
                  <option value="">全部来源</option>
                  <option value="manual">手动记录</option>
                  <option value="device">设备采集</option>
                </select>
              </label>
              <label>
                开始日期
                <input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label>
                结束日期
                <input
                  type="date"
                  min={from}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
              <label>
                汇总
                <select
                  value={group}
                  onChange={(e) => setGroup(e.target.value)}
                >
                  <option value="day">按日</option>
                  <option value="week">按周</option>
                  <option value="month">按月</option>
                </select>
              </label>
            </div>
            <p>
              BMI
              根据体重和当时已记录的身高计算；无历史身高时使用记录当时的成员身高，保存快照后不随资料修改变化。估算值会单独标注。
            </p>
            <MetricChart rows={stats} />
            {statsTotal > 200 && (
              <div className="pagination">
                <button
                  className="secondary"
                  disabled={statsPage === 1}
                  onClick={() => setStatsPage(statsPage - 1)}
                >
                  统计上一页
                </button>
                <span>
                  统计第 {statsPage} 页 · 共 {statsTotal} 组
                </span>
                <button
                  className="secondary"
                  disabled={statsPage * 200 >= statsTotal}
                  onClick={() => setStatsPage(statsPage + 1)}
                >
                  统计下一页
                </button>
              </div>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>测量时间</th>
                    <th>数值</th>
                    <th>来源与说明</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((o) => (
                    <tr key={o.id}>
                      <td>{date(o.measured_at)}</td>
                      <td>
                        {Number(o.value).toFixed(2)}
                        {o.value_secondary != null
                          ? ` / ${Number(o.value_secondary).toFixed(2)}`
                          : ""}{" "}
                        {o.unit}
                      </td>
                      <td>
                        {o.source === "device" ? "设备采集" : "手动记录"}
                        {o.estimated ? " · 估算" : ""}
                        {o.age_approximate ? " · 年龄近似" : ""}
                        <small>{o.notes}</small>
                      </td>
                      <td>
                        {o.source === "manual" && !o.estimated && (
                          <div className="actions">
                            <button
                              className="link"
                              onClick={() => setEditMetric(o)}
                            >
                              编辑指标
                            </button>
                            <button
                              className="link"
                              disabled={busy}
                              onClick={() => {
                                if (confirm("删除这条手动记录？"))
                                  action(() =>
                                    api(
                                      `members/${selected}/observations/${o.source_record_id}`,
                                      "DELETE",
                                    ),
                                  );
                              }}
                            >
                              删除指标
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!rows.length && <p>暂无该指标记录。</p>}
            <Pages page={page} total={total} setPage={setPage} />
          </section>
        </>
      )}
      {section === "documents" && (
        <>
          <section className="panel">
            <h2>{editDocument ? "编辑文件资料" : "添加医疗文件"}</h2>
            <form
              className="form-grid"
              key={editDocument?.id || "new"}
              onSubmit={saveDoc}
            >
              <label>
                标题
                <input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={editDocument?.title || ""}
                />
              </label>
              <label>
                类型
                <select
                  name="category"
                  defaultValue={editDocument?.category || "report"}
                >
                  {Object.entries(documentNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                检查日期
                <input
                  name="recorded_on"
                  type="date"
                  defaultValue={editDocument?.recorded_on?.slice(0, 10) || ""}
                />
              </label>
              <label>
                医疗机构
                <input
                  name="institution"
                  maxLength={200}
                  defaultValue={editDocument?.institution || ""}
                />
              </label>
              <label>
                搜索关联经历
                <input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="按标题搜索"
                />
              </label>
              <label>
                关联健康经历
                <select
                  name="history_id"
                  value={editDocument ? editDocument.history_id || "" : linkedHistory}
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
                </select>
              </label>
              {!editDocument && (
                <label>
                  原件（默认最大 25 MiB）
                  <input
                    name="file"
                    type="file"
                    required
                    accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,.heic,.heif"
                  />
                </label>
              )}
              <label className="wide-field">
                摘要
                <textarea
                  name="summary"
                  maxLength={8000}
                  rows={3}
                  defaultValue={editDocument?.summary || ""}
                />
              </label>
              <div className="actions">
                <button disabled={busy}>
                  {busy ? "正在保存…" : "保存医疗文件"}
                </button>
                {editDocument && (
                  <button
                    className="secondary"
                    type="button"
                    onClick={() => setEditDocument(null)}
                  >
                    取消编辑
                  </button>
                )}
              </div>
            </form>
            <p>
              原件完整保留；PDF 可选取的文字供 AI
              读取。照片和扫描件通过页面预览读取。
            </p>
          </section>
          <section className="panel">
            <h2>医疗文件</h2>
            {documents.map((d) => (
              <article className="health-entry" key={d.id}>
                <h3>{d.title}</h3>
                <p>
                  {documentNames[d.category] || d.category} ·{" "}
                  {d.recorded_on?.slice(0, 10) || "日期未注明"} ·{" "}
                  {d.institution || "机构未注明"}
                </p>
                <p>{d.summary}</p>
                <small>
                  {d.filename} · {(d.size / 1048576).toFixed(2)} MiB ·{" "}
                  {d.page_count} 页
                </small>
                <div className="actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setPreview(d);
                      setPreviewPage(1);
                      setText("");
                    }}
                  >
                    预览文件
                  </button>
                  <a
                    className="button secondary"
                    href={`/api/v1/documents/${d.id}/download`}
                  >
                    下载原件
                  </a>
                  <button
                    className="secondary"
                    onClick={() => setEditDocument(d)}
                  >
                    编辑文件信息
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      if (confirm(`删除“${d.title}”及原件？`))
                        action(async () => {
                          await api(
                            `members/${selected}/documents/${d.id}`,
                            "DELETE",
                          );
                          if (preview?.id === d.id) setPreview(null);
                        });
                    }}
                  >
                    删除文件
                  </button>
                </div>
              </article>
            ))}
            {!documents.length && <p>暂无医疗文件。</p>}
            <Pages
              page={documentPage}
              total={documentTotal}
              setPage={setDocumentPage}
            />
          </section>
          {preview && (
            <section className="panel">
              <div className="section-title">
                <h2>
                  {preview.title} · 第 {previewPage} / {preview.page_count} 页
                </h2>
                <button className="secondary" onClick={() => setPreview(null)}>
                  关闭预览
                </button>
              </div>
              <img
                className="medical-preview"
                src={`/api/v1/documents/${preview.id}/pages/${previewPage}`}
                alt={`${preview.title}第${previewPage}页`}
              />
              <div className="actions">
                <button
                  className="secondary"
                  disabled={previewPage <= 1}
                  onClick={() => setPreviewPage(previewPage - 1)}
                >
                  上一页
                </button>
                <button
                  className="secondary"
                  disabled={previewPage >= preview.page_count}
                  onClick={() => setPreviewPage(previewPage + 1)}
                >
                  下一页
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    action(async () => {
                      const v = await api(`documents/${preview.id}/text`);
                      setText(
                        v.text || "该文件没有可选取文字，请查看页面预览。",
                      );
                    }, "已读取文件文字")
                  }
                >
                  查看文件文字
                </button>
              </div>
              {text && <pre className="document-text">{text}</pre>}
            </section>
          )}
        </>
      )}
    </>
  );
}
