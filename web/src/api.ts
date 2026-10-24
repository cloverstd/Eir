import {
  offlineEnabled,
  readSnapshot,
  localRead,
  cachedRead,
  cacheRead,
  removeCached,
  snapshotRoute,
} from "./offlineData";
let offline = false;
export function isOffline() {
  return offline;
}
export function connectionState(value: boolean) {
  if (offline !== value) {
    offline = value;
    window.dispatchEvent(new Event("eir-connection-changed"));
  }
}
export async function networkRead(path: string, signal?: AbortSignal) {
  return api(path, "GET", undefined, signal, true);
}
export type Row = Record<string, any>;
export async function api(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
  networkOnly = false,
) {
  if (method !== "GET" && (offline || !navigator.onLine))
    throw new Error("当前离线，仅可查看本机数据；请联网后再保存或操作设备");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer =
    method === "GET"
      ? setTimeout(() => controller.abort(), networkOnly ? 15000 : 5000)
      : undefined;
  let response: Response;
  try {
    if (!navigator.onLine || (offline && !networkOnly && method === "GET"))
      throw new TypeError("offline");
    response = await fetch("/api/v1/" + path, {
      method,
      signal: controller.signal,
      headers:
        body && !(body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : undefined,
      body:
        body instanceof FormData
          ? body
          : body === undefined
            ? undefined
            : JSON.stringify(body),
    });
    if (response.status >= 500) throw new TypeError("server unavailable");
  } catch (error) {
    if (signal?.aborted) throw error;
    connectionState(true);
    if (method !== "GET" || networkOnly || !offlineEnabled())
      throw new Error("无法连接服务，且没有可用的离线读取");
    const snapshot = await readSnapshot().catch(() => null);
    if (snapshot && snapshotRoute(path, snapshot))
      return localRead(path, snapshot);
    if (/^(measurements|health\/(observations|statistics))/.test(path))
      throw new Error(
        "本机尚未同步这项数据，请联网后同步；离线范围为最近 90 天",
      );
    return cachedRead(path);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch {
      /* Plain-text server errors are also supported. */
    }
    if (method === "GET") void removeCached(path).catch(() => {});
    throw new Error(message || `请求失败 (${response.status})`);
  }
  if (path === "offline/snapshot") connectionState(false);
  const value = response.status === 204 ? null : await response.json();
  if (
    method === "GET" &&
    !networkOnly &&
    !/^(offline\/|push\/|measurements|health\/(observations|statistics)|documents\/.*\/(text|download|pages))/.test(
      path,
    )
  ) {
    void cacheRead(path, value).catch(() => {});
  }
  if (method !== "GET") window.dispatchEvent(new Event("eir-data-written"));
  return value;
}
export const date = (value: unknown) =>
  value != null && value !== ""
    ? new Date(
        typeof value === "number" ? value : String(value),
      ).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "时间未校准";
export const number = (value: unknown, digits = 1) =>
  value == null
    ? "—"
    : Number(value).toLocaleString("zh-CN", { maximumFractionDigits: digits });
