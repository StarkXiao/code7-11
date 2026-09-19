# 冷链温控追溯系统

接入车载温度传感器，**实时判定超温、定位责任环节、按运输批次完整回溯**。

零运行时依赖（仅使用 Node.js ≥ 20 内置能力），克隆即用；所有业务事实写入只追加的
哈希链事件日志，任何对温度证据的事后篡改都可被检出。

## 它解决什么问题

冷链纠纷的核心从来不是"有没有超温"，而是：

1. **开门装卸、冷机化霜也会短时越限**——直接按阈值告警会把正常操作误判成事故；
   但真等"超了很久"再报，驾驶端又来不及处置。
2. 一车货从出库到入库经过**发货方仓储 → 承运方运输 → 收货方仓储**三段，
   超温到底是谁的责任，各说各话。
3. 出事要追责时，记录仪数据可以被导出后修改，**证据本身不可信**。

本系统对应的三个答案：

| 问题 | 机制 |
|---|---|
| 误报与漏报 | 三态判定机 `normal → watching → alarming`：越限**立即预警**，持续超过温区容忍时长才**计超温**，开门/化霜短时波动自动豁免 |
| 责任不清 | 以**交接记录实测温度**（发运/中转/到货/签收）为界切分三段责任；超温窗口按段计时，结合交接证据给出主责规则（预冷不合格 / 运输故障 / 收货失职） |
| 证据不可信 | 全部读数与交接逐条 SHA-256 哈希链接（append-only），报告内置完整性校验，改 1°C 即断链 |

## 快速开始

```bash
cd cold-chain
npm test                 # 28 个测试：领域纯函数 / 状态机 / 哈希链 / 责任规则 / 三剧本端到端 / HTTP+SSE

# 方式一：一键生成三个责任剧本的数据（约 1310 条读数）
node src/cli.js reset
node src/cli.js simulate --all
node src/cli.js trace CC-2026-0919-A    # 查看批次完整溯源报告（JSON）
node src/cli.js verify                  # 校验哈希链

# 方式二：启动服务 + Web 仪表盘
node src/server.js
#   仪表盘   http://localhost:3100/
#   健康检查 http://localhost:3100/api/health
#   实时流   http://localhost:3100/api/stream  (SSE)
```

仪表盘右上角「重置并运行模拟剧本」可直接生成数据并在曲线上实时观看判定过程。

## 三个内置剧本（`src/simulator/scenarios.js`）

| 剧本 | 批次 | 关键事实 | 系统判定 |
|---|---|---|---|
| 一：运输冷机故障 | CC-2026-0919-A 速冻虾仁 | 发运 -20.4°C 合格；途中冷机皮带断裂；到货 -11.2°C | 超温 ≈2h19m，**主责承运方**（迅驰冷链物流）；途中 5 分钟开门理货被容忍时长豁免；到货后滞留部分收货方承担次要责任 |
| 二：发货即热货 | CC-2026-0919-B 冷鲜牛腩 | 发运实测 11.6°C（温区 0~8°C）仍放行 | 超温 ≈2h17m，**主责发货方**（中原肉业，预冷不合格）；承运人未拒收热货承担次要责任 |
| 三：签收后失职 | CC-2026-0919-C 胰岛素 | 到货 5.6°C、签收 6.1°C 均合格；随后冷库压缩机故障 | 超温 ≈51m，**主责收货方**（滨海医院中心药库） |

## API 摘要

设备/模拟器上报（需 `Authorization: Bearer dev-token`，可用 `GATEWAY_TOKEN` 覆盖）：

```bash
curl -X POST http://localhost:3100/api/gateway/readings \
  -H 'authorization: Bearer dev-token' -H 'content-type: application/json' \
  -d '{"batchId":"<id>","sensorId":"TH-001","tempC":-12.4,"ts":1789800000000}'
# 支持单条对象或数组批量；整批要么全收要么整批拒
```

