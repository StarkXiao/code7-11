// 责任环节定位
//
// 冷链三段责任：
//   发货方仓储（预装/预冷/装箱） → 承运方运输（车辆/冷机/司机） → 收货方仓储（卸货/入库）
// 段与段之间以"交接记录"为界，交接时的实测温度是划分责任的关键证据：
//   - 发运时温度已越限：发货方预冷/打冷不合格，承运人收到的就是热货
//   - 到货时温度越限：运输交付物不合格，责任在运输段
//   - 签收温度合格、到货后才超温：收货方卸货延误/冷库打冷不及时
// 交接记录缺失时按读数时间推断边界，并在结论中标注"边界为推断"。

import { classifyTemperature } from './zones.js';
import { splitWindowBySegments, fmtDuration } from './timewindows.js';

const STAGE_META = {
  storage_origin: { stage: 'storage_origin', label: '发货方仓储' },
  transport: { stage: 'transport', label: '承运方运输' },
  storage_dest: { stage: 'storage_dest', label: '收货方仓储' },
  unattributed: { stage: 'unattributed', label: '无法定位' },
};

function partyOf(batch, stage) {
  if (stage === 'storage_origin') return batch.shipper || null;
  if (stage === 'transport') return batch.carrier ? { ...batch.carrier, vehicleId: batch.vehicleId } : null;
  if (stage === 'storage_dest') return batch.consignee || null;
  return null;
}

/**
 * 由批次时间范围与交接记录构造责任段。
 * @param timelineStart {number} 首条读数/交接的最早时间
 * @param timelineEnd   {number} 末条读数/交接的最晚时间
 */
export function buildSegments(batch, handovers, timelineStart, timelineEnd) {
  const byStage = new Map(handovers.map((h) => [h.stage, h]));
  const departure = byStage.get('departure');
  const arrival = byStage.get('arrival');
  const segments = [];
  const flags = [];

  if (!departure) flags.push('缺少发运交接记录，运输段起点按最早读数推断');
  if (!arrival) flags.push('缺少到货交接记录，运输段终点按最晚读数推断');

  const depTs = departure ? departure.ts : timelineStart;
  const arrTs = arrival ? arrival.ts : timelineEnd;

  // 越限起始可能恰好等于发运时刻（甚至插值到发运之前）。
  // 用 <= 保留零长度的发货方段，保证"主责在发货方仓储"时该段必然可见。
  if (timelineStart <= depTs) {
    segments.push({
      ...STAGE_META.storage_origin,
      start: timelineStart,
      end: depTs,
      party: partyOf(batch, 'storage_origin'),
      endHandover: departure || null,
    });
  }
  segments.push({
    ...STAGE_META.transport,
    start: depTs,
    end: arrTs,
    party: partyOf(batch, 'transport'),
    startHandover: departure || null,
    endHandover: arrival || null,
  });
  if (timelineEnd >= arrTs) {
    segments.push({
      ...STAGE_META.storage_dest,
      start: arrTs,
      end: timelineEnd,
      party: partyOf(batch, 'storage_dest'),
      startHandover: arrival || null,
    });
  }
  return { segments, flags };
}

function tempEvidence(label, handover, zone, wantDirection) {
  if (!handover || typeof handover.measuredTempC !== 'number') return null;
  const c = classifyTemperature(handover.measuredTempC, zone);
  const mark = c.status === 'in' ? '合格' : `越限 ${c.deviationC}°C（${c.status === 'high' ? '偏高' : '偏低'}）`;
  return {
    matches: c.status === wantDirection,
    text: `${label}实测 ${handover.measuredTempC}°C，${mark}（交接记录 ${handover.id}，${handover.holder}）`,
  };
}

/**
 * 定位一个异常窗口（超温或数据中断）的责任环节。
 * @param anomaly 已结案的异常：含 window{start,end}、rawStart（首次越限时刻）、direction
 * @param ctx     { zone, batch, segments, segmentFlags, handovers }
 */
