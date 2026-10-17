# 健康档案与医疗文件

家庭成员页面包含基本资料、健康经历、身体指标、医疗文件四个分区，桌面和手机均可操作。

## 基本资料与历史快照

支持姓名、计算用性别、身高、血型、备注，以及完整出生日期或仅出生年月。所有字段除姓名外可不填写。完整出生日期优先；仅有年月时按测量年月估算年龄，并在体脂计算快照和查询结果中标记 `age_approximate`。资料修改不自动重算既有体脂快照。

成员请求新增 `birth_month`（`YYYY-MM`）、`blood_type`（A+/A-/B+/B-/AB+/AB-/O+/O- 或空）。现有 `birth_date` 保持兼容。变更出生年月时，不匹配的完整日期清空；同时提交的年月和日期必须一致。

## 健康经历

类型为 `condition`、`surgery`、`allergy`、`medication`、`family`，分别对应既往疾病、手术、过敏、用药、家族史。每条记录有标题、发生日期（可不填）、状态、备注，以及按类型使用的反应、程度、剂量、频次、结束日期、亲属关系。未填写不表示没有相关情况。用药字段用于记录已有信息。

## 身体指标

固定项目及规范单位：身高 cm、体重 kg、体脂率 %、腰围 cm、血压 mmHg（收缩压和舒张压）、心率 bpm、血糖 mmol/L、血氧 %、体温 °C。BMI 使用 kg/m²，由体重和身高快照计算，不接受手动填入。数值范围用于拒绝格式错误或无法表示的数据，不作为医学参考范围。

手动记录和设备数据通过 `GET /api/v1/health/observations` 查询，带 `source`、`source_record_id`、`estimated`、`age_approximate`。只有手动原始记录可以在此编辑；设备原文仍由原测量 API 管理。`from` 包含起点，`to` 不包含终点，使用 RFC3339。`page` 默认 1，`page_size` 默认 50、最大 200。汇总按上海时区日/周/月分组，测量类型、单位、估算属性分开统计。

## 文件

原件支持 PDF、JPEG、PNG、WebP、HEIC，默认每文件 25 MiB，PDF 最多 500 页；内容以实际文件格式识别。文件属于一个成员，可关联该成员的一条健康经历，保存标题、类别、检查日期、机构和手动摘要。分类为 `report`、`lab`、`prescription`、`imaging`、`other`。

PDF 通过 Poppler 提取已有可选取文字；图片和扫描件通过页面预览供人或 Agent 读取，不运行 OCR，不自动生成病史或指标。每次文字读取最多 20000 个 Unicode 字符，跟随 `next_offset`；服务器保留最多 2 MiB 提取文字，大文件仍可逐页读取。MCP 每次最多三页。原件下载保持字节及 SHA-256 不变；预览缩放为最多 1600 像素。图片最大 4000 万像素；预览进程有并发和时间限制。

文件保存在 `DOCUMENT_DIR`，容器默认 `/data/documents`。元信息在 PostgreSQL，路径采用服务生成的 UUID。删除元信息后，通过持久化清理队列移除文件，失败自动重试。完整重置同时排队清理文件；仅测量重置保留档案和文件。

## 接口

- `GET/POST /api/v1/members`，`GET/PUT /api/v1/members/{id}`。
- `POST /api/v1/members/{member}/history`，`PUT/DELETE .../history/{id}`。
- `POST /api/v1/members/{member}/observations`，`PUT/DELETE .../observations/{id}`。
- `POST /api/v1/members/{member}/documents` 使用 multipart 的 `file` 及元信息字段；`PUT/DELETE .../documents/{id}` 管理文件。
- `GET /api/v1/health/{metrics,history,observations,statistics,documents}` 查询固定字典和记录。
- `GET /api/v1/documents/{id}`、`/download`、`/text?offset=0`、`/pages/1` 读取文件。

完整结构由 `/api/v1/openapi.json` 提供。所有附件关联均校验成员所属关系。新增数据使用增量迁移；升级前备份数据库、固件和医疗文件。
