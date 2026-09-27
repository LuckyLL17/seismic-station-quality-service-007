# 地震台站数据质量检测服务

纯后端 Node.js + TypeScript + Fastify 服务，面向地震台站观测数据接入与质量检测。

## 能力

- 台站档案管理（建档、资料更新、状态变更审计）
- 观测摘要批量接入
- 采样完整性、波形削顶、时间同步检测
- 质量评分与问题标签
- 按台站/分数查询观测记录
- 生成时间窗口质量报告（含台站档案快照）

## 台站状态机

三个状态：`online`（在线）、`maintenance`（维护）、`offline`（离线）。

状态变更严格区分两类来源：

| 来源 | 触发方式 | 规则 |
| --- | --- | --- |
| `manual`（人工） | `PATCH /api/stations/:id` 的 `status` 字段 | 三个状态之间可双向互转（在线↔维护↔离线）；同状态为空操作，不产生流水 |
| `observation`（观测事件） | 观测数据到达 `/api/observations/ingest` | 仅允许 `offline → online`（数据到达说明台站恢复）；**维护态受保护，观测不会把维护中台站自动改成在线**，维护只能由人工解除 |

- 维护期到达的观测照常接入并更新 `lastSeenAt`，但会打上 `维护期观测` 标记（不参与质量扣分），供质量报告识别。
- 由观测自动拉起上线的观测带 `观测触发自动上线` 标记。
- 所有状态转换写入状态流水，可按台站、来源查询。

## 主要接口

- `GET  /api/stations` / `GET /api/stations/:id` 查询档案
- `POST /api/stations` 建档（默认 `offline`，写建档人工流水；code 重复返回 409）
- `PATCH /api/stations/:id` 更新资料：`name` / `region` / `elevationM` / `status` / `reason` / `updatedBy`，均可选但至少一项；非法状态返回 400
- `GET  /api/status-events?stationId=&source=manual|observation` 状态变更流水
- `POST /api/observations/ingest` 观测接入（按状态机推导状态）
- `GET  /api/observations?stationId=&minScore=`
- `POST /api/quality/reports/run` 生成质量报告
- `GET  /api/quality/reports?stationId=`

## 一致性约定

- 质量报告生成时固化台站档案快照（`stationSnapshot`：code/name/region/elevationM）与生成时状态（`statusAtGeneration`）；后续档案勘误不影响已生成的历史报告。
- 报告单独统计窗口内 `maintenanceObservationCount`（维护期观测）与 `autoOnlineObservationCount`（自动上线触发观测）；数据质量问题（`issues`，参与扣分）与接入上下文标记（`flags`，不扣分）分离。
- 新接入观测与后续报告均读取更新后的当前档案。

## 启动

```bash
npm install
npm run dev
```

默认端口：`4301`。当前使用内存存储，后续可替换 PostgreSQL/时序数据库，并接入 Kafka、SeedLink 或对象存储。
