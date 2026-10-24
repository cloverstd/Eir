// Synthetic browser acceptance: no live API, MQTT, or health data.
const { chromium, expect } = require("playwright/test");
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
(async () => {
  const { localRead } = await import("../web/src/offlineData.ts");
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  const members = ids.map((id, i) => ({
    id,
    name: ["成员甲", "成员乙"][i],
    sex: i ? "female" : "male",
    height_cm: 170,
    birth_date: "1990-01-01",
    notes: "",
  }));
  const now = new Date().toISOString();
  const snapshot = {
    instance_id: "synthetic",
    data_epoch: "epoch1",
    synced_at: now,
    window_start: new Date(Date.now() - 90 * 86400000).toISOString(),
    members,
    measurements: members.flatMap((m, i) => [
      {
        id: "bp-" + i,
        member_id: m.id,
        member_name: m.name,
        kind: "blood_pressure",
        measured_at: now,
        device_name: "血压计",
        device_time: now,
        time_valid: true,
        weight_valid: true,
        systolic: 120 + i * 10,
        diastolic: 80,
        pulse: 70,
        notes: "",
      },
      {
        id: "body-" + i,
        member_id: m.id,
        member_name: m.name,
        kind: "body_composition",
        measured_at: now,
        time_valid: true,
        weight_valid: true,
        weight_kg: 65 + i * 10,
        body_fat_pct: 20,
        body_fat_status: "estimated",
        notes: "",
      },
    ]),
    observations: members.map((m, i) => ({
      id: "waist-" + i,
      member_id: m.id,
      kind: "waist",
      value: 82 + i * 8,
      unit: "cm",
      measured_at: now,
      source: "manual",
      notes: "",
    })),
    history: [
      {
        id: "history",
        member_id: ids[0],
        kind: "condition",
        title: "合成病史",
        occurred_on: "2026-01-01",
        details: {},
        notes: "",
      },
    ],
    documents: [
      {
        id: "document",
        member_id: ids[0],
        title: "合成检验单",
        category: "lab",
        filename: "fixture.pdf",
        mime_type: "application/pdf",
        size: 1024,
        page_count: 1,
      },
    ],
    metrics: [{ kind: "waist", label: "腰围", unit: "cm", min: 10, max: 400 }],
    resources: {
      devices: [],
      collectors: [],
      bindings: [],
      rejections: [],
      "collectors/discovered": [],
      operations: [],
      events: [],
      firmwares: [],
      "ota-jobs": [],
      "signals/latest": [],
    },
  };
  let syncs = 0,
    apiRequests = 0,
    fail = false,
    writes = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      apiRequests++;
      if (req.method !== "GET") {
        writes++;
        res.writeHead(405);
        res.end();
        return;
      }
      if (fail) {
        res.writeHead(503);
        res.end();
        return;
      }
      if (url.pathname.endsWith("/events/stream")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: heartbeat\ndata: {}\n\n");
        return;
      }
      res.setHeader("Content-Type", "application/json");
      if (url.pathname.endsWith("/offline/snapshot")) {
        syncs++;
        snapshot.synced_at = new Date().toISOString();
        res.end(JSON.stringify(snapshot));
        return;
      }
      if (url.pathname.endsWith("/push/config")) {
        res.end(JSON.stringify({ enabled: false, public_key: "" }));
        return;
      }
      try {
        res.end(
          JSON.stringify(
            localRead(
              url.pathname.slice("/api/v1/".length) + url.search,
              snapshot,
            ),
          ),
        );
      } catch {
        res.writeHead(404);
        res.end("{}");
      }
      return;
    }
    const file = path.join(
      __dirname,
      "../web/dist",
      url.pathname.includes(".") ? url.pathname : "index.html",
    );
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "application/javascript",
        ".css": "text/css",
        ".png": "image/png",
        ".webmanifest": "application/manifest+json",
      }[path.extname(file)] || "application/octet-stream",
    );
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.EIR_TEST_BROWSER ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  try {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    await context.addInitScript(() => {
      const original = window.setInterval;
      window.setInterval = (fn, ms, ...args) =>
        original(fn, ms === 300000 ? 1200 : ms, ...args);
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin + "/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => syncs).toBeGreaterThanOrEqual(2);
    const initialSyncs = syncs;
    await expect.poll(() => syncs).toBeGreaterThan(initialSyncs);
    const before = apiRequests;
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "家庭概览", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("正在查看本机数据", { exact: false }),
    ).toBeVisible();
    assert.equal(new URL(page.url()).pathname, "/");
    await expect(
      page.getByText("本机尚未同步这项数据", { exact: false }),
    ).toHaveCount(0);
    await page.goto(origin + "/data?member_id=" + ids[0]);
    await expect(
      page.getByRole("heading", { name: "血压数据", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("测量记录", { exact: true })).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "导出 CSV" }).click(),
    ]);
    const csv = fs.readFileSync(await download.path(), "utf8");
    assert(
      csv.includes("成员甲") && !csv.includes("成员乙"),
      "offline export leaked another member",
    );
    await page.goto(origin + "/body?member_id=" + ids[1]);
    await expect(page.getByText("称重记录", { exact: true })).toBeVisible();
    await page.goto(origin + "/members/" + ids[0] + "/history");
    await expect(
      page.getByText("合成病史", { exact: true }).first(),
    ).toBeVisible();
    await page.goto(origin + "/members/" + ids[0] + "/documents");
    await expect(page.getByText("合成检验单", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "预览文件", exact: true }).click();
    await expect(
      page.getByText("医疗文件原件未缓存在本机，请联网后预览", { exact: true }),
    ).toBeVisible();
    await page.goto(origin + "/devices");
    await expect(
      page.getByRole("heading", { name: "设备", exact: true }),
    ).toBeVisible();
    await page.goto(origin + "/?member_id=" + ids[0]);
    await page.getByRole("button", { name: "记录腰围", exact: true }).click();
    await page.getByRole("spinbutton", { name: "腰围（cm）" }).fill("83");
    await page.getByRole("button", { name: "保存腰围", exact: true }).click();
    await expect(
      page
        .getByText("当前离线，仅可查看本机数据；请联网后再保存或操作设备", {
          exact: true,
        })
        .first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    assert.equal(apiRequests, before, "offline navigations contacted server");
    // A connected network with an unreachable Eir must also fall back in place.
    fail = true;
    await context.setOffline(false);
    await page.goto(origin + "/");
    await expect(
      page.getByText("正在查看本机数据", { exact: false }),
    ).toBeVisible();
    fail = false;
    snapshot.observations[0].value = 86;
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const open = indexedDB.open("eir-offline");
              open.onsuccess = () => {
                const db = open.result;
                const req = db
                  .transaction("snapshot")
                  .objectStore("snapshot")
                  .get("current");
                req.onsuccess = () => {
                  resolve(req.result?.observations[0]?.value);
                  db.close();
                };
                req.onerror = reject;
              };
              open.onerror = reject;
            }),
        ),
      )
      .toBe(86);
    await expect(
      page.getByText("正在查看本机数据", { exact: false }),
    ).toHaveCount(0);
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "家庭概览", exact: true }),
    ).toBeVisible();
    await page.waitForFunction(
      () => document.documentElement.scrollWidth <= innerWidth,
    );
    assert.deepEqual(errors, []);
    assert.equal(writes, 0);
    await page.screenshot({
      path: "/tmp/eir-overview-offline-390.png",
      fullPage: true,
    });
    console.log(
      "PASS: overview, blood pressure, body, profile, documents and devices offline; 5-minute scheduler, unreachable service fallback, reconnect refresh; no writes",
    );
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
