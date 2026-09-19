/**
 * 冷链领域服务：在事件存储之上维护可查询状态，并处理温度入库时的报警生命周期。
 *
 * 报警以 (批次, 车厢) 为键 —— 同一车厢在跨车/跨月台交接时，
 * 未闭环的报警自动延续到下一个承运环节，从而实现"一次超温、多环节分责"。
 */

import { EventStore } from './store.js';
import { createId } from './ids.js';
import { nowSec, toSec, toIso } from './time.js';
import { DEFAULT_MIN_TEMP, DEFAULT_MAX_TEMP } from './config.js';
import {
  evaluateTemp,
  severityFor,
  segmentAt,
  splitResponsibility,
  verdictFor,
} from './engine.js';

export class ColdChainService {
  /** @param {string|URL} storePath */
  constructor(storePath) {
    this.store = new EventStore(storePath);
    this._resetState();
  }

  _resetState() {
    this.shipments = new Map();
    this.vehicles = new Map(); // 同时按 id 与 code 建索引
    this.vehiclesByCode = new Map();
    this.sensors = new Map(); // 按 id
    this.sensorsByCode = new Map(); // 按 code（入库协议用 code）
    this.segments = new Map(); // id -> segment（含 status）
    this.events = [];
    this.readings = [];
    this.alarms = new Map(); // id -> alarm
  }

  /** 重放事件日志，重建全部状态 */
  async init() {
    this._resetState();
    const events = await this.store.load();
    for (const e of events) this._reduce(e);
    // 重放完成后再订阅：此后每条新写入实时推进内存状态
    this._unsubscribe = this.store.subscribe((e) => this._reduce(e));
    return this;
  }

  subscribe(fn) {
    return this.store.subscribe(fn);
  }

  // ---------- 建档 ----------

  /**
   * 创建运输批次。
   * @param {object} p {code, product, origin, destination, min_temp?, max_temp?, owner?, ts?}
   */
  async createShipment(p) {
    if (!p?.code) throw new ValidationError('批次号 code 必填');
    const dup = [...this.shipments.values()].find((s) => s.code === p.code);
    if (dup) throw new ValidationError(`批次号已存在: ${p.code}`);

    const shipment = {
      id: createId('ship'),
      code: p.code,
      product: p.product ?? '',
      origin: p.origin ?? '',
      destination: p.destination ?? '',
      owner: p.owner ?? '',
      min_temp: p.min_temp ?? DEFAULT_MIN_TEMP,
      max_temp: p.max_temp ?? DEFAULT_MAX_TEMP,
      created_at: p.ts ? toSec(p.ts) : nowSec(),
    };
    await this.store.append('shipment.created', shipment, { ts: shipment.created_at });
    return shipment;
  }

  /** 注册车辆（月台/冷库温控位也以"载具"形式注册） */
  async registerVehicle(p) {
    if (!p?.code) throw new ValidationError('车辆编号 code 必填');
    const vehicle = {
      id: createId('veh'),
      code: p.code,
      name: p.name ?? p.code,
      kind: p.kind ?? 'truck', // truck | van | dock
      created_at: nowSec(),
    };
    await this.store.append('vehicle.registered', vehicle);
    return vehicle;
  }

  /** 注册车载温度传感器，绑定车辆与车厢号 */
  async registerSensor(p) {
    if (!p?.code) throw new ValidationError('传感器编号 code 必填');
    if (!p.vehicle_code) throw new ValidationError('vehicle_code 必填');
    const vehicle = this._requireVehicleByCode(p.vehicle_code);
    const sensor = {
      id: createId('sen'),
      code: p.code,
      vehicle_id: vehicle.id,
      compartment: p.compartment ?? 'C1',
      created_at: nowSec(),
    };
    await this.store.append('sensor.registered', sensor);
    return sensor;
  }

  /**
   * 开始一个承运环节（装车发运 / 中转 / 城配 / 交付……）。
   * @param {object} p {shipment_code, vehicle_code, compartment?, stage, party, operator?, ts?}
   */
  async startSegment(p) {
    const shipment = this._requireShipment(p.shipment_code);
    const vehicle = this._requireVehicleByCode(p.vehicle_code);
    if (!p.stage || !p.party) throw new ValidationError('stage 与 party 必填');

    const compartment = p.compartment ?? 'C1';
    const ts = p.ts ? toSec(p.ts) : nowSec();
    const active = [...this.segments.values()].find(
      (s) =>
        s.shipment_id === shipment.id &&
        s.compartment === compartment &&
        s.vehicle_id === vehicle.id &&
        s.status === 'active' &&
        s.started_at <= ts
    );
    if (active) throw new ValidationError('该车辆/车厢已有进行中的环节，请先交接结束');

    const segment = {
      id: createId('seg'),
      shipment_id: shipment.id,
      vehicle_id: vehicle.id,
      compartment,
      stage: p.stage,
      party: p.party,
      operator: p.operator ?? '',
      started_at: ts,
      ended_at: null,
      status: 'active',
    };
    await this.store.append('segment.started', segment, { ts });
    return segment;
  }

