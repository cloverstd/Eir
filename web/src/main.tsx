import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  CanvasRenderer,
]);
import "./style.css";
import {HealthProfiles} from "./health";
import {BodyMeasurements} from "./body";
import {scaleProfile} from "./bodyDomain";
import { measurementQuery, chartDay, measurementCorrection, isHistoryStart } from "./domain";
import { Discovered, CollectorActions, DeviceActions, ConfirmAction, ResetAction, Operations } from "./lifecycle";
type Row = Record<string, any>;
async function api(path: string, method = "GET", body?: unknown) {
  const r = await fetch("/api/v1/" + path, {
    method,
    headers:
      body instanceof FormData
        ? undefined
        : body
          ? { "Content-Type": "application/json" }
          : undefined,
    body:
      body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const t = await r.text();
    let message = t;
    try {
      message = JSON.parse(t).error || t;
    } catch {}
    throw new Error(message || `请求失败 (${r.status})`);
  }
  return r.status === 204 ? null : r.json();
}
const date = (v: unknown) =>
  v
    ? new Date(String(v)).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "—";
const val = (v: unknown) =>
  v == null ? "—" : typeof v === "number" ? Math.round(v * 10) / 10 : String(v);
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty">
      <span>◌</span>
      <p>{children}</p>
    </div>
  );
}
function Chart({ buckets }: { buckets: Row[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const c = echarts.init(ref.current);
    c.setOption({
      color: ["#0c6657", "#67a994", "#cd925b"],
      tooltip: { trigger: "axis" },
      legend: { bottom: 0 },
      grid: { left: 42, right: 20, top: 20, bottom: 66 },
      xAxis: {
        type: "category",
        data: buckets.map((x) => chartDay(x.time)),
        axisLine: { lineStyle: { color: "#d8e1da" } },
      },
      yAxis: { type: "value", splitLine: { lineStyle: { color: "#edf1ed" } } },
      series: [
        ["收缩压", "systolic"],
        ["舒张压", "diastolic"],
        ["脉搏", "pulse"],
      ].map(([name, key]) => ({
        name,
        type: "line",
        smooth: false,
        connectNulls: false,
        data: buckets.map((x) => x[key]),
        symbolSize: 7,
      })),
    });
    const o = new ResizeObserver(() => c.resize());
    o.observe(ref.current);
    return () => {
      o.disconnect();
      c.dispose();
    };
  }, [buckets]);
  return (
    <div
      ref={ref}
      className="chart"
      role="img"
      aria-label="按时间显示收缩压、舒张压和脉搏趋势"
    />
  );
}
function App() {
  const [tab, setTab] = useState("overview");
  const [members, setMembers] = useState<Row[]>([]),
    [devices, setDevices] = useState<Row[]>([]),
    [collectors, setCollectors] = useState<Row[]>([]),
    [discovered, setDiscovered] = useState<Row[]>([]),
    [operations, setOperations] = useState<Row[]>([]),
    [firmwares, setFirmwares] = useState<Row[]>([]),
    [jobs, setJobs] = useState<Row[]>([]),
    [events, setEvents] = useState<Row[]>([]),
    [bindings, setBindings] = useState<Row[]>([]),
    [rejections, setRejections] = useState<Row[]>([]);
  const [measurements, setMeasurements] = useState<Row[]>([]),
    [total, setTotal] = useState(0),
    [stats, setStats] = useState<Row>({});
  const [member, setMember] = useState(""),
    [device, setDevice] = useState(""),
    [unassigned, setUnassigned] = useState(false),
    [period, setPeriod] = useState("30"),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [group, setGroup] = useState("day"),
    [page, setPage] = useState(1);
  const [error, setError] = useState(""),
    [loadError, setLoadError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [hasLoaded, setHasLoaded] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [bindingDevice, setBindingDevice] = useState(""),
    [slot, setSlot] = useState("1"),
    [preview, setPreview] = useState<number | null>(null);
  const [editing, setEditing] = useState<Row | null>(null),
    [latest, setLatest] = useState<Record<string, Row>>({}),
    [scanAddress, setScanAddress] = useState(""),
    [scanCollector, setScanCollector] = useState(""),
    [scanAddressType, setScanAddressType] = useState("0");
 const [scanProfile,setScanProfile]=useState("omron-hem-7374t1"),[scanHardware,setScanHardware]=useState("");
  const query = useCallback(() => {
    return measurementQuery({
      member,
      device,
      unassigned,
      period,
      from,
      to,
      group,
      page,
    });
  }, [member, device, unassigned, page, period, from, to, group]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      api("members"),
      api("devices"),
      api("collectors"),
      api("firmwares"),
      api("ota-jobs"),
      api("events"),
      api("bindings"),
      api("measurements?" + query()),
      api("statistics?" + query()),
      api("rejections"),
      api("collectors/discovered"),
      api("operations"),
    ])
      .then(([m, d, c, f, j, e, b, r, s, rejected, discoveredRows, operationRows]) => {
        if (!active) return;
        setHasLoaded(true);
        setMembers(m);
        setDevices(d);
        setCollectors(c);
        setDiscovered(discoveredRows);
        setOperations(operationRows);
        setFirmwares(f);
        setJobs(j);
        setEvents(e);
        setBindings(b);
        setMeasurements(r.items || []);
        setTotal(r.total || 0);
        setStats(s);
        setRejections(rejected);
        setLoadError("");
      })
      .catch((e) => active && setLoadError(e.message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [query, refresh]);
  useEffect(() => {
    const s = new EventSource("/api/v1/events/stream");
    let t: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(t);
      t = setTimeout(() => setRefresh((x) => x + 1), 500);
    };
    s.addEventListener("change", update);
    s.onmessage = update;
    const interval = setInterval(update, 30000);
    return () => {
      clearTimeout(t);
      clearInterval(interval);
      s.close();
    };
  }, []);
  useEffect(() => {
    setPreview(null);
    if (bindingDevice)
      api(
        `bindings/preview?device_id=${encodeURIComponent(bindingDevice)}&user_slot=${devices.find(d=>d.id===bindingDevice)?.profile===scaleProfile?0:slot}`,
      )
        .then((r) => setPreview(r.unassigned_count))
        .catch(() => {});
  }, [bindingDevice, slot, refresh, devices]);
  useEffect(() => {
    let active = true;
    Promise.all(
      members.map(
        async (m) =>
          [
            m.id,
            (
              await api(
                "measurements?member_id=" + m.id + "&kind=blood_pressure&page=1&page_size=1",
              )
            ).items?.[0],
          ] as const,
      ),
    )
      .then((rows) => {
        if (active)
          setLatest(
            Object.fromEntries(
              rows.filter((r): r is readonly [string, Row] => !!r[1]),
            ),
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [members]);
  useEffect(() => {
    if (!editing) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const focusable = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button,input,select,textarea,a[href]",
        ) || [],
      );
    focusable()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditing(null);
      if (e.key === "Tab") {
        const all = focusable();
        const first = all[0],
          last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, [editing]);
  async function action(fn: () => Promise<unknown>, message = "已保存") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      setNotice(message);
      setRefresh((x) => x + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function form(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return Object.fromEntries(new FormData(e.currentTarget)) as Record<
      string,
      string
    >;
  }
  function command(id: string, type: string, device_id?: string) {
    return action(
      () =>
        api(`collectors/${id}/commands`, "POST", {
          type,
          ...(device_id ? { device_id } : {}),
        }),
      "指令已提交，请查看设备事件中的执行结果",
    );
  }
  const tabs = [
    ["overview", "⌂", "家庭概览"],
    ["data", "▥", "血压数据"],
    ["body", "◴", "体重与体脂"],
    ["devices", "⌁", "设备与采集端"],
    ["members", "♧", "家庭成员"],
    ["firmware", "↑", "固件升级"],
    ["settings", "⚙", "系统管理"],
  ];
  return (
    <div className="shell">
      <aside>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("overview");
          }}
        >
          <span className="mark">e</span>
          <span>
            Eir<small>家庭健康管理</small>
          </span>
        </a>
        <div className="nav-label">家庭空间</div>
        <nav aria-label="主导航">
          {tabs.map(([id, icon, label]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              <span>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <span className="dot" /> 内网家庭空间<small>数据由你自己保管</small>
        </div>
      </aside>
      <main>
        <header>
          <div className="eyebrow">EIR / FAMILY WELLNESS</div>
          <div className="heading">
            <div>
              <h1>{tabs.find((x) => x[0] === tab)?.[2]}</h1>
              <p>
                {tab === "overview"
                  ? "关心家人的每一次变化。"
                  : tab === "data"
                    ? "按成员和时间查看每一条测量记录。"
                    : tab === "body" ? "每台秤连接一位家人，记录体重与估算体脂率。" : tab === "devices"
                      ? "连接分布在家中的设备，让记录自然汇聚。"
                      : tab === "members"
                        ? "为每位家人建立独立的健康记录。"
                        : tab === "settings" ? "查看设备操作进度与管理数据重置。" : "管理采集端固件与远程升级进度。"}
              </p>
            </div>
            <button
              className="secondary"
              disabled={loading}
              onClick={() => setRefresh((x) => x + 1)}
            >
              {loading ? "同步中…" : "刷新数据"}
            </button>
          </div>
        </header>
        {(error || loadError) && (
          <div className="alert" role="alert">
            {error ||
              (hasLoaded
                ? `更新失败，当前显示上次成功读取的数据：${loadError}`
                : loadError)}
            <button
              aria-label="关闭错误"
              onClick={() => {
                setError("");
                setLoadError("");
              }}
            >
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
            <button aria-label="关闭提示" onClick={() => setNotice("")}>
              ×
            </button>
          </div>
        )}
        {!hasLoaded ? (
          <section className="panel">
            <Empty>
              {loading
                ? "正在连接家庭健康服务…"
                : "暂时无法读取数据，请检查服务连接后重试。"}
            </Empty>
          </section>
        ) : (
          <>
            {(tab === "overview" || tab === "data") && (
              <>
                <div className="filters">
                  <label>
                    家庭成员
                    <select
                      value={member}
                      onChange={(e) => {
                        setMember(e.target.value);
                        if (e.target.value) setUnassigned(false);
                        setPage(1);
                      }}
                    >
                      <option value="">全部成员</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    时间范围
                    <select
                      value={period}
                      onChange={(e) => {
                        setPeriod(e.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="7">最近 7 天</option>
                      <option value="30">最近 30 天</option>
                      <option value="90">最近 90 天</option>
                      <option value="all">全部时间（含无效时间）</option>
                      <option value="custom">自定义</option>
                    </select>
                  </label>
                  {period === "custom" && (
                    <>
                      <label>
                        开始日期
                        <input
                          type="date"
                          value={from}
                          onChange={(e) => {
                            setFrom(e.target.value);
                            setPage(1);
                          }}
                        />
                      </label>
                      <label>
                        结束日期
                        <input
                          type="date"
                          min={from}
                          value={to}
                          onChange={(e) => {
                            setTo(e.target.value);
                            setPage(1);
                          }}
                        />
                      </label>
                    </>
                  )}
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
                <div className="metrics">
                  {[
                    ["测量记录", stats.count ?? 0, "次"],
                    ["平均收缩压", stats.mean_systolic, "mmHg"],
                    ["平均舒张压", stats.mean_diastolic, "mmHg"],
                    ["平均脉搏", stats.mean_pulse, "次 / 分"],
                  ].map(([name, value, unit]) => (
                    <article className="metric" key={String(name)}>
                      <span>{name}</span>
                      <div>
                        {val(value)}
                        <small>{unit}</small>
                      </div>
                    </article>
                  ))}
                </div>
                {tab === "overview" && (
                  <section>
                    <div className="section-title">
                      <h2>家人的健康档案</h2>
                      <button
                        className="link"
                        onClick={() => setTab("members")}
                      >
                        管理成员 →
                      </button>
                    </div>
                    {!members.length ? (
                      <Empty>
                        还没有家庭成员。先添加家人，再绑定血压计的用户档位。
                      </Empty>
                    ) : (
                      <div className="member-cards">
                        {members.map((m, i) => (
                          <button
                            className="member-card"
                            key={m.id}
                            onClick={() => {
                              setMember(m.id);
                              setUnassigned(false);
                              setTab("data");
                              setPage(1);
                            }}
                          >
                            <div className={"avatar a" + (i % 3)}>
                              {m.name.slice(0, 1)}
                            </div>
                            <div>
                              <strong>{m.name}</strong>
                              <small>
                                {latest[m.id]
                                  ? `${latest[m.id].systolic}/${latest[m.id].diastolic} mmHg · 脉搏 ${latest[m.id].pulse}`
                                  : m.notes || "尚无测量记录"}
                              </small>
                              {latest[m.id] && (
                                <small>{date(latest[m.id].measured_at)}</small>
                              )}
                            </div>
                            <span className="arrow">↗</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                )}
                <section className="panel">
                  <div className="section-title">
                    <div>
                      <h2>血压与脉搏趋势</h2>
                      <p>血压 mmHg · 脉搏 次/分 · 上海时间</p>
                    </div>
                    <span className="badge">
                      {group === "day"
                        ? "每日"
                        : group === "week"
                          ? "每周"
                          : "每月"}
                      均值
                    </span>
                  </div>
                  {stats.buckets?.length ? (
                    <Chart buckets={stats.buckets} />
                  ) : (
                    <Empty>此时间范围内还没有测量数据</Empty>
                  )}
                </section>
                <section className="panel">
                  <div className="section-title">
                    <div>
                      <h2>测量记录</h2>
                      <p>共 {total} 条 · 保留设备原始记录</p>
                    </div>
                    <a
                      className="button secondary"
                      href={"/api/v1/measurements/export.csv?" + query()}
                    >
                      导出 CSV
                    </a>
                  </div>
                  <div className="filters">
                    <label>
                      来源设备
                      <select
                        value={device}
                        onChange={(e) => {
                          setDevice(e.target.value);
                          setPage(1);
                        }}
                      >
                        <option value="">全部设备</option>
                        {devices.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={unassigned}
                        onChange={(e) => {
                          setUnassigned(e.target.checked);
                          if (e.target.checked) {
                            setPeriod("all");
                            setMember("");
                          }
                          setPage(1);
                        }}
                      />
                      仅待归属记录
                    </label>
                  </div>
                  {measurements.length ? (
                    <>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>测量时间</th>
                              <th>成员 / 档位</th>
                              <th>
                                血压 <small>mmHg</small>
                              </th>
                              <th>脉搏</th>
                              <th>设备 / 备注</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {measurements.map((r) => (
                              <tr key={r.id}>
                                <td>
                                  {r.time_valid === false ? (
                                    <span className="warning">
                                      设备时间无效
                                    </span>
                                  ) : (
                                    date(r.measured_at)
                                  )}
                                  <small>收到于 {date(r.received_at)}</small>
                                </td>
                                <td>
                                  {r.member_name ||
                                    members.find((m) => m.id === r.member_id)
                                      ?.name || (
                                      <span className="warning">待归属</span>
                                    )}
                                  <small>用户 {r.user_slot}</small>
                                </td>
                                <td className="bp">
                                  {r.systolic} <span>/</span> {r.diastolic}
                                </td>
                                <td>{r.pulse}</td>
                                <td>
                                  {r.device_name ||
                                    devices.find((d) => d.id === r.device_id)
                                      ?.name ||
                                    r.device_id}
                                  <small>{r.notes || "—"}</small>
                                </td>
                                <td>
                                  <button
                                    className="link"
                                    onClick={() => setEditing(r)}
                                  >
                                    编辑
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="pagination">
                        <button
                          className="secondary"
                          disabled={page === 1}
                          onClick={() => setPage((x) => x - 1)}
                        >
                          上一页
                        </button>
                        <span>第 {page} 页</span>
                        <button
                          className="secondary"
                          disabled={page * 50 >= total}
                          onClick={() => setPage((x) => x + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    </>
                  ) : (
                    <Empty>暂无符合条件的记录</Empty>
                  )}
                </section>
                {tab === "overview" && (
                  <section className="panel">
                    <div className="section-title">
                      <h2>采集网络</h2>
                      <button
                        className="link"
                        onClick={() => setTab("devices")}
                      >
                        管理采集端 →
                      </button>
                    </div>
                    {!collectors.length ? (
                      <Empty>等待采集端连接 MQTT 后自动出现</Empty>
                    ) : (
                      collectors.map((c) => (
                        <div className="network-row" key={c.id}>
                          <span
                            className={"dot " + (!c.online ? "offline" : "")}
                          />
                          <strong>{c.name || c.id}</strong>
                          <span>{c.location || "未设置位置"}</span>
                          <span>{c.online ? "在线" : "离线"}</span>
                          <small>最近连接 {date(c.last_seen)}</small>
                        </div>
                      ))
                    )}
                  </section>
                )}
              </>
            )}
            {tab === "body" && <BodyMeasurements members={members} devices={devices} refresh={refresh} api={api} action={action} busy={busy}/>}
            {tab === "members" && <HealthProfiles members={members} refresh={refresh} api={api} action={action} busy={busy}/>}
            {tab === "settings" && <><section className="panel"><h2>数据重置</h2><p>先预览影响范围，再确认执行。不会删除血压计自身记录、固件库、已有备份和导出文件。</p><div className="actions"><ResetAction api={api} action={action} busy={busy} type="system_reset" scope="measurements" label="清空健康数据" /><ResetAction api={api} action={action} busy={busy} type="system_reset" scope="all" label="完整重置 Eir" /></div></section><Operations operations={operations} /></>}
            {tab === "devices" && (
              <>
                <Discovered rows={discovered} api={api} action={action} busy={busy} />
                <Operations operations={operations} />
                <section>
                  <div className="section-title">
                    <h2>采集端</h2>
                    <span className="badge">
                      {collectors.filter((c) => c.online).length} 在线 /{" "}
                      {collectors.length} 台
                    </span>
                  </div>
                  {!collectors.length ? (
                    <Empty>
                      暂无已绑定采集端。请先在上方待添加列表中添加设备。
                    </Empty>
                  ) : (
                    <div className="cards">
                      {collectors.map((c) => (
                        <section className="panel" key={c.id}>
                          <div className="section-title">
                            <h2>{c.name || c.id}</h2>
                            <span
                              className={"badge " + (!c.online ? "muted" : "")}
                            >
                              {c.online ? "在线" : "离线"}
                            </span>
                          </div>
                          <code>{c.id}</code>
                          <form
                            onSubmit={(e) => {
                              const d = form(e);
                              action(() => api("collectors/" + c.id, "PUT", d));
                            }}
                          >
                            <div className="form-grid">
                              <label>
                                名称
                                <input
                                  name="name"
                                  defaultValue={c.name || ""}
                                  required
                                />
                              </label>
                              <label>
                                位置
                                <input
                                  name="location"
                                  defaultValue={c.location || ""}
                                  placeholder="例如 客厅"
                                />
                              </label>
                            </div>
                            <button disabled={busy}>保存信息</button>
                          </form>
                          <dl>
                            <dt>固件</dt>
                            <dd>
                              {c.status?.firmware ||
                                c.status?.firmware_version ||
                                c.status?.version ||
                                "—"}
                            </dd>
                            <dt>待上传</dt>
                            <dd>
                              {c.status?.queue_depth ??
                                c.status?.pending_count ??
                                "—"}
                            </dd>
                            <dt>Wi-Fi 信号</dt>
                            <dd>
                              {c.status?.rssi ?? c.status?.wifi_rssi ?? "—"} dBm
                            </dd>
                            <dt>体脂秤容量</dt><dd>{c.status?.capabilities?.max_scales ? `${devices.filter(d=>d.collector_id===c.id&&d.profile===scaleProfile).length} / ${c.status.capabilities.max_scales} 台` : "请升级固件后接入"}</dd>
                            <dt>最近在线</dt>
                            <dd>{date(c.last_seen)}</dd>
                            <dt>最近错误</dt>
                            <dd>
                              {c.status?.error || c.status?.last_error || "无"}
                            </dd>
                          </dl>
                          <div className="actions">
                            <button
                              disabled={busy || !c.online}
                              onClick={() => command(c.id, "scan")}
                            >
                              扫描蓝牙设备
                            </button>
                            {safeDebugURL(c.status) && (
                              <a
                                className="button secondary"
                                href={safeDebugURL(c.status)}
                                target="_blank"
                                rel="noreferrer"
                              >
                                本机调试 ↗
                              </a>
                            )}
                          </div>
                          <CollectorActions collector={c} api={api} action={action} busy={busy} />
                        </section>
                      ))}
                    </div>
                  )}
                </section>
                <section className="panel">
                  <h2>添加测量设备</h2>
                  <p>
                    先在设备附近的采集端执行扫描，从下方事件中核对 BLE
                    地址。每台设备只分配给一个采集端。
                  </p>
                  <form
                    className="form-grid"
                    onSubmit={(e) => {
                      const d = form(e);
                      const f = e.currentTarget;
                      action(async () => {
                        await api("devices", "POST", {
                          ...d,
                          address_type: Number(d.address_type),
                          model: scanProfile===scaleProfile?"AFU-WL-TZ-A1":"HEM-7374T1",
                          profile: scanProfile,
                          hardware_id: scanProfile===scaleProfile?scanHardware:"",
                        });
                        f.reset();
                      });
                    }}
                  >
                    <label>
                      名称
                      <input name="name" required placeholder="客厅测量设备" />
                    </label>
                    <label>
                      采集端
                      <select
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
                      </select>
                    </label>
                    <label>设备类型<select value={scanProfile} onChange={e=>{setScanProfile(e.target.value);setScanHardware("")}}><option value="omron-hem-7374t1">欧姆龙 HEM-7374T1</option><option value={scaleProfile}>阿福 AFU-WL-TZ-A1</option></select></label>
                    <label>
                      BLE 地址
                      <input
                        name="address"
                        required
                        value={scanAddress}
                        onChange={(e) => setScanAddress(e.target.value)}
                        pattern="[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}"
                        placeholder="AA:BB:CC:DD:EE:FF"
                      />
                    </label>
                    <label>
                      地址类型
                      <select
                        name="address_type"
                        value={scanAddressType}
                        onChange={(e) => setScanAddressType(e.target.value)}
                      >
                        <option value="0">Public (0)</option>
                        <option value="1">Random (1)</option>
                      </select>
                    </label>
                    {scanProfile===scaleProfile&&<label>秤的设备身份<input required value={scanHardware} onChange={e=>setScanHardware(e.target.value)} pattern="[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}" placeholder="从扫描结果自动填入"/><small>同名秤通过设备身份区分。每块采集端最多 2 台秤。</small></label>}
                    <button disabled={busy}>添加测量设备</button>
                  </form>
                </section>
                <div className="cards">
                  {devices.map((d) => (
                    <section className="panel" key={d.id}>
                      <div className="section-title">
                        <h2>{d.name}</h2>
                        <span className="badge">{d.model}</span>
                      </div>
                      <p>
                        {d.profile===scaleProfile?"唤醒体脂秤即可连接；每台秤在下方绑定一位家庭成员。":"配对前请在血压计上长按蓝牙按键进入配对模式。配对会注册此采集端；正常读取不修改设置。"}
                      </p>
                      <p>
                        {d.address} ·{" "}
                        {collectors.find((c) => c.id === d.collector_id)
                          ?.name || d.collector_id}
                      </p>
                      {d.profile!==scaleProfile && <>
                      <div className="actions">
                        <button
                          disabled={busy || !collectors.find(c => c.id === d.collector_id)?.online}
                          onClick={() => command(d.collector_id, "pair", d.id)}
                        >
                          配对 / 重新配对
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || !collectors.find(c => c.id === d.collector_id)?.online}
                          onClick={() => command(d.collector_id, "read", d.id)}
                        >
                          诊断读取
                        </button>
                        <button
                          className="secondary"
                          disabled={busy || !collectors.find(c => c.id === d.collector_id)?.online}
                          onClick={() =>
                            command(d.collector_id, "backfill", d.id)
                          }
                        >
                          补采遗漏记录
                        </button>
                      </div>
                      </>}
                      {d.profile===scaleProfile && <>{d.lifecycle_state!=="active"&&d.collector_id&&<button disabled={busy||!collectors.find(c=>c.id===d.collector_id)?.online} onClick={()=>command(d.collector_id,"pair",d.id)}>重试接入验证</button>}<label>体脂估算通道<select value={d.adc_index} disabled={busy} onChange={e=>action(()=>api("devices/"+d.id,"PATCH",{adc_index:Number(e.target.value)}),"计算通道已保存，仅影响新测量")}><option value="0">ADC 1（默认）</option><option value="1">ADC 2</option></select></label><p>所属成员：{bindings.find(b=>b.device_id===d.id&&!b.effective_to)?.member_name||"待绑定"} · {collectors.find(c=>c.id===d.collector_id)?.status?.devices?.find((v:Row)=>v.id===d.id)?.connected?"蓝牙已连接":"等待秤唤醒"}</p></>}
                      <DeviceActions device={d} collectors={collectors} api={api} action={action} busy={busy} />
                    </section>
                  ))}
                </div>
                <section className="panel">
                  <h2>绑定设备用户</h2>
                  <p>
                    首次绑定认领未归属历史；换绑按生效时间划分，补采记录仍按测量时间归属。
                  </p>
                  <form
                    className="form-grid"
                    onSubmit={(e) => {
                      const d = form(e);
                      action(() =>
                        api("bindings", "POST", {
                          device_id: d.device_id,
                          user_slot: devices.find(v=>v.id===d.device_id)?.profile===scaleProfile?0:Number(d.user_slot),
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
                    <label>
                      设备
                      <select
                        name="device_id"
                        required
                        value={bindingDevice}
                        onChange={(e) => setBindingDevice(e.target.value)}
                      >
                        <option value="">请选择</option>
                        {devices.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {devices.find(d=>d.id===bindingDevice)?.profile!==scaleProfile && <label>
                      用户档位
                      <select
                        name="user_slot"
                        value={slot}
                        onChange={(e) => setSlot(e.target.value)}
                      >
                        <option value="1">用户 1</option>
                        <option value="2">用户 2</option>
                      </select>
                    </label>
                    }
                    <label>
                      家庭成员
                      <select name="member_id" required>
                        <option value="">请选择</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      生效时间（上海时间）
                      <input type="datetime-local" name="effective_from" />
                      <small>留空：首次认领历史，换绑从现在生效</small>
                    </label>
                    <label className="check">
                      <input
                        type="checkbox"
                        name="claim_history"
                        defaultChecked
                      />
                      首次绑定认领历史{" "}
                      {preview !== null && `（${preview} 条待归属）`}
                    </label>
                    <button disabled={busy}>保存绑定</button>
                  </form>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>设备</th>
                          <th>用户</th>
                          <th>成员</th>
                          <th>生效时间</th>
                          <th>结束时间</th><th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bindings.map((b) => (
                          <tr key={b.id}>
                            <td>
                              {devices.find((d) => d.id === b.device_id)
                                ?.name || b.device_id}
                            </td>
                            <td>{b.user_slot===0?"整台体脂秤":b.user_slot}</td>
                            <td>
                              {members.find((m) => m.id === b.member_id)
                                ?.name || b.member_id}
                            </td>
                            <td>
                              {!isHistoryStart(b.effective_from)
                                ? date(b.effective_from)
                                : "全部历史"}
                            </td>
                            <td>
                              {b.effective_to
                                ? date(b.effective_to)
                                : "当前绑定"}
                            </td><td>{!b.effective_to && <ConfirmAction action={action} busy={busy} label="解绑成员" message="成员绑定已结束，历史归属保留" description="结束当前用户档位的成员绑定。已有记录归属保留，后续测量进入待归属列表。" run={() => api(`bindings/${encodeURIComponent(b.id)}/unbind`, "POST", {})} />}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="panel">
                  <h2>上报拒绝记录</h2>
                  {!rejections.length ? (
                    <p>没有被拒绝的上报记录。</p>
                  ) : (
                    rejections.map((r) => (
                      <details key={r.id}>
                        <summary>
                          {date(r.created_at)} · {r.collector_id} · {r.reason}
                        </summary>
                        <pre>{r.payload}</pre>
                      </details>
                    ))
                  )}
                </section>
                <section className="panel">
                  <h2>设备事件与扫描结果</h2>
                  {!events.length ? (
                    <Empty>暂无设备事件</Empty>
                  ) : (
                    events.slice(0, 50).map((e) => (
                      <details key={e.id}>
                        <summary>
                          {date(e.created_at)} · {e.collector_id} ·{" "}
                          {e.type || e.event_type} · {e.status || ""}
                        </summary>
                        {e.error && <p className="warning">{e.error}</p>}
                        {Array.isArray(e.data?.devices) &&
                          e.data.devices.map((found: Row) => (
                            <div className="network-row" key={found.address}>
                              <strong>{found.name || "未知设备"}</strong>
                              <span>
                                {found.address} · {found.rssi} dBm
                              </span>
                              <button
                                className="secondary"
                                onClick={() => {
                                  setScanAddress(found.address || "");
                                  setScanProfile(found.profile||"omron-hem-7374t1");
                                  setScanHardware(found.hardware_id||"");
                                  setScanCollector(e.collector_id);
                                  setScanAddressType(
                                    String(found.address_type ?? 0),
                                  );
                                  setNotice(
                                    "已填入添加测量设备表单，请核对名称并添加",
                                  );
                                }}
                              >
                                选择设备
                              </button>
                            </div>
                          ))}
                        <pre>{JSON.stringify(e.data ?? e, null, 2)}</pre>
                      </details>
                    ))
                  )}
                </section>
              </>
            )}
            {tab === "firmware" && (
              <>
                <section className="panel">
                  <h2>上传固件</h2>
                  <p>
                    选择为 ESP32-C3 构建的应用固件
                    .bin。服务端校验芯片和分区兼容性后才可升级。
                  </p>
                  <form
                    className="form-grid"
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
                    <label>
                      版本
                      <input name="version" required placeholder="例如 0.1.0" />
                    </label>
                    <label>
                      固件文件
                      <input name="file" type="file" accept=".bin" required />
                    </label>
                    <button disabled={busy}>上传固件</button>
                  </form>
                </section>
                <section className="panel">
                  <h2>远程升级</h2>
                  <form
                    className="form-grid"
                    onSubmit={(e) => {
                      const d = form(e);
                      action(
                        () => api("ota-jobs", "POST", d),
                        "升级任务已创建，状态将在下方更新",
                      );
                    }}
                  >
                    <label>
                      在线采集端
                      <select name="collector_id" required>
                        <option value="">请选择</option>
                        {collectors
                          .filter((c) => c.online)
                          .map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name || c.id}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      固件版本
                      <select name="firmware_id" required>
                        <option value="">请选择</option>
                        {firmwares.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.version} · {Math.round(f.size / 1024)} KB
                          </option>
                        ))}
                      </select>
                    </label>
                    <button disabled={busy}>开始升级</button>
                  </form>
                </section>
                <section className="panel">
                  <h2>升级任务</h2>
                  {!jobs.length ? (
                    <Empty>暂无升级任务</Empty>
                  ) : (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>采集端</th>
                            <th>版本</th>
                            <th>状态</th>
                            <th>创建时间</th>
                            <th>错误</th>
                          </tr>
                        </thead>
                        <tbody>
                          {jobs.map((j) => (
                            <tr key={j.id}>
                              <td>
                                {collectors.find((c) => c.id === j.collector_id)
                                  ?.name || j.collector_id}
                              </td>
                              <td>{j.version}</td>
                              <td>
                                <span className="badge">
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
                                </span>
                              </td>
                              <td>{date(j.created_at)}</td>
                              <td>{j.error || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
                <section className="panel">
                  <h2>固件库</h2>
                  {!firmwares.length ? (
                    <Empty>上传首个固件以开始</Empty>
                  ) : (
                    firmwares.map((f) => (
                      <details key={f.id}>
                        <summary>
                          {f.version} · {f.chip} · {Math.round(f.size / 1024)}{" "}
                          KB
                        </summary>
                        <p>分区：{f.partition_layout}</p>
                        <code className="hash">SHA-256: {f.sha256}</code>
                      </details>
                    ))
                  )}
                </section>
              </>
            )}
          </>
        )}
        <footer>
          Eir · 家庭健康管理 <span>所有时间以 Asia/Shanghai 显示</span>
        </footer>
      </main>
      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <section
            className="modal panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-title">
              <h2 id="edit-title">编辑测量记录</h2>
              <button
                className="secondary"
                aria-label="关闭"
                onClick={() => setEditing(null)}
              >
                ×
              </button>
            </div>
            <p>
              {editing.systolic}/{editing.diastolic} mmHg · 脉搏 {editing.pulse}{" "}
              · {date(editing.measured_at)}
            </p>
            <form
              onSubmit={(e) => {
                const d = form(e);
                action(async () => {
                  await api("measurements/" + editing.id, "PATCH", {
                    ...measurementCorrection(
                      editing.member_id,
                      d.member_id,
                      d.notes,
                    ),
                  });
                  setEditing(null);
                });
              }}
            >
              <label>
                所属成员
                <select name="member_id" defaultValue={editing.member_id || ""}>
                  <option value="">待归属</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                备注
                <textarea
                  name="notes"
                  defaultValue={editing.notes || ""}
                  rows={3}
                />
              </label>
              <p>修改会保留记录，不会改变原始测量值。</p>
              <button disabled={busy}>保存更正</button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
function safeDebugURL(s: Row | undefined) {
  if (!s) return undefined;
  try {
    const u = new URL(s.debug_url || (s.ip ? `http://${s.ip}` : ""));
    if (["http:", "https:"].includes(u.protocol)) return u.href;
  } catch {}
  return undefined;
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
