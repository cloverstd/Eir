package firmware

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
)

const MaxSize = 0x180000
const Layout = "eir-c3-v1"
const Marker = "EIR_PARTITION_LAYOUT=" + Layout

// Validate validates the ESP image envelope, C3 target, segments, ROM checksum,
// appended SHA256 and our partition ABI marker. ESP-IDF performs boot validation too.
func Validate(image []byte) (string, error) {
	if len(image) < 288 || len(image) > MaxSize {
		return "", fmt.Errorf("firmware size out of range (max %d)", MaxSize)
	}
	if image[0] != 0xe9 || binary.LittleEndian.Uint16(image[12:14]) != 5 {
		return "", fmt.Errorf("not an ESP32-C3 application image")
	}
	segments := int(image[1])
	if segments < 1 || segments > 16 {
		return "", fmt.Errorf("invalid segment count")
	}
	if binary.LittleEndian.Uint32(image[32:36]) != 0xabcd5432 {
		return "", fmt.Errorf("missing app descriptor")
	}
	if !bytes.Contains(image, []byte(Marker)) {
		return "", fmt.Errorf("incompatible partition layout")
	}
	pos := 24
	checksum := byte(0xef)
	for i := 0; i < segments; i++ {
		if pos+8 > len(image) {
			return "", fmt.Errorf("truncated segment header")
		}
		size := int(binary.LittleEndian.Uint32(image[pos+4 : pos+8]))
		pos += 8
		if size > len(image)-pos {
			return "", fmt.Errorf("truncated segment")
		}
		for _, b := range image[pos : pos+size] {
			checksum ^= b
		}
		pos += size
	}
	end := (pos + 16) &^ 15
	if end > len(image) || image[end-1] != checksum {
		return "", fmt.Errorf("image checksum mismatch")
	}
	if image[23] == 1 {
		if end+32 != len(image) {
			return "", fmt.Errorf("invalid image digest length")
		}
		sum := sha256.Sum256(image[:end])
		if !bytes.Equal(sum[:], image[end:]) {
			return "", fmt.Errorf("image SHA256 mismatch")
		}
	} else if end != len(image) {
		return "", fmt.Errorf("unexpected trailing image data")
	}
	version := stringsTrimNull(image[48:80])
	if version == "" {
		return "", fmt.Errorf("missing application version")
	}
	return version, nil
}
func stringsTrimNull(b []byte) string {
	if i := bytes.IndexByte(b, 0); i >= 0 {
		b = b[:i]
	}
	return string(b)
}