  /** 环节结束（交接） */
  async endSegment(p) {
    const segment = this._requireActiveSegment(p.segment_id ?? p.segmentId, p.shipment_code);
    const ts = p.ts ? toSec(p.ts) : nowSec();
    if (ts < segment.started_at) throw new ValidationError('结束时间不能早于开始时间');
    const updated = { ...segment, ended_at: ts, status: 'ended' };
    await this.store.append('segment.ended', {
      segment_id: segment.id,
      shipment_id: segment.shipment_id,
      ended_at: ts,
      operator: p.operator ?? segment.operator,
      note: p.note ?? '',
    }, { ts });
    return updated;
  }

  /** 记录业务事件：开门、故障、交接备注等（用于回溯时间线） */
  async recordEvent(p) {
    const shipment = this._requireShipment(p.shipment_code);
    const ev = {
      id: createId('evtlog'),
      shipment_id: shipment.id,
      kind: p.kind ?? 'note', // door_open | equipment_fault | handover_note | note
      detail: p.detail ?? '',
      ts: p.ts ? toSec(p.ts) : nowSec(),
    };
    await this.store.append('event.recorded', ev, { ts: ev.ts });
    return ev;
  }

  // ---------- 传感器接入 ----------

  /**
   * 接收一条车载温度读数。流程：
   *  1. 解析传感器 → 车辆/车厢；
   *  2. 找到该时刻承运该批次车厢的环节（找不到则标记为孤儿读数，不参与判定）；
   *  3. 按批次温区判定越限，维护 (批次,车厢) 维度报警的开/闭环。
   *
   * @param {object} p {sensor_code, temp, ts?}
   * @returns {Promise<{reading:object, alarm:object|null, action:string}>}
   */
  async ingestReading(p) {
    if (!p?.sensor_code) throw new ValidationError('sensor_code 必填');
    if (typeof p.temp !== 'number' || !Number.isFinite(p.temp)) {
      throw new ValidationError('temp 必须是数字');
    }
    const sensor = this.sensorsByCode.get(p.sensor_code);
    if (!sensor) throw new ValidationError(`未注册的传感器: ${p.sensor_code}`);

    const ts = p.ts ? toSec(p.ts) : nowSec();
    const seg = segmentAt([...this.segments.values()], sensor.vehicle_id, sensor.compartment, ts);

    const reading = {
      id: createId('rdg'),
      ts,
      sensor_id: sensor.id,
      sensor_code: sensor.code,
      vehicle_id: sensor.vehicle_id,
      compartment: sensor.compartment,
      temp: Math.round(p.temp * 100) / 100,
      received_at: nowSec(),
      shipment_id: seg?.shipment_id ?? null,
      segment_id: seg?.id ?? null,
      orphan: !seg,
      alarm_id: null,
    };

    if (!seg) {
      await this.store.append('reading.ingested', { ...reading, action: 'orphan' }, { ts });
      return { reading: this._byId('reading', reading.id), alarm: null, action: 'orphan' };
    }

    const shipment = this.shipments.get(seg.shipment_id);
    const verdict = evaluateTemp(reading.temp, shipment.min_temp, shipment.max_temp);

    if (verdict.ok) {
      // 在限：若该车厢有开启中的报警则闭环
      const openAlarm = this._findOpenAlarm(shipment.id, sensor.compartment);
      if (openAlarm) {
        reading.alarm_id = openAlarm.id;
        await this.store.append('reading.ingested', { ...reading, action: 'close' }, { ts });
        const closed = await this._closeAlarm(openAlarm, reading, ts);
        return { reading: this._byId('reading', reading.id), alarm: closed, action: 'close' };
      }
      await this.store.append('reading.ingested', { ...reading, action: 'ok' }, { ts });
      return { reading: this._byId('reading', reading.id), alarm: null, action: 'ok' };
    }

    // 越限：找到/创建开启中的报警
    let alarm = this._findOpenAlarm(shipment.id, sensor.compartment);
    const isFirst = !alarm;
    if (isFirst) {
      alarm = await this._openAlarm(shipment, reading, seg, verdict, ts);
    }
    reading.alarm_id = alarm.id;
    // alarm.opened 已先于首条越限读数落库；replay 时读数即可挂到报警
    await this.store.append('reading.ingested', { ...reading, action: 'excursion' }, { ts });
    return {
      reading: this._byId('reading', reading.id),
      alarm: this.alarms.get(alarm.id),
      action: isFirst ? 'alarm_opened' : 'excursion',
    };
  }

