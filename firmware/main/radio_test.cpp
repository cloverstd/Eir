#include "radio_test.h"
#include "radio_test_policy.h"
#include "ble_runtime.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include <cstdio>
#include <set>

namespace {
radio_test::Cache cache;
std::mutex wifi_mutex;
radio_test::Stats wifi_stats;
uint8_t wifi_bssid[6]{};
int64_t millis() { return esp_timer_get_time() / 1000; }
radio_test::Address address(const ble_addr_t &value) {
  radio_test::Address result; memcpy(result.bytes, value.val, 6); result.type = value.type; return result;
}
std::string mac(const radio_test::Address &value) {
  char out[18]; const auto &b = value.bytes;
  snprintf(out, sizeof(out), "%02X:%02X:%02X:%02X:%02X:%02X", b[5], b[4], b[3], b[2], b[1], b[0]);
  return out;
}
std::string hex(const uint8_t *bytes, size_t count, bool reverse = false) {
  static const char digits[] = "0123456789ABCDEF";
  std::string result; result.reserve(count * 2);
  for (size_t i = 0; i < count; ++i) {
    auto b = bytes[reverse ? count - i - 1 : i]; result += digits[b >> 4]; result += digits[b & 15];
  }
  return result;
}
// Radio names and SSIDs are arbitrary bytes. Keep valid UTF-8, replace invalid
// sequences/control characters so one broadcaster cannot break JSON decoding.
std::string text(const uint8_t *bytes, size_t size) {
  std::string out;
  for (size_t i = 0; i < size;) {
    uint8_t c = bytes[i]; size_t n = c < 0x80 ? 1 : c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
    bool valid = n && i + n <= size;
    for (size_t k = 1; valid && k < n; ++k) valid = (bytes[i + k] & 0xc0) == 0x80;
    if (valid && n >= 3) valid = !(c == 0xe0 && bytes[i+1] < 0xa0) && !(c == 0xed && bytes[i+1] >= 0xa0) && !(c == 0xf0 && bytes[i+1] < 0x90) && !(c == 0xf4 && bytes[i+1] >= 0x90);
    if (!valid) { out += '?'; ++i; }
    else { if (c < 0x20 || c == 0x7f) out += '?'; else out.append(reinterpret_cast<const char *>(bytes+i), n); i += n; }
  }
  return out;
}
void stats(cJSON *parent, const char *key, const radio_test::Stats &s, int64_t now) {
  if (!s.count) { cJSON_AddNullToObject(parent, key); return; }
  auto j = cJSON_AddObjectToObject(parent, key);
  cJSON_AddNumberToObject(j, "rssi", s.latest);
  cJSON_AddNumberToObject(j, "min", s.minimum); cJSON_AddNumberToObject(j, "max", s.maximum);
  cJSON_AddNumberToObject(j, "mean", double(s.sum) / s.count);
  cJSON_AddNumberToObject(j, "count", s.count);
  cJSON_AddNumberToObject(j, "age_ms", std::max<int64_t>(0, now - s.when));
  cJSON_AddNumberToObject(j, "at_ms", s.when);
}
esp_err_t send_json(httpd_req_t *r, cJSON *j) {
  auto out = js(j); cJSON_Delete(j); return httpd_resp_send_chunk(r, out.c_str(), out.size());
}
void details(cJSON *j, const radio_test::Entry &entry) {
  std::string name; bool complete = false, valid = true;
  std::set<std::string> uuids, manufacturers;
  bool has_tx = false; int tx = 0;
  for (const auto *payload : {&entry.advertisement, &entry.response}) {
    valid &= radio_test::fields(*payload, [&](uint8_t type, const uint8_t *bytes, size_t length) {
      if ((type == 8 || type == 9) && length && (!complete || type == 9)) { name = text(bytes, length); complete = type == 9; }
      if (type == 0xff && length >= 2) manufacturers.insert(hex(bytes, 2, true));
      if (type == 0x0a && length == 1) { has_tx = true; tx = int8_t(bytes[0]); }
      size_t width = (type == 2 || type == 3 || type == 0x16) ? 2 : (type == 4 || type == 5 || type == 0x20) ? 4 : (type == 6 || type == 7 || type == 0x21) ? 16 : 0;
      if (width) {
        bool service_data = type == 0x16 || type == 0x20 || type == 0x21;
        for (size_t offset = 0; offset + width <= length; offset += width) {
          auto uuid = hex(bytes + offset, width, true);
          if (width == 16) uuid = uuid.substr(0,8)+"-"+uuid.substr(8,4)+"-"+uuid.substr(12,4)+"-"+uuid.substr(16,4)+"-"+uuid.substr(20);
          uuids.insert(uuid); if (service_data) break;
        }
      }
    });
  }
  cJSON_AddStringToObject(j, "name", name.c_str());
  cJSON_AddBoolToObject(j, "payload_valid", valid);
  auto services = cJSON_AddArrayToObject(j, "services");
  for (const auto &uuid : uuids) cJSON_AddItemToArray(services, cJSON_CreateString(uuid.c_str()));
  auto companies = cJSON_AddArrayToObject(j, "manufacturer_ids");
  for (const auto &id : manufacturers) cJSON_AddItemToArray(companies, cJSON_CreateString(id.c_str()));
  if (has_tx) cJSON_AddNumberToObject(j, "tx_power", tx); else cJSON_AddNullToObject(j, "tx_power");
  cJSON_AddStringToObject(j, "advertisement_hex", hex(entry.advertisement.bytes, entry.advertisement.size).c_str());
  cJSON_AddStringToObject(j, "scan_response_hex", hex(entry.response.bytes, entry.response.size).c_str());
  const char *hint = name.rfind("AFU-WL",0) == 0 ? "阿福体脂秤广播" : uuids.count("FE4A") || manufacturers.count("020E") ? "Omron 广播" : "BLE 设备";
  cJSON_AddStringToObject(j, "hint", hint);
}
} // namespace

