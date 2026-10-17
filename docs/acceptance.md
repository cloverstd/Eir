# 测试与验收

公开仓库使用合成或已脱敏测试夹具，不包含个人健康记录、原始蓝牙诊断、Flash 备份或真实设备身份。私有硬件验收材料由运维独立保存。

## 软件检查

- `make test`：Go 和 Python 测试；`go test -race ./...` 与 `go vet ./...` 检查并发及静态问题。
- `npm test --prefix web`、`npm run build --prefix web`：日期边界、资料精度、显示规则与生产构建。
- 原生 `firmware/tests/*_test.cpp` 使用 C++17、`-Wall -Wextra -Werror`。
- `scripts/integration.sh`：实际 HTTP/MQTT 去重、归属、数据库中断和备份恢复。
- `scripts/lifecycle_integration.sh`：发现、绑定、撤销、代次检查、重置和中断操作。
- `scripts/body_integration.sh`：体脂秤上秤周期、手动归属、估算、缺失资料和过期消息。
- `scripts/health_integration.sh`：档案、指标、附件格式、联合恢复、旧库迁移、只读 MCP 及真实客户端结果一致性。

所有破坏性测试必须使用独立 `eir-test-*` 项目、测试 MQTT 和私有测试卷。CI 分别运行 PostgreSQL 17、18，禁止使用现有 Home/PVE 数据库。浏览器演练同样使用合成资料，验证 390px 布局及表单、趋势、文件预览。

## 发布检查

检查 GitHub 工作流成功、多架构镜像可匿名拉取、固件芯片/大小/版本/哈希正确、源码提交与产物一致。发布产物后由运维手动更新应用或执行 OTA。

## 实机项目

仍需单独记录各版本的配对、两种设备自动采集、离线队列、设备断电恢复、OTA 失败回滚和连续运行。原始健康数据、采集完整率的独立参照、设备及测试时间保存在私有验收记录中。进程在线、队列为零、构建成功均不能替代上述结果。