export function attribute(anomaly, ctx) {
  const { zone, batch, segments, segmentFlags = [], handovers = [] } = ctx;
  const win = anomaly.window;
  const pieces = splitWindowBySegments(win, segments);
  const total = pieces.reduce((s, p) => s + p.durationMs, 0) || 1;

  const contributions = pieces.map((p) => ({
    stage: p.segment.stage,
    stageLabel: p.segment.label,
    party: p.segment.party,
    durationMs: p.durationMs,
    pct: Math.round((p.durationMs / total) * 1000) / 10,
  }));

  const evidence = [];
  const departure = handovers.find((h) => h.stage === 'departure');
  const arrival = handovers.find((h) => h.stage === 'arrival');
  const signoff = handovers.find((h) => h.stage === 'signoff');
  const depEv = tempEvidence('发运交接', departure, zone, anomaly.direction);
  const arrEv = tempEvidence('到货交接', arrival, zone, anomaly.direction);
  const signEv = signoff ? tempEvidence('签收', signoff, zone, anomaly.direction) : null;

  let rule;
  let primaryStage;
  let share;

  // 规则 1：首次越限发生在发运之前，且发运交接温度同方向越限 => 预冷/打冷不合格
  if (
    anomaly.direction &&
    anomaly.rawStart <= (departure?.ts ?? Infinity) &&
    depEv?.matches
  ) {
    rule = 'PRE_COOL_FAILURE';
    primaryStage = 'storage_origin';
    evidence.push(depEv.text);
    evidence.push('车辆发运时货物温度已越限，说明装箱前未按温区充分预冷/打冷');
    // 承运人在越限温度下放行，若超温延续到运输段，承担次要责任
    share = contributions.find((c) => c.stage === 'transport');
    if (share && share.durationMs > 0) {
      evidence.push(`承运人未拒收热货即发运，运输段内继续超温 ${fmtDuration(share.durationMs)}，承担次要责任`);
    }
  }
  // 规则 2：到货交接温度同方向越限 => 运输交付不合格
  else if (anomaly.direction && arrEv?.matches && win.start < (arrival?.ts ?? Infinity)) {
    rule = 'IN_TRANSIT_FAULT';
    primaryStage = 'transport';
    evidence.push(arrEv.text);
    evidence.push('到货开门测温即越限，运输段交付温度不合格');
    const destShare = contributions.find((c) => c.stage === 'storage_dest');
    if (destShare && destShare.durationMs > 0) {
      evidence.push(`到货后温度仍未恢复，收货方${signoff ? '签收前滞留' : '未签收'}期间继续计责 ${fmtDuration(destShare.durationMs)}，承担次要责任`);
    }
  }
  // 规则 3：异常完全发生在到货之后（签收合格后升温 => 收货方卸货/入库环节）
  else if (arrival && win.start >= arrival.ts) {
    rule = 'DEST_HANDLING';
    primaryStage = 'storage_dest';
    if (signEv) evidence.push(signEv.text);
    evidence.push(signEv?.text?.includes('合格')
      ? '签收温度合格，异常发生在收货之后：卸货延误或冷库打冷不及时'
      : '异常全部发生在到货之后，归收货方仓储/卸货环节');
  }
  // 规则 4：数据中断或无决定性边界证据时，按异常时长在各段的占比归因
  else {
    rule = anomaly.kind === 'gap' ? 'GAP_BY_SEGMENT_SHARE' : 'BY_SEGMENT_SHARE';
    const sorted = [...contributions].sort((a, b) => b.durationMs - a.durationMs);
    primaryStage = sorted[0]?.stage ?? 'unattributed';
    if (anomaly.kind === 'gap') {
      evidence.push('传感器数据中断，按中断窗口与各责任段的时间重叠度归因');
    }
  }

  // 占比证据（所有规则通用）
  if (contributions.length) {
    evidence.push(
      '异常计时分布：' +
        contributions
          .map((c) => `${c.stageLabel} ${fmtDuration(c.durationMs)}（${c.pct}%）`)
          .join('，'),
    );
  }

  const primary = contributions.find((c) => c.stage === primaryStage);
  // 纯边界规则命中（如到货测温越限）但窗口已被恢复得很快导致无计责时长时，仍给出主责
  const party = primary?.party || partyOf(batch, primaryStage);

  return {
    rule,
    primaryStage,
    primaryStageLabel: STAGE_META[primaryStage]?.label || '无法定位',
    primaryParty: party
      ? { id: party.id, name: party.name, contact: party.contact || undefined, vehicleId: party.vehicleId || undefined }
      : null,
    contributions,
    evidence,
    flags: [...segmentFlags],
  };
}
