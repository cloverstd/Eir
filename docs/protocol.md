# Eir MQTT 协议（主题 v1，消息协议 v2）

所有主题位于 `eir/v1/collectors/{collector_id}/`。采集端 ID 是 `eir-` 加出厂 Wi-Fi MAC 的小写十六进制；设备 ID 是 Eir 分配的 UUID，与接收端和蓝牙内存地址无关。普通上报与命令 QoS 1；config/status retained，measurements/acks/commands/events 不 retained。broker PUBACK 不代表数据已落库。

## 上报与确认

```json
{"version":1,"message_id":"32位小写十六进制记录消息ID","collector_id":"eir-001122334455","device_id":"设备UUID","profile":"omron-hem-7374t1","user_slot":1,"raw_hex":"16字节原始记录的32位十六进制"}
```

`record_sequence`、`device_time` 可附带，但服务器使用原始记录独立解析。按设备配置时区转换；无效时间保留原始文本，measured_at为空并进入待归属，不用接收时间伪装测量时间。解析器版本 `hem7374-v1`。未验证状态位只存储，不作诊断解释。

`acks` 在 PostgreSQL 提交后发送：

```json
{"version":1,"message_id":"原消息ID","status":"stored","measurement_id":"记录UUID"}
```

`status: rejected` 带 `error`；当前有效关联的格式错误保存拒绝诊断。未知设备、已撤销关联或旧代次消息在原文落库前拒绝，不再保存旧健康原文。采集端只回收匹配当前消息及作用域的确认。DB错误时没有应用确认；采集端重发。同消息ID不同内容拒绝；不同消息ID同原始记录成功确认但不增加测量。指纹为 SHA256(`device_id/user_slot/record_sequence/raw_hex`)；不依赖采集端、接收时间或内存槽位。

## 配置与指令

`config` 为单调递增版本的完整设备列表，低版本和同版本不写NVS：

```json
{"version":2,"devices":[{"id":"设备UUID","address":"AA:BB:CC:DD:EE:FF","address_type":0,"model":"HEM-7374T1","profile":"omron-hem-7374t1"}]}
```

`commands`：`{id,type,expires_at,device_id?}`，expires_at 必须为 UTC RFC3339 `Z`。类型为 scan、pair、read、backfill、ota。除scan外的蓝牙命令指定已分配设备。pair需要血压计进入配对模式；普通采集不会进行注册写入。ID在端上持久化去重。命令默认120秒过期；后台在pending期间每10秒重发，收到running/结果后停止。

OTA额外字段：`url,sha256,size,version,chip:"esp32c3",partition_layout:"eir-c3-v1"`。只下载应用镜像，不更换分区表或擦除NVS。单镜像上限0x180000；服务端验证C3镜像头、分段长度、校验和、SHA256及分区ABI标记。

## 事件与状态

`events`: `{command_id?,type,status,data,error?}`。命令状态包括running/succeeded/failed，OTA还有downloading/rebooting/rolled_back。scan的data为`{devices:[{address,address_type,name,rssi}]}`。device_info的data为`{device_id,serial_number}`。

`status`: `{online,collector_id,firmware,ip,rssi,free_heap,uptime,queue_depth,error,last_command}`。last_command携带最近一次持久化命令事件，服务器通过心跳恢复丢失结果。遗嘱只发送`{online:false}`，服务器合并状态，保留最后版本和IP。90秒无新心跳视为离线。

## REST

完整请求、响应及筛选定义由 `/api/v1/openapi.json` 提供。API和前端同源，拒绝跨源写入；不设置用户登录。CSV采用UTF-8 BOM，保护名字/备注的公式前缀。原始记录不可通过PATCH改写；仅归属和备注可改，保留修改审计。


## 0.2.0 生命周期协议

主题前缀保持 `eir/v1`。`version:2` 测量以及配置、指令、事件、确认贯穿三个 UUID 字段：`instance_id`（服务实例）、`binding_id`（采集端关联代次）、`data_epoch`（健康数据代次）。服务端先验证作用域，再处理原文和幂等确认；旧代次不能重新创建采集端或恢复已删除数据。

新刷采集端持久化生成 `enrollment_nonce`，通过 `protocol_version:2,bound:false` 状态进入发现列表。只有页面添加后下发的 `claim:true` 配置且 nonce 一致，才能建立关联。配置同时包含上述作用域、单调版本和 `devices` 完整列表；设备项的 `enabled:false` 表示基线尚未完成，不可自动采集。既有固件升级使用 `preserve_legacy:true` 接管，保留旧进度和队列，不重新建立基线。

