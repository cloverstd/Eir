package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"time"
)

type SystemState struct {
	InstanceID string `json:"instance_id"`
	DataEpoch  string `json:"data_epoch"`
	Revision   int64  `json:"revision"`
}

func (s *Store) System(ctx context.Context) (SystemState, error) {
	var v SystemState
	e := s.DB.QueryRow(ctx, "SELECT instance_id::text,data_epoch::text,revision FROM system_state").Scan(&v.InstanceID, &v.DataEpoch, &v.Revision)
	return v, e
}
func (s *Store) DesiredConfig(ctx context.Context, id string) (map[string]any, error) {
	sys, e := s.System(ctx)
	if e != nil {
		return nil, e
	}
	var revision int64
	var state, nonce, binding string
	var proto int
	e = s.DB.QueryRow(ctx, "SELECT config_version,lifecycle_state,enrollment_nonce,binding_id::text,protocol_version FROM collectors WHERE id=$1", id).Scan(&revision, &state, &nonce, &binding, &proto)
	if e != nil {
		return nil, e
	}
	devices, e := s.List(ctx, "SELECT id,address,address_type,model,profile,hardware_id,adc_index,lifecycle_state='active' AS enabled FROM devices WHERE collector_id=$1 ORDER BY id", id)
	if e != nil {
		return nil, e
	}
	var opID string
	s.DB.QueryRow(ctx, "SELECT id::text FROM operations WHERE collector_id=$1 AND type='claim' AND status='pending' ORDER BY created_at DESC LIMIT 1", id).Scan(&opID)
	if proto < 2 && nonce == "" {
		return map[string]any{"version": revision, "devices": devices}, nil
	}
	return map[string]any{"version": revision, "protocol_version": 2, "instance_id": sys.InstanceID, "binding_id": binding, "data_epoch": sys.DataEpoch, "enrollment_nonce": nonce, "claim": state == "binding" || proto < 2, "preserve_legacy": proto < 2, "operation_id": opID, "devices": devices}, nil
}

