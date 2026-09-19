#!/usr/bin/env node
/**
 * 离线演示：内存库中完整跑一遍上海→杭州的胰岛素运输场景，
 * 结束后打印按批次的完整温控追溯报告（含责任环节认定）。
 *
 *   node src/cli/demo.js
 */

import { ColdChainService } from '../service.js';
import { DirectDriver } from '../../simulator/driver.js';
import { runScenario } from '../../simulator/runner.js';
import { renderReport } from '../report.js';
import { fmtMin } from '../time.js';
import { BATCH } from '../../simulator/scenario.js';

// 基准时刻固定为 2026-09-19 08:00（UTC+8）= 当日 00:00 UTC
const T0 = Date.UTC(2026, 8, 19, 0, 0, 0) / 1000;

const service = await new ColdChainService(':memory:').init();

// 实时监听领域事件，模拟监控大屏上的弹窗
service.subscribe((e) => {
  if (e.type === 'alarm.opened') {
    const p = e.payload;
    console.log(`  [${fmtMin(e.ts)}] ▲ 报警产生：${p.compartment} 车厢 ${p.direction === 'high' ? '超上限' : '低于下限'}`);
  } else if (e.type === 'alarm.closed') {
    const p = e.payload;
    console.log(`  [${fmtMin(e.ts)}] ▽ 报警闭环：级别 ${p.severity}，持续 ${Math.round(p.duration_sec / 60)} 分钟，${p.responsibility.bySegment.length} 个责任环节`);
  }
});

const driver = new DirectDriver(service);
console.log(`开始回放运输批次 ${BATCH.code}（基准时刻 ${fmtMin(T0)}，UTC+8）...\n`);

const { total } = await runScenario(driver, {
  t0Sec: T0,
  onProgress: (kind, data) => {
    if (kind === 'shipment') console.log(`批次建档：${data.code}`);
    if (kind === 'assets') console.log(`已注册 ${data.vehicles} 个载具/温控位、${data.sensors} 个车载传感器\n`);
    if (kind === 'segment_start') console.log(`[${fmtMin(T0 + data.min * 60)}] 环节开始：${data.label} — ${data.party}`);
    if (kind === 'progress' && data.done === data.total) {
      console.log(`\n时间线回放完成，共处理 ${data.total} 个事件/读数。`);
    }
  },
});

void total;
const trace = service.traceShipment(BATCH.code);
console.log(renderReport(trace));
