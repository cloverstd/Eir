package messaging

import (
	"context"
	"eir/internal/store"
	"encoding/json"
	"fmt"
	mqtt "github.com/eclipse/paho.mqtt.golang"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"
)

type Bus struct {
	Client  mqtt.Client
	Store   *store.Store
	Prefix  string
	Changed func()
	drops   atomic.Int64
}
type incoming struct {
	topic string
	data  []byte
}

func Start(ctx context.Context, s *store.Store, url, user, password, prefix string, changed func()) *Bus {
	b := &Bus{Store: s, Prefix: strings.Trim(prefix, "/"), Changed: changed}
	queue := make(chan incoming, 128)
	options := mqtt.NewClientOptions().AddBroker(url).SetClientID("eir-service-v1").SetUsername(user).SetPassword(password).SetAutoReconnect(true).SetConnectRetry(true).SetConnectRetryInterval(5 * time.Second).SetConnectTimeout(10 * time.Second).SetCleanSession(true).SetOrderMatters(false)
	options.SetDefaultPublishHandler(func(_ mqtt.Client, m mqtt.Message) {
		if len(m.Payload()) > 65536 {
			return
		}
		packet := incoming{m.Topic(), append([]byte(nil), m.Payload()...)}
		select {
		case queue <- packet:
		default:
			b.drops.Add(1)
		} // No application ack: durable producer retries.
	})
	options.OnConnect = func(c mqtt.Client) {
		token := c.SubscribeMultiple(map[string]byte{b.Prefix + "/collectors/+/measurements": 1, b.Prefix + "/collectors/+/status": 1, b.Prefix + "/collectors/+/events": 1}, nil)
		if !token.WaitTimeout(10*time.Second) || token.Error() != nil {
			slog.Error("MQTT subscribe failed")
			return
		}
		slog.Info("MQTT connected")
		rows, e := s.DB.Query(ctx, "SELECT id FROM collectors")
		if e != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				b.PublishConfig(ctx, id)
			}
		}
	}
	options.OnConnectionLost = func(_ mqtt.Client, e error) { slog.Warn("MQTT disconnected", "error", e) }
	b.Client = mqtt.NewClient(options)
	b.Client.Connect()
	go func() {
		for {
			select {
			case <-ctx.Done():
				b.Client.Disconnect(100)
				return
			case packet := <-queue:
				c, cancel := context.WithTimeout(ctx, 15*time.Second)
				e := b.consume(c, packet)
				cancel()
				if e != nil {
					slog.Error("MQTT processing failed (no app ack)", "error", e)
				} else if changed != nil {
					changed()
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				b.dispatch(ctx)
			}
		}
	}()
	return b
}
func (b *Bus) Connected() bool { return b.Client != nil && b.Client.IsConnectionOpen() }
func (b *Bus) Publish(collector, suffix string, value any, retained bool) error {
	if !b.Connected() {
		return fmt.Errorf("MQTT disconnected")
	}
	data, e := json.Marshal(value)
	if e != nil {
		return e
	}
	t := b.Client.Publish(b.Prefix+"/collectors/"+collector+"/"+suffix, 1, retained, data)
	if !t.WaitTimeout(5 * time.Second) {
		return fmt.Errorf("MQTT publish timeout")
	}
	return t.Error()
}
func (b *Bus) PublishConfig(ctx context.Context, id string) error {
	config, e := b.Store.DesiredConfig(ctx, id)
	if e != nil {
		return e
	}
	return b.Publish(id, "config", config, true)
}
func (b *Bus) consume(ctx context.Context, m incoming) error {
	tail := strings.TrimPrefix(m.topic, b.Prefix+"/collectors/")
	parts := strings.Split(tail, "/")
	if len(parts) != 2 || !store.CollectorPattern.MatchString(parts[0]) {
		return nil
	}
	id, kind := parts[0], parts[1]
	switch kind {
	case "measurements":
		ack, e := b.Store.Ingest(ctx, id, m.data)
		if e != nil {
			return e
		}
		return b.Publish(id, "acks", ack, false)
	case "status":
		var status map[string]any
		if e := json.Unmarshal(m.data, &status); e != nil {
			return nil
		}
		revoke, e := b.Store.HandleStatus(ctx, id, m.data)
		if e != nil {
			return e
		}
		if revoke != nil {
			if revoke["legacy_revoke"] == true {
				return b.Publish(id, "config", revoke, true)
			}
			return b.Publish(id, "commands", revoke, false)
		}
		if last, ok := status["last_command"].(map[string]any); ok && last["command_id"] != nil {
			data, _ := json.Marshal(last)
			if e = b.consume(ctx, incoming{topic: b.Prefix + "/collectors/" + id + "/events", data: data}); e != nil {
				return e
			}
		}
		var exists bool
		b.Store.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM collectors WHERE id=$1)", id).Scan(&exists)
		if exists {
			return b.PublishConfig(ctx, id)
		}
		return nil
	case "events":
		var raw map[string]any
		if json.Unmarshal(m.data, &raw) != nil {
			return nil
		}
		commandID, _ := raw["command_id"].(string)
		var lifecycle bool
		if store.UUIDPattern.MatchString(commandID) {
			b.Store.DB.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM operations WHERE id=$1)", commandID).Scan(&lifecycle)
		}
		if lifecycle {
			ack, e := b.Store.HandleLifecycleEvent(ctx, id, m.data)
			if e != nil {
				return e
			}
			if ack != nil {
				if e = b.Publish(id, "acks", ack, false); e != nil {
					return e
				}
			}
			b.PublishConfig(ctx, id)
			return nil
		}
		var proto int
		var binding, state string
		e := b.Store.DB.QueryRow(ctx, "SELECT protocol_version,binding_id::text,lifecycle_state FROM collectors WHERE id=$1", id).Scan(&proto, &binding, &state)
		if e != nil {
			return nil
		}
		if proto >= 2 {
			sys, e := b.Store.System(ctx)
			if e != nil {
				return e
			}
			if raw["instance_id"] != sys.InstanceID || raw["binding_id"] != binding || raw["data_epoch"] != sys.DataEpoch {
				return nil
			}
		}

		var event struct {
			CommandID *string         `json:"command_id"`
			Type      string          `json:"type"`
			Status    string          `json:"status"`
			Data      json.RawMessage `json:"data"`
			Error     string          `json:"error"`
		}
		if json.Unmarshal(m.data, &event) != nil || event.Type == "" {
			return nil
		}
		if event.CommandID != nil && *event.CommandID == "" {
			event.CommandID = nil
		}
		if event.CommandID != nil && !store.UUIDPattern.MatchString(*event.CommandID) {
			return nil
		}
		if len(event.Data) == 0 {
			event.Data = json.RawMessage(`{}`)
		}
		tx, e := b.Store.DB.Begin(ctx)
		if e != nil {
			return e
		}
		defer tx.Rollback(ctx)

		if _, e = tx.Exec(ctx, "INSERT INTO events(collector_id,command_id,type,status,data,error) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING", id, event.CommandID, event.Type, event.Status, event.Data, event.Error); e != nil {
			return e
		}
		if event.Type == "device_info" {
			var info struct {
				DeviceID string `json:"device_id"`
				Serial   string `json:"serial_number"`
			}
			if json.Unmarshal(event.Data, &info) == nil && store.UUIDPattern.MatchString(info.DeviceID) && info.Serial != "" && len(info.Serial) <= 128 {
				_, e = tx.Exec(ctx, "UPDATE devices SET serial_number=$1 WHERE id=$2 AND collector_id=$3 AND NOT EXISTS(SELECT 1 FROM devices WHERE serial_number=$1 AND id<>$2)", info.Serial, info.DeviceID, id)
				if e != nil {
					return e
				}
			}
		}
		if event.CommandID != nil {
			if _, e = tx.Exec(ctx, "UPDATE commands SET status=$1 WHERE id=$2 AND collector_id=$3 AND status NOT IN ('succeeded','failed','rolled_back')", event.Status, event.CommandID, id); e != nil {
				return e
			}
			switch event.Status {
			case "downloading", "rebooting", "succeeded", "rolled_back", "failed":
				if _, e = tx.Exec(ctx, "UPDATE ota_jobs SET status=$1,error=$2,updated_at=now() WHERE id=$3 AND collector_id=$4 AND status NOT IN ('succeeded','rolled_back','failed')", event.Status, event.Error, event.CommandID, id); e != nil {
					return e
				}
			}
		}
		return tx.Commit(ctx)
	}
	return nil
}
func (b *Bus) dispatch(ctx context.Context) {
	if b.Connected() {
		pending, e := b.Store.PendingLifecycle(ctx)
		if e == nil {
			for _, t := range pending {
				b.PublishConfig(ctx, t.Collector)
				b.Publish(t.Collector, "commands", t.Payload, false)
			}
		}
	}

	b.Store.DB.Exec(ctx, "UPDATE commands SET status='expired' WHERE status='pending' AND expires_at<=now()")
	b.Store.DB.Exec(ctx, "UPDATE ota_jobs SET status='failed',error='command expired',updated_at=now() WHERE status='pending' AND id IN (SELECT id FROM commands WHERE status='expired')")
	if !b.Connected() {
		return
	}
	rows, e := b.Store.DB.Query(ctx, "SELECT collector_id,payload FROM commands WHERE status='pending' AND expires_at>now() ORDER BY created_at LIMIT 50")
	if e != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var payload json.RawMessage
		if rows.Scan(&id, &payload) == nil {
			b.Publish(id, "commands", payload, false)
		}
	}
}
