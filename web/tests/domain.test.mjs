import test from "node:test";
import assert from "node:assert/strict";
import {
  measurementQuery,
  chartDay,
  measurementCorrection,
  isHistoryStart,
} from "../src/domain.ts";
const base = {
  member: "",
  device: "",
  unassigned: false,
  period: "30",
  from: "",
  to: "",
  group: "day",
  page: 1,
};
test("single selected Shanghai date is a half-open interval containing all of that day", () => {
  const q = new URLSearchParams(
    measurementQuery({
      ...base,
      period: "custom",
      from: "2026-10-17",
      to: "2026-10-17",
    }),
  );
  assert.equal(q.get("from"), "2026-10-16T16:00:00.000Z");
  assert.equal(q.get("to"), "2026-10-17T16:00:00.000Z");
  const accepts = (t) =>
    Date.parse(t) >= Date.parse(q.get("from")) &&
    Date.parse(t) < Date.parse(q.get("to"));
  assert.equal(accepts("2026-10-17T00:00:00+08:00"), true);
  assert.equal(accepts("2026-10-17T23:59:59+08:00"), true);
  assert.equal(accepts("2026-10-18T00:00:00+08:00"), false);
});
test("all-time unassigned query sends no time predicates so invalid device timestamps remain visible", () => {
  const q = new URLSearchParams(
    measurementQuery({
      ...base,
      unassigned: true,
      period: "all",
      from: "2026-10-01",
      to: "2026-10-17",
    }),
  );
  assert.equal(q.get("unassigned"), "true");
  assert.equal(q.has("from"), false);
  assert.equal(q.has("to"), false);
  assert.equal(q.has("member_id"), false);
});
test("rolling window preserves selected member, device, page and aggregation and ignores stale custom dates", () => {
  const q = new URLSearchParams(
    measurementQuery(
      {
        ...base,
        member: "member-1",
        device: "device-2",
        period: "7",
        from: "2020-01-01",
        to: "2020-02-01",
        group: "week",
        page: 3,
      },
      Date.parse("2026-10-17T10:00:00Z"),
    ),
  );
  assert.equal(q.get("from"), "2026-10-10T10:00:00.000Z");
  assert.equal(q.has("to"), false);
  assert.equal(q.get("member_id"), "member-1");
  assert.equal(q.get("device_id"), "device-2");
  assert.equal(q.get("page"), "3");
  assert.equal(q.get("group"), "week");
});
test("chart bucket UTC serialization displays the Shanghai day, including year rollover", () => {
  assert.equal(chartDay("2026-10-16T16:00:00Z"), "2026-10-17");
  assert.equal(chartDay("2026-12-31T16:00:00Z"), "2027-01-01");
});
test("notes-only edit preserves backend automatic member reassignment eligibility", () => {
  assert.deepEqual(measurementCorrection("member-1", "member-1", "饭后"), {
    notes: "饭后",
  });
  assert.deepEqual(measurementCorrection(null, "", "待确认"), {
    notes: "待确认",
  });
});
test("explicit reassignment and unassignment emit the member change, preserving notes", () => {
  assert.deepEqual(measurementCorrection("member-1", "member-2", "修正"), {
    member_id: "member-2",
    notes: "修正",
  });
  assert.deepEqual(measurementCorrection("member-1", "", ""), {
    member_id: null,
    notes: "",
  });
});

test("first binding historical sentinel does not pass through invalid JavaScript timestamp parsing", () => {
  assert.equal(isHistoryStart("0001-01-01T08:05:43+08:05:43"), true);
  assert.equal(isHistoryStart("2026-10-16T00:00:00+08:00"), false);
});
