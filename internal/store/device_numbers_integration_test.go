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

func TestScaleNumberingMigrationIntegration(t *testing.T) {
	dsn := os.Getenv("EIR_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable frontend database")
	}
	u, err := url.Parse(dsn)
	if err != nil || u.Hostname() != "127.0.0.1" || !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "eir_test_") {
		t.Fatal("requires loopback eir_test_* database")
	}
	ctx := context.Background()
	admin, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.DB.Close()
	name := fmt.Sprintf("eir_scale_numbers_%d", time.Now().UnixNano())
	if _, err = admin.DB.Exec(ctx, "CREATE SCHEMA "+name); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, e := admin.DB.Exec(ctx, "DROP SCHEMA "+name+" CASCADE"); e != nil {
			t.Error(e)
		}
	}()
	q := u.Query()
	q.Set("search_path", name)
	u.RawQuery = q.Encode()
	db, err := Open(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.DB.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := db.DB.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	for _, sql := range []string{schema, lifecycleSchema, bodySchema, healthSchema, signalsSchema} {
		exec(sql)
	}
	// Version-five records already exist, in an order different from insertion.
	exec(`INSERT INTO devices(id,name,address,profile,model,created_at) VALUES
	 ('00000000-0000-4000-8000-000000000002','second','02:00:00:00:00:02','afu-wl-tz-a1','AFU-WL-TZ-A1','2021-01-01'),
	 ('00000000-0000-4000-8000-000000000001','first','02:00:00:00:00:01','afu-wl-tz-a1','AFU-WL-TZ-A1','2020-01-01'),
	 ('00000000-0000-4000-8000-000000000003','cuff','02:00:00:00:00:03','omron-hem-7374t1','HEM-7374T1','2019-01-01')`)
	for i := 0; i < 2; i++ {
		if e := db.Migrate(ctx); e != nil {
			t.Fatal(e)
		}
	}
	var first, second int64
	if err = db.DB.QueryRow(ctx, `SELECT scale_number FROM devices WHERE name='first'`).Scan(&first); err != nil {
		t.Fatal(err)
	}
	if err = db.DB.QueryRow(ctx, `SELECT scale_number FROM devices WHERE name='second'`).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if first != 1 || second != 2 {
		t.Fatalf("backfill %d %d", first, second)
	}
	var null bool
	if err = db.DB.QueryRow(ctx, `SELECT scale_number IS NULL FROM devices WHERE name='cuff'`).Scan(&null); err != nil || !null {
		t.Fatal("number assigned to cuff", err)
	}
	exec(`UPDATE devices SET lifecycle_state='unbound',collector_id=NULL WHERE name='second'`)
	exec(`DELETE FROM devices WHERE name='first'`)
	exec(`INSERT INTO devices(name,address,profile,model) VALUES('third','02:00:00:00:00:04','afu-wl-tz-a1','AFU-WL-TZ-A1')`)
	var third int64
	if err = db.DB.QueryRow(ctx, `SELECT scale_number FROM devices WHERE name='third'`).Scan(&third); err != nil || third != 3 {
		t.Fatal("deleted number reused", third, err)
	}
	if err = db.DB.QueryRow(ctx, `SELECT scale_number FROM devices WHERE name='second'`).Scan(&second); err != nil || second != 2 {
		t.Fatal("existing number changed", second, err)
	}
}
