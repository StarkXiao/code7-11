/**
 * 时间工具。系统内部一律使用 epoch 秒（UTC，浮点数）；
 * 展示层固定按北京时间（UTC+8）渲染，与运输场景一致，避免夏令时歧义。
 */

const SHANGHAI_OFFSET_MIN = 8 * 60;

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

/**
 * 把 epoch 秒格式化为 "YYYY-MM-DD HH:mm:ss"（UTC+8）。
 */
export function fmt(epochSec) {
  if (epochSec === null || epochSec === undefined) return '';
  // 取 UTC 字段后人工加 8 小时偏移，结果与运行机器时区无关
  const utc = new Date(epochSec * 1000 + SHANGHAI_OFFSET_MIN * 60_000);
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ` +
    `${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}`;
}

/** "YYYY-MM-DD HH:mm" 短格式（UTC+8） */
export function fmtMin(epochSec) {
  return fmt(epochSec).slice(0, 16);
}

/** 当前 epoch 秒 */
export function nowSec() {
  return Date.now() / 1000;
}

/**
 * 兼容地把入参解析为 epoch 秒：
 *  - number：视为 epoch 秒（< 10^11 时）；若看起来像毫秒则换算
 *  - string：交给 Date 解析（要求 ISO 8601，建议带时区）
 */
export function toSec(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e11 ? v / 1000 : v;
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new Error(`无法解析的时间: ${v}`);
    return t / 1000;
  }
  throw new Error(`无法解析的时间: ${String(v)}`);
}

/** 输出为带时区的 ISO 字符串 */
export function toIso(epochSec) {
  return new Date(epochSec * 1000).toISOString();
}

/** 分钟差 */
export function minutes(aSec, bSec) {
  return Math.round(((aSec - bSec) / 60) * 10) / 10;
}
