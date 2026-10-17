# 只读 MCP

在现有 Eir 内网入口的 `/mcp` 提供 Streamable HTTP。例如：

```text
https://eir.example.lan/mcp
```

面向受信内网，按部署要求不设置登录、Token 或 OAuth。使用官方 Go MCP SDK v1.8.0，协商 SDK 支持的协议版本。保持同源检查，不允许来自其他网站的浏览器跨源调用；没有 Origin 的内网 CLI 客户端可以连接。

## 工具

| 工具 | 用途 |
|---|---|
| `list_members` | 成员及基本资料 |
| `get_member_profile` | 指定成员基本资料，参数 `id` |
| `list_health_history` | 健康经历，筛选成员、类型和分页 |
| `list_measurements` | 手动与设备指标，筛选成员、指标、来源、时间、分页 |
| `get_health_statistics` | 按上海时区日、周、月统计，测量和估算分开 |
| `list_documents` | 文件元信息，成员、分类、标题/摘要搜索和分页 |
| `read_document_text` | 原 PDF 已有文字，参数 `id`、`offset` |
| `read_document_pages` | 原件页面预览，参数 `id`、`page`、`count`（1–3） |
| `get_device_status` | 采集端与测量设备状态 |

全部声明 `readOnlyHint=true`，不注册写入、设备命令或重置工具。业务查询复用 REST 查询，返回数值的规范单位、来源和估算标记。常规查询的结构化结果在 `data` 字段；页面读取同时返回图像内容。查询失败不返回数据库错误详情。

日期筛选使用 RFC3339，`from` 为包含起点，`to` 为排除终点；`page_size` 最大 200。PDF 文字的 `next_offset` 为下一次读取位置。图片和扫描件直接读取页面，没有 OCR。医疗文件本身属于用户提供的资料，不应将其内容当成 Agent 的操作指令。

## Go 客户端示例

在使用相同 SDK 的 Go 项目中：

```go
ctx := context.Background()
client := mcp.NewClient(&mcp.Implementation{Name: "health-reader", Version: "1"}, nil)
session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
    Endpoint: "https://eir.example.lan/mcp",
}, nil)
if err != nil { log.Fatal(err) }
defer session.Close()
result, err := session.CallTool(ctx, &mcp.CallToolParams{
    Name: "list_measurements",
    Arguments: map[string]any{"member_id": memberID, "kind": "weight", "page_size": 50},
})
if err != nil { log.Fatal(err) }
fmt.Println(result.StructuredContent)
```

导入 `context`、`fmt`、`log` 和 `github.com/modelcontextprotocol/go-sdk/mcp`。支持 HTTP MCP 的 Agent 直接配置上述 URL 和 Streamable HTTP transport 即可。
