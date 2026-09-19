import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { EventStore } from '../src/store/event-store.js';
import { Monitor } from '../src/ingest/monitor.js';
import { IngestGateway } from '../src/ingest/gateway.js';
import { Commands } from '../src/commands/index.js';
import { SCENARIOS, compileScenario } from '../src/simulator/scenarios.js';
import { runScenario } from '../src/simulator/runner.js';
import { buildTraceReport } from '../src/domain/trace.js';

async function runScenarioInTemp(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-e2e-'));
  const store = new EventStore(join(dir, 'events.jsonl'));
  store.load();
  const monitor = new Monitor(store, { gapMs: store.state.gapMs });
  const gateway = new IngestGateway(store, monitor);
  const commands = new Commands(store, monitor);
  const { batch } = await runScenario({ commands, gateway }, compileScenario(scenario));
  const verify = await store.verify();
  assert.equal(verify.ok, true, verify.reason);
  const report = buildTraceReport(store.state, batch.id, verify);
  return { store, report, batch };
}

test('剧本一：冷机故障 —— 判定超温、主责承运方运输，且开门短时波动被豁免', async () => {
  const { report } = await runScenarioInTemp(SCENARIOS[0]);
  assert.equal(report.conclusion.status, 'FAIL');
  assert.ok(report.excursionCount >= 1);

  const ex = report.excursions.find((e) => e.direction === 'high');
  assert.ok(ex, '应有高温超温事件');
  assert.equal(ex.attribution.primaryStage, 'transport');
  assert.equal(ex.attribution.primaryParty?.name, '迅驰冷链物流');
  assert.ok(ex.chargeableDurationMs >= 60 * 60 * 1000, `计责时长应 ≥1 小时，实际 ${ex.chargeableDurationMs}`);
  assert.match(ex.attribution.evidence.join('\n'), /到货开门测温即越限|到货交接/);

  // 6 分钟开门理货（< 10 分钟容忍）必须被豁免
  assert.ok(report.excusedFluctuations.some((f) => /开门|波动/.test(f.reason)), '应有被豁免的短时波动');

  // 责任分布以运输段为主
  const top = report.liabilityDistribution[0];
  assert.equal(top.stage, 'transport');
});

test('剧本二：发运即热货 —— 主责发货方预冷，承运人未拒收承担次要责任', async () => {
  const { report } = await runScenarioInTemp(SCENARIOS[1]);
  assert.equal(report.conclusion.status, 'FAIL');
  const ex = report.excursions[0];
  assert.equal(ex.direction, 'high');
  assert.equal(ex.attribution.rule, 'PRE_COOL_FAILURE');
  assert.equal(ex.attribution.primaryStage, 'storage_origin');
  assert.equal(ex.attribution.primaryParty?.name, '中原肉业');
  assert.match(ex.attribution.evidence.join('\n'), /预冷|热货/);
  // 运输段内继续超温，存在次要责任占比
  assert.ok(ex.attribution.contributions.some((c) => c.stage === 'transport' && c.durationMs > 0));
});

test('剧本三：签收合格后升温 —— 主责收货方仓储，到货前全程合格', async () => {
  const { report } = await runScenarioInTemp(SCENARIOS[2]);
  assert.equal(report.conclusion.status, 'FAIL');
  assert.ok(report.excursionCount >= 1);
  const ex = report.excursions[0];
  assert.equal(ex.attribution.primaryStage, 'storage_dest');
  assert.equal(ex.attribution.primaryParty?.name, '滨海医院中心药库');
  // 超温窗口必须全部晚于到货时刻
  const arrivalIso = report.custody.handovers.find((h) => h.stage === 'arrival').ts;
  assert.ok(ex.rawStart >= arrivalIso);
});

test('三份报告通用约束：交接温度判定、时间线段完整、含防篡改结论', async () => {
  for (const sc of SCENARIOS) {
    const { report } = await runScenarioInTemp(sc);
    // 三段时间线至少包含运输段，边界有明确 party
    const stages = report.custody.segments.map((s) => s.stage);
    assert.ok(stages.includes('transport'), `${sc.id} 必须有运输段`);
    // 每条超温都带证据链
    for (const ex of report.excursions) {
      assert.ok(ex.attribution.evidence.length >= 1);
      assert.ok(ex.attribution.primaryStage);
    }
    assert.equal(report.integrity.ok, true);
    // 交接记录实测温度给出 verdict
    for (const h of report.custody.handovers) {
      assert.ok(['in', 'high', 'low'].includes(h.tempVerdict));
    }
  }
});
