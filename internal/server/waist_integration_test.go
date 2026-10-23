package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"eir/internal/store"
)

func TestWaistObservationsIntegration(t *testing.T) {
	dsn := os.Getenv("EIR_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated frontend integration database")
	}
	u, err := url.Parse(dsn)
	if err != nil || u.Hostname() != "127.0.0.1" || !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "eir_test_") {
		t.Fatal("waist integration requires a loopback eir_test_* database")
	}
	ctx := context.Background()
	db, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	if err := db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	member, other := ID(), ID()
	if _, err := db.DB.Exec(ctx, "INSERT INTO members(id,name) VALUES($1,'Synthetic waist A'),($2,'Synthetic waist B')", member, other); err != nil {
		t.Fatal(err)
	}
	defer db.DB.Exec(ctx, "DELETE FROM members WHERE id IN($1,$2)", member, other)
	handler := New(db, "http://localhost", t.TempDir(), t.TempDir()).Handler()
	request := func(method, path string, body any, status int) map[string]any {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(method, "/api/v1/"+path, strings.NewReader(string(data)))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
		}
		var result map[string]any
		if w.Body.Len() > 0 && json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatalf("invalid JSON: %s", w.Body.String())
		}
		return result
	}
	input := func(value float64, at string) map[string]any {
		return map[string]any{"kind": "waist", "unit": "cm", "value": value, "measured_at": at, "notes": "Synthetic backfill"}
	}
	path := "members/" + member + "/observations"
	first := request(http.MethodPost, path, input(80.25, "2026-01-02T00:15:00+08:00"), 200)
	second := request(http.MethodPost, path, input(81.5, "2026-01-02T01:15:00+08:00"), 200)
	request(http.MethodPost, "members/"+other+"/observations", input(92.5, "2026-01-03T00:00:00Z"), 200)
	query := "health/observations?member_id=" + member + "&kind=waist"
	latest := func() map[string]any {
		return request(http.MethodGet, query+"&page_size=1", nil, 200)["items"].([]any)[0].(map[string]any)
	}
	if row := latest(); row["source_record_id"] != second["id"] || row["value"] != 81.5 || row["unit"] != "cm" || row["source"] != "manual" {
		t.Fatal(row)
	}
	page := request(http.MethodGet, query+"&from=2026-01-01T16:00:00Z&to=2026-01-01T17:00:00Z", nil, 200)
	if page["total"] != float64(1) || page["items"].([]any)[0].(map[string]any)["source_record_id"] != first["id"] {
		t.Fatalf("Shanghai range or same-day points: %v", page)
	}
	for _, value := range []float64{0, 9.9, 400.1} {
		request(http.MethodPost, path, input(value, "2026-01-01T00:00:00Z"), 400)
	}
	wrongUnit := input(80, "2026-01-01T00:00:00Z")
	wrongUnit["unit"] = "in"
	request(http.MethodPost, path, wrongUnit, 400)
	missing := input(80, "2026-01-01T00:00:00Z")
	delete(missing, "value")
	request(http.MethodPost, path, missing, 400)
	request(http.MethodPost, path, input(80, "bad-time"), 400)
	edit := input(81.75, "2026-01-02T01:15:00+08:00")
	request(http.MethodPut, "members/"+other+"/observations/"+second["id"].(string), edit, 404)
	request(http.MethodDelete, "members/"+other+"/observations/"+second["id"].(string), nil, 404)
	request(http.MethodPut, path+"/"+second["id"].(string), edit, 200)
	if row := latest(); row["value"] != 81.75 {
		t.Fatal(row)
	}
	request(http.MethodDelete, path+"/"+second["id"].(string), nil, 204)
	if row := latest(); row["source_record_id"] != first["id"] || row["value"] != 80.25 {
		t.Fatal(row)
	}
	// More than a full page of older observations must not replace the latest.
	if _, err := db.DB.Exec(ctx, `INSERT INTO manual_observations(member_id,kind,value,unit,measured_at)
	 SELECT $1,'waist',80+n/100.0,'cm','2025-01-01T00:00:00Z'::timestamptz+n*interval '1 minute'
	 FROM generate_series(1,205)n`, member); err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for pageNumber := 1; pageNumber <= 2; pageNumber++ {
		page := request(http.MethodGet, fmt.Sprintf("%s&page_size=200&page=%d", query, pageNumber), nil, 200)
		if page["total"] != float64(206) {
			t.Fatal(page["total"])
		}
		for _, item := range page["items"].([]any) {
			row := item.(map[string]any)
			id := row["id"].(string)
			if ids[id] || row["member_id"] != member || row["unit"] != "cm" {
				t.Fatalf("duplicate or mixed-member observation: %v", row)
			}
			ids[id] = true
		}
	}
	if len(ids) != 206 || latest()["source_record_id"] != first["id"] {
		t.Fatalf("paging/latest: %d points", len(ids))
	}
}
