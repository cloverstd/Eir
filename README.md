# Eir 家庭健康管理

Eir 在受信内网中管理家庭健康档案，通过 ESP32-C3 采集欧姆龙血压计和 AFU 体脂秤数据，经 MQTT 存入 PostgreSQL，提供适配手机的 React 界面和只读 MCP。

支持成员资料、既往疾病、手术史、过敏、用药、家族史，九类固定身体指标，以及 PDF、JPEG、PNG、WebP、HEIC 医疗文件。体脂率和 BMI 的估算来源会明确标记。

```text
血压计 / 体脂秤 → BLE → ESP32-C3 → 现有 MQTT → Eir → PostgreSQL
                                               ├─ 家庭健康网页
                                               └─ /mcp 只读 AI 接口
```

## 启动

```sh
cp .env.example .env
# 填写随机数据库密码、现有 MQTT 和 ESP32 可访问的内网 URL
# 使用已发布镜像时设置 EIR_IMAGE=ghcr.io/cloverstd/eir:main
# 使用源码时：
docker compose up -d --build --wait
```

访问配置的内网地址。Eir 面向受信内网，不设置登录；MCP 同样免鉴权。数据库、固件和医疗文件使用独立持久卷。

- [部署、升级与备份](docs/deployment.md)
- [健康档案、文件与 API](docs/health.md)
- [只读 MCP 接入](docs/mcp.md)
- [ESP32 固件与手动 OTA](docs/firmware.md)
- [设备生命周期](docs/lifecycle.md)
- [协议](docs/protocol.md)
- [测试与验收边界](docs/acceptance.md)

## 开发与构建

Go 1.26、Node 24、ESP-IDF v6.1。测试使用独立 `eir-test-*` Compose 项目及测试 MQTT。

```sh
make test
cd web && npm ci && npm test && npm run build
# 回到仓库根目录
go test -race ./...
go vet ./...
make integration
./scripts/lifecycle_integration.sh
./scripts/body_integration.sh
./scripts/health_integration.sh
```

[GitHub Actions](https://github.com/cloverstd/Eir/actions) 构建并验证应用和 ESP32-C3 固件；[GHCR](https://github.com/cloverstd/Eir/pkgs/container/eir) 发布 amd64/arm64 镜像，[Releases](https://github.com/cloverstd/Eir/releases) 提供正式固件。Home 应用更新和 ESP32 OTA 由运维人员手动发起。

## 许可证

GPL-3.0-only，见 [LICENSE](LICENSE)。上游 MIT、GPL 等声明保存在 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和对应源码目录。健康记录、备份、凭据和原始硬件验收日志不进入公开仓库。
