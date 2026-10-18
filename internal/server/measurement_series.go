package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"eir/internal/store"
)

// Latest values are selected independently: a weight-only reading must not
// erase the last valid body-fat estimate or borrow its measurement timestamp.
func (s *Server) latestMeasurements(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	q.Del("from")
	q.Del("to")
	r = r.Clone(r.Context())
	u := *r.URL
	u.RawQuery = q.Encode()
	r.URL = &u
	where, args, err := measurementFilters(r, false)
	if err != nil {
		bad(w, err.Error())
		return
	}
	rows, err := s.Store.List(r.Context(), `WITH valid AS (
	 SELECT * FROM measurement_details WHERE `+where+` AND measured_at IS NOT NULL AND weight_valid
	), metrics AS (
	 SELECT id AS record_id,member_id,member_name,device_id,measured_at,'blood_pressure' AS metric,systolic::numeric AS value,diastolic::numeric AS value_secondary,'mmHg' AS unit FROM valid WHERE kind='blood_pressure'
	 UNION ALL SELECT id,member_id,member_name,device_id,measured_at,'pulse',pulse::numeric,NULL::numeric,'次/分' FROM valid WHERE kind='blood_pressure'
	 UNION ALL SELECT id,member_id,member_name,device_id,measured_at,'weight',weight_kg,NULL::numeric,'kg' FROM valid WHERE kind='body_composition'
	 UNION ALL SELECT id,member_id,member_name,device_id,measured_at,'body_fat',body_fat_pct,NULL::numeric,'%' FROM valid WHERE kind='body_composition' AND body_fat_status='estimated'
	) SELECT DISTINCT ON(member_id,metric) * FROM metrics ORDER BY member_id,metric,measured_at DESC,record_id DESC`, args...)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, http.StatusOK, map[string]any{"items": rows})
}

type seriesCursor struct {
	Time   time.Time `json:"time"`
	ID     string    `json:"id"`
	Before time.Time `json:"before"`
}

func decodeSeriesCursor(value string) (seriesCursor, error) {
	var cursor seriesCursor
	if len(value) > 1024 {
		return cursor, fmt.Errorf("invalid series cursor")
	}
	b, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || json.Unmarshal(b, &cursor) != nil || cursor.Time.IsZero() || cursor.Before.IsZero() || !store.UUIDPattern.MatchString(cursor.ID) {
		return cursor, fmt.Errorf("invalid series cursor")
	}
	return cursor, nil
}

func (s *Server) measurementSeries(w http.ResponseWriter, r *http.Request) {
	where, args, err := filters(r)
	if err != nil {
		bad(w, err.Error())
		return
	}
	before := time.Now().UTC()
	if value := r.URL.Query().Get("cursor"); value != "" {
		cursor, err := decodeSeriesCursor(value)
		if err != nil {
			bad(w, err.Error())
			return
		}
		before = cursor.Before
		args = append(args, cursor.Time, cursor.ID)
		where += " AND (measured_at,id)>(" + store.Placeholder(len(args)-1) + "," + store.Placeholder(len(args)) + "::uuid)"
	}
	args = append(args, before)
	where += " AND measured_at IS NOT NULL AND received_at<=" + store.Placeholder(len(args))
	// Return invalid weight points as nulls in the UI, preserving a visible gap.
	// Untimed readings remain available in the full measurement table only.
	data, err := s.Store.List(r.Context(), `SELECT id,member_id,member_name,device_id,device_name,kind,measured_at,time_valid,weight_valid,systolic,diastolic,pulse,weight_kg,body_fat_pct,body_fat_status FROM measurement_details WHERE `+where+` ORDER BY measured_at,id LIMIT 1001`, args...)
	if err != nil {
		fail(w, err)
		return
	}
	var items []json.RawMessage
	if err = json.Unmarshal(data, &items); err != nil {
		fail(w, err)
		return
	}
	var next *string
	if len(items) > 1000 {
		items = items[:1000]
		var last struct {
			ID   string    `json:"id"`
			Time time.Time `json:"measured_at"`
		}
		if err = json.Unmarshal(items[len(items)-1], &last); err != nil {
			fail(w, err)
			return
		}
		b, _ := json.Marshal(seriesCursor{Time: last.Time, ID: last.ID, Before: before})
		value := base64.RawURLEncoding.EncodeToString(b)
		next = &value
	}
	respond(w, http.StatusOK, map[string]any{"items": items, "next_cursor": next})
}
