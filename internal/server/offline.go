package server

import (
	"eir/internal/health"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"net/http"
)

// Read the window, identity and all records from one database snapshot.
func (s *Server) offlineSnapshot(w http.ResponseWriter, r *http.Request) {
	tx, err := s.Store.DB.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		fail(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	var result json.RawMessage
	err = tx.QueryRow(r.Context(), `SELECT jsonb_build_object(
 'instance_id',instance_id,'data_epoch',data_epoch,'synced_at',now(),'window_start',now()-interval '90 days',
 'members',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY created_at,id),'[]') FROM members m),
 'measurements',(SELECT coalesce(jsonb_agg(to_jsonb(m)-'raw_hex'-'raw_adcs'-'impedance_raw' ORDER BY measured_at DESC,id),'[]') FROM measurement_details m WHERE coalesce(measured_at,received_at)>=now()-interval '90 days' AND coalesce(measured_at,received_at)<=now()),
 'history',(SELECT coalesce(jsonb_agg(to_jsonb(h) ORDER BY occurred_on DESC NULLS LAST,created_at DESC,id),'[]') FROM health_history h),
 'documents',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY recorded_on DESC NULLS LAST,created_at DESC,id),'[]') FROM (SELECT id,member_id,history_id,title,category,recorded_on,institution,summary,filename,mime_type,size,sha256,page_count,created_at,updated_at FROM medical_documents) d),
 'observations',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'source_record_id',source_record_id,'member_id',member_id,'kind',kind,'value',value,'value_secondary',value_secondary,'unit',unit,'measured_at',measured_at,'source',source,'estimated',estimated,'age_approximate',age_approximate,'notes',notes) ORDER BY measured_at DESC,id),'[]') FROM health_observations WHERE member_id IS NOT NULL AND measured_at >= now()-interval '90 days' AND measured_at <= now())
 ) FROM system_state`).Scan(&result)
	if err != nil {
		fail(w, err)
		return
	}
	var snapshot map[string]any
	if err = json.Unmarshal(result, &snapshot); err != nil {
		fail(w, err)
		return
	}
	snapshot["metrics"] = health.Metrics
	resources := map[string]any{}
	for name, query := range map[string]string{
		"signals/latest": `SELECT t.*,coalesce(c.status->'online'='true'::jsonb,false) AND c.last_seen>now()-interval '90 seconds' AS online,t.boot_id=coalesce(c.status->>'boot_id','') AND t.sampled_at>now()-interval '15 seconds' AS fresh FROM signal_samples t JOIN collectors c ON c.id=t.collector_id CROSS JOIN system_state sys LEFT JOIN devices d ON d.id=t.device_id WHERE t.binding_id=c.binding_id AND t.data_epoch=sys.data_epoch AND (t.device_id IS NULL OR (d.collector_id=c.id AND d.lifecycle_state='active')) AND EXISTS(SELECT 1 FROM signal_latest l WHERE l.sample_id=t.id) ORDER BY t.collector_id,t.link_key`,

		"devices":               "SELECT d.*,(SELECT max(measured_at) FROM measurements WHERE device_id=d.id) AS last_measured_at FROM devices d ORDER BY created_at",
		"collectors":            "SELECT *,protocol_version>=2 AS supports_lifecycle,coalesce(status->'online'='true'::jsonb,false) AND last_seen>now()-interval '90 seconds' AS online FROM collectors ORDER BY id",
		"bindings":              "SELECT b.*,m.name AS member_name FROM bindings b JOIN members m ON m.id=b.member_id ORDER BY effective_from DESC",
		"collectors/discovered": "SELECT * FROM collector_candidates ORDER BY last_seen DESC",
		"rejections":            "SELECT id,collector_id,message_id,reason,created_at FROM rejected_messages ORDER BY created_at DESC LIMIT 100",
		"events":                "SELECT * FROM events ORDER BY created_at DESC LIMIT 200",
		"operations":            "SELECT o.*,coalesce((SELECT jsonb_agg(jsonb_build_object('collector_id',collector_id,'status',status)) FROM operation_targets WHERE operation_id=o.id),'[]') AS targets FROM operations o ORDER BY created_at DESC LIMIT 100",
		"firmwares":             "SELECT * FROM firmwares ORDER BY created_at DESC",
		"ota-jobs":              "SELECT j.*,f.version FROM ota_jobs j JOIN firmwares f ON f.id=j.firmware_id ORDER BY j.created_at DESC LIMIT 100",
	} {
		var rows json.RawMessage
		if err = tx.QueryRow(r.Context(), "SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM ("+query+") t").Scan(&rows); err != nil {
			fail(w, err)
			return
		}
		resources[name] = rows
	}
	snapshot["resources"] = resources
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, err)
		return
	}
	respond(w, 200, sanitizeOffline(snapshot))
}

// Diagnostic packets and original file bodies are not part of offline browsing.
func sanitizeOffline(value any) any {
	switch v := value.(type) {
	case json.RawMessage:
		var decoded any
		if json.Unmarshal(v, &decoded) != nil {
			return nil
		}
		return sanitizeOffline(decoded)
	case map[string]any:
		for key, item := range v {
			switch key {
			case "raw_hex", "raw_data", "raw_adcs", "impedance_raw", "payload", "file_path":
				delete(v, key)
			default:
				v[key] = sanitizeOffline(item)
			}
		}
	case []any:
		for i, item := range v {
			v[i] = sanitizeOffline(item)
		}
	}
	return value
}
