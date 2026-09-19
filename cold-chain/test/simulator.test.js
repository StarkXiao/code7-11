import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpolate, generateReadings } from '../simulator/simulator.js';
import { runScenario } from '../simulator/runner.js';
import { DirectDriver } from '../simulator/driver.js';
import { ColdChainService } from '../src/service.js';
import { BATCH, READING_RANGES, SAMPLE_INTERVAL_MIN } from '../simulator/scenario.js';

const T0 = 3_000_000;

test('关键帧插值：节点值与线性中点', () => {
  const frames = [[0, 4], [10, 6]];
  assert.equal(interpolate(frames, 0), 4);
  assert.equal(interpolate(frames, 10), 6);
  assert.equal(interpolate(frames, 5), 5);
  assert.equal(interpolate(frames, 20), 6); // 超出末帧取末值
});

test('演示场景：读数数量与 5 分钟网格一致、时间戳基于 T0', () => {
  const rs = generateReadings(T0);
  let expected = 0;
  for (const r of READING_RANGES) expected += (r.toMin - r.fromMin) / SAMPLE_INTERVAL_MIN + 1;
  assert.equal(rs.length, expected);
  assert.equal(rs[0].ts, T0);
  for (const r of rs) {
    assert.equal(((r.ts - T0) % 300), 0);
    assert.ok(r.temp > -30 && r.temp < 40);
  }
  // 固定种子 → 两次生成完全一致（可复现）
  assert.deepEqual(generateReadings(T0).map((r) => r.temp), rs.map((r) => r.temp));
});

test('演示场景端到端：产生 2 次报警，第一次跨干线/月台两方分责', async () => {
  const svc = await new ColdChainService(':memory:').init();
  await runScenario(new DirectDriver(svc), { t0Sec: T0 });

  const trace = svc.traceShipment(BATCH.code);
  const alarms = trace.alarms;
  assert.equal(alarms.length, 2, '应产生 2 次报警');
  assert.ok(alarms.every((a) => a.status === 'closed'), '两次报警都应闭环');

  const [a, b] = alarms;
  // 第一次：干线 + 月台两方
  const parties = a.responsibility.bySegment.map((x) => x.stage);
  assert.ok(parties.includes('line_haul'));
  assert.ok(parties.includes('transfer'));
  assert.equal(a.direction, 'high');
  assert.equal(a.severity, 'major'); // 峰值 9.4 / 时长 ≥20min
  // 责任占比之和为 100%
  const total = a.responsibility.totalSec;
  const sum = a.responsibility.bySegment.reduce((acc, x) => acc + x.seconds, 0);
  assert.equal(sum, total);

  // 第二次：仅城配方
  assert.deepEqual(b.responsibility.bySegment.map((x) => x.stage), ['last_mile']);
  assert.equal(b.severity, 'minor');

  // 4 个承运环节、全程读数全部归批
  assert.equal(trace.segments.length, 4);
  assert.equal(trace.stats.orphan_count, 0);
  assert.ok(trace.stats.reading_count > 30);
  assert.equal(trace.verdict.compliant, false);
});
