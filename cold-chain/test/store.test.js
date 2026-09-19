import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ColdChainService } from '../src/service.js';

const T0 = 1_000_000;
const sec = (m) => T0 + m * 60;

test('事件落盘后重建：新服务实例从 JSONL 重放出相同状态与责任拆分', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-'));
  const file = pathToFileURL(path.join(dir, 'log.jsonl'));

  async function build() {
    const svc = await new ColdChainService(file).init();
    await svc.createShipment({ code: 'P1', min_temp: 2, max_temp: 8, ts: sec(0) });
    await svc.registerVehicle({ code: 'V1' });
    await svc.registerVehicle({ code: 'V2' });
    await svc.registerSensor({ code: 'S1', vehicle_code: 'V1' });
    await svc.registerSensor({ code: 'S2', vehicle_code: 'V2' });
    const seg = await svc.startSegment({ shipment_code: 'P1', vehicle_code: 'V1', stage: 'line_haul', party: '甲', ts: sec(0) });
    await svc.endSegment({ segment_id: seg.id, ts: sec(20) });
    await svc.startSegment({ shipment_code: 'P1', vehicle_code: 'V2', stage: 'transfer', party: '乙', ts: sec(20) });
    await svc.ingestReading({ sensor_code: 'S1', temp: 9, ts: sec(10) });
    await svc.ingestReading({ sensor_code: 'S1', temp: 9.2, ts: sec(15) });
    await svc.ingestReading({ sensor_code: 'S1', temp: 9.2, ts: sec(20) });
    await svc.ingestReading({ sensor_code: 'S2', temp: 9.1, ts: sec(20) });
    await svc.ingestReading({ sensor_code: 'S2', temp: 7, ts: sec(25) });
    return svc;
  }

  const before = await build();
  const traceBefore = before.traceShipment('P1');

  // 全新实例，仅靠重放日志恢复
  const after = await new ColdChainService(file).init();
  const traceAfter = after.traceShipment('P1');

  assert.equal(traceAfter.shipment.code, 'P1');
  assert.equal(traceAfter.segments.length, 2);
  assert.equal(traceAfter.alarms.length, 1);
  assert.deepEqual(
    traceAfter.alarms[0].responsibility,
    traceBefore.alarms[0].responsibility
  );
  assert.equal(traceAfter.stats.reading_count, traceBefore.stats.reading_count);
  assert.equal(traceAfter.verdict.code, traceBefore.verdict.code);

  // JSONL 每行一条事件
  const text = await fs.readFile(file, 'utf8');
  const lines = text.trim().split('\n');
  assert.ok(lines.length >= 10);
  for (const line of lines) JSON.parse(line);

  await fs.rm(dir, { recursive: true, force: true });
});
