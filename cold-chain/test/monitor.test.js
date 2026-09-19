import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { EventStore } from '../src/store/event-store.js';
import { Monitor } from '../src/ingest/monitor.js';
import { IngestGateway } from '../src/ingest/gateway.js';
import { Commands } from '../src/commands/index.js';

const MIN = 60_000;
const BASE = new Date('2026-09-19T00:00:00Z').getTime();

async function harness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-test-'));
  const store = new EventStore(join(dir, 'events.jsonl'));
  store.state.gapMs = opts.gapMs ?? 5 * MIN;
  store.load();
  const monitor = new Monitor(store, { gapMs: opts.gapMs ?? 5 * MIN });
  const gateway = new IngestGateway(store, monitor);
  const commands = new Commands(store, monitor);
  const batch = await commands.registerBatch({
    code: 'T-1',
    product: '测试货',
    zone: { id: 'z', name: '测试温区', min: 0, max: 8, toleranceMs: opts.toleranceMs ?? 15 * MIN },
    shipper: { name: '发货方' },
    carrier: { name: '承运方' },
    consignee: { name: '收货方' },
    sensorIds: ['S1'],
  });
  await commands.registerSensor({ id: 'S1', label: '探头' });
  await commands.startBatch('T-1', BASE);
  return { store, monitor, gateway, commands, batchId: batch.id, dir };
}

const signalsOf = (res) => res.signals.map((s) => s.signal);

test('带内读数只产生 reading_ok', async () => {
  const h = await harness();
  const r = await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 4, ts: BASE });
  assert.deepEqual(signalsOf(r), ['reading_ok']);
});

test('短时越限后恢复：先 warning，后 fluctuation_excused，不产生超温事件', async () => {
  const h = await harness({ gapMs: 20 * MIN });
  const s1 = signalsOf(await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 9, ts: BASE }));
  assert.deepEqual(s1, ['warning']);
  const s2 = signalsOf(await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 10, ts: BASE + 10 * MIN }));
  // 10 分钟点仍在容忍窗内：持续 monitoring，不产生超温事件
  assert.deepEqual(s2, ['monitoring']);
  assert.equal(Object.keys(h.store.state.activeExcursions).length, 0);
  const s3 = signalsOf(await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 7, ts: BASE + 14 * MIN }));
  assert.deepEqual(s3, ['fluctuation_excused']);
  assert.equal(Object.keys(h.store.state.activeExcursions).length, 0);
});

test('持续越限超过容忍时长：开启超温事件；回带内后关闭并给出计责时长', async () => {
  const h = await harness();
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 10, ts: BASE });
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 11, ts: BASE + 16 * MIN });
  assert.equal(Object.keys(h.store.state.activeExcursions).length, 1);
  const ex = Object.values(h.store.state.activeExcursions)[0];
  assert.equal(ex.direction, 'high');
  assert.equal(ex.rawStart, BASE);
  // 关闭
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 6, ts: BASE + 40 * MIN });
  assert.equal(Object.keys(h.store.state.activeExcursions).length, 0);
  const closed = Object.values(h.store.state.closedExcursions)[0];
  assert.equal(closed.recovered, true);
  // 40 分钟总越限 - 15 分钟容忍 = 25 分钟计责
  assert.equal(closed.chargeableDurationMs, 25 * MIN);
});

test('越限期间峰值与严重程度持续更新', async () => {
  const h = await harness();
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 9, ts: BASE });
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 20, ts: BASE + 20 * MIN });
  const ex = Object.values(h.store.state.activeExcursions)[0];
  assert.equal(ex.peakTempC, 20);
  assert.equal(ex.severity, 'critical'); // 偏差 12°C
});

test('读数间隔超阈值产生 data_gap 事件并可继续判定', async () => {
  const h = await harness({ gapMs: 5 * MIN });
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 4, ts: BASE });
  const r = await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 4, ts: BASE + 30 * MIN });
  assert.ok(signalsOf(r).includes('data_gap'));
  assert.equal(h.store.state.dataGaps.length, 1);
  assert.equal(h.store.state.dataGaps[0].durationMs, 30 * MIN);
});

test('坏数据门禁：物理量程外、乱序、超前时间戳、未注册批次一律拒收且不写日志', async () => {
  const h = await harness();
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 4, ts: BASE });
  await assert.rejects(() => h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 999, ts: BASE + MIN }), /量程/);
  await assert.rejects(() => h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 4, ts: BASE }), /递增/);
  await assert.rejects(() => h.gateway.ingest({ batchId: 'nope', sensorId: 'S1', tempC: 4, ts: BASE + 2 * MIN }), /批次不存在/);
  await assert.rejects(() => h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 4, ts: Date.now() + 10 * MIN }), /超前/);
  assert.equal(h.store.state.readings.length, 1);
});

test('进程重启重放后，开启中的超温恢复为 alarming 状态', async () => {
  const h = await harness();
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 12, ts: BASE });
  await h.gateway.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 12, ts: BASE + 20 * MIN });
  assert.equal(Object.keys(h.store.state.activeExcursions).length, 1);

  const store2 = new EventStore(h.store.file);
  store2.load();
  const monitor2 = new Monitor(store2, { gapMs: 5 * MIN });
  monitor2.rebuild();
  const gw2 = new IngestGateway(store2, monitor2);
  gw2.rebuild();
  assert.equal(monitor2.statusOf(h.batchId, 'S1').status, 'alarming');
  // 恢复后应关闭同一条超温事件（ID 不变）
  await gw2.ingest({ batchId: h.batchId, sensorId: 'S1', tempC: 5, ts: BASE + 40 * MIN });
  assert.equal(Object.keys(store2.state.closedExcursions).length, 1);
});
