package server

import (
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
 'members',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name)),'[]') FROM members),
 'observations',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'source_record_id',source_record_id,'member_id',member_id,'kind',kind,'value',value,'value_secondary',value_secondary,'unit',unit,'measured_at',measured_at,'source',source,'estimated',estimated) ORDER BY measured_at DESC,id),'[]') FROM health_observations WHERE member_id IS NOT NULL AND measured_at >= now()-interval '90 days' AND measured_at <= now())
 ) FROM system_state`).Scan(&result)
	if err != nil {
		fail(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, err)
		return
	}
	respond(w, 200, result)
}
