package server

import (
	"context"
	"crypto/rand"
	"eir/internal/messaging"
	"eir/internal/store"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Server struct {
	Store                          *store.Store
	Bus                            *messaging.Bus
	PublicURL, FirmwareDir, WebDir string
	DocumentDir                    string
	DocumentMaxBytes               int64
	mu                             sync.Mutex
	listeners                      map[chan struct{}]bool
	signalListeners                map[chan struct{}]bool
}

func New(s *store.Store, public, dir, web string) *Server {
	return &Server{Store: s, PublicURL: strings.TrimRight(public, "/"), FirmwareDir: dir, WebDir: web, DocumentDir: filepath.Join(filepath.Dir(dir), "documents"), DocumentMaxBytes: 25 << 20, listeners: make(map[chan struct{}]bool), signalListeners: make(map[chan struct{}]bool)}
}

func (s *Server) SignalsChanged() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.signalListeners {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
func ID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func (s *Server) Changed() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.listeners {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
func respond(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}
func fail(w http.ResponseWriter, e error) {
	status := http.StatusInternalServerError
	message := "服务暂时不可用"
	var p *pgconn.PgError
	if errors.Is(e, pgx.ErrNoRows) {
		status = 404
		message = "未找到记录"
	} else if errors.As(e, &p) {
		switch p.Code {
		case "23505", "23503", "23514", "22007", "22P02":
			status = 409
			message = "数据冲突、引用不存在或字段无效"
		}
	}
	slog.Error("request failed", "error", e)
	respond(w, status, map[string]any{"error": message})
}
func bad(w http.ResponseWriter, message string) { respond(w, 400, map[string]string{"error": message}) }
func decode(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	d := json.NewDecoder(r.Body)
	if e := d.Decode(out); e != nil {
		bad(w, "无效 JSON 请求")
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		bad(w, "请求必须只有一个 JSON 对象")
		return false
	}
	return true
}
func (s *Server) list(w http.ResponseWriter, r *http.Request, q string, args ...any) {
	v, e := s.Store.List(r.Context(), q, args...)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, v)
}
func (s *Server) one(w http.ResponseWriter, r *http.Request, q string, args ...any) {
	v, e := s.Store.One(r.Context(), q, args...)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, v)
}
func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	s.lifecycleRoutes(m)
	s.healthRoutes(m)
	m.Handle("/mcp", s.mcpHandler())
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { respond(w, 200, map[string]any{"status": "ok"}) })
	m.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, c := context.WithTimeout(r.Context(), 2*time.Second)
		defer c()
		code := 200
		if s.Store.DB.Ping(ctx) != nil {
			code = 503
		}
		respond(w, code, map[string]any{"database": code == 200, "mqtt": s.Bus != nil && s.Bus.Connected()})
	})
	m.HandleFunc("GET /api/v1/members", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT * FROM members ORDER BY created_at")
	})
	m.HandleFunc("POST /api/v1/members", s.member)
	m.HandleFunc("PUT /api/v1/members/{id}", s.member)
	m.HandleFunc("GET /api/v1/collectors", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT *,protocol_version>=2 AS supports_lifecycle,coalesce(status->'online'='true'::jsonb,false) AND last_seen>now()-interval '90 seconds' AS online FROM collectors ORDER BY id")
	})
	m.HandleFunc("PUT /api/v1/collectors/{id}", s.collector)
	m.HandleFunc("POST /api/v1/collectors/{id}/commands", s.command)
	m.HandleFunc("GET /api/v1/devices", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT * FROM devices ORDER BY created_at")
	})
	m.HandleFunc("POST /api/v1/devices", s.device)
	m.HandleFunc("PATCH /api/v1/devices/{id}", s.deviceSettings)
	m.HandleFunc("GET /api/v1/bindings", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT b.*,m.name AS member_name FROM bindings b JOIN members m ON m.id=b.member_id WHERE ($1='' OR device_id::text=$1) ORDER BY effective_from DESC", r.URL.Query().Get("device_id"))
	})
	m.HandleFunc("GET /api/v1/bindings/preview", func(w http.ResponseWriter, r *http.Request) {
		s.one(w, r, "SELECT count(*) AS unassigned_count FROM measurements WHERE device_id::text=$1 AND user_slot::text=$2 AND member_id IS NULL AND measured_at IS NOT NULL AND NOT manual_assignment", r.URL.Query().Get("device_id"), r.URL.Query().Get("user_slot"))
	})
	m.HandleFunc("POST /api/v1/bindings", s.binding)
	m.HandleFunc("GET /api/v1/measurements", s.measurements)
	m.HandleFunc("GET /api/v1/measurements/export.csv", s.export)
	m.HandleFunc("PATCH /api/v1/measurements/{id}", s.correction)
	m.HandleFunc("GET /api/v1/statistics", s.statistics)
	m.HandleFunc("GET /api/v1/events", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT * FROM events WHERE ($1='' OR collector_id=$1) ORDER BY created_at DESC LIMIT 200", r.URL.Query().Get("collector_id"))
	})
	m.HandleFunc("GET /api/v1/rejections", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT id,collector_id,message_id,encode(payload,'escape') AS payload,reason,created_at FROM rejected_messages ORDER BY created_at DESC LIMIT 100")
	})
	m.HandleFunc("GET /api/v1/events/stream", s.stream)
	m.HandleFunc("GET /api/v1/firmwares", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT * FROM firmwares ORDER BY created_at DESC")
	})
	m.HandleFunc("POST /api/v1/firmwares", s.upload)
	m.HandleFunc("GET /api/v1/firmwares/{id}/download", s.download)
	m.HandleFunc("GET /api/v1/ota-jobs", func(w http.ResponseWriter, r *http.Request) {
		s.list(w, r, "SELECT j.*,f.version FROM ota_jobs j JOIN firmwares f ON f.id=j.firmware_id ORDER BY j.created_at DESC LIMIT 100")
	})
	m.HandleFunc("POST /api/v1/ota-jobs", s.ota)
	m.HandleFunc("GET /api/v1/openapi.json", s.openapi)
	m.HandleFunc("GET /api/v1/signals/latest", s.signalsLatest)
	m.HandleFunc("GET /api/v1/signals/history", s.signalsHistory)
	m.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 404, map[string]string{"error": "API not found"})
	})
	files := http.FileServer(http.Dir(s.WebDir))
	m.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" && r.Method != "HEAD" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		p := filepath.Join(s.WebDir, filepath.Clean("/"+r.URL.Path))
		if st, e := os.Stat(p); e == nil && !st.IsDir() {
			files.ServeHTTP(w, r)
			return
		}
		if strings.Contains(r.URL.Path, ".") {
			http.NotFound(w, r)
			return
		}
		http.ServeFile(w, r, filepath.Join(s.WebDir, "index.html"))
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("X-Frame-Options", "DENY")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		if r.Method != "GET" && r.Method != "HEAD" && r.Method != "OPTIONS" {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, e := url.Parse(origin)
				if e != nil || u.Host != r.Host {
					respond(w, 403, map[string]string{"error": "cross-origin write rejected"})
					return
				}
			}
		}
		defer func() {
			if recover() != nil {
				slog.Error("request panic")
				respond(w, 500, map[string]string{"error": "internal error"})
			}
		}()
		m.ServeHTTP(w, r)
	})
}
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch := make(chan struct{}, 1)
	signals := make(chan struct{}, 1)
	s.mu.Lock()
	s.listeners[ch] = true
	s.signalListeners[signals] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.listeners, ch); delete(s.signalListeners, signals); s.mu.Unlock() }()
	fmt.Fprint(w, "event: change\ndata: {}\n\n")
	f.Flush()
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			fmt.Fprint(w, "event: change\ndata: {}\n\n")
			f.Flush()
		case <-signals:
			fmt.Fprint(w, "event: signals\ndata: {}\n\n")
			f.Flush()
		case <-ticker.C:
			fmt.Fprint(w, ": keepalive\n\n")
			f.Flush()
		}
	}
}
