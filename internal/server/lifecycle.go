package server

import (
	"eir/internal/store"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (s *Server) lifecycleRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/collectors/discovered", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT *,status->'online'='true'::jsonb AND last_seen>now()-interval '90 seconds' AS online FROM collector_candidates ORDER BY last_seen DESC")
	})
	m.HandleFunc("POST /api/v1/collectors/{id}/bind", s.claimCollector)
	m.HandleFunc("POST /api/v1/collectors/{id}/unbind", s.unbindCollector)
	m.HandleFunc("DELETE /api/v1/collectors/{id}", s.deleteCollector)
	m.HandleFunc("POST /api/v1/collectors/{id}/reset", s.resetCollector)
	m.HandleFunc("POST /api/v1/devices/{id}/bind", s.bindDevice)
	m.HandleFunc("POST /api/v1/devices/{id}/unbind", s.unbindDevice)
	m.HandleFunc("POST /api/v1/bindings/{id}/unbind", s.unbindMember)
	m.HandleFunc("POST /api/v1/operations/preview", s.resetPreview)
	m.HandleFunc("POST /api/v1/system/reset", s.systemReset)
	m.HandleFunc("GET /api/v1/operations", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT * FROM operations ORDER BY created_at DESC LIMIT 100")
	})
	m.HandleFunc("GET /api/v1/operations/{id}", func(w http.ResponseWriter, r *http.Request) {
		s.one(w, r, "SELECT o.*,coalesce((SELECT jsonb_agg(jsonb_build_object('collector_id',collector_id,'status',status)) FROM operation_targets WHERE operation_id=o.id),'[]') AS targets FROM operations o WHERE id::text=$1", r.PathValue("id"))
	})
}
func (s *Server) operationResponse(w http.ResponseWriter, r *http.Request, id string) {
	s.Changed()
	respond(w, 202, map[string]any{"operation_id": id})
}
func (s *Server) claimCollector(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Nonce    string `json:"enrollment_nonce"`
		Name     string `json:"name"`
		Location string `json:"location"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !store.CollectorPattern.MatchString(r.PathValue("id")) || in.Nonce == "" || len(in.Nonce) > 128 || len(in.Name) > 100 || len(in.Location) > 200 {
		bad(w, "无效设备或入网信息")
		return
	}
	id, e := s.Store.Claim(r.Context(), r.PathValue("id"), in.Nonce, strings.TrimSpace(in.Name), in.Location)
	if e != nil {
		bad(w, e.Error())
		return
	}
	if s.Bus != nil {
		s.Bus.PublishConfig(r.Context(), r.PathValue("id"))
	}
	s.operationResponse(w, r, id)
}
func (s *Server) unbindCollector(w http.ResponseWriter, r *http.Request) {
	id, e := s.Store.StartOperation(r.Context(), "collector_unbind", r.PathValue("id"), "", "", "")
	if e != nil {
		bad(w, e.Error())
		return
	}
	s.operationResponse(w, r, id)
}
func (s *Server) deleteCollector(w http.ResponseWriter, r *http.Request) {
	if !store.CollectorPattern.MatchString(r.PathValue("id")) {
		bad(w, "无效采集端 ID")
		return
	}
	e := s.Store.RemoveCollector(r.Context(), r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	respond(w, 200, map[string]any{"deleted": true, "device_cleanup_confirmed": false, "history_preserved": true})
}
func (s *Server) bindDevice(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Collector string `json:"collector_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !store.UUIDPattern.MatchString(r.PathValue("id")) {
		bad(w, "无效设备 ID")
		return
	}
	id, e := s.Store.StartOperation(r.Context(), "device_bind", in.Collector, r.PathValue("id"), "", "")
	if e != nil {
		bad(w, e.Error())
		return
	}
	if s.Bus != nil {
		s.Bus.PublishConfig(r.Context(), in.Collector)
	}
	s.operationResponse(w, r, id)
}
func (s *Server) unbindDevice(w http.ResponseWriter, r *http.Request) {
	var owner *string
	e := s.Store.DB.QueryRow(r.Context(), "SELECT collector_id FROM devices WHERE id::text=$1", r.PathValue("id")).Scan(&owner)
	if e != nil {
		fail(w, e)
		return
	}
	if owner == nil {
		respond(w, 200, map[string]string{"status": "unbound"})
		return
	}
	id, e := s.Store.StartOperation(r.Context(), "device_unbind", *owner, r.PathValue("id"), "", "")
	if e != nil {
		bad(w, e.Error())
		return
	}
	s.operationResponse(w, r, id)
}
func (s *Server) unbindMember(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	var device string
	var slot int
	e = tx.QueryRow(ctx, "SELECT device_id::text,user_slot FROM bindings WHERE id::text=$1", r.PathValue("id")).Scan(&device, &slot)
	if e != nil {
		fail(w, e)
		return
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "binding/"+device+"/"+jsonNumber(slot)); e != nil {
		fail(w, e)
		return
	}
	var alreadyClosed *time.Time
	e = tx.QueryRow(ctx, "SELECT effective_to FROM bindings WHERE id::text=$1 FOR UPDATE", r.PathValue("id")).Scan(&alreadyClosed)
	if e != nil {
		fail(w, e)
		return
	}
	if alreadyClosed != nil {
		if e = tx.Commit(ctx); e != nil {
			fail(w, e)
			return
		}
		s.one(w, r, "SELECT * FROM bindings WHERE id::text=$1", r.PathValue("id"))
		return
	}
	var cutoff time.Time
	e = tx.QueryRow(ctx, "UPDATE bindings SET effective_to=coalesce(effective_to,greatest(now(),effective_from+interval '1 microsecond')) WHERE id::text=$1 RETURNING effective_to", r.PathValue("id")).Scan(&cutoff)
	if e != nil {
		fail(w, e)
		return
	}
	// Future-clock records are reassigned only when automatic; historical records stay untouched.
	_, e = tx.Exec(ctx, `WITH changed AS(SELECT id,to_jsonb(m) previous FROM measurements m WHERE device_id=$1 AND user_slot=$2 AND measured_at>=$3 AND NOT manual_assignment AND member_id=(SELECT member_id FROM bindings WHERE id::text=$4)), upd AS(UPDATE measurements m SET member_id=NULL FROM changed c WHERE m.id=c.id RETURNING m.id,c.previous,to_jsonb(m) current) INSERT INTO measurement_audit(measurement_id,previous,current) SELECT id,previous,current FROM upd`, device, slot, cutoff, r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	if e = store.RecalculateDeviceBody(ctx, tx, device, cutoff); e != nil {
		fail(w, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM bindings WHERE id::text=$1", r.PathValue("id"))
}
func jsonNumber(n int) string { b, _ := json.Marshal(n); return string(b) }

type resetInput struct {
	Type         string `json:"type"`
	Collector    string `json:"collector_id"`
	Scope        string `json:"scope"`
	Mode         string `json:"mode"`
	Token        string `json:"preview_token"`
	Confirmation string `json:"confirmation"`
}

func (s *Server) resetPreview(w http.ResponseWriter, r *http.Request) {
	var in resetInput
	if !decode(w, r, &in) {
		return
	}
	if in.Type != "collector_reset" && in.Type != "factory_reset" && in.Type != "system_reset" {
		bad(w, "无效重置类型")
		return
	}
	if in.Type == "system_reset" && in.Scope != "all" && in.Scope != "measurements" {
		bad(w, "无效重置范围")
		return
	}
	if in.Type != "system_reset" && !store.CollectorPattern.MatchString(in.Collector) {
		bad(w, "无效采集端")
		return
	}
	sys, e := s.Store.System(r.Context())
	if e != nil {
		fail(w, e)
		return
	}
	counts, e := s.Store.One(r.Context(), "SELECT (SELECT CASE WHEN $3::boolean THEN count(*) ELSE 0 END FROM members) AS members,(SELECT CASE WHEN $3::boolean THEN count(*) ELSE 0 END FROM health_history) AS health_history,(SELECT CASE WHEN $3::boolean THEN count(*) ELSE 0 END FROM medical_documents) AS documents,(SELECT CASE WHEN $2::boolean THEN count(*) ELSE 0 END FROM manual_observations) AS manual_observations,(SELECT CASE WHEN $2::boolean THEN count(*) ELSE 0 END FROM measurements) AS measurements,(SELECT count(*) FROM devices WHERE ($1='' OR collector_id=$1)) AS devices,(SELECT count(*) FROM collectors WHERE ($1='' OR id=$1)) AS collectors,(SELECT coalesce(sum(CASE WHEN jsonb_typeof(status->'queue_depth')='number' THEN (status->>'queue_depth')::integer ELSE 0 END),0) FROM collectors WHERE ($1='' OR id=$1)) AS queued_records", in.Collector, in.Type == "system_reset", in.Type == "system_reset" && in.Scope == "all")
	if e != nil {
		fail(w, e)
		return
	}
	blockers := []string{}
	if in.Type != "system_reset" || in.Scope != "all" {
		rows, e := s.Store.DB.Query(r.Context(), "SELECT id,protocol_version,lifecycle_state,coalesce(status->'online'='true'::jsonb,false) AND last_seen>now()-interval '90 seconds' FROM collectors WHERE ($1='' OR id=$1)", in.Collector)
		if e != nil {
			fail(w, e)
			return
		}
		found := false
		for rows.Next() {
			found = true
			var id, state string
			var proto int
			var online bool
			if rows.Scan(&id, &proto, &state, &online) != nil {
				continue
			}
			if !online || proto < 2 || state != "bound" {
				blockers = append(blockers, id+" 必须在线、已绑定并升级至管理固件")
			}
		}
		rows.Close()
		if in.Type != "system_reset" && !found {
			blockers = append(blockers, "采集端不存在")
		}
		var busy bool
		s.Store.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM operations WHERE status IN('pending','preparing','committing') AND ($1='' OR collector_id=$1 OR type='system_reset')) OR EXISTS(SELECT 1 FROM ota_jobs WHERE status IN('pending','downloading','rebooting') AND ($1='' OR collector_id=$1))", in.Collector).Scan(&busy)
		if busy {
			blockers = append(blockers, "相关设备有正在进行的操作")
		}
	}
	token := ID()
	expires := time.Now().Add(5 * time.Minute)
	_, e = s.Store.DB.Exec(r.Context(), "INSERT INTO operation_previews(token,type,collector_id,scope,data_epoch,revision,counts,expires_at) VALUES($1,$2,nullif($3,''),$4,$5,$6,$7,$8)", token, in.Type, in.Collector, in.Scope, sys.DataEpoch, sys.Revision, counts, expires)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, map[string]any{"preview_token": token, "counts": counts, "blockers": blockers, "expires_at": expires, "notice": "不会删除血压计记录、已有备份或固件库；清空健康数据前必须唤醒设备建立基线。"})
}
func (s *Server) validatePreview(r *http.Request, in resetInput, kind, collector, scope string) error {
	if in.Confirmation != "RESET" || !store.UUIDPattern.MatchString(in.Token) {
		return errors.New("需要有效预览和 RESET 确认")
	}
	var storedType, storedCollector, storedScope, epoch string
	var revision int64
	var expires time.Time
	e := s.Store.DB.QueryRow(r.Context(), "SELECT type,coalesce(collector_id,''),scope,data_epoch::text,revision,expires_at FROM operation_previews WHERE token=$1", in.Token).Scan(&storedType, &storedCollector, &storedScope, &epoch, &revision, &expires)
	if e != nil {
		return e
	}
	if kind != storedType || collector != storedCollector || scope != storedScope {
		return errors.New("预览与操作范围不一致")
	}
	var exists bool
	s.Store.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM operations WHERE id=$1)", in.Token).Scan(&exists)
	if exists {
		return nil
	}
	sys, e := s.Store.System(r.Context())
	if e != nil {
		return e
	}
	if !expires.After(time.Now()) || epoch != sys.DataEpoch || revision != sys.Revision {
		return errors.New("预览已过期或系统状态已改变，请重新预览")
	}
	return nil
}
func (s *Server) resetCollector(w http.ResponseWriter, r *http.Request) {
	var in resetInput
	if !decode(w, r, &in) {
		return
	}
	kind := "collector_reset"
	if in.Mode == "factory" {
		kind = "factory_reset"
	} else if in.Mode != "runtime" {
		bad(w, "mode 必须为 runtime 或 factory")
		return
	}
	if e := s.validatePreview(r, in, kind, r.PathValue("id"), ""); e != nil {
		bad(w, e.Error())
		return
	}
	id, e := s.Store.StartOperation(r.Context(), kind, r.PathValue("id"), "", "", in.Token)
	if e != nil {
		bad(w, e.Error())
		return
	}
	s.operationResponse(w, r, id)
}
func (s *Server) systemReset(w http.ResponseWriter, r *http.Request) {
	var in resetInput
	if !decode(w, r, &in) {
		return
	}
	if in.Scope != "all" && in.Scope != "measurements" {
		bad(w, "无效重置范围")
		return
	}
	if e := s.validatePreview(r, in, "system_reset", "", in.Scope); e != nil {
		bad(w, e.Error())
		return
	}
	var id string
	var e error
	if in.Scope == "all" {
		id, e = s.Store.FullReset(r.Context(), in.Token)
		if e == nil {
			s.CleanupDocuments(r.Context())
		}
	} else {
		id, e = s.Store.StartOperation(r.Context(), "system_reset", "", "", in.Scope, in.Token)
	}
	if e != nil {
		bad(w, e.Error())
		return
	}
	s.operationResponse(w, r, id)
}
