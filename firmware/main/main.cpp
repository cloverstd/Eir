#include "driver/gpio.h"
#include "eir.h"
#include "ble_runtime.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_http_server.h"
#include "esp_image_format.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_ota_ops.h"
#include "esp_random.h"
#include "esp_sntp.h"
#include "esp_spiffs.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mqtt_client.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "protocol.h"
#include "lifecycle_policy.h"
#include "psa/crypto.h"
#include <cstdio>
#include <cerrno>
#include <cstring>
#include <ctime>
#include <dirent.h>
#include <sys/stat.h>
#include <unistd.h>
std::string collector_id, last_error;
std::mutex state_mutex, radio_mutex;
std::atomic<bool> upgrading{false}, ble_busy{false}, lifecycle_busy{false}, lifecycle_storage_fault{false};
static std::string lifecycle = "{}";
static std::mutex lifecycle_mutex;
static std::string lifecycle_snapshot(){std::lock_guard<std::mutex> l(lifecycle_mutex);return lifecycle;}
static void lifecycle_set(const std::string &value){std::lock_guard<std::mutex> l(lifecycle_mutex);lifecycle=value;}
static std::atomic<bool> reset_prepared{false}, legacy_mode{false};
bool lifecycle_bound() { auto j=cJSON_Parse(lifecycle_snapshot().c_str()); bool b=!str(j,"binding_id").empty(); cJSON_Delete(j); return b; }
bool collection_enabled() { return !reset_prepared && (lifecycle_bound() || legacy_mode); }
static void stamp(cJSON *j, const std::string &scope_override = "") {
  auto l=cJSON_Parse((scope_override.empty()?lifecycle_snapshot():scope_override).c_str());
  cJSON_DeleteItemFromObject(j,"protocol_version");cJSON_AddNumberToObject(j,"protocol_version",2);
  for(auto k:{"instance_id","binding_id","data_epoch","enrollment_nonce"}) { cJSON_DeleteItemFromObject(j,k);cJSON_AddStringToObject(j,k,str(l,k).c_str()); }
  cJSON_Delete(l);
}
static lifecycle_policy::Scope scope(const cJSON *j){return {str(j,"instance_id"),str(j,"binding_id"),str(j,"data_epoch")};}
static bool matches(cJSON *j) {
  auto l=cJSON_Parse(lifecycle_snapshot().c_str());bool ok=lifecycle_policy::matches(scope(l),scope(j));cJSON_Delete(l);return ok;
}
static nvs_handle_t nv;
static esp_mqtt_client_handle_t mqtt;
static std::atomic<bool> wifi_ok{false}, mqtt_ok{false};
static std::string startup_ota_command, startup_reset_proof = "{}", last_measurement = "null";
static std::string ip, config = "{}",
                       assignment = "{\"version\":0,\"devices\":[]}", logs;