  /** 批量入库（模拟器推送用），按时间升序逐条处理 */
  async ingestReadings(list) {
    const sorted = [...list].sort((a, b) => toSec(a.ts) - toSec(b.ts));
    const out = [];
    for (const p of sorted) out.push(await this.ingestReading(p));
    return out;
  }

  async _openAlarm(shipment, reading, seg, verdict, ts) {
    const alarm = {
      id: createId('alm'),
      shipment_id: shipment.id,
      compartment: reading.compartment,
      direction: verdict.direction,
      status: 'open',
      opened_at: ts,
      closed_at: null,
      trigger_sensor_id: reading.sensor_id,
      trigger_segment_id: seg.id,
      trigger_reading_id: reading.id,
      closing_reading_id: null,
      peak_temp: reading.temp,
      peak_at: ts,
      severity: 'trivial',
      responsibility: null,
    };
    // 先写 alarm.opened，再写首条越限读数（replay 时读数才能挂到报警上）
    await this.store.append('alarm.opened', alarm, { ts });
    return alarm;
  }

  async _closeAlarm(alarm, closingReading, ts) {
    // 先落 alarm.closed（含闭环时刻），reducer 会把状态置为 closed；
    // 随后重算，此时不再走 liveUntil=当前时刻 的延伸逻辑。
    await this.store.append('alarm.closed', {
      alarm_id: alarm.id,
      shipment_id: alarm.shipment_id,
      closed_at: ts,
      closing_reading_id: closingReading.id,
    }, { ts });
    const updated = this._recomputeAlarm(this.alarms.get(alarm.id));
    // 重算结果（峰值/时长/级别/责任拆分）记录在闭环事件之后，保证重放后可直接取用
    await this.store.append('alarm.closed_resolved', {
      alarm_id: alarm.id,
      peak_temp: updated.peak_temp,
      peak_at: updated.peak_at,
      excursion_count: updated.reading_count,
      duration_sec: updated.duration_sec,
      severity: updated.severity,
      responsibility: updated.responsibility,
    }, { ts });
    return this.alarms.get(alarm.id);
  }

  /**
   * 依据当前报警的越限读数重算峰值/时长/级别/责任拆分。
   * 报警仍开启时，最后一条越限读数的区间延伸到当前时刻（liveUntil=now）。
   */
  _recomputeAlarm(alarm) {
    const excursion = this.readings
      .filter((r) => r.alarm_id === alarm.id)
      .sort((a, b) => a.ts - b.ts);

    let peak = alarm.peak_temp;
    let peakAt = alarm.peak_at;
    for (const r of excursion) {
      if (r.temp > peak) {
        peak = r.temp;
        peakAt = r.ts;
      }
    }

    const liveUntil = alarm.status === 'open' ? nowSec() : null;

    const split = splitResponsibility(
      { ...alarm, readings: excursion },
      // 只取本批次该车厢的读数，避免其他批次同编号车厢的读数污染区间边界
      this.readings.filter(
        (r) => r.shipment_id === alarm.shipment_id && r.compartment === alarm.compartment
      ),
      [...this.segments.values()].filter((s) => s.shipment_id === alarm.shipment_id),
      liveUntil
    );

    const limit = alarm.direction === 'high'
      ? this.shipments.get(alarm.shipment_id).max_temp
      : this.shipments.get(alarm.shipment_id).min_temp;
    const deviation = alarm.direction === 'high' ? peak - limit : limit - peak;
    const durationMin = split.totalSec / 60;

    alarm.peak_temp = Math.round(peak * 100) / 100;
    alarm.peak_at = peakAt;
    alarm.reading_count = excursion.length;
    alarm.duration_sec = split.totalSec;
    alarm.severity = severityFor(Math.round(deviation * 10) / 10, durationMin);
    alarm.responsibility = split;
    return alarm;
  }

  // ---------- 查询 / 回溯 ----------

  listShipments() {
    return [...this.shipments.values()].sort((a, b) => a.created_at - b.created_at);
  }

