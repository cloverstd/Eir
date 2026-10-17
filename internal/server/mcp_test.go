package server

import (
	"context"
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
	if len(tools.Tools) != 9 {
		t.Fatalf("got %d tools", len(tools.Tools))
	}
	names := map[string]bool{}
	for _, tool := range tools.Tools {
		if tool.Annotations == nil || !tool.Annotations.ReadOnlyHint || tool.Annotations.DestructiveHint == nil || *tool.Annotations.DestructiveHint {
			t.Fatalf("unsafe tool %+v", tool)
		}
		names[tool.Name] = true
	}
	for _, name := range []string{"list_members", "get_member_profile", "list_health_history", "list_measurements", "get_health_statistics", "list_documents", "read_document_text", "read_document_pages", "get_device_status"} {
		if !names[name] {
			t.Fatal(name)
		}
	}
	result, e := session.CallTool(ctx, &mcp.CallToolParams{Name: "reset", Arguments: map[string]any{}})
	if e == nil && (result == nil || !result.IsError) {
		t.Fatal("unregistered write tool accepted")
	}
}
