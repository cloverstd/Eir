/** API boundaries use Shanghai calendar days regardless of the browser's timezone. */
export interface MeasurementFilters {
  kind?: string;
  member: string;
  device: string;
  unassigned: boolean;
  period: string;
  from: string;
  to: string;
  group: string;
  page: number;
}
export function measurementQuery(
  filters: MeasurementFilters,
  now = Date.now(),
): string {
  const { member, device, unassigned, period, from, to, group, page } = filters;
  const q = new URLSearchParams({
    kind: filters.kind || "blood_pressure",
    page: String(page),
    page_size: "50",
    group,
  });
  if (member) q.set("member_id", member);
  if (device) q.set("device_id", device);
  if (unassigned) q.set("unassigned", "true");
  if (period !== "custom" && period !== "all")
    q.set("from", new Date(now - Number(period) * 86400000).toISOString());
  else if (period === "custom") {
    if (from) q.set("from", new Date(from + "T00:00:00+08:00").toISOString());
    if (to)
      q.set(
        "to",
        new Date(
          new Date(to + "T00:00:00+08:00").getTime() + 86400000,
        ).toISOString(),
      );
  }
  return q.toString();
}
export function chartDay(value: string): string {
  return new Date(value).toLocaleDateString("sv-SE", {
    timeZone: "Asia/Shanghai",
  });
}
/** Omitting member_id keeps automatic assignment enabled when only notes change. */
export function measurementCorrection(
  previousMember: string | null | undefined,
  nextMember: string,
  notes: string,
) {
  return {
    ...(nextMember !== (previousMember || "")
      ? { member_id: nextMember || null }
      : {}),
    notes,
  };
}
/** PostgreSQL renders year-one sentinel with historical +08:05:43 offset. */
export function isHistoryStart(value: string | null | undefined): boolean {
  return !value || value.startsWith("0001-");
}