  getShipment(idOrCode) {
    const s = this.shipments.get(idOrCode) ??
      [...this.shipments.values()].find((x) => x.code === idOrCode);
    if (!s) throw new NotFoundError(`批次不存在: ${idOrCode}`);
    return s;
  }

  listAlarms(shipmentId = null, status = null) {
    return [...this.alarms.values()]
      .filter((a) => (!shipmentId || a.shipment_id === shipmentId))
      .filter((a) => (!status || a.status === status))
      .sort((a, b) => a.opened_at - b.opened_at)
      .map((a) => this._alarmView(a));
  }

  /**
   * 按运输批次完整回溯：
   * 批次信息 + 承运环节链 + 融合时间线 + 报警（含责任拆分）+ 温度统计 + 结论。
   */
  traceShipment(idOrCode) {
    const shipment = this.getShipment(idOrCode);
    const segments = [...this.segments.values()]
      .filter((s) => s.shipment_id === shipment.id)
      .sort((a, b) => a.started_at - b.started_at);
    const events = this.events.filter((e) => e.shipment_id === shipment.id);
    const readings = this.readings
      .filter((r) => r.shipment_id === shipment.id)
      .sort((a, b) => a.ts - b.ts);
    const alarms = [...this.alarms.values()]
      .filter((a) => a.shipment_id === shipment.id)
      .sort((a, b) => a.opened_at - b.opened_at);

    // 环节视图：补上虚拟承运区间内的读数/报警统计
    const segmentViews = segments.map((s, i) => {
      const custEnd = segments[i + 1] ? segments[i + 1].started_at : null;
      const inCustody = readings.filter(
        (r) => r.ts >= s.started_at && (custEnd === null || r.ts < custEnd)
      );
      const temps = inCustody.map((r) => r.temp);
      return {
        ...s,
        custody_end: custEnd,
        reading_count: inCustody.length,
        min_temp_observed: temps.length ? Math.min(...temps) : null,
        max_temp_observed: temps.length ? Math.max(...temps) : null,
      };
    });

    // 融合时间线（环节交接 + 业务事件 + 报警开闭），供逐时刻回溯
    const timeline = [];
    for (const s of segments) {
      timeline.push({ kind: 'segment_start', ts: s.started_at, ref: s.id, summary: `${s.stage}开始｜${s.party}` });
      if (s.ended_at) timeline.push({ kind: 'segment_end', ts: s.ended_at, ref: s.id, summary: `${s.stage}交接结束｜${s.party}` });
    }
    for (const e of events) timeline.push({ kind: 'event', ts: e.ts, ref: e.id, summary: `${e.kind}：${e.detail}` });
    for (const a of alarms) {
      timeline.push({ kind: 'alarm_open', ts: a.opened_at, ref: a.id, summary: `${a.direction === 'high' ? '超上限' : '低于下限'}报警产生` });
      if (a.closed_at) timeline.push({ kind: 'alarm_close', ts: a.closed_at, ref: a.id, summary: `报警闭环（${a.severity}）` });
    }
    timeline.sort((a, b) => a.ts - b.ts || a.kind.localeCompare(b.kind));

    // 温度统计（仅归入本批次的读数；全局孤儿读数单独计数）
    const temps = readings.map((r) => r.temp);
    const alarmIds = new Set(alarms.map((a) => a.id));
    const stats = {
      reading_count: readings.length,
      first_ts: readings[0]?.ts ?? null,
      last_ts: readings[readings.length - 1]?.ts ?? null,
      min_temp: temps.length ? Math.min(...temps) : null,
      max_temp: temps.length ? Math.max(...temps) : null,
      excursion_count: readings.filter((r) => r.alarm_id && alarmIds.has(r.alarm_id)).length,
      orphan_count: this.readings.filter((r) => r.orphan).length,
    };

    const alarmViews = alarms.map((a) => this._alarmView(a));
    const verdict = verdictFor(alarms);

    return {
      shipment,
      segments: segmentViews,
      timeline,
      alarms: alarmViews,
      stats,
      verdict,
    };
  }

  /** 报警对外视图：开启中的报警实时重算一次责任拆分 */
  _alarmView(alarm) {
    if (alarm.status === 'open') this._recomputeAlarm(alarm);
    const excursion = this.readings
      .filter((r) => r.alarm_id === alarm.id)
      .sort((a, b) => a.ts - b.ts);
    return {
      ...alarm,
      readings: excursion.map((r) => ({ id: r.id, ts: r.ts, temp: r.temp, sensor_code: r.sensor_code, segment_id: r.segment_id })),
    };
  }

