# Eir 网页

Node.js 22.6+，React + TypeScript + Vite + ECharts。生产构建由 Go 服务提供静态文件，不依赖 CDN。

```sh
npm ci
npm test
npm run build
npm run dev
```

开发服务默认将 `/api` 代理到 `http://localhost:8080`。对接独立测试后端时：

```sh
EIR_DEV_API=http://127.0.0.1:18080 npm run dev -- --host 127.0.0.1
```

`src/domain.ts` 集中处理查询参数、上海日期和测量更正的 API 边界。测试覆盖上海自然日的含首不含尾区间、跨年时区、无效测量时间的可见性、筛选与分页，以及只改备注时保持自动归属。

```sh
TZ=America/Los_Angeles npm test
```

真实浏览器联调需要后端、PostgreSQL 和 MQTT。没有服务时显示明确的连接错误，不填充演示健康数据。所有修改通过实际 API 进行，无法连接时不会显示保存成功。设备删除、成员删除未提供，以保留原始健康记录。
