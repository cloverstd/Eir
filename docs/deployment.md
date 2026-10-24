# 部署与维护

Eir 面向受信内网，默认无登录；复用现有 MQTT。支持内置 PostgreSQL 或外部 PostgreSQL。React 资源随服务提供，不依赖 CDN。

页面使用 History 路由：`/data`、`/body`、`/devices`、`/members/:id/:section` 等地址可直接访问，筛选和分页保存在 URL。Go 服务已处理页面回退；反向代理应把完整路径交给 Eir，且不要缓存或缓冲 `/api/v1/events/stream`。缺失的 API 和静态资源仍返回 404。

信号监测升级先部署服务端及页面，再对核实身份的 ESP32 执行 0.3.9 或更新固件的 OTA。数据库新增信号表，不修改健康测量数据。旧固件继续显示 Wi-Fi 心跳信号，完整蓝牙遥测和七天趋势在升级后开始积累。MQTT ACL 若按主题授权，需要为相应采集端开放 `eir/v1/collectors/{id}/signals` 发布及 Eir 的订阅权限。

镜像源码构建使用 Docker BuildKit/buildx，前端和 Go 编译在构建机原生架构运行，再交叉编译目标程序。

## 默认 Compose

```sh
cp .env.example .env
# 填写随机密码、MQTT、内网 EIR_PUBLIC_URL
docker compose config --quiet
docker compose up -d --build --wait
```

使用发布镜像时，在 `.env` 设置 `EIR_IMAGE=ghcr.io/cloverstd/eir:main` 或某个版本/提交标签，执行：

```sh
docker compose pull eir
docker compose up -d --no-build --wait eir
```

`/healthz` 检查进程；`/readyz` 返回数据库和 MQTT 状态。容器非 root 运行，日志每文件 10 MB、保留 3 个。`EIR_PUBLIC_URL` 必须供 ESP32 访问，作为 OTA 下载链接来源。

持久卷为 `postgres_data`、`firmware_data`、`documents_data`。正常停止使用 `docker compose down` 保留卷。数据库自动进行受锁保护的增量迁移，升级前应保留完整备份。

## 外部数据库与 Home 风格部署

`compose.external.yaml` 只运行 Eir。复制 `.env.external.example` 并填写独立数据库账号的 `DATABASE_URL`，使用：

```sh
docker compose -f compose.external.yaml up -d --build --wait
```

默认只监听本机回环地址；需要内网端口时设置 `EIR_BIND_ADDRESS`。数据库账号拥有自己的 Eir 库即可，无需超级用户。URL 中的密码必须编码，随机十六进制密码可直接使用。服务端未启用 TLS 时，仅在受信内网使用 `sslmode=disable`。

已有 Traefik 和 Mosquitto 的 Home 风格目录：把 `compose.external.yaml` 安装为 `compose.yaml`，把 `compose.home.yaml` 安装为 `compose.override.yaml`，并保存私有 `.env`（0600）。现有网络名为 `traefik-net` 和 `mosquitto_default`；设置 `EIR_HOST=eir.example.lan`、`EIR_PUBLIC_URL=https://eir.example.lan`、`MQTT_URL=tcp://mosquitto:1883`。Compose 自动读取覆盖文件，不发布宿主机端口，使用既有 Traefik HTTPS。

覆盖文件需要支持 `!reset` 的 Compose v2。正式更新只需在该目录拉取 Eir 镜像并执行 `docker compose up -d --no-build --wait eir`，数据库和 MQTT 不由此项目管理。一个 MQTT broker 只运行一个 Eir 实例，避免固定 client ID 冲突。

医疗文件运行组件为官方 Alpine 的 `poppler-utils` 和 `libheif-tools`；不使用外部 OCR 或文档上传服务。可用 `EIR_DOCUMENT_MAX_BYTES` 配置文件大小上限，默认 26214400，最大 100 MiB。

## 备份与恢复

默认 Compose：

```sh
./scripts/backup.sh
./scripts/restore.sh backups/<timestamp> --replace-database
```

新备份包含 `database.dump`、`firmwares.tar.gz`、`documents.tar.gz` 和格式版本 2。备份短暂暂停当前项目的 Eir，保持数据库与文件快照一致；数据库和 MQTT 持续运行，脚本结束或失败时恢复 Eir。恢复暂停 Eir 后替换当前库和文件，失败保持停止供排查。支持没有医疗文件包的旧备份。备份只允许当前用户读取，不包含 `.env`。

