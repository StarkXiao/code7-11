# HTTP API 手册

所有请求/响应均为 JSON。时间字段输入接受 ISO 8601（建议带时区）或 epoch 秒，
响应统一输出带 `Z` 的 ISO 字符串（UTC）。中文报告按 UTC+8 展示。

## 1. 运输批次建档

```bash
curl -s -X POST http://127.0.0.1:3000/api/shipments \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "SH2026091901",
    "product": "重组人胰岛素注射液（需冷藏）",
    "origin": "上海浦东医药冷库",
    "destination": "杭州仁爱医院药房",
    "owner": "上海浦东医药物流有限公司",
    "min_temp": 2,
    "max_temp": 8,
    "ts": "2026-09-19T00:00:00Z"
  }'
```

`min_temp` / `max_temp` 省略时取全局默认 2 / 8 ℃。

## 2. 注册载具与车载传感器

```bash
# 载具：truck 干线车 / van 城配车 / dock 月台或收货温控位
curl -s -X POST localhost:3000/api/vehicles -H 'Content-Type: application/json' \
  -d '{"code":"沪A8D23F","name":"沪A·8D23F 冷藏车","kind":"truck"}'

# 传感器必须绑定载具与车厢号（默认 C1）
curl -s -X POST localhost:3000/api/sensors -H 'Content-Type: application/json' \
  -d '{"code":"T-1001","vehicle_code":"沪A8D23F","compartment":"C1"}'
```

## 3. 承运环节开始 / 交接结束

```bash
# 干线发运
curl -s -X POST localhost:3000/api/segments -H 'Content-Type: application/json' -d '{
  "shipment_code":"SH2026091901","vehicle_code":"沪A8D23F","compartment":"C1",
  "stage":"line_haul","party":"上海浦东医药物流（干线承运）",
  "operator":"司机 王建国","ts":"2026-09-19T00:00:00Z"}'

# 交接（用上一步返回的 id）
curl -s -X POST localhost:3000/api/segments/end -H 'Content-Type: application/json' -d '{
  "segment_id":"seg_xxx","ts":"2026-09-19T01:30:00Z","note":"到达城北分拨月台"}'
```

`stage` 建议取值：`line_haul`（干线）、`transfer`（中转）、`last_mile`（城配）、`delivery`（交付）。

## 4. 业务事件

```bash
curl -s -X POST localhost:3000/api/events -H 'Content-Type: application/json' -d '{
  "shipment_code":"SH2026091901","kind":"door_open",
  "detail":"城配装车，多次开关门理货","ts":"2026-09-19T02:10:00Z"}'
```

`kind`：`door_open` / `equipment_fault` / `handover_note` / `note`。

## 5. 温度读数接入（核心）

单条：

```bash
curl -s -X POST localhost:3000/api/readings -H 'Content-Type: application/json' \
  -d '{"sensor_code":"T-1001","temp":9.4,"ts":"2026-09-19T01:30:00Z"}'
```

响应：

```json
{
  "action": "alarm_opened",        // ok | alarm_opened | excursion | close | orphan
  "reading_ts": "2026-09-19T01:30:00.000Z",
  "alarm": { "id":"alm_...", "status":"open", "direction":"high", "...": "..." }
}
```

批量（车载网关常见用法，按 ts 升序逐条判定）：

```bash
curl -s -X POST localhost:3000/api/readings -H 'Content-Type: application/json' -d '{
  "readings":[
    {"sensor_code":"T-1001","temp":5.1,"ts":"2026-09-19T00:05:00Z"},
    {"sensor_code":"T-1001","temp":9.2,"ts":"2026-09-19T01:15:00Z"}
  ]}'
```

```json
{ "accepted": 2, "orphaned": 0,
  "events": [ { "action":"alarm_opened", "alarm_id":"alm_...", "status":"open" } ] }
```

`orphan` 表示读数时刻该传感器所在载具没有承运该批次（装车前、交货后、换车后旧车误发等），
读数仍留痕但不触发报警。

## 6. 报警查询

```bash
curl -s "localhost:3000/api/alarms?shipment=SH2026091901"
curl -s "localhost:3000/api/alarms?status=open"        # 只看未闭环
```

每条报警含：方向（high/low）、级别（major/minor/trivial）、开闭时刻、峰值、
越限读数明细 `readings[]`、责任拆分 `responsibility.bySegment[]`（环节、责任方、秒数、峰值）。

## 7. ★ 按批次完整回溯

```bash
curl -s localhost:3000/api/shipments/SH2026091901/trace
```

返回结构：

```jsonc
{
  "shipment": { "...": "批次与温区" },
  "segments": [
    // 每个承运环节：责任方、时间、虚拟承运区间内读数条数、观测到的最低/最高温
  ],
  "timeline": [
    // 环节交接、业务事件、报警开闭融合后的统一时间线，可逐时刻回放
  ],
  "alarms": [ /* 含责任拆分 */ ],
  "stats": {
    "reading_count": 44, "min_temp": 4.6, "max_temp": 9.4,
    "excursion_count": 12, "orphan_count": 0
  },
  "verdict": {
    "code": "EXCURSION_CLOSED",
    "label": "运输过程发生超温（已闭环），需质量评估",
    "compliant": false
  }
}
```

`verdict.code` 取值：`COMPLIANT`（全程达标）、`TRIVIAL_ONLY`（仅瞬时波动）、
`EXCURSION_OPEN`（有未闭环报警）、`EXCURSION_CLOSED`（发生过超温）。

## 8. SSE 实时事件流

```bash
curl -N localhost:3000/api/stream
```

事件类型：

- `alarm.opened` —— 判定到越限，立即产生报警
- `alarm.closed` —— 温度回到区间，报警闭环
- `reading.ingested` —— 每条读数（含 `action` 字段）

带 25 秒心跳（`: hb` 注释行），代理环境下可保活。

## 错误约定

| 状态码 | 场景 |
|---|---|
| 400 | 参数缺失/非法、时间倒挂、重复批次、传感器未注册等 |
| 404 | 批次或资源不存在 |
| 201/202 | 创建成功 / 读数已受理 |
