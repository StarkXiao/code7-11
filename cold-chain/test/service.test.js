import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ColdChainService } from '../src/service.js';

const T0 = 1_000_000; // 任意基准（秒）
const sec = (m) => T0 + m * 60;

/** 搭建一个批次 + 一个载具/传感器的最小环境 */
async function env(store = ':memory:') {
  const svc = await new ColdChainService(store).init();
  await svc.createShipment({
    code: 'B1', product: '疫苗', origin: 'O', destination: 'D',
    min_temp: 2, max_temp: 8, ts: sec(0),
  });
  await svc.registerVehicle({ code: 'V1', kind: 'truck' });
  await svc.registerSensor({ code: 'S1', vehicle_code: 'V1', compartment: 'C1' });
  return svc;
}

let svc;
beforeEach(async () => { svc = await env(); });

test('在限读数不产生报警；超上限立即产生 open 报警，回温后闭环', async () => {
  await svc.startSegment({ shipment_code: 'B1', vehicle_code: 'V1', stage: 'line_haul', party: '甲', ts: sec(0) });

  const r1 = await svc.ingestReading({ sensor_code: 'S1', temp: 5, ts: sec(5) });
  assert.equal(r1.action, 'ok');
  assert.equal(r1.alarm, null);

  const r2 = await svc.ingestReading({ sensor_code: 'S1', temp: 9.2, ts: sec(10) });
  assert.equal(r2.action, 'alarm_opened');
  assert.equal(r2.alarm.status, 'open');
  assert.equal(r2.alarm.direction, 'high');

  const r3 = await svc.ingestReading({ sensor_code: 'S1', temp: 9.5, ts: sec(15) });
  assert.equal(r3.action, 'excursion');

  const r4 = await svc.ingestReading({ sensor_code: 'S1', temp: 7.0, ts: sec(20) });
  assert.equal(r4.action, 'close');
  assert.equal(r4.alarm.status, 'closed');

  const alarms = svc.listAlarms();
  assert.equal(alarms.length, 1);
  const a = alarms[0];
  assert.equal(a.peak_temp, 9.5);
  // 阶跃模型：9.2 保持 5min + 9.5 保持 5min = 10min（闭环读数 7.0 不再延伸）
  assert.equal(a.duration_sec, 600);
  assert.equal(a.direction, 'high');
  assert.ok(['minor', 'major'].includes(a.severity));
  // 全部责任在唯一环节
  assert.equal(a.responsibility.bySegment.length, 1);
});

test('低于下限同样触发报警', async () => {
  await svc.startSegment({ shipment_code: 'B1', vehicle_code: 'V1', stage: 'line_haul', party: '甲', ts: sec(0) });
  const r = await svc.ingestReading({ sensor_code: 'S1', temp: 0.5, ts: sec(5) });
  assert.equal(r.action, 'alarm_opened');
  assert.equal(r.alarm.direction, 'low');
});

test('无承运环节时读数标记为孤儿，不触发报警', async () => {
  const r = await svc.ingestReading({ sensor_code: 'S1', temp: 99, ts: sec(3) });
  assert.equal(r.action, 'orphan');
  assert.equal(svc.listAlarms().length, 0);
  const trace = svc.traceShipment('B1');
  assert.equal(trace.stats.orphan_count, 1);
  assert.equal(trace.stats.reading_count, 0);
});

