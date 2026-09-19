#!/usr/bin/env node
// 命令行：
//   node src/cli.js simulate [剧本id] [--all] [--reset] 跑模拟剧本
//   node src/cli.js trace <批次编号>                  打印完整溯源报告
//   node src/cli.js verify                            校验哈希链
//   node src/cli.js reset                             清空事件日志
import { resolve } from 'node:path';
import { config } from './config.js';
import { buildServices } from './assembly.js';
import { SCENARIOS, scenarioById } from './simulator/scenarios.js';
import { runScenario } from './simulator/runner.js';
import { buildTraceReport } from './domain/trace.js';

function parseArgs(argv) {
  const [command, ...rest] = argv.slice(2);
  const positional = rest.filter((a) => !a.startsWith('--'));
  const flags = new Set(rest.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
  return { command, positional, flags };
}

async function runOne(services, id) {
  const compiled = scenarioById(id);
  const { batch } = await runScenario(services, compiled);
  console.log(`✓ ${compiled.title}`);
  console.log(`  批次 ${batch.code}（${batch.product}）模拟完成，共 ${services.store.state.readings.filter((r) => r.batchId === batch.id).length} 条读数`);
  return batch;
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv);

  if (command === 'simulate') {
    const services = buildServices();
    if (flags.has('reset')) services.store.reset();
    const wantAll = flags.has('all') || !positional[0];
    const ids = wantAll ? SCENARIOS.map((s) => s.id) : [positional[0]];
    for (const id of ids) await runOne(services, id);
    const verify = await services.store.verify();
    console.log(`\n${verify.message}`);
    return;
  }

  if (command === 'trace') {
    const code = positional[0];
    if (!code) throw new Error('用法: trace <批次编号>');
    const { store } = buildServices();
    const batch = Object.values(store.state.batches).find((b) => b.code === code);
    if (!batch) throw new Error(`批次不存在: ${code}`);
    const verifyResult = await store.verify();
    const report = buildTraceReport(store.state, batch.id, verifyResult);
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  if (command === 'verify') {
    const { store } = buildServices();
    const result = await store.verify();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'reset') {
    const { store } = buildServices();
    store.reset();
    console.log(`已清空事件日志: ${resolve(config.eventLog)}`);
    return;
  }

  console.log('用法: node src/cli.js <simulate|trace|verify|reset> ...');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('错误:', err.message);
  process.exit(1);
});
