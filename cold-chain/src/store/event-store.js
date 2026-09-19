// 事件溯源存储（零依赖）
//
// 所有业务事实都是不可变事件，追加写入 events.jsonl，每条携带：
//   seq  递增序号
//   ts   入链时间（服务器时钟）
//   type 事件类型
//   payload 业务数据
//   prevHash 上一条事件的哈希
//   hash sha256(prevHash + canonicalJSON({seq,ts,type,payload}))
// 哈希链让事后对日志的任何增删改都可被 verify 检出——追溯报告因此具备防篡改自证能力。
//
// 启动时从头重放日志重建内存状态；进程内所有模块共享同一份状态。
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { config } from '../config.js';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
    .join(',')}}`;
}

export function hashEvent(prevHash, event) {
  return createHash('sha256')
    .update(prevHash)
    .update(canonical({ seq: event.seq, ts: event.ts, type: event.type, payload: event.payload }))
    .digest('hex');
}

const GENESIS = '0'.repeat(64);

// 把事件折叠进当前状态（纯函数；读侧投影）
function apply(state, event) {
  const { type, payload } = event;
  switch (type) {
    case 'batch_registered': {
      state.batches[payload.id] = { ...payload, status: payload.status || 'registered', readingsCount: 0 };
      break;
    }
    case 'batch_started': {
      const b = state.batches[payload.id];
      if (b) {
        b.startedAt = payload.ts;
        b.status = 'in_transit';
      }
      break;
    }
    case 'batch_finished': {
      const b = state.batches[payload.id];
      if (b) {
        b.finishedAt = payload.ts;
        b.status = payload.status || 'completed';
      }
      break;
    }
    case 'sensor_registered': {
      if (!state.sensors.some((s) => s.id === payload.id)) state.sensors.push({ ...payload });
      break;
    }
    case 'batch_sensor_bound': {
      const b = state.batches[payload.batchId];
      if (b && !b.sensorIds.includes(payload.sensorId)) b.sensorIds.push(payload.sensorId);
      break;
    }
    case 'handover_recorded': {
      state.handovers.push({ ...payload });
      break;
    }
    case 'reading_ingested': {
      state.readings.push({ ...payload });
      const b = state.batches[payload.batchId];
      if (b) b.readingsCount += 1;
      break;
    }
    case 'excursion_started': {
      state.activeExcursions[payload.id] = { ...payload, open: true };
      break;
    }
    case 'excursion_updated': {
      const ex = state.activeExcursions[payload.id];
      if (ex) Object.assign(ex, payload.patch);
      break;
    }
    case 'excursion_closed': {
      const ex = state.activeExcursions[payload.id];
      if (ex) {
        Object.assign(ex, payload.patch, { open: false });
        state.closedExcursions[payload.id] = ex;
        delete state.activeExcursions[payload.id];
      }
      break;
    }
    case 'data_gap_detected': {
      state.dataGaps.push({ ...payload });
      break;
    }
    default:
      // 未知事件类型不影响状态（向前兼容），但仍在链上
      break;
  }
}

function freshState() {
  return {
    batches: {},
    sensors: [],
    handovers: [],
    readings: [],
    activeExcursions: {},
    closedExcursions: {},
    dataGaps: [],
    gapMs: config.sensorGapMs,
  };
}

export class EventStore {
  constructor(file = config.eventLog) {
    this.file = file;
    this.state = freshState();
    this.lastHash = GENESIS;
    this.seq = 0;
    this.subscribers = new Set();
    this._chain = Promise.resolve();
  }

  load() {
    this.state = freshState();
    this.lastHash = GENESIS;
    this.seq = 0;
    if (!existsSync(this.file)) return this.state;
    const text = readFileSync(this.file, 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      apply(this.state, event);
      this.lastHash = event.hash;
      this.seq = event.seq;
    }
    return this.state;
  }

  // 订阅事件（监控引擎、SSE 推送使用）
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  // 串行化追加写入：进程内并发 append 不会交错
  append(type, payload) {
    const job = this._chain.then(() => {
      const event = { seq: this.seq + 1, ts: Date.now(), type, payload, prevHash: this.lastHash };
      event.hash = hashEvent(this.lastHash, event);
      appendFileSync(this.file, JSON.stringify(event) + '\n');
      this.seq = event.seq;
      this.lastHash = event.hash;
      apply(this.state, event);
      for (const fn of this.subscribers) {
        try {
          fn(event);
        } catch (err) {
          // 订阅者失败不影响存储
          console.error('[store] subscriber error:', err);
        }
      }
      return event;
    });
    this._chain = job.catch(() => {});
    return job;
  }

  // 逐条流式校验哈希链，返回首个断点（大日志不一次性载入内存）
  async verify(onProgress) {
    if (!existsSync(this.file)) return { ok: true, total: 0, message: '事件日志为空' };
    let prev = GENESIS;
    let expectedSeq = 0;
    let total = 0;
    const stream = createReadStream(this.file, { encoding: 'utf8' });
    let buffer = '';
    const check = (line) => {
      const event = JSON.parse(line);
      expectedSeq += 1;
      if (event.seq !== expectedSeq) {
        return { ok: false, atSeq: event.seq, reason: `序号不连续，期望 ${expectedSeq}` };
      }
      if (event.prevHash !== prev) {
        return { ok: false, atSeq: event.seq, reason: 'prevHash 断链：日志可能被删除或重排' };
      }
      const recomputed = hashEvent(event.prevHash, event);
      if (recomputed !== event.hash) {
        return { ok: false, atSeq: event.seq, reason: '哈希不一致：事件内容被篡改' };
      }
      prev = event.hash;
      total += 1;
      onProgress?.(total);
      return null;
    };

    for await (const chunk of stream) {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const bad = check(line);
        if (bad) return bad;
      }
    }
    if (buffer.trim()) {
      const bad = check(buffer.trim());
      if (bad) return bad;
    }
    return { ok: true, total, lastHash: this.lastHash, message: `哈希链校验通过，共 ${total} 条事件` };
  }

  // 清空日志（测试/重置使用；CLI reset 会明确提示）
  reset() {
    writeFileSync(this.file, '');
    this.state = freshState();
    this.lastHash = GENESIS;
    this.seq = 0;
  }
}

export const store = new EventStore();
