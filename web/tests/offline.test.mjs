import test from "node:test";
import assert from "node:assert/strict";
import { localRead, cacheKey } from "../src/offlineData.ts";
const now = new Date().toISOString(),
  old = new Date(Date.now() - 91 * 86400000).toISOString();
const snapshot = {
  instance_id: "i",
  data_epoch: "e",
  synced_at: now,
  window_start: old,
  members: [
    { id: "a", name: "甲" },
    { id: "b", name: "乙" },
  ],
  observations: [
    {
      id: "1",
      member_id: "a",
      kind: "waist",
      value: 80,
      unit: "cm",
      measured_at: now,
    },
    {
      id: "2",
      member_id: "b",
      kind: "waist",
      value: 90,
      unit: "cm",
      measured_at: now,
    },
    {
      id: "3",
      member_id: "a",
      kind: "waist",
      value: 99,
      unit: "cm",
      measured_at: old,
    },
  ],
  measurements: [
    {
      id: "m1",
      member_id: "a",
      kind: "blood_pressure",
      systolic: 120,
      diastolic: 80,
      pulse: 70,
      measured_at: now,
      time_valid: true,
      weight_valid: true,
    },
    {
      id: "m2",
      member_id: "b",
      kind: "blood_pressure",
      systolic: 130,
      diastolic: 85,
      pulse: 75,
      measured_at: now,
      time_valid: true,
      weight_valid: true,
    },
  ],
  history: [{ id: "h", member_id: "a", kind: "condition", title: "过敏" }],
  documents: [{ id: "d", member_id: "a", category: "lab", title: "化验单" }],
};
test("offline routes retain member isolation, 90-day limit and pagination", () => {
  assert.deepEqual(localRead("members", snapshot), snapshot.members);
  assert.equal(
    localRead("health/observations?member_id=a&kind=waist", snapshot).total,
    1,
  );
  assert.equal(
    localRead("health/observations?page_size=1&page=2", snapshot).items.length,
    1,
  );
  assert.equal(
    localRead("measurements?member_id=b", snapshot).items[0].id,
    "m2",
  );
  assert.throws(() => localRead("members/unknown", snapshot));
});
test("overview curves and latest values use the same snapshot", () => {
  assert.equal(
    localRead("measurements/series?kind=blood_pressure", snapshot).items.length,
    2,
  );
  assert.equal(
    localRead("measurements/latest?member_id=a", snapshot).items.length,
    2,
  );
  assert.equal(
    localRead("measurements/latest?member_id=a", snapshot).items.find(
      (r) => r.metric === "blood_pressure",
    ).value_secondary,
    80,
  );
});
test("offline statistics never combine members or different units", () => {
  const result = localRead(
    "health/statistics?member_id=a&kind=waist&group=day",
    snapshot,
  );
  assert.equal(result.items[0].mean, 80);
  assert.equal(result.items[0].count, 1);
});
test("profile history and document metadata can be queried offline; original files cannot", () => {
  assert.equal(
    localRead("health/history?member_id=a&search=过敏", snapshot).total,
    1,
  );
  assert.equal(
    localRead("health/documents?member_id=a&kind=lab", snapshot).total,
    1,
  );
  assert.throws(() => localRead("documents/d/download", snapshot));
  assert.equal(cacheKey("devices?b=2&a=1"), cacheKey("devices?a=1&b=2"));
});
