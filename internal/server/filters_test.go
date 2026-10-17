package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHistoryRouteFallback(t *testing.T) {
	dir := t.TempDir()
	if e := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html>Eir SPA</html>"), 0600); e != nil {
		t.Fatal(e)
	}
	app := New(nil, "http://localhost", t.TempDir(), dir).Handler()
	for _, tt := range []struct {
		path   string
		status int
	}{
		{"/data?page=2", 200}, {"/members/example/documents", 200}, {"/body", 200}, {"/assets/missing.js", 404}, {"/api/v1/missing", 404},
	} {
		w := httptest.NewRecorder()
		app.ServeHTTP(w, httptest.NewRequest("GET", tt.path, nil))
		if w.Code != tt.status {
			t.Fatalf("%s: %d", tt.path, w.Code)
		}
	}
}

func TestFiltersRejectBadDates(t *testing.T) {
	for _, q := range []string{"from=tomorrow", "from=2026-10-17T00:00:00Z&to=2026-10-16T00:00:00Z", "member_id=anything"} {
		r := httptest.NewRequest("GET", "/?"+q, nil)
		if _, _, e := filters(r); e == nil {
			t.Fatalf("accepted %s", q)
		}
	}
}
func TestFiltersExclusiveEndAndPending(t *testing.T) {
	r := httptest.NewRequest("GET", "/?unassigned=true&from=2026-10-16T00:00:00Z&to=2026-10-17T00:00:00Z", nil)
	sql, args, e := filters(r)
	if e != nil || len(args) != 2 || !strings.Contains(sql, "member_id IS NULL") || !strings.Contains(sql, "measured_at<$2") {
		t.Fatalf("%s %#v %v", sql, args, e)
	}
}
func TestCSVFormulaEscape(t *testing.T) {
	for _, s := range []string{"=1+1", "+SUM(A1)", "@x", "\t=1"} {
		if safeCell(s) != "'"+s {
			t.Fatal(s)
		}
	}
	if safeCell("爸爸") != "爸爸" {
		t.Fatal("changed normal text")
	}
}
func TestMalformedBody(t *testing.T) {
	for _, body := range []string{`{}`, `{} {}`} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		var out map[string]json.RawMessage
		ok := decode(w, r, &out)
		if ok != (body == `{}`) {
			t.Fatal(body)
		}
	}
}

func TestHandlerConstructionAndHealth(t *testing.T) {
	app := New(nil, "http://localhost:8080", t.TempDir(), t.TempDir())
	handler := app.Handler()
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != 200 {
		t.Fatalf("health: %d %s", w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/missing", nil))
	if w.Code != 404 {
		t.Fatalf("API fallback: %d", w.Code)
	}
	r := httptest.NewRequest("POST", "http://localhost:8080/api/v1/members", strings.NewReader(`{"name":"test"}`))
	r.Header.Set("Origin", "http://foreign.test")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatalf("cross-origin write: %d", w.Code)
	}
}
