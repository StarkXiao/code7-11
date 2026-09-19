/**
 * 判定引擎：纯函数，不碰存储。
 *
 * 责任拆分思路
 * ------------
 * 温度采样是阶跃函数：每条读数 r_i 的测量值代表区间 [ts_i, ts_{i+1}) 内的
 * 实际温度（保持到下一次采样）；报警闭环读数之后的区间自然不再计入。
 * 把所有越限读数的区间与各承运环节的"虚拟承运区间"求交，即可把一次
 * 跨交接的超温精确拆到多个责任方：
 *
 *   环节 i 的虚拟承运区间 = [本环节开始, 下一环节开始)，最后一个环节到批次结束。
 *
 * 交接空档（如月台卸货后下一车还没发）默认归上一环节，即"交出去之前都算我的"。
 * 报警仍开启时，最后一条越限读数的区间延伸到 liveUntil（调用方传当前时刻）。
 */

import { SEVERITY_RULES } from './config.js';

/**
 * 判定单条读数是否越限。
 * @returns {{ok:boolean, direction:null|'high'|'low', deviation:number}}
 */
export function evaluateTemp(temp, minTemp, maxTemp) {
  if (temp > maxTemp) {
    return { ok: false, direction: 'high', deviation: round1(temp - maxTemp) };
  }
  if (temp < minTemp) {
    return { ok: false, direction: 'low', deviation: round1(minTemp - temp) };
  }
  return { ok: true, direction: null, deviation: 0 };
}

/**
 * 依据最大偏离与持续时长判定严重程度，就高不就低。
 * @param {number} deviation 最大偏离 °C
 * @param {number} durationMin 超温时长（分钟）
 * @returns {'trivial'|'minor'|'major'}
 */
export function severityFor(deviation, durationMin) {
  const m = SEVERITY_RULES.major;
  const n = SEVERITY_RULES.minor;
  if (deviation >= m.deviation || durationMin >= m.durationMin) return 'major';
  if (deviation >= n.deviation || durationMin >= n.durationMin) return 'minor';
  return 'trivial';
}

/**
 * 找到某时刻承运某车厢的环节。
 * 环节按开始时间排序；custodyEnd 取"下一环节开始时间"（无下家则为 +∞），
 * 落在交接空档的时刻归上一环节。
 *
 * @param {Array<{id:string,vehicle_id:string,compartment:string,
 *                started_at:number, custodyEnd?:number}>} segments
 * @returns {object|null} 匹配的环节（带 custodyEnd），无匹配为 null
 */
export function segmentAt(segments, vehicleId, compartment, ts) {
  // 先按"车厢"的承运链定位时刻（跨载具，按开始时间排序）
  const chain = segments
    .filter((s) => s.compartment === compartment)
    .sort((a, b) => a.started_at - b.started_at);

  let current = null;
  for (const s of chain) {
    if (s.started_at <= ts) current = s;
    else break;
  }
  if (!current) return null;

  // 该时刻的在途责任载具不是上报传感器所在载具：
  // 下一环节已换车（旧车读数为孤儿），或读数来自无关车辆。
  // 注意：交接空档（当前环节已结束、下家尚未开始）时仍归当前环节的载具。
  if (current.vehicle_id !== vehicleId) return null;

  const idx = chain.indexOf(current);
  const next = chain[idx + 1];
  return { ...current, custodyEnd: next ? next.started_at : Infinity };
}

/**
 * 把一次超温报警拆分到各责任环节。
 *
 * @param {object} alarm 报警（含 readings：越限读数明细，按时间升序）
 * @param {Array} readings 该车厢全部读数（用于取下一条读数的时间戳）
 * @param {Array} segments 批次环节列表
 * @param {number|null} liveUntil 报警仍开启时延伸到的时刻（通常为当前时刻）；已关闭传 null
 * @returns {{totalSec:number, bySegment:Array, peak:{temp:number,at:number,segmentId:string}|null}}
 *   bySegment: [{segment_id, party, stage, seconds, reading_count, peak_temp}]
 */
export function splitResponsibility(alarm, readings, segments, liveUntil = null) {
  const excursionIds = new Set(alarm.readings.map((r) => r.id));
  const chain = readings
    .filter((r) => r.compartment === alarm.compartment)
    .sort((a, b) => a.ts - b.ts);

  // 计算虚拟承运区间：按"车厢"的环节链（跨载具），不按车辆。
  // 本环节 [started_at, 下一环节 started_at)，空档时间归上一环节。
  const ordered = segments
    .filter((s) => s.compartment === alarm.compartment)
    .sort((a, b) => a.started_at - b.started_at)
    .map((s, i, arr) => ({
      ...s,
      custStart: s.started_at,
      custEnd: arr[i + 1] ? arr[i + 1].started_at : Infinity,
    }));

  const buckets = new Map(); // segmentId -> 累计
  let peak = null;
  let totalSec = 0;

  for (let i = 0; i < chain.length; i++) {
    const r = chain[i];
    if (!excursionIds.has(r.id)) continue;

    // 阶跃模型：该读数的温度保持到下一条读数；
    // 最后一条越限读数若报警仍开启，延伸到 liveUntil。
    const next = chain[i + 1];
    let intervalEnd = next ? next.ts : r.ts;
    if ((!next || !excursionIds.has(next.id)) && liveUntil != null) {
      intervalEnd = Math.max(intervalEnd, liveUntil);
    }
    if (intervalEnd <= r.ts) continue;

    for (const s of ordered) {
      const lo = Math.max(r.ts, s.custStart);
      const hi = Math.min(intervalEnd, s.custEnd);
      if (hi > lo) {
        let b = buckets.get(s.id);
        if (!b) {
          b = {
            segment_id: s.id,
            party: s.party,
            stage: s.stage,
            vehicle_id: s.vehicle_id,
            seconds: 0,
            reading_count: 0,
            peak_temp: -Infinity,
            peak_at: null,
          };
          buckets.set(s.id, b);
        }
        b.seconds += hi - lo;
        b.reading_count += 1;
        if (r.temp > b.peak_temp) {
          b.peak_temp = r.temp;
          b.peak_at = r.ts;
        }
        totalSec += hi - lo;
        if (!peak || r.temp > peak.temp) {
          peak = { temp: r.temp, at: r.ts, segmentId: s.id };
        }
      }
    }
  }

  const bySegment = [...buckets.values()]
    .map((b) => ({
      ...b,
      seconds: Math.round(b.seconds),
      peak_temp: b.peak_temp === -Infinity ? null : round1(b.peak_temp),
    }))
    .sort((a, b) => b.seconds - a.seconds);

  return { totalSec: Math.round(totalSec), bySegment, peak };
}

/** 批次结论：全部达标 / 有超温 */
export function verdictFor(alarms) {
  const open = alarms.filter((a) => a.status === 'open');
  const confirmed = alarms.filter((a) => a.severity !== 'trivial');
  if (open.length) {
    return { code: 'EXCURSION_OPEN', label: '存在未闭环超温报警', compliant: false };
  }
  if (confirmed.length) {
    return { code: 'EXCURSION_CLOSED', label: '运输过程发生超温（已闭环），需质量评估', compliant: false };
  }
  if (alarms.length) {
    return { code: 'TRIVIAL_ONLY', label: '仅有瞬时轻微波动，整体达标', compliant: true };
  }
  return { code: 'COMPLIANT', label: '全程温度达标', compliant: true };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
