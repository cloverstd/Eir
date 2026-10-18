export type Row = Record<string, any>;
export async function api(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch("/api/v1/" + path, {
    method,
    signal,
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
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = JSON.parse(text).error || text;
    } catch {
      /* Plain-text server errors are also supported. */
    }
    throw new Error(message || `请求失败 (${response.status})`);
  }
  return response.status === 204 ? null : response.json();
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
