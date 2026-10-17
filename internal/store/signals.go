package store

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

type SignalSample struct {
	Kind      string `json:"kind"`
	DeviceID  string `json:"device_id"`
	RSSI      *int   `json:"rssi"`
	Source    string `json:"source"`
	AgeMS     int64  `json:"age_ms"`
	Connected bool   `json:"connected"`
}
type SignalPacket struct {
	ProtocolVersion int            `json:"protocol_version"`
	InstanceID      string         `json:"instance_id"`
	BindingID       string         `json:"binding_id"`
	DataEpoch       string         `json:"data_epoch"`
	BootID          string         `json:"boot_id"`
	Sequence        int64          `json:"sequence"`
	SentAt          *time.Time     `json:"sent_at"`
	UptimeMS        *int64         `json:"uptime_ms"`
	Samples         []SignalSample `json:"samples"`
}

var signalBootPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func (p SignalPacket) valid(now time.Time) bool {
	if p.ProtocolVersion != 2 || !UUIDPattern.MatchString(p.InstanceID) || !UUIDPattern.MatchString(p.BindingID) || !UUIDPattern.MatchString(p.DataEpoch) || !signalBootPattern.MatchString(p.BootID) || p.Sequence < 1 || len(p.Samples) > 32 || len(p.Samples) == 0 {
		return false
	}
	if p.SentAt != nil && (p.SentAt.After(now.Add(5*time.Second)) || p.SentAt.Before(now.Add(-15*time.Second))) {
		return false
	}
	if p.SentAt == nil && p.UptimeMS == nil {
		return false
	}
	if p.UptimeMS != nil && (*p.UptimeMS < 0 || *p.UptimeMS > 3155760000000) {
		return false
	}
	seen := map[string]bool{}
	for _, v := range p.Samples {
		key := v.Kind + v.DeviceID
		if seen[key] || v.AgeMS < 0 || v.AgeMS > 15000 {
			return false
		}
		seen[key] = true
		if v.RSSI != nil && (*v.RSSI < -127 || *v.RSSI > 20) {
			return false
		}
		if v.Kind == "wifi" {
			if v.DeviceID != "" || v.Source != "wifi" {
				return false
			}
		} else if v.Kind == "ble" {
			if !UUIDPattern.MatchString(v.DeviceID) || (v.Source != "advertisement" && v.Source != "connection") {
				return false
			}
		} else {
			return false
		}
	}
	return true
}

