package server

import (
	"eir/internal/store"
	"net/http"
)

func signalFilters(w http.ResponseWriter, r *http.Request) (collector, kind, device string, ok bool) {
	q := r.URL.Query()
	collector = q.Get("collector_id")
	kind = q.Get("kind")
	device = q.Get("device_id")
	if (collector != "" && !store.CollectorPattern.MatchString(collector)) || (kind != "" && kind != "wifi" && kind != "ble") || (device != "" && !store.UUIDPattern.MatchString(device)) || (kind == "wifi" && device != "") {
		bad(w, "无效信号筛选条件")
		return
	}
	ok = true
	return
}
func (s *Server) signalsLatest(w http.ResponseWriter, r *http.Request) {
	c, k, d, ok := signalFilters(w, r)
	if !ok {
		return
	}
	v, e := s.Store.LatestSignals(r.Context(), c, k, d)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, v)
}
func (s *Server) signalsHistory(w http.ResponseWriter, r *http.Request) {
	c, k, d, ok := signalFilters(w, r)
	if !ok {
		return
	}
	ranges := map[string][2]int{"15m": {900, 5}, "1h": {3600, 5}, "24h": {86400, 60}, "7d": {604800, 300}}
	name := r.URL.Query().Get("range")
	if name == "" {
		name = "1h"
	}
	size, ok := ranges[name]
	if !ok || c == "" || k == "" || (k == "ble" && d == "") {
		bad(w, "请选择采集端、信号链路和有效时间范围")
		return
	}
	v, e := s.Store.SignalHistory(r.Context(), c, k, d, size[0], size[1])
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, map[string]any{"items": v, "range": name, "bucket_seconds": size[1]})
}
