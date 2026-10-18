import test from "node:test";
import assert from "node:assert/strict";
import {openRealtimeStream} from "../src/realtimeStream.ts";

function fixture() {
  const sources = [], tasks = new Map(), states = [];
  let changes = 0, signals = 0, id = 0, clock = 0;
  const connection = openRealtimeStream({
    change: () => changes++, signals: () => signals++, status: state => states.push(state),
    now: () => clock,
    create: () => {const listeners = {}; const source = {readyState: 0, onopen: null, onerror: null, closed: false, addEventListener: (type, fn) => {listeners[type] = fn;}, close() {this.closed = true; this.readyState = 2;}, emit(type) {listeners[type]?.();}}; sources.push(source); return source;},
    schedule: (callback, delay) => {tasks.set(++id, {callback, delay}); return id;},
    cancel: timer => tasks.delete(timer),
  });
  return {connection, sources, tasks, states, advance: value=>{clock+=value; connection.check();}, counts: () => ({changes, signals}), next: () => {const [key, task] = [...tasks][0]; tasks.delete(key); task.callback();}};
}
test("closed SSE reconnects with bounded backoff, ignoring duplicate errors and stale events", () => {
  const f = fixture(), first = f.sources[0];
  first.readyState = 1; first.onopen();
  first.emit("signals"); first.emit("change");
  assert.deepEqual(f.counts(), {changes: 2, signals: 2});
  first.onerror(); first.onerror(); first.emit("change");
  assert.equal(first.closed, true);
  assert.equal(f.tasks.size, 1);
  assert.equal([...f.tasks.values()][0].delay, 1000);
  f.next(); f.sources[1].onerror();
  assert.equal([...f.tasks.values()][0].delay, 2000);
  f.next(); f.sources[2].readyState = 1; f.sources[2].onopen();
  assert.equal(f.connection.isOpen(), true);
  assert.deepEqual(f.counts(), {changes: 3, signals: 3});
  assert.deepEqual(f.states, ["connected", "reconnecting", "reconnecting", "connected"]);
  f.sources[2].onerror();
  assert.equal([...f.tasks.values()][0].delay, 1000);
  f.connection.close();
});
test("unmount cancels the pending reconnect and closes the only active stream", () => {
  const f = fixture(); f.sources[0].onerror();
  f.connection.close();
  assert.equal(f.tasks.size, 0);
  assert.equal(f.connection.isOpen(), false);
  f.sources[0].onopen(); f.sources[0].emit("change");
  assert.deepEqual(f.counts(), {changes: 0, signals: 0});
});
test("heartbeat watchdog replaces a silent proxy connection without polling healthy data", () => {
  const f=fixture(); f.sources[0].readyState=1; f.sources[0].onopen();
  f.advance(20000); f.sources[0].emit("heartbeat"); f.advance(30000);
  assert.equal(f.connection.isOpen(),true);
  assert.deepEqual(f.counts(),{changes:1,signals:1});
  f.advance(16000);
  assert.equal(f.connection.isOpen(),false);
  assert.equal(f.sources[0].closed,true);
  assert.equal(f.tasks.size,1);
  f.connection.close();
});
