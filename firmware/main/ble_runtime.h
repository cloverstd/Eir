#pragma once
#include "eir.h"
#include "host/ble_hs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
extern std::mutex ble_connect_mutex;
extern std::atomic<bool> ble_connecting;
void ble_resume_scan();
// Initiation is serialized; established connections continue independently.
struct BLEInitiation {
  std::unique_lock<std::mutex> lock;
  BLEInitiation():lock(ble_connect_mutex){ble_connecting=true;ble_gap_disc_cancel();}
  ~BLEInitiation(){ble_gap_disc_cancel();ble_connecting=false;lock.unlock();ble_resume_scan();}
};
void afu_discover(const ble_gap_disc_desc &disc);
void afu_scan_items(cJSON *array);
void afu_start();
void afu_pause();
bool afu_lifecycle(const Device &device,const std::string &type);
bool ble_connected(const std::string &device);
bool afu_connected(const std::string &device);
// Explicit, short-lived local diagnostics; never included in MQTT status.
void afu_trace_start(int seconds);
std::string afu_trace_json();
