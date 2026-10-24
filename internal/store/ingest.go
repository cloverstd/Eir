package store

import (
	"context"
	"crypto/sha256"
	"eir/internal/afu"
	"eir/internal/omron"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"regexp"
	"strings"
	"time"
)

var UUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var CollectorPattern = regexp.MustCompile(`^[a-zA-Z0-9:_-]{1,100}$`)

type Envelope struct {
	Version              int    `json:"version"`
	InstanceID           string `json:"instance_id"`
	BindingID            string `json:"binding_id"`
	DataEpoch            string `json:"data_epoch"`
	MessageID            string `json:"message_id"`
	CollectorID          string `json:"collector_id"`
	DeviceID             string `json:"device_id"`
	Profile              string `json:"profile"`
	UserSlot             int    `json:"user_slot"`
	RawHex               string `json:"raw_hex"`
	MeasurementSessionID string `json:"measurement_session_id"`
	CapturedAt           string `json:"captured_at"`
	ImpedanceRawHex      string `json:"impedance_raw_hex"`
}
type Ack struct {
	Version       int     `json:"version"`
	InstanceID    string  `json:"instance_id,omitempty"`
	BindingID     string  `json:"binding_id,omitempty"`
	DataEpoch     string  `json:"data_epoch,omitempty"`
	ErrorCode     string  `json:"error_code,omitempty"`
	MessageID     string  `json:"message_id"`
	Status        string  `json:"status"`
	Error         string  `json:"error,omitempty"`
	MeasurementID *string `json:"measurement_id,omitempty"`
}

