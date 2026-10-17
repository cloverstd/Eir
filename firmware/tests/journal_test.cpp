#include "../main/durable_journal.h"
#include <cassert>
#include <cstdlib>
void replace(const std::string&path,const std::string&data){FILE*f=fopen(path.c_str(),"wb");assert(f);assert(fwrite(data.data(),1,data.size(),f)==data.size());fclose(f);}
int main(){
  using namespace durable_journal;
  assert(crc32("123456789")==0xcbf43926);
  char dir[]="/tmp/eir-journal-XXXXXX";assert(mkdtemp(dir));std::string base=std::string(dir)+"/cycle",value;bool present;
  assert(!load(base,value,present)&&!present);
  assert(save(base,"stable-weight"));assert(load(base,value,present)&&value=="stable-weight");
  assert(save(base,"weight-and-adc"));assert(load(base,value,present)&&value=="weight-and-adc");
  // Power loss while truncating/writing the inactive slot retains the commit.
  replace(base+".a","EJR1-partial");assert(load(base,value,present)&&value=="weight-and-adc");
  assert(save(base,"next-cycle"));assert(load(base,value,present)&&value=="next-cycle");
  // A complete-sized but corrupted newest payload also falls back safely.
  FILE*f=fopen((base+".a").c_str(),"r+b");assert(f);assert(fseek(f,-1,SEEK_END)==0);fputc('X',f);fclose(f);
  assert(load(base,value,present)&&value=="weight-and-adc");
  replace(base+".b","torn");assert(!load(base,value,present)&&present);
  assert(!save(base,"must-not-overwrite-corrupt-history"));
  unlink((base+".a").c_str());unlink((base+".b").c_str());rmdir(dir);
}
