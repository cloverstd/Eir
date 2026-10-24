package store

import (
	"context"
	"crypto/sha256"
	"eir/internal/afu"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"regexp"
	"time"
)

var sessionPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

func (s *Store) ingestBody(ctx context.Context, tx pgx.Tx, collector string, in Envelope, payloadHash string, ack Ack, reject func(string) (Ack, error)) (Ack, error) {
	if !sessionPattern.MatchString(in.MeasurementSessionID) {
		return reject("invalid measurement_session_id")
	}
	weight, e := afu.Parse(in.RawHex, 0xd5)
	if e != nil {
		return reject(e.Error())
	}
	if !weight.Stable {
		return reject("AFU measurement requires stable D5")
	}
	var impedance afu.Packet
	if in.ImpedanceRawHex != "" {
		impedance, e = afu.Parse(in.ImpedanceRawHex, 0xd6)
		if e != nil {
			return reject(e.Error())
		}
		if impedance.WeightGrams != weight.WeightGrams {
			return reject("AFU ADC weight does not match stable weight")
		}
	}
	var at *time.Time
	if in.CapturedAt != "" {
		t, err := time.Parse(time.RFC3339, in.CapturedAt)
		if err != nil || t.Year() < 2020 || t.After(time.Now().Add(5*time.Minute)) {
			return reject("invalid collector captured_at")
		}
		at = &t
	}
	if _, e = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", "binding/"+in.DeviceID+"/0"); e != nil {
		return ack, e
	}
	fingerprint := fmt.Sprintf("%x", sha256.Sum256([]byte("afu/"+in.InstanceID+"/"+in.DataEpoch+"/"+in.DeviceID+"/"+in.MeasurementSessionID)))
	var id string
	var existingRaw []byte
	var existingTime *time.Time
	e = tx.QueryRow(ctx, "SELECT id::text,raw_data,measured_at FROM measurements WHERE fingerprint=$1 FOR UPDATE", fingerprint).Scan(&id, &existingRaw, &existingTime)
	fresh := errors.Is(e, pgx.ErrNoRows)
	if e != nil && !fresh {
		return ack, e
	}
	if !fresh && (string(existingRaw) != string(weight.Raw) || (existingTime == nil) != (at == nil) || (at != nil && !at.Equal(*existingTime))) {
		return reject("AFU session reused with different weight or capture time")
	}
	if fresh {
		var member *string
		if at != nil {
			e = tx.QueryRow(ctx, "SELECT member_id::text FROM bindings WHERE device_id=$1 AND user_slot=0 AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>$2)", in.DeviceID, at).Scan(&member)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return ack, e
			}
		}
		e = tx.QueryRow(ctx, `INSERT INTO measurements(fingerprint,device_id,collector_id,user_slot,kind,record_sequence,device_time,measured_at,timezone,member_id,raw_data,parser_version,raw_flags,source_collector_id,source_device_name,time_source)
  SELECT $1,id,$2,0,'body_composition',NULL,'',$3,timezone,$4,$5,$6,0,$2,name,'collector' FROM devices WHERE id=$7 RETURNING measurements.id::text`, fingerprint, collector, at, member, weight.Raw, afu.ParserVersion, in.DeviceID).Scan(&id)
		if e != nil {
			return ack, e
		}
		_, e = tx.Exec(ctx, `INSERT INTO body_composition(measurement_id,measurement_session_id,weight_grams,adc_index,profile_snapshot)
  SELECT $1,$2,$3,d.adc_index,jsonb_build_object('sex',coalesce(p.sex,''),'height_cm',coalesce(p.height_cm,0),'birth_date',coalesce(p.birth_date::text,''),'birth_month',coalesce(p.birth_month,'')) FROM devices d LEFT JOIN members p ON p.id=$4 WHERE d.id=$5`, id, in.MeasurementSessionID, weight.WeightGrams, member, in.DeviceID)
		if e != nil {
			return ack, e
		}
	}
	if len(impedance.Raw) > 0 {
		var old []byte
		if e = tx.QueryRow(ctx, "SELECT impedance_raw FROM body_composition WHERE measurement_id=$1", id).Scan(&old); e != nil {
			return ack, e
		}
		if len(old) > 0 && string(old) != string(impedance.Raw) {
			return reject("AFU session already has different ADC data")
		}
		adcs, _ := json.Marshal(impedance.ADCs)
		if _, e = tx.Exec(ctx, "UPDATE body_composition SET impedance_raw=$2,raw_adcs=$3 WHERE measurement_id=$1 AND impedance_raw IS NULL", id, impedance.Raw, adcs); e != nil {
			return ack, e
		}
	}
	// Snapshot is taken with the first durable weight; a delayed ADC cannot
	// silently switch the person or calculation settings of that measurement.
	if e = calculateBody(ctx, tx, id, false); e != nil {
		return ack, e
	}
	if _, e = tx.Exec(ctx, "INSERT INTO receipts(collector_id,message_id,payload_hash,status,measurement_id,binding_id,data_epoch) VALUES($1,$2,$3,'stored',$4,$5,$6)", collector, in.MessageID, payloadHash, id, in.BindingID, in.DataEpoch); e != nil {
		return ack, e
	}
	if fresh && s.PushEnabled {
		if e = enqueuePush(ctx, tx, id); e != nil {
			return ack, e
		}
	}
	ack.Status = "stored"
	ack.MeasurementID = &id
	return ack, tx.Commit(ctx)
}