外部数据库由其所在机器备份。维护顺序为：暂停 Eir；通过数据库机器生成 PostgreSQL custom dump；使用同项目的一次性 `tar` 容器备份 `/data/firmwares` 和 `/data/documents`；在退出处理函数中恢复 Eir。不要把默认脚本用于没有 `postgres` 服务的外部部署。SSH 使用现有运维身份，不分发私钥。恢复演练只在隔离 `eir-test-*` 项目执行。

## 构建与发布

GitHub Actions 对 PR 和主分支运行测试、隔离集成和固件构建。主分支镜像标签为 `main` 和 `sha-<commit>`；`vX.Y.Z` 发布应用版本，稳定版更新 `latest`。`firmware-vX.Y.Z` 发布固件，标签必须与工程内嵌版本一致。固件及应用分别发布，自动化只生成产物，升级由运维人员发起。

需要可重现更新时使用具体提交标签或镜像 digest。数据库升级后回退程序不代表完成数据回滚，应结合备份恢复。

## iPhone PWA、离线保存与 Web Push

用具有受信任证书的 HTTPS 地址访问，在 Safari 分享菜单选择“添加到主屏幕”。从桌面图标启动后，在系统管理开启通知并选择关注成员。iOS 16.4 或更新版本支持标准 Web Push，无需 Apple 开发者账号。每台设备分别授权；系统设置中的通知权限或专注模式会影响展示。

推送默认关闭。执行 `eir push-keygen` 一次，将输出安全保存到私有 `.env`（0600），不要提交密钥或在日志中记录。配置：

```dotenv
EIR_PUSH_ENABLED=true
EIR_PUSH_VAPID_PUBLIC_KEY=<generated public key>
EIR_PUSH_VAPID_PRIVATE_KEY=<generated private key>
EIR_PUSH_VAPID_SUBJECT=mailto:operator@example.com
```

复用现有 HTTPS 代理及 Eir 容器，不需要新增入站端口。服务器需要出站访问浏览器推送服务；允许 Apple `*.push.apple.com`、FCM `fcm.googleapis.com`、Firefox `updates.push.services.mozilla.com`。VAPID 密钥必须跨重启保持不变，换密钥后设备需要重新订阅。通知内容通过标准 Web Push 加密传递，但锁屏会显示姓名、读数及测量时间。

只有首次入库且已有成员归属的设备测量进入持久队列，体重等待 10 秒合并体脂结果。手工录入、重复数据、后续归属修改不推送。首次入库的历史补传也会通知，保留实际测量时间。失败最长重试 24 小时，过期订阅自动删除。推送并非紧急告警服务；点开最新详情仍需手机能访问家中 Eir。

本机默认自动保存全家最近 90 天的测量和手工指标，以及成员资料、病史、医疗文件列表、设备和操作列表；此前明确关闭离线保存的设备继续保持关闭。家庭概览、血压、体重和成员资料等原页面在断网或服务不可达时直接读取本机数据，保留筛选、分页、趋势和 CSV 导出。PDF/图片原件、文件文字和原始诊断字段仍需联网，不支持离线录入或控制设备。应用在前台时每 5 分钟同步，启动、回到前台、恢复网络和数据变化时立即检查；同步请求合并执行，完整快照原子替换，失败保留旧数据。其他已查看的 JSON 查询（例如指定时间范围的信号趋势）同步保存并定期刷新，未缓存的查询明确提示不可用。所有离线页面显示最后同步时间；测量数据仅覆盖本机最近 90 天。iOS 暂停或关闭应用后不保证后台定时任务，重新打开时补同步。关闭保存会清除本机健康快照，不影响推送订阅。系统重置后的新数据代次会随下一次成功同步替换旧快照；未联网的设备仍只能展示最后同步的数据。浏览器可能回收存储，离线保存不代替服务器备份。

更新时保留根路径 `/sw.js` 和 manifest 的正确 MIME 类型和重新验证缓存策略，不能将 API/SSE 缓存为页面。发现更新后由用户点击刷新，不自动重载录入中的页面。

### PWA 图标更新

当前图标为日漫双人家庭头像，manifest、Apple Touch Icon、favicon 与通知图标统一使用 `icon-anime-v1-*` 版本化路径。应用身份 `id`、`scope` 和 `start_url` 仍为 `/`，保留已有推送订阅及离线数据。打开应用或回到前台后发现新版本，会显示“新版本可用，刷新应用”；点击后启用新的 Service Worker。iOS 主屏幕上的图标更新由系统处理，网页更新并不代表桌面图标已在真机刷新。
