package server

import (
	"context"
	"crypto/sha256"
	"eir/internal/documents"
	"eir/internal/health"
	"eir/internal/store"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func (s *Server) documentRoutes(m *http.ServeMux) {
	m.HandleFunc("POST /api/v1/members/{member}/documents", s.uploadDocument)
	m.HandleFunc("PUT /api/v1/members/{member}/documents/{id}", s.editDocument)
	m.HandleFunc("DELETE /api/v1/members/{member}/documents/{id}", s.deleteDocument)
	m.HandleFunc("GET /api/v1/documents/{id}", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Store.Document(r.Context(), r.PathValue("id"))
		if e != nil {
			fail(w, e)
			return
		}
		respond(w, 200, v)
	})
	m.HandleFunc("GET /api/v1/documents/{id}/text", func(w http.ResponseWriter, r *http.Request) {
		offset, e := strconv.Atoi(r.URL.Query().Get("offset"))
		if r.URL.Query().Get("offset") == "" {
			offset = 0
			e = nil
		}
		if e != nil {
			bad(w, "无效文字偏移")
			return
		}
		v, e := s.DocumentText(r.Context(), r.PathValue("id"), offset)
		if e != nil {
			bad(w, e.Error())
			return
		}
		respond(w, 200, v)
	})
	m.HandleFunc("GET /api/v1/documents/{id}/download", s.documentDownload)
	m.HandleFunc("GET /api/v1/documents/{id}/pages/{page}", s.documentPage)
}

type documentMeta struct {
	ID       string `json:"id"`
	MemberID string `json:"member_id"`
	Filename string `json:"filename"`
	MIME     string `json:"mime_type"`
	Pages    int    `json:"page_count"`
}

func (s *Server) documentMeta(ctx context.Context, id string) (documentMeta, error) {
	var m documentMeta
	v, e := s.Store.Document(ctx, id)
	if e != nil {
		return m, e
	}
	e = json.Unmarshal(v, &m)
	return m, e
}
func (s *Server) DocumentText(ctx context.Context, id string, offset int) (map[string]any, error) {
	if !store.UUIDPattern.MatchString(id) || offset < 0 || offset > 2<<20 {
		return nil, errors.New("无效文件或文字偏移")
	}
	var text string
	if e := s.Store.DB.QueryRow(ctx, "SELECT extracted_text FROM medical_documents WHERE id=$1", id).Scan(&text); e != nil {
		return nil, e
	}
	runes := []rune(text)
	if offset > len(runes) {
		return nil, errors.New("文字偏移超出范围")
	}
	end := min(offset+20000, len(runes))
	var next any
	if end < len(runes) {
		next = end
	}
	return map[string]any{"id": id, "text": string(runes[offset:end]), "offset": offset, "next_offset": next, "text_available": len(runes) > 0, "note": "仅包含原文件的可选取文字；扫描件和照片请读取页面，未执行 OCR。"}, nil
}
func (s *Server) DocumentPage(ctx context.Context, id string, page int) (string, string, error) {
	m, e := s.documentMeta(ctx, id)
	if e != nil {
		return "", "", e
	}
	return documents.Page(ctx, filepath.Join(s.DocumentDir, m.ID), m.MIME, page, m.Pages)
}
func (s *Server) documentDownload(w http.ResponseWriter, r *http.Request) {
	m, e := s.documentMeta(r.Context(), r.PathValue("id"))
	if e != nil {
		fail(w, e)
		return
	}
	w.Header().Set("Content-Type", m.MIME)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": m.Filename}))
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, filepath.Join(s.DocumentDir, m.ID, "original"))
}
func (s *Server) documentPage(w http.ResponseWriter, r *http.Request) {
	page, e := strconv.Atoi(r.PathValue("page"))
	if e != nil {
		bad(w, "无效页码")
		return
	}
	p, mt, e := s.DocumentPage(r.Context(), r.PathValue("id"), page)
	if e != nil {
		bad(w, e.Error())
		return
	}
	w.Header().Set("Content-Type", mt)
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, p)
}

type documentInput struct {
	Title       string `json:"title"`
	Category    string `json:"category"`
	Date        string `json:"recorded_on"`
	Institution string `json:"institution"`
	Summary     string `json:"summary"`
	HistoryID   string `json:"history_id"`
}

