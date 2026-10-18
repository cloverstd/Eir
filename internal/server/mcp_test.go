package server

import (
	"context"
	"encoding/json"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http/httptest"
	"testing"
)

func TestMCPReadOnlyCatalog(t *testing.T) {
	app := New(nil, "http://localhost", t.TempDir(), t.TempDir())
	srv := httptest.NewServer(app.Handler())
	defer srv.Close()
	ctx := context.Background()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	session, e := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: srv.URL + "/mcp"}, nil)
	if e != nil {
		t.Fatal(e)
	}
	defer session.Close()
	tools, e := session.ListTools(ctx, nil)
	if e != nil {
		t.Fatal(e)
	}
	if len(tools.Tools) != 8 {
		t.Fatalf("got %d tools", len(tools.Tools))
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint || tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint {
			t.Fatalf("unsafe tool %+v", tool)
		}
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		var schema struct {
			Required []string `json:"required"`
		}
		if err := json.Unmarshal(encoded, &schema); err != nil {
			t.Fatal(err)
		}
		want := "member_id"
		if tool.Name == "find_member" {
			want = "name"
		}
		found := false
		for _, field := range schema.Required {
			found = found || field == want
		}
		if !found {
			t.Fatalf("%s does not require %s: %s", tool.Name, want, encoded)
		}
		names[tool.Name] = true
	}
	for _, name := range []string{"find_member", "get_member_profile", "list_health_history", "list_measurements", "get_health_statistics", "list_documents", "read_document_text", "read_document_pages"} {
		if !names[name] {
			t.Fatal(name)
		}
	}
	// Nil Store proves invalid scopes are rejected before any data access.
	for name := range names {
		field := "member_id"
		if name == "find_member" {
			field = "name"
		}
		values := []any{nil, "", "  ", []string{"a", "b"}}
		if name != "find_member" {
			values = append(values, "all", "not-a-uuid", "11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222")
		}
		for _, value := range values {
			args := map[string]any{}
			if name == "read_document_text" || name == "read_document_pages" {
				args["id"] = "11111111-1111-4111-8111-111111111111"
			}
			if name == "read_document_pages" {
				args["page"] = 1
			}
			if value != nil {
				args[field] = value
			}
			result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
			if _, isString := value.(string); isString && err != nil {
				t.Fatalf("%s failed outside scope validation: %v", name, err)
			}
			if err == nil && (result == nil || !result.IsError) {
				t.Fatalf("%s accepted invalid scope %#v", name, value)
			}
		}
	}
	for _, name := range []string{"list_members", "get_device_status"} {
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: map[string]any{}})
		if err == nil && (result == nil || !result.IsError) {
			t.Fatalf("household tool %s exposed", name)
		}
	}
	result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: "reset", Arguments: map[string]any{}})
	if e == nil && (result == nil || !result.IsError) {
		t.Fatal("unregistered write tool accepted")
	}
}
