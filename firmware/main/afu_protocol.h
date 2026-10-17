// AFU format adapted from Xuan-lprk/smart-body-scale-IOS, commit c11f1b9.
// SPDX-License-Identifier: GPL-3.0-only. See LICENSE.afu.
#pragma once
#include <cstdint>
#include <array>
#include <algorithm>
#include <cstdio>
#include <string>
#include <vector>
namespace afu {
constexpr const char *profile="afu-wl-tz-a1";
struct Packet { int grams=0; bool stable=false; uint8_t opcode=0; std::vector<int> adcs; };
inline bool parse(const std::vector<uint8_t> &raw,Packet &p) {
  p={};
  if(raw.size()<20 || raw.size()>21 || raw[0]!=0xac || raw[raw.size()-3]!=0x29)return false;
  p.opcode=raw[raw.size()-2];
  if(p.opcode==0xd5) {
    if(raw.size()!=20 || raw[3]<0x68)return false;
    p.grams=(int(raw[3]-0x68)<<16)|(int(raw[4])<<8)|raw[5];
    // TZ-A1 sends status 02 during live changes too. The high bit becomes
    // set only when its displayed result locks (verified notification trace).
    p.stable=(raw[2]&0x80)!=0 && raw[6]==2;
  } else if(p.opcode==0xd6) {
    if(raw[2]!=2)return false;
    p.grams=((uint32_t(raw[9])<<24)|(uint32_t(raw[10])<<16)|(uint32_t(raw[11])<<8)|raw[12])&0x3ffff;
    p.adcs={int(raw[4])<<8|raw[5],int(raw[6])<<8|raw[7]};
  } else return false;
  return p.grams<=300000;
}
inline std::string hardware_id(const uint8_t *data,size_t n) {
  if(n<8 || data[0]!=0xac || (data[1]&0x70)!=0x20 || (data[1]&15)!=7)return "";
  char out[18];snprintf(out,sizeof(out),"%02X:%02X:%02X:%02X:%02X:%02X",data[7],data[6],data[5],data[4],data[3],data[2]);return out;
}
// Bluetooth base UUIDs are equivalent to their 16-bit form, even when a
// vendor's GATT table encodes them as 128-bit attributes (little endian).
inline uint16_t short_uuid(const uint8_t*bytes,size_t size){
  if(size==2)return uint16_t(bytes[0])|(uint16_t(bytes[1])<<8);
  const uint8_t base[16]={0xfb,0x34,0x9b,0x5f,0x80,0x00,0x00,0x80,0x00,0x10,0x00,0x00,0x00,0x00,0x00,0x00};
  if(size!=16)return 0;
  for(size_t i=0;i<16;++i)if(i!=12&&i!=13&&bytes[i]!=base[i])return 0;
  return uint16_t(bytes[12])|(uint16_t(bytes[13])<<8);
}
// Lane ownership is independent of config ordering. Adding a lower UUID must
// not make both workers connect to the scale that already owns a lane.
inline std::string choose_lane(const std::vector<std::string>&eligible,const std::array<std::string,2>&owners,size_t lane){
  const auto &own=owners[lane];
  auto claimed=[&](const std::string&id){for(size_t i=0;i<owners.size();++i)if(i!=lane&&owners[i]==id)return true;return false;};
  if(std::find(eligible.begin(),eligible.end(),own)!=eligible.end()&&!claimed(own))return own;
  for(const auto&id:eligible)if(!claimed(id))return id;
  return "";
}
// Live D5 after a locked result marks a new load cycle; TZ-A1 need not send
// a zero-weight packet between people. Equal weights in distinct cycles stay
// distinct, whereas repeats of the locked packet retain their ID.
struct Cycle {
  std::string id, captured_at;
  std::vector<uint8_t> weight,adc;
  int grams=0;
  bool weight_queued=false,adc_queued=false,closed=false;
  bool ends_on(const Packet&p)const {
    return p.opcode==0xd5&&(p.grams<1000||(!p.stable&&!weight.empty()));
  }
  bool accept_weight(const Packet &p,const std::vector<uint8_t>&raw) {
    if(p.opcode!=0xd5)return false;
    if(p.grams<1000){closed=true;return false;}
    if(!p.stable || !weight.empty())return false;
    grams=p.grams;weight=raw;return true;
  }
  bool accept_adc(const Packet &p,const std::vector<uint8_t>&raw) {
    if(closed||p.opcode!=0xd6||weight.empty()||p.grams!=grams||!adc.empty())return false;
    adc=raw;return true;
  }
};
}
