#pragma once
#include <string>
#include <cstddef>
#include <cstdint>
#include <cerrno>
namespace lifecycle_policy {
struct Scope {
  std::string instance, binding, epoch;
  bool bound() const { return !instance.empty() && !binding.empty() && !epoch.empty(); }
};
inline bool matches(const Scope &current, const Scope &incoming) {
  return current.bound() && current.instance == incoming.instance &&
         current.binding == incoming.binding && current.epoch == incoming.epoch;
}
inline bool claim(const Scope &current, const Scope &incoming,
                  const std::string &nonce, const std::string &requested_nonce,
                  bool busy) {
  return !busy && !nonce.empty() && nonce == requested_nonce && incoming.bound() &&
         (!current.bound() || matches(current, incoming));
}
inline bool deletion_succeeded(int result, int error) { return result == 0 || error == ENOENT; }
constexpr std::size_t receipt_capacity = 32;
inline bool receipt_evictable(std::int64_t expiry, std::int64_t now, bool latest) {
  return !latest && expiry > 0 && now > 1700000000 && expiry <= now;
}
inline bool receipt_room(std::size_t count, bool duplicate) {
  return duplicate || count < receipt_capacity;
}
inline bool owns_preparation(const std::string &id, const std::string &prepared,
                             const std::string &snapshot) {
  return !id.empty() && (prepared == id || snapshot == id) &&
         (prepared.empty() || prepared == id) &&
         (snapshot.empty() || snapshot == id);
}
inline bool retire_preparation(const std::string&type,const std::string&status,const std::string&id,
                               const std::string&prepared,const std::string&snapshot){
  return status=="succeeded"&&(type=="device_bind"||type=="commit_data_reset")&&!id.empty()&&prepared.empty()&&snapshot==id;
}
inline bool abort_allowed(const std::string &id,const std::string &prepared,const std::string &snapshot) {
  return !id.empty() && ((prepared.empty()&&snapshot.empty()) || owns_preparation(id,prepared,snapshot));
}
inline bool retry_empty_abort(const std::string &type,const std::string &status,const std::string &error,
                              const std::string &id,const std::string &prepared,const std::string &snapshot) {
  return type=="abort_data_reset" && status=="failed" && error=="Abort does not own current prepared baseline" &&
         abort_allowed(id,prepared,snapshot);
}
inline std::string receipt_key(const std::string &id, const std::string &phase,
                               const std::string &type) {
  return id + ":" + phase + ":" + type;
}
}
