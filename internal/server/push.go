package server

import (
	"context"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/jackc/pgx/v5"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

func pushHash(v string) string { h := sha256.Sum256([]byte(v)); return hex.EncodeToString(h[:]) }
func validPushEndpoint(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return strings.HasSuffix(host, ".push.apple.com") || host == "fcm.googleapis.com" || host == "updates.push.services.mozilla.com"
}
func pushClient() *http.Client {
	return &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("push redirect rejected") }, Transport: &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		for _, ip := range ips {
			if !ip.IP.IsGlobalUnicast() || ip.IP.IsPrivate() || ip.IP.IsLoopback() || ip.IP.IsLinkLocalUnicast() {
				return nil, errors.New("private push address rejected")
			}
		}
		for _, ip := range ips {
			c, e := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
			if e == nil {
				return c, nil
			}
		}
		return nil, errors.New("push endpoint unreachable")
	}}}
}
func (s *Server) pushRoutes(m *http.ServeMux) {
	m.HandleFunc("GET /api/v1/push/config", func(w http.ResponseWriter, r *http.Request) {
		respond(w, 200, map[string]any{"enabled": s.Store.PushEnabled, "public_key": os.Getenv("EIR_PUSH_VAPID_PUBLIC_KEY")})
	})
	m.HandleFunc("POST /api/v1/push/subscriptions", func(w http.ResponseWriter, r *http.Request) {
		if !s.Store.PushEnabled {
			respond(w, 503, map[string]string{"error": "推送尚未配置"})
			return
		}
		var in struct {
			Subscription webpush.Subscription `json:"subscription"`
			Members      []string             `json:"member_ids"`
		}
		if !decode(w, r, &in) {
			return
		}
		if !validPushEndpoint(in.Subscription.Endpoint) || !validPushKeys(in.Subscription.Keys.Auth, in.Subscription.Keys.P256dh) {
			bad(w, "无效推送订阅")
			return
		}
		if !s.pushMembers(r.Context(), in.Members) {
			bad(w, "请选择有效成员")
			return
		}
		token := make([]byte, 32)
		if _, e := rand.Read(token); e != nil {
			fail(w, e)
			return
		}
		secret := hex.EncodeToString(token)
		data, _ := json.Marshal(in.Subscription)
		var id string
		e := s.Store.DB.QueryRow(r.Context(), `INSERT INTO push_subscriptions(endpoint,subscription,token_hash,member_ids) VALUES($1,$2,$3,$4) ON CONFLICT(endpoint) DO NOTHING RETURNING id::text`, in.Subscription.Endpoint, data, pushHash(secret), in.Members).Scan(&id)
		if errors.Is(e, pgx.ErrNoRows) {
			respond(w, 409, map[string]string{"error": "该订阅已注册，请先取消浏览器订阅后重试"})
			return
		}
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 201, map[string]string{"id": id, "token": secret})
	})
	for _, method := range []string{"GET", "PATCH", "DELETE", "POST"} {
		pattern := method + " /api/v1/push/subscriptions/{id}"
		if method == "POST" {
			pattern += "/test"
		}
		m.HandleFunc(pattern, s.managePush)
	}
}
func (s *Server) pushMembers(ctx context.Context, ids []string) bool {
	if len(ids) == 0 || len(ids) > 100 {
		return false
	}
	for _, id := range ids {
		if len(id) != 36 {
			return false
		}
	}
	var count int
	e := s.Store.DB.QueryRow(ctx, "SELECT count(*) FROM members WHERE id::text=ANY($1)", ids).Scan(&count)
	return e == nil && count == len(ids)
}
func (s *Server) managePush(w http.ResponseWriter, r *http.Request) {
	var id string
	var raw json.RawMessage
	var members []string
	token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if len(token) != 64 {
		respond(w, 404, map[string]string{"error": "订阅不存在"})
		return
	}
	e := s.Store.DB.QueryRow(r.Context(), "SELECT id::text,subscription,member_ids::text[] FROM push_subscriptions WHERE id::text=$1 AND token_hash=$2", r.PathValue("id"), pushHash(token)).Scan(&id, &raw, &members)
	if e != nil {
		respond(w, 404, map[string]string{"error": "订阅不存在"})
		return
	}
	switch r.Method {
	case "GET":
		respond(w, 200, map[string]any{"id": id, "member_ids": members})
	case "DELETE":
		_, e = s.Store.DB.Exec(r.Context(), "DELETE FROM push_subscriptions WHERE id=$1", id)
		if e != nil {
			fail(w, e)
			return
		}
		w.WriteHeader(204)
	case "PATCH":
		var in struct {
			Members []string `json:"member_ids"`
		}
		if !decode(w, r, &in) {
			return
		}
		if !s.pushMembers(r.Context(), in.Members) {
			bad(w, "请选择有效成员")
			return
		}
		_, e = s.Store.DB.Exec(r.Context(), "UPDATE push_subscriptions SET member_ids=$2 WHERE id=$1", id, in.Members)
		if e != nil {
			fail(w, e)
			return
		}
		w.WriteHeader(204)
	case "POST":
		if !s.Store.PushEnabled {
			respond(w, 503, map[string]string{"error": "推送未启用"})
			return
		}
		code, err := s.deliverPush(r.Context(), raw, map[string]any{"title": "Eir 测试通知", "body": "这台设备已可以接收通知", "tag": "eir-test", "url": "/settings"})
		if err != nil || code < 200 || code >= 300 {
			respond(w, 502, map[string]string{"error": "推送服务暂时不可用"})
			return
		}
		w.WriteHeader(204)
	}
}
func sendPush(ctx context.Context, raw json.RawMessage, payload any) (int, error) {
	var sub webpush.Subscription
	if e := json.Unmarshal(raw, &sub); e != nil {
		return 0, e
	}
	if !validPushEndpoint(sub.Endpoint) {
		return 0, errors.New("invalid endpoint")
	}
	data, _ := json.Marshal(payload)
	response, e := webpush.SendNotificationWithContext(ctx, data, &sub, &webpush.Options{HTTPClient: pushClient(), Subscriber: os.Getenv("EIR_PUSH_VAPID_SUBJECT"), VAPIDPublicKey: os.Getenv("EIR_PUSH_VAPID_PUBLIC_KEY"), VAPIDPrivateKey: os.Getenv("EIR_PUSH_VAPID_PRIVATE_KEY"), TTL: 86400})
	if e != nil {
		return 0, e
	}
	defer response.Body.Close()
	return response.StatusCode, nil
}
func (s *Server) RunPush(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if s.Store.PushEnabled {
				s.pushNext(ctx)
			}
		}
	}
}
func (s *Server) pushNext(ctx context.Context) {
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		return
	}
	defer tx.Rollback(ctx)
	var id, subID string
	var raw, row json.RawMessage
	var attempts int
	e = tx.QueryRow(ctx, `SELECT q.id::text,q.subscription_id::text,s.subscription,row_to_json(m),q.attempts FROM push_deliveries q JOIN push_subscriptions s ON s.id=q.subscription_id JOIN measurement_details m ON m.id=q.measurement_id WHERE q.status='pending' AND q.next_attempt<=now() ORDER BY q.created_at LIMIT 1 FOR UPDATE OF q SKIP LOCKED`).Scan(&id, &subID, &raw, &row, &attempts)
	if e != nil {
		return
	}
	var valid bool
	e = tx.QueryRow(ctx, `SELECT coalesce(q.created_at>now()-interval '24 hours' AND q.member_id=m.member_id AND q.member_id=ANY(s.member_ids),false) FROM push_deliveries q JOIN measurements m ON m.id=q.measurement_id JOIN push_subscriptions s ON s.id=q.subscription_id WHERE q.id=$1`, id).Scan(&valid)
	if e != nil {
		return
	}
	if !valid {
		_, e = tx.Exec(ctx, "UPDATE push_deliveries SET status='cancelled' WHERE id=$1", id)
		if e == nil {
			tx.Commit(ctx)
		}
		return
	}
	_, e = tx.Exec(ctx, "UPDATE push_deliveries SET attempts=attempts+1,next_attempt=now()+interval '2 minutes' WHERE id=$1", id)
	if e != nil {
		return
	}
	if tx.Commit(ctx) != nil {
		return
	}
	var m map[string]any
	json.Unmarshal(row, &m)
	path := "/data"
	body := fmt.Sprintf("血压 %v/%v mmHg，脉搏 %v bpm", m["systolic"], m["diastolic"], m["pulse"])
	if m["kind"] == "body_composition" {
		path = "/body"
		body = fmt.Sprintf("体重 %v kg", m["weight_kg"])
		if m["body_fat_status"] == "estimated" {
			body += fmt.Sprintf("，估算体脂 %v%%", m["body_fat_pct"])
		}
	}
	if at, ok := m["measured_at"].(string); ok {
		if t, err := time.Parse(time.RFC3339, at); err == nil {
			body += " · " + t.In(time.FixedZone("CST", 8*3600)).Format("01-02 15:04")
		}
	}
	link := path + "?member_id=" + fmt.Sprint(m["member_id"]) + "&measurement_id=" + fmt.Sprint(m["id"])
	code, err := s.deliverPush(ctx, raw, map[string]any{"title": fmt.Sprint(m["member_name"]) + " · 新测量", "body": body, "tag": "eir-" + id, "url": link})
	if code == 404 || code == 410 {
		s.Store.DB.Exec(ctx, "DELETE FROM push_subscriptions WHERE id=$1", subID)
		return
	}
	if err != nil || code < 200 || code >= 300 {
		slog.Warn("push delivery failed", "delivery_id", id, "http_status", code, "attempt", attempts+1)
	}
	status := "pending"
	if err == nil && code >= 200 && code < 300 {
		status = "sent"
	} else if err == nil && code >= 400 && code < 500 && code != 429 {
		status = "failed"
	}
	delay := time.Duration(30*(1<<min(attempts, 7))) * time.Second
	s.Store.DB.Exec(ctx, "UPDATE push_deliveries SET status=$2,next_attempt=$3 WHERE id=$1", id, status, time.Now().Add(delay))
	s.Store.DB.Exec(ctx, "DELETE FROM push_deliveries WHERE created_at<now()-interval '7 days'")
}

func (s *Server) deliverPush(ctx context.Context, raw json.RawMessage, payload any) (int, error) {
	if s.pushSender != nil {
		return s.pushSender(ctx, raw, payload)
	}
	return sendPush(ctx, raw, payload)
}

func validPushKeys(auth, public string) bool {
	a, e := base64.RawURLEncoding.DecodeString(strings.TrimRight(auth, "="))
	if e != nil || len(a) != 16 {
		return false
	}
	p, e := base64.RawURLEncoding.DecodeString(strings.TrimRight(public, "="))
	if e != nil {
		return false
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), p)
	return x != nil && y != nil
}
