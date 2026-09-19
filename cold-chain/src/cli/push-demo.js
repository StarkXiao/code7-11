#!/usr/bin/env node
/**
 * 向运行中的 API 推送完整演示场景，验证"车载传感器实时接入 → 实时判定"链路。
 *
 * 先启动服务：  npm start
 * 再开终端：    npm run push-demo
 * 查看回溯：    curl http://127.0.0.1:3000/api/shipments/SH2026091901/trace
 *
 * 为便于观察实时性，读数按其时间戳推送（历史回放），API 侧以读数自带 ts 判定。
 */

import { HttpDriver } from '../../simulator/driver.js';
import { runScenario } from '../../simulator/runner.js';
import { BATCH } from '../../simulator/scenario.js';

const BASE = process.env.API_BASE ?? 'http://127.0.0.1:3000';
const driver = new HttpDriver(BASE);

if (!(await driver.health().catch(() => false))) {
  console.error(`✗ API 不可达：${BASE}，请先执行 npm start`);
  process.exit(1);
}

// 取当天 08:00（UTC+8）= 当天 00:00 UTC 作为基准
const T0 = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate(), 0, 0, 0) / 1000;

console.log(`向 ${BASE} 推送批次 ${BATCH.code} ...`);
try {
  const { total } = await runScenario(driver, {
    t0Sec: T0,
    onProgress: (kind, data) => {
      if (kind === 'shipment') console.log('  批次建档完成');
      if (kind === 'assets') console.log(`  载具/传感器注册完成（${data.vehicles}/${data.sensors}）`);
      if (kind === 'progress') process.stdout.write(`\r  推送中 ${data.done}/${data.total}`);
    },
  });
  console.log(`\n✓ 完成，共推送 ${total} 个事件/读数。`);
  console.log(`  回溯：curl ${BASE}/api/shipments/${BATCH.code}/trace`);
  console.log(`  报警：curl "${BASE}/api/alarms?shipment=${BATCH.code}"`);
  console.log(`  实时：curl ${BASE}/api/stream （再跑一次本脚本可观察推送）`);
} catch (e) {
  console.error(`\n✗ 推送失败：${e.message}`);
  console.error('  （批次号可能已存在于服务端存储，可更换 data 目录或删除 JSONL 后重试）');
  process.exit(1);
}
