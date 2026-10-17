package server

import (
	"eir/internal/afu"
	"eir/internal/omron"
	"eir/internal/store"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

func (s *Server) collector(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name     string `json:"name"`
		Location string `json:"location"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Name) > 100 || len(in.Location) > 200 {
		bad(w, "名称或位置过长")
		return
	}
	t, e := s.Store.DB.Exec(r.Context(), "UPDATE collectors SET name=$1,location=$2 WHERE id=$3", in.Name, in.Location, r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	if t.RowsAffected() == 0 {
		http.NotFound(w, r)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM collectors WHERE id=$1", r.PathValue("id"))
}
func (s *Server) device(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name        string `json:"name"`
		CollectorID string `json:"collector_id"`
		Address     string `json:"address"`
		AddressType int    `json:"address_type"`
		Model       string `json:"model"`
		Profile     string `json:"profile"`
		Timezone    string `json:"timezone"`
		HardwareID  string `json:"hardware_id"`
		ADCIndex    int    `json:"adc_index"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Model == "" {
		if in.Profile == afu.Profile {
			in.Model = "AFU-WL-TZ-A1"
		} else {
			in.Model = "HEM-7374T1"
		}
	}
	if in.Profile == "" {
		in.Profile = omron.Profile
	}
	if in.Timezone == "" {
		in.Timezone = "Asia/Shanghai"
	}
	parts := strings.Split(in.Address, ":")
	validAddress := len(parts) == 6
	for _, p := range parts {
		if len(p) != 2 {
			validAddress = false
		}
		for _, c := range strings.ToLower(p) {
			if !strings.ContainsRune("0123456789abcdef", c) {
				validAddress = false
			}
		}
	}
	if strings.TrimSpace(in.Name) == "" || len(in.Name) > 100 || !validAddress || !((in.Model == "HEM-7374T1" && in.Profile == omron.Profile) || (in.Model == "AFU-WL-TZ-A1" && in.Profile == afu.Profile)) || (in.ADCIndex != 0 && in.ADCIndex != 1) || (in.AddressType != 0 && in.AddressType != 1) {
		bad(w, "请指定名称、BLE MAC 地址、地址类型和受支持型号")
		return
	}
	if _, e := time.LoadLocation(in.Timezone); e != nil {
		bad(w, "无效时区")
		return
	}
	if in.CollectorID != "" {
		var capable bool
		e := s.Store.DB.QueryRow(r.Context(), "SELECT protocol_version>=2 AND lifecycle_state='bound' FROM collectors WHERE id=$1", in.CollectorID).Scan(&capable)
		if e != nil || !capable {
			bad(w, "请先升级并绑定采集端管理固件")
			return
		}
	}
	if (in.Profile == afu.Profile && !macPattern.MatchString(in.HardwareID)) || (in.Profile != afu.Profile && in.HardwareID != "") {
		bad(w, "无效体脂秤设备身份")
		return
	}
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if in.CollectorID != "" && in.Profile == afu.Profile {
		if e = store.CheckScaleCapacity(ctx, tx, in.CollectorID, ""); e != nil {
			bad(w, e.Error())
			return
		}
	}
	id := ID()
	if _, e = tx.Exec(ctx, "INSERT INTO devices(id,name,collector_id,address,address_type,model,profile,timezone,lifecycle_state,hardware_id,adc_index) VALUES($1,$2,nullif($3,''),$4,$5,$6,$7,$8,'unbound',$9,$10)", id, in.Name, in.CollectorID, strings.ToUpper(in.Address), in.AddressType, in.Model, in.Profile, in.Timezone, strings.ToUpper(in.HardwareID), in.ADCIndex); e != nil {
		fail(w, e)
		return
	}
	if _, e = tx.Exec(ctx, "UPDATE collectors SET config_version=config_version+1 WHERE id=$1", in.CollectorID); e != nil {
		fail(w, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		fail(w, e)
		return
	}
	if in.CollectorID != "" {
		op, err := s.Store.StartOperation(ctx, "device_bind", in.CollectorID, id, "", "")
		if err != nil {
			bad(w, err.Error())
			return
		}
		_ = op
	}
	if s.Bus != nil {
		s.Bus.PublishConfig(ctx, in.CollectorID)
	}
	s.Changed()
	s.one(w, r, "SELECT d.*,(SELECT id FROM operations WHERE device_id=d.id AND type='device_bind' ORDER BY created_at DESC LIMIT 1) AS operation_id FROM devices d WHERE id=$1", id)
}
func (s *Server) binding(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DeviceID      string `json:"device_id"`
		UserSlot      int    `json:"user_slot"`
		MemberID      string `json:"member_id"`
		EffectiveFrom string `json:"effective_from"`
		ClaimHistory  *bool  `json:"claim_history"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !store.UUIDPattern.MatchString(in.DeviceID) || !store.UUIDPattern.MatchString(in.MemberID) || (in.UserSlot < 0 || in.UserSlot > 2) {
		bad(w, "无效设备、成员或用户档位")
		return
	}
	var profile string
	if e := s.Store.DB.QueryRow(r.Context(), "SELECT profile FROM devices WHERE id=$1", in.DeviceID).Scan(&profile); e != nil {
		fail(w, e)
		return
	}
	if (profile == afu.Profile && in.UserSlot != 0) || (profile != afu.Profile && in.UserSlot == 0) {
		bad(w, "体脂秤绑定整台设备，血压计选择用户 1 或 2")
		return
	}
	now := time.Now()
	from := now
	if in.EffectiveFrom != "" {
		var e error
		from, e = time.Parse(time.RFC3339, in.EffectiveFrom)
		if e != nil || from.After(now) {
			bad(w, "生效时间必须为有效时间且不能晚于现在")
			return
		}
	}
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", fmt.Sprintf("binding/%s/%d", strings.ToLower(in.DeviceID), in.UserSlot)); e != nil {
		fail(w, e)
		return
	}
	var count int
	var latest *time.Time
	e = tx.QueryRow(ctx, "SELECT count(*),max(effective_from) FROM bindings WHERE device_id=$1 AND user_slot=$2", in.DeviceID, in.UserSlot).Scan(&count, &latest)
	if e != nil {
		fail(w, e)
		return
	}
	if count == 0 && in.EffectiveFrom == "" && (in.ClaimHistory == nil || *in.ClaimHistory) {
		from = time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	if latest != nil && !from.After(*latest) {
		bad(w, "换绑时间必须晚于上一段绑定的起点")
		return
	}
	if _, e = tx.Exec(ctx, "UPDATE bindings SET effective_to=$3 WHERE device_id=$1 AND user_slot=$2 AND effective_to IS NULL", in.DeviceID, in.UserSlot, from); e != nil {
		fail(w, e)
		return
	}
	id := ID()
	if _, e = tx.Exec(ctx, "INSERT INTO bindings(id,device_id,user_slot,member_id,effective_from) VALUES($1,$2,$3,$4,$5)", id, in.DeviceID, in.UserSlot, in.MemberID, from); e != nil {
		fail(w, e)
		return
	}
	if _, e = tx.Exec(ctx, `WITH changed AS (SELECT id,to_jsonb(m) AS previous FROM measurements m WHERE device_id=$1 AND user_slot=$2 AND measured_at>=$3 AND NOT manual_assignment AND member_id IS DISTINCT FROM $4::uuid), upd AS (UPDATE measurements m SET member_id=$4 FROM changed c WHERE m.id=c.id RETURNING m.id,to_jsonb(m) AS current,c.previous) INSERT INTO measurement_audit(measurement_id,previous,current) SELECT id,previous,current FROM upd`, in.DeviceID, in.UserSlot, from, in.MemberID); e != nil {
		fail(w, e)
		return
	}
	if e = store.RecalculateDeviceBody(ctx, tx, in.DeviceID, from); e != nil {
		fail(w, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM bindings WHERE id=$1", id)
}
func (s *Server) command(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Type     string `json:"type"`
		DeviceID string `json:"device_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	switch in.Type {
	case "scan", "pair", "read", "backfill":
	default:
		bad(w, "不支持的指令")
		return
	}
	collector := r.PathValue("id")
	if in.Type == "pair" {
		op, e := s.Store.StartOperation(r.Context(), "device_bind", collector, in.DeviceID, "", "")
		if e != nil {
			bad(w, e.Error())
			return
		}
		s.operationResponse(w, r, op)
		return
	}
	var online bool
	e := s.Store.DB.QueryRow(r.Context(), "SELECT coalesce(status->'online'='true'::jsonb,false) AND last_seen>now()-interval '90 seconds' FROM collectors WHERE id=$1", collector).Scan(&online)
	if e != nil {
		fail(w, e)
		return
	}
	if !online || s.Bus == nil || !s.Bus.Connected() {
		respond(w, 409, map[string]string{"error": "采集端或 MQTT 离线"})
		return
	}
	if in.Type != "scan" {
		var exists bool
		e = s.Store.DB.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM devices WHERE id::text=$1 AND collector_id=$2)", in.DeviceID, collector).Scan(&exists)
		if e != nil {
			fail(w, e)
			return
		}
		if !exists {
			bad(w, "设备未分配给此采集端")
			return
		}
		var profile string
		if e = s.Store.DB.QueryRow(r.Context(), "SELECT profile FROM devices WHERE id=$1", in.DeviceID).Scan(&profile); e != nil {
			fail(w, e)
			return
		}
		if profile == afu.Profile {
			bad(w, "体脂秤自动接收实时测量，暂不支持历史补采或诊断读取")
			return
		}
	}
	id := ID()
	expires := time.Now().Add(2 * time.Minute)
	payload := map[string]any{"id": id, "type": in.Type, "device_id": in.DeviceID, "expires_at": expires.UTC().Format(time.RFC3339)}
	if config, e := s.Store.DesiredConfig(r.Context(), collector); e == nil {
		for _, k := range []string{"instance_id", "binding_id", "data_epoch"} {
			if v, ok := config[k]; ok {
				payload[k] = v
			}
		}
	}
	data, _ := json.Marshal(payload)
	_, e = s.Store.DB.Exec(r.Context(), "INSERT INTO commands(id,collector_id,type,payload,expires_at) VALUES($1,$2,$3,$4,$5)", id, collector, in.Type, data, expires)
	if e != nil {
		fail(w, e)
		return
	}
	s.Bus.Publish(collector, "commands", payload, false)
	s.Changed()
	respond(w, 202, payload)
}
