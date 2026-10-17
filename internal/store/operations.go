package store

import (
	"context"
	"eir/internal/afu"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"regexp"
	"time"
)

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Store) StartOperation(ctx context.Context, kind, collector, device, scope, id string) (string, error) {
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(73473742)"); e != nil {
		return "", e
	}
	if id != "" {
		var found string
		e = tx.QueryRow(ctx, "SELECT id::text FROM operations WHERE id=$1", id).Scan(&found)
		if e == nil {
			return found, tx.Commit(ctx)
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return "", e
		}
	}
	if id != "" {
		var valid bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operation_previews p CROSS JOIN system_state s WHERE p.token=$1 AND p.expires_at>now() AND p.data_epoch=s.data_epoch AND p.revision=s.revision)", id).Scan(&valid)
		if e != nil {
			return "", e
		}
		if !valid {
			return "", errors.New("preview expired or state changed")
		}
	}
	var instance, epoch string
	e = tx.QueryRow(ctx, "SELECT instance_id::text,data_epoch::text FROM system_state").Scan(&instance, &epoch)
	if e != nil {
		return "", e
	}
	ids := []string{}
	if kind == "system_reset" {
		rows, e := tx.Query(ctx, "SELECT id FROM collectors")
		if e != nil {
			return "", e
		}
		for rows.Next() {
			var x string
			rows.Scan(&x)
			ids = append(ids, x)
		}
		rows.Close()
	} else {
		ids = []string{collector}
	}
	bindings := map[string]string{}
	for _, c := range ids {
		var binding string
		var usable bool
		e = tx.QueryRow(ctx, "SELECT binding_id::text,protocol_version>=2 AND lifecycle_state='bound' AND last_seen>now()-interval '90 seconds' AND status->'online'='true'::jsonb FROM collectors WHERE id=$1 FOR UPDATE", c).Scan(&binding, &usable)
		if e != nil {
			return "", e
		}
		if !usable {
			return "", fmt.Errorf("collector %s must be online, bound and upgraded", c)
		}
		var busy bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operation_targets t JOIN operations o ON o.id=t.operation_id WHERE t.collector_id=$1 AND (o.status IN('pending','preparing','committing') OR t.status='abort_pending')) OR EXISTS(SELECT 1 FROM ota_jobs WHERE collector_id=$1 AND status IN('pending','downloading','rebooting'))", c).Scan(&busy)
		if e != nil {
			return "", e
		}
		if busy {
			return "", fmt.Errorf("collector %s is busy", c)
		}
		bindings[c] = binding
	}
	if device != "" {
		if _, e = tx.Exec(ctx, "DELETE FROM signal_latest WHERE link_key=$1", device); e != nil {
			return "", e
		}
		var oldOwner *string
		var state string
		e = tx.QueryRow(ctx, "SELECT collector_id,lifecycle_state FROM devices WHERE id=$1 FOR UPDATE", device).Scan(&oldOwner, &state)
		if e != nil {
			return "", e
		}
		if kind == "device_bind" {
			var profile string
			if e = tx.QueryRow(ctx, "SELECT profile FROM devices WHERE id=$1", device).Scan(&profile); e != nil {
				return "", e
			}
			if profile == afu.Profile {
				if e = CheckScaleCapacity(ctx, tx, collector, device); e != nil {
					return "", e
				}
			}
		}
		if kind == "device_bind" {
			if oldOwner != nil && *oldOwner != collector {
				return "", errors.New("unbind old collector first")
			}
			if state == "active" {
				return "", errors.New("device already active; unbind before rebinding")
			}
			if _, e = tx.Exec(ctx, "UPDATE devices SET collector_id=$2,lifecycle_state='pending_baseline' WHERE id=$1", device, collector); e != nil {
				return "", e
			}
		} else if oldOwner == nil || *oldOwner != collector {
			return "", errors.New("device is not assigned to collector")
		}
	}
	phase := "execute"
	status := "pending"
	commandType := kind
	if kind == "device_bind" || kind == "system_reset" {
		phase = "prepare"
		status = "preparing"
	}
	if kind == "system_reset" {
		commandType = "prepare_data_reset"
	}
	if id == "" {
		e = tx.QueryRow(ctx, "SELECT gen_random_uuid()::text").Scan(&id)
		if e != nil {
			return "", e
		}
	}
	var deviceArg any
	if device != "" {
		deviceArg = device
	}
	_, e = tx.Exec(ctx, "INSERT INTO operations(id,type,scope,collector_id,device_id,status,phase) VALUES($1,$2,$3,nullif($4,''),$5,$6,$7)", id, kind, scope, collector, deviceArg, status, phase)
	if e != nil {
		return "", e
	}
	for _, c := range ids {
		payload := map[string]any{"id": id, "type": commandType, "phase": phase, "instance_id": instance, "binding_id": bindings[c], "data_epoch": epoch}
		if device != "" {
			payload["device_id"] = device
		}
		if kind == "system_reset" {
			rows, e := tx.Query(ctx, "SELECT id::text FROM devices WHERE collector_id=$1", c)
			if e != nil {
				return "", e
			}
			ds := []string{}
			for rows.Next() {
				var d string
				rows.Scan(&d)
				ds = append(ds, d)
			}
			rows.Close()
			payload["devices"] = ds
		}
		data, _ := json.Marshal(payload)
		if _, e = tx.Exec(ctx, "INSERT INTO operation_targets(operation_id,collector_id,binding_id,data_epoch,payload) VALUES($1,$2,$3,$4,$5)", id, c, bindings[c], epoch, data); e != nil {
			return "", e
		}
		state := "resetting"
		if kind == "collector_unbind" {
			state = "unbinding"
		}
		if kind == "device_bind" || kind == "device_unbind" {
			state = "bound"
		}
		if _, e = tx.Exec(ctx, "UPDATE collectors SET lifecycle_state=$2,config_version=config_version+1 WHERE id=$1", c, state); e != nil {
			return "", e
		}
	}
	if kind == "device_unbind" {
		if _, e = tx.Exec(ctx, "UPDATE devices SET lifecycle_state='unbinding' WHERE id=$1", device); e != nil {
			return "", e
		}
	}
	if kind == "system_reset" && len(ids) == 0 {
		if e = clearHealth(ctx, tx, id); e != nil {
			return "", e
		}
		if _, e = tx.Exec(ctx, "UPDATE system_state SET data_epoch=gen_random_uuid(),revision=revision+1"); e != nil {
			return "", e
		}
		if _, e = tx.Exec(ctx, "UPDATE operations SET status='succeeded' WHERE id=$1", id); e != nil {
			return "", e
		}
	}
	return id, tx.Commit(ctx)
}
func clearHealth(ctx context.Context, tx pgx.Tx, op string) error {
	for _, q := range []string{"DELETE FROM manual_observations", "DELETE FROM measurement_audit", "DELETE FROM blood_pressure", "DELETE FROM body_composition", "DELETE FROM receipts", "DELETE FROM rejected_messages", "DELETE FROM measurements", "DELETE FROM events", "UPDATE collectors SET status=status-'last_measurement'-'error'-'last_command'"} {
		if _, e := tx.Exec(ctx, q); e != nil {
			return e
		}
	}
	_, e := tx.Exec(ctx, "DELETE FROM baseline_chunks WHERE operation_id<>$1", op)
	return e
}
func (s *Store) FullReset(ctx context.Context, id string) (string, error) {
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return "", e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(73473742)"); e != nil {
		return "", e
	}
	var exists bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations WHERE id=$1)", id).Scan(&exists)
	if e != nil {
		return "", e
	}
	if exists {
		return id, tx.Commit(ctx)
	}
	var valid bool
	e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operation_previews p CROSS JOIN system_state s WHERE p.token=$1 AND p.expires_at>now() AND p.data_epoch=s.data_epoch AND p.revision=s.revision)", id).Scan(&valid)
	if e != nil {
		return "", e
	}
	if !valid {
		return "", errors.New("preview expired or state changed")
	}
	if _, e = tx.Exec(ctx, "INSERT INTO operations(id,type,scope,status) VALUES($1,'system_reset','all','committing')", id); e != nil {
		return "", e
	}
	if e = clearHealth(ctx, tx, id); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO collector_tombstones(id,binding_id,enrollment_nonce,config_version) SELECT id,binding_id,enrollment_nonce,config_version FROM collectors ON CONFLICT(id) DO UPDATE SET binding_id=EXCLUDED.binding_id,enrollment_nonce=EXCLUDED.enrollment_nonce,config_version=greatest(collector_tombstones.config_version,EXCLUDED.config_version),deleted_at=now()"); e != nil {
		return "", e
	}
	for _, q := range []string{"INSERT INTO document_garbage(id) SELECT id FROM medical_documents ON CONFLICT DO NOTHING", "DELETE FROM medical_documents", "DELETE FROM health_history", "DELETE FROM ota_jobs", "DELETE FROM commands", "DELETE FROM device_baselines", "DELETE FROM bindings", "DELETE FROM devices", "DELETE FROM collectors", "DELETE FROM collector_candidates", "DELETE FROM members", "UPDATE system_state SET data_epoch=gen_random_uuid(),revision=revision+1"} {
		if _, e = tx.Exec(ctx, q); e != nil {
			return "", e
		}
	}
	if _, e = tx.Exec(ctx, "DELETE FROM operations WHERE id<>$1", id); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "DELETE FROM operation_previews WHERE token<>$1", id); e != nil {
		return "", e
	}
	if _, e = tx.Exec(ctx, "UPDATE operations SET status='succeeded',updated_at=now(),result='{\"server_reset\":true,\"offline_device_erasure_confirmed\":false}' WHERE id=$1", id); e != nil {
		return "", e
	}
	return id, tx.Commit(ctx)
}

