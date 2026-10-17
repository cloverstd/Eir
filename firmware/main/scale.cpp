#include "afu_protocol.h"
#include "durable_journal.h"
#include "ble_runtime.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "host/util/util.h"
#include <array>
#include <cstring>
#include <ctime>
#include <map>
#include <unistd.h>

namespace {
struct SeenScale {ble_addr_t address{};std::string name,hardware;int rssi=0;int64_t when=0;};
std::mutex scales_mutex;
std::map<std::string,SeenScale> seen_scales;
struct Notice {uint16_t connection,handle,length;uint8_t bytes[64];};
struct Trace {Notice notice{};uint32_t sequence=0,milliseconds=0;uint16_t expected_handle=0;};
std::mutex trace_mutex;
std::array<Trace,48> trace_entries{};
uint32_t trace_sequence=0;
int64_t trace_until=0;
void trace_notice(const Notice&notice,uint16_t expected){
  std::lock_guard<std::mutex> lock(trace_mutex);
  if(esp_timer_get_time()>=trace_until)return;
  uint32_t sequence=++trace_sequence;
  trace_entries[(sequence-1)%trace_entries.size()]={notice,sequence,uint32_t(esp_timer_get_time()/1000),expected};
}
struct ScaleConnection {
  std::atomic<uint16_t> conn{BLE_HS_CONN_HANDLE_NONE};
  std::atomic<bool> busy{false};
  SemaphoreHandle_t done=nullptr;
  QueueHandle_t notices=nullptr;
  int result=0;
  uint16_t start=0,end=0,notify=0,cccd=0;
  std::string device_id,inventory;
  afu::Cycle cycle;
  std::vector<uint8_t> early_adc;
  int disconnect_reason=0;
  bool load_seen=false;
};
std::array<ScaleConnection,2> connections;
std::string address_string(const ble_addr_t &a){char b[18];snprintf(b,sizeof(b),"%02X:%02X:%02X:%02X:%02X:%02X",a.val[5],a.val[4],a.val[3],a.val[2],a.val[1],a.val[0]);return b;}
std::string hex(const std::vector<uint8_t>&raw){std::string out;char b[3];for(auto x:raw){snprintf(b,sizeof(b),"%02x",x);out+=b;}return out;}
std::vector<uint8_t> unhex(const std::string &s){std::vector<uint8_t> out;if(s.size()%2)return out;for(size_t i=0;i<s.size();i+=2){unsigned x;if(sscanf(s.substr(i,2).c_str(),"%2x",&x)!=1)return {};out.push_back(x);}return out;}
// AFU registration/baseline markers are reconstructible ("1" or empty).
bool durable(const std::string &path,const std::string &data){FILE*f=fopen(path.c_str(),"wb");if(!f)return false;bool ok=fwrite(data.data(),1,data.size(),f)==data.size()&&fflush(f)==0&&fsync(fileno(f))==0;fclose(f);return ok;}
std::string cycle_path(const Device&d){return "/data/scale-session-"+d.id;}
bool clear_cycle(const Device&d,bool include_legacy=false){
  for(const auto&suffix:{"",".a",".b",".tmp",".legacy",".legacy.a",".legacy.b"}){
    if(!include_legacy&&std::string(suffix).rfind(".legacy",0)==0)continue;
    if(!remove_file(cycle_path(d)+suffix))return false;
  }
  return true;
}
bool save_cycle(const Device&d,const afu::Cycle&cycle){
  auto j=cJSON_CreateObject();
  cJSON_AddStringToObject(j,"id",cycle.id.c_str());cJSON_AddStringToObject(j,"captured_at",cycle.captured_at.c_str());
  cJSON_AddStringToObject(j,"weight",hex(cycle.weight).c_str());cJSON_AddStringToObject(j,"adc",hex(cycle.adc).c_str());
  cJSON_AddBoolToObject(j,"closed",cycle.closed);cJSON_AddBoolToObject(j,"weight_queued",cycle.weight_queued);cJSON_AddBoolToObject(j,"adc_queued",cycle.adc_queued);
  auto data=js(j);cJSON_Delete(j);return durable_journal::save(cycle_path(d),data);
}
bool load_cycle(const Device&d,afu::Cycle&cycle){
  cycle={};std::string payload;bool present=false;
  if(!durable_journal::load(cycle_path(d),payload,present)){
    if(present)return false;
    // Migrate the original single-file record without dropping its message ID.
    FILE*f=fopen(cycle_path(d).c_str(),"rb");if(!f)return errno==ENOENT;
    char bytes[1024];size_t n=fread(bytes,1,sizeof(bytes)-1,f);fclose(f);bytes[n]=0;payload=bytes;
  }
  auto j=cJSON_Parse(payload.c_str());if(!j)return false;
  cycle.id=str(j,"id");cycle.captured_at=str(j,"captured_at");cycle.weight=unhex(str(j,"weight"));cycle.adc=unhex(str(j,"adc"));cycle.closed=cJSON_IsTrue(cJSON_GetObjectItem(j,"closed"));cycle.weight_queued=cJSON_IsTrue(cJSON_GetObjectItem(j,"weight_queued"));cycle.adc_queued=cJSON_IsTrue(cJSON_GetObjectItem(j,"adc_queued"));cJSON_Delete(j);
  afu::Packet weight,adc;
  if(cycle.id.size()!=32 || !afu::parse(cycle.weight,weight)||weight.opcode!=0xd5)return false;
  if(!weight.stable){
    // <=0.3.5 could persist a changing D5 as stable. Preserve that record
    // separately, without sending it as a new result or blocking new cycles.
    if(cycle.weight[6]!=2||(cycle.weight[2]&0x80))return false;
    auto path=cycle_path(d)+".legacy";std::string old;bool present=false;
    if(!durable_journal::load(path,old,present)&&present)return false;
    if(present&&old!=payload)return false;
    if(!durable_journal::save(path,payload)||!clear_cycle(d))return false;
    cycle={};return true;
  }
  if(!cycle.adc.empty()&&(!afu::parse(cycle.adc,adc)||adc.opcode!=0xd6||adc.grams!=weight.grams))return false;
  cycle.grams=weight.grams;return true;
}
bool flush_cycle(const Device&d,afu::Cycle&cycle){
  if(cycle.weight.empty())return true;
  if(!save_cycle(d,cycle)){error("Scale session cannot be persisted; errno="+std::to_string(errno));return false;}
  if(!cycle.weight_queued){if(!enqueue_scale(d,cycle.id,cycle.captured_at,cycle.weight,{}))return false;cycle.weight_queued=true;}
  if(!cycle.adc.empty()&&!cycle.adc_queued){if(!enqueue_scale(d,cycle.id,cycle.captured_at,cycle.weight,cycle.adc))return false;cycle.adc_queued=true;}
  return save_cycle(d,cycle);
}
void reset_wait(ScaleConnection&c){while(xSemaphoreTake(c.done,0)){}c.result=0;}
bool wait(ScaleConnection&c,int ms=7000,const char*stage="GATT"){
  bool completed=xSemaphoreTake(c.done,pdMS_TO_TICKS(ms))==pdTRUE;
  if(!completed||c.result)error(std::string("AFU ")+stage+(completed?" error="+std::to_string(c.result):" timeout"));
  return completed&&c.result==0;
}
int gap(ble_gap_event*e,void*arg){
  auto &c=*static_cast<ScaleConnection*>(arg);
  switch(e->type){
  case BLE_GAP_EVENT_CONNECT:c.result=e->connect.status;if(!c.result)c.conn=e->connect.conn_handle;xSemaphoreGive(c.done);break;
  case BLE_GAP_EVENT_DISCONNECT:
    if(c.conn==e->disconnect.conn.conn_handle){c.conn=BLE_HS_CONN_HANDLE_NONE;c.disconnect_reason=e->disconnect.reason;}
    c.result=BLE_HS_ENOTCONN;xSemaphoreGive(c.done);break;
  case BLE_GAP_EVENT_NOTIFY_RX:{
    size_t length=OS_MBUF_PKTLEN(e->notify_rx.om);
    if(c.conn!=e->notify_rx.conn_handle||length>64)break;
    Notice n{};n.connection=e->notify_rx.conn_handle;n.handle=e->notify_rx.attr_handle;n.length=length;os_mbuf_copydata(e->notify_rx.om,0,length,n.bytes);
    if(xQueueSend(c.notices,&n,0)!=pdTRUE)error("Scale notification queue full; measurement may be incomplete");
    break;
  }
  default:break;
  }return 0;
}
uint16_t short_uuid(const ble_uuid_t*u){if(u->type==BLE_UUID_TYPE_16)return BLE_UUID16(u)->value;if(u->type==BLE_UUID_TYPE_32){uint32_t v=BLE_UUID32(u)->value;return v<=0xffff?v:0;}if(u->type==BLE_UUID_TYPE_128)return afu::short_uuid(BLE_UUID128(u)->value,16);return 0;}
void inventory(ScaleConnection&c,const char*kind,const ble_uuid_t*u,uint16_t handle){if(c.inventory.size()>800)return;char text[BLE_UUID_STR_LEN];ble_uuid_to_str(u,text);c.inventory+=std::string(kind)+":"+text+"@"+std::to_string(handle)+" ";}
int mtu_cb(uint16_t,const ble_gatt_error*e,uint16_t,void*arg){auto &c=*static_cast<ScaleConnection*>(arg);c.result=e->status;xSemaphoreGive(c.done);return 0;}
int service_cb(uint16_t,const ble_gatt_error*e,const ble_gatt_svc*svc,void*arg){auto &c=*static_cast<ScaleConnection*>(arg);if(e->status){c.result=e->status==BLE_HS_EDONE?0:e->status;xSemaphoreGive(c.done);}else{inventory(c,"svc",&svc->uuid.u,svc->start_handle);if(short_uuid(&svc->uuid.u)==0xffb0){c.start=svc->start_handle;c.end=svc->end_handle;}}return 0;}
int characteristic_cb(uint16_t,const ble_gatt_error*e,const ble_gatt_chr*chr,void*arg){auto &c=*static_cast<ScaleConnection*>(arg);if(e->status){c.result=e->status==BLE_HS_EDONE?0:e->status;xSemaphoreGive(c.done);}else{inventory(c,"chr",&chr->uuid.u,chr->val_handle);if(short_uuid(&chr->uuid.u)==0xffb2&&(chr->properties&BLE_GATT_CHR_PROP_NOTIFY))c.notify=chr->val_handle;}return 0;}
int descriptor_cb(uint16_t,const ble_gatt_error*e,uint16_t chr,const ble_gatt_dsc*dsc,void*arg){auto &c=*static_cast<ScaleConnection*>(arg);if(e->status){c.result=e->status==BLE_HS_EDONE?0:e->status;xSemaphoreGive(c.done);}else{inventory(c,"dsc",&dsc->uuid.u,dsc->handle);if(chr==c.notify&&short_uuid(&dsc->uuid.u)==0x2902)c.cccd=dsc->handle;}return 0;}
int write_cb(uint16_t,const ble_gatt_error*e,ble_gatt_attr*,void*arg){auto &c=*static_cast<ScaleConnection*>(arg);c.result=e->status;xSemaphoreGive(c.done);return 0;}
void disconnect(ScaleConnection&c){
  afu_sample_signals();
  if(c.conn!=BLE_HS_CONN_HANDLE_NONE){ble_gap_terminate(c.conn,BLE_ERR_REM_USER_CONN_TERM);for(int n=0;n<40&&c.conn!=BLE_HS_CONN_HANDLE_NONE;++n)vTaskDelay(pdMS_TO_TICKS(50));}
  xQueueReset(c.notices);c.early_adc.clear();c.load_seen=false;
}
bool connect(ScaleConnection&c,const ble_addr_t&address){
  c.start=c.end=c.notify=c.cccd=0;c.disconnect_reason=0;c.inventory.clear();xQueueReset(c.notices);
  {
    BLEInitiation guard;uint8_t own;
    if(ble_hs_id_infer_auto(0,&own)){error("AFU local BLE address unavailable");return false;}
    reset_wait(c);
    int rc=ble_gap_connect(own,&address,7000,nullptr,gap,&c);if(rc){error("AFU connect start error="+std::to_string(rc));return false;}
    if(!wait(c,9000,"connect")){ble_gap_conn_cancel();return false;}
  }
  reset_wait(c);int rc=ble_gattc_exchange_mtu(c.conn,mtu_cb,&c);
  if(rc!=BLE_HS_EALREADY){if(rc){error("AFU MTU start error="+std::to_string(rc));return false;}if(!wait(c,7000,"MTU"))return false;}
  reset_wait(c);rc=ble_gattc_disc_all_svcs(c.conn,service_cb,&c);
  if(rc){error("AFU service discovery start error="+std::to_string(rc));return false;}
  if(!wait(c,7000,"service discovery"))return false;
  if(!c.start){error("AFU FFB0 service missing: "+c.inventory);return false;}
  reset_wait(c);rc=ble_gattc_disc_all_chrs(c.conn,c.start,c.end,characteristic_cb,&c);
  if(rc){error("AFU characteristic discovery start error="+std::to_string(rc));return false;}
  if(!wait(c,7000,"characteristic discovery"))return false;
  if(!c.notify){error("AFU notify FFB2 missing: "+c.inventory);return false;}
  reset_wait(c);rc=ble_gattc_disc_all_dscs(c.conn,c.notify,c.end,descriptor_cb,&c);
  if(rc){error("AFU descriptor discovery start error="+std::to_string(rc));return false;}
  if(!wait(c,7000,"descriptor discovery"))return false;
  if(!c.cccd){error("AFU FFB2 CCCD missing: "+c.inventory);return false;}
  uint8_t enable[]={1,0};reset_wait(c);
  rc=ble_gattc_write_flat(c.conn,c.cccd,enable,sizeof(enable),write_cb,&c);
  if(rc){error("AFU subscribe start error="+std::to_string(rc));return false;}
  return wait(c,7000,"subscribe");
}
bool seen_address(const Device&d,ble_addr_t&address){
  std::lock_guard<std::mutex> lock(scales_mutex);
  for(const auto &item:seen_scales){const auto&s=item.second;if(esp_timer_get_time()-s.when>15000000||s.hardware.empty()||s.name.rfind("AFU-WL",0)!=0)continue;
    if((!d.hardware_id.empty()&&s.hardware==d.hardware_id)||(d.hardware_id.empty()&&strcasecmp(address_string(s.address).c_str(),d.address.c_str())==0)){address=s.address;return true;}}
  return false;
}
void receive(ScaleConnection&c,const Device&d,const std::vector<uint8_t>&raw){
  afu::Packet p;if(!afu::parse(raw,p))return;
  auto &cycle=c.cycle;
  if(cycle.ends_on(p)){
    c.early_adc.clear();c.load_seen=false;cycle.closed=true;
    if(!flush_cycle(d,cycle)||!clear_cycle(d))return;
    cycle={};
    if(p.grams<1000)return;
  }
  if(p.opcode==0xd5&&p.grams>=1000)c.load_seen=true;
  if(cycle.closed){if(!flush_cycle(d,cycle)||!clear_cycle(d))return;cycle={};}
  if(p.opcode==0xd5&&cycle.accept_weight(p,raw)){
    uint8_t id[16];esp_fill_random(id,sizeof(id));cycle.id=hex(std::vector<uint8_t>(id,id+16));
    time_t now=time(nullptr);if(now>1700000000){tm t{};gmtime_r(&now,&t);char at[32];strftime(at,sizeof(at),"%Y-%m-%dT%H:%M:%SZ",&t);cycle.captured_at=at;}
    afu::Packet early;if(afu::parse(c.early_adc,early))cycle.accept_adc(early,c.early_adc);
    c.early_adc.clear();flush_cycle(d,cycle);
  }else if(p.opcode==0xd6){
    if(cycle.weight.empty()&&c.load_seen)c.early_adc=raw;
    else if(cycle.accept_adc(p,raw))flush_cycle(d,cycle);
  }
}
void worker(void*arg){
  size_t index=reinterpret_cast<size_t>(arg);auto &c=connections[index];std::string previous;int64_t resume_until=0;
  for(;;){
    vTaskDelay(pdMS_TO_TICKS(250));
    if(upgrading||lifecycle_busy||!collection_enabled()){previous.clear();c.cycle={};continue;}
    std::vector<Device> scales;for(auto d:devices())if(d.profile==afu::profile)scales.push_back(d);
    Device d;
    {
      std::lock_guard<std::mutex> lock(scales_mutex);
      std::vector<std::string> eligible;for(const auto&candidate:scales)if(candidate.enabled)eligible.push_back(candidate.id);
      std::array<std::string,2> owners{connections[0].device_id,connections[1].device_id};
      c.device_id=afu::choose_lane(eligible,owners,index);
      for(const auto&candidate:scales)if(candidate.id==c.device_id)d=candidate;
    }
    if(d.id.empty())continue;
    ble_addr_t address{};if(!seen_address(d,address))continue;
    c.busy=true;
    if(upgrading||lifecycle_busy||!collection_enabled()){c.busy=false;continue;}
    if(previous!=d.id){
      if(!load_cycle(d,c.cycle)||!flush_cycle(d,c.cycle)||!clear_cycle(d)){error("Cannot recover saved scale session; refusing to overwrite it");c.busy=false;vTaskDelay(pdMS_TO_TICKS(5000));continue;}
      // On a collector reboot, recover its durable messages first. A new link
      // is a new acquisition cycle; do not hold an old load cycle forever.
      c.cycle={};previous=d.id;resume_until=0;
    }
    if(!c.cycle.weight.empty()&&resume_until>0&&esp_timer_get_time()>=resume_until){if(!flush_cycle(d,c.cycle)||!clear_cycle(d)){c.busy=false;continue;}c.cycle={};}
    bool ok=connect(c,address);
    if(ok){
      afu_sample_signals();
      bool resuming=!c.cycle.weight.empty();
      while(c.conn!=BLE_HS_CONN_HANDLE_NONE&&!upgrading&&!lifecycle_busy&&collection_enabled()){
        bool assigned=false;for(auto current:devices())if(current.id==d.id&&current.enabled&&current.profile==afu::profile)assigned=true;if(!assigned)break;
        Notice n{};bool received=xQueueReceive(c.notices,&n,pdMS_TO_TICKS(100));
        if(received)trace_notice(n,c.notify);
        if(received&&n.connection==c.conn&&n.handle==c.notify){
          std::vector<uint8_t> raw(n.bytes,n.bytes+n.length);afu::Packet packet;
          if(resuming&&afu::parse(raw,packet)&&packet.opcode==0xd5&&packet.grams>=1000){
            if(!packet.stable||packet.grams!=c.cycle.grams){if(!flush_cycle(d,c.cycle)||!clear_cycle(d))break;c.cycle={};}
            resuming=false;
          }
          receive(c,d,raw);
        }
        if(!c.cycle.weight.empty()&&(!c.cycle.weight_queued||(!c.cycle.adc.empty()&&!c.cycle.adc_queued)))flush_cycle(d,c.cycle);
      }
    }else error("AFU connection or notification subscription failed");
    // A normal scale sleep ends the load cycle; radio loss retains the ID so
    // reconnect notifications can complete the interrupted measurement.
    if(c.disconnect_reason==BLE_HS_HCI_ERR(BLE_ERR_REM_USER_CONN_TERM)&&flush_cycle(d,c.cycle)&&clear_cycle(d)){c.cycle={};}
    resume_until=esp_timer_get_time()+30000000;
    disconnect(c);c.busy=false;
    vTaskDelay(pdMS_TO_TICKS(ok?500:3000));
  }
}
} // namespace

