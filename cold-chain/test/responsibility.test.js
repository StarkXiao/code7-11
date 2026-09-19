import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveZone } from '../src/domain/zones.js';
import { buildSegments, attribute } from '../src/domain/responsibility.js';

const T0 = new Date('2026-09-19T00:00:00Z').getTime();
const MIN = 60_000;

function batch() {
  return {
    id: 'b1',
    shipper: { id: 'p1', name: '发货方' },
    carrier: { id: 'p2', name: '承运方' },
    vehicleId: '车-1',
    consignee: { id: 'p3', name: '收货方' },
  };
}

function ctxOverrides({ handovers, zone = resolveZone('chilled') }) {
  const b = batch();
  const { segments, flags } = buildSegments(b, handovers, T0, T0 + 360 * MIN);
  return { zone, batch: b, segments, segmentFlags: flags, handovers };
}

test('运输段中部故障、到货测温越限：IN_TRANSIT_FAULT，承运方主责', () => {
  const handovers = [
    { id: 'h1', batchId: 'b1', stage: 'departure', ts: T0, holder: '发货', measuredTempC: 4 },
    { id: 'h2', batchId: 'b1', stage: 'arrival', ts: T0 + 300 * MIN, holder: '收货', measuredTempC: 12 },
  ];
  const ctx = ctxOverrides({ handovers });
  const anomaly = {
    kind: 'excursion', direction: 'high',
    rawStart: T0 + 120 * MIN,
    window: { start: T0 + 135 * MIN, end: T0 + 260 * MIN },
  };
  const a = attribute(anomaly, ctx);
  assert.equal(a.rule, 'IN_TRANSIT_FAULT');
  assert.equal(a.primaryStage, 'transport');
  assert.equal(a.primaryParty.name, '承运方');
  assert.match(a.evidence.join(), /到货开门测温即越限/);
});

test('发运即热货：PRE_COOL_FAILURE，发货方主责；运输延续部分承运方次责', () => {
  const handovers = [
    { id: 'h1', batchId: 'b1', stage: 'departure', ts: T0, holder: '发货', measuredTempC: 11 },
    { id: 'h2', batchId: 'b1', stage: 'arrival', ts: T0 + 300 * MIN, holder: '收货', measuredTempC: 4 },
  ];
  const ctx = ctxOverrides({ handovers });
  const anomaly = {
    kind: 'excursion', direction: 'high',
    rawStart: T0 - 5 * MIN, // 越限曲线插值到发运之前
    window: { start: T0, end: T0 + 100 * MIN },
  };
  const a = attribute(anomaly, ctx);
  assert.equal(a.rule, 'PRE_COOL_FAILURE');
  assert.equal(a.primaryStage, 'storage_origin');
  assert.match(a.evidence.join(), /预冷|热货/);
  assert.ok(a.contributions.some((c) => c.stage === 'transport' && c.durationMs > 0));
});

test('签收合格后升温：DEST_HANDLING，收货方主责', () => {
  const handovers = [
    { id: 'h1', batchId: 'b1', stage: 'departure', ts: T0, holder: '发货', measuredTempC: 4 },
    { id: 'h2', batchId: 'b1', stage: 'arrival', ts: T0 + 200 * MIN, holder: '收货', measuredTempC: 5 },
    { id: 'h3', batchId: 'b1', stage: 'signoff', ts: T0 + 210 * MIN, holder: '收货', measuredTempC: 6 },
  ];
  const ctx = ctxOverrides({ handovers });
  const anomaly = {
    kind: 'excursion', direction: 'high',
    rawStart: T0 + 230 * MIN,
    window: { start: T0 + 245 * MIN, end: T0 + 300 * MIN },
  };
  const a = attribute(anomaly, ctx);
  assert.equal(a.rule, 'DEST_HANDLING');
  assert.equal(a.primaryStage, 'storage_dest');
  assert.equal(a.primaryParty.name, '收货方');
});

test('数据中断按窗口重叠段归因，并标记缺失交接的推断', () => {
  const ctx = ctxOverrides({ handovers: [] }); // 没有任何交接
  const anomaly = {
    kind: 'gap', direction: null,
    rawStart: T0 + 50 * MIN,
    window: { start: T0 + 50 * MIN, end: T0 + 200 * MIN },
  };
  const a = attribute(anomaly, ctx);
  assert.equal(a.rule, 'GAP_BY_SEGMENT_SHARE');
  // 无交接时全部推断为运输段（起点=最早读数，终点=最晚读数）
  assert.equal(a.primaryStage, 'transport');
  assert.ok(a.flags.some((f) => /缺少发运交接/.test(f)));
  assert.match(a.evidence.join(), /数据中断/);
});

test('低越限（冻穿）方向同样可被规则识别', () => {
  const zone = resolveZone('frozen'); // -25..-18
  const handovers = [
    { id: 'h1', stage: 'departure', ts: T0, holder: '发货', measuredTempC: -20 },
    { id: 'h2', stage: 'arrival', ts: T0 + 300 * MIN, holder: '收货', measuredTempC: -30 },
  ];
  const b = batch();
  const { segments, flags } = buildSegments(b, handovers, T0, T0 + 360 * MIN);
  const a = attribute(
    { kind: 'excursion', direction: 'low', rawStart: T0 + 100 * MIN, window: { start: T0 + 110 * MIN, end: T0 + 290 * MIN } },
    { zone, batch: b, segments, segmentFlags: flags, handovers },
  );
  assert.equal(a.rule, 'IN_TRANSIT_FAULT');
  assert.match(a.evidence.join(), /偏低/);
});
