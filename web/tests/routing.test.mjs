import test from "node:test";
import assert from "node:assert/strict";
import {routeForPath,normalizeSearch} from "../src/routingDomain.ts";
import {signalLevel,signalFresh,signalLinkState} from "../src/signalDomain.ts";
test("routes preserve member deep links and reject unknown sections",()=>{
 assert.equal(routeForPath("/body").page,"body");
 assert.equal(routeForPath("/members/id").section,"basic");
 assert.equal(routeForPath("/members/id/documents").memberId,"id");
 assert.equal(routeForPath("/members/id/nope").page,"not-found");
 assert.equal(routeForPath("/unknown").page,"not-found");
});
test("invalid URL filters are corrected without resetting a restored page",()=>{
 assert.equal(normalizeSearch("?page=7&period=all&group=week"),"page=7&period=all&group=week");
 assert.equal(normalizeSearch("?page=-1&period=oops&from=2026-02-30&device_id=oops"),"");
 assert.equal(normalizeSearch("?page=NaN&group=oops&signal_range=forever"),"");
 assert.equal(normalizeSearch("?from=2026-10-18&to=2026-10-17"),"from=2026-10-18");
});
test("RSSI levels and freshness have exact boundaries",()=>{
 assert.equal(signalLevel(-60).bars,4);assert.equal(signalLevel(-61).bars,3);
 assert.equal(signalLevel(-75).bars,3);assert.equal(signalLevel(-85).bars,2);
 assert.equal(signalLevel(-86).bars,1);assert.equal(signalLevel(null).bars,0);
 assert(signalFresh(new Date(1000).toISOString(),16000));
 assert(!signalFresh(new Date(1000).toISOString(),16001));
 assert(!signalFresh(null,1000));
});
test("short connection samples stay distinguishable after disconnect",()=>{
 assert.equal(signalLinkState("connection",false),"最近连接信号 · 当前未连接");
 assert.equal(signalLinkState("advertisement",false),"最近收到蓝牙广播");
 assert.equal(signalLinkState("connection",true),"蓝牙已连接");
});
