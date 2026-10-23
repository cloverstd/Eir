import test from "node:test";
import assert from "node:assert/strict";
import {healthQuery,memberAge,loadObservationSeries} from "../src/healthDomain.ts";
test("health ranges include the entire Shanghai end date and preserve metric/source filters",()=>{const q=new URLSearchParams(healthQuery("m","blood_pressure",2,"2026-10-17","2026-10-17","week","manual"));assert.equal(q.get("from"),"2026-10-16T16:00:00.000Z");assert.equal(q.get("to"),"2026-10-17T16:00:00.000Z");assert.equal(q.get("kind"),"blood_pressure");assert.equal(q.get("source"),"manual");assert.equal(q.get("page"),"2")});
test("month-only age is approximate and exact birthdays keep their precision",()=>{const now=new Date("2026-10-17T04:00:00Z");assert.equal(memberAge({birth_month:"1990-10"},now),"约 36 岁");assert.equal(memberAge({birth_date:"1990-10-18"},now),"35 岁");assert.equal(memberAge({birth_date:"1990-10-17"},now),"36 岁");assert.equal(memberAge({},now),"未填写出生信息")});

test("observation curves load every page, keep filters and deduplicate updated IDs", async () => {
  const paths = [];
  const query = healthQuery("member", "waist", 9, "2026-10-01", "2026-10-23");
  const rows = await loadObservationSeries(query, async (path) => {
    const q = new URLSearchParams(path.split("?")[1]);
    paths.push(q);
    return {
      items: q.get("page") === "1"
        ? Array.from({length: 200}, (_, n) => ({id: String(n), value: 80}))
        : [{id: "199", value: 80.5}, {id: "200", value: 81.25}],
      total: 202,
    };
  });
  assert.equal(rows.length, 201);
  assert.equal(rows.find(row => row.id === "199").value, 80.5);
  assert.deepEqual(paths.map(q => q.get("page")), ["1", "2"]);
  for (const q of paths) {
    assert.equal(q.get("page_size"), "200");
    assert.equal(q.get("member_id"), "member");
    assert.equal(q.get("kind"), "waist");
    assert.equal(q.get("from"), "2026-09-30T16:00:00.000Z");
    assert.equal(q.get("to"), "2026-10-23T16:00:00.000Z");
    assert.equal(q.has("group"), false);
  }
});
test("observation curves reject stalled paging and propagate cancellation or request failure", async () => {
  assert.deepEqual(await loadObservationSeries("kind=waist", async () => ({items: [], total: 0})), []);
  await assert.rejects(loadObservationSeries("", async () => ({items: [{id: "same"}], total: 1000})), /分页异常/);
  await assert.rejects(loadObservationSeries("", async () => ({items: [], total: NaN})), /分页异常/);
  const abort = new DOMException("Cancelled", "AbortError");
  await assert.rejects(loadObservationSeries("", async () => {throw abort;}), error => error === abort);
});