// RecalculateBody is used only for an explicit attribution change. Ordinary
// profile/device-setting edits leave previously calculated measurements intact.
func RecalculateBody(ctx context.Context, tx pgx.Tx, id string) error {
	return calculateBody(ctx, tx, id, true)
}

func calculateBody(ctx context.Context, tx pgx.Tx, id string, refreshProfile bool) error {
	var grams, index int
	var adcsJSON, snapshot []byte
	var at *time.Time
	var member *string
	e := tx.QueryRow(ctx, "SELECT c.weight_grams,c.adc_index,c.raw_adcs,c.profile_snapshot,m.measured_at,m.member_id::text FROM body_composition c JOIN measurements m ON m.id=c.measurement_id WHERE m.id=$1 FOR UPDATE OF m,c", id).Scan(&grams, &index, &adcsJSON, &snapshot, &at, &member)
	if errors.Is(e, pgx.ErrNoRows) {
		return nil
	}
	if e != nil {
		return e
	}
	var p afu.Person
	if refreshProfile {
		if member != nil {
			e = tx.QueryRow(ctx, "SELECT sex,coalesce(height_cm,0)::float8,coalesce(birth_date::text,''),birth_month FROM members WHERE id=$1", member).Scan(&p.Sex, &p.HeightCM, &p.BirthDate, &p.BirthMonth)
			if e != nil {
				return e
			}
		}
	} else {
		if e = json.Unmarshal(snapshot, &p); e != nil {
			return e
		}
	}
	var adcs []int
	if e = json.Unmarshal(adcsJSON, &adcs); e != nil {
		return e
	}
	result := afu.Calculate(grams, adcs, index, p, at)
	snapshot, _ = json.Marshal(map[string]any{"sex": p.Sex, "height_cm": p.HeightCM, "birth_date": p.BirthDate, "birth_month": p.BirthMonth, "age": result.Age, "age_approximate": result.AgeApproximate})
	_, e = tx.Exec(ctx, "UPDATE body_composition SET resistance=$2,bmi=$3,body_fat_pct=$4,body_fat_status=$5,profile_snapshot=$6,algorithm_version=$7 WHERE measurement_id=$1", id, result.Resistance, result.BMI, result.BodyFatPct, result.Status, snapshot, result.AlgorithmVersion)
	return e
}

func RecalculateDeviceBody(ctx context.Context, tx pgx.Tx, device string, from time.Time) error {
	rows, e := tx.Query(ctx, "SELECT id::text FROM measurements WHERE device_id=$1 AND measured_at>=$2 AND kind='body_composition' AND NOT manual_assignment ORDER BY id", device, from)
	if e != nil {
		return e
	}
	var ids []string
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, id := range ids {
		if e = RecalculateBody(ctx, tx, id); e != nil {
			return e
		}
	}
	return nil
}

// CheckScaleCapacity is called under the collector row lock by both creation
// and reassignment so concurrent requests cannot overbook the two scale slots.
func CheckScaleCapacity(ctx context.Context, tx pgx.Tx, collector, exclude string) error {
	var supported bool
	var capacity int
	e := tx.QueryRow(ctx, `SELECT coalesce(status->'capabilities'->'profiles','[]'::jsonb) ? 'afu-wl-tz-a1',
 coalesce((status->'capabilities'->>'max_scales')::integer,0) FROM collectors WHERE id=$1 FOR UPDATE`, collector).Scan(&supported, &capacity)
	if e != nil {
		return e
	}
	if !supported || capacity < 2 {
		return errors.New("请先升级采集端至支持阿福体脂秤的固件")
	}
	var count int
	if e = tx.QueryRow(ctx, "SELECT count(*) FROM devices WHERE collector_id=$1 AND profile=$2 AND id::text<>$3", collector, afu.Profile, exclude).Scan(&count); e != nil {
		return e
	}
	if count >= 2 {
		return errors.New("此采集端最多接入两台体脂秤，请选择其他采集端")
	}
	return nil
}
