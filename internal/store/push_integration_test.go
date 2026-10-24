package store

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPushEnqueueIntegration(t *testing.T) {
	dsn := os.Getenv("EIR_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires isolated database")
	}
	u, e := url.Parse(dsn)
	if e != nil || u.Hostname() != "127.0.0.1" || !strings.HasPrefix(u.Path, "/eir_test_") {
		t.Fatal("isolated database required")
	}
	ctx := context.Background()
	db, e := Open(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.DB.Close()
	if e = db.Migrate(ctx); e != nil {
		t.Fatal(e)
	}
	tx, e := db.DB.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	var member, device, measurement string
	for _, step := range []struct {
		sql  string
		out  *string
		args []any
	}{{"INSERT INTO members(name) VALUES('PWA fixture') RETURNING id::text", &member, nil}} {
		if e = tx.QueryRow(ctx, step.sql, step.args...).Scan(step.out); e != nil {
			t.Fatal(e)
		}
	}
	if e = tx.QueryRow(ctx, "INSERT INTO devices(name,address) VALUES('fixture',$1) RETURNING id::text", fmt.Sprint(time.Now().UnixNano())).Scan(&device); e != nil {
		t.Fatal(e)
	}
	if e = tx.QueryRow(ctx, "INSERT INTO measurements(fingerprint,device_id,user_slot,device_time,measured_at,timezone,member_id,raw_data,parser_version,raw_flags,kind) VALUES($1::text,$1::uuid,0,'',now(),'Asia/Shanghai',$2,'','test',0,'body_composition') RETURNING id::text", device, member).Scan(&measurement); e != nil {
		t.Fatal(e)
	}
	if _, e = tx.Exec(ctx, `INSERT INTO push_subscriptions(endpoint,subscription,token_hash,member_ids) VALUES($1,'{}','hash',ARRAY[$2::uuid]),($3,'{}','other','{}')`, device, member, measurement); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 2; i++ {
		if e = enqueuePush(ctx, tx, measurement); e != nil {
			t.Fatal(e)
		}
	}
	var count int
	var delay bool
	if e = tx.QueryRow(ctx, "SELECT count(*),bool_and(next_attempt>=created_at+interval '10 seconds') FROM push_deliveries WHERE measurement_id=$1", measurement).Scan(&count, &delay); e != nil || count != 1 || !delay {
		t.Fatal(count, delay, e)
	}
	if _, e = tx.Exec(ctx, "DELETE FROM measurements WHERE id=$1", measurement); e != nil {
		t.Fatal(e)
	}
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM push_deliveries WHERE measurement_id=$1", measurement).Scan(&count); e != nil || count != 0 {
		t.Fatal("reset cascade", count, e)
	}
}
