/**
 * 车载温度模拟器。
 *
 * - 按关键帧做分段线性插值（真实温度是连续变化的）；
 * - 叠加固定种子的微小噪声（同一次演示结果可复现）；
 * - 通过 Driver 适配层推送：direct 直连内存服务（本地演示）或 http 推到运行中的 API。
 */

import {
  SAMPLE_INTERVAL_MIN,
  NOISE_SEED,
  NOISE_AMP,
  CURVE_TRUCK,
  CURVE_DOCK,
  CURVE_VAN,
  READING_RANGES,
} from './scenario.js';

/** 可复现的伪随机：mulberry32 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 分段线性插值关键帧曲线 */
export function interpolate(frames, min) {
  if (min <= frames[0][0]) return frames[0][1];
  for (let i = 0; i < frames.length - 1; i++) {
    const [m0, v0] = frames[i];
    const [m1, v1] = frames[i + 1];
    if (min >= m0 && min <= m1) {
      return v0 + ((v1 - v0) * (min - m0)) / (m1 - m0);
    }
  }
  return frames[frames.length - 1][1];
}

const CURVES = {
  'T-1001': CURVE_TRUCK,
  'T-1002': CURVE_DOCK,
  'T-1003': CURVE_VAN,
};

/**
 * 生成全部读数（相对 T0 的绝对时间）。
 * @param {number} t0Sec 基准时刻 epoch 秒
 * @returns {Array<{sensor_code:string, ts:number, temp:number, min:number}>}
 */
export function generateReadings(t0Sec) {
  const rand = mulberry32(NOISE_SEED);
  const out = [];
  for (const range of READING_RANGES) {
    const frames = CURVES[range.sensor];
    for (let m = range.fromMin; m <= range.toMin; m += SAMPLE_INTERVAL_MIN) {
      const noise = (rand() - 0.5) * 2 * NOISE_AMP;
      const temp = Math.round((interpolate(frames, m) + noise) * 10) / 10;
      out.push({
        sensor_code: range.sensor,
        ts: t0Sec + m * 60,
        temp,
        min: m,
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts || a.sensor_code.localeCompare(b.sensor_code));
}
