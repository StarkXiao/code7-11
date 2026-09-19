import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTemperature, quantifyRun, resolveZone, severityOf } from '../src/domain/zones.js';
import { runsOf, splitWindowBySegments } from '../src/domain/timewindows.js';

const frozen = resolveZone('frozen'); // -25..-18, 容忍 10 分钟

test('温度分类：带内/超上限/超下限', () => {
  assert.equal(classifyTemperature(-20, frozen).status, 'in');
  assert.equal(classifyTemperature(-18, frozen).status, 'in'); // 边界值算带内
  assert.equal(classifyTemperature(-17.9, frozen).status, 'high');
  assert.equal(classifyTemperature(-25.1, frozen).status, 'low');
  const high = classifyTemperature(-10, frozen);
  assert.ok(Math.abs(high.deviationC - 8) < 0.01);
});

test('容忍时长内的越限被豁免（开门/化霜波动）', () => {
  const start = 1_000_000;
  const r = quantifyRun(start, start + 9 * 60 * 1000, frozen.toleranceMs);
  assert.equal(r.excused, true);
  assert.equal(r.window, null);
});

test('刚好等于容忍时长仍豁免；超过则从容忍线后开始计责', () => {
  const start = 1_000_000;
  assert.equal(quantifyRun(start, start + 10 * 60 * 1000, frozen.toleranceMs).excused, true);
  const r = quantifyRun(start, start + 25 * 60 * 1000, frozen.toleranceMs);
  assert.equal(r.excused, false);
  assert.equal(r.window.start, start + frozen.toleranceMs);
  assert.equal(r.window.end, start + 25 * 60 * 1000);
  assert.equal(r.durationMs, 15 * 60 * 1000);
});

test('读数游程按状态切分并合并相邻同类', () => {
  const readings = [
    { ts: 1, tempC: -20 }, { ts: 2, tempC: -19 },
    { ts: 3, tempC: -10 }, { ts: 4, tempC: -9 },
    { ts: 5, tempC: -20 },
  ];
  const runs = runsOf(readings, (t) => classifyTemperature(t, frozen));
  assert.deepEqual(runs.map((r) => r.status), ['in', 'high', 'in']);
  assert.equal(runs[1].readings.length, 2);
});

test('计责窗口按责任段切分', () => {
  const segments = [
    { stage: 'storage_origin', start: 0, end: 100 },
    { stage: 'transport', start: 100, end: 300 },
  ];
  const pieces = splitWindowBySegments({ start: 50, end: 250 }, segments);
  assert.equal(pieces.length, 2);
  assert.equal(pieces[0].durationMs, 50);
  assert.equal(pieces[1].durationMs, 150);
});

test('自定义温区与严重程度分级', () => {
  const z = resolveZone({ min: 2, max: 8, toleranceMs: 0, name: '医药' });
  assert.equal(z.name, '医药');
  assert.throws(() => resolveZone({ min: 8, max: 2, toleranceMs: 0 }), /非法/);
  assert.equal(severityOf(9), 'critical');
  assert.equal(severityOf(4), 'major');
  assert.equal(severityOf(1), 'minor');
});
