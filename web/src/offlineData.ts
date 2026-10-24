import type { Row } from "./api";
export type Snapshot = {
  instance_id: string;
  data_epoch: string;
  synced_at: string;
  window_start: string;
  members: Row[];
  observations: Row[];
  measurements?: Row[];
  history?: Row[];
  documents?: Row[];
  metrics?: Row[];
  resources?: Record<string, unknown>;
};
export function offlineEnabled() {
  try {
    return localStorage.getItem("eir-offline-enabled") !== "false";
  } catch {
    return false;
  }
}
export async function offlineDB<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("eir-offline", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("snapshot");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      let tx: IDBTransaction;
      try {
        tx = db.transaction("snapshot", mode);
        const req = fn(tx.objectStore("snapshot"));
        let result: T;
        req.onsuccess = () => {
          result = req.result;
        };
        tx.oncomplete = () => {
          db.close();
          resolve(result);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      } catch (e) {
        db.close();
        reject(e);
      }
    };
  });
}
export async function readSnapshot(): Promise<Snapshot | null> {
  return (await offlineDB("readonly", (s) => s.get("current"))) ?? null;
}
export async function saveSnapshot(value: Snapshot | null) {
  if (value && !offlineEnabled()) return;
  await offlineDB("readwrite", (store) => {
    const request = store.get("current");
    request.addEventListener("success", () => {
      if (value && !offlineEnabled()) return;
      const old = request.result as Snapshot | undefined;
      if (
        !value ||
        (old &&
          (old.instance_id !== value.instance_id ||
            old.data_epoch !== value.data_epoch))
      )
        store.clear();
      if (value) store.put(value, "current");
    });
    return request;
  });
  window.dispatchEvent(new Event("eir-offline-updated"));
}
export function cacheKey(path: string) {
  const [name, query = ""] = path.split("?");
  const q = new URLSearchParams(query);
  q.sort();
  const queryString = q.toString();
  return name + (queryString ? "?" + queryString : "");
}
function cacheValue(value:unknown):unknown {
 if(Array.isArray(value))return value.map(cacheValue);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!['raw_hex','raw_data','raw_adcs','impedance_raw','payload','file_path'].includes(key)).map(([key,item])=>[key,cacheValue(item)]));
 return value;
}
export async function cacheRead(path: string, value: unknown) {
  if (!offlineEnabled()) return;
  await offlineDB<any>("readwrite", (s) =>
    offlineEnabled()
      ? s.put({ value:cacheValue(value), at: Date.now() }, "api:" + cacheKey(path))
      : s.get("current"),
  );
}
export async function cachedRead(path: string) {
  if (!offlineEnabled()) throw Error("离线保存未开启，请联网后在系统管理开启");
  const entry = await offlineDB<any>("readonly", (s) =>
    s.get("api:" + cacheKey(path)),
  );
  if (!entry || Date.now() - entry.at > 90 * 86400000)
    throw Error("本机尚未保存这项数据，请联网同步后查看");
  return entry.value;
}
export async function cachedPaths(): Promise<string[]> {
  const keys = await offlineDB("readonly", (s) => s.getAllKeys());
  return keys
    .filter((k) => typeof k === "string" && k.startsWith("api:"))
    .map((k) => String(k).slice(4));
}
export function localRead(path: string, s: Snapshot): unknown {
  const url = new URL(path, "https://offline.local/"),
    name = url.pathname.slice(1),
    q = url.searchParams;
  const page = Math.max(1, Number(q.get("page") || 1)),
    size = Math.min(200, Math.max(1, Number(q.get("page_size") || 50)));
  const paginate = (rows: Row[]) => ({
    items: rows.slice((page - 1) * size, page * size),
    total: rows.length,
    page,
    page_size: size,
  });
  const member = q.get("member_id"),
    kind = q.get("kind"),
    source = q.get("source");
  const filter = (rows: Row[], timed = true) =>
    rows.filter(
      (r) =>
        (!member || r.member_id === member) &&
        (!kind || (r.kind ?? r.category) === kind) &&
        (!source || r.source === source) &&
        (!timed ||
          ((!q.get("from") ||
            Date.parse(r.measured_at) >= Date.parse(q.get("from")!)) &&
            (!q.get("to") ||
              Date.parse(r.measured_at) < Date.parse(q.get("to")!)))),
    );
  const desc = (rows: Row[]) =>
    [...rows].sort(
      (a, b) =>
        Date.parse(b.measured_at) - Date.parse(a.measured_at) ||
        String(a.id).localeCompare(String(b.id)),
    );
  if (name === "members") return s.members;
  if (/^members\/[^/]+$/.test(name)) {
    const row = s.members.find((m) => m.id === name.split("/")[1]);
    if (!row) throw Error("本机没有该成员资料");
    return row;
  }
  if (name === "health/metrics")
    return (
      s.metrics ??
      Object.entries({
        height: "cm",
        weight: "kg",
        waist: "cm",
        body_fat: "%",
        blood_pressure: "mmHg",
        heart_rate: "bpm",
        blood_glucose: "mmol/L",
        oxygen_saturation: "%",
        temperature: "°C",
      }).map(([kind, unit]) => ({ kind, unit }))
    );
  const observations = s.observations.filter(
    (r) => Date.parse(r.measured_at) >= Date.now() - 90 * 86400000,
  );
  if (name === "health/observations")
    return paginate(desc(filter(observations)));
  if (name === "health/statistics") {
    const groups = new Map<string, Row[]>();
    for (const row of filter(observations)) {
      const date = new Date(Date.parse(row.measured_at) + 8 * 3600000);
      date.setUTCHours(0, 0, 0, 0);
      if (q.get("group") === "month") date.setUTCDate(1);
      if (q.get("group") === "week")
        date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
      const time = new Date(date.getTime() - 8 * 3600000).toISOString();
      const key = JSON.stringify([
        time,
        row.kind,
        row.unit,
        !!row.estimated,
        !!row.age_approximate,
      ]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return paginate(
      [...groups]
        .map(([key, rows]) => {
          const [time, kind, unit, estimated, age_approximate] =
            JSON.parse(key);
          const values = rows.map((r) => Number(r.value)),
            second = rows
              .filter((r) => r.value_secondary != null)
              .map((r) => Number(r.value_secondary));
          return {
            time,
            kind,
            unit,
            estimated,
            age_approximate,
            count: rows.length,
            mean: values.reduce((a, b) => a + b, 0) / values.length,
            min: Math.min(...values),
            max: Math.max(...values),
            mean_secondary: second.length
              ? second.reduce((a, b) => a + b, 0) / second.length
              : null,
          };
        })
        .sort(
          (a, b) =>
            a.time.localeCompare(b.time) || a.kind.localeCompare(b.kind),
        ),
    );
  }
  if (name === "health/history" || name === "health/documents") {
    const rows = name.endsWith("history") ? s.history : s.documents;
    if (!rows) throw Error("本机尚未同步此类资料");
    const search = (q.get("search") || "").toLowerCase();
    return paginate(
      filter(rows, false).filter(
        (r) =>
          !search ||
          [r.title, r.notes, r.summary]
            .join(" ")
            .toLowerCase()
            .includes(search),
      ),
    );
  }
  if (/^documents\/[^/]+$/.test(name)) {
    const row = s.documents?.find((r) => r.id === name.split("/")[1]);
    if (!row) throw Error("本机没有该文件资料");
    return row;
  }
  if (name === "measurements" || name.startsWith("measurements/")) {
    let measurements = s.measurements;
    if (!measurements) {
      const grouped = new Map<string, Row>();
      for (const o of observations.filter((r) => r.source === "device")) {
        const id = o.source_record_id || o.id.split(":")[0];
        const row = grouped.get(id) ?? {
          id,
          member_id: o.member_id,
          member_name: s.members.find((m) => m.id === o.member_id)?.name,
          measured_at: o.measured_at,
          time_valid: true,
          weight_valid: true,
        };
        if (o.kind === "blood_pressure") {
          Object.assign(row, {
            kind: "blood_pressure",
            systolic: o.value,
            diastolic: o.value_secondary,
          });
        }
        if (o.kind === "heart_rate") row.pulse = o.value;
        if (o.kind === "weight")
          Object.assign(row, { kind: "body_composition", weight_kg: o.value });
        if (o.kind === "body_fat")
          Object.assign(row, {
            body_fat_pct: o.value,
            body_fat_status: "estimated",
          });
        grouped.set(id, row);
      }
      measurements = [...grouped.values()];
    }
    let rows = measurements.filter(
      (r) =>
        Date.parse(r.measured_at || r.received_at) >=
          Date.now() - 90 * 86400000 &&
        (!member || r.member_id === member) &&
        (!q.get("device_id") || r.device_id === q.get("device_id")) &&
        (q.get("unassigned") !== "true" || r.member_id == null) &&
        (!q.get("measurement_id") || r.id === q.get("measurement_id")) &&
        (!kind || (r.kind ?? r.category) === kind),
    );
    if (name === "measurements/latest") {
      const found = new Map<string, Row>();
      for (const r of desc(
        rows.filter((r) => r.time_valid !== false && r.weight_valid !== false),
      )) {
        const values =
          r.kind === "blood_pressure"
            ? [
                ["blood_pressure", r.systolic, r.diastolic, "mmHg"],
                ["pulse", r.pulse, null, "次/分"],
              ]
            : [
                ["weight", r.weight_kg, null, "kg"],
                ...(r.body_fat_status === "estimated"
                  ? [["body_fat", r.body_fat_pct, null, "%"]]
                  : []),
              ];
        for (const [metric, value, value_secondary, unit] of values) {
          const key = r.member_id + ":" + metric;
          if (value != null && !found.has(key))
            found.set(key, {
              ...r,
              record_id: r.id,
              metric,
              value,
              value_secondary,
              unit,
            });
        }
      }
      return { items: [...found.values()] };
    }
    rows = desc(filter(rows));
    if (!kind) rows = rows.filter((r) => r.kind === "blood_pressure");
    if (name === "measurements/series")
      return {
        items: rows.filter((r) => r.measured_at).reverse(),
        next_cursor: null,
      };
    if (name === "measurements") return paginate(rows);
  }
  if (name.startsWith("operations/") && s.resources?.operations) {
    const row = (s.resources.operations as Row[]).find(
      (r) => r.id === name.split("/")[1],
    );
    if (!row) throw Error("本机没有该操作记录");
    return row;
  }
  if (s.resources && Object.hasOwn(s.resources, name)) {
    const data = s.resources[name];
    if (!Array.isArray(data)) return data;
    return data.filter(
      (r) =>
        (!q.get("device_id") || r.device_id === q.get("device_id")) &&
        (!q.get("collector_id") || r.collector_id === q.get("collector_id")) &&
        (!kind || r.kind === kind),
    );
  }
  throw Error("此查询尚未缓存在本机");
}

export async function removeCached(path: string) {
  await offlineDB("readwrite", (s) => s.delete("api:" + cacheKey(path)));
}
export async function exportLocalMeasurements(query: string) {
  const snapshot = await readSnapshot();
  if (!snapshot) throw Error("本机尚无测量数据");
  const q = new URLSearchParams(query);
  q.set("page_size", "200");
  const rows: Row[] = [];
  for (let page = 1; ; page++) {
    q.set("page", String(page));
    const result = localRead("measurements?" + q, snapshot) as {
      items: Row[];
      total: number;
    };
    rows.push(...result.items);
    if (rows.length >= result.total || !result.items.length) break;
  }
  const columns = [
    ["成员", "member_name"],
    ["设备", "device_name"],
    ["测量时间", "measured_at"],
    ["收缩压(mmHg)", "systolic"],
    ["舒张压(mmHg)", "diastolic"],
    ["脉搏(bpm)", "pulse"],
    ["体重(kg)", "weight_kg"],
    ["估算体脂(%)", "body_fat_pct"],
    ["备注", "notes"],
  ];
  const cell = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const csv =
    "\ufeff" +
    [
      columns.map(([name]) => cell(name)).join(","),
      ...rows.map((row) =>
        columns
          .map(([, key]) =>
            cell(
              key === "body_fat_pct" && row.body_fat_status !== "estimated"
                ? ""
                : row[key],
            ),
          )
          .join(","),
      ),
    ].join("\r\n");
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "eir-offline-measurements.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function snapshotRoute(path: string, snapshot: Snapshot) {
  const name = path.split("?")[0];
  return (
    /^(members(?:\/[^/]+)?|health\/(metrics|observations|statistics|history|documents)|measurements(?:\/(latest|series))?|documents\/[^/]+|operations\/[^/]+)$/.test(
      name,
    ) ||
    (!!snapshot.resources && Object.hasOwn(snapshot.resources, name))
  );
}
