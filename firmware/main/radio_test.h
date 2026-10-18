#pragma once
#include "eir.h"
#include "esp_http_server.h"
#include "host/ble_gap.h"
bool local_radio_allowed();
bool local_radio_active();
void local_radio_start(int seconds);
void local_radio_tick();
void local_radio_discover(const ble_gap_disc_desc &disc);
void local_radio_connection(const Device &device, int rssi, int64_t when);
esp_err_t local_radio_status(httpd_req_t *request);