// Status never creates a managed collector. Unknown or re-flashed boards are candidates.
func (s *Store) HandleStatus(ctx context.Context, id string, data []byte) (map[string]any, error) {
	if !CollectorPattern.MatchString(id) {
		return nil, errors.New("invalid collector")
	}
	var v map[string]any
	if json.Unmarshal(data, &v) != nil {
		return nil, nil
	}
	str := func(k string) string { x, _ := v[k].(string); return x }
	proto := 1
	if n, ok := v["protocol_version"].(float64); ok {
		proto = int(n)
	}
	nonce := str("enrollment_nonce")
	if len(nonce) > 128 {
		return nil, nil
	}
	sys, e := s.System(ctx)
	if e != nil {
		return nil, e
	}
	var binding, state, knownNonce string
	var oldProto int
	e = s.DB.QueryRow(ctx, "SELECT binding_id::text,lifecycle_state,enrollment_nonce,protocol_version FROM collectors WHERE id=$1", id).Scan(&binding, &state, &knownNonce, &oldProto)
	if e != nil && !errors.Is(e, pgx.ErrNoRows) {
		return nil, e
	}
	if e == nil {
		matching := proto >= 2 && str("instance_id") == sys.InstanceID && str("binding_id") == binding && str("data_epoch") == sys.DataEpoch
		legacy := oldProto == 1 && proto == 1
		adoption := oldProto == 1 && proto >= 2 && v["legacy_adoption"] == true && nonce != ""
		if matching || legacy || adoption {
			if matching {
				oldProto = 2
				if state == "binding" {
					state = "bound"
				}
			}
			if adoption {
				knownNonce = nonce
			}
			_, e = s.DB.Exec(ctx, "UPDATE collectors SET status=status||$2::jsonb,last_seen=now(),protocol_version=$3,enrollment_nonce=$4,lifecycle_state=$5 WHERE id=$1", id, data, oldProto, knownNonce, state)
			if e != nil {
				return nil, e
			}
			if matching {
				_, e = s.DB.Exec(ctx, "UPDATE operations SET status='succeeded',updated_at=now() WHERE collector_id=$1 AND type='claim' AND status='pending'", id)
			}
			return nil, e
		}
		// Bare last-will packet may only mark a known collector offline, never fresh online.
		if len(v) == 1 && v["online"] == false {
			_, e = s.DB.Exec(ctx, "UPDATE collectors SET status=status||'{\"online\":false}'::jsonb WHERE id=$1", id)
			return nil, e
		}
		if str("binding_id") != "" || v["bound"] == true {
			return nil, nil
		}
	}
	var retiredBinding, retiredNonce string
	var retiredVersion int64
	tomb := s.DB.QueryRow(ctx, "SELECT binding_id::text,enrollment_nonce,config_version FROM collector_tombstones WHERE id=$1", id).Scan(&retiredBinding, &retiredNonce, &retiredVersion)
	if tomb == nil && (nonce == retiredNonce || str("binding_id") == retiredBinding || proto < 2) {
		if proto < 2 {
			return map[string]any{"legacy_revoke": true, "version": retiredVersion + 1, "devices": []any{}}, nil
		}
		return map[string]any{"id": retiredBinding, "type": "revoke", "instance_id": str("instance_id"), "binding_id": retiredBinding, "data_epoch": str("data_epoch"), "expires_at": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)}, nil
	}
	if proto >= 2 && nonce == "" {
		return nil, nil
	}
	// Candidate payload is restricted to non-health metadata.
	candidate := map[string]any{}
	for _, k := range []string{"online", "ip", "firmware", "rssi", "protocol_version", "enrollment_nonce", "capabilities"} {
		if x, ok := v[k]; ok {
			candidate[k] = x
		}
	}
	safe, _ := json.Marshal(candidate)
	_, e = s.DB.Exec(ctx, "INSERT INTO collector_candidates(id,enrollment_nonce,protocol_version,status) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET enrollment_nonce=EXCLUDED.enrollment_nonce,protocol_version=EXCLUDED.protocol_version,status=EXCLUDED.status,last_seen=now()", id, nonce, proto, safe)
	// Factory-reset completion survives network erasure as a non-health receipt.
	if receipt, ok := v["reset_receipt"].(map[string]any); ok {
		if op, ok := receipt["command_id"].(string); ok && UUIDPattern.MatchString(op) {
			s.DB.Exec(ctx, "UPDATE operations SET status='succeeded',updated_at=now() WHERE id=$1 AND collector_id=$2 AND type='factory_reset' AND status='awaiting_provisioning'", op, id)
		}
	}
	return nil, e
}
func (s *Store) RemoveCollector(ctx context.Context, id string) error {
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if e = removeCollector(ctx, tx, id); e != nil {
		return e
	}
	return tx.Commit(ctx)
}
func removeCollector(ctx context.Context, tx pgx.Tx, id string) error {
	if _, e := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(73473742)"); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `INSERT INTO collector_tombstones(id,binding_id,enrollment_nonce,config_version) SELECT id,binding_id,enrollment_nonce,config_version FROM collectors WHERE id=$1 ON CONFLICT(id) DO UPDATE SET binding_id=EXCLUDED.binding_id,enrollment_nonce=EXCLUDED.enrollment_nonce,config_version=greatest(collector_tombstones.config_version,EXCLUDED.config_version),deleted_at=now()`, id)
	if e != nil {
		return e
	}
	statements := []string{
		"UPDATE measurements m SET source_collector_id=coalesce(source_collector_id,$1),source_device_name=coalesce(source_device_name,d.name) FROM devices d WHERE m.device_id=d.id AND m.collector_id=$1",
		"UPDATE devices SET collector_id=NULL,lifecycle_state='unbound' WHERE collector_id=$1",
		"UPDATE operations SET status='failed',error='collector removed',updated_at=now() WHERE collector_id=$1 AND status IN('pending','preparing','committing')",
		"DELETE FROM ota_jobs WHERE collector_id=$1", "DELETE FROM commands WHERE collector_id=$1", "DELETE FROM events WHERE collector_id=$1", "DELETE FROM receipts WHERE collector_id=$1", "DELETE FROM rejected_messages WHERE collector_id=$1", "DELETE FROM collector_candidates WHERE id=$1", "DELETE FROM collectors WHERE id=$1",
	}
	for _, q := range statements {
		if _, e = tx.Exec(ctx, q, id); e != nil {
			return e
		}
	}
	_, e = tx.Exec(ctx, "UPDATE system_state SET revision=revision+1")
	return e
}
func (s *Store) Claim(ctx context.Context, id, nonce, name, location string) (string, error) {
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	var valid bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM collector_candidates WHERE id=$1 AND enrollment_nonce=$2 AND protocol_version>=2 AND last_seen>now()-interval '90 seconds' AND status->'online'='true'::jsonb)", id, nonce).Scan(&valid)
	if e != nil {
		return "", e
	}
	if !valid {
		return "", fmt.Errorf("candidate unavailable or handshake changed")
	}
	var existing string
	e = tx.QueryRow(ctx, "SELECT id::text FROM operations WHERE type='claim' AND collector_id=$1 AND request->>'enrollment_nonce'=$2 AND status='pending'", id, nonce).Scan(&existing)
	if e == nil {
		return existing, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return "", e
	}
	_, e = tx.Exec(ctx, `INSERT INTO collectors(id,name,location,status,last_seen,enrollment_nonce,protocol_version,lifecycle_state) SELECT id,$3,$4,status,last_seen,enrollment_nonce,2,'binding' FROM collector_candidates WHERE id=$1 AND enrollment_nonce=$2 ON CONFLICT(id) DO UPDATE SET name=$3,location=$4,status=EXCLUDED.status,last_seen=EXCLUDED.last_seen,enrollment_nonce=$2,binding_id=gen_random_uuid(),protocol_version=2,lifecycle_state='binding',config_version=collectors.config_version+1`, id, nonce, name, location)
	if e != nil {
		return "", e
	}
	_, e = tx.Exec(ctx, "UPDATE devices SET collector_id=NULL,lifecycle_state='unbound' WHERE collector_id=$1", id)
	if e != nil {
		return "", e
	}
	e = tx.QueryRow(ctx, "INSERT INTO operations(type,collector_id,request) VALUES('claim',$1,jsonb_build_object('enrollment_nonce',$2::text)) RETURNING id::text", id, nonce).Scan(&existing)
	if e != nil {
		return "", e
	}
	_, e = tx.Exec(ctx, "DELETE FROM collector_candidates WHERE id=$1", id)
	if e != nil {
		return "", e
	}
	_, e = tx.Exec(ctx, "DELETE FROM collector_tombstones WHERE id=$1", id)
	if e != nil {
		return "", e
	}
	_, e = tx.Exec(ctx, "UPDATE system_state SET revision=revision+1")
	if e != nil {
		return "", e
	}
	return existing, tx.Commit(ctx)
}
