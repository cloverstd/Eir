package server

import (
	"context"
	"encoding/json"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestMCPIntegration(t *testing.T) {
	base := os.Getenv("EIR_MCP_TEST_URL")
	if base == "" {
		t.Skip("requires isolated health integration project")
	}
	if !strings.HasPrefix(base, "http://127.0.0.1:") {
		t.Fatal("integration endpoint must be an isolated loopback service")
	}
	fetch := func(path string) any {
		t.Helper()
		r, e := http.Get(base + "/api/v1/" + path)
		if e != nil {
			t.Fatal(e)
		}
		defer r.Body.Close()
		if r.StatusCode != 200 {
			t.Fatal(r.Status)
		}
		var out any
		if e = json.NewDecoder(r.Body).Decode(&out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	members := fetch("members").([]any)
	var member string
	for _, m := range members {
		row := m.(map[string]any)
		if row["name"] == "Synthetic member" {
			member = row["id"].(string)
		}
	}
	if member == "" {
		t.Fatal("synthetic test member missing")
	}
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "eir-integration", Version: "1"}, nil)
	session, e := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: base + "/mcp"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	call := func(name string, args map[string]any) *mcp.CallToolResult {
		t.Helper()
		result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if e != nil || result.IsError {
			t.Fatalf("%s: %v %+v", name, e, result)
		}
		return result
	}
	for _, tc := range []struct {
		name, path string
		args       map[string]any
	}{
		{"list_members", "members", map[string]any{}},
		{"get_member_profile", "members/" + member, map[string]any{"id": member}},
		{"list_health_history", "health/history?member_id=" + member, map[string]any{"member_id": member}},
		{"list_measurements", "health/observations?member_id=" + member + "&page_size=1&page=2", map[string]any{"member_id": member, "page_size": 1, "page": 2}},
		{"get_health_statistics", "health/statistics?member_id=" + member, map[string]any{"member_id": member}},
		{"list_documents", "health/documents?member_id=" + member, map[string]any{"member_id": member}},
	} {
		result := call(tc.name, tc.args)
		encoded, _ := json.Marshal(result.StructuredContent)
		var parsed map[string]any
		if e = json.Unmarshal(encoded, &parsed); e != nil {
			t.Fatal(e)
		}
		expected := fetch(tc.path)
		if !reflect.DeepEqual(parsed["data"], expected) {
			t.Fatalf("%s MCP and REST differ", tc.name)
		}
	}
	documents := fetch("health/documents?member_id=" + member).(map[string]any)["items"].([]any)
	doc := documents[0].(map[string]any)
	call("read_document_text", map[string]any{"id": doc["id"]})
	result := call("read_document_pages", map[string]any{"id": doc["id"], "page": 1})
	images := 0
	for _, c := range result.Content {
		if image, ok := c.(*mcp.ImageContent); ok && len(image.Data) > 0 {
			images++
		}
	}
	if images != 1 {
		t.Fatal("document image not returned")
	}
	call("get_device_status", map[string]any{})
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: "list_measurements", Arguments: map[string]any{"member_id": member, "page_size": 1}})
			if e != nil || result.IsError {
				t.Errorf("concurrent query: %v", e)
			}
		})
	}
	wg.Wait()
	req, _ := http.NewRequest("POST", base+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"reset","arguments":{}}}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Origin", "http://foreign.example")
	r, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	io.Copy(io.Discard, r.Body)
	r.Body.Close()
	if r.StatusCode != 403 {
		t.Fatalf("foreign Origin accepted: %d", r.StatusCode)
	}
}