test('跨载具交接的超温：一次报警拆分给前后两个责任方', async () => {
  // 干线（V1）0~30min，月台（V2）30min 起
  await svc.registerVehicle({ code: 'V2', kind: 'dock' });
  await svc.registerSensor({ code: 'S2', vehicle_code: 'V2', compartment: 'C1' });
  const seg1 = await svc.startSegment({ shipment_code: 'B1', vehicle_code: 'V1', stage: 'line_haul', party: '干线方', ts: sec(0) });
  await svc.endSegment({ segment_id: seg1.id, ts: sec(30) });
  await svc.startSegment({ shipment_code: 'B1', vehicle_code: 'V2', stage: 'transfer', party: '月台方', ts: sec(30) });

  // 20min 9.1（越限，报警产生）→ 25min 9.3 → 30min 旧车读数 9.3 →
  // 30min 月台读数 9.0 → 35min 8.5 → 40min 回 7.5 闭环
  await svc.ingestReading({ sensor_code: 'S1', temp: 9.1, ts: sec(20) });
  await svc.ingestReading({ sensor_code: 'S1', temp: 9.3, ts: sec(25) });
  await svc.ingestReading({ sensor_code: 'S1', temp: 9.3, ts: sec(30) });
  await svc.ingestReading({ sensor_code: 'S2', temp: 9.0, ts: sec(30) });
  await svc.ingestReading({ sensor_code: 'S2', temp: 8.5, ts: sec(35) });
  const close = await svc.ingestReading({ sensor_code: 'S2', temp: 7.5, ts: sec(40) });

  assert.equal(close.action, 'close');
  const alarm = svc.listAlarms()[0];
  // 20→25、25→30 各 5 分钟归干线；同时刻旧车读数零宽不计；
  // 30→35、35→40 各 5 分钟归月台
  const parts = Object.fromEntries(alarm.responsibility.bySegment.map((b) => [b.party, b.seconds]));
  assert.equal(parts['干线方'], 600);
  assert.equal(parts['月台方'], 600);
  assert.equal(alarm.responsibility.totalSec, 1200);
});

test('环节结束后、下一环节开始前的空档读数归上一环节（空档归上家）', async () => {
  await svc.registerVehicle({ code: 'V2', kind: 'van' });
  await svc.registerSensor({ code: 'S2', vehicle_code: 'V2', compartment: 'C1' });
  const seg1 = await svc.startSegment({ shipment_code: 'B1', vehicle_code: 'V1', stage: 'line_haul', party: '干线方', ts: sec(0) });
  await svc.endSegment({ segment_id: seg1.id, ts: sec(30) });
  // 35min 仍未开始下一环节：旧车传感器若仍上报，按空档归上家
  await svc.ingestReading({ sensor_code: 'S1', temp: 9.4, ts: sec(35) });
  const alarms = svc.listAlarms();
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].trigger_segment_id, seg1.id);
});

test('traceShipment 返回环节链/时间线/统计/结论，且报警可按批次与状态筛选', async () => {
  const seg = await svc.startSegment({ shipment_code: 'B1', vehicle_code: 'V1', stage: 'line_haul', party: '甲', ts: sec(0) });
  await svc.recordEvent({ shipment_code: 'B1', kind: 'door_open', detail: '开门理货', ts: sec(8) });
  await svc.ingestReading({ sensor_code: 'S1', temp: 9, ts: sec(10) });
  await svc.ingestReading({ sensor_code: 'S1', temp: 5, ts: sec(15) });

  const trace = svc.traceShipment('B1');
  assert.equal(trace.shipment.code, 'B1');
  assert.equal(trace.segments.length, 1);
  assert.equal(trace.verdict.compliant, false);
  assert.ok(trace.timeline.some((t) => t.kind === 'event'));
  assert.ok(trace.timeline.some((t) => t.kind === 'alarm_open'));
  assert.equal(trace.stats.reading_count, 2);
  assert.equal(trace.stats.max_temp, 9);
  void seg;

  const onlyOpen = svc.listAlarms(null, 'open');
  assert.equal(onlyOpen.length, 0); // 已闭环
  const closed = svc.listAlarms(trace.shipment.id, 'closed');
  assert.equal(closed.length, 1);
});

test('重复批次号与未知传感器被拒绝', async () => {
  await assert.rejects(
    () => svc.createShipment({ code: 'B1', ts: sec(0) }),
    /已存在/
  );
  await svc.startSegment({ shipment_code: 'B1', vehicle_code: 'V1', stage: 'line_haul', party: '甲', ts: sec(0) });
  await assert.rejects(
    () => svc.ingestReading({ sensor_code: 'NOPE', temp: 5, ts: sec(1) }),
    /未注册的传感器/
  );
});
