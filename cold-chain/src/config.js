// 全局配置：全部可经环境变量覆盖，零依赖读取
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const DATA_DIR = process.env.COLDCHAIN_DATA_DIR || resolve(ROOT, 'data');

mkdirSync(DATA_DIR, { recursive: true });

export const config = {
  port: Number(process.env.PORT || 3100),
  // 设备/模拟器上报网关时携带的令牌：Authorization: Bearer <token>
  gatewayToken: process.env.GATEWAY_TOKEN || 'dev-token',
  // 同一传感器判定"数据中断"的读数间隔上限（毫秒）
  sensorGapMs: Number(process.env.SENSOR_GAP_MS || 5 * 60 * 1000),
  // 温度超出传感器物理量程时拒绝入库（坏数据门禁）
  plausibleRange: Object.freeze({ min: -60, max: 80 }),
  // 事件日志与状态快照文件
  eventLog: resolve(DATA_DIR, 'events.jsonl'),
  stateFile: resolve(DATA_DIR, 'state.json'),
};

// 预置温区模板（也允许批次自带自定义温区）
export const ZONE_TEMPLATES = Object.freeze({
  // 冷冻：-25 ~ -18°C，允许单次开门/化霜导致的短时超限 ≤ 10 分钟
  frozen: Object.freeze({ id: 'frozen', name: '冷冻', min: -25, max: -18, toleranceMs: 10 * 60 * 1000 }),
  // 冷藏：0 ~ 8°C，容忍 ≤ 15 分钟
  chilled: Object.freeze({ id: 'chilled', name: '冷藏', min: 0, max: 8, toleranceMs: 15 * 60 * 1000 }),
  // 医药（疫苗等）：2 ~ 8°C，容忍 ≤ 5 分钟
  pharma: Object.freeze({ id: 'pharma', name: '医药 2-8°C', min: 2, max: 8, toleranceMs: 5 * 60 * 1000 }),
  // 深冻
  deepFrozen: Object.freeze({ id: 'deepFrozen', name: '深冻', min: -60, max: -30, toleranceMs: 10 * 60 * 1000 }),
});