// HandleLifecycleEvent validates association before persisting any event body.
func (s *Store) HandleLifecycleEvent(ctx context.Context, collector string, data []byte) (map[string]any, error) {
	var ev struct {
		CommandID  string          `json:"command_id"`
		Type       string          `json:"type"`
		Status     string          `json:"status"`
		InstanceID string          `json:"instance_id"`
		BindingID  string          `json:"binding_id"`
		DataEpoch  string          `json:"data_epoch"`
		Error      string          `json:"error"`
		Data       json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &ev) != nil || !UUIDPattern.MatchString(ev.CommandID) {
		return nil, nil
	}
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(73473742)"); e != nil {
		return nil, e
	}
	var kind, phase, opStatus, binding, epoch string
	var device *string
	var payload []byte
	e = tx.QueryRow(ctx, `SELECT o.type,o.phase,o.status,o.device_id::text,t.binding_id::text,t.data_epoch::text,t.payload FROM operations o JOIN operation_targets t ON t.operation_id=o.id WHERE o.id=$1 AND t.collector_id=$2 FOR UPDATE OF o,t`, ev.CommandID, collector).Scan(&kind, &phase, &opStatus, &device, &binding, &epoch, &payload)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var current map[string]any
	json.Unmarshal(payload, &current)
	var instance string
	tx.QueryRow(ctx, "SELECT instance_id::text FROM system_state").Scan(&instance)
	if ev.InstanceID != instance || ev.BindingID != binding || (ev.DataEpoch != epoch && ev.DataEpoch != current["next_data_epoch"]) {
		return nil, nil
	}
	if current["phase"] == "abort" {
		if ev.Status == "succeeded" || ev.Status == "aborted" {
			_, e = tx.Exec(ctx, "UPDATE operation_targets SET status='aborted',updated_at=now() WHERE operation_id=$1 AND collector_id=$2", ev.CommandID, collector)
		}
		return nil, tx.Commit(ctx)
	}
	if opStatus == "succeeded" || opStatus == "failed" {
		return nil, nil
	}
	if ev.Type == "baseline_chunk" {
		var chunk struct {
			DeviceID string `json:"device_id"`
			Index    int    `json:"chunk_index"`
			Total    int    `json:"total_chunks"`
			Records  []struct {
				Slot int    `json:"user_slot"`
				Hash string `json:"hash"`
			} `json:"records"`
		}
		if phase != "prepare" || json.Unmarshal(ev.Data, &chunk) != nil || !UUIDPattern.MatchString(chunk.DeviceID) || chunk.Total < 1 || chunk.Total > 16 || chunk.Index < 0 || chunk.Index >= chunk.Total || chunk.Records == nil || len(chunk.Records) > 32 {
			return nil, nil
		}
		var owner bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM devices WHERE id=$1 AND collector_id=$2)", chunk.DeviceID, collector).Scan(&owner)
		if e != nil {
			return nil, e
		}
		if !owner || (device != nil && *device != chunk.DeviceID) {
			return nil, nil
		}
		for _, r := range chunk.Records {
			if (r.Slot != 1 && r.Slot != 2) || !hashPattern.MatchString(r.Hash) {
				return nil, nil
			}
		}
		records, _ := json.Marshal(chunk.Records)
		_, e = tx.Exec(ctx, "INSERT INTO baseline_chunks(operation_id,collector_id,device_id,chunk_index,total_chunks,records) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", ev.CommandID, collector, chunk.DeviceID, chunk.Index, chunk.Total, records)
		if e != nil {
			return nil, e
		}
		if e = tx.Commit(ctx); e != nil {
			return nil, e
		}
		return map[string]any{"kind": "baseline", "command_id": ev.CommandID, "device_id": chunk.DeviceID, "chunk_index": chunk.Index, "status": "stored", "instance_id": instance, "binding_id": binding, "data_epoch": epoch}, nil
	}
	if ev.Status == "prepared" && phase == "prepare" {
		// Every assigned target must have all chunks, including an empty chunk for an empty cuff.
		rows, e := tx.Query(ctx, "SELECT id::text FROM devices WHERE collector_id=$1 AND ($2::uuid IS NULL OR id=$2)", collector, device)
		if e != nil {
			return nil, e
		}
		ds := []string{}
		for rows.Next() {
			var d string
			rows.Scan(&d)
			ds = append(ds, d)
		}
		rows.Close()
		for _, d := range ds {
			var complete bool
			e = tx.QueryRow(ctx, "SELECT coalesce(count(*)=max(total_chunks) AND min(chunk_index)=0 AND max(chunk_index)=max(total_chunks)-1 AND min(total_chunks)=max(total_chunks),false) FROM baseline_chunks WHERE operation_id=$1 AND collector_id=$2 AND device_id=$3", ev.CommandID, collector, d).Scan(&complete)
			if e != nil {
				return nil, e
			}
			if !complete {
				return nil, errors.New("baseline chunks incomplete")
			}
		}
		if _, e = tx.Exec(ctx, "UPDATE operation_targets SET status='prepared',updated_at=now() WHERE operation_id=$1 AND collector_id=$2", ev.CommandID, collector); e != nil {
			return nil, e
		}
		var all bool
		e = tx.QueryRow(ctx, "SELECT bool_and(status='prepared') FROM operation_targets WHERE operation_id=$1", ev.CommandID).Scan(&all)
		if e != nil {
			return nil, e
		}
		if all {
			if _, e = tx.Exec(ctx, "DELETE FROM device_baselines WHERE device_id IN(SELECT DISTINCT device_id FROM baseline_chunks WHERE operation_id=$1)", ev.CommandID); e != nil {
				return nil, e
			}
			_, e = tx.Exec(ctx, `INSERT INTO device_baselines(device_id,user_slot,record_hash) SELECT c.device_id,(r->>'user_slot')::integer,r->>'hash' FROM baseline_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.records) r WHERE operation_id=$1 ON CONFLICT DO NOTHING`, ev.CommandID)
			if e != nil {
				return nil, e
			}
			newEpoch := epoch
			if kind == "system_reset" {
				if e = clearHealth(ctx, tx, ev.CommandID); e != nil {
					return nil, e
				}
				if e = tx.QueryRow(ctx, "UPDATE system_state SET data_epoch=gen_random_uuid(),revision=revision+1 RETURNING data_epoch::text").Scan(&newEpoch); e != nil {
					return nil, e
				}
			}
			commandType := "device_bind"
			if kind == "system_reset" {
				commandType = "commit_data_reset"
			}
			_, e = tx.Exec(ctx, "UPDATE operation_targets SET status='pending',payload=payload||jsonb_build_object('phase','commit','type',$2::text,'next_data_epoch',$3::text),updated_at=now() WHERE operation_id=$1", ev.CommandID, commandType, newEpoch)
			if e != nil {
				return nil, e
			}
			_, e = tx.Exec(ctx, "UPDATE operations SET phase='commit',status='committing',updated_at=now() WHERE id=$1", ev.CommandID)
			if e != nil {
				return nil, e
			}
		}
	} else if ev.Status == "failed" {
		if phase == "commit" {
			_, e = tx.Exec(ctx, "UPDATE operations SET error=$2,updated_at=now() WHERE id=$1", ev.CommandID, ev.Error)
			if e != nil {
				return nil, e
			}
			return nil, tx.Commit(ctx)
		}
		if _, e = tx.Exec(ctx, "UPDATE operations SET status='failed',error=$2,updated_at=now() WHERE id=$1", ev.CommandID, ev.Error); e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, "UPDATE operation_targets SET status='abort_pending',payload=payload||'{\"phase\":\"abort\",\"type\":\"abort_data_reset\"}'::jsonb WHERE operation_id=$1", ev.CommandID)
		if e != nil {
			return nil, e
		}
		if _, e = tx.Exec(ctx, "UPDATE collectors SET lifecycle_state='bound' WHERE id IN(SELECT collector_id FROM operation_targets WHERE operation_id=$1)", ev.CommandID); e != nil {
			return nil, e
		}
	} else if ev.Status == "awaiting_provisioning" && kind == "factory_reset" {
		if e = removeCollector(ctx, tx, collector); e != nil {
			return nil, e
		}
		_, e = tx.Exec(ctx, "UPDATE operations SET status='awaiting_provisioning',error='',updated_at=now() WHERE id=$1", ev.CommandID)
		if e != nil {
			return nil, e
		}
	} else if ev.Status == "succeeded" {
		if phase == "prepare" {
			return nil, nil
		}
		if _, e = tx.Exec(ctx, "UPDATE operation_targets SET status='succeeded',updated_at=now() WHERE operation_id=$1 AND collector_id=$2", ev.CommandID, collector); e != nil {
			return nil, e
		}
		switch kind {
		case "device_bind":
			if _, e = tx.Exec(ctx, "UPDATE devices SET lifecycle_state='active' WHERE id=$1", device); e != nil {
				return nil, e
			}
		case "device_unbind":
			if _, e = tx.Exec(ctx, "UPDATE devices SET collector_id=NULL,lifecycle_state='unbound' WHERE id=$1", device); e != nil {
				return nil, e
			}
		case "collector_unbind", "collector_reset":
			if e = removeCollector(ctx, tx, collector); e != nil {
				return nil, e
			}
		}
		var all bool
		e = tx.QueryRow(ctx, "SELECT bool_and(status='succeeded') FROM operation_targets WHERE operation_id=$1", ev.CommandID).Scan(&all)
		if e != nil {
			return nil, e
		}
		if all {
			_, e = tx.Exec(ctx, "UPDATE operations SET status='succeeded',error='',updated_at=now() WHERE id=$1", ev.CommandID)
			if e != nil {
				return nil, e
			}
			_, e = tx.Exec(ctx, "UPDATE collectors SET lifecycle_state='bound',config_version=config_version+1 WHERE id IN(SELECT collector_id FROM operation_targets WHERE operation_id=$1)", ev.CommandID)
			if e != nil {
				return nil, e
			}
		}
	}
	return nil, tx.Commit(ctx)
}
func (s *Store) PendingLifecycle(ctx context.Context) ([]struct {
	Collector string
	Payload   map[string]any
}, error) {
	rows, e := s.DB.Query(ctx, "SELECT t.collector_id,t.payload FROM operation_targets t JOIN operations o ON o.id=t.operation_id WHERE (o.status IN('pending','preparing','committing') AND t.status IN('pending','prepared','running')) OR t.status='abort_pending'")
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []struct {
		Collector string
		Payload   map[string]any
	}{}
	for rows.Next() {
		var id string
		var raw []byte
		if e = rows.Scan(&id, &raw); e != nil {
			return nil, e
		}
		var p map[string]any
		json.Unmarshal(raw, &p)
		p["expires_at"] = time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339)
		out = append(out, struct {
			Collector string
			Payload   map[string]any
		}{id, p})
	}
	return out, rows.Err()
}
