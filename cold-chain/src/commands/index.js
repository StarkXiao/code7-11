// 业务命令：批次/传感器注册、交接登记、批次启停。全部以事件落链。
import { randomUUID } from 'node:crypto';
import { resolveZone } from '../domain/zones.js';

function requireString(v, field, errors) {
  if (typeof v !== 'string' || !v.trim()) errors.push(`${field} 必填`);
}

function party(p) {
  if (!p || typeof p !== 'object') return null;
  return { id: p.id || randomUUID(), name: p.name, contact: p.contact || null };
}

export class Commands {
  constructor(store, monitor) {
    this.store = store;
    this.monitor = monitor;
  }

  async registerBatch(input) {
    const errors = [];
    requireString(input?.code, '批次编号 code', errors);
    requireString(input?.product, '货品 product', errors);
    let zone;
    try {
      zone = resolveZone(input.zone);
    } catch (e) {
      errors.push(e.message);
    }
    requireString(input?.shipper?.name, '发货方 shipper.name', errors);
    requireString(input?.carrier?.name, '承运方 carrier.name', errors);
    requireString(input?.consignee?.name, '收货方 consignee.name', errors);
    if (errors.length) {
      const err = new Error(errors.join('；'));
      err.statusCode = 422;
      throw err;
    }
    if (this.store.state.batches[input.code] || Object.values(this.store.state.batches).some((b) => b.code === input.code)) {
      const err = new Error(`批次编号已存在: ${input.code}`);
      err.statusCode = 409;
      throw err;
    }

    const batch = {
      id: randomUUID(),
      code: input.code,
      product: input.product,
      quantity: input.quantity || null,
      zone,
      shipper: party(input.shipper),
      carrier: party(input.carrier),
      vehicleId: input.vehicleId || null,
      driver: input.driver || null,
      consignee: party(input.consignee),
      route: input.route || null,
      sensorIds: Array.isArray(input.sensorIds) ? [...new Set(input.sensorIds)] : [],
      status: 'registered',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    await this.store.append('batch_registered', batch);
    return batch;
  }

  async registerSensor(input) {
    const errors = [];
    requireString(input?.id, '传感器编号 id', errors);
    requireString(input?.label, '传感器名称 label', errors);
    if (errors.length) {
      const err = new Error(errors.join('；'));
      err.statusCode = 422;
      throw err;
    }
    if (this.store.state.sensors.some((s) => s.id === input.id)) {
      const err = new Error(`传感器已注册: ${input.id}`);
      err.statusCode = 409;
      throw err;
    }
    const sensor = {
      id: input.id,
      label: input.label,
      position: input.position || '车厢',
      calibratedAt: input.calibratedAt || null,
      registeredAt: Date.now(),
    };
    await this.store.append('sensor_registered', sensor);
    return sensor;
  }

  async bindSensor(batchCode, sensorId) {
    const batch = this.#batchByCode(batchCode);
    if (!this.store.state.sensors.some((s) => s.id === sensorId)) {
      const err = new Error(`传感器未注册: ${sensorId}`);
      err.statusCode = 404;
      throw err;
    }
    if (!batch.sensorIds.includes(sensorId)) {
      await this.store.append('batch_sensor_bound', { batchId: batch.id, sensorId, ts: Date.now() });
    }
    return this.#batchByCode(batchCode);
  }

  async startBatch(batchCode, ts = Date.now()) {
    const batch = this.#batchByCode(batchCode);
    if (!batch.sensorIds.length) {
      const err = new Error('批次未绑定任何传感器，无法发运');
      err.statusCode = 422;
      throw err;
    }
    await this.store.append('batch_started', { id: batch.id, ts });
    return this.store.state.batches[batch.id];
  }

  // 交接登记：stage ∈ departure(发运) / transit(中转) / arrival(到货) / signoff(签收)
  async recordHandover(input) {
    const errors = [];
    const batch = this.#batchByCode(input?.batchCode);
    if (!batch) errors.push(`批次不存在: ${input?.batchCode}`);
    const allowed = ['departure', 'transit', 'arrival', 'signoff'];
    if (!allowed.includes(input?.stage)) errors.push(`stage 必须是 ${allowed.join('/')}`);
    requireString(input?.holder, '交接责任人/岗位 holder', errors);
    if (typeof input?.measuredTempC !== 'number') errors.push('交接实测温度 measuredTempC 必填且为数字');
    if (errors.length) {
      const err = new Error(errors.join('；'));
      err.statusCode = 422;
      throw err;
    }
    const handover = {
      id: randomUUID(),
      batchId: batch.id,
      stage: input.stage,
      ts: input.ts || Date.now(),
      holder: input.holder,
      measuredTempC: input.measuredTempC,
      note: input.note || null,
    };
    await this.store.append('handover_recorded', handover);
    return handover;
  }

  // 批次完结：关闭所有开启中的超温（未恢复按批次结束时刻收口）
  async finishBatch(batchCode, ts = Date.now()) {
    const batch = this.#batchByCode(batchCode);
    await this.monitor.forceCloseOpen(batch.id, ts);
    await this.store.append('batch_finished', { id: batch.id, ts, status: 'completed' });
    return this.store.state.batches[batch.id];
  }

  #batchByCode(code) {
    return Object.values(this.store.state.batches).find((b) => b.code === code) || null;
  }
}
