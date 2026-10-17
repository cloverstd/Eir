package server

import (
	_ "embed"
	"encoding/json"
	"net/http"
)

//go:embed openapi.json
var apiSpec []byte

func (s *Server) openapi(w http.ResponseWriter, r *http.Request) {
	respond(w, 200, json.RawMessage(apiSpec))
}
