// 按运输批次完整回溯：从事件日志重建的状态出发，生成一份结构化溯源报告
// 报告同时给出：时间线、温区符合度、超温明细、责任归因、篡改校验、合格结论
import { classifyTemperature, resolveZone, severityOf } from './zones.js';
import { runsOf, fmtDuration } from './timewindows.js';
import { buildSegments, attribute } from './responsibility.js';

const ISO = (ts) => new Date(ts).toISOString();

// 找到越限游程真正越过阈值边界的时刻（最后带内点与首个越限点之间线性插值）
function crossingTime(prev, first, zone, direction) {
  if (!prev) return first.ts;
  const boundary = direction === 'high' ? zone.max : zone.min;
  if ((direction === 'high' && prev.tempC >= boundary) || (direction === 'low' && prev.tempC <= boundary)) {
    return first.ts; // 前一点本身就在边界上/外，无法前推
  }
  if (first.tempC === prev.tempC) return first.ts;
  const ratio = (boundary - prev.tempC) / (first.tempC - prev.tempC);
  if (ratio <= 0 || ratio >= 1) return first.ts;
  return Math.round(prev.ts + ratio * (first.ts - prev.ts));
}

// 越限恢复到带内的时刻
function recoveryTime(last, next) {
  if (!next) return last.ts; // 批次结束仍未恢复
  return next.ts;
}

/**
 * 分析单个传感器在批次时间范围内的读数。
 * 返回 { stats, excursions:[{...含责任归因}], excused:[开门波动], gaps:[] }
 */
export function analyzeSensor(sensor, readings, ctx) {
  const { zone, batch, segments, segmentFlags, handovers, gapMs, bounds } = ctx;
  const inRange = readings.filter((r) => r.ts >= bounds.start && r.ts <= bounds.end);

  let inMs = 0;
  let outMs = 0;
  const excursions = [];
  const excused = [];
  let maxDeviation = 0;
  let minTemp = Infinity;
  let maxTemp = -Infinity;

  for (let i = 0; i < inRange.length; i++) {
    const cur = inRange[i];
    minTemp = Math.min(minTemp, cur.tempC);
    maxTemp = Math.max(maxTemp, cur.tempC);
    const c = classifyTemperature(cur.tempC, zone);
    if (c.status !== 'in') maxDeviation = Math.max(maxDeviation, c.deviationC);
    if (i < inRange.length - 1) {
      const next = inRange[i + 1];
      // 以区间中点归类，避免把插值误差算到边界两侧
      const mid = (cur.tempC + next.tempC) / 2;
      const dt = next.ts - cur.ts;
      if (classifyTemperature(mid, zone).status === 'in') inMs += dt;
      else outMs += dt;
    }
  }

  const runs = runsOf(inRange, (t) => classifyTemperature(t, zone));
  runs.forEach((run, idx) => {
    if (run.status === 'in') return;
    const first = run.readings[0];
    const last = run.readings[run.readings.length - 1];
    const firstIdx = indexOfReading(inRange, first);
    const prev = firstIdx > 0 ? inRange[firstIdx - 1] : null;
    const lastIdx = indexOfReading(inRange, last);
    const next = lastIdx >= 0 && lastIdx + 1 < inRange.length ? inRange[lastIdx + 1] : null;
    const rawStart = crossingTime(prev, first, zone, run.status);
    const rawEnd = recoveryTime(last, next);
    const rawDurationMs = rawEnd - rawStart;

    const dur = rawDurationMs;
    const maxDev = Math.max(...run.readings.map((r) => classifyTemperature(r.tempC, zone).deviationC));
    const peak = run.readings.reduce((a, b) =>
      Math.abs(classifyTemperature(b.tempC, zone).deviationC) >
      Math.abs(classifyTemperature(a.tempC, zone).deviationC) ? b : a);

    const base = {
      sensorId: sensor.id,
      sensorLabel: sensor.label || sensor.id,
      direction: run.status,
      directionLabel: run.status === 'high' ? '温度偏高（超上限）' : '温度偏低（超下限）',
      rawStart,
      rawEnd,
      recovered: Boolean(next),
      peakTempC: peak.tempC,
      peakTs: peak.ts,
      maxDeviationC: maxDev,
      severity: severityOf(maxDev),
      rawDurationMs: dur,
      rawDurationLabel: fmtDuration(dur),
    };

    if (dur <= zone.toleranceMs) {
      excused.push({ ...base, reason: `越限 ${fmtDuration(dur)} 未超过温区容忍时长 ${fmtDuration(zone.toleranceMs)}，判定为开门/化霜类正常波动` });
      return;
    }
    const window = { start: rawStart + zone.toleranceMs, end: rawEnd };
    const anomaly = { ...base, kind: 'excursion', window };
    const attribution = attribute(anomaly, { zone, batch, segments, segmentFlags, handovers });
    excursions.push({
      ...base,
      toleranceMs: zone.toleranceMs,
      windowStart: window.start,
      windowEnd: window.end,
      chargeableDurationMs: window.end - window.start,
      chargeableDurationLabel: fmtDuration(window.end - window.start),
      attribution,
    });
  });

  // 数据中断（读数间隔超阈值）
  const gaps = [];
  for (let i = 1; i < inRange.length; i++) {
    const dt = inRange[i].ts - inRange[i - 1].ts;
    if (dt > gapMs) {
      const window = { start: inRange[i - 1].ts, end: inRange[i].ts };
      const anomaly = {
        kind: 'gap',
        rawStart: window.start,
        direction: null,
        window,
        durationMs: dt,
        sensorId: sensor.id,
        sensorLabel: sensor.label || sensor.id,
      };
      const attribution = attribute(anomaly, { zone, batch, segments, segmentFlags, handovers });
      gaps.push({
        sensorId: sensor.id,
        sensorLabel: sensor.label || sensor.id,
        start: window.start,
        end: window.end,
        durationMs: dt,
        durationLabel: fmtDuration(dt),
        attribution,
      });
    }
  }

  return {
    sensor: { id: sensor.id, label: sensor.label || sensor.id, position: sensor.position },
    count: inRange.length,
    firstTs: inRange[0]?.ts ?? null,
    lastTs: inRange[inRange.length - 1]?.ts ?? null,
    minTempC: inRange.length ? +minTemp.toFixed(2) : null,
    maxTempC: inRange.length ? +maxTemp.toFixed(2) : null,
    maxDeviationC: +maxDeviation.toFixed(2),
    inMs,
    outMs,
    compliancePct: inMs + outMs === 0 ? 100 : +((inMs / (inMs + outMs)) * 100).toFixed(1),
    inDurationLabel: fmtDuration(inMs),
    outDurationLabel: fmtDuration(outMs),
    excursions,
    excused,
    gaps,
  };
}

