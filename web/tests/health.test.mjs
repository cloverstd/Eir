import test from "node:test";
import assert from "node:assert/strict";
import {healthQuery,memberAge} from "../src/healthDomain.ts";
test("health ranges include the entire Shanghai end date and preserve metric/source filters",()=>{const q=new URLSearchParams(healthQuery("m","blood_pressure",2,"2026-10-17","2026-10-17","week","manual"));assert.equal(q.get("from"),"2026-10-16T16:00:00.000Z");assert.equal(q.get("to"),"2026-10-17T16:00:00.000Z");assert.equal(q.get("kind"),"blood_pressure");assert.equal(q.get("source"),"manual");assert.equal(q.get("page"),"2")});
test("month-only age is approximate and exact birthdays keep their precision",()=>{const now=new Date("2026-10-17T04:00:00Z");assert.equal(memberAge({birth_month:"1990-10"},now),"约 36 岁");assert.equal(memberAge({birth_date:"1990-10-18"},now),"35 岁");assert.equal(memberAge({birth_date:"1990-10-17"},now),"36 岁");assert.equal(memberAge({},now),"未填写出生信息")});
