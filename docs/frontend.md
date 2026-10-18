# Web 前端

全站使用 shadcn/ui（Radix）、Tailwind CSS 4、Lucide 图标与黑白灰主题；图表使用按需注册的 ECharts 组件。`web/components.json` 保存组件生成配置，组件源码在 `web/src/components/ui/`，`style.css` 只包含导入、主题变量和基础样式。页面布局使用 Tailwind 工具类。

家庭概览按成员展示最新设备读数及原始测量趋势，默认最近 30 天；最新值独立于图表窗口。血压与称重页默认全部时间，曲线完整加载游标分页，与每页 50 条的记录表分开读取。拖动任一图表会同步同页时间视野、记录表及 CSV 范围，并保留可回退的 URL。手动指标仍在成员健康档案查看，不混入设备测量概览。

`TimeSeriesChart` 共用时间轴、缩放、参考带、提示框和实例生命周期。血压使用成人正常上界参考线，脉搏使用成人静息参考带；体重按当前成员身高及中国成人一般 BMI 参考换算，体脂按 Omron BF511 成人年龄／性别分级。来源链接与适用条件在图表下显示，资料不足或年龄不适用时不显示参考带。体脂显示为估算，历史估算快照保持原样。

设备页按采集端分组，设备行默认折叠，宽屏摘要分列，手机纵向排列；设置、绑定、诊断、信号和操作预览仍可访问。桌面导航可折叠，手机导航使用 Sheet；成员筛选、确认、重置预览、表格与医疗文件操作统一使用 shadcn 组件。

## 开发与验证

- `npm ci --prefix web`、`npm test --prefix web`、`npm run build --prefix web`。
- `EIR_DEV_API=http://127.0.0.1:18088 npm run dev --prefix web` 可连接隔离验收服务。
- `./scripts/frontend_integration.sh` 创建 `eir-test-*` 项目、独立数据库与测试 MQTT，验证最新值、超过 1000 个曲线点、有效性、时间及类型隔离。默认退出后清理容器和卷；`EIR_TEST_KEEP=1` 可保留合成浏览器夹具。
- `EIR_TEST_SKIP_BUILD=1 EIR_TEST_IMAGE=<测试镜像>` 可复用已构建测试镜像。`EIR_TEST_DB_PORT` 默认 18547，`EIR_TEST_PORT` 默认 18088。
- 持续集成将新查询集成测试与已有生命周期、体脂秤、健康档案、MCP、信号测试一起在 PostgreSQL 17、18 上运行。

浏览器与软件验收结果见 `acceptance.md`；合成夹具和截图不代表真实 BLE 硬件验收。
