#include "../main/radio_test_policy.h"
#include <atomic>
#include <cassert>
#include <thread>

using namespace radio_test;
static Address addr(uint8_t value, uint8_t type = 0) {
  Address result; result.bytes[0] = value; result.type = type; return result;
}
int main() {
  Cache cache; Entry entry;
  const uint8_t adv[] = {3, 3, 0x4a, 0xfe, 3, 0xff, 0x0e, 2};
  const uint8_t response[] = {5, 9, 't', 'e', 's', 't'};
  auto record = [&](Address address, int rssi, int64_t when) {
    cache.advertisement(address, rssi, when, 0, false, adv, sizeof(adv));
  };
  record(addr(1), -60, 0); assert(!cache.copy(0, 0, entry));
  assert(!cache.start(301, 0)); assert(!cache.start(-1, 0));
  assert(cache.start(60, 1000)); const auto first = cache.state(1000).id;
  record(addr(1), -60, 999); assert(!cache.copy(0, first, entry));
  record(addr(1), 127, 1000); assert(!cache.copy(0, first, entry));
  record(addr(1), -60, 1000); record(addr(1), -80, 2000);
  cache.advertisement(addr(1), -70, 3000, 4, true, response, sizeof(response));
  cache.connected(addr(1), -50, 3500);
  assert(cache.copy(0, first, entry));
  assert(entry.broadcast.count == 3 && entry.broadcast.sum == -210);
  assert(entry.broadcast.minimum == -80 && entry.broadcast.maximum == -60);
  assert(entry.connection.count == 1 && entry.connection.latest == -50);
  assert(entry.advertisement.size == sizeof(adv) && entry.response.size == sizeof(response));
  assert(entry.event_type == 0); // Scan response must not hide connectability.
  record(addr(1), -90, 1500); assert(cache.copy(0, first, entry));
  assert(entry.broadcast.count == 3 && entry.last_seen == 3500);
  record(addr(1, 1), -65, 4000); assert(cache.copy(1, first, entry));
  assert(entry.address.type == 1); // Same MAC, different address type.
  assert(cache.state(60999).active && !cache.state(61000).active);
  record(addr(2), -50, 61000); assert(!cache.copy(2, first, entry));
  assert(cache.start(0, 62000)); assert(cache.copy(0, first, entry));
  assert(cache.state(62000).until == 61000); // Expiry stays fixed after a later stop.
  cache.connected(addr(1), -10, 62001); assert(cache.copy(0, first, entry));
  assert(entry.connection.latest == -50); // Stop keeps results without mutation.
  assert(cache.start(300, 70000)); const auto second = cache.state(70000).id;
  assert(second != first && !cache.copy(0, first, entry));
  record(addr(1), -60, 69999); assert(!cache.copy(0, second, entry));
  for (size_t i = 0; i < capacity + 4; ++i) record(addr(i), -65, 70000+i);
  assert(cache.state(71000).evictions == 4);
  for (size_t i = 0; i < capacity; ++i) {
    assert(cache.copy(i, second, entry)); assert(entry.address.bytes[0] >= 4);
  }
  assert(cache.start(0, 71000)); assert(cache.state(72000).until == 71000);
  // Crowded airspace must not evict an assigned scale sampled every 2 seconds
  // between hundreds of unrelated advertisements. Preserve sleeping targets too.
  Cache crowded; crowded.start(300, 1);
  auto crowded_id = crowded.state(1).id;
  crowded.protect(addr(250), 1); crowded.protect(addr(251), 1);
  for (int round = 0; round < 20; ++round) {
    crowded.connected(addr(250), -80, 2 + round * 2000);
    for (int i = 0; i < 200; ++i)
      crowded.advertisement(addr(i), -60, 3 + round * 2000 + i, 0, false, adv, sizeof(adv));
    assert(crowded.copy(0, crowded_id, entry));
    assert(entry.address == addr(250) && entry.connection.count == uint32_t(round + 1));
    assert(crowded.copy(1, crowded_id, entry));
    assert(entry.address == addr(251) && !entry.broadcast.count && !entry.connection.count);
  }
  assert(crowded.state(50000).evictions > 1000);
  Cache full; full.start(300, 1);
  for (size_t i = 0; i < capacity; ++i) full.protect(addr(i), 1);
  full.advertisement(addr(250), -60, 2, 0, false, adv, sizeof(adv));
  assert(full.state(2).evictions == 0);
  assert(full.copy(0, full.state(2).id, entry) && entry.address == addr(0));
  Payload payload; int visited = 0;
  payload.set(adv, sizeof(adv));
  assert(fields(payload, [&](uint8_t, const uint8_t *, size_t length) { assert(length == 2); ++visited; }));
  assert(visited == 2);
  const uint8_t broken[] = {0xff, 9, 0}; payload.set(broken, sizeof(broken));
  assert(!fields(payload, [](uint8_t, const uint8_t *, size_t) { assert(false); }));
  // Fuzz AD lengths, zero terminators and truncation; the callback never reads
  // beyond the stored packet even when the advertised field length is invalid.
  uint8_t bytes[64]; uint32_t random = 17;
  for (size_t iteration = 0; iteration < 10000; ++iteration) {
    for (auto &byte : bytes) { random = random * 1664525 + 1013904223; byte = random >> 24; }
    payload.set(bytes, iteration % sizeof(bytes));
    fields(payload, [&](uint8_t, const uint8_t *data, size_t length) {
      assert(data >= payload.bytes && data + length <= payload.bytes + payload.size);
    });
  }
  // BLE callbacks, HTTP start/stop/snapshot and the periodic connection sampler
  // share this cache. Concurrent restarts must not produce torn rows or stats.
  Cache concurrent; std::atomic<int64_t> now{1};
  std::thread writer([&] { for (int i = 0; i < 3000; ++i) {
    auto t = now.fetch_add(1); concurrent.advertisement(addr(i%64), -70, t, 0, false, adv, sizeof(adv));
  }});
  std::thread sampler([&] { for (int i = 0; i < 3000; ++i) concurrent.connected(addr(i%64), -50, now.fetch_add(1)); });
  for (int i = 0; i < 300; ++i) {
    concurrent.start(i%7 ? 300 : 0, now.fetch_add(1));
    auto session = concurrent.state(now);
    for (size_t slot = 0; slot < capacity; ++slot) if (concurrent.copy(slot, session.id, entry)) {
      assert(entry.used && entry.last_seen >= session.started);
      assert(!entry.broadcast.count || entry.broadcast.sum == -70LL * entry.broadcast.count);
      assert(!entry.connection.count || entry.connection.sum == -50LL * entry.connection.count);
    }
  }
  writer.join(); sampler.join();
}
