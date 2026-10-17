#include "../main/signal_policy.h"
#include <cassert>
int main(){
 signal_policy::Cache cache;signal_policy::Sample sample;
 assert(!cache.take("device",1000,sample));
 cache.record("device",{-60,1000,false,"advertisement"});
 assert(cache.take("device",1000,sample)&&sample.rssi==-60);
 assert(!cache.take("device",5000,sample));
 cache.record("device",{-70,900,false,"advertisement"});
 assert(!cache.take("device",5000,sample));
 cache.record("device",{-55,6000,true,"connection"});
 assert(cache.take("device",6000,sample)&&sample.connected);
 cache.record("device",{127,7000,true,"connection"});assert(!cache.take("device",7000,sample));
 cache.record("device",{-85,8000,false,"advertisement"});assert(!cache.take("device",24000,sample));
 cache.clear();assert(!cache.take("device",8000,sample));
 cache.clear(9000);cache.record("device",{-60,8000,false,"advertisement"});assert(!cache.take("device",9000,sample));
 cache.record("device",{-61,9001,false,"advertisement"});assert(cache.take("device",9001,sample));cache.clear();
 for(int i=0;i<100;++i)cache.record(std::to_string(i),{-60,1000+i,false,"advertisement"});
 assert(!cache.take("0",1100,sample));assert(cache.take("99",1100,sample));
}
