/**
 * 场景执行器：把场景定义（相对 T0 的分钟偏移）按时间线喂给适配层。
 * 同一时刻先结束上一环节、再开始下一环节，保证虚拟承运区间无缝衔接。
 */

import { BATCH, VEHICLES, SENSORS, SEGMENTS, NOTES, COMPARTMENT } from './scenario.js';
import { generateReadings } from './simulator.js';

/**
 * @param {object} driver DirectDriver 或 HttpDriver
 * @param {object} opts {t0Sec:number, onProgress?:(msg,data)=>void}
 */
export async function runScenario(driver, { t0Sec, onProgress = () => {} }) {
  const at = (min) => t0Sec + min * 60;

  // 1. 建档：批次、车辆、车载传感器
  await driver.createShipment({ ...BATCH, ts: at(0) });
  onProgress('shipment', { code: BATCH.code });

  for (const v of VEHICLES) {
    await driver.registerVehicle(v);
  }
  for (const s of SENSORS) {
    await driver.registerSensor(s);
  }
  onProgress('assets', { vehicles: VEHICLES.length, sensors: SENSORS.length });

  // 2. 环节开始（第一个在 08:00），记录返回的环节 id
  const segmentIds = new Map();
  for (const seg of SEGMENTS) {
    const created = await driver.startSegment({
      shipment_code: BATCH.code,
      vehicle_code: seg.vehicle_code,
      compartment: COMPARTMENT,
      stage: seg.stage,
      party: seg.party,
      operator: seg.operator,
      ts: at(seg.startMin),
    });
    segmentIds.set(seg.stage, created.id);
    onProgress('segment_start', { min: seg.startMin, label: seg.stageLabel, party: seg.party });
  }

  // 3. 合并交接结束、业务事件、读数到同一时间线，按 (时间, 类型优先级) 排序
  const jobs = [];
  for (const seg of SEGMENTS) {
    if (seg.endMin !== null) {
      jobs.push({ min: seg.endMin, order: 0, run: () => driver.endSegment({
        segment_id: segmentIds.get(seg.stage),
        ts: at(seg.endMin),
        operator: seg.operator,
        note: `${seg.stageLabel}交接`,
      }) });
    }
  }
  for (const n of NOTES) {
    jobs.push({ min: n.min, order: 2, run: () => driver.recordEvent({
      shipment_code: BATCH.code, kind: n.kind, detail: n.detail, ts: at(n.min),
    }) });
  }
  for (const r of generateReadings(t0Sec)) {
    jobs.push({ min: r.min, order: 1, run: () => driver.ingestReading({
      sensor_code: r.sensor_code, temp: r.temp, ts: r.ts,
    }).then((res) => {
      if (res.action === 'alarm_opened') onProgress('alarm_open', r);
      else if (res.action === 'close') onProgress('alarm_close', r);
      else if (res.action === 'excursion') onProgress('excursion', r);
    }) });
  }

  jobs.sort((a, b) => a.min - b.min || a.order - b.order);

  let done = 0;
  for (const job of jobs) {
    await job.run();
    done += 1;
    if (done % 12 === 0) onProgress('progress', { done, total: jobs.length });
  }
  onProgress('progress', { done, total: jobs.length });

  return { batchCode: BATCH.code, total: jobs.length };
}
