const { chromium } = require("playwright");
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../web/dist");
const member = { id: "00000000-0000-4000-8000-000000000001", name: "测试成员" };
const snapshot = {
  instance_id: "instance",
  data_epoch: "epoch",
  synced_at: new Date().toISOString(),
  window_start: new Date(Date.now() - 90 * 86400000).toISOString(),
  members: [member],
  observations: [
    {
      id: "row",
      member_id: member.id,
      kind: "waist",
      value: 82,
      unit: "cm",
      measured_at: new Date().toISOString(),
    },
  ],
};
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  if (pathname.startsWith("/api/")) {
    if (pathname.endsWith("/events/stream")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("event: heartbeat\ndata: {}\n\n");
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        pathname.endsWith("/offline/snapshot")
          ? snapshot
          : pathname.endsWith("/members")
            ? [member]
            : pathname.endsWith("/push/config")
              ? { enabled: false, public_key: "" }
              : [],
      ),
    );
    return;
  }
  const file = path.join(
    root,
    pathname.includes(".") ? pathname : "index.html",
  );
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader(
    "Content-Type",
    {
      ".js": "application/javascript",
      ".html": "text/html",
      ".css": "text/css",
      ".png": "image/png",
      ".webmanifest": "application/manifest+json",
    }[path.extname(file)] || "application/octet-stream",
  );
  res.end(fs.readFileSync(file));
});
(async () => {
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
    await context.addInitScript(()=>{if(localStorage.getItem("eir-offline-enabled")===null)localStorage.setItem("eir-offline-enabled","false")});
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/settings`);
    await page.getByRole("button", { name: "开启离线保存" }).click();
    await page.getByText("最近同步：", { exact: false }).waitFor();
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.getByRole("link", { name: "查看离线数据", exact: true }).click();
    await page.getByRole("heading", { name: "离线数据 · 只读" }).waitFor();
    await page.getByRole("cell", { name: "82 cm", exact: true }).waitFor();
    await context.setOffline(true);
    await page.reload();
    await page.getByRole("cell", { name: "82 cm", exact: true }).waitFor();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "mobile overflow",
    );
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: "/tmp/eir-pwa-offline-390.png",
      fullPage: true,
    });
    const apiCached=await page.evaluate(async()=>{for(const name of await caches.keys()){for(const request of await (await caches.open(name)).keys()){if(new URL(request.url).pathname.startsWith('/api/'))return true}}return false});
    assert.equal(apiCached,false,'API response entered service worker cache');
    await context.setOffline(false);
    await page.goto(`http://127.0.0.1:${server.address().port}/settings`);
    await page.getByRole('button',{name:'关闭并清除离线数据'}).click();
    await page.getByText('本机离线数据已清除',{exact:true}).waitFor();
    await page.getByRole('link',{name:'查看离线数据',exact:true}).click();
    await page.getByText('尚无离线数据，请联网后在系统管理开启保存。',{exact:true}).waitFor();
    console.log("PWA 390px, offline reload, snapshot clear, API cache exclusion: PASS");
  } finally {
    await browser.close();
    server.closeAllConnections();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