// Telemetry has no application ACK or durable replay queue. Only the current,
// already announced boot and lifecycle scope may update a managed collector.
func (s *Store) IngestSignals(ctx context.Context, collector string, data []byte) (bool, error) {
	var p SignalPacket
	now := time.Now().UTC()
	if json.Unmarshal(data, &p) != nil || !p.valid(now) {
		return false, nil
	}
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	var valid bool
	var lastSeen *time.Time
	var uptimeText *string
	e = tx.QueryRow(ctx, `SELECT c.lifecycle_state='bound' AND c.binding_id::text=$2 AND s.instance_id::text=$3 AND s.data_epoch::text=$4 AND coalesce(c.status->>'boot_id','')=$5,c.last_seen,c.status->>'uptime'
 FROM collectors c CROSS JOIN system_state s WHERE c.id=$1 FOR UPDATE OF c`, collector, p.BindingID, p.InstanceID, p.DataEpoch, p.BootID).Scan(&valid, &lastSeen, &uptimeText)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if !valid {
		return false, nil
	}
	base := now
	if p.SentAt != nil {
		base = *p.SentAt
	} else {
		if lastSeen == nil || uptimeText == nil {
			return false, nil
		}
		uptime, e := strconv.ParseInt(*uptimeText, 10, 64)
		if e != nil || uptime < 0 || uptime > 3155760000 {
			return false, nil
		}
		// The heartbeat's server receipt anchors the same boot's monotonic
		// clock. Replayed, unclocked MQTT samples cannot become fresh merely
		// because their age_ms was computed before a long disconnection.
		base = lastSeen.Add(time.Duration(*p.UptimeMS-uptime*1000) * time.Millisecond)
		if base.Before(now.Add(-15*time.Second)) || base.After(now.Add(5*time.Second)) {
			return false, nil
		}
	}
	changed := false
	for _, v := range p.Samples {
		key := "wifi"
		if v.Kind == "ble" {
			e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM devices WHERE id=$1 AND collector_id=$2 AND lifecycle_state='active')", v.DeviceID, collector).Scan(&valid)
			if e != nil {
				return false, e
			}
			if !valid {
				continue
			}
			key = v.DeviceID
		}
		at := base.Add(-time.Duration(v.AgeMS) * time.Millisecond)
		var id int64
		e = tx.QueryRow(ctx, `INSERT INTO signal_samples(collector_id,device_id,link_key,kind,binding_id,data_epoch,boot_id,sequence,sampled_at,rssi,source,connected)
  VALUES($1,nullif($2,'')::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id`, collector, v.DeviceID, key, v.Kind, p.BindingID, p.DataEpoch, p.BootID, p.Sequence, at, v.RSSI, v.Source, v.Connected).Scan(&id)
		if errors.Is(e, pgx.ErrNoRows) {
			continue
		}
		if e != nil {
			return false, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO signal_latest(collector_id,link_key,sample_id) VALUES($1,$2,$3)
  ON CONFLICT(collector_id,link_key) DO UPDATE SET sample_id=EXCLUDED.sample_id
  WHERE EXISTS(SELECT 1 FROM signal_samples old WHERE old.id=signal_latest.sample_id AND
  (old.binding_id<>$4::uuid OR old.data_epoch<>$5::uuid OR old.boot_id<>$6 OR (old.sequence<$7 AND old.sampled_at<=$8)))`, collector, key, id, p.BindingID, p.DataEpoch, p.BootID, p.Sequence, at)
		if e != nil {
			return false, e
		}
		changed = true
	}
	return changed, tx.Commit(ctx)
}

func (s *Store) CleanupSignals(ctx context.Context) error {
	_, e := s.DB.Exec(ctx, "DELETE FROM signal_samples WHERE sampled_at < now()-interval '7 days'")
	return e
}

const signalCurrent = ` FROM signal_samples t JOIN collectors c ON c.id=t.collector_id CROSS JOIN system_state sys
 LEFT JOIN devices d ON d.id=t.device_id
 WHERE t.binding_id=c.binding_id AND t.data_epoch=sys.data_epoch
 AND (t.device_id IS NULL OR (d.collector_id=c.id AND d.lifecycle_state='active')) `

func (s *Store) LatestSignals(ctx context.Context, collector, kind, device string) (json.RawMessage, error) {
	return s.List(ctx, `SELECT t.*,coalesce(c.status->'online'='true'::jsonb,false) AND c.last_seen>now()-interval '90 seconds' AS online,
 t.boot_id=coalesce(c.status->>'boot_id','') AND t.sampled_at>now()-interval '15 seconds' AS fresh`+signalCurrent+`
 AND EXISTS(SELECT 1 FROM signal_latest l WHERE l.sample_id=t.id)
 AND ($1='' OR t.collector_id=$1) AND ($2='' OR t.kind=$2) AND ($3='' OR t.device_id::text=$3) ORDER BY t.collector_id,t.link_key`, collector, kind, device)
}

func (s *Store) SignalHistory(ctx context.Context, collector, kind, device string, seconds, bucket int) (json.RawMessage, error) {
	// Generate empty buckets too, so the browser never connects across outages.
	return s.List(ctx, `WITH bounds AS (SELECT date_bin(make_interval(secs=>$5),now(),timestamptz '2000-01-01') AS finish),
 buckets AS (SELECT generate_series(finish-make_interval(secs=>$4),finish,make_interval(secs=>$5)) AS time FROM bounds),
 samples AS (SELECT date_bin(make_interval(secs=>$5),t.sampled_at,timestamptz '2000-01-01') AS time,t.rssi`+signalCurrent+`
 AND t.collector_id=$1 AND t.kind=$2 AND ($3='' OR t.device_id::text=$3)
 AND t.sampled_at>=now()-make_interval(secs=>$4) AND t.sampled_at>now()-interval '7 days')
 SELECT b.time,avg(s.rssi) AS mean,min(s.rssi) AS min,max(s.rssi) AS max,count(s.rssi) AS count
 FROM buckets b LEFT JOIN samples s ON s.time=b.time GROUP BY b.time ORDER BY b.time`, collector, kind, device, seconds, bucket)
}
