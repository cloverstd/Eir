import test from "node:test";
import assert from "node:assert/strict";
import {applyZoom, loadSeries, metricSeries, referenceFor, zoomRange} from "../src/chartDomain.ts";
import {normalizeSearch} from "../src/routingDomain.ts";

const now = new Date("2026-10-18T04:00:00Z");
test("adult references respect age, sex, height and exact age-band boundaries", () => {
  const person = {sex: "male", birth_date: "1986-10-19", height_cm: 170};
  assert.deepEqual(referenceFor("body_fat", person, now).band, [8, 19.9]);
  assert.deepEqual(referenceFor("body_fat", {...person, birth_date: "1986-10-18"}, now).band, [11, 21.9]);
  assert.deepEqual(referenceFor("body_fat", {...person, sex: "female", birth_date: "1966-10-18"}, now).band, [24, 35.9]);
  assert.equal(referenceFor("body_fat", {...person, birth_date: "1945-10-18"}, now), undefined);
  assert.equal(referenceFor("weight", {...person, height_cm: null}, now), undefined);
  assert.equal(referenceFor("pulse", {...person, birth_date: "2010-01-01"}, now), undefined);
  assert.equal(referenceFor("weight", {height_cm: 170}, now), undefined);
  const band = referenceFor("weight", person, now).band;
  assert.ok(Math.abs(band[0] - 18.5 * 1.7 ** 2) < 1e-8);
  assert.ok(Math.abs(band[1] - 24 * 1.7 ** 2) < 1e-8);
  assert.deepEqual(referenceFor("pulse", person, now).band, [60, 100]);
});
test("original same-day measurements remain separate; missing and unlocked body values form gaps", () => {
  const rows = [
    {id: "b", kind: "body_composition", measured_at: "2026-10-18T09:00:00+08:00", weight_kg: 71, body_fat_pct: 0, body_fat_status: "missing_adc", weight_valid: true},
    {id: "a", kind: "body_composition", measured_at: "2026-10-18T08:00:00+08:00", weight_kg: 70, body_fat_pct: 20, body_fat_status: "estimated", weight_valid: true},
    {id: "c", kind: "body_composition", measured_at: "2026-10-18T10:00:00+08:00", weight_kg: 72, body_fat_pct: 21, body_fat_status: "estimated", weight_valid: false},
    {id: "d", kind: "body_composition", measured_at: null, weight_kg: 73},
  ];
  assert.deepEqual(metricSeries(rows, "weight")[0].data.map(point => point[1]), [70, 71, null]);
  assert.deepEqual(metricSeries(rows, "body_fat")[0].data.map(point => point[1]), [20, null, null]);
});
test("curve loader reads all cursor pages and deduplicates updated point IDs", async () => {
  const paths = [];
  const points = await loadSeries("kind=blood_pressure&page=9&page_size=50&member_id=member", async path => {
    paths.push(path);
    return paths.length === 1 ? {items: Array.from({length: 1000}, (_, n) => ({id: String(n), pulse: 60})), next_cursor: "second"} : {items: [{id: "999", pulse: 70}, {id: "1000", pulse: 80}], next_cursor: null};
  });
  assert.equal(points.length, 1001);
  assert.equal(points.find(point => point.id === "999").pulse, 70);
  assert.ok(!paths[0].includes("page="));
  assert.ok(paths[1].includes("cursor=second"));
  await assert.rejects(loadSeries("", async () => ({items: [], next_cursor: "repeat"})), /分页异常/);
});
test("zoom table/export bounds preserve the complete base series query and include the final millisecond", () => {
  const range = zoomRange("2026-10-18T08:12:00+08:00", "2026-10-18T09:27:00+08:00");
  const q = new URLSearchParams(applyZoom("kind=blood_pressure&member_id=m&from=2026-10-01T00:00:00Z", range));
  assert.equal(q.get("from"), "2026-10-18T00:12:00.000Z");
  assert.equal(q.get("to"), "2026-10-18T01:27:00.001Z");
  assert.equal(q.get("member_id"), "m");
  const encoded = new URLSearchParams({zoom_from: "2026-10-18T00:12:00.000Z", zoom_to: "2026-10-18T01:27:00.000Z", page: "2"}).toString();
  assert.equal(normalizeSearch(encoded), encoded);
  assert.equal(normalizeSearch("zoom_from=oops&zoom_to=oops&page=2"), "page=2");
  assert.equal(normalizeSearch("zoom_from=2026-10-19T00%3A00%3A00Z&zoom_to=2026-10-18T00%3A00%3A00Z"), "");
});