| 方法 路径 | 说明 |
|---|---|
| `POST /api/admin/sensors` / `/batches` | 注册传感器、批次（含温区、三方主体、车牌、路线） |
| `POST /api/admin/batches/:code/sensors` | 绑定传感器 |
| `POST /api/admin/batches/:code/start` `/finish` | 发运 / 完结（完结时未恢复的超温按时收口） |
| `POST /api/admin/handovers` | 交接测温（departure/transit/arrival/signoff） |
| `GET  /api/batches` | 批次列表（含告警角标） |
| `GET  /api/batches/:code/monitor` | 实时监控视图（最新读数、开启中超温、状态机） |
| `GET  /api/batches/:code/readings` | 温度序列（自动等距抽稀） |
| `GET  /api/batches/:code/trace` | **完整溯源报告** |
| `GET  /api/excursions` | 超温台账（开启中/已关闭） |
| `GET  /api/integrity` | 哈希链校验 |
| `GET  /api/stream` | SSE 实时事件推送 |

### 坏数据门禁

以下读数返回 422 且**不写入证据链**：温度超出物理量程 [-60, 80]°C、时间戳乱序/重复、
超前服务器时间 >60s、批次或传感器不存在、传感器未绑定批次。

## 溯源报告长什么样

`GET /api/batches/:code/trace` 返回：

- `conclusion`：**PASS 合格 / REVIEW 存疑（温度合格但有数据中断）/ FAIL 不合格**及依据
- `custody`：交接测温台账（逐条判定合格/越限）+ 三段责任时间线（责任方、起止、时长）
- `sensors[]`：每探头读数量、极值、温区符合率、带内/带外时长
- `excursions[]`：方向、首次越限/恢复时刻（阈值边界线性插值）、峰值、等级
  （minor/major/critical）、扣减容忍后的**计责时长**、`attribution`（主责环节 +
  责任方 + 占比 + 逐条**证据文本** + 数据缺失标记）
- `excusedFluctuations[]`：被容忍时长豁免的开门/化霜波动（可见但不追责）
- `dataGaps[]`：传感器数据中断及其环节归因
- `liabilityDistribution`：全批次责任计时分布
- `timeline`：交接/告警关键时间线
- `integrity`：哈希链校验结论

## 架构与目录

```
cold-chain/
├─ src/
│  ├─ config.js               # 温区模板（冷冻/冷藏/医药/深冻）、量程、容忍时长
│  ├─ store/event-store.js    # append-only JSONL + SHA-256 哈希链 + 重放/校验
│  ├─ ingest/
│  │  ├─ monitor.js           # 实时超温三态状态机（含重启重建）
│  │  └─ gateway.js           # 上报网关：坏数据门禁、串行入链
│  ├─ domain/
│  │  ├─ zones.js             # 温区分类、容忍量化、严重程度（纯函数）
│  │  ├─ timewindows.js       # 越限游程、边界插值、责任段切分（纯函数）
│  │  ├─ responsibility.js    # 责任归因规则引擎
│  │  └─ trace.js             # 批次完整溯源报告
│  ├─ commands/index.js       # 批次/传感器/交接/启停 命令
│  ├─ simulator/              # 确定性温度模型 + 三个剧本 + 执行器
│  ├─ api/                    # HTTP 路由、SSE、静态托管
│  ├─ assembly.js             # 共享装配（测试/CLI 注入独立数据文件）
│  ├─ server.js / cli.js
├─ web/                       # 零依赖原生 JS 仪表盘（温度曲线/责任段/时间线）
├─ test/                      # node:test，23 个用例
└─ data/events.jsonl          # 事件日志（gitignore）
```

设计取舍详见 [`docs/design.md`](docs/design.md)。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3100 | HTTP 端口 |
| `GATEWAY_TOKEN` | dev-token | 设备上报与运维接口的 Bearer 令牌（生产必须改） |
| `SENSOR_GAP_MS` | 300000 | 判定数据中断的读数间隔阈值（5 分钟） |
| `COLDCHAIN_DATA_DIR` | ./data | 事件日志目录 |

## 与真实车载设备对接

把设备协议网关的数据按 `reading_ingested` 形状 POST 到 `/api/gateway/readings` 即可；
批量上报建议每批在同一传感器内严格按时间排序（任一条非法整批拒收，不会破坏递增链）。
设备时钟不可信时可不传 `ts`，由服务器在入链时打时戳（此时数据中断按入链间隔判定）。
