#include "../main/protocol.h"
#include <cassert>
int main() {
  using namespace omron;
  auto f = frame(0x8100, 0x1c4, 16, std::vector<uint8_t>(16, 7));
  assert(valid(f, 0x8100, 0x1c4));
  f[9] ^= 1;
  assert(!valid(f, 0x8100, 0x1c4));
  std::vector<uint8_t> p(34, 0xc0);
  auto e = frame(0x81c0, 0x54, 34, p);
  assert(echo(e, 0x54, p));
  e[6] = 0;
  assert(!echo(e, 0x54, p));
  assert(!write_allowed(0x1c4, 16));
  std::vector<uint8_t> h(24);
  h[0] = 12;
  h[8] = 12;
  assert(slot_count(h, 1) == 12);
  h[0] = 10;
  h[8] = 11;
  assert(slot_count(h, 1) == 10);
  h[0] = 1;
  h[8] = 101;
  assert(slot_count(h, 1) == 100);
  h[0] = 35;
  h[8] = 0;
  assert(slot_count(h, 1) == 100);
  h[0] = 101;
  assert(slot_count(h, 1) == -1);
  assert(address(2, 99) == 0xe34);
}
