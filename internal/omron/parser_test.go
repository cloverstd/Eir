package omron

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func TestSyntheticRecords(t *testing.T) {
	var fixtures []struct {
		Raw                                  string
		Systolic, Diastolic, Pulse, Sequence int
		DeviceTime                           string `json:"device_time"`
	}
	b, e := os.ReadFile("testdata/synthetic_records.json")
	if e != nil {
		t.Fatal(e)
	}
	if e = json.Unmarshal(b, &fixtures); e != nil {
		t.Fatal(e)
	}
	if len(fixtures) != 4 {
		t.Fatal("missing synthetic regression records")
	}
	zone, _ := time.LoadLocation("Asia/Shanghai")
	for _, f := range fixtures {
		r, e := Parse(f.Raw, zone)
		if e != nil {
			t.Fatal(e)
		}
		if r.Systolic != f.Systolic || r.Diastolic != f.Diastolic || r.Pulse != f.Pulse || r.Sequence != f.Sequence || r.DeviceTime != f.DeviceTime || r.Time == nil {
			t.Errorf("decode mismatch: %+v reference %+v", r, f)
		}
	}
}
func TestSyntheticPackedFields(t *testing.T) {
	// Synthetic packed fields exercise independent date/time decoding.
	b := make([]byte, 16)
	b[0] = 111 - 25
	b[1] = 69
	b[2] = 90
	b[3] = 26
	binary.LittleEndian.PutUint16(b[4:6], 16|17<<5|10<<10)
	binary.LittleEndian.PutUint16(b[6:8], 55|30<<6)
	binary.LittleEndian.PutUint16(b[10:12], 12)
	zone, _ := time.LoadLocation("Asia/Shanghai")
	r, e := Parse(hex.EncodeToString(b), zone)
	if e != nil || r.Systolic != 111 || r.Diastolic != 69 || r.Pulse != 90 || r.DeviceTime != "2026-10-17 16:30:55" {
		t.Fatalf("%+v %v", r, e)
	}
}
func TestInvalidTimePreserved(t *testing.T) {
	r, e := Parse("5849501a000000000000010000000000", time.UTC)
	if e != nil || r.Time != nil || r.DeviceTime != "2026-00-00 00:00:00" {
		t.Fatalf("%+v %v", r, e)
	}
}
func TestMalformedAndEmpty(t *testing.T) {
	for _, raw := range []string{"", "zz", "00", "ffffffffffffffffffffffffffffffff", "00000000000000000000000000000000"} {
		if _, e := Parse(raw, time.UTC); e == nil {
			t.Errorf("accepted %s", raw)
		}
	}
}
func TestFingerprint(t *testing.T) {
	a, _ := Parse("5849501a000000000000010000000000", time.UTC)
	b, _ := Parse("5949501a000000000000010000000000", time.UTC)
	if Fingerprint("device", 1, a) == Fingerprint("device", 1, b) {
		t.Fatal("sequence reused with new record must not deduplicate")
	}
	if Fingerprint("device", 1, a) == Fingerprint("device", 2, a) || Fingerprint("device", 1, a) == Fingerprint("other", 1, a) {
		t.Fatal("fingerprint must scope device and user")
	}
}
