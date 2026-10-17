#pragma once
#include <algorithm>
#include <cstdint>
#include <vector>
namespace omron {
inline uint8_t checksum(const std::vector<uint8_t> &v) {
  uint8_t s = 0;
  for (auto b : v)
    s ^= b;
  return s;
}
inline std::vector<uint8_t> frame(uint16_t op, uint16_t addr, uint8_t size,
                                  const std::vector<uint8_t> &payload = {}) {
  std::vector<uint8_t> v = {
      uint8_t(8 + payload.size()), uint8_t(op >> 8), uint8_t(op),
      uint8_t(addr >> 8),          uint8_t(addr),    size};
  v.insert(v.end(), payload.begin(), payload.end());
  v.push_back(0);
  v.push_back(checksum(v));
  return v;
}
inline bool valid(const std::vector<uint8_t> &v, uint16_t op, uint16_t addr) {
  return v.size() >= 8 && v.size() == v[0] && checksum(v) == 0 &&
         v[1] == (op >> 8) && v[2] == (op & 255) && v[3] == (addr >> 8) &&
         v[4] == (addr & 255);
}
inline bool write_allowed(uint16_t a, size_t n) {
  return (a == 0x54 && n == 34) || (a == 0x80 && n == 16);
}
inline bool echo(const std::vector<uint8_t> &v, uint16_t a,
                 const std::vector<uint8_t> &p) {
  return write_allowed(a, p.size()) && valid(v, 0x81c0, a) &&
         v.size() == p.size() + 8 && v[5] == p.size() && v[v.size() - 2] == 0 &&
         std::equal(p.begin(), p.end(), v.begin() + 6);
}
inline uint16_t le16(const uint8_t *p) { return p[0] | (p[1] << 8); }
inline int slot_count(const std::vector<uint8_t> &h, int user) {
  if (h.size() < 24 || user < 1 || user > 2)
    return -1;
  int cursor = le16(&h[(user - 1) * 2]) & 255;
  if (cursor > 100)
    return -1;
  int seq = le16(&h[8 + (user - 1) * 4]);
  return cursor == 0 ? 0 : (seq > 100 || seq < cursor ? 100 : cursor);
}
inline uint16_t address(int user, int slot) {
  return (user == 1 ? 0x1c4 : 0x804) + slot * 16;
}
} // namespace omron