bool local_radio_active() { return cache.state(millis()).active; }
void local_radio_start(int seconds) {
  std::lock_guard<std::mutex> lock(wifi_mutex);
  cache.start(seconds, millis());
  if (seconds) { wifi_stats = {}; memset(wifi_bssid, 0, sizeof(wifi_bssid)); }
}
void local_radio_discover(const ble_gap_disc_desc &disc) {
  ble_addr_t advertiser = disc.addr;
#if MYNEWT_VAL(BLE_HOST_BASED_PRIVACY)
  advertiser = disc.ota_addr;
#endif
  cache.advertisement(address(advertiser), disc.rssi, millis(), disc.event_type,
      disc.event_type == BLE_HCI_ADV_RPT_EVTYPE_SCAN_RSP, disc.data, disc.length_data);
}
void local_radio_connection(const Device &device, int rssi, int64_t when) {
  radio_test::Address addr; unsigned b[6];
  if (sscanf(device.address.c_str(), "%x:%x:%x:%x:%x:%x", &b[5], &b[4], &b[3], &b[2], &b[1], &b[0]) != 6) return;
  for (size_t i = 0; i < 6; ++i) addr.bytes[i] = b[i];
  addr.type = device.address_type; cache.connected(addr, rssi, when);
}
void local_radio_tick() {
  const auto session = cache.state(millis());
  if (!session.active) return;
  if (!local_radio_allowed()) { local_radio_start(0); return; }
  ble_sample_signals(); afu_sample_signals();
  wifi_ap_record_t ap{};
  bool connected = esp_wifi_sta_get_ap_info(&ap) == ESP_OK;
  std::lock_guard<std::mutex> lock(wifi_mutex);
  const auto current = cache.state(millis());
  if (!current.active || current.id != session.id || !connected) return;
  if (memcmp(wifi_bssid, ap.bssid, 6)) { wifi_stats = {}; memcpy(wifi_bssid, ap.bssid, 6); }
  wifi_stats.add(ap.rssi, millis());
}
esp_err_t local_radio_status(httpd_req_t *r) {
  const auto now = millis(); const auto session = cache.state(now);
  auto j = cJSON_CreateObject();
  cJSON_AddNumberToObject(j, "session_id", session.id);
  cJSON_AddNumberToObject(j, "uptime_ms", now);
  cJSON_AddBoolToObject(j, "active", session.active);
  cJSON_AddNumberToObject(j, "remaining_ms", session.active ? session.until - now : 0);
  cJSON_AddNumberToObject(j, "until_ms", session.until);
  cJSON_AddBoolToObject(j, "scanning", ble_gap_disc_active());
  cJSON_AddBoolToObject(j, "available", local_radio_allowed());
  cJSON_AddBoolToObject(j, "connecting", ble_connecting);
  cJSON_AddNumberToObject(j, "capacity", radio_test::capacity);
  cJSON_AddNumberToObject(j, "evictions", session.evictions);
  wifi_ap_record_t ap{}; bool connected = esp_wifi_sta_get_ap_info(&ap) == ESP_OK;
  auto wifi = cJSON_AddObjectToObject(j, "wifi");
  cJSON_AddBoolToObject(wifi, "connected", connected);
  if (connected) {
    cJSON_AddNumberToObject(wifi, "rssi", ap.rssi);
    cJSON_AddStringToObject(wifi, "ssid", text(ap.ssid, strnlen(reinterpret_cast<char *>(ap.ssid), sizeof(ap.ssid))).c_str());
    radio_test::Address bssid;
    for (size_t i = 0; i < 6; ++i) bssid.bytes[5-i] = ap.bssid[i];
    cJSON_AddStringToObject(wifi, "bssid", mac(bssid).c_str());
    cJSON_AddNumberToObject(wifi, "channel", ap.primary);
  } else cJSON_AddNullToObject(wifi, "rssi");
  {
    std::lock_guard<std::mutex> lock(wifi_mutex);
    stats(wifi, "stats", connected && !memcmp(wifi_bssid, ap.bssid, 6) ? wifi_stats : radio_test::Stats{}, now);
  }
  auto header = js(j); cJSON_Delete(j); header.pop_back(); header += ",\"devices\":[";
  httpd_resp_set_type(r, "application/json");
  esp_err_t result = httpd_resp_send_chunk(r, header.c_str(), header.size());
  if (result != ESP_OK) return result;
  bool first = true; auto assigned = devices();
  for (size_t i = 0; i < radio_test::capacity; ++i) {
    radio_test::Entry entry;
    if (!cache.copy(i, session.id, entry)) continue;
    if (!first && (result = httpd_resp_send_chunk(r, ",", 1)) != ESP_OK) return result;
    first = false; j = cJSON_CreateObject(); auto addr = mac(entry.address);
    cJSON_AddStringToObject(j, "address", addr.c_str());
    cJSON_AddNumberToObject(j, "address_type", entry.address.type);
    cJSON_AddNumberToObject(j, "event_type", entry.event_type);
    cJSON_AddNumberToObject(j, "age_ms", std::max<int64_t>(0, now - entry.last_seen));
    stats(j, "advertisement", entry.broadcast, now); stats(j, "connection", entry.connection, now);
    bool configured = false, linked = false;
    for (const auto &device : assigned) {
      if (strcasecmp(device.address.c_str(), addr.c_str()) || device.address_type != entry.address.type) continue;
      configured = true; linked = device.profile == "afu-wl-tz-a1" ? afu_connected(device.id) : ble_connected(device.id);
      cJSON_AddStringToObject(j, "profile", device.profile.c_str()); break;
    }
    cJSON_AddBoolToObject(j, "configured", configured); cJSON_AddBoolToObject(j, "connected", linked);
    details(j, entry);
    if ((result = send_json(r, j)) != ESP_OK) return result;
  }
  if ((result = httpd_resp_send_chunk(r, "]}", 2)) != ESP_OK) return result;
  return httpd_resp_send_chunk(r, nullptr, 0);
}
