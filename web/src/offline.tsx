import { useEffect, useState } from "react";
import { TimeSeriesChart } from "./components/TimeSeriesChart";
import { Link, useLocation } from "react-router";
import { registerSW } from "virtual:pwa-register";
import { api, date } from "./api";
import type { Row } from "./api";
import { metricNames } from "./healthDomain";
import { Button } from "./components/ui/button";
import { useRealtime } from "./realtime";

type Snapshot = {
  instance_id: string;
  data_epoch: string;
  synced_at: string;
  window_start: string;
  members: Row[];
  observations: Row[];
};
function offlineEnabled() {
  try {
    return localStorage.getItem("eir-offline-enabled") === "true";
  } catch {
    return false;
  }
}
async function storage(value?: Snapshot | null): Promise<Snapshot | null> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("eir-offline", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("snapshot");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      if (value && !offlineEnabled()) {
        db.close();
        resolve(null);
        return;
      }
      const tx = db.transaction(
        "snapshot",
        value === undefined ? "readonly" : "readwrite",
      );
      const store = tx.objectStore("snapshot");
      const req =
        value === undefined
          ? store.get("current")
          : value === null
            ? store.delete("current")
            : store.put(value, "current");
      let result: Snapshot | null = null;
      req.onsuccess = () => {
        result = value === undefined ? (req.result ?? null) : value;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
        if (value !== undefined)
          window.dispatchEvent(new Event("eir-offline-updated"));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}
export function OfflineControls({ settings }: { settings: boolean }) {
  const [enabled, setEnabled] = useState(() => offlineEnabled());
  const [message, setMessage] = useState("");
  const [update, setUpdate] = useState(false);
  const [refresh, setRefresh] = useState<() => void>(() => () => {});
  const { version } = useRealtime();
  const [refreshTick, setRefreshTick] = useState(0);
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
      if (!navigator.onLine || document.visibilityState === "hidden" || !("serviceWorker" in navigator)) return;
      void navigator.serviceWorker.getRegistration().then(registration => registration?.update()).catch(() => {});
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
    if (!enabled) return;
    let alive = true;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api("offline/snapshot", "GET", undefined, controller.signal)
        .then(async (value) => {
          if (!alive) return;
          if (!offlineEnabled()) return;
          await storage(value);
          if (alive) setMessage("最近同步：" + date(value.synced_at));
        })
        .catch(() => {
          if (alive) setMessage("同步失败或本机存储不可用，保留上次完整数据");
        });
    }, 1000);
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled, version, refreshTick]);
  const change = async () => {
    const next = !enabled;
    localStorage.setItem("eir-offline-enabled", String(next));
    setEnabled(next);
    if (!next) {
      await storage(null);
      setMessage("本机离线数据已清除");
    }
  };
  return (
    <>
      <div hidden={!settings} className="rounded-xl border p-4 space-y-3">
        <p>iPhone：在 Safari 分享菜单中选择“添加到主屏幕”。</p>
        <p>
          离线保存全家最近 90
          天的指标，不保存医疗文件。设备上的其他使用者也能查看。
        </p>
        <Button
          onClick={() =>
            void change().catch(() => setMessage("本机存储不可用"))
          }
        >
          {enabled ? "关闭并清除离线数据" : "开启离线保存"}
        </Button>{" "}
        <Link to="/offline">查看离线数据</Link>{" "}
        {enabled && (
          <Button onClick={() => setRefreshTick((v) => v + 1)}>立即同步</Button>
        )}
        <p role="status">{message}</p>
      </div>
      {update && <Button onClick={refresh}>新版本可用，刷新应用</Button>}
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
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <h2>离线数据 · 只读</h2>
      <p>
        {error ||
          (!snapshot
            ? "尚无离线数据，请联网后在系统管理开启保存。"
            : "截至 " +
              date(snapshot.synced_at) +
              "，仅包含同步时最近 90 天的数据。")}
      </p>
      {focus && (
        <p role="status">
          {snapshot?.observations.some((r) => r.source_record_id === focus)
            ? "通知测量已包含在以下本机记录中"
            : "通知中的测量尚未同步到本机，请连接服务后查看。"}
        </p>
      )}
      <Link to="/settings">离线设置</Link> <Link to="/">返回在线首页</Link>
      <div className="flex flex-wrap gap-3">
        <select
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
        </select>
        <select
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
        </select>
      </div>
      <div className="flex flex-wrap gap-3">
        <label>
          开始{" "}
          <input
            type="date"
            value={from}
            min={snapshot?.window_start.slice(0, 10)}
            max={snapshot?.synced_at.slice(0, 10)}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束{" "}
          <input
            type="date"
            value={to}
            min={from || snapshot?.window_start.slice(0, 10)}
            max={snapshot?.synced_at.slice(0, 10)}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
      </div>
      {Object.keys(metricNames)
        .filter((k) => !kind || kind === k)
        .map((k) => {
          const points = rows.filter((r) => r.kind === k);
          if (!points.length) return null;
          return (
            <div key={k}>
              <h3>{metricNames[k]}</h3>
              {member && (
                <p>
                  缓存中最新：{points[0].value}
                  {points[0].value_secondary != null
                    ? "/" + points[0].value_secondary
                    : ""}{" "}
                  {points[0].unit}
                </p>
              )}
              <TimeSeriesChart
                label={metricNames[k]}
                unit={points[0].unit}
                series={(snapshot?.members ?? [])
                  .filter((m) => !member || m.id === member)
                  .flatMap((m) => {
                    const values = points
                      .filter((r) => r.member_id === m.id)
                      .sort(
                        (a, b) =>
                          Date.parse(a.measured_at) - Date.parse(b.measured_at),
                      );
                    return [
                      {
                        id: m.id,
                        name: m.name,
                        data: values.map(
                          (r) =>
                            [Date.parse(r.measured_at), Number(r.value)] as [
                              number,
                              number,
                            ],
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
            </div>
          );
        })}
      <div className="overflow-auto">
        <table className="w-full text-sm [&_td]:px-2 [&_td]:py-3 [&_th]:p-2 [&_tr]:border-b">
          <thead>
            <tr>
              <th>成员</th>
              <th>指标</th>
              <th>读数</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className={row.source_record_id === focus ? "bg-accent" : ""}
              >
                <td>
                  {snapshot?.members.find((m) => m.id === row.member_id)?.name}
                </td>
                <td>{metricNames[row.kind]}</td>
                <td>
                  {row.value}
                  {row.value_secondary != null
                    ? "/" + row.value_secondary
                    : ""}{" "}
                  {row.unit}
                  {row.estimated ? "（估算）" : ""}
                </td>
                <td>{date(row.measured_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
