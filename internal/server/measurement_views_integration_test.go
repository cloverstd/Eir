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
	"time"

	"eir/internal/store"
)

// This fixture is deliberately synthetic and only runs against an explicitly
// named, loopback-only disposable database. It can also seed browser QA.
func TestMeasurementViewsIntegration(t *testing.T) {
	dsn := os.Getenv("EIR_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated frontend integration database")
	}
	u, err := url.Parse(dsn)
	if err != nil || u.Hostname() != "127.0.0.1" || !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "eir_test_") {
		t.Fatal("frontend integration requires a loopback eir_test_* database")
	}
	ctx := context.Background()
	db, err := store.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	member, second, cuff, scale, secondScale := ID(), ID(), ID(), ID(), ID()
	collector := "eir-test-ui-" + ID()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.DB.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO members(id,name,sex,birth_date,birth_month,height_cm) VALUES($1,'测试甲','male','1990-01-01','1990-01',170),($2,'测试乙','female','1988-06-01','1988-06',160)`, member, second)
	exec(`INSERT INTO collectors(id,name,location,protocol_version,last_seen,status) VALUES($1,'客厅采集端','客厅',2,now(),'{"online":true,"firmware_version":"test-ui","capabilities":{"max_scales":2,"signals":true}}')`, collector)
	exec(`INSERT INTO devices(id,name,collector_id,address,profile,model) VALUES($1,'客厅血压计',$3,$4,'omron-hem-7374t1','HEM-7374T1'),($2,'家庭体脂秤',$3,$5,'afu-wl-tz-a1','AFU-WL-TZ-A1')`, cuff, scale, collector, "02:"+cuff[:2]+":00:00:00:01", "02:"+scale[:2]+":00:00:00:02")
	exec(`INSERT INTO bindings(device_id,user_slot,member_id,effective_from) VALUES($1,1,$3,'2020-01-01'),($2,0,$3,'2020-01-01')`, cuff, scale, member)
	exec(`INSERT INTO devices(id,name,collector_id,address,profile,model) VALUES($1,'卧室体脂秤',$2,$3,'afu-wl-tz-a1','AFU-WL-TZ-A1')`, secondScale, collector, "02:"+secondScale[:2]+":00:00:00:03")
	exec(`INSERT INTO bindings(device_id,user_slot,member_id,effective_from) VALUES($1,0,$2,'2020-01-01')`, secondScale, second)
	// More than one page, including repeated timestamps to test the ID tie-breaker.
	exec(`WITH inserted AS (
	 INSERT INTO measurements(fingerprint,device_id,collector_id,user_slot,kind,record_sequence,device_time,measured_at,timezone,member_id,raw_data,parser_version,raw_flags)
	 SELECT $1||':'||n,$2,$3,1,'blood_pressure',n,'synthetic',date_trunc('day',now())-interval '20 days'+(n/3)*interval '1 hour','Asia/Shanghai',$4,decode('00','hex'),'synthetic',0 FROM generate_series(1,1105)n RETURNING id,record_sequence
	) INSERT INTO blood_pressure SELECT id,110+record_sequence%25,65+record_sequence%15,60+record_sequence%30 FROM inserted`, ID(), cuff, collector, member)
	insertBody := func(who string, at any, valid bool, status string, weight, fat int) string {
		t.Helper()
		id := ID()
		source := scale
		if who == second {
			source = secondScale
		}
		raw := "ac298069117002000540000a000000000029d51b"
		if !valid {
			raw = "ac290069117002000540000a000000000029d51b"
		}
		exec(`INSERT INTO measurements(id,fingerprint,device_id,collector_id,user_slot,kind,device_time,measured_at,timezone,member_id,raw_data,parser_version,raw_flags) VALUES($1::uuid,$1::text,$2,$3,0,'body_composition','synthetic',$4,'Asia/Shanghai',$5,decode($6,'hex'),'synthetic',0)`, id, source, collector, at, who, raw)
		exec(`INSERT INTO body_composition(measurement_id,measurement_session_id,weight_grams,adc_index,body_fat_pct,body_fat_status) VALUES($1::uuid,$1::text,$2,0,$3,$4)`, id, weight*1000, fat, status)
		return id
	}
	now := time.Now().UTC().Truncate(time.Second)
	fatID := insertBody(member, now.Add(-24*time.Hour), true, "estimated", 70, 20)
	weightID := insertBody(member, now, true, "missing_adc", 71, 0)
	insertBody(member, now.Add(time.Hour), false, "estimated", 99, 40)
	insertBody(member, nil, true, "estimated", 98, 40)
	insertBody(second, now, true, "estimated", 55, 27)
	app := New(db, "http://localhost", t.TempDir(), t.TempDir())
	handler := app.Handler()
	get := func(path string) map[string]any {
		t.Helper()
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/"+path, nil))
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	t.Run("latest independent metrics ignore range and invalid readings", func(t *testing.T) {
		result := get("measurements/latest?member_id=" + member + "&from=2099-01-01T00:00:00Z")
		items := result["items"].([]any)
		if len(items) != 4 {
			t.Fatalf("metrics: %v", items)
		}
		for _, item := range items {
			row := item.(map[string]any)
			if row["member_id"] != member {
				t.Fatal("member leakage")
			}
			if row["metric"] == "weight" && (row["record_id"] != weightID || row["value"] != float64(71)) {
				t.Fatal(row)
			}
			if row["metric"] == "body_fat" && (row["record_id"] != fatID || row["value"] != float64(20)) {
				t.Fatal(row)
			}
		}
	})
	t.Run("all raw points cursor through repeated timestamps without pagination leakage", func(t *testing.T) {
		path := "measurements/series?kind=blood_pressure&member_id=" + member
		first := get(path)
		if len(first["items"].([]any)) != 1000 {
			t.Fatal("first batch size")
		}
		cursor := first["next_cursor"].(string)
		second := get(path + "&cursor=" + url.QueryEscape(cursor))
		if len(second["items"].([]any)) != 105 || second["next_cursor"] != nil {
			t.Fatal("remaining points truncated")
		}
		seen := map[string]bool{}
		for _, items := range [][]any{first["items"].([]any), second["items"].([]any)} {
			for _, item := range items {
				row := item.(map[string]any)
				id := row["id"].(string)
				if seen[id] || row["raw_hex"] != nil {
					t.Fatal("duplicate or raw payload exposed")
				}
				seen[id] = true
			}
		}
		table := get("measurements?kind=blood_pressure&member_id=" + member + "&page=2")
		if table["total"] != float64(1105) || len(table["items"].([]any)) != 50 {
			t.Fatal("table pagination regression")
		}
	})
	t.Run("body point validity missing values and kind isolation", func(t *testing.T) {
		result := get("measurements/series?kind=body_composition&member_id=" + member)
		items := result["items"].([]any)
		if len(items) != 3 {
			t.Fatal("untimed point was included or valid gap lost")
		}
		for _, item := range items {
			if item.(map[string]any)["kind"] != "body_composition" {
				t.Fatal("kind leakage")
			}
		}
		table := get("measurements?kind=body_composition&member_id=" + member)
		if table["total"] != float64(4) {
			t.Fatal("untimed readings disappeared from full history")
		}
	})
	t.Run("ADC completion updates one reading and latest body fat", func(t *testing.T) {
		exec(`UPDATE body_composition SET body_fat_status='estimated',body_fat_pct=21 WHERE measurement_id=$1`, weightID)
		result := get("measurements/latest?kind=body_composition&member_id=" + member)
		for _, item := range result["items"].([]any) {
			row := item.(map[string]any)
			if row["metric"] == "body_fat" && row["record_id"] != weightID {
				t.Fatal(row)
			}
		}
	})
	t.Run("bad filters and cursors rejected before database work", func(t *testing.T) {
		for _, path := range []string{"measurements/series?cursor=bad", "measurements/series?kind=unknown", "measurements/latest?device_id=bad"} {
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/"+path, nil))
			if w.Code != 400 {
				t.Fatalf("%s: %d", path, w.Code)
			}
		}
	})
	fmt.Println("Synthetic frontend fixture:", member, second)
}
