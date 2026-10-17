package server

import (
	"eir/internal/health"
	"eir/internal/store"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func queryHealth(r *http.Request) (store.HealthQuery, error) {
	v := r.URL.Query()
	q := store.HealthQuery{MemberID: v.Get("member_id"), Kind: v.Get("kind"), From: v.Get("from"), To: v.Get("to"), Source: v.Get("source"), Search: v.Get("search"), Group: v.Get("group")}
	if id := r.PathValue("member"); id != "" {
		q.MemberID = id
	}
	for key, dest := range map[string]*int{"page": &q.Page, "page_size": &q.PageSize} {
		if v.Get(key) != "" {
			n, e := strconv.Atoi(v.Get(key))
			if e != nil {
				return q, errors.New("无效分页")
			}
			*dest = n
		}
	}
	if q.Kind != "" {
		switch {
		case strings.Contains(r.URL.Path, "/observations") || strings.Contains(r.URL.Path, "/statistics"):
			if _, ok := health.MetricFor(q.Kind); !ok && q.Kind != "bmi" {
				return q, errors.New("无效指标类型")
			}
		case strings.Contains(r.URL.Path, "/history"):
			if !health.HistoryKinds[q.Kind] {
				return q, errors.New("无效健康经历类型")
			}
		}
	}
	return q, q.Validate()
}
func (s *Server) healthRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/health/metrics", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, health.Metrics) })
	for path, fn := range map[string]func(*http.Request, store.HealthQuery) (json.RawMessage, error){
		"GET /api/v1/health/observations": func(r *http.Request, q store.HealthQuery) (json.RawMessage, error) {
			return s.Store.Observations(r.Context(), q)
		},
		"GET /api/v1/health/statistics": func(r *http.Request, q store.HealthQuery) (json.RawMessage, error) {
			return s.Store.Statistics(r.Context(), q)
		},
		"GET /api/v1/health/history": func(r *http.Request, q store.HealthQuery) (json.RawMessage, error) {
			return s.Store.History(r.Context(), q)
		},
		"GET /api/v1/health/documents": func(r *http.Request, q store.HealthQuery) (json.RawMessage, error) {
			return s.Store.Documents(r.Context(), q)
		},
	} {
		m.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
			q, e := queryHealth(r)
			if e != nil {
				bad(w, e.Error())
				return
			}
			data, e := fn(r, q)
			if e != nil {
				fail(w, e)
				return
			}
			respond(w, 200, data)
		})
	}
	m.HandleFunc("GET /api/v1/members/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !store.UUIDPattern.MatchString(r.PathValue("id")) {
			bad(w, "无效成员 ID")
			return
		}
		v, e := s.Store.Member(r.Context(), r.PathValue("id"))
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, v)
	})
	m.HandleFunc("POST /api/v1/members/{member}/history", s.saveHistory)
	m.HandleFunc("PUT /api/v1/members/{member}/history/{id}", s.saveHistory)
	m.HandleFunc("DELETE /api/v1/members/{member}/history/{id}", s.deleteHealth)
	m.HandleFunc("POST /api/v1/members/{member}/observations", s.saveObservation)
	m.HandleFunc("PUT /api/v1/members/{member}/observations/{id}", s.saveObservation)
	m.HandleFunc("DELETE /api/v1/members/{member}/observations/{id}", s.deleteHealth)
	s.documentRoutes(m)
}
func (s *Server) member(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name       string          `json:"name"`
		Notes      string          `json:"notes"`
		Sex        *string         `json:"sex"`
		Height     json.RawMessage `json:"height_cm"`
		BirthDate  *string         `json:"birth_date"`
		BirthMonth *string         `json:"birth_month"`
		BloodType  *string         `json:"blood_type"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" || len(in.Name) > 100 || len(in.Notes) > 4000 {
		bad(w, "请填写有效姓名和备注")
		return
	}
	id := r.PathValue("id")
	creating := id == ""
	if creating {
		id = ID()
	} else if !store.UUIDPattern.MatchString(id) {
		bad(w, "无效成员 ID")
		return
	}
	tx, e := s.Store.DB.Begin(r.Context())
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(r.Context())
	if e = store.HealthWrite(r.Context(), tx); e != nil {
		fail(w, e)
		return
	}
	var sex, bd, bm, bt string
	var height *float64
	if !creating {
		e = tx.QueryRow(r.Context(), "SELECT sex,coalesce(birth_date::text,''),birth_month,blood_type,height_cm::float8 FROM members WHERE id=$1 FOR UPDATE", id).Scan(&sex, &bd, &bm, &bt, &height)
		if e != nil {
			fail(w, e)
			return
		}
	}
	if in.Sex != nil {
		sex = *in.Sex
	}
	if sex != "" && sex != "male" && sex != "female" {
		bad(w, "无效计算用性别")
		return
	}
	if len(in.Height) > 0 {
		height = nil
		if string(in.Height) != "null" {
			var h float64
			if json.Unmarshal(in.Height, &h) != nil || math.IsNaN(h) || math.IsInf(h, 0) || h < 50 || h > 250 {
				bad(w, "身高应在 50 至 250 厘米之间")
				return
			}
			height = &h
		}
	}
	if in.BirthMonth != nil {
		bm = *in.BirthMonth
		if bd != "" && (bm == "" || !strings.HasPrefix(bd, bm)) {
			bd = ""
		}
	}
	if in.BirthDate != nil {
		bd = *in.BirthDate
		if bd != "" && in.BirthMonth == nil && len(bd) >= 7 {
			bm = bd[:7]
		}
	}
	if e = health.ValidateBirth(bd, bm, time.Now()); e != nil {
		bad(w, e.Error())
		return
	}
	if in.BloodType != nil {
		bt = *in.BloodType
	}
	if !map[string]bool{"": true, "A+": true, "A-": true, "B+": true, "B-": true, "AB+": true, "AB-": true, "O+": true, "O-": true}[bt] {
		bad(w, "无效血型")
		return
	}
	if creating {
		_, e = tx.Exec(r.Context(), "INSERT INTO members(id,name,notes,sex,height_cm,birth_date,birth_month,blood_type) VALUES($1,$2,$3,$4,$5,nullif($6,'')::date,$7,$8)", id, in.Name, in.Notes, sex, height, bd, bm, bt)
	} else {
		_, e = tx.Exec(r.Context(), "UPDATE members SET name=$2,notes=$3,sex=$4,height_cm=$5,birth_date=nullif($6,'')::date,birth_month=$7,blood_type=$8 WHERE id=$1", id, in.Name, in.Notes, sex, height, bd, bm, bt)
	}
	if e == nil {
		e = store.HealthChanged(r.Context(), tx)
	}
	if e == nil {
		e = tx.Commit(r.Context())
	}
	if e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM members WHERE id=$1", id)
}
func healthIDs(w http.ResponseWriter, r *http.Request) (string, string, bool) {
	member, id := r.PathValue("member"), r.PathValue("id")
	if !store.UUIDPattern.MatchString(member) || (id != "" && !store.UUIDPattern.MatchString(id)) {
		bad(w, "无效记录 ID")
		return "", "", false
	}
	return member, id, true
}
func (s *Server) saveHistory(w http.ResponseWriter, r *http.Request) {
	member, id, ok := healthIDs(w, r)
	if !ok {
		return
	}
	var in struct {
		Kind       string            `json:"kind"`
		Title      string            `json:"title"`
		OccurredOn string            `json:"occurred_on"`
		Status     string            `json:"status"`
		Details    map[string]string `json:"details"`
		Notes      string            `json:"notes"`
	}
	if !decode(w, r, &in) {
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Status == "" {
		in.Status = "unknown"
	}
	if in.Details == nil {
		in.Details = map[string]string{}
	}
	if !health.HistoryKinds[in.Kind] || len(in.Title) == 0 || len(in.Title) > 200 || len(in.Notes) > 4000 || !health.ValidDate(in.OccurredOn) || !map[string]bool{"unknown": true, "active": true, "resolved": true}[in.Status] || !store.ValidHistoryDetails(in.Details) {
		bad(w, "健康经历字段无效")
		return
	}
	data, _ := json.Marshal(in.Details)
	creating := id == ""
	if creating {
		id = ID()
	}
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if e = store.HealthWrite(ctx, tx); e == nil {
		if creating {
			_, e = tx.Exec(ctx, "INSERT INTO health_history(id,member_id,kind,title,occurred_on,status,details,notes) VALUES($1,$2,$3,$4,nullif($5,'')::date,$6,$7,$8)", id, member, in.Kind, in.Title, in.OccurredOn, in.Status, data, in.Notes)
		} else {
			var n int64
			tag, err := tx.Exec(ctx, "UPDATE health_history SET kind=$3,title=$4,occurred_on=nullif($5,'')::date,status=$6,details=$7,notes=$8,updated_at=now() WHERE id=$1 AND member_id=$2", id, member, in.Kind, in.Title, in.OccurredOn, in.Status, data, in.Notes)
			e = err
			n = tag.RowsAffected()
			if e == nil && n == 0 {
				respond(w, 404, map[string]string{"error": "未找到记录"})
				return
			}
		}
	}
	if e == nil {
		e = store.HealthChanged(ctx, tx)
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM health_history WHERE id=$1", id)
}
func (s *Server) saveObservation(w http.ResponseWriter, r *http.Request) {
	member, id, ok := healthIDs(w, r)
	if !ok {
		return
	}
	var in struct {
		Kind       string   `json:"kind"`
		Value      *float64 `json:"value"`
		Secondary  *float64 `json:"value_secondary"`
		MeasuredAt string   `json:"measured_at"`
		Notes      string   `json:"notes"`
		Unit       *string  `json:"unit"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Value == nil {
		bad(w, "请填写指标数值")
		return
	}
	if e := health.ValidateMetric(in.Kind, *in.Value, in.Secondary); e != nil {
		bad(w, e.Error())
		return
	}
	at, e := time.Parse(time.RFC3339, in.MeasuredAt)
	if e != nil || at.Year() < 1900 || at.After(time.Now().Add(5*time.Minute)) || len(in.Notes) > 4000 {
		bad(w, "无效测量时间或备注")
		return
	}
	metric, _ := health.MetricFor(in.Kind)
	if in.Unit != nil && *in.Unit != metric.Unit {
		bad(w, "请使用指标指定的规范单位")
		return
	}
	creating := id == ""
	if creating {
		id = ID()
	}
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if e = store.HealthWrite(ctx, tx); e == nil {
		var height *float64
		if in.Kind == "weight" {
			if !creating {
				_ = tx.QueryRow(ctx, "SELECT height_snapshot::float8 FROM manual_observations WHERE id=$1 AND member_id=$2 AND kind='weight'", id, member).Scan(&height)
			}
			if height == nil {
				e = tx.QueryRow(ctx, "SELECT coalesce((SELECT value FROM manual_observations WHERE member_id=$1 AND kind='height' AND measured_at<=$2 ORDER BY measured_at DESC,id DESC LIMIT 1),height_cm)::float8 FROM members WHERE id=$1", member, at).Scan(&height)
				if e != nil {
					fail(w, e)
					return
				}
			}
		}
		if creating {
			_, e = tx.Exec(ctx, "INSERT INTO manual_observations(id,member_id,kind,value,value_secondary,unit,measured_at,notes,height_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", id, member, in.Kind, in.Value, in.Secondary, metric.Unit, at, in.Notes, height)
		} else {
			tag, err := tx.Exec(ctx, "UPDATE manual_observations SET kind=$3,value=$4,value_secondary=$5,unit=$6,measured_at=$7,notes=$8,height_snapshot=$9,updated_at=now() WHERE id=$1 AND member_id=$2", id, member, in.Kind, in.Value, in.Secondary, metric.Unit, at, in.Notes, height)
			e = err
			if e == nil && tag.RowsAffected() == 0 {
				respond(w, 404, map[string]string{"error": "未找到记录"})
				return
			}
		}
	}
	if e == nil {
		e = store.HealthChanged(ctx, tx)
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM manual_observations WHERE id=$1", id)
}
func (s *Server) deleteHealth(w http.ResponseWriter, r *http.Request) {
	member, id, ok := healthIDs(w, r)
	if !ok {
		return
	}
	table := "manual_observations"
	if strings.Contains(r.URL.Path, "/history/") {
		table = "health_history"
	}
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if e = store.HealthWrite(ctx, tx); e != nil {
		fail(w, e)
		return
	}
	tag, e := tx.Exec(ctx, "DELETE FROM "+table+" WHERE id=$1 AND member_id=$2", id, member)
	if e != nil {
		fail(w, e)
		return
	}
	if tag.RowsAffected() == 0 {
		respond(w, 404, map[string]string{"error": "未找到记录"})
		return
	}
	if e = store.HealthChanged(ctx, tx); e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	w.WriteHeader(204)
}
