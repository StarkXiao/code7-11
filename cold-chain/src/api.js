/**
 * HTTP API（node:http 原生实现，零第三方依赖）。
 *
 * 路由：
 *   GET    /healthz
 *   POST   /api/shipments                 运输批次建档
 *   GET    /api/shipments                 批次列表
 *   GET    /api/shipments/:id/trace       ★ 按批次完整回溯
 *   POST   /api/vehicles                  车辆注册
 *   POST   /api/sensors                   车载传感器注册
 *   POST   /api/segments                  承运环节开始
 *   POST   /api/segments/end              环节交接结束
 *   POST   /api/events                    业务事件（开门/故障/备注）
 *   POST   /api/readings                  ★ 温度读数接入（单条或 {readings:[...]} 批量）
 *   GET    /api/alarms?shipment=&status=  报警查询
 *   GET    /api/stream                   ★ SSE：实时推送报警开闭与越限读数
 */

import http from 'node:http';
import { URL } from 'node:url';
import { ColdChainService, ValidationError, NotFoundError, serializeView } from './service.js';
import { DEFAULT_STORE_PATH, SSE_HEARTBEAT_MS } from './config.js';

export async function createServer(storePath = DEFAULT_STORE_PATH) {
  const service = await new ColdChainService(storePath).init();

  // ---- SSE 客户端集合：领域事件实时广播 ----
  const sseClients = new Set();
  service.subscribe((event) => {
    if (!['alarm.opened', 'alarm.closed', 'reading.ingested'].includes(event.type)) return;    const payload = serializeView(event);
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(frame);
      } catch {
        sseClients.delete(res);
      }
    }
  });

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res, service, sseClients);
    } catch (err) {
      sendError(res, err);
    }
  });

  server.on('close', () => {
    for (const res of sseClients) res.end();
    sseClients.clear();
  });

  return { server, service };
}

async function route(req, res, service, sseClients) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/stream') {
    return openSse(res, sseClients);
  }

  if (method === 'GET' && pathname === '/api/shipments') {
    return sendJson(res, 200, serializeView(service.listShipments()));
  }

  if (method === 'POST' && pathname === '/api/shipments') {
    const body = await readJson(req);
    return sendJson(res, 201, serializeView(await service.createShipment(body)));
  }

  let m;
  if (method === 'GET' && (m = pathname.match(/^\/api\/shipments\/([^/]+)\/trace$/))) {
    return sendJson(res, 200, serializeView(service.traceShipment(decodeURIComponent(m[1]))));
  }

  if (method === 'POST' && pathname === '/api/vehicles') {
    return sendJson(res, 201, serializeView(await service.registerVehicle(await readJson(req))));
  }

  if (method === 'POST' && pathname === '/api/sensors') {
    return sendJson(res, 201, serializeView(await service.registerSensor(await readJson(req))));
  }

  if (method === 'POST' && pathname === '/api/segments') {
    return sendJson(res, 201, serializeView(await service.startSegment(await readJson(req))));
  }

  if (method === 'POST' && pathname === '/api/segments/end') {
    return sendJson(res, 200, serializeView(await service.endSegment(await readJson(req))));
  }

  if (method === 'POST' && pathname === '/api/events') {
    return sendJson(res, 201, serializeView(await service.recordEvent(await readJson(req))));
  }

  if (method === 'POST' && pathname === '/api/readings') {
    const body = await readJson(req);
    if (Array.isArray(body?.readings)) {
      const out = await service.ingestReadings(body.readings);
      // 只在响应里突出报警状态变化，避免回显大量读数
      const changes = out.filter((r) => r.action !== 'ok' && r.action !== 'orphan');
      return sendJson(res, 202, {
        accepted: out.length,
        orphaned: out.filter((r) => r.action === 'orphan').length,
        events: changes.map((r) => ({
          action: r.action,
          alarm_id: r.alarm?.id ?? null,
          status: r.alarm?.status ?? null,
        })),
      });
    }
    const out = await service.ingestReading(body);
    return sendJson(res, 202, {
      action: out.action,
      reading_ts: serializeView({ x: out.reading.ts }).x,
      alarm: out.alarm ? serializeView(service._alarmView(out.alarm)) : null,
    });
  }

  if (method === 'GET' && pathname === '/api/alarms') {
    const code = url.searchParams.get('shipment');
    let shipmentId = null;
    if (code) shipmentId = service.getShipment(code).id;
    const status = url.searchParams.get('status');
    return sendJson(res, 200, serializeView(service.listAlarms(shipmentId, status)));
  }

  sendJson(res, 404, { error: 'not found', path: pathname });
}

function openSse(res, clients) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  const timer = setInterval(() => {
    try {
      res.write(': hb\n\n');
    } catch {
      /* ignore */
    }
  }, SSE_HEARTBEAT_MS);
  reqCloseOnAbort(res, timer, clients);
}

function reqCloseOnAbort(res, timer, clients) {
  res.on('close', () => {
    clearInterval(timer);
    clients.delete(res);
  });
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('请求体不是合法 JSON');
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, err) {
  const status = err.statusCode ?? 500;
  if (status >= 500) console.error(err);
  sendJson(res, status, { error: err.message ?? 'internal error' });
}
