package health

import (
	"errors"
	"math"
	"time"
)

type Metric struct {
	Kind string  `json:"kind"`
	Unit string  `json:"unit"`
	Min  float64 `json:"min"`
	Max  float64 `json:"max"`
}

var Metrics = []Metric{{"height", "cm", 30, 260}, {"weight", "kg", 1, 500}, {"body_fat", "%", 0, 100}, {"waist", "cm", 10, 400}, {"blood_pressure", "mmHg", 10, 400}, {"heart_rate", "bpm", 10, 350}, {"blood_glucose", "mmol/L", 0.1, 100}, {"oxygen_saturation", "%", 0, 100}, {"temperature", "°C", 20, 50}}

func MetricFor(kind string) (Metric, bool) {
	for _, m := range Metrics {
		if m.Kind == kind {
			return m, true
		}
	}
	return Metric{}, false
}
func ValidateMetric(kind string, value float64, secondary *float64) error {
	m, ok := MetricFor(kind)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value < m.Min || value > m.Max {
		return errors.New("无效指标类型或数值")
	}
	if kind == "blood_pressure" {
		if secondary == nil || math.IsNaN(*secondary) || math.IsInf(*secondary, 0) || *secondary < 10 || *secondary > 300 || value < *secondary {
			return errors.New("请填写有效收缩压和舒张压")
		}
	} else if secondary != nil {
		return errors.New("该指标不接受第二个数值")
	}
	return nil
}

var HistoryKinds = map[string]bool{"condition": true, "surgery": true, "allergy": true, "medication": true, "family": true}

func ValidDate(s string) bool {
	if s == "" {
		return true
	}
	_, e := time.Parse("2006-01-02", s)
	return e == nil
}
func ValidateBirth(date, month string, now time.Time) error {
	if date != "" {
		t, e := time.Parse("2006-01-02", date)
		if e != nil || t.Year() < 1900 || t.After(now) {
			return errors.New("无效出生日期")
		}
		if month != "" && month != date[:7] {
			return errors.New("出生年月与日期不一致")
		}
	}
	if month != "" {
		t, e := time.Parse("2006-01", month)
		if e != nil || t.Year() < 1900 || month > now.Format("2006-01") {
			return errors.New("无效出生年月")
		}
	}
	return nil
}
