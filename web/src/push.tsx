import { useEffect, useState } from "react";
import type { Row } from "./api";
import { api, date } from "./api";
import { useLocation } from "react-router";
import { useAPI } from "./realtime";
import { Button } from "./components/ui/button";
type Handle = { id: string; token: string };
function handle(): Handle | null {
  try {
    return JSON.parse(localStorage.getItem("eir-push") || "null");
  } catch {
    return null;
  }
}
async function manage(method: string, body?: unknown, suffix = "") {
  const h = handle();
  if (!h) throw Error("请先开启推送");
  const res = await fetch(`/api/v1/push/subscriptions/${h.id}${suffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${h.token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) {
    localStorage.removeItem("eir-push");
    throw Error("订阅已失效，请重新开启通知");
  }
  if (!res.ok) throw Error("订阅操作失败，请检查服务连接");
  return res.status === 204 ? null : res.json();
}
export function PushSettings({ members }: { members: Row[] }) {
  const [config, setConfig] = useState<{
      enabled: boolean;
      public_key: string;
    } | null>(null),
    [selected, setSelected] = useState<string[]>([]),
    [active, setActive] = useState(!!handle()),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api("push/config")
      .then(setConfig)
      .catch(() => setMessage("无法连接推送服务"));
    if (handle())
      void manage("GET")
        .then((x) => setSelected(x.member_ids))
        .catch((e) => {
          setActive(!!handle());
          setMessage(e.message);
        });
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setMessage(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const enable = async () => {
    if (!config?.enabled) throw Error("服务端尚未配置推送");
    if (!("PushManager" in window) || !("Notification" in window))
      throw Error(
        "iPhone 请先添加到主屏幕，再从主屏幕打开；需要 iOS 16.4 或更新版本",
      );
    if (!selected.length) throw Error("请至少选择一个成员");
    const permission = await Notification.requestPermission();
    if (permission !== "granted") throw Error("请在系统设置中允许 Eir 通知");
    const registration = await navigator.serviceWorker.ready;
    let sub = await registration.pushManager.getSubscription();
    if (sub && !handle()) {
      await sub.unsubscribe();
      sub = null;
    }
    const key = Uint8Array.from(
      atob(config.public_key.replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    sub ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    try {
      const h = await api("push/subscriptions", "POST", {
        subscription: sub.toJSON(),
        member_ids: selected,
      });
      localStorage.setItem("eir-push", JSON.stringify(h));
      setActive(true);
      setMessage("已开启，锁屏通知会显示姓名和具体读数");
    } catch (e) {
      await sub.unsubscribe();
      throw e;
    }
  };
  return (
    <section className="rounded-xl border p-4 space-y-3">
      <h2>测量通知</h2>
      <p>仅通知新设备测量，显示姓名和读数。每台手机独立选择关注成员。</p>
      <div className="flex flex-wrap gap-4">
        {members.map((m) => (
          <label key={m.id}>
            <input
              type="checkbox"
              checked={selected.includes(m.id)}
              onChange={(e) =>
                setSelected((old) =>
                  e.target.checked
                    ? [...old, m.id]
                    : old.filter((id) => id !== m.id),
                )
              }
            />{" "}
            {m.name}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        {!active ? (
          <Button
            disabled={busy || !config?.enabled}
            onClick={() => void run(enable)}
          >
            开启通知
          </Button>
        ) : (
          <>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await manage("PATCH", { member_ids: selected });
                  setMessage("关注成员已保存");
                })
              }
            >
              保存关注成员
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await manage("POST", undefined, "/test");
                  setMessage("测试通知已发送");
                })
              }
            >
              发送测试通知
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await manage("DELETE");
                  const registration = await navigator.serviceWorker.ready;
                  await (
                    await registration.pushManager.getSubscription()
                  )?.unsubscribe();
                  localStorage.removeItem("eir-push");
                  setActive(false);
                  setMessage("已关闭通知");
                })
              }
            >
              关闭通知
            </Button>
          </>
        )}
      </div>
      <p role="status">
        {config && !config.enabled ? "服务端尚未启用推送。" : message}
      </p>
    </section>
  );
}

export function FocusMeasurement() {
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const id = query.get("measurement_id");
  const member = query.get("member_id");
  const data = useAPI<{ items: Row[] }>(
    id && member
      ? `measurements?measurement_id=${encodeURIComponent(id)}&member_id=${encodeURIComponent(member)}&kind=${location.pathname === "/body" ? "body_composition" : "blood_pressure"}`
      : null,
    { items: [] },
  );
  if (!id || !member || !["/body", "/data"].includes(location.pathname))
    return null;
  const row = data.data.items[0];
  return (
    <section className="rounded-xl border border-primary p-4" role="status">
      <h2>通知中的测量</h2>
      {row ? (
        <p>
          {row.member_name} ·{" "}
          {row.kind === "body_composition"
            ? `${row.weight_kg} kg${row.body_fat_status === "estimated" ? ` · 估算体脂 ${row.body_fat_pct}%` : ""}`
            : `${row.systolic}/${row.diastolic} mmHg · ${row.pulse} bpm`}{" "}
          · {date(row.measured_at)}
        </p>
      ) : (
        <p>
          {data.loading
            ? "正在读取…"
            : data.error
              ? "暂时无法连接服务"
              : "记录已删除或归属已调整"}
        </p>
      )}
    </section>
  );
}
