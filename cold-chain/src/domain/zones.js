// 温区判定：纯函数，可独立测试
import { ZONE_TEMPLATES } from '../config.js';

export function resolveZone(zoneInput) {
  if (!zoneInput) throw new Error('缺少温区配置');
  if (typeof zoneInput === 'string') {
    const tpl = ZONE_TEMPLATES[zoneInput];
    if (!tpl) throw new Error(`未知温区模板: ${zoneInput}`);
    return { ...tpl };
  }
  const { id, name, min, max, toleranceMs } = zoneInput;
  if (typeof min !== 'number' || typeof max !== 'number' || min >= max) {
    throw new Error('温区上下限非法（要求 min < max，均为数字）');
  }
  if (typeof toleranceMs !== 'number' || toleranceMs < 0) {
    throw new Error('温区容忍时长 toleranceMs 非法');
  }
  return {
    id: id || 'custom',
    name: name || `自定义 ${min}~${max}°C`,
    min,
    max,
    toleranceMs,
  };
}

/**
 * 判定一个温度读数落在温区的哪个位置。
 * 返回 high(超上限) / low(超下限) / in(带内)，以及越限幅度°C。
 */
export function classifyTemperature(tempC, zone) {
  if (typeof tempC !== 'number' || Number.isNaN(tempC)) {
    throw new Error('温度必须是数字');
  }
  if (tempC > zone.max) return { status: 'high', deviationC: +(tempC - zone.max).toFixed(2) };
  if (tempC < zone.min) return { status: 'low', deviationC: +(zone.min - tempC).toFixed(2) };
  return { status: 'in', deviationC: 0 };
}

/**
 * 按"超出容忍时长才算超温"的规则，把连续越限区间量化。
 * 输入一条连续越限游程（同一方向 high/low，区间 [start,end] 内全程越限），
 * 输出其中真正计为超温的窗口：
 *   - 游程时长 ≤ toleranceMs：属于开门/化霜等正常波动，不产生超温
 *   - 否则容忍窗口被"豁免"，从越限开始时刻起 toleranceMs 之后的部分计为超温
 *
 * 注意：容忍时长是豁免而非延迟告警——系统在越限开始时即进入 watching 实时预警，
 * 只是最终责任计时从越过容忍线起算。这样既不漏报，也不把开门装卸误判成事故。
 */
export function quantifyRun(runStart, runEnd, toleranceMs) {
  const durationMs = runEnd - runStart;
  if (durationMs <= toleranceMs) {
    return { excused: true, window: null, durationMs };
  }
  const windowStart = runStart + toleranceMs;
  return {
    excused: false,
    window: { start: windowStart, end: runEnd },
    durationMs: runEnd - windowStart,
    rawDurationMs: durationMs,
  };
}

// 严重程度分级（基于最大越限幅度）
export function severityOf(maxDeviationC) {
  if (maxDeviationC >= 8) return 'critical';
  if (maxDeviationC >= 3) return 'major';
  return 'minor';
}
