import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateTemp,
  severityFor,
  segmentAt,
  splitResponsibility,
  verdictFor,
} from '../src/engine.js';

test('evaluateTemp: 区间内/超上限/低于下限', () => {
  assert.deepEqual(evaluateTemp(5, 2, 8), { ok: true, direction: null, deviation: 0 });
  const high = evaluateTemp(10.5, 2, 8);
  assert.equal(high.ok, false);
  assert.equal(high.direction, 'high');
  assert.equal(high.deviation, 2.5);
  const low = evaluateTemp(0.3, 2, 8);
  assert.equal(low.direction, 'low');
  assert.equal(low.deviation, 1.7);
  // 边界：恰好等于上下限算达标
  assert.equal(evaluateTemp(8, 2, 8).ok, true);
  assert.equal(evaluateTemp(2, 2, 8).ok, true);
});

test('severityFor: 按偏离与时长就高不就低', () => {
  assert.equal(severityFor(0.1, 2), 'trivial');
  assert.equal(severityFor(0.6, 5), 'minor'); // 偏离达 minor
  assert.equal(severityFor(0.2, 12), 'minor'); // 时长达 minor
  assert.equal(severityFor(2.1, 5), 'major'); // 偏离达 major
  assert.equal(severityFor(0.5, 25), 'major'); // 时长达 major
});

test('segmentAt: 按车厢链定位并核对载具，交接空档归上家、换车后旧车为孤儿', () => {
  const segments = [
    { id: 's1', vehicle_id: 'v1', compartment: 'C1', started_at: 0, ended_at: 5400 },
    { id: 's2', vehicle_id: 'v2', compartment: 'C1', started_at: 6000, ended_at: 12000 },
  ];
  assert.equal(segmentAt(segments, 'v1', 'C1', 3000).id, 's1');
  // 空档 5400~6000：仍归上一环节的载具 v1
  assert.equal(segmentAt(segments, 'v1', 'C1', 5700).id, 's1');
  // 6000 后在途责任载具已是 v2，v1 再来的读数无承运环节
  assert.equal(segmentAt(segments, 'v1', 'C1', 6300), null);
  // 下家载具 v2 在其环节期间正常匹配
  assert.equal(segmentAt(segments, 'v2', 'C1', 9000).id, 's2');
  // v2 在自己开始前（s1 在途）上报：不匹配
  assert.equal(segmentAt(segments, 'v2', 'C1', 3000), null);
  // 车厢不匹配
  assert.equal(segmentAt(segments, 'v1', 'C2', 3000), null);
});

test('splitResponsibility: 跨交接超温按虚拟承运区间拆分到两个责任方（阶跃模型）', () => {
  // 交接发生在 1800s；s1 虚拟承运 [0,1800)，s2 [1800,∞)
  const segments = [
    { id: 's1', vehicle_id: 'v1', compartment: 'C1', started_at: 0, party: '甲方', stage: 'line_haul' },
    { id: 's2', vehicle_id: 'v2', compartment: 'C1', started_at: 1800, party: '乙方', stage: 'transfer' },
  ];
  // 5 分钟一条（ts 单位秒）：600/1200 来自旧车 v1；1800 起来自新车 v2；2400 回到区间闭环
  const mk = (id, ts, temp, sensorId) => ({
    id, ts, temp, compartment: 'C1', alarm_id: 'a1', sensor_id: sensorId,
  });
  const readings = [
    mk('r1', 0, 5, 'senA'),
    mk('r2', 600, 9, 'senA'),
    mk('r3', 1200, 9.2, 'senA'), // [1200,1800) 归 s1
    mk('r4', 1800, 9.1, 'senB'), // [1800,2400) 归 s2
    mk('r5', 2400, 7, 'senB'), // 回到区间，报警闭环
  ];
  const alarm = { id: 'a1', compartment: 'C1', readings: readings.slice(1, 4) }; // r2..r4 越限
  const { totalSec, bySegment, peak } = splitResponsibility(alarm, readings, segments);

  // r2 [600,1200)=600s、r3 [1200,1800)=600s 归 s1；r4 [1800,2400)=600s 归 s2
  const s1 = bySegment.find((b) => b.segment_id === 's1');
  const s2 = bySegment.find((b) => b.segment_id === 's2');
  assert.equal(s1.seconds, 1200);
  assert.equal(s2.seconds, 600);
  assert.equal(totalSec, 1800);
  assert.equal(s1.party, '甲方');
  assert.equal(s2.reading_count, 1);
  assert.equal(peak.temp, 9.2);
});

test('splitResponsibility: 交接同时刻双传感器读数不产生零宽错分', () => {
  const segments = [
    { id: 's1', vehicle_id: 'v1', compartment: 'C1', started_at: 0, party: '甲方', stage: 'line_haul' },
    { id: 's2', vehicle_id: 'v2', compartment: 'C1', started_at: 900, party: '乙方', stage: 'transfer' },
  ];
  // 旧车最后一条读数恰好在交接时刻 900，新车第一条也是 900
  const readings = [
    { id: 'r1', ts: 600, temp: 9.5, compartment: 'C1', sensor_id: 'A', alarm_id: 'a1' },
    { id: 'r2', ts: 900, temp: 9.4, compartment: 'C1', sensor_id: 'A', alarm_id: 'a1' },
    { id: 'r3', ts: 900, temp: 9.4, compartment: 'C1', sensor_id: 'B', alarm_id: 'a1' },
    { id: 'r4', ts: 1200, temp: 7, compartment: 'C1', sensor_id: 'B' },
  ];
  const alarm = { id: 'a1', compartment: 'C1', readings: [readings[0], readings[1], readings[2]] };
  const { totalSec, bySegment } = splitResponsibility(alarm, readings, segments);
  const s1 = bySegment.find((b) => b.segment_id === 's1');
  const s2 = bySegment.find((b) => b.segment_id === 's2');
  // r1 [600,900)=300s 归 s1；r2 与 r3 同时刻 → r2 零宽区间不计；r3 [900,1200)=300s 归 s2
  assert.equal(s1.seconds, 300);
  assert.equal(s2.seconds, 300);
  assert.equal(totalSec, 600);
});

test('splitResponsibility: 开放中的报警最后一条越限读数延伸到 liveUntil', () => {
  const segments = [
    { id: 's1', vehicle_id: 'v1', compartment: 'C1', started_at: 0, party: '甲方', stage: 'line_haul' },
  ];
  const readings = [{ id: 'r1', ts: 0, temp: 9, compartment: 'C1', alarm_id: 'a1' }];
  const alarm = { id: 'a1', compartment: 'C1', readings };
  const { totalSec, bySegment } = splitResponsibility(alarm, readings, segments, 300);
  assert.equal(totalSec, 300);
  assert.equal(bySegment[0].seconds, 300);
});

test('verdictFor: 结论分级', () => {
  assert.equal(verdictFor([]).compliant, true);
  assert.equal(verdictFor([{ status: 'open', severity: 'minor' }]).compliant, false);
  assert.equal(verdictFor([{ status: 'closed', severity: 'major' }]).compliant, false);
  assert.equal(verdictFor([{ status: 'closed', severity: 'trivial' }]).compliant, true);
});
