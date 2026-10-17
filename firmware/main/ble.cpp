#include "eir.h"
#include "ble_runtime.h"
#include "afu_protocol.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/ble_hs_pvcy.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "protocol.h"
#include "store/config/ble_store_config.h"
#include <array>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <map>
#include <memory>
#include <unistd.h>
extern "C" void ble_store_config_init(void);
std::mutex ble_connect_mutex;
std::atomic<bool> ble_connecting{false};
namespace {
struct Seen {
  ble_addr_t addr;
  int rssi;
  std::string name, signature;
  int64_t when;
  bool pairing_mode=false;
};
std::mutex bm;
std::map<std::string, Seen> seen;
struct Job {
  char id[80], type[16], device[80];
};
QueueHandle_t jobs;
struct Packet {uint16_t handle,len;uint8_t bytes[256];};
// The cuff has one reserved connection; scales have two separate contexts.
struct CuffConnection {
  QueueHandle_t notifications=nullptr;
  SemaphoreHandle_t done=nullptr,security_done=nullptr;
  int security_result=0,result=0;
  const char *stage="idle";
  std::string device_id;
  std::atomic<uint16_t> conn{BLE_HS_CONN_HANDLE_NONE};
  uint16_t tx=0,rx=0,auth=0,model=0,serial=0,rx_cccd=0,auth_cccd=0;
  std::vector<uint16_t> declarations;
  std::vector<uint8_t> read_value;
} cuff;
std::atomic<bool> ready{false};
std::string addrstr(const ble_addr_t &a) {
  char b[18];
  snprintf(b, sizeof(b), "%02X:%02X:%02X:%02X:%02X:%02X", a.val[5], a.val[4],
           a.val[3], a.val[2], a.val[1], a.val[0]);
  return b;
}
const ble_uuid128_t AUTH =
    BLE_UUID128_INIT(0x1b, 0xc5, 0xd5, 0xa5, 0x02, 0x00, 0x30, 0xa7, 0xe1, 0x11,
                     0xe7, 0xae, 0x80, 0xb6, 0x05, 0xb3);
const ble_uuid128_t TX =
    BLE_UUID128_INIT(0x1b, 0xc5, 0xd5, 0xa5, 0x02, 0x00, 0x5e, 0x96, 0xe1, 0x11,
                     0xe7, 0xae, 0xe0, 0x55, 0x5b, 0xdb);
const ble_uuid128_t RX =
    BLE_UUID128_INIT(0x1b, 0xc5, 0xd5, 0xa5, 0x02, 0x00, 0x4d, 0xa7, 0xe1, 0x11,
                     0xe8, 0xae, 0x40, 0x30, 0x12, 0x49);
void reset_wait() {
  while (xSemaphoreTake(cuff.done, 0))
    ;
  cuff.result = 0;
}
bool wait(int ms = 15000) {
  bool completed=xSemaphoreTake(cuff.done, pdMS_TO_TICKS(ms)) == pdTRUE;
  if(!completed || cuff.result) error(std::string("BLE stage ")+cuff.stage+" "+(completed?"error="+std::to_string(cuff.result):"timeout"));
  return completed && cuff.result==0;
}
int gap(ble_gap_event *e, void *) {
  switch (e->type) {
  case BLE_GAP_EVENT_DISC: {
    afu_discover(e->disc);
    ble_hs_adv_fields f{};
    if (ble_hs_adv_parse_fields(&f, e->disc.data, e->disc.length_data))
      break;
    bool omron =
        f.mfg_data_len >= 2 && f.mfg_data[0] == 0x0e && f.mfg_data[1] == 2;
    for (int i = 0; i < f.num_uuids16; i++)
      if (f.uuids16[i].value == 0xfe4a)
        omron = true;
    if (!omron)
      break;
    ble_addr_t advertiser=e->disc.addr;
#if MYNEWT_VAL(BLE_HOST_BASED_PRIVACY)
    // NimBLE replaces addr with the SMP identity after bonding; this Omron
    // advertises an unusable all-zero identity. Keep its actual on-air address.
    advertiser=e->disc.ota_addr;
#endif
    Seen s{advertiser, e->disc.rssi,
           f.name ? std::string((char *)f.name, f.name_len) : "OMRON", "",
           esp_timer_get_time()};
    s.pairing_mode = f.mfg_data_len>=4 && (f.mfg_data[3]&8);
    if (f.mfg_data)
      s.signature.assign((char *)f.mfg_data, f.mfg_data_len);
    std::lock_guard<std::mutex> l(bm);
    seen[addrstr(s.addr)] = s;
    break;
  }
  case BLE_GAP_EVENT_CONNECT:
    cuff.result = e->connect.status;
    if (!cuff.result)
      cuff.conn = e->connect.conn_handle;
    xSemaphoreGive(cuff.done);
    break;
  case BLE_GAP_EVENT_DISCONNECT:
    if(cuff.conn==e->disconnect.conn.conn_handle)cuff.conn = BLE_HS_CONN_HANDLE_NONE;
    break;
  case BLE_GAP_EVENT_ENC_CHANGE:
    cuff.security_result = e->enc_change.status;
    xSemaphoreGive(cuff.security_done);
    break;
  case BLE_GAP_EVENT_REPEAT_PAIRING:
    return BLE_GAP_REPEAT_PAIRING_IGNORE;
  case BLE_GAP_EVENT_NOTIFY_RX: {
    if(cuff.conn!=e->notify_rx.conn_handle)break;
    Packet p{};
    p.handle = e->notify_rx.attr_handle;
    p.len =
        std::min((int)sizeof(p.bytes), (int)OS_MBUF_PKTLEN(e->notify_rx.om));
    os_mbuf_copydata(e->notify_rx.om, 0, p.len, p.bytes);
    xQueueSend(cuff.notifications, &p, 0);
    break;
  }
  default:
    break;
  }
  return 0;
}
void scan() {
  if (!ready || ble_connecting || upgrading || lifecycle_busy || !collection_enabled() || ble_gap_disc_active())
    return;
#if !MYNEWT_VAL(BLE_HOST_BASED_PRIVACY)
  // This cuff supplies a zero SMP identity. Disable controller substitution
  // only during discovery so the real advertised address remains observable.
  int privacy_rc=ble_hs_pvcy_set_resolve_enabled(0);
  if(privacy_rc)error("BLE scan privacy error="+std::to_string(privacy_rc));
#endif
  ble_gap_disc_params p{};
  p.passive = 0;
  p.itvl = 160;
  p.window = 80;
  p.filter_duplicates = 0;
  uint8_t own;
  ble_hs_id_infer_auto(0, &own);
  ble_gap_disc(own, BLE_HS_FOREVER, &p, gap, nullptr);
}
int chr_cb(uint16_t, const ble_gatt_error *e, const ble_gatt_chr *c, void *) {
  if (e->status) {
    cuff.result = e->status == BLE_HS_EDONE ? 0 : e->status;
    xSemaphoreGive(cuff.done);
    return 0;
  }
  cuff.declarations.push_back(c->def_handle);
  if (!ble_uuid_cmp(&c->uuid.u, &TX.u))
    cuff.tx = c->val_handle;
  if (!ble_uuid_cmp(&c->uuid.u, &RX.u))
    cuff.rx = c->val_handle;
  if (!ble_uuid_cmp(&c->uuid.u, &AUTH.u))
    cuff.auth = c->val_handle;
  if (c->uuid.u.type == BLE_UUID_TYPE_16) {
    uint16_t u = BLE_UUID16(&c->uuid.u)->value;
    if (u == 0x2a24)
      cuff.model = c->val_handle;
    if (u == 0x2a25)
      cuff.serial = c->val_handle;
  }
  return 0;
}
int dsc_cb(uint16_t, const ble_gatt_error *e, uint16_t ch,
           const ble_gatt_dsc *d, void *) {
  if (e->status) {
    cuff.result = e->status == BLE_HS_EDONE ? 0 : e->status;
    xSemaphoreGive(cuff.done);
    return 0;
  }
  if (d->uuid.u.type == BLE_UUID_TYPE_16 &&
      BLE_UUID16(&d->uuid.u)->value == 0x2902) {
    if (ch == cuff.rx)
      cuff.rx_cccd = d->handle;
    if (ch == cuff.auth)
      cuff.auth_cccd = d->handle;
  }
  return 0;
}
int attr_cb(uint16_t, const ble_gatt_error *e, ble_gatt_attr *a, void *) {
  cuff.result = e->status;
  if (!cuff.result && a && a->om) {
    cuff.read_value.resize(OS_MBUF_PKTLEN(a->om));
    os_mbuf_copydata(a->om, 0, cuff.read_value.size(), cuff.read_value.data());
  }
  xSemaphoreGive(cuff.done);
  return 0;
}
bool read_char(uint16_t h, std::string &v) {
  if (!h)
    return false;
  reset_wait();
  cuff.read_value.clear();
  if (ble_gattc_read(cuff.conn, h, attr_cb, nullptr) || !wait())
    return false;
  v.assign(cuff.read_value.begin(), cuff.read_value.end());
  while (!v.empty() && v.back() == 0)
    v.pop_back();
  return true;
}
bool subscribe(uint16_t h) {
  uint8_t b[] = {1, 0};
  reset_wait();
  return h && ble_gattc_write_flat(cuff.conn, h, b, 2, attr_cb, nullptr) == 0 &&
         wait();
}
bool notification(uint16_t handle, std::vector<uint8_t> &out,
                  int timeout = 8000) {
  int64_t deadline = esp_timer_get_time() + timeout * 1000LL;
  Packet p;
  while (esp_timer_get_time() < deadline) {
    if (xQueueReceive(cuff.notifications, &p, pdMS_TO_TICKS(100)) &&
        p.handle == handle) {
      out.assign(p.bytes, p.bytes + p.len);
      return true;
    }
    if (cuff.conn == BLE_HS_CONN_HANDLE_NONE)
      return false;
  }
  return false;
}
bool exchange(const std::vector<uint8_t> &f, uint16_t op, uint16_t a,
              std::vector<uint8_t> &v) {
  if (ble_gattc_write_no_rsp_flat(cuff.conn, cuff.tx, f.data(), f.size()))
    return false;
  return notification(cuff.rx, v) && omron::valid(v, op, a);
}
bool last_read_absent = false;
bool read(uint16_t a, uint8_t n, std::vector<uint8_t> &v) {
  last_read_absent = false;
  std::vector<uint8_t> r;
  if (!exchange(omron::frame(0x0100, a, n), 0x8100, a, r))
    return false;
  if (r.size() == 8 && r[6]) {
    last_read_absent = r[6] == 0xe3;
    error("Omron read refused at " + std::to_string(a) + " code " +
          std::to_string(r[6]));
    return false;
  }
  if (r.size() != n + 8 || r[5] != n || r[r.size() - 2])
    return false;
  v.assign(r.begin() + 6, r.begin() + 6 + n);
  return true;
}
bool write(uint16_t a, const std::vector<uint8_t> &v) {
  std::vector<uint8_t> r;
  return omron::write_allowed(a, v.size()) &&
         exchange(omron::frame(0x01c0, a, v.size(), v), 0x81c0, a, r) &&
         omron::echo(r, a, v);
}
int mtu_cb(uint16_t, const ble_gatt_error *e, uint16_t, void *) {
  cuff.result = e->status;
  xSemaphoreGive(cuff.done);
  return 0;
}
bool begin(const Device &d, bool pairing) {
  if(cuff.conn!=BLE_HS_CONN_HANDLE_NONE)return false;
  {std::lock_guard<std::mutex> lock(bm);cuff.device_id=d.id;}
  std::unique_ptr<BLEInitiation> initiation(new BLEInitiation());
#if !MYNEWT_VAL(BLE_HOST_BASED_PRIVACY)
  // Restore resolution for the connection so persisted LTKs remain usable.
  ble_hs_pvcy_set_resolve_enabled(1);
#endif
  ble_addr_t a{};
  unsigned b[6];
  if (sscanf(d.address.c_str(), "%x:%x:%x:%x:%x:%x", &b[5], &b[4], &b[3], &b[2],
             &b[1], &b[0]) != 6)
    return false;
  for (int i = 0; i < 6; i++)
    a.val[i] = b[i];
  a.type = d.address_type;
  // Re-pair only the actual identity learned during an encrypted connection.
  // Never infer the credential key from an advertising address.
  if (pairing) {
    ble_addr_t identity{};FILE *f=fopen(("/data/peer-"+d.id).c_str(),"rb");
    if(f) {
      bool known=fread(&identity,sizeof(identity),1,f)==1;fclose(f);if(!known)return false;
      for(const auto &other:devices()) {
        if(other.id==d.id||other.profile==afu::profile)continue;
        ble_addr_t peer{};f=fopen(("/data/peer-"+other.id).c_str(),"rb");
        if(!f){if(file_exists("/data/registered-"+other.id))return false;continue;}
        bool same=fread(&peer,sizeof(peer),1,f)==1 && memcmp(&identity,&peer,sizeof(peer))==0;fclose(f);
        if(same){error("Cannot re-pair ambiguous shared SMP identity");return false;}
      }
      if(ble_store_util_delete_peer(&identity))return false;
    }
  }
  uint8_t own;
  ble_hs_id_infer_auto(0, &own);
  cuff.stage="connect";
  reset_wait();
  while(xSemaphoreTake(cuff.security_done,0)) {}
  cuff.security_result=0;
  int connect_rc=ble_gap_connect(own, &a, 15000, nullptr, gap, nullptr);
  if(connect_rc){error("BLE connect start error="+std::to_string(connect_rc));return false;}
  if(!wait(17000)){ble_gap_conn_cancel();return false;}
  initiation.reset();
  cuff.stage="security";
  ble_gap_conn_desc descriptor{};
  if(ble_gap_conn_find(cuff.conn,&descriptor)){error("BLE connection disappeared");return false;}
  if(!descriptor.sec_state.encrypted){
    int secure=ble_gap_security_initiate(cuff.conn);
    if(secure && secure!=BLE_HS_EALREADY){error("BLE security start error="+std::to_string(secure));return false;}
    if(!xSemaphoreTake(cuff.security_done,pdMS_TO_TICKS(20000)) || cuff.security_result){error("BLE security completion error="+std::to_string(cuff.security_result));return false;}
  }
  if (!ble_gap_conn_find(cuff.conn, &descriptor)) {
    FILE *identity = fopen(("/data/peer-" + d.id).c_str(), "wb");
    if (!identity) return false;
    bool saved = fwrite(&descriptor.peer_id_addr, sizeof(ble_addr_t), 1, identity) == 1 && fflush(identity) == 0 && fsync(fileno(identity)) == 0;
    fclose(identity);
    if (!saved) return false;
  }
  cuff.stage="MTU exchange";
  reset_wait();
  if (ble_gattc_exchange_mtu(cuff.conn, mtu_cb, nullptr) || !wait())
    return false;
  cuff.tx = cuff.rx = cuff.auth = cuff.model = cuff.serial = cuff.rx_cccd = cuff.auth_cccd = 0;
  cuff.declarations.clear();
  cuff.stage="characteristic discovery";
  reset_wait();
  if (ble_gattc_disc_all_chrs(cuff.conn, 1, 0xffff, chr_cb, nullptr) || !wait())
    return false;
  if (!cuff.tx || !cuff.rx || !cuff.auth) {error("Missing FE4A characteristics TX="+std::to_string(cuff.tx)+" RX="+std::to_string(cuff.rx)+" AUTH="+std::to_string(cuff.auth));return false;}
  cuff.stage="descriptor discovery";
  for (uint16_t handle : {cuff.rx, cuff.auth}) {
    uint16_t end_handle = 0xffff;
    for (auto def : cuff.declarations)
      if (def > handle && def < end_handle)
        end_handle = def - 1;
    reset_wait();
    if (ble_gattc_disc_all_dscs(cuff.conn, handle, end_handle, dsc_cb, nullptr) ||
        !wait())
      return false;
  }
  cuff.stage="device information";
  std::string name, sn;
  if (!read_char(cuff.model, name) || name != "HEM-7374T1") {
    error("Unexpected Omron model; no registration writes permitted");
    return false;
  }
  read_char(cuff.serial, sn);
  auto j = cJSON_CreateObject();
  cJSON_AddStringToObject(j, "device_id", d.id.c_str());
  cJSON_AddStringToObject(j, "serial_number", sn.c_str());
  auto data = js(j);
  cJSON_Delete(j);
  event("", "device_info", "succeeded", data);
  cuff.stage="subscribe RX";
  if(!subscribe(cuff.rx_cccd)){error("RX CCCD failure handle="+std::to_string(cuff.rx_cccd));return false;}
  vTaskDelay(pdMS_TO_TICKS(300));
  cuff.stage="subscribe AUTH";
  if(!subscribe(cuff.auth_cccd)){error("AUTH CCCD failure handle="+std::to_string(cuff.auth_cccd));return false;}
  vTaskDelay(pdMS_TO_TICKS(300));
  xQueueReset(cuff.notifications);
  uint8_t request[20] = {0x11};
  esp_fill_random(request + 1, 4);
  if (ble_gattc_write_no_rsp_flat(cuff.conn, cuff.auth, request, sizeof(request)))
    return false;
  std::vector<uint8_t> r;
  cuff.stage="nonce authentication";
  if (!notification(cuff.auth, r) || r.size() < 6 || r[0] != 0x91 || r[1] || memcmp(r.data()+2,request+1,4)){error("BLE nonce response missing or invalid");return false;}
  cuff.stage="memory session open";
  if (!exchange(omron::frame(0, 0, 16), 0x8000, 0, r) || r.size() != 8 || r[6])
    return false;
  (void)pairing;
  return true;
}
void end() {
  if (cuff.conn != BLE_HS_CONN_HANDLE_NONE) {
    std::vector<uint8_t> r;
    exchange(omron::frame(0x0f00, 0, 0), 0x8f00, 0, r);
    ble_gap_terminate(cuff.conn, BLE_ERR_REM_USER_CONN_TERM);
    for (int i = 0; i < 20 && cuff.conn != BLE_HS_CONN_HANDLE_NONE; i++)
      vTaskDelay(pdMS_TO_TICKS(100));
  }
  scan();
}
std::string tohex(const std::vector<uint8_t> &v) {
  std::string s;
  char b[3];
  for (auto x : v) {
    snprintf(b, sizeof(b), "%02x", x);
    s += b;
  }
  return s;
}
bool collect(const Device &d, bool registration, bool baseline = false, bool staged = false) {
  std::string baseline_data;
  std::array<uint8_t, 3200> checkpoint;
  checkpoint.fill(255);
  std::string checkpoint_path = "/data/c-" + d.id;
  FILE *saved = fopen(checkpoint_path.c_str(), "rb");
  if (saved) {
    if (fread(checkpoint.data(), 1, checkpoint.size(), saved) !=
        checkpoint.size())
      checkpoint.fill(255);
    fclose(saved);
  }
  std::vector<uint8_t> h, tail;
  if (!read(0x10, registration ? 44 : 24, h))
    return false;
  auto backup = cJSON_CreateObject();
  cJSON_AddStringToObject(backup, "device_id", d.id.c_str());
  cJSON_AddStringToObject(backup, "settings_head", tohex(h).c_str());
  auto rows = cJSON_AddArrayToObject(backup, "records");
  bool ok = true;
  for (int u = 1; u <= 2 && ok; u++) {
    int count = omron::slot_count(h, u);
    if (count < 0) {
      ok = false;
      break;
    }
    int cursor = omron::le16(&h[(u - 1) * 2]) & 255;
    if (cursor && checkpoint[(u * 100 - 1) * 16] != 255)
      count = 100;
    for (int i = 0; i < count; i++) {
      int slot = (cursor - 1 - i + 100) % 100;
      std::vector<uint8_t> raw;
      if (!read(omron::address(u, slot), 16, raw)) {
        if (last_read_absent)
          continue;
        ok = false;
        break;
      }
      if (raw[0] > 0xe1)
        continue;
      if (i == 0 && !baseline)
        observe(d, u, raw);
      if (baseline) baseline_data += std::to_string(u) + ":" + record_fingerprint(u, raw) + "\n";
      if (registration) {
        auto row = cJSON_CreateObject();
        cJSON_AddNumberToObject(row, "user", u);
        cJSON_AddNumberToObject(row, "address", omron::address(u, slot));
        cJSON_AddStringToObject(row, "raw", tohex(raw).c_str());
        cJSON_AddItemToArray(rows, row);
      }
      size_t offset = ((u - 1) * 100 + slot) * 16;
      if (!std::equal(raw.begin(), raw.end(), checkpoint.begin() + offset)) {
        if (!baseline && !enqueue(d, u, raw)) {
          ok = false;
          break;
        }
        std::copy(raw.begin(), raw.end(), checkpoint.begin() + offset);
      }
    }
  }
  if (ok && registration) {
    ok = read(0x3c, 24, tail);
    if (ok) {
      cJSON_AddStringToObject(backup, "settings_clock", tohex(tail).c_str());
      auto encoded = js(backup);
      FILE *f = fopen("/data/registration.tmp", "wb");
      ok = f && fwrite(encoded.data(), 1, encoded.size(), f) == encoded.size();
      if (f) {
        ok = ok && fflush(f) == 0 && fsync(fileno(f)) == 0;
        fclose(f);
      }
      if (ok)
        ok = rename("/data/registration.tmp", "/data/registration.json") == 0;
    }
    if (ok) {
      std::vector<uint8_t> block(h.begin(), h.begin() + 34),
          clock(tail.begin(), tail.begin() + 16);
      unsigned sum = 0;
      for (int i = 24; i < 32; i++)
        sum += block[i];
      unsigned cs = 0;
      for (int i = 0; i < 14; i++)
        cs += clock[i];
      time_t now = time(nullptr);
      if ((block[24] == 255 && block[25] == 255) || (sum & 255) != block[32] ||
          (cs & 255) != clock[14] || now < 1700000000) {
        error("Registration checksum or clock invalid; backed up but no writes "
              "performed");
        ok = false;
      } else {
        block[4] = 0;
        block[5] = 0x80;
        block[6] = 0;
        block[7] = 0x80;
        for (int i : {17, 19, 21, 23})
          block[i] = 0x80;
        uint32_t count = 0;
        for (int i = 0; i < 4; i++)
          count |= uint32_t(block[28 + i]) << (i * 8);
        count++;
        for (int i = 0; i < 4; i++)
          block[28 + i] = count >> (i * 8);
        sum = 0;
        for (int i = 24; i < 32; i++)
          sum += block[i];
        block[32] = sum;
        tm t{};
        localtime_r(&now, &t);
        clock[4] |= 1;
        clock[8] = t.tm_year - 100;
        clock[9] = t.tm_mon + 1;
        clock[10] = t.tm_mday;
        clock[11] = t.tm_hour;
        clock[12] = t.tm_min;
        clock[13] = t.tm_sec;
        cs = 0;
        for (int i = 0; i < 14; i++)
          cs += clock[i];
        clock[14] = cs;
        ok = write(0x54, block) && write(0x80, clock);
      }
    }
  }
  cJSON_Delete(backup);
  if (baseline) {
    if (!ok) return false;
    std::string path = "/data/" + std::string(staged ? "staged-" : "baseline-") + d.id;
    FILE *f = fopen((path + ".tmp").c_str(), "wb");
    if (!f) return false;
    bool durable = fwrite(baseline_data.data(), 1, baseline_data.size(), f) == baseline_data.size() && fflush(f) == 0 && fsync(fileno(f)) == 0;
    fclose(f);
    return durable && rename((path + ".tmp").c_str(), path.c_str()) == 0;
  }
  FILE *progress = fopen((checkpoint_path + ".tmp").c_str(), "wb");
  if (progress) {
    bool durable = fwrite(checkpoint.data(), 1, checkpoint.size(), progress) ==
                       checkpoint.size() &&
                   fflush(progress) == 0 && fsync(fileno(progress)) == 0;
    fclose(progress);
    if (durable)
      rename((checkpoint_path + ".tmp").c_str(), checkpoint_path.c_str());
  }
  return ok;
}
void host(void *) {
  nimble_port_run();
  nimble_port_freertos_deinit();
}
void worker(void *) {
  std::map<std::string, int64_t> next;
  std::map<std::string, std::string> signatures;
  std::map<std::string, int> failures;
  while (!ready)
    vTaskDelay(pdMS_TO_TICKS(100));
  scan();
  for (;;) {
    Job job{};
    bool explicit_job = xQueueReceive(jobs, &job, pdMS_TO_TICKS(1000));
    if (upgrading || lifecycle_busy || !collection_enabled()) {
      ble_gap_disc_cancel();
      if (explicit_job)
        event(job.id, job.type, "failed", "{}",
              "Collector is upgrading; retry with a new command after "
              "completion");
      continue;
    }
    if (explicit_job && std::string(job.type) == "scan") {
      event(job.id, "scan", "running");
      scan();
      vTaskDelay(pdMS_TO_TICKS(7000));
      event(job.id, "scan", "succeeded", ble_scan_json());
      continue;
    }
    for (auto d : devices()) {
      if(d.profile==afu::profile) {if(explicit_job&&d.id==job.device)event(job.id,job.type,"failed","{}","Scale supports automatic live measurements; history/read commands are not supported");continue;}
      if (upgrading || lifecycle_busy || !collection_enabled()) {
        if (explicit_job)
          event(job.id, job.type, "failed", "{}",
                "Collector is upgrading; retry after completion");
        break;
      }
      if (explicit_job && d.id != job.device)
        continue;
      Seen obs;
      bool found = false;
      {
        std::lock_guard<std::mutex> l(bm);
        for (auto &p : seen)
          if (strcasecmp(p.first.c_str(), d.address.c_str()) == 0) {
            obs = p.second;
            found = true;
            break;
          }
      }
      if (!explicit_job) {
        // First-time pairing/registration is explicit. Do not steal the cuff's
        // limited pairing advertisement window with a background read session.
        if(!d.enabled || !file_exists("/data/registered-"+d.id) || (found&&obs.pairing_mode)) continue;
        if (!found || esp_timer_get_time() - obs.when > 15000000 ||
            esp_timer_get_time() < next[d.id])
          continue;
        // The cuff can retain the same unread flag across successive measurements.
        // Recheck continuous advertisements every 30s, not only on byte changes.
        if (signatures[d.id] == obs.signature &&
            esp_timer_get_time() < next[d.id] + 15000000)
          continue;
      }
      if (explicit_job)
        event(job.id, job.type, "running");
      if (explicit_job && std::string(job.type) == "backfill" && !remove_file("/data/c-" + d.id)) {
        event(job.id,job.type,"failed","{}","Cannot remove collection checkpoint");continue;
      }
      std::unique_lock<std::mutex> radio_lock(radio_mutex);
      if(upgrading || lifecycle_busy || !collection_enabled())break;
      ble_busy = true;
      bool registering=explicit_job && std::string(job.type)=="pair";
      if(registering && !remove_file("/data/registered-"+d.id)) {
        ble_busy=false;event(job.id,job.type,"failed","{}","Cannot reset registration marker");continue;
      }
      bool ok = begin(d, explicit_job && std::string(job.type) == "pair");
      if (ok)
        ok = collect(d, registering, registering && lifecycle_bound());
      end();
      ble_busy = false;
      if(ok&&registering){
        FILE *f=fopen(("/data/registered-"+d.id).c_str(),"wb");
        if(!f)ok=false;
        else {ok=fwrite("1",1,1,f)==1&&fflush(f)==0&&fsync(fileno(f))==0;fclose(f);}
      }
      if (ok) {
        failures[d.id] = 0;
        signatures[d.id] = obs.signature;
      } else {
        failures[d.id]++;
        error("BLE collection failed for " + d.address);
      }
      next[d.id] =
          esp_timer_get_time() +
          std::min(300, 15 * (1 << std::min(failures[d.id], 4))) * 1000000LL;
      if (explicit_job)
        event(job.id, job.type, ok ? "succeeded" : "failed", "{}",
              ok ? ""
                 : "BLE connection, registration or read failed; see collector "
                   "logs");
    }
    scan();
  }
}
} // namespace
bool ble_connected(const std::string &id){std::lock_guard<std::mutex> lock(bm);return cuff.device_id==id&&cuff.conn!=BLE_HS_CONN_HANDLE_NONE;}
void ble_resume_scan(){scan();}
std::string ble_scan_json() {
  std::lock_guard<std::mutex> l(bm);
  auto j = cJSON_CreateObject();
  auto a = cJSON_AddArrayToObject(j, "devices");
  for (auto &p : seen) {
    if (esp_timer_get_time() - p.second.when > 60000000)
      continue;
    auto d = cJSON_CreateObject();
    cJSON_AddStringToObject(d, "address", p.first.c_str());
    cJSON_AddNumberToObject(d, "address_type", p.second.addr.type);
    cJSON_AddStringToObject(d, "name", p.second.name.c_str());
    cJSON_AddNumberToObject(d, "rssi", p.second.rssi);
    cJSON_AddBoolToObject(d,"pairing_mode",p.second.pairing_mode);
    cJSON_AddItemToArray(a, d);
  }
  afu_scan_items(a);
  auto s = js(j);
  cJSON_Delete(j);
  return s;
}
void ble_command(const std::string &id, const std::string &type,
                 const std::string &device) {
  if (upgrading || lifecycle_busy || !collection_enabled()) {
    event(id, type.c_str(), "failed", "{}",
          "Collector is upgrading; retry after completion");
    return;
  }
  if (type != "scan" && type != "pair" && type != "read" &&
      type != "backfill") {
    event(id, type.c_str(), "failed", "{}", "Unknown command");
    return;
  }
  Job j{};
  snprintf(j.id, sizeof(j.id), "%s", id.c_str());
  snprintf(j.type, sizeof(j.type), "%s", type.c_str());
  snprintf(j.device, sizeof(j.device), "%s", device.c_str());
  if (!jobs || !xQueueSend(jobs, &j, 0))
    event(id, type.c_str(), "failed", "{}", "Command queue full");
}
void ble_pause_for_ota() {
  ble_gap_disc_cancel();
  afu_pause();
  while (ble_busy)
    vTaskDelay(pdMS_TO_TICKS(50));
}
void ble_start() {
  jobs = xQueueCreate(4, sizeof(Job));
  cuff.notifications = xQueueCreate(8, sizeof(Packet));
  cuff.done = xSemaphoreCreateBinary();
  cuff.security_done = xSemaphoreCreateBinary();
  ESP_ERROR_CHECK(nimble_port_init());
  ble_hs_cfg.sync_cb = []() {
    ble_hs_util_ensure_addr(0);
    ready = true;
  };
  ble_att_set_preferred_mtu(247);
  ble_hs_cfg.sm_bonding = 1;
  ble_hs_cfg.sm_sc = 1;
  ble_hs_cfg.sm_io_cap = BLE_HS_IO_NO_INPUT_OUTPUT;
  ble_hs_cfg.sm_our_key_dist =
      BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
  ble_hs_cfg.sm_their_key_dist =
      BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
  ble_hs_cfg.store_status_cb = ble_store_util_status_rr;
  ble_store_config_init();
  nimble_port_freertos_init(host);
  xTaskCreate(worker, "ble_collect", 10240, nullptr, 4, nullptr);
  afu_start();
}

