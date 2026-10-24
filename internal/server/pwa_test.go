package server

import (
	"context"
	"crypto/elliptic"
	"eir/internal/store"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestPushEndpointBoundary(t *testing.T) {
	for _, raw := range []string{"http://web.push.apple.com/a", "https://127.0.0.1/a", "https://web.push.apple.com.evil.test/a", "https://user@web.push.apple.com/a", "https://web.push.apple.com:444/a"} {
		if validPushEndpoint(raw) {
			t.Fatal(raw)
		}
	}
	for _, raw := range []string{"https://web.push.apple.com/a", "https://fcm.googleapis.com/a", "https://updates.push.services.mozilla.com/a"} {
		if !validPushEndpoint(raw) {
			t.Fatal(raw)
		}
	}
}
func TestOfflineSnapshotIntegration(t *testing.T) {
	dsn := os.Getenv("EIR_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated database")
	}
	u, e := url.Parse(dsn)
	if e != nil || u.Hostname() != "127.0.0.1" || !strings.HasPrefix(u.Path, "/eir_test_") {
		t.Fatal("isolated database required")
	}
	ctx := context.Background()
	db, e := store.Open(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.DB.Close()
	if e = db.Migrate(ctx); e != nil {
		t.Fatal(e)
	}
	id := ID()
	_, e = db.DB.Exec(ctx, "INSERT INTO members(id,name,notes) VALUES($1,'Synthetic PWA','private notes')", id)
	if e != nil {
		t.Fatal(e)
	}
	defer db.DB.Exec(ctx, "DELETE FROM members WHERE id=$1", id)
	_, e = db.DB.Exec(ctx, `INSERT INTO manual_observations(member_id,kind,value,unit,measured_at,notes) VALUES($1,'waist',81,'cm',now()-interval '1 day','private'),($1,'waist',82,'cm',now()-interval '91 days','private')`, id)
	if e != nil {
		t.Fatal(e)
	}
	w := httptest.NewRecorder()
	New(db, "http://localhost", t.TempDir(), t.TempDir()).Handler().ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/offline/snapshot", nil))
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "private") {
		t.Fatal("private fields leaked")
	}
	var result struct {
		Observations []struct {
			Member string `json:"member_id"`
		}
	}
	if e = json.Unmarshal(w.Body.Bytes(), &result); e != nil {
		t.Fatal(e)
	}
	count := 0
	for _, r := range result.Observations {
		if r.Member == id {
			count++
		}
	}
	if count != 1 {
		t.Fatal(count)
	}
}

