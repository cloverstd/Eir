package main

import (
	"context"
	"eir/internal/messaging"
	"eir/internal/server"
	"eir/internal/store"
	"fmt"
	webpush "github.com/SherClockHolmes/webpush-go"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
	_ "time/tzdata"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "push-keygen" {
		private, public, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			os.Exit(1)
		}
		fmt.Printf("EIR_PUSH_VAPID_PUBLIC_KEY=%s\nEIR_PUSH_VAPID_PRIVATE_KEY=%s\n", public, private)
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		c := http.Client{Timeout: 3 * time.Second}
		r, e := c.Get("http://127.0.0.1:8080/healthz")
		if e != nil {
			os.Exit(1)
		}
		r.Body.Close()
		if r.StatusCode != 200 {
			os.Exit(1)
		}
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	db, e := store.Open(ctx, env("DATABASE_URL", "postgres://eir:eir@localhost:5432/eir?sslmode=disable"))
	if e != nil {
		slog.Error("database config", "error", e)
		os.Exit(1)
	}
	defer db.DB.Close()
	startup, cancel := context.WithTimeout(ctx, 30*time.Second)
	e = db.Migrate(startup)
	cancel()
	if e != nil {
		slog.Error("database migration failed", "error", e)
		os.Exit(1)
	}
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		slog.Info("migrations complete")
		return
	}
	app := server.New(db, env("EIR_PUBLIC_URL", "http://localhost:8080"), env("FIRMWARE_DIR", "data/firmwares"), env("WEB_DIR", "web/dist"))
	db.PushEnabled = os.Getenv("EIR_PUSH_ENABLED") == "true" && os.Getenv("EIR_PUSH_VAPID_PUBLIC_KEY") != "" && os.Getenv("EIR_PUSH_VAPID_PRIVATE_KEY") != "" && os.Getenv("EIR_PUSH_VAPID_SUBJECT") != ""
	go app.RunPush(ctx)
	app.DocumentDir = env("DOCUMENT_DIR", "data/documents")
	if value, err := strconv.ParseInt(env("EIR_DOCUMENT_MAX_BYTES", "26214400"), 10, 64); err == nil && value > 0 && value <= 100<<20 {
		app.DocumentMaxBytes = value
	}
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				app.ReconcileDocuments(ctx)
				app.CleanupDocuments(ctx)
			}
		}
	}()
	go func() {
		cleanup := func() {
			if e := db.CleanupSignals(ctx); e != nil {
				slog.Error("signal cleanup failed", "error", e)
			}
		}
		cleanup()
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				cleanup()
			}
		}
	}()
	app.Bus = messaging.Start(ctx, db, env("MQTT_URL", "tcp://localhost:1883"), os.Getenv("MQTT_USERNAME"), os.Getenv("MQTT_PASSWORD"), env("MQTT_PREFIX", "eir/v1"), app.Changed, app.SignalsChanged)
	srv := &http.Server{Addr: env("HTTP_ADDR", ":8080"), Handler: app.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 1 << 16}
	go func() {
		slog.Info("Eir listening", "address", srv.Addr)
		if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			slog.Error("HTTP server failed", "error", e)
			stop()
		}
	}()
	<-ctx.Done()
	shutdown, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()
	srv.Shutdown(shutdown)
}