// Called with lifecycle_busy set and the background worker quiescent.
bool ble_lifecycle(const std::string &type, const std::string &device) {
  while (!ready) vTaskDelay(pdMS_TO_TICKS(100));
  ble_gap_disc_cancel();
  auto assigned = devices();
  if(type=="collector_unbind" || type=="collector_reset" ||
     type=="factory_reset" || type=="revoke") {
    // The entire collector is being detached. Every bond belongs to that
    // scope; a shared zero SMP identity is safe to clear in this operation.
    return ble_store_clear()==0;
  }
  // Validate every target before deleting any credential or local record.
  if (type != "device_bind" && type != "prepare_data_reset") {
    std::map<std::string, ble_addr_t> identities;
    for (const auto &d : assigned) {
      if(d.profile==afu::profile)continue;
      ble_addr_t peer{}; FILE *f=fopen(("/data/peer-"+d.id).c_str(),"rb");
      if(!f){if(file_exists("/data/registered-"+d.id)){error("BLE identity unknown; read device before cleanup");return false;}continue;}
      bool ok=fread(&peer,sizeof(peer),1,f)==1;fclose(f);if(!ok)return false;
      identities[d.id]=peer;
    }
    for(const auto &target:identities) {
      if(!device.empty()&&target.first!=device)continue;
      for(const auto &other:identities)if(other.first!=target.first && memcmp(&other.second,&target.second,sizeof(ble_addr_t))==0){error("Ambiguous shared SMP identity; no cleanup performed");return false;}
    }
  }
  bool matched = device.empty();
  for (const auto &d : assigned) {
    if (!device.empty() && d.id != device) continue;
    matched = true;
    if(d.profile==afu::profile){if(!afu_lifecycle(d,type))return false;continue;}
    if (type == "device_bind" || type == "prepare_data_reset") {
      bool ok = begin(d, type == "device_bind");
      if (ok) ok = collect(d, type == "device_bind", true, true);
      end();
      if (!ok) return false;
      if (type == "device_bind") {
        FILE *f = fopen(("/data/registered-" + d.id).c_str(), "wb");
        if (!f) return false;
        bool durable = fwrite("1",1,1,f)==1 && fflush(f)==0 && fsync(fileno(f))==0;
        fclose(f); if(!durable) return false;
      }
    } else {
      ble_addr_t peer{};
      FILE *f = fopen(("/data/peer-" + d.id).c_str(), "rb");
      if (!f && !file_exists("/data/registered-"+d.id)) continue;
      if (!f) { error("BLE identity unknown; wake device for a read before unbind"); return false; }
      bool valid = fread(&peer, sizeof(peer), 1, f) == 1; fclose(f);
      if (!valid) return false;
      for (const auto &other : assigned) {
        if (other.id == d.id) continue;
        ble_addr_t candidate{};
        f = fopen(("/data/peer-" + other.id).c_str(), "rb");
        if (f) {
          bool same = fread(&candidate,sizeof(candidate),1,f)==1 && memcmp(&peer,&candidate,sizeof(peer))==0;
          fclose(f);
          if(same) { error("Ambiguous shared SMP identity; bond was not removed"); return false; }
        }
      }
      if (ble_store_util_delete_peer(&peer) != 0) return false;
      for (auto prefix : {"peer-", "c-", "registered-", "baseline-", "staged-"})
        if(!remove_file("/data/" + std::string(prefix) + d.id))return false;
    }
  }
  return matched;
}
