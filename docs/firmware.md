# ESP32-C3 固件

目标为 ESP32-C3、4 MB Flash、分区 ABI `eir-c3-v1`。使用官方 ESP-IDF v6.1，依赖版本固定在 `firmware/dependencies.lock`。协议保留原上游 MIT/GPL 声明。

## 构建

```sh
. /path/to/esp-idf/export.sh
idf.py -C firmware build
python firmware/tools/manifest.py firmware/build/eir_collector.bin
```

应用版本由 `firmware/CMakeLists.txt` 定义；构建清单记录版本、芯片、分区、大小和 SHA-256。OTA 应用必须不超过 0x180000 字节。

## GitHub 产物

PR 和主分支的 Actions artifacts 包含应用、bootloader、分区表、刷机参数、首次刷机 `factory.bin`、校验清单和对应源码。版本标签 `firmware-vX.Y.Z` 必须与工程版本一致，构建通过后在 Releases 发布相同文件。镜像及固件构建不会自动连接真实设备。

- `eir_collector.bin`：已有 Eir 设备的手动 OTA 应用。
- `factory.bin`：首次刷机包，包含分区及初始化区域，只用于已核对身份的目标板。
- `manifest.json`：版本、SHA-256、大小、芯片、分区 ABI、源码提交。
- `SHA256SUMS`：产物校验和；`source.tar.gz`：该提交源码和锁文件。

## 首次配置与升级

首次刷写前核对芯片和 MAC，保留原固件和配置备份；不得将其他用途的板子直接覆盖。已有 Eir 设备优先 OTA，无需擦除 NVS 或更换分区表。

配网页配置 Wi-Fi 和 MQTT 后，在 Eir“设备与采集端”核对发现的设备 ID，再显式添加绑定。支持的血压计和体脂秤按界面配置；未绑定采集端不会开始采集。必要时可用 `firmware/tools/provision.py --port PORT --config PRIVATE_JSON`，私有配置不提交仓库。

手动 OTA：从 Release 下载应用并核对 SHA-256，在 Eir“固件升级”上传 `eir_collector.bin`，核对版本与目标采集端后执行升级。服务端验证芯片、布局、大小、镜像校验和和附加 SHA-256；设备完成启动确认后才视为成功。首次刷机包不能用于 OTA。

## 上传队列并发

固件 0.3.10 修复上传测量时的队列锁与 MQTT API 锁冲突。读取或迁移队列文件时持有存储锁，发布前释放；MQTT 确认回调可以独立删除已确认文件。发布失败时停止本批次，未确认记录继续保留在 Flash，后续重试沿用原消息 ID。每批最多处理 8 个文件，不改变绑定、代次或历史归属。

旧版本可能在仍有待上传记录时停止心跳，MQTT 服务随后显示采集端离线；重启可能暂时恢复。排查时保留 Flash 和待上传记录，核对服务端及设备身份后安装修复固件，不通过清空队列解决。

## 验收边界

CI 编译和镜像格式检查不等同于真实 BLE、配对、断电恢复、OTA 回滚或 24 小时采集验收。真实原始日志、设备地址、健康数据和 Flash 备份由运维私有保存。公开仓库的协议测试均为合成夹具。