function indexOfReading(arr, target) {
  return arr.findIndex((r) => r.ts === target.ts && r.tempC === target.tempC && r.sensorId === target.sensorId);
}

/**
 * 生成批次完整溯源报告
 * @param state 从事件日志重放得到的全部状态
 * @param batchId
 * @param verifyResult 哈希链校验结果（由 store 提供）
 */
export function buildTraceReport(state, batchId, verifyResult) {
  const batch = state.batches[batchId];
  if (!batch) return null;
  const zone = resolveZone(batch.zone);

  const handovers = state.handovers
    .filter((h) => h.batchId === batchId)
    .sort((a, b) => a.ts - b.ts);

  const sensors = state.sensors.filter((s) => batch.sensorIds.includes(s.id));
  const readings = state.readings.filter((r) => r.batchId === batchId).sort((a, b) => a.ts - b.ts);

  const timePoints = [
    ...readings.map((r) => r.ts),
    ...handovers.map((h) => h.ts),
    ...(batch.startedAt ? [batch.startedAt] : []),
  ];
  const bounds = { start: Math.min(...timePoints), end: Math.max(...timePoints) };

  const { segments, flags: segmentFlags } = buildSegments(batch, handovers, bounds.start, bounds.end);

  const ctx = { zone, batch, segments, segmentFlags, handovers, gapMs: state.gapMs, bounds };
  const sensorReports = sensors.map((s) =>
    analyzeSensor(s, readings.filter((r) => r.sensorId === s.id), ctx));

  const excursions = sensorReports.flatMap((s) => s.excursions).sort((a, b) => a.rawStart - b.rawStart);
  const excused = sensorReports.flatMap((s) => s.excused).sort((a, b) => a.rawStart - b.rawStart);
  const gaps = sensorReports.flatMap((s) => s.gaps).sort((a, b) => a.start - b.start);

  // 责任分布（按计责时长汇总）
  const liability = new Map();
  for (const ex of excursions) {
    for (const c of ex.attribution.contributions) {
      const key = c.stage;
      const cur = liability.get(key) || {
        stage: c.stage,
        stageLabel: c.stageLabel,
        party: c.party,
        chargeableMs: 0,
        excursionCount: 0,
      };
      cur.chargeableMs += c.durationMs;
      liability.set(key, cur);
    }
    const p = ex.attribution.primaryStage;
    if (liability.has(p)) liability.get(p).excursionCount += 1;
  }
  const liabilityDistribution = [...liability.values()]
    .map((l) => ({ ...l, chargeableDurationLabel: fmtDuration(l.chargeableMs) }))
    .sort((a, b) => b.chargeableMs - a.chargeableMs);

  const criticalCount = excursions.filter((e) => e.severity === 'critical').length;
  const majorCount = excursions.filter((e) => e.severity === 'major').length;

  let conclusion;
  if (excursions.length) {
    conclusion = {
      status: 'FAIL',
      label: '不合格：存在超出容忍时长的温度越限',
      reasons: excursions.map(
        (e) =>
          `${e.directionLabel}，${e.rawStart ? ISO(e.rawStart) : ''} 起持续 ${e.chargeableDurationLabel}，峰值 ${e.peakTempC}°C，主责：${e.attribution.primaryStageLabel}${e.attribution.primaryParty ? `（${e.attribution.primaryParty.name}）` : ''}`,
      ),
    };
  } else if (gaps.length) {
    conclusion = {
      status: 'REVIEW',
      label: '存疑：温度未超温但存在传感器数据中断，需人工核查',
      reasons: gaps.map((g) => `数据中断 ${g.durationLabel}（${ISO(g.start)} ~ ${ISO(g.end)}）`),
    };
  } else {
    conclusion = { status: 'PASS', label: '合格：全程温度符合温区要求', reasons: [] };
  }

  return {
    reportVersion: 1,
    generatedAt: ISO(Date.now()),
    batch: {
      id: batch.id,
      code: batch.code,
      product: batch.product,
      quantity: batch.quantity,
      zone,
      shipper: batch.shipper,
      carrier: batch.carrier,
      vehicleId: batch.vehicleId,
      consignee: batch.consignee,
      route: batch.route,
      startedAt: batch.startedAt ? ISO(batch.startedAt) : null,
      finishedAt: batch.finishedAt ? ISO(batch.finishedAt) : null,
      status: batch.status,
    },
    custody: {
      handovers: handovers.map((h) => ({
        id: h.id,
        stage: h.stage,
        ts: ISO(h.ts),
        holder: h.holder,
        measuredTempC: h.measuredTempC,
        tempVerdict: classifyTemperature(h.measuredTempC, zone).status,
        note: h.note || null,
      })),
      segments: segments.map((s) => ({
        stage: s.stage,
        label: s.label,
        start: ISO(s.start),
        end: ISO(s.end),
        durationLabel: fmtDuration(s.end - s.start),
        party: s.party
          ? { id: s.party.id, name: s.party.name, contact: s.party.contact || undefined, vehicleId: s.party.vehicleId || undefined }
          : null,
      })),
      flags: segmentFlags,
    },
    sensors: sensorReports.map((s) => ({
      sensor: s.sensor,
      count: s.count,
      firstTs: s.firstTs ? ISO(s.firstTs) : null,
      lastTs: s.lastTs ? ISO(s.lastTs) : null,
      minTempC: s.minTempC,
      maxTempC: s.maxTempC,
      maxDeviationC: s.maxDeviationC,
      compliancePct: s.compliancePct,
      inDurationLabel: s.inDurationLabel,
      outDurationLabel: s.outDurationLabel,
    })),
    excursionCount: excursions.length,
    severitySummary: { critical: criticalCount, major: majorCount, minor: excursions.length - criticalCount - majorCount },
    excursions: excursions.map((e) => ({
      ...e,
      rawStart: ISO(e.rawStart),
      rawEnd: ISO(e.rawEnd),
      windowStart: ISO(e.windowStart),
      windowEnd: ISO(e.windowEnd),
      peakTs: ISO(e.peakTs),
      attribution: {
        rule: e.attribution.rule,
        primaryStage: e.attribution.primaryStage,
        primaryStageLabel: e.attribution.primaryStageLabel,
        primaryParty: e.attribution.primaryParty,
        contributions: e.attribution.contributions.map((c) => ({ ...c, durationLabel: fmtDuration(c.durationMs) })),
        evidence: e.attribution.evidence,
        flags: e.attribution.flags,
      },
    })),
    excusedFluctuations: excused.map((e) => ({
      ...e,
      rawStart: ISO(e.rawStart),
      rawEnd: ISO(e.rawEnd),
      peakTs: ISO(e.peakTs),
    })),
    dataGaps: gaps.map((g) => ({
      ...g,
      start: ISO(g.start),
      end: ISO(g.end),
      attribution: {
        rule: g.attribution.rule,
        primaryStage: g.attribution.primaryStage,
        primaryStageLabel: g.attribution.primaryStageLabel,
        primaryParty: g.attribution.primaryParty,
        evidence: g.attribution.evidence,
        flags: g.attribution.flags,
      },
    })),
    liabilityDistribution,
    timeline: buildTimeline(bounds, readings, handovers, sensors, zone),
    integrity: verifyResult,
    conclusion,
  };
}

// 关键事件时间线（交接 + 超温起止 + 数据中断），供前端逐环节回溯
function buildTimeline(bounds, readings, handovers, sensors, zone) {
  const items = [];
  for (const h of handovers) {
    const v = classifyTemperature(h.measuredTempC, zone);
    items.push({
      ts: h.ts,
      tsIso: ISO(h.ts),
      type: 'handover',
      stage: h.stage,
      title: `${h.holder} · ${stageName(h.stage)}`,
      detail: `实测 ${h.measuredTempC}°C（${v.status === 'in' ? '合格' : '越限'}）${h.note ? '；' + h.note : ''}`,
      level: v.status === 'in' ? 'ok' : 'danger',
    });
  }
  return { start: ISO(bounds.start), end: ISO(bounds.end), totalLabel: fmtDuration(bounds.end - bounds.start), items: items.sort((a, b) => a.ts - b.ts) };
}

function stageName(stage) {
  return { departure: '发运交接', transit: '中转交接', arrival: '到货交接', signoff: '签收' }[stage] || stage;
}
