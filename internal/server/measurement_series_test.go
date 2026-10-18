package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSeriesCursor(t *testing.T) {
	cursor := seriesCursor{Time: time.Now().UTC().Truncate(time.Microsecond), ID: ID(), Before: time.Now().UTC()}
	b, _ := json.Marshal(cursor)
	value := base64.RawURLEncoding.EncodeToString(b)
	decoded, err := decodeSeriesCursor(value)
	if err != nil || decoded != cursor {
		t.Fatalf("cursor roundtrip: %+v %v", decoded, err)
	}
	for _, bad := range []string{"!", "e30", base64.RawURLEncoding.EncodeToString([]byte(`{"time":"2026-01-01T00:00:00Z","id":"bad"}`))} {
		if _, err := decodeSeriesCursor(bad); err == nil {
			t.Fatalf("accepted invalid cursor %q", bad)
		}
	}
}

func TestLatestFiltersAllowBothKinds(t *testing.T) {
	r := httptest.NewRequest("GET", "/?member_id="+ID(), nil)
	where, args, err := measurementFilters(r, false)
	if err != nil || where != "true AND member_id=$1" || len(args) != 1 {
		t.Fatalf("latest scope: %s %#v %v", where, args, err)
	}
	r = httptest.NewRequest("GET", "/?kind=unexpected", nil)
	if _, _, err := measurementFilters(r, false); err == nil {
		t.Fatal("accepted unknown kind")
	}
}