func (d *documentInput) valid() bool {
	d.Title = strings.TrimSpace(d.Title)
	if d.Category == "" {
		d.Category = "other"
	}
	return d.Title != "" && len(d.Title) <= 200 && map[string]bool{"report": true, "lab": true, "prescription": true, "imaging": true, "other": true}[d.Category] && health.ValidDate(d.Date) && len(d.Institution) <= 200 && len(d.Summary) <= 8000 && (d.HistoryID == "" || store.UUIDPattern.MatchString(d.HistoryID))
}
func (s *Server) uploadDocument(w http.ResponseWriter, r *http.Request) {
	member, _, ok := healthIDs(w, r)
	if !ok {
		return
	}
	limit := s.DocumentMaxBytes
	if limit == 0 {
		limit = 25 << 20
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit+(1<<20))
	if e := r.ParseMultipartForm(1 << 20); e != nil {
		bad(w, "文件超过上传限制或格式无效")
		return
	}
	defer r.MultipartForm.RemoveAll()
	in := documentInput{r.FormValue("title"), r.FormValue("category"), r.FormValue("recorded_on"), r.FormValue("institution"), r.FormValue("summary"), r.FormValue("history_id")}
	if !in.valid() {
		bad(w, "无效文件信息")
		return
	}
	f, header, e := r.FormFile("file")
	if e != nil {
		bad(w, "请上传文件")
		return
	}
	defer f.Close()
	if header.Size <= 0 || header.Size > limit {
		bad(w, "文件超过上传限制或为空")
		return
	}
	if e = os.MkdirAll(s.DocumentDir, 0700); e != nil {
		fail(w, e)
		return
	}
	temp, e := os.MkdirTemp(s.DocumentDir, ".upload-")
	if e != nil {
		fail(w, e)
		return
	}
	defer os.RemoveAll(temp)
	out, e := os.OpenFile(filepath.Join(temp, "original"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		fail(w, e)
		return
	}
	hash := sha256.New()
	n, e := io.Copy(io.MultiWriter(out, hash), io.LimitReader(f, limit+1))
	closeErr := out.Close()
	if e != nil || closeErr != nil || n == 0 || n > limit {
		bad(w, "文件写入失败或超过限制")
		return
	}
	info, e := documents.Prepare(r.Context(), temp)
	if e != nil {
		if errors.Is(e, documents.ErrUnavailable) {
			respond(w, 503, map[string]string{"error": e.Error()})
		} else {
			bad(w, e.Error())
		}
		return
	}
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if e = store.HealthWrite(ctx, tx); e != nil {
		fail(w, e)
		return
	}
	if in.HistoryID != "" {
		var found bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM health_history WHERE id=$1 AND member_id=$2)", in.HistoryID, member).Scan(&found)
		if e != nil || !found {
			bad(w, "关联健康经历不属于该成员")
			return
		}
	}
	id := ID()
	filename := strings.ReplaceAll(filepath.Base(strings.ReplaceAll(header.Filename, "\\", "/")), "\x00", "")
	if len(filename) > 240 {
		filename = "medical-document"
	}
	_, e = tx.Exec(ctx, "INSERT INTO medical_documents(id,member_id,history_id,title,category,recorded_on,institution,summary,filename,mime_type,size,sha256,page_count,extracted_text) VALUES($1,$2,nullif($3,'')::uuid,$4,$5,nullif($6,'')::date,$7,$8,$9,$10,$11,$12,$13,$14)", id, member, in.HistoryID, in.Title, in.Category, in.Date, in.Institution, in.Summary, filename, info.MIME, n, fmt.Sprintf("%x", hash.Sum(nil)), info.Pages, info.Text)
	if e == nil {
		e = store.HealthChanged(ctx, tx)
	}
	if e != nil {
		fail(w, e)
		return
	}
	if e = os.Rename(temp, filepath.Join(s.DocumentDir, id)); e != nil {
		fail(w, e)
		return
	}
	// On an uncertain commit, retain the finalized file rather than erase a possibly committed upload.
	if e = tx.Commit(ctx); e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	v, e := s.Store.Document(ctx, id)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 201, v)
}
func (s *Server) editDocument(w http.ResponseWriter, r *http.Request) {
	member, id, ok := healthIDs(w, r)
	if !ok {
		return
	}
	var in documentInput
	if !decode(w, r, &in) {
		return
	}
	if !in.valid() {
		bad(w, "无效文件信息")
		return
	}
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if e = store.HealthWrite(ctx, tx); e != nil {
		fail(w, e)
		return
	}
	if in.HistoryID != "" {
		var valid bool
		e = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM health_history WHERE id=$1 AND member_id=$2)", in.HistoryID, member).Scan(&valid)
		if e != nil || !valid {
			bad(w, "关联健康经历不属于该成员")
			return
		}
	}
	tag, e := tx.Exec(ctx, "UPDATE medical_documents SET history_id=nullif($3,'')::uuid,title=$4,category=$5,recorded_on=nullif($6,'')::date,institution=$7,summary=$8,updated_at=now() WHERE id=$1 AND member_id=$2", id, member, in.HistoryID, in.Title, in.Category, in.Date, in.Institution, in.Summary)
	if e != nil {
		fail(w, e)
		return
	}
	if tag.RowsAffected() == 0 {
		respond(w, 404, map[string]string{"error": "未找到记录"})
		return
	}
	if e = store.HealthChanged(ctx, tx); e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		fail(w, e)
		return
	}
	s.Changed()
	v, e := s.Store.Document(ctx, id)
	if e != nil {
		fail(w, e)
		return
	}
	respond(w, 200, v)
}
func (s *Server) deleteDocument(w http.ResponseWriter, r *http.Request) {
	member, id, ok := healthIDs(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, e := s.Store.DB.Begin(ctx)
	if e != nil {
		fail(w, e)
		return
	}
	defer tx.Rollback(ctx)
	if e = store.HealthWrite(ctx, tx); e != nil {
		fail(w, e)
		return
	}
	tag, e := tx.Exec(ctx, "INSERT INTO document_garbage(id) SELECT id FROM medical_documents WHERE id=$1 AND member_id=$2 ON CONFLICT DO NOTHING", id, member)
	if e != nil {
		fail(w, e)
		return
	}
	if tag.RowsAffected() == 0 {
		respond(w, 404, map[string]string{"error": "未找到记录"})
		return
	}
	_, e = tx.Exec(ctx, "DELETE FROM medical_documents WHERE id=$1 AND member_id=$2", id, member)
	if e == nil {
		e = store.HealthChanged(ctx, tx)
	}
	if e == nil {
		e = tx.Commit(ctx)
	}
	if e != nil {
		fail(w, e)
		return
	}
	s.CleanupDocuments(ctx)
	s.Changed()
	w.WriteHeader(204)
}
func (s *Server) CleanupDocuments(ctx context.Context) {
	if s.Store == nil {
		return
	}
	rows, e := s.Store.DB.Query(ctx, "SELECT id::text FROM document_garbage ORDER BY created_at LIMIT 100")
	if e != nil {
		return
	}
	var ids []string
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil && store.UUIDPattern.MatchString(id) {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		if os.RemoveAll(filepath.Join(s.DocumentDir, id)) == nil {
			s.Store.DB.Exec(ctx, "DELETE FROM document_garbage WHERE id=$1", id)
		}
	}
}

// Reconcile abandoned uploads and uncertain commits after a full day; fresh uploads are never collected.
func (s *Server) ReconcileDocuments(ctx context.Context) {
	entries, err := os.ReadDir(s.DocumentDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil || time.Since(info.ModTime()) < 24*time.Hour {
			continue
		}
		id := entry.Name()
		if strings.HasPrefix(id, ".upload-") {
			_ = os.RemoveAll(filepath.Join(s.DocumentDir, id))
			continue
		}
		if !store.UUIDPattern.MatchString(id) {
			continue
		}
		tx, err := s.Store.DB.Begin(ctx)
		if err != nil {
			return
		}
		if err = store.HealthWrite(ctx, tx); err == nil {
			_, err = tx.Exec(ctx, "INSERT INTO document_garbage(id) SELECT $1::uuid WHERE NOT EXISTS(SELECT 1 FROM medical_documents WHERE id=$1::uuid) ON CONFLICT DO NOTHING", id)
		}
		if err == nil {
			_ = tx.Commit(ctx)
		} else {
			_ = tx.Rollback(ctx)
		}
	}
}
