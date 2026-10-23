import { rangeBounds } from "./dateDomain.ts";
import type { Row } from "./api";

// Overview curves need every original observation, independently of table paging.
export async function loadObservationSeries(
  query: string,
  read: (path: string) => Promise<{ items: Row[]; total: number }>,
) {
  const q = new URLSearchParams(query);
  q.delete("group");
  q.set("page_size", "200");
  const rows = new Map<string, Row>();
  for (let page = 1; page <= 100000; page++) {
    q.set("page", String(page));
    const result = await read("health/observations?" + q);
    if (!Number.isSafeInteger(result.total) || result.total < 0)
      throw new Error("历史数据分页异常，请稍后重试");
    const previousSize = rows.size;
    for (const row of result.items) rows.set(row.id, row);
    if (page * 200 >= result.total) return [...rows.values()];
    if (rows.size === previousSize)
      throw new Error("历史数据分页异常，请稍后重试");
  }
  throw new Error("历史数据过多，请缩小时间范围");
}

export const metricNames: Record<string, string> = {
  height: "身高",
  weight: "体重",
  body_fat: "体脂率",
  waist: "腰围",
  blood_pressure: "血压",
  heart_rate: "心率",
  blood_glucose: "血糖",
  oxygen_saturation: "血氧",
  temperature: "体温",
  bmi: "BMI",
};
export const historyNames: Record<string, string> = {
  condition: "既往疾病",
  surgery: "手术史",
  allergy: "过敏及反应",
  medication: "用药",
  family: "家族史",
};
export const documentNames: Record<string, string> = {
  report: "体检报告",
  lab: "化验单",
  prescription: "处方",
  imaging: "影像资料",
  other: "其他",
};
export function healthQuery(
  member: string,
  kind: string,
  page: number,
  from = "",
  to = "",
  group = "day",
  source = "",
  period = from || to ? "custom" : "all",
  now = Date.now(),
) {
  const q = new URLSearchParams({
    member_id: member,
    page: String(page),
    page_size: "50",
    group,
  });
  if (kind) q.set("kind", kind);
  if (source) q.set("source", source);
  const bounds = rangeBounds(period, from, to, now);
  if (bounds.from) q.set("from", bounds.from);
  if (bounds.to) q.set("to", bounds.to);
  return q.toString();
}
export function memberAge(
  member: Record<string, any>,
  now = new Date(),
): string {
  const birth = member.birth_date?.slice(0, 10) || member.birth_month;
  if (!birth) return "未填写出生信息";
  const parts = birth.split("-").map(Number),
    local = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  const get = (name: string) =>
    Number(local.find((p) => p.type === name)?.value);
  let age = get("year") - parts[0];
  if (
    get("month") < parts[1] ||
    (parts[2] && get("month") === parts[1] && get("day") < parts[2])
  )
    age--;
  return `${member.birth_date ? "" : "约 "}${age} 岁`;
}