void afu_trace_start(int seconds){
  std::lock_guard<std::mutex> lock(trace_mutex);
  trace_entries={};trace_sequence=0;
  trace_until=seconds>0?esp_timer_get_time()+int64_t(std::min(seconds,180))*1000000:0;
}
std::string afu_trace_json(){
  std::vector<Trace> copy;uint32_t count;bool active;
  {std::lock_guard<std::mutex> lock(trace_mutex);copy.assign(trace_entries.begin(),trace_entries.end());count=trace_sequence;active=esp_timer_get_time()<trace_until;}
  // A cJSON tree for every sample used excessive heap during queue writes.
  // Every field is numeric/boolean or locally encoded hexadecimal, so emit
  // the bounded trace directly without allocating hundreds of JSON nodes.
  std::string out="{\"active\":"+std::string(active?"true":"false")+",\"received\":"+std::to_string(count)+",\"entries\":[";
  out.reserve(copy.size()*256+96);
  bool first=true;
  for(uint32_t seq=count>copy.size()?count-copy.size()+1:1;seq<=count;++seq){
    const auto &t=copy[(seq-1)%copy.size()];
    if(!first)out+=",";
    first=false;
    out+="{\"sequence\":"+std::to_string(seq)+",\"uptime_ms\":"+std::to_string(t.milliseconds);
    out+=",\"connection\":"+std::to_string(t.notice.connection)+",\"handle\":"+std::to_string(t.notice.handle)+",\"expected_handle\":"+std::to_string(t.expected_handle);
    std::vector<uint8_t> raw(t.notice.bytes,t.notice.bytes+t.notice.length);afu::Packet p;bool parsed=afu::parse(raw,p);
    out+=",\"raw_hex\":\""+hex(raw)+"\",\"parsed\":"+(parsed?"true":"false");
    if(parsed)out+=",\"opcode\":"+std::to_string(p.opcode)+",\"grams\":"+std::to_string(p.grams)+",\"stable\":"+(p.stable?"true":"false");
    out+="}";
  }
  return out+"]}";
}

