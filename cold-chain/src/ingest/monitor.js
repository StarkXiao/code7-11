// 实时超温判定引擎
//
// 每个 (批次, 传感器) 维护一个三态有限状态机：
//
//   normal ──读数越限──▶ watching ──持续越限超过容忍时长──▶ alarming（超温事件开启）
//     ▲                    │                                   │
//     └────读数回到带内────┘                                   │
//     （短时波动，豁免，记为开门/化霜）                          │
//                          ◀────────读数回到带内────────────────┘
//                          （超温事件关闭，窗口=回到带内的时刻）
//
// 关键点：
//  - watching 状态立即向驾驶端/调度台推送"温度预警"，不延迟告警；
//    容忍时长只决定这段时间是否计入超温责任，避免开门装卸被误判为事故。
//  - 进程重启后通过重放事件日志重建状态机（开启中的超温事件恢复为 alarming）。
//  - 读数间隔超过 sensorGapMs 判定数据中断，单独记 data_gap_detected 事件。
import { randomUUID } from 'node:crypto';
import { classifyTemperature, resolveZone, severityOf } from '../domain/zones.js';

const keyOf = (batchId, sensorId) => `${batchId}|${sensorId}`;

function updatePeak(t, reading, deviationC) {
  if (deviationC >= t.maxDeviationC) {
    t.maxDeviationC = deviationC;
    t.peakTempC = reading.tempC;
    t.peakTs = reading.ts;
  }
}

export class Monitor {
  constructor(eventStore, { gapMs } = {}) {
    this.store = eventStore;
    this.gapMs = gapMs;
    this.trackers = new Map();
  }

  // 从事件日志重建状态机（启动时调用一次，不产生新事件）
  rebuild() {
    this.trackers.clear();
    this.gapMs = this.gapMs ?? this.store.state.gapMs;
    const { readings, activeExcursions, batches } = this.store.state;
    for (const r of readings) {
      const t = this.#tracker(r.batchId, r.sensorId);
      t.lastTs = r.ts;
      t.lastReading = r;
    }
    for (const ex of Object.values(activeExcursions)) {
      const t = this.#tracker(ex.batchId, ex.sensorId);
      const batch = batches[ex.batchId];
      t.status = 'alarming';
      t.direction = ex.direction;
      t.watchStart = ex.rawStart;
      t.excursionId = ex.id;
      t.peakTempC = ex.peakTempC ?? null;
      t.peakTs = ex.peakTs ?? null;
      t.maxDeviationC = ex.maxDeviationC ?? 0;
      t.zone = batch ? resolveZone(batch.zone) : t.zone;
    }
  }

