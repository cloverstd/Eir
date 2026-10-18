#pragma once
#include "afu_protocol.h"
#include <array>
#include <cstdio>
#include <mutex>

// Optional, expiring diagnostics must not reserve a response-sized heap block
// while BLE collection and its durable queue are using the same small heap.
namespace scale_trace {
constexpr size_t capacity = 48;
struct Notice {
  uint16_t connection = 0, handle = 0, length = 0;
  uint8_t bytes[64]{};
};
struct Entry {
  Notice notice;
  uint32_t sequence = 0, milliseconds = 0;
  uint16_t expected_handle = 0;
};
struct Snapshot { uint32_t generation, count; bool active; };
class Buffer {
  std::mutex mutex;
  std::array<Entry, capacity> entries{};
  uint32_t generation = 0, count = 0;
  int64_t until = 0;
public:
  void start(int seconds, int64_t now) {
    std::lock_guard<std::mutex> lock(mutex);
    for (auto &entry : entries) entry = Entry{};
    ++generation;
    count = 0;
    until = seconds > 0 ? now + int64_t(std::min(seconds, 180)) * 1000 : 0;
  }
  void record(const Notice &notice, uint16_t expected_handle, int64_t now) {
    if (notice.length > sizeof(notice.bytes)) return;
    std::lock_guard<std::mutex> lock(mutex);
    if (now >= until) return;
    uint32_t sequence = ++count;
    entries[(sequence - 1) % capacity] = {notice, sequence, uint32_t(now), expected_handle};
  }
  Snapshot snapshot(int64_t now) {
    std::lock_guard<std::mutex> lock(mutex);
    return {generation, count, now < until};
  }
  bool copy(const Snapshot &snapshot, uint32_t sequence, Entry &entry) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!sequence || generation != snapshot.generation || sequence > snapshot.count) return false;
    const auto &stored = entries[(sequence - 1) % capacity];
    if (stored.sequence != sequence) return false;
    entry = stored;
    return true;
  }
};

// Copy only one bounded row, release the recorder lock, then send it. A slow
// browser must never block measurement reception or mix restarted trace runs.
template <typename Send> bool write_json(Buffer &buffer, int64_t now, Send send) {
  auto snapshot = buffer.snapshot(now);
  char chunk[512];
  int size = snprintf(chunk, sizeof(chunk), "{\"active\":%s,\"received\":%lu,\"entries\":[",
                      snapshot.active ? "true" : "false", static_cast<unsigned long>(snapshot.count));
  if (!send(chunk, size_t(size))) return false;
  bool first = true;
  uint32_t begin = snapshot.count > capacity ? snapshot.count - capacity + 1 : 1;
  for (uint32_t sequence = begin; sequence && sequence <= snapshot.count; ++sequence) {
    Entry entry;
    if (!buffer.copy(snapshot, sequence, entry)) continue;
    char raw_hex[sizeof(entry.notice.bytes) * 2 + 1];
    static constexpr char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < entry.notice.length; ++i) {
      raw_hex[i * 2] = digits[entry.notice.bytes[i] >> 4];
      raw_hex[i * 2 + 1] = digits[entry.notice.bytes[i] & 15];
    }
    raw_hex[entry.notice.length * 2] = 0;
    afu::Packet packet;
    bool parsed = afu::parse(std::vector<uint8_t>(entry.notice.bytes, entry.notice.bytes + entry.notice.length), packet);
    size = snprintf(chunk, sizeof(chunk), "%s{\"sequence\":%lu,\"uptime_ms\":%lu,\"connection\":%u,\"handle\":%u,\"expected_handle\":%u,\"raw_hex\":\"%s\",\"parsed\":%s",
                    first ? "" : ",", static_cast<unsigned long>(entry.sequence),
                    static_cast<unsigned long>(entry.milliseconds), unsigned(entry.notice.connection),
                    unsigned(entry.notice.handle), unsigned(entry.expected_handle), raw_hex, parsed ? "true" : "false");
    if (size < 0 || size_t(size) >= sizeof(chunk)) return false;
    if (parsed) {
      int extra = snprintf(chunk + size, sizeof(chunk) - size, ",\"opcode\":%u,\"grams\":%d,\"stable\":%s",
                           unsigned(packet.opcode), packet.grams, packet.stable ? "true" : "false");
      if (extra < 0 || size_t(extra) >= sizeof(chunk) - size) return false;
      size += extra;
    }
    if (size_t(size) + 1 >= sizeof(chunk)) return false;
    chunk[size++] = '}';
    if (!send(chunk, size_t(size))) return false;
    first = false;
  }
  return send("]}", 2);
}
} // namespace scale_trace
