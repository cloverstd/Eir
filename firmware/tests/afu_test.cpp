#include "../main/afu_protocol.h"
#include <cassert>
std::vector<uint8_t> hex(const char*s){std::vector<uint8_t>out;while(*s){unsigned v;assert(sscanf(s,"%2x",&v)==1);out.push_back(v);s+=2;}return out;}
int main(){
 auto uuid=hex("fb349b5f8000008000100000b0ff0000");assert(afu::short_uuid(uuid.data(),uuid.size())==0xffb0);
 uuid[12]=0xb2;assert(afu::short_uuid(uuid.data(),uuid.size())==0xffb2);
 uuid[0]=0;assert(afu::short_uuid(uuid.data(),uuid.size())==0);
 auto shortID=hex("b2ff");assert(afu::short_uuid(shortID.data(),shortID.size())==0xffb2);

 std::array<std::string,2> owners{};
 owners[0]=afu::choose_lane({"scale-b"},owners,0);assert(owners[0]=="scale-b");
 owners[1]=afu::choose_lane({"scale-a","scale-b"},owners,1);assert(owners[1]=="scale-a");
 assert(afu::choose_lane({"scale-a","scale-b"},owners,0)=="scale-b");
 assert(afu::choose_lane({"scale-b","scale-a"},owners,1)=="scale-a");
 assert(afu::choose_lane({"scale-a"},owners,0).empty());

 auto weight=hex("ac298069117002000540000a000000000029d51b");
 auto adc=hex("ac29020001f401c20180691170000000000029d60f");
 afu::Packet w,a;assert(afu::parse(weight,w)&&w.stable&&w.grams==70000);assert(afu::parse(adc,a)&&a.grams==70000&&a.adcs[0]==500&&a.adcs[1]==450);
 auto bad=weight;bad.resize(18);assert(!afu::parse(bad,w));bad=adc;bad[2]=5;assert(!afu::parse(bad,a));bad=weight;bad[18]=0xd8;assert(!afu::parse(bad,w));
 afu::parse(weight,w);afu::parse(adc,a);afu::Cycle c1,c2;
 auto live=weight;live[2]=0;afu::Packet changing;assert(afu::parse(live,changing)&&!changing.stable&&changing.grams==70000);
 assert(!c1.accept_weight(changing,live)&&c1.weight.empty());
 assert(c1.accept_weight(w,weight));assert(!c1.accept_weight(w,weight));assert(c1.accept_adc(a,adc));assert(!c1.accept_adc(a,adc));
 assert(!c1.ends_on(w)&&c1.ends_on(changing));
 // No zero packet is required; the next live phase starts a distinct cycle
 // even when the next locked weight is exactly the same.
 afu::Cycle next;assert(!next.accept_weight(changing,live));assert(!next.accept_adc(a,adc));assert(next.accept_weight(w,weight));
 // Two scales receive identical bytes independently; neither is global state.
 assert(c2.accept_weight(w,weight));auto mismatch=a;mismatch.grams=70100;assert(!c2.accept_adc(mismatch,adc));assert(c2.adc.empty());
 auto unloaded=w;unloaded.grams=0;assert(!c1.accept_weight(unloaded,weight)&&c1.closed);c1={};assert(c1.accept_weight(w,weight));
 uint8_t adv[]={0xac,0x27,0x66,0x55,0x44,0x33,0x22,0x11};assert(afu::hardware_id(adv,sizeof(adv))=="11:22:33:44:55:66");adv[2]=0x77;assert(afu::hardware_id(adv,sizeof(adv))=="11:22:33:44:55:77");assert(afu::hardware_id(adv,2).empty());
}