func TestPushQueueIntegration(t *testing.T) {
	dsn := os.Getenv("EIR_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated database")
	}
	u, e := url.Parse(dsn)
	if e != nil || u.Hostname() != "127.0.0.1" || !strings.HasPrefix(u.Path, "/eir_test_") {
		t.Fatal("isolated database required")
	}
	ctx := context.Background()
	db, e := store.Open(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.DB.Close()
	if e = db.Migrate(ctx); e != nil {
		t.Fatal(e)
	}
	member, device, measurement, subscription, delivery := ID(), ID(), ID(), ID(), ID()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, e := db.DB.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	exec("INSERT INTO members(id,name) VALUES($1,'Synthetic Push')", member)
	exec("INSERT INTO devices(id,name,address) VALUES($1::uuid,'Synthetic Device',$1::text)", device)
	exec("INSERT INTO measurements(id,fingerprint,device_id,user_slot,device_time,measured_at,timezone,member_id,raw_data,parser_version,raw_flags) VALUES($1::uuid,$1::text,$2,1,'',now(),'Asia/Shanghai',$3,'','test',0)", measurement, device, member)
	exec("INSERT INTO blood_pressure VALUES($1,120,80,70)", measurement)
	exec(`INSERT INTO push_subscriptions(id,endpoint,subscription,token_hash,member_ids) VALUES($1::uuid,$1::text,'{}','hash',ARRAY[$2::uuid])`, subscription, member)
	defer func() {
		exec("DELETE FROM push_subscriptions WHERE id=$1", subscription)
		exec("DELETE FROM blood_pressure WHERE measurement_id=$1", measurement)
		exec("DELETE FROM measurements WHERE id=$1", measurement)
		exec("DELETE FROM devices WHERE id=$1", device)
		exec("DELETE FROM members WHERE id=$1", member)
	}()
	exec("INSERT INTO push_deliveries(id,subscription_id,measurement_id,member_id) VALUES($1,$2,$3,$4)", delivery, subscription, measurement, member)
	app := New(db, "http://localhost", t.TempDir(), t.TempDir())
	calls := 0
	app.pushSender = func(ctx context.Context, raw json.RawMessage, payload any) (int, error) { calls++; return 503, nil }
	app.pushNext(ctx)
	var status string
	var attempts int
	if e = db.DB.QueryRow(ctx, "SELECT status,attempts FROM push_deliveries WHERE id=$1", delivery).Scan(&status, &attempts); e != nil || status != "pending" || attempts != 1 {
		t.Fatal(status, attempts, e)
	}
	app.pushNext(ctx)
	if calls != 1 {
		t.Fatal("backoff ignored")
	}
	exec("UPDATE push_deliveries SET next_attempt=now() WHERE id=$1", delivery)
	app.pushSender = func(ctx context.Context, raw json.RawMessage, payload any) (int, error) {
		calls++
		p := payload.(map[string]any)
		if !strings.Contains(p["body"].(string), "120/80") {
			t.Fatal(p)
		}
		return 201, nil
	}
	app.pushNext(ctx)
	app.pushNext(ctx)
	if calls != 2 {
		t.Fatal("duplicate delivery", calls)
	}
	exec("UPDATE push_deliveries SET status='pending',next_attempt=now() WHERE id=$1", delivery)
	exec("UPDATE push_subscriptions SET member_ids='{}' WHERE id=$1", subscription)
	app.pushNext(ctx)
	if calls != 2 {
		t.Fatal("unfollowed member delivered")
	}
	exec("UPDATE push_deliveries SET status='pending',next_attempt=now(),created_at=now()-interval '25 hours' WHERE id=$1", delivery)
	exec("UPDATE push_subscriptions SET member_ids=ARRAY[$2::uuid] WHERE id=$1", subscription, member)
	app.pushNext(ctx)
	if calls != 2 {
		t.Fatal("expired delivery sent")
	}
	exec("UPDATE push_deliveries SET status='pending',next_attempt=now(),created_at=now() WHERE id=$1", delivery)
	app.pushSender = func(context.Context, json.RawMessage, any) (int, error) { return 410, nil }
	app.pushNext(ctx)
	var remaining int
	if e = db.DB.QueryRow(ctx, "SELECT count(*) FROM push_subscriptions WHERE id=$1", subscription).Scan(&remaining); e != nil || remaining != 0 {
		t.Fatal("expired subscription retained", e)
	}
	// Exercise subscription management with synthetic cryptographically valid browser keys.
	db.PushEnabled = true
	public := elliptic.Marshal(elliptic.P256(), elliptic.P256().Params().Gx, elliptic.P256().Params().Gy)
	payload := map[string]any{"member_ids": []string{member}, "subscription": map[string]any{"endpoint": "https://web.push.apple.com/" + ID(), "keys": map[string]string{"auth": base64.RawURLEncoding.EncodeToString(make([]byte, 16)), "p256dh": base64.RawURLEncoding.EncodeToString(public)}}}
	encoded, _ := json.Marshal(payload)
	w := httptest.NewRecorder()
	handler := app.Handler()
	handler.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/push/subscriptions", strings.NewReader(string(encoded))))
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var handle map[string]string
	json.Unmarshal(w.Body.Bytes(), &handle)
	request := func(method, token string, body string, status int) {
		t.Helper()
		r := httptest.NewRequest(method, "/api/v1/push/subscriptions/"+handle["id"], strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		handler.ServeHTTP(out, r)
		if out.Code != status {
			t.Fatal(method, out.Code, out.Body.String())
		}
	}
	request("GET", strings.Repeat("0", 64), "", 404)
	request("GET", handle["token"], "", 200)
	request("PATCH", handle["token"], `{"member_ids":[]}`, 400)
	request("DELETE", handle["token"], "", 204)
	request("GET", handle["token"], "", 404)

}