  #tracker(batchId, sensorId) {
    const k = keyOf(batchId, sensorId);
    let t = this.trackers.get(k);
    if (!t) {
      t = {
        batchId,
        sensorId,
        status: 'normal',
        lastTs: null,
        lastReading: null,
        direction: null,
        watchStart: null,
        excursionId: null,
        peakTempC: null,
        peakTs: null,
        maxDeviationC: 0,
      };
      this.trackers.set(k, t);
    }
    return t;
  }

  /**
   * 处理一条已通过校验的读数。
   * @returns {Array<{signal:string,event?:object,reading:object}>} 本次读数触发的信号
   *   signal ∈ reading_ok / warning / excursion_started / excursion_recovered / fluctuation_excused / data_gap
   */
  async ingest(reading) {
    const batch = this.store.state.batches[reading.batchId];
    if (!batch) throw new Error(`批次不存在: ${reading.batchId}`);
    const zone = resolveZone(batch.zone);
    const t = this.#tracker(reading.batchId, reading.sensorId);
    t.zone = zone;
    const signals = [];

    // 1) 数据中断检测（与温度状态独立）
    if (t.lastTs !== null && reading.ts - t.lastTs > this.gapMs) {
      const event = await this.store.append('data_gap_detected', {
        id: randomUUID(),
        batchId: reading.batchId,
        sensorId: reading.sensorId,
        start: t.lastTs,
        end: reading.ts,
        durationMs: reading.ts - t.lastTs,
      });
      signals.push({ signal: 'data_gap', event, reading });
    }

    // 2) 温度三态机
    const { status, deviationC } = classifyTemperature(reading.tempC, zone);
    const outOfBand = status !== 'in';

    if (t.status === 'normal') {
      if (outOfBand) {
        t.status = 'watching';
        t.direction = status;
        t.watchStart = reading.ts;
        t.peakTempC = reading.tempC;
        t.peakTs = reading.ts;
        t.maxDeviationC = deviationC;
        signals.push({
          signal: 'warning',
          reading,
          detail: {
            direction: status,
            deviationC,
            toleranceMs: zone.toleranceMs,
            message:
              (status === 'high' ? '温度超上限' : '温度超下限') +
              `，进入 ${Math.round(zone.toleranceMs / 60000)} 分钟容忍观察；持续越限将判定超温`,
          },
        });
      }
    } else if (t.status === 'watching') {
      if (outOfBand && t.direction === status) {
        updatePeak(t, reading, deviationC);
        if (reading.ts - t.watchStart > zone.toleranceMs) {
          signals.push(...(await this.#startExcursion(reading)));
        }
      } else if (!outOfBand) {
        signals.push(...(await this.#excuse(reading, zone)));
      } else {
        // 方向翻转（高越限直接变低越限）：先豁免旧方向，再观察新方向
        signals.push(...(await this.#excuse(reading, zone)));
        t.status = 'watching';
        t.direction = status;
        t.watchStart = reading.ts;
        t.peakTempC = reading.tempC;
        t.peakTs = reading.ts;
        t.maxDeviationC = deviationC;
      }
    } else if (t.status === 'alarming') {
      if (outOfBand && t.direction === status) {
        updatePeak(t, reading, deviationC);
        const evt = await this.store.append('excursion_updated', {
          id: t.excursionId,
          patch: {
            peakTempC: t.peakTempC,
            peakTs: t.peakTs,
            maxDeviationC: t.maxDeviationC,
            severity: severityOf(t.maxDeviationC),
            lastTs: reading.ts,
          },
        });
        signals.push({ signal: 'excursion_updated', event: evt, reading });
      } else {
        signals.push(...(await this.#closeExcursion(reading, zone, !outOfBand)));
      }
    }

    t.lastTs = reading.ts;
    t.lastReading = reading;
    if (!signals.length) signals.push({ signal: t.status === 'normal' ? 'reading_ok' : 'monitoring', reading });
    return signals;
  }

  async #startExcursion(reading) {
    const t = this.#tracker(reading.batchId, reading.sensorId);
    t.status = 'alarming';
    t.excursionId = randomUUID();
    const zone = t.zone;
    const event = await this.store.append('excursion_started', {
      id: t.excursionId,
      batchId: reading.batchId,
      sensorId: reading.sensorId,
      direction: t.direction,
      rawStart: t.watchStart,
      windowStart: t.watchStart + zone.toleranceMs,
      toleranceMs: zone.toleranceMs,
      zone: { id: zone.id, min: zone.min, max: zone.max },
      peakTempC: t.peakTempC,
      peakTs: t.peakTs,
      maxDeviationC: t.maxDeviationC,
      severity: severityOf(t.maxDeviationC),
    });
    return [{
      signal: 'excursion_started',
      event,
      reading,
      detail: {
        excursionId: t.excursionId,
        direction: t.direction,
        message:
          (t.direction === 'high' ? '持续超上限' : '持续超下限') +
          `已超过 ${Math.round(zone.toleranceMs / 60000)} 分钟容忍时长，判定为超温事件并开始计责`,
      },
    }];
  }

  async #excuse(reading, zone) {
    const t = this.#tracker(reading.batchId, reading.sensorId);
    const rawDurationMs = reading.ts - t.watchStart;
    const was = { direction: t.direction, watchStart: t.watchStart, durationMs: rawDurationMs };
    t.status = 'normal';
    t.direction = null;
    t.watchStart = null;
    t.peakTempC = null;
    t.peakTs = null;
    t.maxDeviationC = 0;
    return [{
      signal: 'fluctuation_excused',
      reading,
      detail: {
        ...was,
        message: `越限 ${Math.round(rawDurationMs / 60000)} 分钟后恢复，未超过容忍时长 ${Math.round(zone.toleranceMs / 60000)} 分钟，判定为开门/化霜类波动，不计超温`,
      },
    }];
  }

  async #closeExcursion(reading, zone, recovered) {
    const t = this.#tracker(reading.batchId, reading.sensorId);
    const rawEnd = reading.ts;
    const rawDurationMs = rawEnd - t.watchStart;
    const windowEnd = rawEnd;
    const chargeableDurationMs = Math.max(0, windowEnd - (t.watchStart + zone.toleranceMs));
    const patch = {
      rawEnd,
      recovered,
      peakTempC: t.peakTempC,
      peakTs: t.peakTs,
      maxDeviationC: t.maxDeviationC,
      severity: severityOf(t.maxDeviationC),
      rawDurationMs,
      chargeableDurationMs,
    };
    const event = await this.store.append('excursion_closed', { id: t.excursionId, patch });
    const signals = [{
      signal: 'excursion_recovered',
      event,
      reading,
      detail: {
        excursionId: t.excursionId,
        chargeableDurationMs,
        message: `温度回到 ${zone.min}~${zone.max}°C 温区，超温事件关闭，计责时长 ${Math.round(chargeableDurationMs / 60000)} 分钟`,
      },
    }];
    t.status = 'normal';
    t.direction = null;
    t.watchStart = null;
    t.excursionId = null;
    t.peakTempC = null;
    t.peakTs = null;
    t.maxDeviationC = 0;
    return signals;
  }

  // 批次结束仍未恢复的超温：由命令层调用，按"批次结束时刻"关闭
  async forceCloseOpen(batchId, endTs) {
    const out = [];
    for (const t of this.trackers.values()) {
      if (t.batchId !== batchId || t.status !== 'alarming') continue;
      const zone = t.zone;
      const rawDurationMs = endTs - t.watchStart;
      const chargeableDurationMs = Math.max(0, endTs - (t.watchStart + zone.toleranceMs));
      const patch = {
        rawEnd: endTs,
        recovered: false,
        peakTempC: t.peakTempC,
        peakTs: t.peakTs,
        maxDeviationC: t.maxDeviationC,
        severity: severityOf(t.maxDeviationC),
        rawDurationMs,
        chargeableDurationMs,
      };
      const event = await this.store.append('excursion_closed', { id: t.excursionId, patch });
      out.push(event);
      t.status = 'normal';
      t.direction = null;
      t.watchStart = null;
      t.excursionId = null;
    }
    return out;
  }

  statusOf(batchId, sensorId) {
    const t = this.trackers.get(keyOf(batchId, sensorId));
    if (!t) return { status: 'normal' };
    return {
      status: t.status,
      direction: t.direction,
      watchStart: t.watchStart,
      excursionId: t.excursionId,
      peakTempC: t.peakTempC,
      maxDeviationC: t.maxDeviationC,
      lastTs: t.lastTs,
    };
  }
}
