import type { Row } from "./api";
export type TimeRange = { from: number; to: number };
export type ChartSeries = {
  id: string;
  name: string;
  data: [number, number | null][];
  color?: string;
};
export type Reference = {
  label: string;
  source: string;
  url: string;
  band?: [number, number];
  lines?: { value: number; label: string }[];
};
export type Metric = "blood_pressure" | "pulse" | "weight" | "body_fat";
export function ageInShanghai(member: Row, now = new Date()) {
  const birth = (member.birth_date || member.birth_month || "").slice(0, 10);
  if (!birth) return null;
  const [year, month, day = 1] = birth.split("-").map(Number);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (key: string) =>
    Number(parts.find((p) => p.type === key)?.value);
  const age =
    part("year") -
    year -
    Number(
      part("month") < month || (part("month") === month && part("day") < day),
    );
  return Number.isFinite(age) && age >= 0 ? age : null;
}
export function referenceFor(
  metric: Metric,
  member: Row,
  now = new Date(),
): Reference | undefined {
  const age = ageInShanghai(member, now);
  if (age === null || age < 18) return;
  if (metric === "blood_pressure")
    return {
      label: "成人血压正常上界参考线",
      source: "American Heart Association",
      url: "https://www.heart.org/en/health-topics/high-blood-pressure/blood-pressure-explained",
      lines: [
        { value: 120, label: "收缩压参考 120" },
        { value: 80, label: "舒张压参考 80" },
      ],
    };
  if (metric === "pulse")
    return {
      label: "成人静息参考",
      source: "American Heart Association",
      url: "https://www.heart.org/en/health-topics/high-blood-pressure/the-facts-about-high-blood-pressure/all-about-heart-rate-pulse",
      band: [60, 100],
    };
  if (metric === "weight") {
    const height = Number(member.height_cm) / 100;
    if (!Number.isFinite(height) || height <= 0) return;
    return {
      label: "中国成人一般参考 · 18.5 ≤ BMI < 24",
      source: "国家卫生健康委员会",
      url: "https://www.nhc.gov.cn/ylyjs/zcwj/202412/75cb79c171c94def9e768193e65484f7/files/1736390749000_59785.pdf",
      band: [18.5 * height * height, 24 * height * height],
    };
  }
  if (age > 80 || !["male", "female"].includes(member.sex)) return;
  const index = age < 40 ? 0 : age < 60 ? 1 : 2;
  const bands: [number, number][] =
    member.sex === "male"
      ? [
          [8, 19.9],
          [11, 21.9],
          [13, 24.9],
        ]
      : [
          [21, 32.9],
          [23, 33.9],
          [24, 35.9],
        ];
  return {
    label: `成人体脂参考 · ${age < 40 ? "18–39" : age < 60 ? "40–59" : "60–80"} 岁 · ${member.sex === "male" ? "男" : "女"}${member.birth_date ? "" : " · 年龄近似"}`,
    source: "Omron BF511 成人分级",
    url: "https://www.omron-healthcare.com/storage/files/manuals/hbf-511_b_t/5322544-0i_web_im-hbf-511-e-en-09-09-2022.pdf",
    band: bands[index],
  };
}
export function metricSeries(rows: Row[], metric: Metric): ChartSeries[] {
  const keys =
    metric === "blood_pressure"
      ? [
          ["systolic", "收缩压"],
          ["diastolic", "舒张压"],
        ]
      : metric === "pulse"
        ? [["pulse", "脉搏"]]
        : metric === "weight"
          ? [["weight_kg", "体重"]]
          : [["body_fat_pct", "估算体脂率"]];
  const kind =
    metric === "blood_pressure" || metric === "pulse"
      ? "blood_pressure"
      : "body_composition";
  const points = rows
    .filter(
      (row) =>
        row.kind === kind &&
        row.measured_at &&
        Number.isFinite(Date.parse(row.measured_at)),
    )
    .sort(
      (a, b) =>
        Date.parse(a.measured_at) - Date.parse(b.measured_at) ||
        String(a.id).localeCompare(String(b.id)),
    );
  return keys.map(([key, name]) => ({
    id: key,
    name,
    data: points.map((row) => [
      Date.parse(row.measured_at),
      row.weight_valid === false ||
      (metric === "body_fat" && row.body_fat_status !== "estimated") ||
      row[key] == null
        ? null
        : Number(row[key]),
    ]),
  }));
}
export function zoomRange(from: string, to: string): TimeRange | undefined {
  const a = Date.parse(from),
    b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) && b > a
    ? { from: a, to: b }
    : undefined;
}
export function applyZoom(query: string, range?: TimeRange) {
  const q = new URLSearchParams(query);
  if (!range) return q.toString();
  const start = q.has("from")
    ? Math.max(Date.parse(q.get("from")!), range.from)
    : range.from;
  const end = q.has("to")
    ? Math.min(Date.parse(q.get("to")!), range.to + 1)
    : range.to + 1;
  q.set("from", new Date(start).toISOString());
  q.set("to", new Date(Math.max(start + 1, end)).toISOString());
  return q.toString();
}
export async function loadSeries(
  query: string,
  read: (
    path: string,
  ) => Promise<{ items: Row[]; next_cursor?: string | null }>,
) {
  const q = new URLSearchParams(query);
  q.delete("page");
  q.delete("page_size");
  q.delete("group");
  const rows = new Map<string, Row>(),
    cursors = new Set<string>();
  while (true) {
    const result = await read("measurements/series?" + q);
    for (const row of result.items) rows.set(row.id, row);
    if (!result.next_cursor) return [...rows.values()];
    if (cursors.has(result.next_cursor))
      throw new Error("历史数据分页异常，请稍后重试");
    cursors.add(result.next_cursor);
    q.set("cursor", result.next_cursor);
  }
}
