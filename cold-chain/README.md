# 冷链温控追溯系统

接入车载温度传感器，**实时判定超温并定位责任环节**，支持**按运输批次完整回溯**。

- 零第三方依赖：Node.js ≥ 20 原生 ESM（`node:http` / 内置 `fetch` / 内置 test runner）
- 事件溯源存储（append-only JSONL），每个结论都可重放原始事件复核
- 超温报警自动开闭，跨交接的一次超温按时间精确拆分到多个责任方
- SSE 实时推送报警；车载模拟器内置真实运输场景（含跨责任超温）

## 快速开始

```bash
cd cold-chain

# 方式一：离线演示（内存库，跑完直接打印中文追溯报告）
npm run demo

# 方式二：启动 HTTP API，再用模拟器推送真实链路
npm start                    # 终端 A
npm run push-demo            # 终端 B：推送一个上海→杭州的完整批次
curl http://127.0.0.1:3000/api/shipments/SH2026091901/trace
```

实时监控（SSE）：

```bash
curl -N http://127.0.0.1:3000/api/stream
# 再执行一次 npm run push-demo，可实时看到 alarm.opened / alarm.closed 推送
```

运行测试：

```bash
npm test          # 22 个测试：判定引擎 / 服务状态机 / 事件重放 / HTTP+SSE / 模拟器
```

## 它解决什么问题

一批需 2–8℃ 运输的药品从上海发杭州，途中发生两段超温：

1. **冷机老化升温，且恰好跨越"干线车→分拨月台"交接** —— 一次报警持续 35 分钟，
   系统按各承运方虚拟承运区间拆分为：干线 15 分钟（43%）/ 月台 20 分钟（57%），
   不会因为交接而让任何一方脱责。
2. **城配频繁开门导致小幅超温 15 分钟** —— 独立报警，100% 归于末端配送站。

`npm run demo` 的报告会直接给出上述认定。

## 核心模型

- **运输批次 shipment**：温区（如 2–8℃）随批次配置，不同货品可不同。
- **载具 vehicle / 传感器 sensor**：传感器固定安装在某载具的某车厢（compartment）。
  月台、医院收货温控位也作为"载具"注册，保证交接前后温度链不断。
- **承运环节 segment**：批次在某段时间由某责任方用某载具承运（干线/中转/城配/交付）。
- **读数 reading**：`sensor_code + 温度 + 时间戳`。找不到在途承运环节的读数标记为**孤儿**，不参与判定。
- **报警 alarm**：以 `(批次, 车厢)` 为键。越限即开、回到温区即闭；换车/换月台时未闭环报警自动延续。

## 责任拆分算法（关键点）

温度采样按**阶跃函数**建模：读数 r_i 的测量值代表区间 `[ts_i, ts_{i+1})` 的实际温度。
每个环节的**虚拟承运区间**为 `[本环节开始, 下一环节开始)`，交接空档归上一环节
（"货没交出去之前都算我的"）。把每条越限读数的区间与各虚拟承运区间求交，
即得到每个责任方名下精确到秒的超温时长与峰值。报警仍开启时，最后一条越限区间延伸到当前时刻。

严重程度按**最大偏离**与**持续时长**就高判定：

| 级别 | 偏离 | 或 时长 |
|---|---|---|
| major 严重 | ≥ 2.0℃ | ≥ 20 分钟 |
| minor 一般 | ≥ 0.5℃ | ≥ 10 分钟 |
| trivial | 未达上述阈值的瞬时波动 | |

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/shipments` | 批次建档（可带 min_temp/max_temp） |
| GET | `/api/shipments` | 批次列表 |
| GET | `/api/shipments/:id/trace` | **按批次完整回溯** |
| POST | `/api/vehicles` / `/api/sensors` | 载具 / 车载传感器注册 |
| POST | `/api/segments` / `/api/segments/end` | 承运环节开始 / 交接结束 |
| POST | `/api/events` | 开门、设备故障、交接备注 |
| POST | `/api/readings` | **温度接入**：单条或 `{readings:[...]}` 批量 |
| GET | `/api/alarms?shipment=&status=` | 报警查询 |
| GET | `/api/stream` | SSE 实时事件流 |

完整字段与 curl 示例见 [docs/API.md](docs/API.md)，设计细节见 [docs/设计.md](docs/设计.md)。

## 目录

```
src/
  config.js          温区/级别阈值/存储路径
  time.js            epoch 秒内部表示，UTC+8 展示
  engine.js          纯规则：越限判定、级别、环节定位、责任拆分
  store.js           事件溯源 JSONL（append + replay）
  service.js         领域服务：建档/交接/读数入库/报警生命周期/回溯组装
  api.js             node:http 路由 + SSE
  report.js          中文终端追溯报告
  cli/               serve / demo / push-demo
simulator/
  scenario.js        上海→杭州演示场景（载具、传感器、环节、温度关键帧）
  simulator.js       关键帧插值 + 固定种子噪声，生成读数
  driver.js          DirectDriver（进程内）/ HttpDriver（推送 API）
  runner.js          按时间线执行场景
test/                node --test 内置测试
```
