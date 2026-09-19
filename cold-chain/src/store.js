/**
 * 事件溯源存储（append-only JSONL）。
 *
 * 冷链追溯要求"每一个判定结论都能回到原始记录"，因此不做就地 UPDATE：
 * 状态变更全部以事件追加到日志，重启时顺序重放重建。
 *
 * 事件类型：
 *   shipment.created   运输批次建档
 *   vehicle.registered 车辆注册
 *   sensor.registered  传感器注册
 *   segment.started    承运环节开始（车辆绑定批次车厢）
 *   segment.ended      承运环节结束（交接）
 *   event.recorded     业务事件（开门、故障、交接备注……）
 *   reading.ingested   温度读数入库（孤儿读数 orphan=true 表示当时无承运环节）
 *   alarm.opened       超温报警产生
 *   alarm.closed       超温报警闭环（回到温区）
 */

import { fileURLToPath } from 'node:url';
import { createId } from './ids.js';
import { nowSec } from './time.js';

export class EventStore {
  /**
   * @param {string|URL} filePath JSONL 文件路径；传 ':memory:' 则不落盘（测试/演示）
   */
  constructor(filePath) {
    this.filePath = filePath === ':memory:'
      ? ':memory:'
      : filePath instanceof URL
        ? fileURLToPath(filePath)
        : filePath;
    this.memory = filePath === ':memory:' ? [] : null;
    this.subscribers = new Set();
  }

  /** 启动时重放全部事件，返回事件数组 */
  async load() {
    if (this.memory) return this.memory.slice();
    const fs = await import('node:fs/promises');
    let text;
    try {
      text = await fs.readFile(this.filePath, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
    const events = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t) events.push(JSON.parse(t));
    }
    return events;
  }

  /**
   * 追加一条事件。
   * @param {string} type 事件类型
   * @param {object} payload 事件数据（不可再改）
   * @param {object} [meta] {ts, id} 重放时传入以保留原始值
   */
  async append(type, payload, meta = {}) {
    const event = {
      id: meta.id ?? createId('evt'),
      type,
      ts: meta.ts ?? nowSec(),
      payload,
    };
    if (this.memory) {
      this.memory.push(event);
    } else {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      // 追加写；每条一行 JSON，崩溃最多损坏最后一行
      await fs.appendFile(this.filePath, JSON.stringify(event) + '\n');
    }
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        /* 订阅者异常不影响入库 */
      }
    }
    return event;
  }

  /** 订阅新事件（SSE 实时推送用）；返回取消函数 */
  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
