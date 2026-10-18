#!/usr/bin/env node
// Household overview acceptance with synthetic data only. Build web/ first.
// Requires Playwright and Chromium; EIR_TEST_BROWSER may select a local browser.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../web/dist');
const output = process.env.EIR_OVERVIEW_SCREENSHOTS || '/tmp/eir-overview-ui';
fs.mkdirSync(output, { recursive: true });
const members = ['成员甲', '成员乙', '成员丙', '无记录成员'].map((name, n) => ({
  id: `00000000-0000-4000-8000-00000000000${n + 1}`, name,
  sex: n === 1 ? 'female' : 'male', birth_date: '1990-01-01', height_cm: 170,
}));
const points = members.slice(0, 3).flatMap((m, member) => Array.from({ length: 12 }, (_, n) => {
  const measured_at = new Date(Date.UTC(2026, 9, 1 + n, 0, member * 15)).toISOString();
  return [
    { id: `${member}-bp-${n}`, member_id: m.id, kind: 'blood_pressure', measured_at,
      systolic: 115 + member * 11 + Math.sin(n) * 5, diastolic: 72 + member * 8 + Math.cos(n) * 3, pulse: 62 + member * 9 + Math.sin(n) * 4 },
    { id: `${member}-body-${n}`, member_id: m.id, kind: 'body_composition', measured_at,
      weight_kg: 61 + member * 11 + Math.sin(n / 3), weight_valid: true,
      body_fat_pct: member === 2 || n === 5 ? 0 : 18 + member * 6 + Math.cos(n / 3), body_fat_status: member === 2 || n === 5 ? 'missing_adc' : 'estimated' },
  ];
}).flat());
let latestRequests = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: heartbeat\ndata: {}\n\n');
    const heartbeat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 5000);
    req.on('close', () => clearInterval(heartbeat));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    let body;
    if (url.pathname.endsWith('/members')) body = members;
    else if (url.pathname.endsWith('/operations') || url.pathname.endsWith('/devices')) body = [];
    else if (url.pathname.endsWith('/measurements/series')) {
      const items = points.filter(p => p.kind === url.searchParams.get('kind') && (!url.searchParams.get('member_id') || p.member_id === url.searchParams.get('member_id')));
      body = { items, next_cursor: null };
    } else if (url.pathname.endsWith('/measurements/latest')) {
      latestRequests++;
      assert(url.searchParams.get('member_id'), 'overview fetched household latest values');
      body = { items: ['weight', 'body_fat', 'blood_pressure', 'pulse'].map((metric, n) => ({
        member_id: url.searchParams.get('member_id'), metric, value: [64.2, 21.5, 118, 67][n],
        value_secondary: metric === 'blood_pressure' ? 76 : null, measured_at: '2026-10-12T03:00:00Z',
      })) };
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  const file = url.pathname.startsWith('/assets/') ? path.join(root, url.pathname) : path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EIR_TEST_BROWSER ? { executablePath: process.env.EIR_TEST_BROWSER } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const chartCount = async n => page.waitForFunction(n => document.querySelectorAll('[role="img"] canvas').length === n, n);
    const latestCards = () => page.locator('[data-slot="card-description"]').filter({ hasText: /^(体重|估算体脂率|血压|脉搏)$/ });
    await page.goto(base + '/?period=all');
    await chartCount(4);
    assert.equal(await page.getByRole('img', { name: /^全员/ }).count(), 4);
    assert.equal(await latestCards().count(), 0); assert.equal(latestRequests, 0);
    assert.equal(await page.getByRole('heading', { name: /^成员[甲乙丙]$/ }).count(), 0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.waitForTimeout(250);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
      await page.screenshot({ path: path.join(output, `family-overview-${width}.png`), fullPage: true });
    }
    await page.getByRole('tab', { name: '成员甲', exact: true }).click();
    await chartCount(4);
    await page.waitForFunction(() => document.body.textContent.includes('64.2'));
    assert.equal(await latestCards().count(), 4);
    assert(new URL(page.url()).searchParams.get('member_id') === members[0].id);
    assert.equal(await page.getByRole('img', { name: /成员甲/ }).count(), 0);
    await page.screenshot({ path: path.join(output, 'member-overview-390.png'), fullPage: true });
    await page.goBack(); await chartCount(4);
    assert.equal(await latestCards().count(), 0);
    await page.goForward(); await chartCount(4);
    assert.equal(await latestCards().count(), 4);
    await page.getByRole('tab', { name: '全员', exact: true }).click();
    await chartCount(4);
    const requests = latestRequests;
    await page.waitForTimeout(700);
    assert.equal(latestRequests, requests);
    assert.equal(await latestCards().count(), 0);
    await page.getByRole('tab', { name: '无记录成员', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="img"] canvas').length === 0);
    assert.equal(await page.getByText(/当前时间范围暂无有效/).count(), 4);
    assert.deepEqual(errors, []);
    console.log('PASS synthetic household overview: 4 combined charts, no household latest requests/cards, member cards, history navigation, empty member, 390/1440px layouts');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.closeAllConnections(); server.close(); process.exitCode = 1; });
