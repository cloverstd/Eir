#pragma once
#include <cstddef>
#include <mutex>
#include <string>
#include <vector>

namespace queue_upload {
// MQTT delivers acknowledgements while holding its own API lock. Never keep
// the storage lock across publish: the acknowledgement needs that same lock.
template <typename Load, typename Publish>
void send(std::mutex &mutex, const std::vector<std::string> &files,
          Load load, Publish publish, size_t limit = 8) {
  size_t count = 0;
  for (const auto &name : files) {
    if (count++ >= limit)
      break;
    std::string payload;
    {
      std::lock_guard<std::mutex> lock(mutex);
      payload = load(name);
    }
    // An ACK or lifecycle operation may have removed a snapshotted file.
    if (!payload.empty() && !publish(payload))
      break;
  }
}
}