func (s *Store) Ingest(ctx context.Context, collector string, payload []byte) (Ack, error) {
	var in Envelope
	decodeErr := json.Unmarshal(payload, &in)
	hash := fmt.Sprintf("%x", sha256.Sum256(payload))
	ack := Ack{Version: in.Version, MessageID: in.MessageID, Status: "rejected", InstanceID: in.InstanceID, BindingID: in.BindingID, DataEpoch: in.DataEpoch}
	if ack.Version != 2 {
		ack.Version = 1
	}
	if !CollectorPattern.MatchString(collector) {
		return ack, errors.New("invalid collector topic")
	}
	tx, e := s.DB.Begin(ctx)
	if e != nil {
		return ack, e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock_shared(73473742)"); e != nil {
		return ack, e
	}
	var expectedBinding, instance, epoch, state string
	var proto int
	e = tx.QueryRow(ctx, "SELECT c.binding_id::text,c.lifecycle_state,c.protocol_version,s.instance_id::text,s.data_epoch::text FROM collectors c CROSS JOIN system_state s WHERE c.id=$1 FOR SHARE OF c", collector).Scan(&expectedBinding, &state, &proto, &instance, &epoch)
	if errors.Is(e, pgx.ErrNoRows) {
		ack.Error = "collector is not bound"
		ack.ErrorCode = "stale_binding"
		return ack, tx.Commit(ctx)
	}
	if e != nil {
		return ack, e
	}
	validScope := in.Version == 2 && in.InstanceID == instance && in.BindingID == expectedBinding && in.DataEpoch == epoch
	legacy := (in.Version == 1 || decodeErr != nil) && proto == 1
	if (state != "bound" && state != "unbinding" && state != "resetting") || (!validScope && !legacy) {
		ack.Error = "retired association or data epoch"
		ack.ErrorCode = "stale_generation"
		return ack, tx.Commit(ctx)
	}

	if in.MessageID == "" || len(in.MessageID) > 128 {
		in.MessageID = "invalid-" + hash
		ack.MessageID = in.MessageID
		decodeErr = errors.New("missing or oversized message_id")
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "receipt/"+collector+"/"+in.MessageID); e != nil {
		return ack, e
	}
	var previousHash, status, reason string
	var measurementID *string
	e = tx.QueryRow(ctx, "SELECT payload_hash,status,error,measurement_id::text FROM receipts WHERE collector_id=$1 AND message_id=$2 AND binding_id=$3 AND data_epoch=$4", collector, in.MessageID, in.BindingID, in.DataEpoch).Scan(&previousHash, &status, &reason, &measurementID)
	if e == nil {
		if previousHash == hash {
			ack.Status = status
			ack.Error = reason
			ack.MeasurementID = measurementID
			return ack, tx.Commit(ctx)
		}
		ack.Error = "message_id reused with different content"
		_, e = tx.Exec(ctx, "INSERT INTO rejected_messages(collector_id,message_id,payload,reason) VALUES($1,$2,$3,$4)", collector, in.MessageID, payload, ack.Error)
		if e != nil {
			return ack, e
		}
		return ack, tx.Commit(ctx)
	}
	if !errors.Is(e, pgx.ErrNoRows) {
		return ack, e
	}
	reject := func(reason string) (Ack, error) {
		ack.Error = reason
		if _, e = tx.Exec(ctx, "INSERT INTO rejected_messages(collector_id,message_id,payload,reason) VALUES($1,$2,$3,$4)", collector, in.MessageID, payload, reason); e != nil {
			return ack, e
		}
		if _, e = tx.Exec(ctx, "INSERT INTO receipts(collector_id,message_id,payload_hash,status,error,binding_id,data_epoch) VALUES($1,$2,$3,'rejected',$4,$5,$6)", collector, in.MessageID, hash, reason, in.BindingID, in.DataEpoch); e != nil {
			return ack, e
		}
		return ack, tx.Commit(ctx)
	}
	if decodeErr != nil {
		return reject("invalid JSON envelope or message_id")
	}
	if (in.Version != 1 && in.Version != 2) || in.CollectorID != collector || !UUIDPattern.MatchString(in.DeviceID) || (in.Profile != omron.Profile && in.Profile != afu.Profile) || (in.Profile == omron.Profile && in.UserSlot != 1 && in.UserSlot != 2) || (in.Profile == afu.Profile && (in.UserSlot != 0 || in.Version != 2)) {
		return reject("unsupported envelope, profile, device ID, collector or user slot")
	}
	in.DeviceID = strings.ToLower(in.DeviceID)
	var owner *string
	var profile, zone, deviceState string
	e = tx.QueryRow(ctx, "SELECT collector_id,profile,timezone,lifecycle_state FROM devices WHERE id=$1", in.DeviceID).Scan(&owner, &profile, &zone, &deviceState)
	if errors.Is(e, pgx.ErrNoRows) {
		return reject("unknown device")
	}
	if e != nil {
		return ack, e
	}
	if owner == nil || *owner != collector || profile != in.Profile {
		return reject("device is not assigned to this collector/profile")
	}
	if deviceState != "active" && deviceState != "unbinding" {
		ack.Error = "device not enabled"
		ack.ErrorCode = "device_inactive"
		return ack, tx.Commit(ctx)
	}
	if in.Profile == afu.Profile {
		return s.ingestBody(ctx, tx, collector, in, hash, ack, reject)
	}
	raw, decodeRawErr := hex.DecodeString(in.RawHex)
	if decodeRawErr == nil {
		var baseline bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM device_baselines WHERE device_id=$1 AND user_slot=$2 AND record_hash=$3)", in.DeviceID, in.UserSlot, fmt.Sprintf("%x", sha256.Sum256(raw))).Scan(&baseline)
		if e != nil {
			return ack, e
		}
		if baseline {
			ack.Error = "record precedes activation baseline"
			ack.ErrorCode = "baseline_record"
			return ack, tx.Commit(ctx)
		}
	}
	loc, e := time.LoadLocation(zone)
	if e != nil {
		return reject("invalid device timezone")
	}
	record, e := omron.Parse(in.RawHex, loc)
	if e != nil {
		return reject(e.Error())
	}
	// Serialize binding changes and delayed ingestion for this device slot.
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", fmt.Sprintf("binding/%s/%d", in.DeviceID, in.UserSlot)); e != nil {
		return ack, e
	}
	var member *string
	if record.Time != nil {
		e = tx.QueryRow(ctx, "SELECT member_id::text FROM bindings WHERE device_id=$1 AND user_slot=$2 AND effective_from<=$3 AND (effective_to IS NULL OR effective_to>$3)", in.DeviceID, in.UserSlot, record.Time).Scan(&member)
		if e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return ack, e
		}
	}
	fingerprint := omron.Fingerprint(in.DeviceID, in.UserSlot, record)
	e = tx.QueryRow(ctx, `INSERT INTO measurements(fingerprint,device_id,collector_id,user_slot,record_sequence,device_time,measured_at,timezone,member_id,raw_data,parser_version,raw_flags,source_collector_id,source_device_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$3,(SELECT name FROM devices WHERE id=$2)) ON CONFLICT(fingerprint) DO NOTHING RETURNING id::text`, fingerprint, in.DeviceID, collector, in.UserSlot, record.Sequence, record.DeviceTime, record.Time, zone, member, record.Raw, omron.ParserVersion, int64(record.Flags)).Scan(&measurementID)
	fresh := e == nil
	if errors.Is(e, pgx.ErrNoRows) {
		e = tx.QueryRow(ctx, "SELECT id::text FROM measurements WHERE fingerprint=$1", fingerprint).Scan(&measurementID)
	}
	if e != nil {
		return ack, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO blood_pressure(measurement_id,systolic,diastolic,pulse) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", measurementID, record.Systolic, record.Diastolic, record.Pulse); e != nil {
		return ack, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO receipts(collector_id,message_id,payload_hash,status,measurement_id,binding_id,data_epoch) VALUES($1,$2,$3,'stored',$4,$5,$6)", collector, in.MessageID, hash, measurementID, in.BindingID, in.DataEpoch); e != nil {
		return ack, e
	}
	if fresh && s.PushEnabled {
		if e = enqueuePush(ctx, tx, *measurementID); e != nil {
			return ack, e
		}
	}
	ack.Status = "stored"
	ack.MeasurementID = measurementID
	return ack, tx.Commit(ctx)
}
