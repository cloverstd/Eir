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

## 信号遥测（固件 0.3.9 起）

`status` 增加每次启动随机的 32 位十六进制 `boot_id` 和 `capabilities.signals:true`。旧 `rssi` 字段仍表示 Wi-Fi dBm；接入点读取失败时为 `null`。心跳继续每 10 秒发送。

新增 `signals` 主题，QoS 1、**不 retained**，每 5 秒至多一批。示例：

```json
{"protocol_version":2,"instance_id":"实例UUID","binding_id":"关联UUID","data_epoch":"代次UUID","boot_id":"0123456789abcdef0123456789abcdef","sequence":1,"uptime_ms":100000,"sent_at":"2026-10-18T00:00:00.123Z","samples":[{"kind":"wifi","source":"wifi","rssi":-55,"connected":true,"age_ms":0},{"kind":"ble","device_id":"设备UUID","source":"advertisement","rssi":-72,"connected":false,"age_ms":200}]}
```

`sequence` 为本次启动递增批次号，`uptime_ms` 为本次启动至打包时的单调时钟毫秒数；`age_ms` 为打包时样本的单调时钟年龄（0–15000）。校时后携带 `sent_at`；未校时省略，利用同一启动心跳的 `uptime` 和服务器收到心跳的时间锚点推算采样时间，再减 `age_ms`；缺少锚点或推算已超过 15 秒的批次丢弃，防止网络恢复后将旧队列信号当作实时值。`source` 为 `wifi`、`advertisement` 或 `connection`；RSSI 不可用时为 `null`，不能用 0 代表失败。

BLE 广播缓存逐次更新，每批只发送各关联设备最新、尚未发送的真实观测；连接期间每 5 秒读 RSSI，短连接建立后也读取一次。停止广播或断开连接后不重复产生旧样本。Omron 沿用广播地址及地址类型匹配，AFU 沿用硬件身份匹配。所有信号缓存均有界且仅存在于 RAM，不写 Flash，也不使用健康测量 ACK 或重传队列。最多一个信号批次等待 broker PUBACK，断网或拥塞时丢弃中间遥测，恢复后历史保持缺口。

服务端只接受当前已绑定采集端的 `instance_id/binding_id/data_epoch` 和最近有效心跳已宣布的 `boot_id`；BLE 还必须属于该采集端且为 active。重复批次不重复落库，乱序旧样本不能覆盖最新信号。校时时钟偏差超过未来 5 秒或过去 15 秒的批次丢弃。信号历史独立保存 7 天，启动及每小时清理；删除设备／采集端级联清理其信号。重新关联先清除最新指针，旧作用域信号不参与当前查询。

HTTP `GET /api/v1/signals/latest` 可按 `collector_id,kind,device_id` 筛选；`GET /api/v1/signals/history` 必须选择采集端和类型，BLE 必须指定设备。`range=15m|1h|24h|7d` 对应 5 秒／5 秒／1 分钟／5 分钟桶；返回 `items[{time,mean,min,max,count}]`，缺测值为 null。SSE `/api/v1/events/stream` 的 `signals` 事件只更新信号区域，`change` 保留原有语义。

## REST

ESP32 固件 0.3.11 新增独立的本机诊断页 `GET /radio`、状态 `GET /radio/status` 和测试控制 `POST /radio/scan`，不属于 Eir REST API。控制请求为 `{"seconds":180}`，整数范围 0–300；0 停止并保留结果，正数清空诊断缓存后开始新一轮，最长五分钟。错误请求返回 400，维护中开始测试返回 409，跨源写入沿用设备本机的 Origin 检查。状态和页面禁用缓存，GET 不启动测试。详细数据结构见 [`firmware/openapi.json`](../firmware/openapi.json)，操作及缓存边界见 [固件说明](firmware.md#本机蓝牙--wi-fi-摆放测试0311)。

新接口返回本机运行时间、测试会话和截止时间、实际扫描状态、Wi-Fi 信息及附近 BLE 列表。广播与连接分别提供 `rssi/min/max/mean/count/age_ms/at_ms`，无样本时为 null；时间均为本次启动的单调毫秒数。`active` 表示是否记录诊断样本，`scanning` 表示物理扫描状态，停止测试后正常采集仍可能扫描。`connected` 是响应时实际连接状态，不能由旧连接 RSSI 推断当前连接。附近设备和广播详情不进入 MQTT、Eir OpenAPI 或健康数据队列，原有 `/scan` 和 MQTT scan 的支持设备筛选保持兼容。

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

## Web 测量查询与实时更新

`GET /api/v1/measurements/latest` 按成员及指标分别选取最近有效设备测量，返回 `items`，每项包含 `member_id`、`member_name`、`device_id`、`metric`、`record_id`、`measured_at`、`value`、`value_secondary`、`unit`。`metric` 为 `blood_pressure`、`pulse`、`weight` 或 `body_fat`；血压的副值是舒张压，其他指标副值为空。支持 `member_id`、`device_id`、`kind` 和 `unassigned`；不指定 kind 时同时查询血压与称重，忽略时间窗口。未校时、未锁定体重及非 estimated 体脂不作为最新有效值；体脂可以来自较早记录，必须保留其自身时间。

`GET /api/v1/measurements/series` 沿用测量列表的成员、设备、类型及 `[from,to)` 时间筛选，每批返回最多 1000 个原始点与 `next_cursor`。按 `measured_at,id` 升序读取，后续请求保持筛选不变并传回游标，直到游标为空；首次查询的接收时间上界随游标保留。响应只包含图表字段，不含蓝牙原文。未校时记录仅在原记录表中显示；未锁定体重保留 `weight_valid=false`，前端将它绘为缺测断点，缺失体脂也不能把存储用 0 当作测量值。

Web 全站共用 `/api/v1/events/stream` 一条 SSE 连接。`change` 合并触发当前页面重新查询，`signals` 只使信号数据失效，`heartbeat` 每 20 秒报告连接活性；连接恢复和页面重新可见时补读。断线及超过 45 秒无活动的代理连接采用有界退避重连，断线期间每 30 秒兜底读取，保留上次成功结果。查询支持取消与旧响应隔离，自动更新保留未保存表单、分页、图例、缩放及设备展开状态。

页面 URL 的 `zoom_from`、`zoom_to` 使用 RFC3339 毫秒时间。图表仍保留完整基础数据范围，记录表和 CSV 将当前视野转为 API 的半开时间区间；末端毫秒包含在所选范围内。原有日期筛选、列表分页和统计接口继续兼容。设备列表另提供可空的 `last_measured_at` 用于摘要显示，不用添加时间冒充最近测量时间。

`GET /devices`、设备详情与新增设备响应增加可空的只读字段 `scale_number`（整数）。schema 6 自动为体脂秤分配并持久化编号，UI 使用 `S` 前缀及至少三位数字；创建请求不能指定编号，血压计为空。该字段独立于 BLE 身份及 MQTT 生命周期作用域。

Web URL 的 `period` 新增 `180`（最近半年）和 `365`（最近一年），分别按上海时间的 6／12 个自然月计算；`30`／`90` 保持天数窗口。日历自定义范围仍保存 `period=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`，现有 HTTP 时间边界与日期表单字段格式保持兼容。
