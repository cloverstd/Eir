package server

import (
	"eir/internal/store"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func filters(r *http.Request) (string, []any, error) {
	return measurementFilters(r, true)
}

func measurementFilters(r *http.Request, defaultKind bool) (string, []any, error) {
	q := r.URL.Query()
	clauses := []string{"true"}
	if q.Get("kind") == "" && defaultKind {
		clauses = append(clauses, "kind='blood_pressure'")
	} else if q.Get("kind") != "" && q.Get("kind") != "blood_pressure" && q.Get("kind") != "body_composition" {
		return "", nil, fmt.Errorf("unsupported measurement kind")
	}
	args := []any{}
	if id := q.Get("measurement_id"); id != "" {
		if !store.UUIDPattern.MatchString(id) {
			return "", nil, fmt.Errorf("invalid measurement ID")
		}
		args = append(args, id)
		clauses = append(clauses, "id="+store.Placeholder(len(args)))
	}
	for _, key := range []string{"member_id", "device_id", "kind"} {
		if v := q.Get(key); v != "" {
			if key != "kind" && !store.UUIDPattern.MatchString(v) {
				return "", nil, fmt.Errorf("invalid %s", key)
			}
			args = append(args, v)
			clauses = append(clauses, key+"="+store.Placeholder(len(args)))
		}
	}
	if q.Get("unassigned") == "true" {
		clauses = append(clauses, "member_id IS NULL")
	}
	for _, key := range []string{"from", "to"} {
		if v := q.Get(key); v != "" {
			t, e := time.Parse(time.RFC3339, v)
			if e != nil {
				return "", nil, fmt.Errorf("invalid %s time", key)
			}
			args = append(args, t)
			op := ">="
			if key == "to" {
				op = "<"
			}
			clauses = append(clauses, "measured_at"+op+store.Placeholder(len(args)))
		}
	}
	if q.Get("from") != "" && q.Get("to") != "" {
		a, _ := time.Parse(time.RFC3339, q.Get("from"))
		b, _ := time.Parse(time.RFC3339, q.Get("to"))
		if !b.After(a) {
			return "", nil, fmt.Errorf("结束时间必须晚于开始时间")
		}
	}
	return strings.Join(clauses, " AND "), args, nil
}
func (s *Server) measurements(w http.ResponseWriter, r *http.Request) {
	where, args, e := filters(r)
	if e != nil {
		bad(w, e.Error())
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 {
		page = 1
	}
	size, _ := strconv.Atoi(r.URL.Query().Get("page_size"))
	if size < 1 {
		size = 50
	}
	if size > 200 {
		size = 200
	}
	if page > 1000000 {
		bad(w, "页码超出范围")
		return
	}
	var count int64
	if e = s.Store.DB.QueryRow(r.Context(), "SELECT count(*) FROM measurement_details WHERE "+where, args...).Scan(&count); e != nil {
		fail(w, e)
		return
	}
	args = append(args, size, (page-1)*size)
	data, e := s.Store.List(r.Context(), "SELECT * FROM measurement_details WHERE "+where+" ORDER BY measured_at DESC NULLS LAST,received_at DESC,id DESC LIMIT "+store.Placeholder(len(args)-1)+" OFFSET "+store.Placeholder(len(args)), args...)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, map[string]any{"items": data, "total": count, "page": page, "page_size": size})
}
func (s *Server) statistics(w http.ResponseWriter, r *http.Request) {
	where, args, e := filters(r)
	if e != nil {
		bad(w, e.Error())
		return
	}
	group := r.URL.Query().Get("group")
	if group == "" {
		group = "day"
	}
	if group != "day" && group != "week" && group != "month" {
		bad(w, "无效汇总粒度")
		return
	}
	// Keep invalid times and pre-fix unlocked AFU readings for inspection,
	// while excluding them from health trends and summary statistics.
	where += " AND measured_at IS NOT NULL AND weight_valid"
	summary, e := s.Store.One(r.Context(), "SELECT count(*) AS count,round(avg(systolic),1) AS mean_systolic,round(avg(diastolic),1) AS mean_diastolic,round(avg(pulse),1) AS mean_pulse,round(avg(weight_kg),2) AS mean_weight_kg,round(avg(body_fat_pct) FILTER(WHERE body_fat_status='estimated'),2) AS mean_body_fat_pct,count(*) FILTER(WHERE body_fat_status='estimated') AS body_fat_count FROM measurement_details WHERE "+where, args...)
	if e != nil {
		fail(w, e)
		return
	}
	buckets, e := s.Store.List(r.Context(), "SELECT date_trunc('"+group+"',measured_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS time,count(*) AS count,round(avg(systolic),1) AS systolic,round(avg(diastolic),1) AS diastolic,round(avg(pulse),1) AS pulse,round(avg(weight_kg),2) AS weight_kg,round(avg(body_fat_pct) FILTER(WHERE body_fat_status='estimated'),2) AS body_fat_pct FROM measurement_details WHERE "+where+" GROUP BY 1 ORDER BY 1", args...)
	if e != nil {
		fail(w, e)
		return
	}
	var result map[string]any
	json.Unmarshal(summary, &result)
	result["buckets"] = buckets
	respond(w, 200, result)
}
func (s *Server) correction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !store.UUIDPattern.MatchString(id) {
		bad(w, "无效记录 ID")
		return
	}
	var fields map[string]json.RawMessage
	if !decode(w, r, &fields) {
		return
	}
	_, hasMember := fields["member_id"]
	_, hasNotes := fields["notes"]
	if !hasMember && !hasNotes {
		bad(w, "请指定归属或备注")
		return
	}
	for key := range fields {
		if key != "member_id" && key != "notes" {
			bad(w, "原始测量字段不可修改")
			return
		}
	}
	var member *string
	notes := ""
	if hasMember {
		if json.Unmarshal(fields["member_id"], &member) != nil || (member != nil && !store.UUIDPattern.MatchString(*member)) {
			bad(w, "无效成员 ID")
			return
		}
	}
	if hasNotes {
		if json.Unmarshal(fields["notes"], &notes) != nil || len(notes) > 4000 {
			bad(w, "无效备注")
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
	var before []byte
	e = tx.QueryRow(ctx, "SELECT to_jsonb(d) FROM measurements m JOIN measurement_details d ON d.id=m.id WHERE m.id=$1 FOR UPDATE OF m", id).Scan(&before)
	if e != nil {
		fail(w, e)
		return
	}
	_, e = tx.Exec(ctx, "UPDATE measurements SET member_id=CASE WHEN $2 THEN $3::uuid ELSE member_id END,manual_assignment=manual_assignment OR $2,notes=CASE WHEN $4 THEN $5 ELSE notes END WHERE id=$1", id, hasMember, member, hasNotes, notes)
	if e != nil {
		fail(w, e)
		return
	}
	if hasMember {
		if e = store.RecalculateBody(ctx, tx, id); e != nil {
			fail(w, e)
			return
		}
	}
	_, e = tx.Exec(ctx, "INSERT INTO measurement_audit(measurement_id,previous,current) SELECT id,$2,to_jsonb(d) FROM measurement_details d WHERE id=$1", id, before)
	if e != nil {
		fail(w, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM measurement_details WHERE id=$1", id)
}
func safeCell(s string) string {
	if len(s) > 0 && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}
func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	where, args, e := filters(r)
	if e != nil {
		bad(w, e.Error())
		return
	}
	if r.URL.Query().Get("kind") == "body_composition" {
		s.exportBody(w, r, where, args)
		return
	}
	rows, e := s.Store.DB.Query(r.Context(), "SELECT coalesce(member_name,''),device_name,user_slot,device_time,systolic,diastolic,pulse,notes FROM measurement_details WHERE "+where+" ORDER BY measured_at DESC NULLS LAST", args...)
	if e != nil {
		fail(w, e)
		return
	}
	defer rows.Close()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="eir-measurements.csv"`)
	fmt.Fprint(w, "\ufeff")
	c := csv.NewWriter(w)
	c.Write([]string{"成员", "设备", "用户档位", "设备测量时间", "收缩压(mmHg)", "舒张压(mmHg)", "脉搏(次/分)", "备注"})
	for rows.Next() {
		var member, device, dt, notes string
		var slot, sys, dia, pulse int
		if rows.Scan(&member, &device, &slot, &dt, &sys, &dia, &pulse, &notes) != nil {
			return
		}
		if c.Write([]string{safeCell(member), safeCell(device), strconv.Itoa(slot), dt, strconv.Itoa(sys), strconv.Itoa(dia), strconv.Itoa(pulse), safeCell(notes)}) != nil {
			return
		}
	}
	c.Flush()
}
