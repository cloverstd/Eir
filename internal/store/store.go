package store

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

//go:embed lifecycle.sql
var lifecycleSchema string

//go:embed body.sql
var bodySchema string

//go:embed health.sql
var healthSchema string

type Store struct{ DB *pgxpool.Pool }

func Open(ctx context.Context, url string) (*Store, error) {
	config, e := pgxpool.ParseConfig(url)
	if e != nil {
		return nil, e
	}
	// Serialize timestamptz as UTC. Historical Shanghai offsets include seconds,
	// which are not valid RFC3339/JavaScript dates (notably initial binding year 1).
	config.ConnConfig.RuntimeParams["timezone"] = "UTC"
	p, e := pgxpool.NewWithConfig(ctx, config)
	if e != nil {
		return nil, e
	}
	return &Store{p}, nil
}
func (s *Store) Migrate(ctx context.Context) error {
	c, e := s.DB.Acquire(ctx)
	if e != nil {
		return e
	}
	defer c.Release()
	if _, e = c.Exec(ctx, "SELECT pg_advisory_lock(73473741)"); e != nil {
		return e
	}
	defer c.Exec(context.Background(), "SELECT pg_advisory_unlock(73473741)")
	tx, e := c.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, schema); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, lifecycleSchema); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, bodySchema); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, healthSchema); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func (s *Store) List(ctx context.Context, query string, args ...any) (json.RawMessage, error) {
	var out []byte
	e := s.DB.QueryRow(ctx, "SELECT coalesce(jsonb_agg(row_to_json(t)),'[]'::jsonb) FROM ("+query+") t", args...).Scan(&out)
	return out, e
}
func (s *Store) One(ctx context.Context, query string, args ...any) (json.RawMessage, error) {
	var out []byte
	e := s.DB.QueryRow(ctx, "SELECT row_to_json(t) FROM ("+query+") t", args...).Scan(&out)
	return out, e
}
func Placeholder(n int) string { return fmt.Sprintf("$%d", n) }
