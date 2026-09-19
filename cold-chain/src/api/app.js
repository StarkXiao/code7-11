// HTTP 应用：REST API + SSE + 静态仪表盘
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { store as defaultStore, EventStore } from '../store/event-store.js';
import { Monitor } from '../ingest/monitor.js';
import { IngestGateway } from '../ingest/gateway.js';
import { Commands } from '../commands/index.js';
import { buildTraceReport } from '../domain/trace.js';
import { SCENARIOS, compileScenario } from '../simulator/scenarios.js';
import { runScenario } from '../simulator/runner.js';
import { SseHub } from './sse.js';
import { sendJson, readJson, requireGatewayToken, notFound } from './http.js';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(here, '../../web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

export function createApp(options = {}) {
  // 允许测试注入独立事件日志；生产用默认单例
  const store = options.store || defaultStore;
  store.load();
  const monitor = new Monitor(store, { gapMs: config.sensorGapMs });
  monitor.rebuild();
  const gateway = new IngestGateway(store, monitor);
  gateway.rebuild();
  const commands = new Commands(store, monitor);
  const hub = new SseHub(store);

  const listBatches = () =>
    Object.values(store.state.batches)
      .map((b) => ({
        id: b.id,
        code: b.code,
        product: b.product,
        quantity: b.quantity,
        zone: b.zone,
        status: b.status,
        vehicleId: b.vehicleId,
        shipper: b.shipper?.name,
        carrier: b.carrier?.name,
        consignee: b.consignee?.name,
        readingsCount: b.readingsCount,
        startedAt: b.startedAt,
        finishedAt: b.finishedAt,
        sensorIds: b.sensorIds,
        openExcursions: Object.values(store.state.activeExcursions).filter((e) => e.batchId === b.id).length,
      }))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  async function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const filePath = normalize(join(WEB_DIR, rel));
    if (!filePath.startsWith(WEB_DIR)) return notFound(res);
    try {
      const s = await stat(filePath);
      if (s.isDirectory()) return notFound(res);
      const body = await readFile(filePath);
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      notFound(res);
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;
    const isApi = pathname.startsWith('/api/');
    if (!isApi) return serveStatic(req, res, pathname);

    const route = `${req.method} ${pathname}`;
    try {
      // --- 健康检查 ---
      if (route === 'GET /api/health') {
        return sendJson(res, 200, {
          ok: true,
          batches: Object.keys(store.state.batches).length,
          readings: store.state.readings.length,
          activeExcursions: Object.keys(store.state.activeExcursions).length,
          lastSeq: store.seq,
        });
      }

      // --- 实时事件流 ---
      if (req.method === 'GET' && pathname === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        hub.add(res);
        return;
      }

      // --- 设备上报（网关令牌）---
      if (req.method === 'POST' && pathname === '/api/gateway/readings') {
        if (!requireGatewayToken(req, res, config.gatewayToken)) return;
        const body = await readJson(req);
        // 支持单条与批量
        const items = Array.isArray(body) ? body : [body];
        if (!items.length) return sendJson(res, 400, { error: 'bad_request', message: '空批量' });
        const results = [];
        for (const item of items) {
          // 批量上报中任一条非法则整批拒收（时间戳严格递增不被破坏）
          results.push(await gateway.ingest(item));
        }
        return sendJson(res, 202, { accepted: results.length, results });
      }

      // --- 管理/查询接口 ---
      if (route === 'GET /api/batches') {
        const status = url.searchParams.get('status');
        let rows = listBatches();
        if (status) rows = rows.filter((b) => b.status === status);
        return sendJson(res, 200, { items: rows });
      }

      if (route === 'POST /api/admin/batches') {
        const batch = await commands.registerBatch(await readJson(req));
        return sendJson(res, 201, batch);
      }

      if (req.method === 'POST' && /^\/api\/admin\/batches\/[^/]+\/sensors$/.test(pathname)) {
        const code = decodeURIComponent(pathname.split('/')[4]);
        const { sensorId } = await readJson(req);
        const batch = await commands.bindSensor(code, sensorId);
        return sendJson(res, 200, { id: batch.id, code: batch.code, sensorIds: batch.sensorIds });
      }

      if (route === 'POST /api/admin/sensors') {
        const sensor = await commands.registerSensor(await readJson(req));
        return sendJson(res, 201, sensor);
      }

      if (req.method === 'POST' && /^\/api\/admin\/batches\/[^/]+\/start$/.test(pathname)) {
        const code = decodeURIComponent(pathname.split('/')[4]);
        const body = await readJson(req).catch(() => ({}));
        const batch = await commands.startBatch(code, body.ts);
        return sendJson(res, 200, batch);
      }

      if (req.method === 'POST' && /^\/api\/admin\/batches\/[^/]+\/finish$/.test(pathname)) {
        const code = decodeURIComponent(pathname.split('/')[4]);
        const body = await readJson(req).catch(() => ({}));
        const batch = await commands.finishBatch(code, body.ts);
        return sendJson(res, 200, batch);
      }

      if (route === 'POST /api/admin/handovers') {
        const handover = await commands.recordHandover(await readJson(req));
        return sendJson(res, 201, handover);
      }

      // 批次实时监控视图
      if (req.method === 'GET' && /^\/api\/batches\/[^/]+\/monitor$/.test(pathname)) {
        const idOrCode = decodeURIComponent(pathname.split('/')[3]);
        const batch = store.state.batches[idOrCode]
          || Object.values(store.state.batches).find((b) => b.code === idOrCode);
        if (!batch) return sendJson(res, 404, { error: 'not_found', message: '批次不存在' });
        const live = Object.values(store.state.activeExcursions).filter((e) => e.batchId === batch.id);
        const latest = new Map();
        for (const r of store.state.readings.filter((r) => r.batchId === batch.id)) {
          const prev = latest.get(r.sensorId);
          if (!prev || r.ts > prev.ts) latest.set(r.sensorId, r);
        }
        return sendJson(res, 200, {
          batch: listBatches().find((b) => b.id === batch.id),
          latestReadings: [...latest.values()],
          activeExcursions: live,
          monitorStatus: batch.sensorIds.map((sid) => ({ sensorId: sid, ...monitor.statusOf(batch.id, sid) })),
        });
      }

      // 完整溯源报告
      if (req.method === 'GET' && /^\/api\/batches\/[^/]+\/trace$/.test(pathname)) {
        const idOrCode = decodeURIComponent(pathname.split('/')[3]);
        const batch = store.state.batches[idOrCode]
          || Object.values(store.state.batches).find((b) => b.code === idOrCode);
        if (!batch) return sendJson(res, 404, { error: 'not_found', message: '批次不存在' });
        const verifyResult = await store.verify();
        const report = buildTraceReport(store.state, batch.id, verifyResult);
        return sendJson(res, 200, report);
      }

      // 温度序列（图表用，可限采样数量）
      if (req.method === 'GET' && /^\/api\/batches\/[^/]+\/readings$/.test(pathname)) {
        const idOrCode = decodeURIComponent(pathname.split('/')[3]);
        const batch = store.state.batches[idOrCode]
          || Object.values(store.state.batches).find((b) => b.code === idOrCode);
        if (!batch) return sendJson(res, 404, { error: 'not_found', message: '批次不存在' });
        const sensorId = url.searchParams.get('sensorId');
        let rows = store.state.readings.filter((r) => r.batchId === batch.id);
        if (sensorId) rows = rows.filter((r) => r.sensorId === sensorId);
        rows.sort((a, b) => a.ts - b.ts);
        const limit = Number(url.searchParams.get('limit') || 5000);
        if (rows.length > limit) {
          // 等距抽稀，且始终保留最后一条读数（监控视图取 limit=1 时语义为"最新读数"）
          const step = rows.length / limit;
          rows = Array.from({ length: limit }, (_, i) => rows[Math.min(rows.length - 1, Math.floor(i * step))]);
          rows[limit - 1] = store.state.readings
            .filter((r) => r.batchId === batch.id && (!sensorId || r.sensorId === sensorId))
            .sort((a, b) => a.ts - b.ts)
            .at(-1);
        }
        return sendJson(res, 200, { items: rows });
      }

      // 超温事件台账
      if (route === 'GET /api/excursions') {
        const closed = Object.values(store.state.closedExcursions);
        const open = Object.values(store.state.activeExcursions);
        return sendJson(res, 200, { open, closed });
      }

      // 运维：重置事件日志并跑全部模拟剧本（需网关令牌；通过事件流可实时观看判定过程）
      if (req.method === 'POST' && pathname === '/api/admin/simulate') {
        if (!requireGatewayToken(req, res, config.gatewayToken)) return;
        const body = await readJson(req).catch(() => ({}));
        if (body.reset !== false) {
          store.reset();
          monitor.trackers.clear();
          gateway.lastIngestedTs.clear();
        }
        const ids = body.scenarioIds?.length ? body.scenarioIds : SCENARIOS.map((s) => s.id);
        const created = [];
        for (const id of ids) {
          const { batch } = await runScenario({ commands, gateway }, compileScenario(SCENARIOS.find((s) => s.id === id)));
          created.push({ code: batch.code, id: batch.id });
        }
        return sendJson(res, 200, { ran: created, totalEvents: store.seq });
      }

      // 篡改校验
      if (route === 'GET /api/integrity') {
        const result = await store.verify();
        return sendJson(res, result.ok ? 200 : 409, result);
      }

      return notFound(res);
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, {
        error: status === 500 ? 'internal_error' : 'request_error',
        message: err.message,
        ...(err.errors ? { details: err.errors } : {}),
      });
      if (status === 500) console.error('[api]', err);
    }
  });

  return { server, store, monitor, gateway, commands };
}
