// 车载传感器上报网关
//
// 入站数据先过"坏数据门禁"再入链：
//  1. 必填字段、类型合法
//  2. 批次与传感器均存在且绑定
//  3. 温度在物理量程内（-60~80°C，防止 NaN/传感器故障值污染证据链）
//  4. 时间戳不允许比服务器时间快超过 60 秒（防时钟错乱）
//  5. 同一传感器的读数时间戳必须严格递增（乱序/重复一律拒收）
// 拒绝的数据返回 422 且不写日志——追溯链上只留可信数据。
import { config } from '../config.js';
import { classifyTemperature, resolveZone } from '../domain/zones.js';

export class IngestGateway {
  constructor(store, monitor) {
    this.store = store;
    this.monitor = monitor;
    this.lastIngestedTs = new Map(); // sensorId -> 最近入链 ts
  }

  rebuild() {
    this.lastIngestedTs.clear();
    for (const r of this.store.state.readings) {
      const prev = this.lastIngestedTs.get(r.sensorId) ?? -Infinity;
      if (r.ts > prev) this.lastIngestedTs.set(r.sensorId, r.ts);
    }
  }

  validate(body) {
    const errors = [];
    const { batchId, sensorId, tempC, ts } = body || {};
    if (typeof batchId !== 'string' || !batchId) errors.push('batchId 必填');
    if (typeof sensorId !== 'string' || !sensorId) errors.push('sensorId 必填');
    if (typeof tempC !== 'number' || Number.isNaN(tempC)) errors.push('tempC 必须是数字');
    const tsNum = ts === undefined ? Date.now() : Number(ts);
    if (!Number.isFinite(tsNum)) errors.push('ts 必须是毫秒时间戳');

    if (errors.length) return { errors };

    const batch = this.store.state.batches[batchId];
    if (!batch) errors.push(`批次不存在: ${batchId}`);
    const sensor = this.store.state.sensors.find((s) => s.id === sensorId);
    if (!sensor) errors.push(`传感器未注册: ${sensorId}`);
    if (batch && sensor && !batch.sensorIds.includes(sensorId)) {
      errors.push(`传感器 ${sensorId} 未绑定到批次 ${batch.code || batchId}`);
    }
    if (typeof tempC === 'number' && (tempC < config.plausibleRange.min || tempC > config.plausibleRange.max)) {
      errors.push(`温度 ${tempC}°C 超出物理量程 [${config.plausibleRange.min}, ${config.plausibleRange.max}]，按传感器故障值拒收`);
    }
    if (Number.isFinite(tsNum) && tsNum > Date.now() + 60 * 1000) {
      errors.push('读数时间戳超前服务器时间超过 60 秒，请校时后重试');
    }
    const prev = this.lastIngestedTs.get(sensorId);
    if (prev !== undefined && tsNum <= prev) {
      errors.push(`读数时间戳必须严格递增（该传感器最近入链时间 ${new Date(prev).toISOString()}）`);
    }
    return { errors, reading: { id: body.id || `${sensorId}-${tsNum}`, batchId, sensorId, tempC, ts: tsNum } };
  }

  async ingest(body) {
    const { errors, reading } = this.validate(body);
    if (errors.length) {
      const err = new Error(errors.join('；'));
      err.statusCode = 422;
      err.errors = errors;
      throw err;
    }
    const event = await this.store.append('reading_ingested', reading);
    this.lastIngestedTs.set(reading.sensorId, reading.ts);

    const signals = await this.monitor.ingest(reading);
    const batch = this.store.state.batches[reading.batchId];
    return {
      accepted: true,
      seq: event.seq,
      reading,
      band: classifyTemperature(reading.tempC, resolveZone(batch.zone)),
      signals,
    };
  }
}
