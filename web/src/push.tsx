import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { Bell, BellRing, Send } from "lucide-react";
import type { Row } from "./api";
import { api, date } from "./api";
import { useAPI } from "./realtime";
import { CheckboxField } from "./components/forms";
import { Button } from "./components/ui/button";
import { Badge } from "./components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./components/ui/card";

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

  const statusText =
    config && !config.enabled ? "服务端尚未启用推送。" : message;

  return (
    <Card className="health-card gap-4 py-5">
      <CardHeader className="px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
              <Bell className="size-4" />
            </span>
            <div className="space-y-0.5">
              <CardTitle className="text-base">测量通知</CardTitle>
              <CardDescription className="text-xs">
                仅通知新设备测量，显示姓名和读数。每台手机独立选择关注成员。
              </CardDescription>
            </div>
          </div>
          <Badge
            variant={active ? "secondary" : "outline"}
            className={
              active
                ? "rounded-full bg-emerald-50 text-emerald-700"
                : "rounded-full text-muted-foreground"
            }
          >
            {active ? "已开启" : "未开启"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        <div className="flex flex-wrap gap-2.5">
          {members.map((m) => {
            const checked = selected.includes(m.id);
            return (
              <label
                key={m.id}
                className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors ${
                  checked
                    ? "border-primary/40 bg-primary/5 font-medium text-foreground"
                    : "border-border bg-muted/35 text-muted-foreground hover:bg-muted/60"
                }`}
              >
                <CheckboxField
                  checked={checked}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, m.id]
                        : old.filter((id) => id !== m.id),
                    )
                  }
                />
                <span>{m.name}</span>
              </label>
            );
          })}
          {!members.length && (
            <p className="text-xs text-muted-foreground">
              请先在「家庭成员」中添加成员后再订阅通知。
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!active ? (
            <Button
              size="sm"
              className="rounded-xl"
              disabled={busy || !config?.enabled}
              onClick={() => void run(enable)}
            >
              <BellRing className="size-3.5" />
              开启通知
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                className="rounded-xl"
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
                size="sm"
                variant="outline"
                className="rounded-xl"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await manage("POST", undefined, "/test");
                    setMessage("测试通知已发送");
                  })
                }
              >
                <Send className="size-3.5" />
                发送测试通知
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="rounded-xl text-destructive hover:text-destructive"
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
        {statusText && (
          <p
            role="status"
            className="rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            {statusText}
          </p>
        )}
      </CardContent>
    </Card>
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
    <Card
      className="health-card gap-2 border-blue-200/90 bg-blue-50/70 py-4"
      role="status"
    >
      <CardHeader className="flex flex-row items-center gap-2.5 px-4 sm:px-5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-blue-100 text-blue-600">
          <BellRing className="size-4" />
        </span>
        <CardTitle className="text-sm font-semibold text-blue-950">
          通知中的测量
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-sm text-blue-950 sm:px-5">
        {row ? (
          <p className="font-medium tabular-nums">
            {row.member_name} ·{" "}
            {row.kind === "body_composition"
              ? `${row.weight_kg} kg${row.body_fat_status === "estimated" ? ` · 估算体脂 ${row.body_fat_pct}%` : ""}`
              : `${row.systolic}/${row.diastolic} mmHg · ${row.pulse} bpm`}{" "}
            ·{" "}
            <span className="font-normal text-blue-800/80">
              {date(row.measured_at)}
            </span>
          </p>
        ) : (
          <p className="text-blue-900/80">
            {data.loading
              ? "正在读取…"
              : data.error
                ? "暂时无法连接服务"
                : "记录已删除或归属已调整"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
