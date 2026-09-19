import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { EventStore } from '../src/store/event-store.js';

// 直接组装 app（注入独立临时事件日志），再用真实 HTTP server 暴露
async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-http-'));
  const file = join(dir, 'events.jsonl');
  const { createApp } = await import('../src/api/app.js');
  const app = createApp({ store: new EventStore(file) });
  const server = app.server;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  return { base: `http://127.0.0.1:${port}`, app, file };
}

const MIN = 60_000;

test('健康检查 → 无令牌上报 401 → 带令牌注册/发运/上报 → 追溯闭环', async () => {
  const { base } = await startServer();

  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  assert.equal(health.ok, true);

  // 1) 无令牌被拒
  const noAuth = await fetch(`${base}/api/gateway/readings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ batchId: 'x', sensorId: 'y', tempC: 4 }),
  });
  assert.equal(noAuth.status, 401);

  const auth = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

  // 2) 注册传感器与批次
  const sensor = await fetch(`${base}/api/admin/sensors`, {
    method: 'POST', headers: auth, body: JSON.stringify({ id: 'HTTP-1', label: '车载探头' }),
  }).then((r) => r.json());
  assert.equal(sensor.id, 'HTTP-1');

  const batch = await fetch(`${base}/api/admin/batches`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      code: 'HTTP-B1', product: '测试冷冻草莓', zone: 'frozen',
      shipper: { name: '甲冷库' }, carrier: { name: '乙物流' }, consignee: { name: '丙超市' },
      sensorIds: ['HTTP-1'],
    }),
  }).then((r) => r.json());
  assert.equal(batch.status, 'registered');

  await fetch(`${base}/api/admin/batches/HTTP-B1/start`, { method: 'POST', headers: auth, body: '{}' });

  // 3) 发运交接合格
  const t0 = Date.now() - 40 * MIN;
  const dep = await fetch(`${base}/api/admin/handovers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ batchCode: 'HTTP-B1', stage: 'departure', holder: '甲冷库值班员', measuredTempC: -20, ts: t0 }),
  }).then((r) => r.json());
  assert.ok(dep.id);

  // 4) 上报读数：先 20 分钟合格，再持续高温 30 分钟（超过 10 分钟容忍）
  for (let m = 0; m < 20; m++) {
    const r = await fetch(`${base}/api/gateway/readings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ batchId: batch.id, sensorId: 'HTTP-1', tempC: -20, ts: t0 + m * MIN }),
    });
    assert.equal(r.status, 202);
  }
  for (let m = 20; m < 50; m++) {
    await fetch(`${base}/api/gateway/readings`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ batchId: batch.id, sensorId: 'HTTP-1', tempC: -9, ts: t0 + m * MIN }),
    });
  }

  // 5) 到货交接越限（主责运输）
  await fetch(`${base}/api/admin/handovers`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ batchCode: 'HTTP-B1', stage: 'arrival', holder: '丙超市收货员', measuredTempC: -9.4, ts: t0 + 50 * MIN }),
  });
  // 回带内，关闭超温
  await fetch(`${base}/api/gateway/readings`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ batchId: batch.id, sensorId: 'HTTP-1', tempC: -20, ts: t0 + 52 * MIN }),
  });
  await fetch(`${base}/api/admin/batches/HTTP-B1/finish`, { method: 'POST', headers: auth, body: '{}' });

  // 6) 追溯报告
  const report = await fetch(`${base}/api/batches/HTTP-B1/trace`).then((r) => r.json());
  assert.equal(report.conclusion.status, 'FAIL');
  assert.equal(report.excursions.length, 1);
  assert.equal(report.excursions[0].attribution.primaryStage, 'transport');
  assert.equal(report.integrity.ok, true);

  // 7) 坏数据 422
  const bad = await fetch(`${base}/api/gateway/readings`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ batchId: batch.id, sensorId: 'HTTP-1', tempC: 500, ts: t0 + 53 * MIN }),
  });
  assert.equal(bad.status, 422);

  // 8) 篡改校验接口
  const integrity = await fetch(`${base}/api/integrity`).then((r) => r.json());
  assert.equal(integrity.ok, true);
});

test('SSE 实时推送：连接后能收到后续上报的 reading_ingested 事件', async () => {
  const { base, app } = await startServer();
  const monitor = app.monitor;

  const auth = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
  await fetch(`${base}/api/admin/sensors`, { method: 'POST', headers: auth, body: JSON.stringify({ id: 'SSE-1', label: 'SSE探头' }) });
  const batch = await fetch(`${base}/api/admin/batches`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      code: 'SSE-B1', product: '疫苗', zone: 'pharma',
      shipper: { name: 'A' }, carrier: { name: 'B' }, consignee: { name: 'C' }, sensorIds: ['SSE-1'],
    }),
  }).then((r) => r.json());
  await fetch(`${base}/api/admin/batches/SSE-B1/start`, { method: 'POST', headers: auth, body: '{}' });

  const got = new Promise((resolve) => {
    const es = new EventSourcePolyfill(`${base}/api/stream`);
    es.onmessage = (data) => {
      const event = JSON.parse(data);
      if (event.type === 'reading_ingested') {
        es.close();
        resolve(event);
      }
    };
    es.onclose = () => resolve(null);
  });

  // 给 SSE 建连一点时间
  await new Promise((r) => setTimeout(r, 150));
  await fetch(`${base}/api/gateway/readings`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ batchId: batch.id, sensorId: 'SSE-1', tempC: 5, ts: Date.now() }),
  });
  const event = await got;
  assert.equal(event.type, 'reading_ingested');
  assert.equal(event.payload.tempC, 5);
  assert.ok(event.hash);

  // 防止未使用告警
  assert.ok(monitor);
});

// 极简 EventSource 实现（Node 没有内置 EventSource）
class EventSourcePolyfill {
  constructor(url) {
    this.url = url;
    this.controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: this.controller.signal });
        const reader = res.body.getReader();
        this.reader = reader;
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data: ')) this.onmessage?.(line.slice(6));
            }
          }
        }
      } catch {
        // abort/连接关闭是预期行为
      } finally {
        this.onclose?.();
      }
    })();
  }
  close() {
    this.controller.abort();
    this.reader?.cancel().catch(() => {});
  }
}
