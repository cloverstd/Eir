package server

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"image"
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
	var member, other string
	for _, m := range members {
		row := m.(map[string]any)
		if row["name"] == "Synthetic other" {
			other = row["id"].(string)
		}
		if row["name"] == "Synthetic member" {
			member = row["id"].(string)
		}
	}
	if member == "" || other == "" {
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
		{"get_member_profile", "members/" + member, map[string]any{"member_id": member}},
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
	for _, entry := range documents {
		doc := entry.(map[string]any)
		if doc["filename"] != "report.pdf" {
			continue
		}
		response, err := http.Get(base + "/api/v1/documents/" + doc["id"].(string) + "/pages/1")
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		raster, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		ink := 0
		bounds := raster.Bounds()
		for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
			for x := bounds.Min.X; x < bounds.Max.X; x++ {
				r, g, b, _ := raster.At(x, y).RGBA()
				if r < 50000 || g < 50000 || b < 50000 {
					ink++
				}
			}
		}
		if ink < 20 {
			t.Fatal("Text PDF rendered blank; runtime fonts are missing")
		}
	}
	doc := documents[0].(map[string]any)
	call("read_document_text", map[string]any{"member_id": member, "id": doc["id"]})
	result := call("read_document_pages", map[string]any{"member_id": member, "id": doc["id"], "page": 1})
	images := 0
	for _, c := range result.Content {
		if image, ok := c.(*mcp.ImageContent); ok && len(image.Data) > 0 {
			images++
		}
	}
	if images != 1 {
		t.Fatal("document image not returned")
	}
	// Ownership is enforced for both original text and rendered images.
	for _, name := range []string{"read_document_text", "read_document_pages"} {
		args := map[string]any{"member_id": other, "id": doc["id"]}
		if name == "read_document_pages" {
			args["page"] = 1
		}
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err != nil {
			t.Fatalf("%s failed before ownership validation: %v", name, err)
		}
		if result == nil || !result.IsError {
			t.Fatalf("%s accepted another member's file", name)
		}
		metadata, _ := json.Marshal(result.StructuredContent)
		if string(metadata) != "null" && string(metadata) != "{}" {
			t.Fatalf("%s leaked file metadata", name)
		}
		for _, content := range result.Content {
			text, ok := content.(*mcp.TextContent)
			if !ok || text.Text != "读取失败：参数无效、记录不存在或服务暂不可用。" {
				t.Fatalf("%s leaked file content", name)
			}
		}
	}
	for _, name := range []string{"list_health_history", "list_measurements", "list_documents", "get_health_statistics"} {
		result := call(name, map[string]any{"member_id": other})
		encoded, _ := json.Marshal(result.StructuredContent)
		var data struct {
			Data struct {
				Items []any `json:"items"`
			} `json:"data"`
		}
		if err := json.Unmarshal(encoded, &data); err != nil {
			t.Fatal(err)
		}
		if len(data.Data.Items) != 0 {
			t.Fatalf("%s leaked another member's records: %s", name, encoded)
		}
	}
	for _, name := range []string{"Synthetic member", "Synthetic", "%", "not a member"} {
		result := call("find_member", map[string]any{"name": name})
		encoded, _ := json.Marshal(result.StructuredContent)
		var data struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal(encoded, &data); err != nil {
			t.Fatal(err)
		}
		if name == "Synthetic member" {
			if len(data.Data) != 1 || len(data.Data[0]) != 2 || data.Data[0]["id"] != member || data.Data[0]["name"] != name {
				t.Fatalf("lookup returned excess or incorrect data: %s", encoded)
			}
		} else if len(data.Data) != 0 {
			t.Fatalf("lookup was not exact: %s", encoded)
		}
	}
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
