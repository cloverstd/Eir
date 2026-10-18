#include "../main/queue_upload.h"
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <future>
#include <map>
#include <thread>

int main() {
  using namespace std::chrono_literals;
  std::mutex storage, mqtt, state;
  std::condition_variable changed;
  bool callback_ready = false, upload_ready = false;
  std::map<std::string, std::string> pending{{"first", "record-1"}, {"second", "record-2"}};
  // Reproduce the real ordering: MQTT owns its API lock and receives an ACK
  // while the uploader reads a queued file. Both tasks must make progress.
  auto callback = std::async(std::launch::async, [&] {
    std::lock_guard<std::mutex> api(mqtt);
    {
      std::unique_lock<std::mutex> lock(state);
      callback_ready = true;
      changed.notify_all();
      assert(changed.wait_for(lock, 2s, [&] { return upload_ready; }));
    }
    std::lock_guard<std::mutex> lock(storage);
    pending.erase("first");
  });
  {
    std::unique_lock<std::mutex> lock(state);
    assert(changed.wait_for(lock, 2s, [&] { return callback_ready; }));
  }
  size_t published = 0;
  auto upload = std::async(std::launch::async, [&] {
    queue_upload::send(storage, {"first", "second"}, [&](const std::string &name) {
      std::lock_guard<std::mutex> lock(state);
      upload_ready = true;
      changed.notify_all();
      return pending.at(name);
    }, [&](const std::string &payload) {
      std::lock_guard<std::mutex> api(mqtt);
      assert(!payload.empty());
      ++published;
      return true;
    });
  });
  assert(callback.wait_for(2s) == std::future_status::ready);
  assert(upload.wait_for(2s) == std::future_status::ready);
  callback.get();
  upload.get();
  assert(published == 2 && pending.size() == 1);
  // Missing files are harmless; a failed publish leaves the durable record
  // for retry and stops the batch. Only the ACK deletes a record.
  published = 0;
  queue_upload::send(storage, {"removed", "second", "second"}, [&](const std::string &name) {
    auto found = pending.find(name);
    return found == pending.end() ? std::string{} : found->second;
  }, [&](const std::string &) { ++published; return false; });
  assert(published == 1 && pending.size() == 1);
  published = 0;
  queue_upload::send(storage, {"second", "second"}, [&](const std::string &name) {
    return pending.at(name);
  }, [&](const std::string &) { ++published; return true; }, 1);
  assert(published == 1 && pending.size() == 1);
}
