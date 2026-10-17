// Package omron decodes the exact HEM-7374T1 classic record layout.
// Derived from eigger/hass-omron, MIT; see THIRD_PARTY_NOTICES.md.
package omron

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"time"
)

const Profile = "omron-hem-7374t1"
const ParserVersion = "hem7374-v1"

type Record struct {
	Systolic   int        `json:"systolic"`
	Diastolic  int        `json:"diastolic"`
	Pulse      int        `json:"pulse"`
	Sequence   int        `json:"record_sequence"`
	DeviceTime string     `json:"device_time"`
	Time       *time.Time `json:"measured_at"`
	Flags      uint32     `json:"raw_flags"`
	Raw        []byte     `json:"-"`
}

func Parse(rawHex string, zone *time.Location) (Record, error) {
	var r Record
	raw, e := hex.DecodeString(rawHex)
	if e != nil || len(raw) != 16 {
		return r, errors.New("expected a 16-byte hex record")
	}
	if raw[0] > 0xe1 {
		return r, errors.New("empty record slot")
	}
	f1 := binary.LittleEndian.Uint16(raw[4:6])
	f2 := binary.LittleEndian.Uint16(raw[6:8])
	if raw[1] == 0 && raw[2] == 0 && raw[3]&63 == 0 && f1 == 0 && f2 == 0 {
		return r, errors.New("uninitialized record slot")
	}
	r.Systolic = int(raw[0]) + 25
	r.Diastolic = int(raw[1])
	r.Pulse = int(raw[2])
	r.Sequence = int(binary.LittleEndian.Uint16(raw[10:12]))
	r.Raw = raw
	r.Flags = uint32(f1) | uint32(f2)<<16
	year, month, day := 2000+int(raw[3]&63), int(f1>>10&15), int(f1>>5&31)
	hour, minute, second := int(f1&31), int(f2>>6&63), int(f2&63)
	r.DeviceTime = fmt.Sprintf("%04d-%02d-%02d %02d:%02d:%02d", year, month, day, hour, minute, second)
	// Preserve invalid device time rather than silently normalizing it or using receipt time.
	t, err := time.ParseInLocation("2006-01-02 15:04:05", r.DeviceTime, zone)
	if err == nil {
		r.Time = &t
	}
	return r, nil
}

func Fingerprint(device string, slot int, r Record) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprintf("%s/%d/%d/%x", device, slot, r.Sequence, r.Raw))))
}
