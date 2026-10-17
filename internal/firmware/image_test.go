package firmware

import (
	"crypto/sha256"
	"encoding/binary"
	"os"
	"testing"
)

func validImage() []byte {
	data := make([]byte, 24+8+256)
	data[0] = 0xe9
	data[1] = 1
	data[12] = 5
	data[23] = 1
	binary.LittleEndian.PutUint32(data[28:32], 256)
	binary.LittleEndian.PutUint32(data[32:36], 0xabcd5432)
	copy(data[48:], "0.1.0")
	copy(data[160:], Marker)
	checksum := byte(0xef)
	for _, b := range data[32:] {
		checksum ^= b
	}
	end := (len(data) + 16) &^ 15
	data = append(data, make([]byte, end-len(data))...)
	data[end-1] = checksum
	sum := sha256.Sum256(data)
	return append(data, sum[:]...)
}
func TestValidateImage(t *testing.T) {
	v, e := Validate(validImage())
	if e != nil || v != "0.1.0" {
		t.Fatalf("%s %v", v, e)
	}
}
func TestRejectImages(t *testing.T) {
	for _, change := range []func([]byte) []byte{func(b []byte) []byte { b[12] = 0; return b }, func(b []byte) []byte { b[80] ^= 1; return b }, func(b []byte) []byte { return b[:len(b)-1] }, func(b []byte) []byte { b[160] = 0; return b }, func(b []byte) []byte { return append(b, 1) }, func(b []byte) []byte { b[1] = 255; return b }} {
		if _, e := Validate(change(validImage())); e == nil {
			t.Fatal("accepted invalid image")
		}
	}
}

func TestBuiltFirmware(t *testing.T) {
	path := os.Getenv("EIR_FIRMWARE_PATH")
	if path == "" {
		t.Skip("set EIR_FIRMWARE_PATH to validate an ESP-IDF build")
	}
	data, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	version, e := Validate(data)
	if e != nil {
		t.Fatal(e)
	}
	t.Logf("accepted firmware version=%s size=%d", version, len(data))
}
