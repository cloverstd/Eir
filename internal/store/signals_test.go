package store

import (
	"testing"
	"time"
)

func TestSignalPacketValidation(t *testing.T) {
	now := time.Now()
	rssi := -60
	base := SignalPacket{ProtocolVersion: 2, InstanceID: "11111111-1111-4111-8111-111111111111", BindingID: "22222222-2222-4222-8222-222222222222", DataEpoch: "33333333-3333-4333-8333-333333333333", BootID: "0123456789abcdef0123456789abcdef", Sequence: 1, SentAt: &now, Samples: []SignalSample{{Kind: "wifi", Source: "wifi", RSSI: &rssi}}}
	if !base.valid(now) {
		t.Fatal("valid packet rejected")
	}
	tests := []struct {
		name   string
		mutate func(*SignalPacket)
	}{
		{"old clock", func(p *SignalPacket) { at := now.Add(-time.Minute); p.SentAt = &at }},
		{"future clock", func(p *SignalPacket) { at := now.Add(time.Minute); p.SentAt = &at }},
		{"missing boot", func(p *SignalPacket) { p.BootID = "" }},
		{"stale sample", func(p *SignalPacket) { p.Samples[0].AgeMS = 15001 }},
		{"negative age", func(p *SignalPacket) { p.Samples[0].AgeMS = -1 }},
		{"invalid RSSI", func(p *SignalPacket) { v := 127; p.Samples[0].RSSI = &v }},
		{"duplicate link", func(p *SignalPacket) { p.Samples = append(p.Samples, p.Samples[0]) }},
		{"wifi device", func(p *SignalPacket) { p.Samples[0].DeviceID = base.BindingID }},
		{"unknown source", func(p *SignalPacket) { p.Samples[0].Source = "unknown" }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := base
			p.Samples = append([]SignalSample(nil), base.Samples...)
			tt.mutate(&p)
			if p.valid(now) {
				t.Fatal("invalid packet accepted")
			}
		})
	}
	base.SentAt = nil
	if base.valid(now) {
		t.Fatal("unclocked packet without monotonic time accepted")
	}
	uptime := int64(100000)
	base.UptimeMS = &uptime
	base.Samples[0].RSSI = nil
	if !base.valid(now) {
		t.Fatal("unsynchronized clock or unavailable Wi-Fi rejected")
	}
}
