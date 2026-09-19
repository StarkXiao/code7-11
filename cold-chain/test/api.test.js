import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/api.js';

const { server } = await createServer(':memory:');
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}`;
after(() => server.close());

const T0 = 2_000_000;
const at = (m) => new Date((T0 + m * 60) * 1000).toISOString();

async function post(pathName, body) {
  const res = await fetch(BASE + pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

const get = (pathName) => fetch(BASE + pathName).then(async (r) => ({ status: r.status, data: await r.json() }));

test('完整 HTTP 闭环：建档 → 环节 → 读数 → 报警 → 回溯', async () => {
  const { status: s1 } = await post('/api/shipments', {
    code: 'HTTP1', product: '疫苗', min_temp: 2, max_temp: 8, ts: at(0),
  });
  assert.equal(s1, 201);

  assert.equal((await post('/api/vehicles', { code: 'HV1' })).status, 201);
  assert.equal((await post('/api/sensors', { code: 'HS1', vehicle_code: 'HV1' })).status, 201);
  assert.equal((await post('/api/segments', {
    shipment_code: 'HTTP1', vehicle_code: 'HV1', stage: 'line_haul', party: '甲', ts: at(0),
  })).status, 201);

  const ok = await post('/api/readings', { sensor_code: 'HS1', temp: 5, ts: at(5) });
  assert.equal(ok.status, 202);
  assert.equal(ok.data.action, 'ok');

  const hot = await post('/api/readings', { sensor_code: 'HS1', temp: 9.5, ts: at(10) });
  assert.equal(hot.data.action, 'alarm_opened');
  assert.equal(hot.data.alarm.status, 'open');

  const cool = await post('/api/readings', { sensor_code: 'HS1', temp: 6, ts: at(15) });
  assert.equal(cool.data.action, 'close');
  assert.equal(cool.data.alarm.status, 'closed');
  // 时间戳以 ISO 字符串返回
  assert.match(cool.data.alarm.opened_at, /^\d{4}-\d{2}-\d{2}T/);

  const trace = await get('/api/shipments/HTTP1/trace');
  assert.equal(trace.status, 200);
  assert.equal(trace.data.alarms.length, 1);
  assert.equal(trace.data.verdict.compliant, false);
  assert.equal(trace.data.alarms[0].responsibility.bySegment[0].party, '甲');

  const alarms = await get('/api/alarms?shipment=HTTP1&status=closed');
  assert.equal(alarms.data.length, 1);

  const list = await get('/api/shipments');
  assert.ok(list.data.some((x) => x.code === 'HTTP1'));
});

test('批量读数接口返回报警状态变化与孤儿计数', async () => {
  await post('/api/shipments', { code: 'HTTP2', min_temp: 2, max_temp: 8, ts: at(0) });
  await post('/api/vehicles', { code: 'HV2' });
  await post('/api/sensors', { code: 'HS2', vehicle_code: 'HV2' });
  // 故意不建环节，全部成为孤儿
  const res = await post('/api/readings', {
    readings: [
      { sensor_code: 'HS2', temp: 9, ts: at(5) },
      { sensor_code: 'HS2', temp: 10, ts: at(10) },
    ],
  });
  assert.equal(res.status, 202);
  assert.equal(res.data.accepted, 2);
  assert.equal(res.data.orphaned, 2);
  assert.deepEqual(res.data.events, []);
});

test('参数错误返回 400，未知批次返回 404', async () => {
  const bad = await post('/api/readings', { sensor_code: 'NOPE', temp: 5 });
  assert.equal(bad.status, 400);
  const missing = await get('/api/shipments/NO_SUCH/trace');
  assert.equal(missing.status, 404);
});

test('SSE：建立连接后新报警实时推送', async () => {
  await post('/api/shipments', { code: 'HTTP3', min_temp: 2, max_temp: 8, ts: at(0) });
  await post('/api/vehicles', { code: 'HV3' });
  await post('/api/sensors', { code: 'HS3', vehicle_code: 'HV3' });
  await post('/api/segments', {
    shipment_code: 'HTTP3', vehicle_code: 'HV3', stage: 'line_haul', party: '甲', ts: at(0),
  });

  const controller = new AbortController();
  const streamPromise = (async () => {
    const res = await fetch(BASE + '/api/stream', { signal: controller.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes('event: alarm.opened')) return buf;
    }
    return buf;
  })();

  // 给 SSE 连接建立留出时间
  await new Promise((r) => setTimeout(r, 200));
  await post('/api/readings', { sensor_code: 'HS3', temp: 9.9, ts: at(5) });

  const got = await streamPromise;
  controller.abort();
  assert.match(got, /event: alarm\.opened/);
  assert.match(got, /"direction":"high"/);
  assert.match(got, /"peak_temp":9.9/);
});
