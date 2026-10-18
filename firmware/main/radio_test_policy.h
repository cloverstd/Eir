#pragma once
#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <mutex>

// Device-local, fixed-size RAM only. No health records or MQTT publication.
namespace radio_test {
constexpr size_t capacity = 32;
constexpr int max_seconds = 300;
inline bool valid_rssi(int value) { return value >= -127 && value <= 20; }
struct Stats {
  int latest = 0, minimum = 0, maximum = 0;
  int64_t sum = 0, when = 0;
  uint32_t count = 0;
  void add(int value, int64_t now) {
    if (!valid_rssi(value) || (count && now < when)) return;
    if (!count) minimum = maximum = value;
    latest = value; minimum = std::min(minimum, value); maximum = std::max(maximum, value);
    sum += value; ++count; when = now;
  }
};
struct Address {
  uint8_t bytes[6]{};
  uint8_t type = 0;
  bool operator==(const Address &other) const {
    return type == other.type && memcmp(bytes, other.bytes, sizeof(bytes)) == 0;
  }
};
struct Payload {
  uint8_t bytes[31]{};
  uint8_t size = 0;
  bool truncated = false;
  void set(const uint8_t *data, size_t length) {
    size = std::min(length, sizeof(bytes)); truncated = length > sizeof(bytes);
    if (size) memcpy(bytes, data, size);
  }
};
// Safely iterate AD structures, including unknown and malformed broadcasters.
template <class F> bool fields(const Payload &payload, F visit) {
  for (size_t offset = 0; offset < payload.size;) {
    size_t length = payload.bytes[offset++];
    if (!length) return !payload.truncated;
    if (length > payload.size - offset) return false;
    visit(payload.bytes[offset], payload.bytes + offset + 1, length - 1);
    offset += length;
  }
  return !payload.truncated;
}
struct Entry {
  bool used = false;
  bool protected_target = false;
  Address address;
  uint8_t event_type = 0xff;
  int64_t first_seen = 0, last_seen = 0;
  Payload advertisement, response;
  Stats broadcast, connection;
};
struct Session { uint32_t id = 0, evictions = 0; int64_t started = 0, until = 0; bool active = false; };
class Cache {
  std::mutex mutex;
  std::array<Entry, capacity> entries{};
  Session session;
  bool accepting(int64_t now) const {
    return session.active && now >= session.started && now < session.until;
  }
  Entry *find(const Address &address, int64_t now) {
    for (auto &entry : entries) if (entry.used && entry.address == address) return &entry;
    Entry *target = nullptr;
    for (auto &entry : entries) if (!entry.used) { target = &entry; break; }
    if (!target) {
      for (auto &entry : entries)
        if (!entry.protected_target && (!target || entry.last_seen < target->last_seen)) target = &entry;
      if (!target) return nullptr;
      ++session.evictions;
    }
    *target = Entry{}; target->used = true; target->address = address; target->first_seen = now;
    return target;
  }
public:
  // A stop preserves the last run. Starting again discards only diagnostics.
  bool start(int seconds, int64_t now) {
    if (seconds < 0 || seconds > max_seconds) return false;
    std::lock_guard<std::mutex> lock(mutex);
    if (!seconds) { session.active = false; session.until = std::min(session.until, now); return true; }
    for (auto &entry : entries) entry = Entry{};
    ++session.id; session.evictions = 0; session.started = now;
    session.until = now + seconds * 1000LL; session.active = true;
    return true;
  }
  Session state(int64_t now) {
    std::lock_guard<std::mutex> lock(mutex);
    auto result = session; result.active = accepting(now); return result;
  }
  void protect(const Address &address, int64_t now) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!accepting(now)) return;
    if (auto entry = find(address, now)) {
      entry->protected_target = true;
      if (!entry->last_seen) entry->last_seen = now;
    }
  }
  void advertisement(const Address &address, int rssi, int64_t now,
                     uint8_t event_type, bool response, const uint8_t *data, size_t length) {
    if (!valid_rssi(rssi) || (length && !data)) return;
    std::lock_guard<std::mutex> lock(mutex);
    if (!accepting(now)) return;
    auto found = find(address, now);
    if (!found) return;
    auto &entry = *found;
    if (now < entry.last_seen) return;
    entry.last_seen = now;
    if (response) entry.response.set(data, length);
    else { entry.event_type = event_type; entry.advertisement.set(data, length); }
    entry.broadcast.add(rssi, now);
  }
  void connected(const Address &address, int rssi, int64_t now) {
    if (!valid_rssi(rssi)) return;
    std::lock_guard<std::mutex> lock(mutex);
    if (!accepting(now)) return;
    auto found = find(address, now);
    if (!found) return;
    auto &entry = *found;
    entry.protected_target = true;
    if (now < entry.last_seen) return;
    entry.last_seen = now; entry.connection.add(rssi, now);
  }
  // Copy one row at a time: neither a full table on task stack nor a large
  // cJSON tree is needed. A new session invalidates an in-flight snapshot.
  bool copy(size_t index, uint32_t session_id, Entry &entry) {
    std::lock_guard<std::mutex> lock(mutex);
    if (index >= capacity || session.id != session_id || !entries[index].used) return false;
    entry = entries[index]; return true;
  }
};
} // namespace radio_test
