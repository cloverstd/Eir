#pragma once
#include "cJSON.h"
#include <atomic>
#include <mutex>
#include <string>
#include <vector>
struct Device {
  std::string id, address, profile, hardware_id;
  int address_type = 0;
  bool enabled = true;
};
extern std::string collector_id, last_error;
extern std::mutex state_mutex;
extern std::atomic<bool> upgrading, ble_busy;
std::string js(cJSON *value);
std::string str(const cJSON *j, const char *key, const char *fallback = "");
int num(const cJSON *j, const char *key, int fallback = 0);
void error(const std::string &message);
void event(const std::string &command, const char *type, const char *status,
           const std::string &data = "{}", const std::string &err = "");
std::vector<Device> devices();
void observe(const Device &, int user, const std::vector<uint8_t> &raw);
bool file_exists(const std::string &path);
bool enqueue(const Device &, int user, const std::vector<uint8_t> &raw);
void ble_start();
void ble_pause_for_ota();
void ble_command(const std::string &command, const std::string &type,
                 const std::string &device);
std::string ble_scan_json();

extern std::atomic<bool> lifecycle_busy;
bool collection_enabled();
bool lifecycle_bound();
bool ble_lifecycle(const std::string &type, const std::string &device);
std::string record_fingerprint(int user, const std::vector<uint8_t> &raw);

extern std::mutex radio_mutex;

extern std::atomic<bool> lifecycle_storage_fault;
bool remove_file(const std::string &path);

bool enqueue_scale(const Device &, const std::string &session, const std::string &captured_at, const std::vector<uint8_t> &weight, const std::vector<uint8_t> &adc);
