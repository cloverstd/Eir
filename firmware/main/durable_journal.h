#pragma once
#include <cerrno>
#include <cstdint>
#include <cstdio>
#include <string>
#include <unistd.h>

// SPIFFS rename does not replace existing files. Keep the last committed slot
// intact while writing the other slot; reject torn writes by length and CRC.
namespace durable_journal {
inline uint32_t crc32(const std::string &data) {
  uint32_t crc=0xffffffff;
  for(unsigned char byte:data){crc^=byte;for(int bit=0;bit<8;++bit)crc=(crc>>1)^((crc&1)?0xedb88320:0);}
  return ~crc;
}
inline uint32_t read32(const unsigned char*p){return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
inline void write32(unsigned char*p,uint32_t n){for(int i=0;i<4;++i)p[i]=n>>(i*8);}
struct Slot {bool present=false,valid=false;uint32_t generation=0;std::string payload;};
inline Slot read_slot(const std::string &path){
  Slot slot;FILE*f=fopen(path.c_str(),"rb");
  if(!f){slot.present=errno!=ENOENT;return slot;}
  slot.present=true;unsigned char header[16];
  if(fread(header,1,sizeof(header),f)==sizeof(header)&&header[0]=='E'&&header[1]=='J'&&header[2]=='R'&&header[3]=='1'){
    uint32_t size=read32(header+8);slot.generation=read32(header+4);
    if(size<=4096&&slot.generation>0){slot.payload.resize(size);bool complete=fread(slot.payload.data(),1,size,f)==size&&fgetc(f)==EOF;slot.valid=complete&&crc32(slot.payload)==read32(header+12);}
  }
  fclose(f);return slot;
}
inline bool load(const std::string &base,std::string &payload,bool &present){
  auto a=read_slot(base+".a"),b=read_slot(base+".b");present=a.present||b.present;
  if(!a.valid&&!b.valid)return false;
  payload=b.valid&&(!a.valid||b.generation>a.generation)?b.payload:a.payload;return true;
}
inline bool save(const std::string &base,const std::string &payload){
  if(payload.size()>4096){errno=EFBIG;return false;}
  auto a=read_slot(base+".a"),b=read_slot(base+".b");
  if(!a.valid&&!b.valid&&(a.present||b.present)){errno=EIO;return false;}
  bool active_b=b.valid&&(!a.valid||b.generation>a.generation);
  uint32_t previous=active_b?b.generation:(a.valid?a.generation:0);
  if(previous==UINT32_MAX){errno=EOVERFLOW;return false;}
  std::string path=base+(active_b||!a.valid?".a":".b");
  unsigned char header[16]={'E','J','R','1'};write32(header+4,previous+1);write32(header+8,payload.size());write32(header+12,crc32(payload));
  FILE*f=fopen(path.c_str(),"wb");if(!f)return false;
  bool ok=fwrite(header,1,sizeof(header),f)==sizeof(header)&&fwrite(payload.data(),1,payload.size(),f)==payload.size()&&fflush(f)==0&&fsync(fileno(f))==0;
  if(fclose(f)!=0)ok=false;
  return ok;
}
}