static std::mutex queue_mutex;
static std::string topic(const char *tail) {
  return "eir/v1/collectors/" + collector_id + "/" + tail;
}
std::string js(cJSON *j) {
  char *p = cJSON_PrintUnformatted(j);
  std::string s = p ? p : "{}";
  free(p);
  return s;
}
std::string str(const cJSON *j, const char *k, const char *f) {
  auto v = cJSON_GetObjectItemCaseSensitive(j, k);
  return cJSON_IsString(v) ? v->valuestring : f;
}
int num(const cJSON *j, const char *k, int f) {
  auto v = cJSON_GetObjectItemCaseSensitive(j, k);
  return cJSON_IsNumber(v) ? v->valueint : f;
}
static std::string get(const char *k, const char *f = "") {
  size_t n = 0;
  if (nvs_get_str(nv, k, nullptr, &n) != ESP_OK)
    return f;
  std::vector<char> b(n);
  nvs_get_str(nv, k, b.data(), &n);
  return b.data();
}
static bool put(const char *k, const std::string &v) {
  return nvs_set_str(nv, k, v.c_str()) == ESP_OK && nvs_commit(nv) == ESP_OK;
}
void error(const std::string &s) {
  std::lock_guard<std::mutex> l(state_mutex);
  last_error = s;
  logs += std::to_string(esp_timer_get_time() / 1000000) + " " + s + "\n";
  if (logs.size() > 8192)
    logs.erase(0, logs.size() - 8192);
  ESP_LOGW("eir", "%s", s.c_str());
}
static std::string event_payload(const std::string &cmd, const char *type,
                                 const char *state, const std::string &data,
                                 const std::string &err,
                                 const std::string &scope_override = "") {
  auto j = cJSON_CreateObject();
  stamp(j, scope_override);
  cJSON_AddStringToObject(j, "command_id", cmd.c_str());
  cJSON_AddStringToObject(j, "type", type);
  cJSON_AddStringToObject(j, "status", state);
  cJSON_AddItemToObject(j, "data", cJSON_Parse(data.c_str()));
  if (!err.empty()) cJSON_AddStringToObject(j, "error", err.c_str());
  auto encoded = js(j);
  cJSON_Delete(j);
  return encoded;
}
static void publish_event(const std::string &encoded) {
  if (mqtt_ok)
    esp_mqtt_client_publish(mqtt, topic("events").c_str(), encoded.c_str(), 0, 1, 0);
}
void event(const std::string &cmd, const char *type, const char *state,
           const std::string &data, const std::string &err) {
  auto encoded = event_payload(cmd, type, state, data, err);
  if (!cmd.empty()) put("last_event", encoded);
  publish_event(encoded);
}
std::vector<Device> devices() {
  std::lock_guard<std::mutex> l(state_mutex);
  auto j = cJSON_Parse(assignment.c_str());
  std::vector<Device> out;
  auto a = cJSON_GetObjectItem(j, "devices");
  cJSON *v;
  cJSON_ArrayForEach(v, a) {
    Device d;
    d.id = str(v, "id");
    d.address = str(v, "address");
    d.profile = str(v, "profile");
    d.hardware_id = str(v,"hardware_id");
    d.address_type = num(v, "address_type");
    d.enabled = !cJSON_IsFalse(cJSON_GetObjectItem(v,"enabled"));
    if (!d.id.empty() && (d.profile == "omron-hem-7374t1" || d.profile=="afu-wl-tz-a1"))
      out.push_back(d);
  }
  cJSON_Delete(j);
  return out;
}
static std::vector<std::string> queue_files() {
  std::vector<std::string> v;
  auto *d = opendir("/data");
  if (d) {
    dirent *e;
    while ((e = readdir(d)))
      if (std::strncmp(e->d_name, "q-", 2) == 0 &&
          std::strstr(e->d_name, ".json"))
        v.push_back(e->d_name);
    closedir(d);
  }
  return v;
}
static std::string hex(const uint8_t *p, size_t n) {
  std::string s;
  char b[3];
  for (size_t i = 0; i < n; i++) {
    snprintf(b, sizeof(b), "%02x", p[i]);
    s += b;
  }
  return s;
}
void observe(const Device &d, int u, const std::vector<uint8_t> &r) {
  if (r.size() != 16 || r[0] > 0xe1)
    return;
  auto j = cJSON_CreateObject();
  cJSON_AddStringToObject(j, "device_id", d.id.c_str());
  cJSON_AddNumberToObject(j, "user_slot", u);
  cJSON_AddNumberToObject(j, "systolic", r[0] + 25);
  cJSON_AddNumberToObject(j, "diastolic", r[1]);
  cJSON_AddNumberToObject(j, "pulse", r[2]);
  cJSON_AddNumberToObject(j, "record_sequence", omron::le16(&r[10]));
  cJSON_AddStringToObject(j, "raw_hex", hex(r.data(), r.size()).c_str());
  auto s = js(j);
  cJSON_Delete(j);
  std::lock_guard<std::mutex> lock(state_mutex);
  last_measurement = s;
}
bool remove_file(const std::string &path) {
  int rc=unlink(path.c_str());
  if(lifecycle_policy::deletion_succeeded(rc,errno))return true;
  lifecycle_storage_fault=true;error("Storage deletion failed: "+path);return false;
}
static bool path_exists(const std::string &path) { struct stat st{}; return stat(path.c_str(), &st)==0 && S_ISREG(st.st_mode); }
bool file_exists(const std::string &path) { struct stat st{}; return stat(path.c_str(),&st)==0 && st.st_size>0; }
std::string record_fingerprint(int u, const std::vector<uint8_t> &r) {
  (void)u; const auto &input=r; uint8_t digest[32]; size_t n=0;
  if(psa_hash_compute(PSA_ALG_SHA_256,(const uint8_t*)input.data(),input.size(),digest,32,&n)!=PSA_SUCCESS) return "";
  return hex(digest,32);
}
bool enqueue(const Device &d, int u, const std::vector<uint8_t> &r) {
  if (r.size() != 16 || r[0] > 0xe1)
    return true;
  std::lock_guard<std::mutex> l(queue_mutex);
  FILE *baseline=fopen(("/data/baseline-"+d.id).c_str(),"rb");
  if(baseline){ char line[80]; auto fp=record_fingerprint(u,r); bool excluded=false; while(fgets(line,sizeof(line),baseline)) if(std::string(line)==std::to_string(u)+":"+fp+"\n") excluded=true; fclose(baseline); if(excluded)return true; }
  auto scope=cJSON_Parse(lifecycle_snapshot().c_str());auto scope_key=str(scope,"binding_id")+":"+str(scope,"data_epoch");cJSON_Delete(scope);
  auto raw = hex(r.data(), r.size());
  std::string key = scope_key + ":" + d.id + ":" + std::to_string(u) + ":" + raw;
  uint8_t digest[32];
  size_t digest_len = 0;
  if (psa_hash_compute(PSA_ALG_SHA_256, (const uint8_t *)key.data(), key.size(),
                       digest, sizeof(digest), &digest_len) != PSA_SUCCESS)
    return false;
  std::string id = hex(digest, 16), path = "/data/q-" + id + ".json";
  if (file_exists(path))
    return true;
  if (queue_files().size() >= 192) {
    error("Persistent queue full; collection paused");
    return false;
  }
  auto j = cJSON_CreateObject();
  cJSON_AddNumberToObject(j, "version", 2);
  stamp(j);
  cJSON_AddStringToObject(j, "message_id", id.c_str());
  cJSON_AddStringToObject(j, "collector_id", collector_id.c_str());
  cJSON_AddStringToObject(j, "device_id", d.id.c_str());
  cJSON_AddStringToObject(j, "profile", d.profile.c_str());
  cJSON_AddNumberToObject(j, "user_slot", u);
  cJSON_AddNumberToObject(j, "record_sequence", omron::le16(&r[10]));
  cJSON_AddStringToObject(j, "raw_hex", raw.c_str());
  auto s = js(j);
  cJSON_Delete(j);
  auto *f = fopen("/data/pending.tmp", "wb");
  if (!f)
    return false;
  bool ok = fwrite(s.data(), 1, s.size(), f) == s.size() && fflush(f) == 0 &&
            fsync(fileno(f)) == 0;
  fclose(f);
  if (ok)
    ok = rename("/data/pending.tmp", path.c_str()) == 0;
  return ok;
}
bool enqueue_scale(const Device &d,const std::string &session,const std::string &captured_at,const std::vector<uint8_t>&weight,const std::vector<uint8_t>&adc) {
  std::lock_guard<std::mutex> lock(queue_mutex);
  auto j=cJSON_CreateObject();stamp(j);
  std::string key=str(j,"binding_id")+":"+str(j,"data_epoch")+":"+d.id+":"+session+(adc.empty()?":weight":":adc");
  uint8_t digest[32];size_t n=0;
  if(psa_hash_compute(PSA_ALG_SHA_256,(const uint8_t*)key.data(),key.size(),digest,sizeof(digest),&n)!=PSA_SUCCESS){cJSON_Delete(j);return false;}
  auto id=hex(digest,16),path="/data/q-"+id+".json";
  if(file_exists(path)){cJSON_Delete(j);return true;}
  if(queue_files().size()>=192){cJSON_Delete(j);error("Persistent queue full; scale measurement retained locally");return false;}
  cJSON_AddNumberToObject(j,"version",2);cJSON_AddStringToObject(j,"message_id",id.c_str());cJSON_AddStringToObject(j,"collector_id",collector_id.c_str());cJSON_AddStringToObject(j,"device_id",d.id.c_str());cJSON_AddStringToObject(j,"profile",d.profile.c_str());cJSON_AddNumberToObject(j,"user_slot",0);
  cJSON_AddStringToObject(j,"measurement_session_id",session.c_str());cJSON_AddStringToObject(j,"captured_at",captured_at.c_str());cJSON_AddStringToObject(j,"raw_hex",hex(weight.data(),weight.size()).c_str());
  if(!adc.empty())cJSON_AddStringToObject(j,"impedance_raw_hex",hex(adc.data(),adc.size()).c_str());
  auto data=js(j);cJSON_Delete(j);FILE*f=fopen("/data/pending.tmp","wb");if(!f)return false;
  bool ok=fwrite(data.data(),1,data.size(),f)==data.size()&&fflush(f)==0&&fsync(fileno(f))==0;fclose(f);
  return ok&&rename("/data/pending.tmp",path.c_str())==0;
}
static std::string status() {
  auto j = cJSON_CreateObject();
  stamp(j);
  cJSON_AddBoolToObject(j,"legacy_adoption",get("legacy_adopt")=="1");
  cJSON_AddBoolToObject(j,"bound",lifecycle_bound());
  cJSON_AddItemToObject(j,"reset_receipt",cJSON_Parse(startup_reset_proof.c_str()));
  cJSON_AddStringToObject(j,"completed_operation_id",get("reset_receipt").c_str());
  cJSON_AddBoolToObject(j,"lifecycle_busy",lifecycle_busy || reset_prepared);
  cJSON_AddBoolToObject(j, "online", true);
  cJSON_AddBoolToObject(j, "wifi", wifi_ok);
  cJSON_AddBoolToObject(j, "mqtt", mqtt_ok);
  cJSON_AddBoolToObject(j, "upgrading", upgrading);
  cJSON_AddStringToObject(j, "collector_id", collector_id.c_str());
  cJSON_AddStringToObject(j, "firmware", esp_app_get_description()->version);
  cJSON_AddStringToObject(j, "partition_layout",
                          "EIR_PARTITION_LAYOUT=eir-c3-v1");
  cJSON_AddStringToObject(j, "ip", ip.c_str());
  cJSON_AddStringToObject(j, "boot_partition",
                          esp_ota_get_running_partition()->label);
  cJSON_AddNumberToObject(j, "reset_reason", esp_reset_reason());
  cJSON_AddBoolToObject(j, "clock_synchronized", time(nullptr) > 1700000000);
  wifi_ap_record_t ap{};
  esp_wifi_sta_get_ap_info(&ap);
  cJSON_AddNumberToObject(j, "rssi", ap.rssi);
  cJSON_AddNumberToObject(j, "free_heap", esp_get_free_heap_size());
  cJSON_AddNumberToObject(j,"min_free_heap",esp_get_minimum_free_heap_size());
  cJSON_AddBoolToObject(j,"ble_scanning",ble_gap_disc_active());
  cJSON_AddNumberToObject(j, "uptime", esp_timer_get_time() / 1000000);
  {
    std::lock_guard<std::mutex> l(queue_mutex);
    cJSON_AddNumberToObject(j, "queue_depth", queue_files().size());
  }
  {
    std::lock_guard<std::mutex> l(state_mutex);
    cJSON_AddStringToObject(j, "error", last_error.c_str());
    cJSON_AddItemToObject(j, "last_measurement",
                          cJSON_Parse(last_measurement.c_str()));
  }
  auto caps=cJSON_AddObjectToObject(j,"capabilities");
  auto profiles=cJSON_AddArrayToObject(caps,"profiles");cJSON_AddItemToArray(profiles,cJSON_CreateString("omron-hem-7374t1"));cJSON_AddItemToArray(profiles,cJSON_CreateString("afu-wl-tz-a1"));
  cJSON_AddNumberToObject(caps,"max_scales",2);cJSON_AddNumberToObject(caps,"max_connections",3);
  auto configured=cJSON_AddArrayToObject(j,"devices");
  for(const auto &d:devices()) {
    auto row=cJSON_CreateObject();
    cJSON_AddStringToObject(row,"id",d.id.c_str());
    cJSON_AddStringToObject(row,"address",d.address.c_str());
    cJSON_AddBoolToObject(row,"registered",file_exists("/data/registered-"+d.id));
    cJSON_AddStringToObject(row,"profile",d.profile.c_str());
    cJSON_AddBoolToObject(row,"connected",d.profile=="afu-wl-tz-a1"?afu_connected(d.id):ble_connected(d.id));
    cJSON_AddItemToArray(configured,row);
  }
  auto last = cJSON_Parse(get("last_event", "{}").c_str());
  cJSON_AddItemToObject(j, "last_command", last);
  auto s = js(j);
  cJSON_Delete(j);
  return s;
}
struct OtaRequest {
  std::string id, url, sha;
  int size;
};
static bool verify_image(const esp_partition_t *p, size_t size,
                         const std::string &sha) {
  if (size < sizeof(esp_image_header_t) || size > p->size || sha.size() != 64)
    return false;
  esp_image_header_t h{};
  if (esp_partition_read(p, 0, &h, sizeof(h)) != ESP_OK ||
      h.magic != ESP_IMAGE_HEADER_MAGIC || h.chip_id != ESP_CHIP_ID_ESP32C3)
    return false;
  psa_hash_operation_t ctx = PSA_HASH_OPERATION_INIT;
  if (psa_hash_setup(&ctx, PSA_ALG_SHA_256) != PSA_SUCCESS)
    return false;
  uint8_t b[1024], sum[32];
  bool layout_ok = false;
  std::string overlap;
  for (size_t n = 0; n < size;) {
    size_t k = std::min(sizeof(b), size - n);
    if (esp_partition_read(p, n, b, k) != ESP_OK) {
      psa_hash_abort(&ctx);
      return false;
    }
    if (psa_hash_update(&ctx, b, k) != PSA_SUCCESS) {
      psa_hash_abort(&ctx);
      return false;
    }
    overlap.append(reinterpret_cast<const char *>(b), k);
    if (overlap.find("EIR_PARTITION_LAYOUT=eir-c3-v1") != std::string::npos)
      layout_ok = true;
    if (overlap.size() > 64)
      overlap.erase(0, overlap.size() - 64);
    n += k;
  }
  size_t digest_len = 0;
  if (psa_hash_finish(&ctx, sum, sizeof(sum), &digest_len) != PSA_SUCCESS) {
    psa_hash_abort(&ctx);
    return false;
  }
  psa_hash_abort(&ctx);
  return layout_ok && hex(sum, 32) == sha;
}
static void ota_task(void *arg) {
  auto *r = (OtaRequest *)arg;
  upgrading = true;
  std::unique_lock<std::mutex> radio_lock(radio_mutex);
  ble_pause_for_ota();
  esp_wifi_set_ps(WIFI_PS_NONE);
  event(r->id, "ota", "downloading");
  esp_http_client_config_t c{};
  c.url = r->url.c_str();
  c.timeout_ms = 15000;
  c.crt_bundle_attach = esp_crt_bundle_attach;
  auto h = esp_http_client_init(&c);
  auto *p = esp_ota_get_next_update_partition(nullptr);
  esp_ota_handle_t handle = 0;
  bool ok = h && p && r->size > 0 && r->size <= (int)p->size &&
            esp_http_client_open(h, 0) == ESP_OK;
  if (ok) {
    esp_http_client_fetch_headers(h);
    ok = esp_http_client_get_status_code(h) == 200 &&
         esp_ota_begin(p, r->size, &handle) == ESP_OK;
  }
  int total = 0;
  char b[2048];
  while (ok && total < r->size) {
    int n =
        esp_http_client_read(h, b, std::min((int)sizeof(b), r->size - total));
    if (n <= 0) {
      ok = false;
      break;
    }
    ok = esp_ota_write(handle, b, n) == ESP_OK;
    total += n;
  }
  if (h)
    esp_http_client_cleanup(h);
  if (ok)
    ok = total == r->size && verify_image(p, total, r->sha);
  if (ok) {
    ok = esp_ota_end(handle) == ESP_OK;
    handle = 0;
  }
  if (!ok && handle)
    esp_ota_abort(handle);
  if (ok)
    ok = put("ota_command", r->id) && put("ota_target", p->label) &&
         esp_ota_set_boot_partition(p) == ESP_OK;
  if (ok) {
    event(r->id, "ota", "rebooting");
    vTaskDelay(pdMS_TO_TICKS(1500));
    esp_restart();
  }
  event(r->id, "ota", "failed", "{}",
        "Image download, compatibility or digest validation failed");
  delete r;
  esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
  upgrading = false;
  radio_lock.unlock();
  vTaskDelete(nullptr);
}
static bool fresh(const cJSON *j) {
  auto e = str(j, "expires_at");
  struct tm t {};
  if (e.empty() || !strptime(e.c_str(), "%Y-%m-%dT%H:%M:%S", &t))
    return false; // commands use UTC Z
  if (e.back() != 'Z')
    return false;
  return time(nullptr) > 1700000000 && timegm(&t) > time(nullptr);
}
static bool copy_file(const std::string &from,const std::string &to) {
  FILE *in=fopen(from.c_str(),"rb");if(!in)return false;FILE *out=fopen((to+".tmp").c_str(),"wb");if(!out){fclose(in);return false;}char b[512];size_t n;bool ok=true;while((n=fread(b,1,sizeof(b),in)))if(fwrite(b,1,n,out)!=n)ok=false;ok=ok&&!ferror(in)&&fflush(out)==0&&fsync(fileno(out))==0;fclose(in);fclose(out);return ok&&rename((to+".tmp").c_str(),to.c_str())==0;
}
static std::mutex baseline_mutex;
static std::string expected_baseline_ack;
static bool chunk_acked=false;
static void baseline_ack(cJSON *j) {
  std::lock_guard<std::mutex> lock(baseline_mutex);
  if(str(j,"status")=="stored" && str(j,"command_id")+":"+str(j,"device_id")+":"+std::to_string(num(j,"chunk_index"))==expected_baseline_ack)chunk_acked=true;
}
static bool send_baselines(const std::string &id,const std::string &device) {
  for(auto d:devices()) {
    if(!device.empty()&&device!=d.id)continue;
    FILE *f=fopen(("/data/staged-"+d.id).c_str(),"rb");if(!f)return false;std::vector<std::string> lines;char b[80];while(fgets(b,sizeof(b),f))lines.emplace_back(b);fclose(f);
    int total=std::max(1,int((lines.size()+31)/32));
    for(int chunk=0;chunk<total;++chunk) {
      auto data=cJSON_CreateObject();cJSON_AddStringToObject(data,"device_id",d.id.c_str());cJSON_AddNumberToObject(data,"chunk_index",chunk);cJSON_AddNumberToObject(data,"total_chunks",total);auto records=cJSON_AddArrayToObject(data,"records");
      for(size_t i=chunk*32;i<std::min(lines.size(),size_t((chunk+1)*32));++i){auto r=cJSON_CreateObject();cJSON_AddNumberToObject(r,"user_slot",lines[i][0]-'0');cJSON_AddStringToObject(r,"hash",lines[i].substr(2,64).c_str());cJSON_AddItemToArray(records,r);}
      auto payload=js(data);cJSON_Delete(data);
      {std::lock_guard<std::mutex> lock(baseline_mutex);expected_baseline_ack=id+":"+d.id+":"+std::to_string(chunk);chunk_acked=false;}
      bool ack=false;for(int wait=0;wait<90&&!ack;++wait){if(wait%5==0)event(id,"baseline_chunk","running",payload);vTaskDelay(pdMS_TO_TICKS(1000));std::lock_guard<std::mutex> lock(baseline_mutex);ack=chunk_acked;}
      if(!ack)return false;
    }
  }return true;
}
static bool clear_health_files(bool all) {
  std::lock_guard<std::mutex> lock(queue_mutex);
  DIR *dir=opendir("/data");
  if(!dir){lifecycle_storage_fault=true;error("Cannot open persistent storage for cleanup");return false;}
  bool ok=true;
  for(;;) {
    errno=0;auto entry=readdir(dir);
    if(!entry){if(errno){ok=false;lifecycle_storage_fault=true;}break;}
    std::string name=entry->d_name;
    if(name=="."||name=="..")continue;
    if(all || name.rfind("q-",0)==0 || name.rfind("c-",0)==0 || name.rfind("registration",0)==0 || name.rfind("scale-session-",0)==0 || name=="pending.tmp")
      if(!remove_file("/data/"+name)){ok=false;break;}
  }
  if(closedir(dir)!=0){ok=false;lifecycle_storage_fault=true;}
  if(!ok)return false;
  std::lock_guard<std::mutex> state(state_mutex);logs.clear();last_error.clear();last_measurement="null";
  return true;
}
static bool save_assignment(const std::string &v) {
  if(!put("assignment",v)){lifecycle_storage_fault=true;return false;}
  std::lock_guard<std::mutex> l(state_mutex); assignment=v; return true;
}
static time_t command_expiry(const cJSON *j) {
  struct tm t{};auto expiry=str(j,"expires_at");
  return strptime(expiry.c_str(),"%Y-%m-%dT%H:%M:%S",&t)?timegm(&t):0;
}
static cJSON *receipt_event(cJSON *entry) {
  auto event=cJSON_GetObjectItem(entry,"event");
  return cJSON_IsObject(event)?event:entry; // accept pre-wrapper development receipts
}
static std::string saved_receipt(const std::string &key) {
  auto entries=cJSON_Parse(get("life_results","{}").c_str());
  auto entry=cJSON_GetObjectItem(entries,key.c_str());
  auto receipt=receipt_event(entry);
  auto value=entry?js(receipt):"";
  // Earlier firmware cached a failure for an abort with no preparation. Retry
  // only that precise failure, retaining refusal of foreign owned snapshots.
  if(entry&&lifecycle_policy::retry_empty_abort(str(receipt,"type"),str(receipt,"status"),str(receipt,"error"),str(receipt,"command_id"),get("prepared"),get("life_snapshot")))value.clear();
  cJSON_Delete(entries);return value;
}
static bool receipt_ready(const std::string &encoded) {
  auto receipt=cJSON_Parse(encoded.c_str());
  bool cleared=cJSON_IsTrue(cJSON_GetObjectItem(cJSON_GetObjectItem(receipt,"data"),"local_cleared"));
  bool ready=!cleared || get("reset_proof")==encoded;
  // The terminal receipt is already durable before retiring the preparation
  // marker; an interrupted commit can therefore replay its exact receipt.
  if(ready&&lifecycle_policy::retire_preparation(str(receipt,"type"),str(receipt,"status"),str(receipt,"command_id"),get("prepared"),get("life_snapshot")))ready=put("life_snapshot","");
  cJSON_Delete(receipt);
  return ready;
}
static bool reserve_receipt(const std::string &key) {
  auto entries=cJSON_Parse(get("life_results","{}").c_str());
  if(!cJSON_IsObject(entries)){cJSON_Delete(entries);return false;}
  std::vector<std::string> remove;
  auto latest=get("life_latest");
  cJSON *entry;
  cJSON_ArrayForEach(entry,entries) {
    auto expiry=cJSON_GetObjectItem(entry,"expires_at");
    if(lifecycle_policy::receipt_evictable(cJSON_IsNumber(expiry)?(int64_t)expiry->valuedouble:0,time(nullptr),entry->string==latest)) remove.emplace_back(entry->string);
  }
  for(const auto &name:remove)cJSON_DeleteItemFromObject(entries,name.c_str());
  bool room=lifecycle_policy::receipt_room(cJSON_GetArraySize(entries),cJSON_GetObjectItem(entries,key.c_str())!=nullptr);
  bool durable=room&&put("life_results",js(entries));cJSON_Delete(entries);return durable;
}
static void lifecycle_run(void *arg) {
  auto encoded=static_cast<std::string*>(arg); auto j=cJSON_Parse(encoded->c_str()); delete encoded;
  auto id=str(j,"id"), type=str(j,"type"), device=str(j,"device_id"), phase=str(j,"phase","execute");
  auto key=lifecycle_policy::receipt_key(id,phase,type);
  auto recovered=saved_receipt(key);
  if(!recovered.empty()) {
    auto receipt=cJSON_Parse(recovered.c_str());
    bool cleared=cJSON_IsTrue(cJSON_GetObjectItem(cJSON_GetObjectItem(receipt,"data"),"local_cleared"));
    bool durable=put("life_latest",key) && (!cleared || (put("reset_receipt",id)&&put("reset_proof",recovered))) && receipt_ready(recovered);
    cJSON_Delete(receipt);
    if(durable && put("lifecycle_job","")) {
      if(cleared)startup_reset_proof=recovered;
      put("last_event",recovered);publish_event(recovered);lifecycle_busy=false;
    } else error("Lifecycle receipt recovery cannot commit; collector remains paused");
    cJSON_Delete(j);return;
  }
  lifecycle_storage_fault=false;
  auto old_lifecycle=js(j);
  std::unique_lock<std::mutex> radio_lock(radio_mutex);
  ble_pause_for_ota();
  bool ok=true; std::string failure;
  bool draining=type=="collector_unbind"||type=="device_unbind";
  if(draining) {
    for(int n=0;n<180;++n) { bool empty; {std::lock_guard<std::mutex> l(queue_mutex); empty=queue_files().empty();} if(empty)break; if(n==179){ok=false;failure="Upload queue has not drained; retry when broker and Eir are available";} vTaskDelay(pdMS_TO_TICKS(1000)); }
  }
  if(ok && get("life_snapshot")!=id && phase!="commit" && (type=="device_bind" || type=="device_unbind" || type=="prepare_data_reset" || type=="collector_unbind" || type=="collector_reset" || type=="factory_reset" || type=="revoke")) {
    ok=ble_lifecycle(type,device);
    if(!ok)failure="BLE cleanup or baseline failed; wake the assigned device and retry; see logs";
  }
  if(ok && phase!="commit" && (type=="prepare_data_reset" || type=="device_bind")) {
    if(!put("life_snapshot",id))ok=false;
    if(ok)ok=send_baselines(id,device);
    if(ok){ok=put("prepared",id);reset_prepared=ok;}
  }
  if(ok && type=="abort_data_reset") {
    if(!lifecycle_policy::abort_allowed(id,get("prepared"),get("life_snapshot"))) {
      ok=false;failure="Abort does not own current prepared baseline";
    } else {
      if(lifecycle_policy::owns_preparation(id,get("prepared"),get("life_snapshot")))for(auto d:devices())if((device.empty()||device==d.id)&&!remove_file("/data/staged-"+d.id)){ok=false;break;}
      if(ok){ok=put("prepared","")&&put("life_snapshot","");if(!ok)lifecycle_storage_fault=true;else reset_prepared=false;}
    }
  }
  if(ok && (type=="commit_data_reset" || (type=="device_bind" && phase=="commit"))) {
    if(get("prepared")!=id && get("life_snapshot")!=id){ok=false;failure="No prepared baseline";}
    else {
      for(auto d:devices()) if((device.empty()||d.id==device) && !path_exists("/data/staged-"+d.id)){ok=false;failure="Staged baseline missing";}
      if(ok) {
        ok=type=="commit_data_reset"?clear_health_files(false):remove_file("/data/registration.json");
        if(ok)for(auto d:devices()) {
          if(!device.empty()&&d.id!=device)continue;
          if(!copy_file("/data/staged-"+d.id,"/data/baseline-"+d.id) || !remove_file("/data/c-"+d.id)) {
            ok=false;lifecycle_storage_fault=true;break;
          }
        }
        auto l=cJSON_Parse(lifecycle_snapshot().c_str());auto epoch=type=="commit_data_reset"?str(j,"next_data_epoch"):str(l,"data_epoch");cJSON_DeleteItemFromObject(l,"data_epoch");cJSON_AddStringToObject(l,"data_epoch",epoch.c_str());
        auto v=js(l);cJSON_Delete(l); if(ok){ok=put("lifecycle",v)&&put("prepared","");if(ok){lifecycle_set(v);reset_prepared=false;}else lifecycle_storage_fault=true;}
      }
    }
  }
  if(ok && type=="device_unbind") {
    auto a=cJSON_Parse(assignment.c_str());auto ds=cJSON_GetObjectItem(a,"devices");for(int i=cJSON_GetArraySize(ds)-1;i>=0;--i)if(str(cJSON_GetArrayItem(ds,i),"id")==device)cJSON_DeleteItemFromArray(ds,i);ok=save_assignment(js(a));cJSON_Delete(a);
  }
  bool cleared=type=="collector_unbind"||type=="collector_reset"||type=="factory_reset"||type=="revoke";
  if(ok && cleared) {
    ok=clear_health_files(true)&&save_assignment("{\"version\":0,\"devices\":[]}");
    uint8_t nonce[16];esp_fill_random(nonce,sizeof(nonce));auto l=cJSON_CreateObject();cJSON_AddStringToObject(l,"enrollment_nonce",hex(nonce,16).c_str());auto v=js(l);cJSON_Delete(l);
    ok=ok&&put("lifecycle",v)&&put("legacy_adopt","");if(ok){lifecycle_set(v);legacy_mode=false;}
    if(type=="factory_reset")ok=ok&&put("config","{}");
    if(!ok)lifecycle_storage_fault=true;
  }
  if(lifecycle_storage_fault) {
    error("Lifecycle storage failure; journal retained and collection paused");
    event(id,type.c_str(),"failed","{}","Persistent storage cleanup failed; journal retained for recovery");
    cJSON_Delete(j);return;
  }
  auto result=cJSON_CreateObject();auto ds=cJSON_AddArrayToObject(result,"devices");for(auto d:devices())if(device.empty()||d.id==device)cJSON_AddItemToArray(ds,cJSON_CreateString(d.id.c_str()));cJSON_AddStringToObject(result,"operation_id",id.c_str());cJSON_AddBoolToObject(result,"local_cleared",ok&&cleared);
  auto data=js(result);cJSON_Delete(result);
  auto state=ok?((type=="prepare_data_reset" || (type=="device_bind"&&phase!="commit"))?"prepared":type=="factory_reset"?"awaiting_provisioning":"succeeded"):"failed";
  // The result's scope is immutable; never change global enrollment state just
  // to report the old scope, since status/ACK callbacks run concurrently.
  auto terminal=event_payload(id,type.c_str(),state,data,failure,cleared?old_lifecycle:"");
  auto receipts=cJSON_Parse(get("life_results","{}").c_str());
  cJSON_DeleteItemFromObject(receipts,key.c_str());
  auto entry=cJSON_CreateObject();
  cJSON_AddNumberToObject(entry,"expires_at",command_expiry(j));
  cJSON_AddItemToObject(entry,"event",cJSON_Parse(terminal.c_str()));
  cJSON_AddItemToObject(receipts,key.c_str(),entry);
  bool durable=put("life_results",js(receipts))&&put("life_latest",key);cJSON_Delete(receipts);
  if(ok&&cleared)durable=durable&&put("reset_receipt",id)&&put("reset_proof",terminal);
  if(durable)durable=receipt_ready(terminal);
  if(!durable){error("Cannot persist lifecycle result; journal retained for recovery");cJSON_Delete(j);return;}
  if(!put("lifecycle_job","")){error("Lifecycle journal could not be finalized; collector remains paused");cJSON_Delete(j);return;}
  put("last_event",terminal);
  publish_event(terminal);
  cJSON_Delete(j);lifecycle_busy=false;
  if(ok&&cleared && mqtt_ok) {
    auto hello=status();esp_mqtt_client_publish(mqtt,topic("status").c_str(),hello.c_str(),0,1,1);
  }
  if(ok&&type=="factory_reset"){vTaskDelay(pdMS_TO_TICKS(1500));esp_restart();}
  radio_lock.unlock();
}
static void lifecycle_task(void *arg){lifecycle_run(arg);vTaskDelete(nullptr);}
static bool is_lifecycle(const std::string &t) { return t=="collector_unbind"||t=="collector_reset"||t=="factory_reset"||t=="device_bind"||t=="device_unbind"||t=="prepare_data_reset"||t=="commit_data_reset"||t=="abort_data_reset"||t=="revoke"; }
static void command(cJSON *j) {
  auto id = str(j, "id"), type = str(j, "type");
  if (id.empty() || !fresh(j)) {
    event(id, type.c_str(), "failed", "{}",
          "Expired command or clock not synchronized; use UTC expires_at");
    return;
  }
  if(is_lifecycle(type)) {
    auto key=lifecycle_policy::receipt_key(id,str(j,"phase","execute"),type);
    auto saved=saved_receipt(key);
    if(!saved.empty()){if(receipt_ready(saved))publish_event(saved);else error("Cleanup receipt awaits durable reset proof; journal retained");return;}
    if(!matches(j)){event(id,type.c_str(),"failed","{}","Stale lifecycle tuple");return;}
    auto ongoing=cJSON_Parse(get("lifecycle_job","{}").c_str());
    bool same=str(ongoing,"id")==id && str(ongoing,"phase","execute")==str(j,"phase","execute") && str(ongoing,"type")==type;cJSON_Delete(ongoing);
    if(same && lifecycle_busy){event(id,type.c_str(),"running");return;}
    if(upgrading || (reset_prepared && type!="commit_data_reset" && type!="abort_data_reset" && !(type=="device_bind"&&str(j,"phase")=="commit")) || lifecycle_busy.exchange(true)){event(id,type.c_str(),"failed","{}","Collector busy");return;}
    if(!reserve_receipt(key)) {
      lifecycle_busy=false;event(id,type.c_str(),"failed","{}","Receipt storage full or unavailable; retry after existing commands expire; no changes applied");return;
    }
    auto payload=js(j); if(!put("lifecycle_job",payload)){lifecycle_busy=false;event(id,type.c_str(),"failed","{}","Cannot persist lifecycle journal; no changes applied");return;}
    event(id,type.c_str(),"running");
    xTaskCreate(lifecycle_task,"lifecycle",12288,new std::string(payload),4,nullptr);return;
  }
  if(!lifecycle_bound() || !matches(j)){event(id,type.c_str(),"failed","{}","Stale lifecycle tuple");return;}
  auto history = get("commands");
  if (history.find("|" + id + "|") != std::string::npos)
    return;
  history += "|" + id + "|";
  if (history.size() > 4096)
    history.erase(0, history.find("|", history.size() - 4000));
  if (!put("commands", history)) {
    error("Cannot persist command ID");
    return;
  }
  if (type == "ota") {
    if (upgrading || lifecycle_busy || reset_prepared || str(j, "chip") != "esp32c3" ||
        str(j, "partition_layout") != "eir-c3-v1") {
      event(id, "ota", "failed", "{}", "Busy or incompatible image");
      return;
    }
    auto *r =
        new OtaRequest{id, str(j, "url"), str(j, "sha256"), num(j, "size")};
    xTaskCreate(ota_task, "ota", 8192, r, 4, nullptr);
  } else
    ble_command(id, type, str(j, "device_id"));
}
static void mqtt_event(void *, esp_event_base_t, int32_t eid, void *arg) {
  auto e = (esp_mqtt_event_handle_t)arg;
  if (eid == MQTT_EVENT_CONNECTED) {
    mqtt_ok = true;
    for (auto s : {"acks", "config", "commands"})
      esp_mqtt_client_subscribe(mqtt, topic(s).c_str(), 1);
    auto s = status();
    esp_mqtt_client_publish(mqtt, topic("status").c_str(), s.c_str(), 0, 1, 1);
  } else if (eid == MQTT_EVENT_DISCONNECTED)
    mqtt_ok = false;
  else if (eid == MQTT_EVENT_DATA) {
    static std::string payload, t;
    if (e->current_data_offset == 0) {
      payload.clear();
      t.assign(e->topic, e->topic_len);
    }
    if (e->total_data_len > 16384)
      return;
    payload.append(e->data, e->data_len);
    if ((int)payload.size() != e->total_data_len)
      return;
    auto j = cJSON_Parse(payload.c_str());
    if (!j)
      return;
    if (t == topic("acks")) {
      if(str(j,"kind")=="baseline"){ if(matches(j))baseline_ack(j);cJSON_Delete(j);return; }
      if(!lifecycle_bound() || !matches(j)){cJSON_Delete(j);return;}
      auto id = str(j, "message_id"), s = str(j, "status");
      if (id.size() == 32 &&
          id.find_first_not_of("0123456789abcdef") == std::string::npos &&
          (s == "stored" || s == "rejected")) {
        std::lock_guard<std::mutex> l(queue_mutex);
        if (s == "rejected")
          error("Server rejected record " + id + ": " + str(j, "error"));
        remove_file("/data/q-" + id + ".json");
      }
    } else if (t == topic("config")) {
      auto old=cJSON_Parse(assignment.c_str()); auto l=cJSON_Parse(lifecycle_snapshot().c_str());
      bool claim=cJSON_IsTrue(cJSON_GetObjectItem(j,"claim"));
      bool valid=matches(j);
      if(claim && lifecycle_policy::claim(scope(l),scope(j),str(l,"enrollment_nonce"),str(j,"enrollment_nonce"),lifecycle_busy)) {
        auto v=cJSON_CreateObject();for(auto k:{"instance_id","binding_id","data_epoch","enrollment_nonce"})cJSON_AddStringToObject(v,k,str(j,k).c_str());
        auto encoded=js(v);cJSON_Delete(v);valid=put("lifecycle",encoded);if(valid){lifecycle_set(encoded);put("legacy_adopt","");legacy_mode=false;}
      }
      if(valid && !lifecycle_busy && (claim || num(j,"version")>num(old,"version")) && cJSON_IsArray(cJSON_GetObjectItem(j,"devices"))) save_assignment(payload);
      if(valid && claim)event(str(j,"operation_id"),"claim","succeeded");
      cJSON_Delete(old);cJSON_Delete(l);
    } else if (t == topic("commands"))
      command(j);
    cJSON_Delete(j);
  }
}
static void wifi_event(void *, esp_event_base_t b, int32_t id, void *data) {
  if (b == WIFI_EVENT && id == WIFI_EVENT_STA_START)
    esp_wifi_connect();
  if (b == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
    wifi_ok = false;
    esp_wifi_connect();
  }
  if (b == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
    auto e = (ip_event_got_ip_t *)data;
    char buf[20];
    snprintf(buf, sizeof(buf), IPSTR, IP2STR(&e->ip_info.ip));
    ip = buf;
    wifi_ok = true;
    esp_wifi_set_mode(WIFI_MODE_STA);
  }
}
static void provisioning() {
  wifi_config_t ap{};
  snprintf((char *)ap.ap.ssid, sizeof(ap.ap.ssid), "Eir-%s",
           collector_id.c_str() + collector_id.size() - 6);
  ap.ap.max_connection = 2;
  ap.ap.authmode = WIFI_AUTH_OPEN;
  esp_wifi_set_mode(WIFI_MODE_APSTA);
  esp_wifi_set_config(WIFI_IF_AP, &ap);
  error("Provisioning hotspot active");
}
static const char *page =
    R"HTML(<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Eir 采集器</title><style>body{font:16px system-ui;max-width:640px;margin:24px auto;padding:16px;background:#f1f5f2;color:#18392e}input,button{padding:12px;margin:5px 0;width:100%;box-sizing:border-box}pre{white-space:pre-wrap;overflow-wrap:anywhere}button{background:#256a54;color:white;border:0;border-radius:8px}</style><h1>Eir 采集器</h1><pre id="status"></pre><h2>网络配置</h2><form id="form"><input name="ssid" placeholder="Wi-Fi SSID" required maxlength="32"><input name="password" type="password" placeholder="Wi-Fi 密码（留空保留）"><input name="mqtt_uri" placeholder="mqtt://主机:1883" required><input name="mqtt_username" placeholder="MQTT 用户名"><input name="mqtt_password" type="password" placeholder="MQTT 密码（留空保留）"><button>保存并重启</button></form><h2>蓝牙诊断</h2><button onclick="fetch('/scan',{method:'POST'})">扫描附近设备</button><pre id="scan"></pre><input id="device" placeholder="Eir 中的设备 UUID"><button onclick="fetch('/read',{method:'POST',body:JSON.stringify({device_id:device.value})})">读取指定已分配设备</button><a href="/logs">下载日志</a> · <a href="/backup">下载注册备份</a><h2>固件升级</h2><input id="file" type="file" accept=".bin"><input id="sha" placeholder="固件 SHA-256（64 位）"><button onclick="upload()">上传并升级</button><pre id="result"></pre><script>async function refresh(){document.getElementById("status").textContent=JSON.stringify(await(await fetch('/status')).json(),null,2);scan.textContent=JSON.stringify(await(await fetch('/scan')).json(),null,2)}form.onsubmit=async e=>{e.preventDefault();let r=await fetch('/config',{method:'POST',body:JSON.stringify(Object.fromEntries(new FormData(form)))});result.textContent=await r.text()};async function upload(){if(!file.files[0])return;let r=await fetch('/ota',{method:'POST',headers:{'X-SHA256':sha.value},body:file.files[0]});result.textContent=await r.text()}fetch("/config").then(r=>r.json()).then(c=>Object.entries(c).forEach(([k,v])=>{if(form.elements[k])form.elements[k].value=v}));refresh();setInterval(refresh,5000);</script></html>)HTML";
