package server

import (
	"crypto/sha256"
	"eir/internal/firmware"
	"eir/internal/store"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, firmware.MaxSize+(64<<10))
	if e := r.ParseMultipartForm(firmware.MaxSize); e != nil {
		bad(w, "无效或过大的固件文件")
		return
	}
	defer r.MultipartForm.RemoveAll()
	file, _, e := r.FormFile("file")
	if e != nil {
		bad(w, "请选择固件文件")
		return
	}
	defer file.Close()
	data, e := io.ReadAll(io.LimitReader(file, firmware.MaxSize+1))
	if e != nil {
		bad(w, "读取固件失败")
		return
	}
	version, e := firmware.Validate(data)
	if e != nil {
		bad(w, e.Error())
		return
	}
	if supplied := r.FormValue("version"); supplied != "" && supplied != version {
		bad(w, "版本号与固件内嵌版本不一致")
		return
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	if e = os.MkdirAll(s.FirmwareDir, 0700); e != nil {
		fail(w, e)
		return
	}
	tmp, e := os.CreateTemp(s.FirmwareDir, ".upload-")
	if e != nil {
		fail(w, e)
		return
	}
	defer os.Remove(tmp.Name())
	if _, e = tmp.Write(data); e == nil {
		e = tmp.Sync()
	}
	closeErr := tmp.Close()
	if e == nil {
		e = closeErr
	}
	if e != nil {
		fail(w, e)
		return
	}
	if e = os.Rename(tmp.Name(), filepath.Join(s.FirmwareDir, digest+".bin")); e != nil {
		fail(w, e)
		return
	}
	_, e = s.Store.DB.Exec(r.Context(), "INSERT INTO firmwares(version,sha256,size,chip,partition_layout) VALUES($1,$2,$3,'esp32c3',$4) ON CONFLICT(sha256) DO NOTHING", version, digest, len(data), firmware.Layout)
	if e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	s.one(w, r, "SELECT * FROM firmwares WHERE sha256=$1", digest)
}
func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !store.UUIDPattern.MatchString(id) {
		http.NotFound(w, r)
		return
	}
	var hash string
	e := s.Store.DB.QueryRow(r.Context(), "SELECT sha256 FROM firmwares WHERE id=$1", id).Scan(&hash)
	if e != nil {
		fail(w, e)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="eir-c3.bin"`)
	http.ServeFile(w, r, filepath.Join(s.FirmwareDir, hash+".bin"))
}
func (s *Server) ota(w http.ResponseWriter, r *http.Request) {
	var in struct {
		CollectorID string `json:"collector_id"`
		FirmwareID  string `json:"firmware_id"`
	}
	if !decode(w, r, &in) {
		return
	}
	if !store.UUIDPattern.MatchString(in.FirmwareID) {
		bad(w, "无效固件 ID")
		return
	}
	var online bool
	e := s.Store.DB.QueryRow(r.Context(), "SELECT coalesce(status->'online'='true'::jsonb,false) AND last_seen>now()-interval '90 seconds' FROM collectors WHERE id=$1", in.CollectorID).Scan(&online)
	if e != nil {
		fail(w, e)
		return
	}
	if !online || s.Bus == nil || !s.Bus.Connected() {
		respond(w, 409, map[string]string{"error": "采集端或 MQTT 离线，请恢复后重试"})
		return
	}
	if strings.Contains(s.PublicURL, "localhost") || strings.Contains(s.PublicURL, "127.0.0.1") {
		bad(w, "请将 EIR_PUBLIC_URL 配置为采集端可访问的局域网地址")
		return
	}
	var version, digest, chip, layout string
	var size int64
	e = s.Store.DB.QueryRow(r.Context(), "SELECT version,sha256,size,chip,partition_layout FROM firmwares WHERE id=$1", in.FirmwareID).Scan(&version, &digest, &size, &chip, &layout)
	if e != nil {
		fail(w, e)
		return
	}
	id := ID()
	expires := time.Now().Add(2 * time.Minute)
	payload := map[string]any{"id": id, "type": "ota", "expires_at": expires.UTC().Format(time.RFC3339), "url": s.PublicURL + "/api/v1/firmwares/" + in.FirmwareID + "/download", "sha256": digest, "size": size, "version": version, "chip": chip, "partition_layout": layout}
	if config, e := s.Store.DesiredConfig(r.Context(), in.CollectorID); e == nil {
		for _, k := range []string{"instance_id", "binding_id", "data_epoch"} {
			if v, ok := config[k]; ok {
				payload[k] = v
			}
		}
	}
	data, _ := json.Marshal(payload)
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "INSERT INTO commands(id,collector_id,type,payload,expires_at) VALUES($1,$2,'ota',$3,$4)", id, in.CollectorID, data, expires); e != nil {
		fail(w, e)
		return
	}
	if _, e = tx.Exec(ctx, "INSERT INTO ota_jobs(id,collector_id,firmware_id) VALUES($1,$2,$3)", id, in.CollectorID, in.FirmwareID); e != nil {
		fail(w, e)
		return
	}
	if e = tx.Commit(ctx); e != nil {
		fail(w, e)
		return
	}
	s.Bus.Publish(in.CollectorID, "commands", payload, false)
	s.Changed()
	s.one(w, r, "SELECT * FROM ota_jobs WHERE id=$1", id)
}
