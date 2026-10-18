export const rangePresets = [
  { value: "30", label: "最近 30 天" },
  { value: "90", label: "最近 90 天" },
  { value: "180", label: "最近半年" },
  { value: "365", label: "最近 1 年" },
  { value: "all", label: "全部时间" },
];
export function shanghaiDay(value = Date.now()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}
// DayPicker works with calendar dates in the browser's timezone. These helpers
// preserve the selected YYYY-MM-DD rather than converting its local midnight.
export function calendarDate(value: string): Date | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return;
  const [year, month, day] = match.slice(1).map(Number);
  const result = new Date(year, month - 1, day);
  return result.getFullYear() === year &&
    result.getMonth() === month - 1 &&
    result.getDate() === day
    ? result
    : undefined;
}
export function calendarValue(value?: Date): string {
  return value
    ? `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
    : "";
}
export function monthsBefore(now: number, months: number): number {
  const shifted = new Date(now + 8 * 3600000);
  const day = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  const end = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate();
  shifted.setUTCDate(Math.min(day, end));
  return shifted.getTime() - 8 * 3600000;
}
export function rangeBounds(
  period: string,
  from: string,
  to: string,
  now = Date.now(),
): { from?: string; to?: string } {
  if (period === "all") return {};
  if (period === "custom")
    return {
      ...(calendarDate(from)
        ? { from: new Date(from + "T00:00:00+08:00").toISOString() }
        : {}),
      ...(calendarDate(to)
        ? {
            to: new Date(
              Date.parse(to + "T00:00:00+08:00") + 86400000,
            ).toISOString(),
          }
        : {}),
    };
  const start =
    period === "180"
      ? monthsBefore(now, 6)
      : period === "365"
        ? monthsBefore(now, 12)
        : now - Number(period) * 86400000;
  return Number.isFinite(start) ? { from: new Date(start).toISOString() } : {};
}