void afu_discover(const ble_gap_disc_desc &disc){
  ble_hs_adv_fields f{};if(ble_hs_adv_parse_fields(&f,disc.data,disc.length_data))return;
  std::string name=f.name?std::string(reinterpret_cast<const char*>(f.name),f.name_len):"";
  std::string hardware=afu::hardware_id(f.mfg_data,f.mfg_data_len);
  if(hardware.empty()&&f.svc_data_uuid16_len>=2){std::vector<uint8_t> reconstructed(f.svc_data_uuid16,f.svc_data_uuid16+f.svc_data_uuid16_len);hardware=afu::hardware_id(reconstructed.data(),reconstructed.size());}
  std::lock_guard<std::mutex> lock(scales_mutex);auto key=address_string(disc.addr);
  // Cache incomplete advertisements only for candidates, and bound the cache.
  auto found=seen_scales.find(key);if(name.rfind("AFU-WL",0)!=0&&hardware.empty()&&found==seen_scales.end())return;
  if(seen_scales.size()>=24&&found==seen_scales.end()){auto oldest=seen_scales.begin();for(auto it=seen_scales.begin();it!=seen_scales.end();++it)if(it->second.when<oldest->second.when)oldest=it;seen_scales.erase(oldest);}
  auto &s=seen_scales[key];s.address=disc.addr;if(!name.empty())s.name=name;if(!hardware.empty())s.hardware=hardware;s.rssi=disc.rssi;s.when=esp_timer_get_time();
}
void afu_scan_items(cJSON*array){std::lock_guard<std::mutex> lock(scales_mutex);for(const auto &item:seen_scales){const auto &s=item.second;if(esp_timer_get_time()-s.when>60000000||s.hardware.empty()||s.name.rfind("AFU-WL",0)!=0)continue;auto j=cJSON_CreateObject();cJSON_AddStringToObject(j,"address",address_string(s.address).c_str());cJSON_AddNumberToObject(j,"address_type",s.address.type);cJSON_AddStringToObject(j,"name",s.name.c_str());cJSON_AddStringToObject(j,"profile",afu::profile);cJSON_AddStringToObject(j,"hardware_id",s.hardware.c_str());cJSON_AddNumberToObject(j,"rssi",s.rssi);cJSON_AddItemToArray(array,j);}}
void afu_start(){for(size_t i=0;i<connections.size();++i){auto &c=connections[i];c.done=xSemaphoreCreateBinary();c.notices=xQueueCreate(12,sizeof(Notice));xTaskCreate(worker,i?"afu_scale_2":"afu_scale_1",6144,reinterpret_cast<void*>(i),4,nullptr);}}
void afu_sample_signals(){
  auto assigned=devices();std::array<std::pair<std::string,uint16_t>,2> links;
  {
    std::lock_guard<std::mutex> lock(scales_mutex);
    for(const auto &d:assigned){
      if(!d.enabled||d.profile!=afu::profile)continue;
      for(const auto &p:seen_scales)if(!d.hardware_id.empty()&&strcasecmp(p.second.hardware.c_str(),d.hardware_id.c_str())==0)
        signal_cache.record(d.id,{p.second.rssi,p.second.when/1000,false,"advertisement"});
    }
    for(size_t i=0;i<connections.size();++i)links[i]={connections[i].device_id,connections[i].conn.load()};
  }
  for(size_t i=0;i<links.size();++i){
    const auto &link=links[i];if(link.second==BLE_HS_CONN_HANDLE_NONE||link.first.empty())continue;
    int8_t rssi=127;if(ble_gap_conn_rssi(link.second,&rssi))continue;
    std::lock_guard<std::mutex> lock(scales_mutex);
    if(connections[i].conn==link.second&&connections[i].device_id==link.first)
      signal_cache.record(link.first,{rssi,esp_timer_get_time()/1000,true,"connection"});
  }
}
void afu_pause(){for(auto &c:connections)while(c.busy)vTaskDelay(pdMS_TO_TICKS(50));}
bool afu_connected(const std::string&device){std::lock_guard<std::mutex> lock(scales_mutex);for(auto &c:connections)if(c.device_id==device&&c.conn!=BLE_HS_CONN_HANDLE_NONE)return true;return false;}
bool afu_lifecycle(const Device&d,const std::string&type){
  if(type=="device_bind"){
    ble_addr_t address{};if(!seen_address(d,address)){error("Wake AFU scale before binding");return false;}
    auto &c=connections[0];bool ok=connect(c,address);disconnect(c);if(!ok)return false;
    return clear_cycle(d,true)&&durable("/data/staged-"+d.id,"")&&durable("/data/registered-"+d.id,"1");
  }
  if(type=="prepare_data_reset")return clear_cycle(d,true)&&durable("/data/staged-"+d.id,"");
  if(!clear_cycle(d,true))return false;
  for(auto prefix:{"registered-","baseline-","staged-"})if(!remove_file("/data/"+std::string(prefix)+d.id))return false;
  return true;
}
