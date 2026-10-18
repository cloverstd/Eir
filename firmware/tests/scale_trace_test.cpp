#include "../main/scale_trace.h"
#include <atomic>
#include <cassert>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <thread>

static size_t allocation_limit = std::numeric_limits<size_t>::max();
static size_t largest_allocation = 0;
void *operator new(size_t size) {
  largest_allocation = std::max(largest_allocation, size);
  if (size > allocation_limit) throw std::bad_alloc();
  if (auto memory = std::malloc(size ? size : 1)) return memory;
  throw std::bad_alloc();
}
void operator delete(void *memory) noexcept { std::free(memory); }
void operator delete(void *memory, size_t) noexcept { std::free(memory); }

using namespace scale_trace;
static Notice notice(const char *hex) {
  Notice out; out.connection = 1; out.handle = 33;
  while (*hex) {
    unsigned value;
    assert(sscanf(hex, "%2x", &value) == 1);
    out.bytes[out.length++] = uint8_t(value);
    hex += 2;
  }
  return out;
}
struct Output {
  char bytes[32768]{};
  size_t size = 0, largest_chunk = 0;
  bool send(const char *data, size_t length) {
    assert(size + length < sizeof(bytes));
    memcpy(bytes + size, data, length);
    size += length; bytes[size] = 0;
    largest_chunk = std::max(largest_chunk, length);
    return true;
  }
};
int main() {
  Buffer buffer; Entry row;
  auto weight = notice("ac298069117002000540000a000000000029d51b");
  auto adc = notice("ac29020001f401c20180691170000000000029d60f");
  buffer.record(weight, 33, 1);
  assert(buffer.snapshot(1).count == 0);
  buffer.start(180, 10);
  for (int i = 0; i < 83; ++i) buffer.record(i >= 79 ? adc : weight, 33, 11 + i);
  auto snapshot = buffer.snapshot(100);
  assert(snapshot.active && snapshot.count == 83);
  assert(!buffer.copy(snapshot, 35, row));
  assert(buffer.copy(snapshot, 36, row) && row.sequence == 36);

  // A populated response used to reserve >12 KiB plus a full ring copy.
  // It must now succeed even if no heap allocation larger than 128 B works.
  Output output;
  largest_allocation = 0; allocation_limit = 128;
  assert(write_json(buffer, 100, [&](const char *data, size_t size) { return output.send(data, size); }));
  allocation_limit = std::numeric_limits<size_t>::max();
  assert(largest_allocation <= sizeof(Notice::bytes));
  assert(output.size > 8000 && output.largest_chunk < 512);
  assert(strstr(output.bytes, "\"received\":83"));
  assert(strstr(output.bytes, "\"sequence\":36,"));
  assert(!strstr(output.bytes, "\"sequence\":35,"));
  assert(strstr(output.bytes, "\"opcode\":213,\"grams\":70000,\"stable\":true"));
  assert(strstr(output.bytes, "\"opcode\":214,\"grams\":70000,\"stable\":false"));
  assert(strcmp(output.bytes + output.size - 2, "]}") == 0);

  int sends = 0;
  assert(!write_json(buffer, 100, [&](const char *, size_t) { return ++sends < 3; }));
  assert(sends == 3); // Stop promptly on a disconnected HTTP client.
  Output restarted;
  assert(write_json(buffer, 100, [&](const char *data, size_t size) {
    bool result = restarted.send(data, size);
    buffer.start(180, 100);
    buffer.record(adc, 99, 101);
    return result;
  }));
  assert(strstr(restarted.bytes, "\"entries\":[]}"));
  assert(!buffer.copy(snapshot, 1, row)); // Never mix two diagnostic sessions.

  buffer.start(1, 1000);
  buffer.record(weight, 33, 1999); buffer.record(adc, 33, 2000);
  assert(!buffer.snapshot(2000).active && buffer.snapshot(2000).count == 1);
  buffer.start(0, 2001);
  Output empty;
  assert(write_json(buffer, 2001, [&](const char *data, size_t size) { return empty.send(data, size); }));
  assert(strcmp(empty.bytes, "{\"active\":false,\"received\":0,\"entries\":[]}") == 0);
  auto bad = weight; bad.length = 65;
  buffer.start(180, 0); buffer.record(bad, 33, 1);
  assert(buffer.snapshot(1).count == 0);

  // Sending a slow response must not hold the producer lock. Force a ring
  // overwrite during a send, then ensure no row from a newer snapshot leaks.
  buffer.start(180, 0);
  for (int i = 0; i < 48; ++i) buffer.record(weight, 33, i + 1);
  Output overwritten; sends = 0;
  assert(write_json(buffer, 100, [&](const char *data, size_t size) {
    if (++sends == 2) {
      std::thread producer([&] { for (int i = 0; i < 48; ++i) buffer.record(adc, 33, i + 101); });
      producer.join();
    }
    return overwritten.send(data, size);
  }));
  assert(strstr(overwritten.bytes, "\"sequence\":1,"));
  assert(!strstr(overwritten.bytes, "\"sequence\":49,"));
}