  // ---------- 事件回放（纯状态推进，不再触发任何写操作） ----------

  _reduce(e) {
    const p = e.payload;
    switch (e.type) {
      case 'shipment.created':
        this.shipments.set(p.id, { ...p });
        break;
      case 'vehicle.registered':
        this.vehicles.set(p.id, { ...p });
        this.vehiclesByCode.set(p.code, { ...p });
        break;
      case 'sensor.registered':
        this.sensors.set(p.id, { ...p });
        this.sensorsByCode.set(p.code, { ...p });
        break;
      case 'segment.started':
        this.segments.set(p.id, { ...p });
        break;
      case 'segment.ended': {
        const s = this.segments.get(p.segment_id);
        if (s) Object.assign(s, { ended_at: p.ended_at, status: 'ended' });
        break;
      }
      case 'event.recorded':
        this.events.push({ ...p });
        break;
      case 'reading.ingested': {
        const { action, ...r } = p;
        this.readings.push({ ...r });
        if (r.alarm_id && this.alarms.has(r.alarm_id)) {
          // 读数明细已在查询时从 readings 反查，无需冗余存储
        }
        void action;
        break;
      }
      case 'alarm.opened':
        this.alarms.set(p.id, {
          ...p,
          closed_at: null,
          closing_reading_id: null,
          peak_temp: p.peak_temp,
          peak_at: p.peak_at,
          reading_count: 0,
          duration_sec: 0,
          responsibility: null,
        });
        break;
      case 'alarm.closed': {
        const a = this.alarms.get(p.alarm_id);
        if (a) {
          Object.assign(a, {
            status: 'closed',
            closed_at: p.closed_at,
            closing_reading_id: p.closing_reading_id,
          });
        }
        break;
      }
      case 'alarm.closed_resolved': {
        // 闭环时刻的重算快照：重放时直接取用，无需依赖当时的真实时钟
        const a = this.alarms.get(p.alarm_id);
        if (a) {
          Object.assign(a, {
            peak_temp: p.peak_temp,
            peak_at: p.peak_at,
            reading_count: p.excursion_count,
            duration_sec: p.duration_sec,
            severity: p.severity,
            responsibility: p.responsibility,
          });
        }
        break;
      }
    }
  }

  // ---------- 内部辅助 ----------

  _findOpenAlarm(shipmentId, compartment) {
    return [...this.alarms.values()].find(
      (a) => a.shipment_id === shipmentId && a.compartment === compartment && a.status === 'open'
    );
  }

  _requireShipment(code) {
    const s = [...this.shipments.values()].find((x) => x.code === code) ?? this.shipments.get(code);
    if (!s) throw new ValidationError(`批次不存在: ${code}`);
    return s;
  }

  _requireVehicleByCode(code) {
    const v = this.vehiclesByCode.get(code) ?? this.vehicles.get(code);
    if (!v) throw new ValidationError(`车辆不存在: ${code}`);
    return v;
  }

  _requireActiveSegment(segmentId, shipmentCode) {
    if (segmentId) {
      const s = this.segments.get(segmentId);
      if (!s) throw new ValidationError('未找到该环节');
      if (s.status !== 'active') throw new ValidationError('该环节已结束');
      return s;
    }
    if (shipmentCode) {
      const ship = this._requireShipment(shipmentCode);
      const s = [...this.segments.values()]
        .filter((x) => x.shipment_id === ship.id && x.status === 'active')
        .sort((a, b) => b.started_at - a.started_at)[0];
      if (!s) throw new ValidationError('未找到进行中的环节');
      return s;
    }
    throw new ValidationError('缺少 segment_id');
  }

  _byId(kind, id) {
    if (kind === 'reading') return this.readings.find((r) => r.id === id) ?? null;
    return null;
  }
}

export class ValidationError extends Error {
  constructor(msg) {
    super(msg);
    this.statusCode = 400;
  }
}
export class NotFoundError extends Error {
  constructor(msg) {
    super(msg);
    this.statusCode = 404;
  }
}

/** 序列化辅助：把视图里的 epoch 秒转成 ISO 字符串（HTTP 层使用） */
const TIME_KEYS = new Set([
  'ts', 'at', 'created_at', 'started_at', 'ended_at', 'opened_at', 'closed_at',
  'peak_at', 'first_ts', 'last_ts', 'custody_end', 'received_at',
]);

export function serializeView(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(serializeView);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') out[k] = serializeView(v);
    else if (typeof v === 'number' && TIME_KEYS.has(k)) out[k] = toIso(v);
    else out[k] = v;
  }
  return out;
}