生命周期命令携带 `id,type,phase,expires_at` 与作用域。操作日志持久化，服务端重发仍使用同一个操作 ID；终态回执持久化后才报告成功。清理与 BLE、OTA、上传互斥。操作类型：

- `device_bind`：prepare 完成配对及基线；服务端确认基线完整后发送同 ID 的 commit，之后才启用。
- `prepare_data_reset`：准备所有已分配设备的基线；全部完成后数据库清空健康数据并切换代次，发送 `commit_data_reset` 和 `next_data_epoch`。准备失败发送 `abort_data_reset`，不删除健康数据。
- `collector_unbind`、`device_unbind`：停止对应采集，待队列确认后清理指定范围。
- `collector_reset`、`factory_reset`：清理本机数据；后者另清除网络并等待重新配网核实。重连状态的 `reset_receipt` 用于恢复丢失终态。
- `revoke`：已删除关联的撤销通知，不能恢复管理关联。

基线以 `type:baseline_chunk` 事件分块发送，`data` 包含 `device_id,chunk_index,total_chunks,records`；records 为 `{user_slot,hash}` 数组，hash 为原始 16 字节记录的 SHA-256。每块最多 32 条，最多 16 块。空数组是有效空基线，缺失 records 非法。收到 `kind:baseline` 且操作、设备、分块和作用域均匹配的 stored 确认后才能报告 prepared。服务端核实所有分块完整后提交；普通补采也必须排除基线记录。

出厂重置的 `awaiting_provisioning` 不是已完成。新入网后核实持久化回执，页面才显示完成。在线删除响应里的 `device_cleanup_confirmed:false` 明确表示仅服务端撤销，不能推断设备本地已清理。旧协议既有设备可以继续采集，但不开放新远程生命周期操作；新设备不能通过心跳或测量自动成为已绑定采集端。

REST 生命周期接口及确认参数见 OpenAPI，操作说明见 [设备生命周期管理](lifecycle.md)。


## 0.3.0 阿福体脂秤扩展

主题及 `version:2` 作用域保持不变。status.capabilities 包含 `profiles:["omron-hem-7374t1","afu-wl-tz-a1"],max_scales:2,max_connections:3`。设备配置增加 `hardware_id` 与 `adc_index`；前者是 AFU 广播携带的稳定硬件身份，后者只在服务器选择估算通道。

体脂秤上报示例（作用域 UUID 和消息 ID 与其他 v2 消息相同）：

```json
{"version":2,"message_id":"每个阶段独立的32位十六进制ID","collector_id":"采集端ID","device_id":"设备UUID","profile":"afu-wl-tz-a1","user_slot":0,"measurement_session_id":"上秤周期32位十六进制ID","captured_at":"2026-10-17T10:00:00Z","raw_hex":"ac298069117002000540000a000000000029d51b","impedance_raw_hex":"ac29020001f401c20180691170000000000029d60f"}
```

以上包为合成协议示例，不对应个人测量。稳定体重阶段不带 `impedance_raw_hex`，ADC 补全阶段带两种原始包。每阶段消息 ID 不同；相同 session 只能补全匹配体重和采集时间的 ADC，不能改写原始体重或已有 ADC。晚到的体重阶段不清除已经补全的 ADC。同一设备另一个 session 即使原始体重相同也保存为新测量。应用确认仍在事务提交后发出，重试沿用原消息 ID 和内容。

`captured_at` 是首次稳定体重的采集端 UTC 时间；未校时时为空，measured_at=NULL，不能按当前成员或接收时间强行归属。服务端按 profile 分派解析，体脂秤不使用欧姆龙记录序号、设备时间或原始内容指纹。

AFU 绑定验证 FFB0／FFB2 后准备一个空基线块，其他生命周期两阶段握手不变；D8 历史未验证，不支持 `read`／`backfill`。OTA 和重置统一停止所有连接。设备扫描结果增加 `profile,hardware_id`，status.devices 的秤条目增加 `connected`。

REST 查询 `kind=body_composition` 返回体重和估算值及其状态；未指定 kind 时兼容旧客户端，默认血压。`PATCH /api/v1/devices/{id}` 接受 `adc_index:0|1`，仅影响新记录。个人资料及 `body_fat_pct=0` 缺测约定详见 [体脂秤说明](body-scale.md)。

稳定 D5 需同时满足 `raw[2]&0x80` 和 `raw[6]==2`；未锁定通知拒收。解析版本 `afu-tz-a1-v2`。测量响应增加 `weight_valid`；旧调试原文可见但不进入统计，体脂估算显示同样受有效性约束。
