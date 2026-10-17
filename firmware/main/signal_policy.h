#pragma once
#include <map>
#include <mutex>
#include <string>
#include <cstdint>

namespace signal_policy {
struct Sample {int rssi=0;int64_t when=0;bool connected=false;const char *source="advertisement";};
// Only configured device IDs enter this cache. Bound memory even if assignment
// changes repeatedly; neither samples nor publication cursors use Flash.
class Cache {
  std::mutex mutex;
  struct Entry {Sample sample;int64_t sent=-1;};
  std::map<std::string,Entry> entries;
  int64_t since=0;
public:
  void record(const std::string&id,const Sample&sample){
    if(id.empty()||sample.rssi < -127||sample.rssi>20)return;
    std::lock_guard<std::mutex> lock(mutex);
    if(sample.when<since)return;
    auto it=entries.find(id);
    if(it==entries.end()&&entries.size()>=32){auto oldest=entries.begin();for(auto p=entries.begin();p!=entries.end();++p)if(p->second.sample.when<oldest->second.sample.when)oldest=p;entries.erase(oldest);}
    auto &e=entries[id];if(sample.when>=e.sample.when)e.sample=sample;
  }
  bool take(const std::string&id,int64_t now,Sample&sample){
    std::lock_guard<std::mutex> lock(mutex);auto it=entries.find(id);
    if(it==entries.end()||it->second.sample.when<=it->second.sent||now-it->second.sample.when>15000||now<it->second.sample.when)return false;
    sample=it->second.sample;it->second.sent=sample.when;return true;
  }
  void clear(int64_t when=0){std::lock_guard<std::mutex> lock(mutex);entries.clear();since=when;}
};
}
