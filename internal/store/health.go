package store

import (
	"context"
	"eir/internal/health"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"strings"
	"time"
)

type HealthQuery struct {
	MemberID string `json:"member_id,omitempty"`
	Kind     string `json:"kind,omitempty"`
	From     string `json:"from,omitempty"`
	To       string `json:"to,omitempty"`
	Source   string `json:"source,omitempty"`
	Search   string `json:"search,omitempty"`
	Group    string `json:"group,omitempty"`
	Page     int    `json:"page,omitempty"`
	PageSize int    `json:"page_size,omitempty"`
}

func (q *HealthQuery) Validate() error {
	if q.MemberID != "" && !UUIDPattern.MatchString(q.MemberID) {
		return errors.New("无效成员 ID")
	}
	if q.Page == 0 {
		q.Page = 1
	}
	if q.PageSize == 0 {
		q.PageSize = 50
	}
	if q.Page < 1 || q.Page > 100000 || q.PageSize < 1 || q.PageSize > 200 {
		return errors.New("无效分页")
	}
	for _, v := range []string{q.From, q.To} {
		if v != "" {
			if _, e := time.Parse(time.RFC3339, v); e != nil {
				return errors.New("时间需要 RFC3339 格式")
			}
		}
	}
	if q.From != "" && q.To != "" {
		a, _ := time.Parse(time.RFC3339, q.From)
		b, _ := time.Parse(time.RFC3339, q.To)
		if !b.After(a) {
			return errors.New("结束时间必须晚于开始时间")
		}
	}
	if q.Group == "" {
		q.Group = "day"
	}
	if q.Group != "day" && q.Group != "week" && q.Group != "month" {
		return errors.New("无效汇总方式")
	}
	if q.Source != "" && q.Source != "manual" && q.Source != "device" {
		return errors.New("无效来源")
	}
	if len(q.Search) > 200 {
		return errors.New("搜索词过长")
	}
	return nil
}
func (s *Store) Members(ctx context.Context) (json.RawMessage, error) {
	return s.List(ctx, "SELECT * FROM members ORDER BY created_at,id")
}
func (s *Store) Member(ctx context.Context, id string) (json.RawMessage, error) {
	if !UUIDPattern.MatchString(id) {
		return nil, errors.New("无效成员 ID")
	}
	return s.One(ctx, "SELECT * FROM members WHERE id=$1", id)
}
func (s *Store) History(ctx context.Context, q HealthQuery) (json.RawMessage, error) {
	if e := q.Validate(); e != nil {
		return nil, e
	}
	if q.Kind != "" && !health.HistoryKinds[q.Kind] {
		return nil, errors.New("无效健康经历类型")
	}
	where := " FROM health_history WHERE ($1='' OR member_id::text=$1) AND ($2='' OR kind=$2) AND ($3='' OR title ILIKE '%'||$3||'%' OR notes ILIKE '%'||$3||'%')"
	return s.healthPage(ctx, "SELECT *"+where+" ORDER BY occurred_on DESC NULLS LAST,created_at DESC,id LIMIT $4 OFFSET $5", "SELECT count(*)"+where, []any{q.MemberID, q.Kind, q.Search}, q)
}

const documentColumns = "id,member_id,history_id,title,category,recorded_on,institution,summary,filename,mime_type,size,sha256,page_count,created_at,updated_at"

func (s *Store) Documents(ctx context.Context, q HealthQuery) (json.RawMessage, error) {
	if e := q.Validate(); e != nil {
		return nil, e
	}
	where := " FROM medical_documents WHERE ($1='' OR member_id::text=$1) AND ($2='' OR category=$2) AND ($3='' OR title ILIKE '%'||$3||'%' OR summary ILIKE '%'||$3||'%')"
	return s.healthPage(ctx, "SELECT "+documentColumns+where+" ORDER BY recorded_on DESC NULLS LAST,created_at DESC,id LIMIT $4 OFFSET $5", "SELECT count(*)"+where, []any{q.MemberID, q.Kind, q.Search}, q)
}
func (s *Store) Document(ctx context.Context, id string) (json.RawMessage, error) {
	if !UUIDPattern.MatchString(id) {
		return nil, errors.New("无效文件 ID")
	}
	return s.One(ctx, "SELECT "+documentColumns+" FROM medical_documents WHERE id=$1", id)
}
func observationWhere(q HealthQuery) (string, []any, error) {
	if e := q.Validate(); e != nil {
		return "", nil, e
	}
	if q.Kind != "" && q.Kind != "bmi" {
		if _, ok := health.MetricFor(q.Kind); !ok {
			return "", nil, errors.New("无效指标类型")
		}
	}
	return " FROM health_observations WHERE ($1='' OR member_id::text=$1) AND ($2='' OR kind=$2) AND ($3='' OR source=$3) AND ($4::timestamptz IS NULL OR measured_at >= $4::timestamptz) AND ($5::timestamptz IS NULL OR measured_at < $5::timestamptz)", []any{q.MemberID, q.Kind, q.Source, nullText(q.From), nullText(q.To)}, nil
}
func nullText(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func (s *Store) Observations(ctx context.Context, q HealthQuery) (json.RawMessage, error) {
	if e := q.Validate(); e != nil {
		return nil, e
	}
	where, args, e := observationWhere(q)
	if e != nil {
		return nil, e
	}
	return s.healthPage(ctx, "SELECT *"+where+" ORDER BY measured_at DESC NULLS LAST,id LIMIT $6 OFFSET $7", "SELECT count(*)"+where, args, q)
}
func (s *Store) Statistics(ctx context.Context, q HealthQuery) (json.RawMessage, error) {
	if e := q.Validate(); e != nil {
		return nil, e
	}
	where, args, e := observationWhere(q)
	if e != nil {
		return nil, e
	}
	// A bucket is never shared by incompatible kinds, units, or measured/estimated values.
	grouped := fmt.Sprintf("SELECT kind,unit,estimated,age_approximate,date_trunc('%s',measured_at AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai' AS time,count(*) AS count,avg(value) AS mean,min(value) AS min,max(value) AS max,avg(value_secondary) AS mean_secondary%s AND measured_at IS NOT NULL GROUP BY kind,unit,estimated,age_approximate,time", q.Group, where)
	return s.healthPage(ctx, grouped+" ORDER BY time,kind,estimated,age_approximate LIMIT $6 OFFSET $7", "SELECT count(*) FROM ("+grouped+") grouped", args, q)
}
func (s *Store) healthPage(ctx context.Context, query, count string, args []any, q HealthQuery) (json.RawMessage, error) {
	var total int
	if e := s.DB.QueryRow(ctx, count, args...).Scan(&total); e != nil {
		return nil, e
	}
	params := append(append([]any{}, args...), q.PageSize, (q.Page-1)*q.PageSize)
	items, e := s.List(ctx, query, params...)
	if e != nil {
		return nil, e
	}
	b, e := json.Marshal(map[string]any{"items": items, "total": total, "page": q.Page, "page_size": q.PageSize})
	return b, e
}
func HealthWrite(ctx context.Context, tx pgx.Tx) error {
	_, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(73473742)")
	return e
}
func HealthChanged(ctx context.Context, tx pgx.Tx) error {
	_, e := tx.Exec(ctx, "UPDATE system_state SET revision=revision+1")
	return e
}
func ValidHistoryDetails(details map[string]string) bool {
	for k, v := range details {
		if !strings.Contains("|reaction|severity|dose|frequency|relative|ended_on|", "|"+k+"|") || len(v) > 1000 {
			return false
		}
	}
	return len(details) <= 6
}
