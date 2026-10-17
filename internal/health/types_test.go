package health

import (
	"math"
	"testing"
	"time"
)

func TestMetricValidation(t *testing.T) {
	d := 80.0
	for _, tc := range []struct {
		k  string
		v  float64
		s  *float64
		ok bool
	}{{"blood_pressure", 120, &d, true}, {"blood_pressure", 70, &d, false}, {"blood_pressure", 120, nil, false}, {"weight", 70, nil, true}, {"weight", math.NaN(), nil, false}, {"weight", 70, &d, false}, {"custom", 1, nil, false}} {
		if (ValidateMetric(tc.k, tc.v, tc.s) == nil) != tc.ok {
			t.Fatal(tc)
		}
	}
}
func TestBirthPrecision(t *testing.T) {
	now := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		date, month string
		ok          bool
	}{{"", "1990-02", true}, {"1990-02-28", "1990-02", true}, {"1990-02-29", "1990-02", false}, {"1990-02-28", "1990-03", false}, {"", "2026-11", false}, {"", "1899-01", false}} {
		if (ValidateBirth(tc.date, tc.month, now) == nil) != tc.ok {
			t.Fatal(tc)
		}
	}
}