static std::string body(httpd_req_t *r, int max = 4096) {
  if (r->content_len > max)
    return "";
  std::string s(r->content_len, '\0');
  int n = 0;
  while (n < r->content_len) {
    int k = httpd_req_recv(r, &s[n], r->content_len - n);
    if (k <= 0)
      return "";
    n += k;
  }
  return s;
}
static void reboot_task(void *) {
  vTaskDelay(pdMS_TO_TICKS(1500));
  esp_restart();
}
static esp_err_t http(httpd_req_t *r) {
  std::string uri = r->uri;
  if (r->method == HTTP_POST) {
    char origin[160]{}, host[128]{};
    if (httpd_req_get_hdr_value_len(r, "Origin") > 0) {
      if (httpd_req_get_hdr_value_str(r, "Origin", origin, sizeof(origin)) !=
              ESP_OK ||
          httpd_req_get_hdr_value_str(r, "Host", host, sizeof(host)) != ESP_OK)
        return httpd_resp_send_err(r, HTTPD_403_FORBIDDEN, "Invalid origin");
      std::string expected = "http://" + std::string(host);
      if (origin != expected)
        return httpd_resp_send_err(r, HTTPD_403_FORBIDDEN,
                                   "Cross-origin writes are not allowed");
    }
  }
  httpd_resp_set_hdr(r, "Cache-Control", "no-store");
  if (uri == "/")
    return httpd_resp_send(r, page, HTTPD_RESP_USE_STRLEN);
  if (uri == "/status") {
    auto s = status();
    httpd_resp_set_type(r, "application/json");
    return httpd_resp_send(r, s.c_str(), s.size());
  }
  if (uri == "/scan") {
    if (r->method == HTTP_POST)
      ble_command("local-scan", "scan", "");
    auto s = ble_scan_json();
    httpd_resp_set_type(r, "application/json");
    return httpd_resp_send(r, s.c_str(), s.size());
  }
  if (uri == "/logs") {
    std::lock_guard<std::mutex> l(state_mutex);
    httpd_resp_set_type(r, "text/plain");
    return httpd_resp_send(r, logs.c_str(), logs.size());
  }
  if(uri=="/scale-diagnostics"){
    if(r->method==HTTP_POST){
      auto input=cJSON_Parse(body(r).c_str());int seconds=num(input,"seconds",0);cJSON_Delete(input);
      if(seconds<0||seconds>180)return httpd_resp_send_err(r,HTTPD_400_BAD_REQUEST,"seconds must be 0..180");
      afu_trace_start(seconds);
    }
    auto out=afu_trace_json();httpd_resp_set_type(r,"application/json");
    return httpd_resp_send(r,out.c_str(),out.size());
  }
  if (uri == "/backup") {
    FILE *f = fopen("/data/registration.json", "rb");
    if (!f)
      return httpd_resp_send_err(r, HTTPD_404_NOT_FOUND,
                                 "No registration backup");
    char b[1024];
    size_t n;
    while ((n = fread(b, 1, sizeof(b), f)))
      httpd_resp_send_chunk(r, b, n);
    fclose(f);
    return httpd_resp_send_chunk(r, nullptr, 0);
  }
  if (uri == "/config") {
    if (r->method == HTTP_GET) {
      auto stored = cJSON_Parse(config.c_str());
      auto pub = cJSON_CreateObject();
      for (auto key : {"ssid", "mqtt_uri", "mqtt_username"})
        cJSON_AddStringToObject(pub, key, str(stored, key).c_str());
      auto response = js(pub);
      cJSON_Delete(stored);
      cJSON_Delete(pub);
      httpd_resp_set_type(r, "application/json");
      return httpd_resp_send(r, response.c_str(), response.size());
    }
    auto s = body(r);
    auto j = cJSON_Parse(s.c_str());
    if (!j || str(j, "ssid").empty() || str(j, "ssid").size() > 32 ||
        str(j, "password").size() > 63 || str(j, "mqtt_uri").empty()) {
      cJSON_Delete(j);
      return httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST,
                                 "Invalid configuration");
    }
    auto old = cJSON_Parse(config.c_str());
    for (auto k : {"password", "mqtt_password"})
      if (str(j, k).empty()) {
        cJSON_DeleteItemFromObject(j, k);
        cJSON_AddStringToObject(j, k, str(old, k).c_str());
      }
    s = js(j);
    cJSON_Delete(j);
    cJSON_Delete(old);
    if (!put("config", s))
      return httpd_resp_send_err(r, HTTPD_500_INTERNAL_SERVER_ERROR,
                                 "NVS write failed");
    httpd_resp_sendstr(r, "Saved; restarting");
    xTaskCreate(reboot_task, "restart", 2048, nullptr, 2, nullptr);
    return ESP_OK;
  }
  if (uri == "/read") {
    auto s = body(r);
    auto j = cJSON_Parse(s.c_str());
    ble_command("local-read", "read", str(j, "device_id"));
    cJSON_Delete(j);
    return httpd_resp_sendstr(r, "Queued");
  }
  if (uri == "/ota") {
    char sha[65];
    if (upgrading || lifecycle_busy || reset_prepared ||
        httpd_req_get_hdr_value_str(r, "X-SHA256", sha, sizeof(sha)) !=
            ESP_OK ||
        strlen(sha) != 64)
      return httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST,
                                 "Busy or missing SHA-256");
    upgrading = true;
    std::unique_lock<std::mutex> radio_lock(radio_mutex);
    ble_pause_for_ota();
    esp_wifi_set_ps(WIFI_PS_NONE);
    auto *p = esp_ota_get_next_update_partition(nullptr);
    esp_ota_handle_t h = 0;
    bool ok = p && r->content_len > 0 && r->content_len <= p->size &&
              esp_ota_begin(p, r->content_len, &h) == ESP_OK;
    int n = 0;
    int64_t received_at = esp_timer_get_time();
    char b[2048];
    while (ok && n < r->content_len) {
      int k = httpd_req_recv(r, b, std::min(sizeof(b), r->content_len - n));
      if (k == HTTPD_SOCK_ERR_TIMEOUT &&
          esp_timer_get_time() - received_at < 30000000)
        continue;
      if (k <= 0) {
        error("OTA upload timed out or disconnected");
        ok = false;
        break;
      }
      received_at = esp_timer_get_time();
      auto written = esp_ota_write(h, b, k);
      ok = written == ESP_OK;
      if (!ok)
        error(std::string("OTA write failed: ") + esp_err_to_name(written));
      n += k;
    }
    if (ok)
      ok = verify_image(p, n, sha);
    if (ok) {
      ok = esp_ota_end(h) == ESP_OK;
      h = 0;
    }
    if (!ok && h)
      esp_ota_abort(h);
    if (ok)
      ok = put("ota_command", "local-upload") && put("ota_target", p->label) &&
           esp_ota_set_boot_partition(p) == ESP_OK;
    if (ok) {
      httpd_resp_sendstr(r, "Verified; rebooting");
      xTaskCreate(reboot_task, "restart", 2048, nullptr, 2, nullptr);
    } else
      httpd_resp_send_err(r, HTTPD_400_BAD_REQUEST,
                          "Firmware validation failed");
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    upgrading = false;
    return ESP_OK;
  }
  return httpd_resp_send_err(r, HTTPD_404_NOT_FOUND, "Not found");
}
static void serial_config(void *) {
  std::string line;
  setvbuf(stdin, nullptr, _IONBF, 0);
  for (;;) {
    int ch = getchar();
    if (ch == EOF) {
      clearerr(stdin);
      vTaskDelay(pdMS_TO_TICKS(20));
      continue;
    }
    if (ch == '\n' || ch == '\r') {
      if (line.rfind("EIR_CONFIG ", 0) == 0) {
        auto j = cJSON_Parse(line.c_str() + 11);
        if (j && !str(j, "ssid").empty() && str(j, "ssid").size() <= 32 &&
            str(j, "password").size() <= 63 && !str(j, "mqtt_uri").empty() &&
            put("config", js(j))) {
          puts("EIR_CONFIG_OK");
          cJSON_Delete(j);
          vTaskDelay(pdMS_TO_TICKS(500));
          esp_restart();
        }
        cJSON_Delete(j);
      }
      line.clear();
    } else if (line.size() < 2048)
      line.push_back(ch);
    else
      line.clear();
  }
}
extern "C" void app_main() {
  ESP_ERROR_CHECK(nvs_flash_init());
  if (psa_crypto_init() != PSA_SUCCESS)
    abort();
  ESP_ERROR_CHECK(nvs_open("eir", NVS_READWRITE, &nv));
  // Retire legacy completed markers as well, using their durable commit receipt.
  auto old_snapshot=get("life_snapshot");
  if(!old_snapshot.empty()&&get("prepared").empty())for(auto type:{"device_bind","commit_data_reset"}){
    auto receipt=saved_receipt(lifecycle_policy::receipt_key(old_snapshot,"commit",type));
    if(!receipt.empty()&&!receipt_ready(receipt))error("Completed preparation marker could not be retired");
  }

  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  collector_id = "eir-" + hex(mac, 6);
  config = get("config", "{}");
  assignment = get("assignment", "{\"version\":0,\"devices\":[]}");
  lifecycle=get("lifecycle");
  if(lifecycle.empty()) {
    auto a=cJSON_Parse(assignment.c_str());bool legacy=cJSON_GetArraySize(cJSON_GetObjectItem(a,"devices"))>0;cJSON_Delete(a);
    uint8_t nonce[16];esp_fill_random(nonce,16);auto l=cJSON_CreateObject();cJSON_AddStringToObject(l,"enrollment_nonce",hex(nonce,16).c_str());lifecycle=js(l);cJSON_Delete(l);put("lifecycle",lifecycle);if(legacy)put("legacy_adopt","1");
  }
  legacy_mode=get("legacy_adopt")=="1";
  reset_prepared=!get("prepared").empty();
  lifecycle_busy=!get("lifecycle_job").empty();
  startup_ota_command = get("ota_command");
  startup_reset_proof=get("reset_proof","{}");
  auto previous_event = cJSON_Parse(get("last_event", "{}").c_str());
  auto previous_status = str(previous_event, "status");
  if ((previous_status == "running" || previous_status == "downloading") &&
      get("ota_command").empty() && get("lifecycle_job").empty())
    event(str(previous_event, "command_id"),
          str(previous_event, "type").c_str(), "failed", "{}",
          "Command interrupted by collector restart");
  cJSON_Delete(previous_event);
  esp_vfs_spiffs_conf_t fs{};
  fs.base_path = "/data";
  fs.partition_label = "storage";
  fs.max_files = 8;
  fs.format_if_mount_failed = false;
  esp_err_t mount = esp_vfs_spiffs_register(&fs);
  if (mount == ESP_FAIL && get("storage_initialized").empty()) {
    ESP_ERROR_CHECK(esp_spiffs_format("storage"));
    mount = esp_vfs_spiffs_register(&fs);
    if (mount == ESP_ERR_INVALID_STATE)
      mount = ESP_OK;
  }
  ESP_ERROR_CHECK(mount);
  put("storage_initialized", "1");
  setenv("TZ", "CST-8", 1);
  tzset();
  ESP_ERROR_CHECK(esp_netif_init());
  ESP_ERROR_CHECK(esp_event_loop_create_default());
  esp_netif_create_default_wifi_sta();
  esp_netif_create_default_wifi_ap();
  wifi_init_config_t init = WIFI_INIT_CONFIG_DEFAULT();
  ESP_ERROR_CHECK(esp_wifi_init(&init));
  esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event, nullptr);
  esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event,
                             nullptr);
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_mode(WIFI_MODE_STA);
  auto j = cJSON_Parse(config.c_str());
  wifi_config_t sta{};
  snprintf((char *)sta.sta.ssid, sizeof(sta.sta.ssid), "%s",
           str(j, "ssid").c_str());
  snprintf((char *)sta.sta.password, sizeof(sta.sta.password), "%s",
           str(j, "password").c_str());
  esp_wifi_set_config(WIFI_IF_STA, &sta);
  if (str(j, "ssid").empty())
    provisioning();
  esp_wifi_start();
  esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
  esp_sntp_setservername(0, "pool.ntp.org");
  esp_sntp_init();
  auto uri = str(j, "mqtt_uri"), user = str(j, "mqtt_username"),
       pass = str(j, "mqtt_password");
  if (!uri.empty()) {
    esp_mqtt_client_config_t mc{};
    mc.broker.address.uri = uri.c_str();
    mc.credentials.client_id = collector_id.c_str();
    mc.credentials.username = user.c_str();
    mc.credentials.authentication.password = pass.c_str();
    mc.session.protocol_ver = MQTT_PROTOCOL_V_3_1_1;
    auto st = topic("status");
    mc.session.last_will.topic = st.c_str();
    mc.session.last_will.msg = "{\"online\":false}";
    mc.session.last_will.qos = 1;
    mc.session.last_will.retain = 1;
    mc.broker.verification.crt_bundle_attach = esp_crt_bundle_attach;
    mqtt = esp_mqtt_client_init(&mc);
    esp_mqtt_client_register_event(mqtt, MQTT_EVENT_ANY, mqtt_event, nullptr);
    esp_mqtt_client_start(mqtt);
  }
  cJSON_Delete(j);
  httpd_config_t hc = HTTPD_DEFAULT_CONFIG();
  hc.max_uri_handlers = 12;
  hc.stack_size = 8192;
  httpd_handle_t server;
  ESP_ERROR_CHECK(httpd_start(&server, &hc));
  for (auto path : {"/", "/status", "/scan", "/logs", "/backup", "/config", "/scale-diagnostics"}) {
    httpd_uri_t u{};
    u.uri = path;
    u.method = HTTP_GET;
    u.handler = http;
    httpd_register_uri_handler(server, &u);
  }
  for (auto path : {"/config", "/scan", "/read", "/ota", "/scale-diagnostics"}) {
    httpd_uri_t u{};
    u.uri = path;
    u.method = HTTP_POST;
    u.handler = http;
    httpd_register_uri_handler(server, &u);
  }
  auto unfinished=get("lifecycle_job");
  lifecycle_busy=!unfinished.empty();
  ble_start();
  if(!unfinished.empty()){xTaskCreate(lifecycle_task,"lifecycle",12288,new std::string(unfinished),4,nullptr);}
  xTaskCreate(serial_config, "serial_config", 4096, nullptr, 2, nullptr);
  gpio_set_direction(GPIO_NUM_9, GPIO_MODE_INPUT);
  gpio_set_pull_mode(GPIO_NUM_9, GPIO_PULLUP_ONLY);
  int tick = 0, pressed = 0;
  bool confirmed = false;
  for (;;) {
    vTaskDelay(pdMS_TO_TICKS(1000));
    tick++;
    pressed = gpio_get_level(GPIO_NUM_9) == 0 ? pressed + 1 : 0;
    if (pressed == 3 || (tick == 60 && !wifi_ok))
      provisioning();
    if (!confirmed && tick >= 30) {
      esp_ota_mark_app_valid_cancel_rollback();
      confirmed = true;
    }
    if (mqtt_ok && tick % 10 == 0) {
      auto s = status();
      esp_mqtt_client_publish(mqtt, topic("status").c_str(), s.c_str(), 0, 1,
                              1);
      auto cmd = startup_ota_command;
      if (!cmd.empty() && confirmed && lifecycle_bound()) {
        bool success =
            get("ota_target") == esp_ota_get_running_partition()->label;
        event(cmd, "ota", success ? "succeeded" : "rolled_back");
        put("ota_command", "");
        startup_ota_command.clear();
      }
      if(!lifecycle_bound())continue;
      std::lock_guard<std::mutex> l(queue_mutex);
      auto files = queue_files();
      int sent = 0;
      for (auto &name : files) {
        if (sent++ >= 8)
          break;
        FILE *f = fopen(("/data/" + name).c_str(), "rb");
        if (!f)
          continue;
        char b[1024];
        size_t n = fread(b, 1, sizeof(b) - 1, f);
        fclose(f);
        b[n] = 0;
        // Durably scope adopted legacy queue IDs. A power cut may leave both
        // filenames, but both normalize to the same id and are idempotent.
        auto queued=cJSON_Parse(b);
        if(lifecycle_bound() && str(queued,"binding_id").empty()) {
          cJSON_DeleteItemFromObject(queued,"version");cJSON_AddNumberToObject(queued,"version",2);stamp(queued);
          std::string key=str(queued,"binding_id")+":"+str(queued,"data_epoch")+":"+str(queued,"device_id")+":"+std::to_string(num(queued,"user_slot"))+":"+str(queued,"raw_hex");
          uint8_t digest[32];size_t length=0;
          if(psa_hash_compute(PSA_ALG_SHA_256,(const uint8_t*)key.data(),key.size(),digest,sizeof(digest),&length)!=PSA_SUCCESS){cJSON_Delete(queued);continue;}
          auto normalized=hex(digest,16);cJSON_DeleteItemFromObject(queued,"message_id");cJSON_AddStringToObject(queued,"message_id",normalized.c_str());
          auto encoded=js(queued);cJSON_Delete(queued);
          FILE *out=fopen("/data/adopt.tmp","wb");if(!out)continue;
          bool durable=fwrite(encoded.data(),1,encoded.size(),out)==encoded.size()&&fflush(out)==0&&fsync(fileno(out))==0;fclose(out);
          if(durable && rename("/data/adopt.tmp",("/data/q-"+normalized+".json").c_str())==0) {
            remove_file("/data/"+name);
            esp_mqtt_client_publish(mqtt,topic("measurements").c_str(),encoded.c_str(),0,1,0);
          }
          continue;
        }
        cJSON_Delete(queued);
        esp_mqtt_client_publish(mqtt, topic("measurements").c_str(), b, n, 1,
                                0);
      }
    }
  }
}
