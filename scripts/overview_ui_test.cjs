#!/usr/bin/env node
// Household overview acceptance with synthetic data only. Build web/ first.
// Requires Playwright and Chromium; EIR_TEST_BROWSER may select a local browser.
const { chromium, expect } = require('playwright/test');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = process.env.EIR_OVERVIEW_ROOT || path.resolve(__dirname, '../web/dist');
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
let waistRows = members.slice(0, 3).flatMap((member, index) => Array.from({ length: index === 0 ? 205 : 12 }, (_, n) => {
  const id = randomUUID();
  return { id, source_record_id: id, member_id: member.id, kind: 'waist', unit: 'cm', value: 80 + index * 5 + (n % 10) / 10,
    measured_at: new Date(Date.UTC(2026, 9, 1, n)).toISOString(), source: 'manual', estimated: false, notes: '' };
}));
const streams = new Set();
const observationQueries = [];
const writes = [];
let latestRequests = 0, waistLatestRequests = 0, failSave = false, failWaist = false, delayMember = '';
let refreshGate = null, latestWeight = 64.2;
const refreshReads = [];
const changed = () => { for (const stream of streams) stream.write('event: change\ndata: {}\n\n'); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/v1/events/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: heartbeat\ndata: {}\n\n');
    streams.add(res);
    const heartbeat = setInterval(() => res.write('event: heartbeat\ndata: {}\n\n'), 5000);
    req.on('close', () => { clearInterval(heartbeat); streams.delete(res); });
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    if (refreshGate && req.method === 'GET') {
      refreshReads.push(url);
      await refreshGate;
    }
    let body;
    const observationPath = url.pathname.match(/^\/api\/v1\/members\/([^/]+)\/observations(?:\/([^/]+))?$/);
    if (observationPath && req.method !== 'GET') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const input = raw ? JSON.parse(raw) : null;
      writes.push({ method: req.method, member: observationPath[1], input });
      await new Promise(resolve => setTimeout(resolve, 250));
      if (failSave) {
        // Keep explicit API errors separate from the 5xx offline-fallback tests.
        res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '模拟保存失败，请重试' })); return;
      }
      if (req.method === 'DELETE') {
        waistRows = waistRows.filter(row => row.id !== observationPath[2]);
        res.writeHead(204); res.end(); changed(); return;
      }
      const id = observationPath[2] || randomUUID();
      body = { ...input, id, source_record_id: id, member_id: observationPath[1], source: 'manual', estimated: false, unit: 'cm' };
      waistRows = waistRows.filter(row => row.id !== id).concat(body);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); changed(); return;
    }
    if (url.pathname.endsWith('/members')) body = members;
    else if (url.pathname.endsWith('/operations') || url.pathname.endsWith('/devices')) body = [];
    else if (url.pathname.endsWith('/health/metrics')) body = [{ kind: 'weight', unit: 'kg', min: 1, max: 500 }, { kind: 'waist', unit: 'cm', min: 10, max: 400 }];
    else if (url.pathname.endsWith('/health/observations')) {
      const q = url.searchParams;
      observationQueries.push(new URLSearchParams(q));
      if (q.get('page_size') === '1') {
        waistLatestRequests++;
        assert(q.get('member_id'), 'overview fetched household latest waist');
        assert(!q.has('from') && !q.has('to'), 'latest waist is date-filtered');
      }
      if (failWaist) {
        res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '模拟腰围查询失败' })); return;
      }
      const items = waistRows.filter(row => (!q.get('member_id') || row.member_id === q.get('member_id')) &&
        (!q.get('kind') || row.kind === q.get('kind')) && (!q.get('from') || Date.parse(row.measured_at) >= Date.parse(q.get('from'))) &&
        (!q.get('to') || Date.parse(row.measured_at) < Date.parse(q.get('to'))))
        .sort((a, b) => Date.parse(b.measured_at) - Date.parse(a.measured_at) || a.id.localeCompare(b.id));
      const page = Number(q.get('page') || 1), pageSize = Number(q.get('page_size') || 50);
      body = { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, page_size: pageSize };
      if (q.get('member_id') === delayMember && delayMember) await new Promise(resolve => setTimeout(resolve, 600));
    } else if (/\/health\/(history|documents|statistics)$/.test(url.pathname)) body = { items: [], total: 0 };
    else if (url.pathname.endsWith('/measurements/series')) {
      const items = points.filter(p => p.kind === url.searchParams.get('kind') && (!url.searchParams.get('member_id') || p.member_id === url.searchParams.get('member_id')));
      body = { items, next_cursor: null };
    } else if (url.pathname.endsWith('/measurements/latest')) {
      latestRequests++;
      assert(url.searchParams.get('member_id'), 'overview fetched household latest values');
      body = { items: ['weight', 'body_fat', 'blood_pressure', 'pulse'].map((metric, n) => ({
        member_id: url.searchParams.get('member_id'), metric, value: [latestWeight, 21.5, 118, 67][n],
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const chartCount = async n => page.waitForFunction(n => document.querySelectorAll('[role="img"] canvas').length === n, n);
    const latestCards = () => page.locator('[data-slot="card-description"]').filter({ hasText: /^(体重|估算体脂率|血压|脉搏|腰围)$/ });
    const waistCard = () => page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-description"]').filter({ hasText: /^腰围$/ }) });
    await page.goto(base + '/?period=all');
    await chartCount(5);
    assert.equal(await page.getByRole('img', { name: /^全员/ }).count(), 5);
    assert.equal(await latestCards().count(), 0); assert.equal(latestRequests + waistLatestRequests, 0);
    assert(observationQueries.some(q => q.get('page') === '2'), 'waist history truncated at 200');
    assert.equal(await page.getByRole('heading', { name: /^成员[甲乙丙]$/ }).count(), 0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.waitForTimeout(250);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
      await page.screenshot({ path: path.join(output, `family-overview-${width}.png`), fullPage: true });
    }

    // Slow SSE and offline-sync refreshes retain the page, charts, focus and scroll.
    // Use a rolling window so sync advances the request boundary without changing filters.
    const refreshTimes = [...points, ...waistRows].map(row => [row, row.measured_at]);
    const refreshOffset = Date.now() - Date.parse('2026-10-15T00:00:00Z');
    for (const [row, measuredAt] of refreshTimes) row.measured_at = new Date(Date.parse(measuredAt) + refreshOffset).toISOString();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      for (const selected of ['', members[0].id, members[3].id]) {
        await page.goto(base + '/?period=30' + (selected ? `&member_id=${selected}` : ''));
        await chartCount(selected === members[3].id ? 0 : 5);
        if (selected === members[3].id) await expect(page.getByText(/当前时间范围暂无有效/)).toHaveCount(5);
        if (selected) await expect(waistCard()).toContainText(selected === members[3].id ? '暂无有效测量' : '80.4');
        await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0);
        await page.waitForTimeout(700); // Allow the initial SSE connection refresh to finish.
        for (const event of ['change', 'eir-offline-updated']) {
          let release;
          refreshReads.length = 0;
          refreshGate = new Promise(resolve => { release = resolve; });
          await page.evaluate(() => {
            document.querySelector('[role="tab"][data-state="active"]').focus({ preventScroll: true });
            window.scrollTo(0, 250);
          });
          await page.waitForTimeout(50);
          await page.evaluate(() => {
            const nodes = [...document.querySelectorAll('main h1, [role="tablist"], main button, [data-slot="card"], [role="img"], canvas, footer')];
            const rect = node => {
              const b = node.getBoundingClientRect();
              return [b.x, b.y + scrollY, b.width, b.height];
            };
            const probe = window.__overviewRefresh = {
              nodes, bounds: nodes.map(rect), focus: document.activeElement,
              scroll: scrollY, height: document.documentElement.scrollHeight, problems: [],
              image: document.querySelector('[role="img"][aria-label*="血压"] canvas')?.toDataURL(),
            };
            const sample = () => {
              if (probe.stopped) return;
              if (nodes.some(node => !node.isConnected)) probe.problems.push('page/chart DOM was replaced');
              if (nodes.some((node, i) => rect(node).some((value, j) => Math.abs(value - probe.bounds[i][j]) > 1))) probe.problems.push('layout moved');
              if (Math.abs(scrollY - probe.scroll) > 1) probe.problems.push('scroll moved');
              if (document.documentElement.scrollHeight !== probe.height) probe.problems.push('page height changed');
              if (document.activeElement !== probe.focus) probe.problems.push('focus lost');
              if (document.querySelector('[data-slot="skeleton"]')) probe.problems.push('skeleton returned');
              requestAnimationFrame(sample);
            };
            requestAnimationFrame(sample);
          });
          try {
            if (event === 'change') changed();
            else await page.evaluate(event => window.dispatchEvent(new Event(event)), event);
            await expect.poll(() => refreshReads.some(url => url.pathname.endsWith('/measurements/series')) &&
              refreshReads.some(url => url.pathname.endsWith('/health/observations'))).toBe(true);
            await page.waitForTimeout(150);
            assert.deepEqual(await page.evaluate(() => [...new Set(window.__overviewRefresh.problems)]), [], `inflight ${width}/${selected || 'family'}/${event}`);
            // New readings and chart points must arrive without replacing their containers.
            if (selected === members[0].id) {
              latestWeight += 1;
              points.filter(row => row.member_id === selected && row.kind === 'blood_pressure').forEach(row => { row.systolic += 1; });
            }
            refreshGate = null; release();
            if (selected === members[0].id) {
              await expect(page.locator('[data-slot="card"]').filter({ has: page.locator('[data-slot="card-description"]').filter({ hasText: /^体重$/ }) })).toContainText(String(latestWeight));
              await expect.poll(() => page.evaluate(() => document.querySelector('[role="img"][aria-label*="血压"] canvas')?.toDataURL() !== window.__overviewRefresh.image)).toBe(true);
            }
            await page.waitForTimeout(300);
            assert.deepEqual(await page.evaluate(() => [...new Set(window.__overviewRefresh.problems)]), [], `complete ${width}/${selected || 'family'}/${event}`);
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `refresh overflow at ${width}`);
          } finally {
            refreshGate = null; release();
            await page.evaluate(() => { window.__overviewRefresh.stopped = true; });
          }
        }
      }
    }
    console.log('PASS stable refresh: 12 slow SSE/offline-sync cases at 390/1440px, family/member/empty views, persistent charts/layout/scroll/focus, updated data');
    for (const [row, measuredAt] of refreshTimes) row.measured_at = measuredAt;
    latestWeight = 64.2;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/?period=all');
    await chartCount(5);
    await page.getByRole('tab', { name: '成员甲', exact: true }).click();
    await chartCount(5);
    await page.waitForFunction(() => document.body.textContent.includes('64.2'));
    assert.equal(await latestCards().count(), 5);
    await expect(waistCard()).toContainText('80.4');
    assert(new URL(page.url()).searchParams.get('member_id') === members[0].id);
    assert.equal(await page.getByRole('img', { name: /成员甲/ }).count(), 0);
    await page.screenshot({ path: path.join(output, 'member-overview-390.png'), fullPage: true });
    await page.goBack(); await chartCount(5);
    assert.equal(await latestCards().count(), 0);
    await page.goForward(); await chartCount(5);
    assert.equal(await latestCards().count(), 5);
    await page.getByRole('tab', { name: '全员', exact: true }).click();
    await chartCount(5);
    const requests = latestRequests + waistLatestRequests;
    await page.waitForTimeout(700);
    assert.equal(latestRequests + waistLatestRequests, requests);
    assert.equal(await latestCards().count(), 0);
    await page.getByRole('tab', { name: '无记录成员', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="img"] canvas').length === 0);
    assert.equal(await page.getByText(/当前时间范围暂无有效/).count(), 5);
    await expect(waistCard()).toContainText('暂无有效测量');

    // Family recording requires an explicit person; validation and errors retain the draft.
    await page.getByRole('tab', { name: '全员', exact: true }).click();
    await page.getByRole('button', { name: '记录腰围', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '记录腰围', exact: true });
    await expect(dialog.getByRole('combobox')).toContainText('请选择成员');
    await dialog.getByLabel('腰围（cm）').fill('82.5');
    await dialog.getByRole('button', { name: '保存腰围', exact: true }).click();
    assert.equal(writes.length, 0);
    await dialog.getByRole('combobox').click();
    await page.getByRole('option', { name: '成员甲', exact: true }).click();
    for (const value of ['', '9.9', '400.1']) {
      await dialog.getByLabel('腰围（cm）').fill(value);
      await dialog.getByRole('button', { name: '保存腰围', exact: true }).click();
      assert.equal(writes.length, 0);
    }
    await dialog.getByLabel('腰围（cm）').fill('82.5');
    await dialog.getByLabel('备注（可选）').fill('合成腰围测试');
    const localTime = await dialog.locator('input[name="measured_at"]').inputValue();
    assert(Math.abs(Date.parse(localTime + ':00+08:00') - Date.now()) < 120000, 'default time must be Shanghai');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await page.screenshot({ path: path.join(output, `waist-record-${width}.png`) });
    }
    failSave = true;
    await dialog.getByRole('button', { name: '保存腰围', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('模拟保存失败');
    await expect(dialog.getByLabel('腰围（cm）')).toHaveValue('82.5');
    await expect(dialog.getByLabel('备注（可选）')).toHaveValue('合成腰围测试');
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await expect(dialog).toBeVisible();
      const bounds = await dialog.boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width, `dialog overflow at ${width}`);
      await page.screenshot({ path: path.join(output, `waist-record-error-${width}.png`) });
    }
    failSave = false;
    const beforeSave = writes.length;
    await dialog.getByRole('button', { name: '保存腰围', exact: true }).click();
    await expect(dialog.getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
    await dialog.locator('form').evaluate(form => form.requestSubmit());
    await expect(dialog).toHaveCount(0);
    assert.equal(writes.length, beforeSave + 1, 'duplicate submit');
    assert.equal(new URL(page.url()).searchParams.get('member_id'), null);
    assert.equal(new URL(page.url()).searchParams.get('period'), 'all');
    assert.deepEqual(writes.at(-1).input, { kind: 'waist', unit: 'cm', value: 82.5, measured_at: new Date(localTime + ':00+08:00').toISOString(), notes: '合成腰围测试' });
    await page.getByRole('tab', { name: '成员甲', exact: true }).click();
    await expect(waistCard()).toContainText('82.5');

    // History uses the existing edit/delete controls and updates an already-open overview over SSE.
    const historyPage = await browser.newPage();
    await historyPage.goto(base + await page.getByRole('link', { name: '查看腰围历史' }).getAttribute('href'));
    await expect(historyPage.getByRole('row').filter({ hasText: '合成腰围测试' })).toContainText('82.50 cm');
    await historyPage.getByRole('row').filter({ hasText: '合成腰围测试' }).getByRole('button', { name: '编辑指标' }).click();
    await historyPage.locator('input[name="value"]').fill('83.5');
    await historyPage.getByRole('button', { name: '保存指标', exact: true }).click();
    await expect(waistCard()).toContainText('83.5');
    await historyPage.getByRole('row').filter({ hasText: '合成腰围测试' }).getByRole('button', { name: '删除指标', exact: true }).click();
    await historyPage.getByRole('dialog').getByRole('button', { name: /确认/ }).click();
    await expect(waistCard()).toContainText('80.4');
    await historyPage.close();

    // Backfill through the date picker in a browser whose timezone is not Shanghai.
    await page.getByRole('button', { name: '记录腰围', exact: true }).click();
    await expect(dialog.getByRole('combobox')).toContainText('成员甲');
    await dialog.getByLabel('腰围（cm）').fill('79.25');
    await dialog.getByRole('button', { name: '测量时间（上海时间）', exact: true }).click();
    await page.getByRole('combobox', { name: '选择年份' }).selectOption('2026');
    await page.getByRole('combobox', { name: '选择月份' }).selectOption('9');
    await page.getByRole('button', { name: /^2026年10月5日/ }).click();
    await page.getByRole('combobox', { name: '小时', exact: true }).click();
    await page.getByRole('option', { name: '09', exact: true }).click();
    await page.getByRole('combobox', { name: '分钟', exact: true }).click();
    await page.getByRole('option', { name: '30', exact: true }).click();
    await page.getByRole('button', { name: '确定时间', exact: true }).click();
    await dialog.getByRole('button', { name: '保存腰围', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    assert.equal(writes.at(-1).input.measured_at, '2026-10-05T01:30:00.000Z');
    await expect(waistCard()).toContainText('80.4');

    await page.goto(base + `/?member_id=${members[0].id}&period=custom&from=2026-10-01&to=2026-10-01`);
    await expect(waistCard()).toContainText('80.4');
    await chartCount(5);
    assert(observationQueries.some(q => q.get('from') === '2026-09-30T16:00:00.000Z' && q.get('to') === '2026-10-01T16:00:00.000Z'));
    await page.goto(base + `/?member_id=${members[0].id}&period=all&zoom_from=2026-10-01T00%3A00%3A00Z&zoom_to=2026-10-02T00%3A00%3A00Z`);
    await chartCount(5);
    await expect(page.getByRole('button', { name: '恢复完整范围' })).toBeVisible();

    // Delayed old-member responses may never reappear after a selection changes.
    delayMember = members[1].id;
    await page.getByRole('tab', { name: '成员乙', exact: true }).click();
    await expect(waistCard()).not.toContainText('80.4');
    await page.getByRole('tab', { name: '无记录成员', exact: true }).click();
    await expect(waistCard()).toContainText('暂无有效测量');
    await page.waitForTimeout(800);
    await expect(waistCard()).not.toContainText('85.1');
    delayMember = '';

    // Waist failures preserve other metrics and previously loaded waist values.
    failWaist = true;
    await page.getByRole('tab', { name: '成员甲', exact: true }).click();
    await chartCount(4);
    await expect(waistCard()).toContainText('暂时无法读取');
    await expect(page.getByRole('alert')).toContainText('模拟腰围查询失败');
    failWaist = false; changed();
    await expect(waistCard()).toContainText('80.4');
    await chartCount(5);
    failWaist = true; changed();
    await expect(page.getByRole('alert')).toContainText('模拟腰围查询失败');
    await expect(waistCard()).toContainText('80.4');
    await chartCount(5);
    failWaist = false;
    assert.deepEqual(errors, []);
    console.log('PASS synthetic overview: stable SSE/offline refresh DOM/layout/scroll/focus, updated readings/charts, empty states, 5 charts, member cards, waist CRUD/SSE, decimal backfill, >200 points, validation, failure recovery, member isolation, date filters, zoom, 390/1440px layouts');
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); server.closeAllConnections(); server.close(); process.exitCode = 1; });
