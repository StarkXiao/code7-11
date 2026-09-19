/**
 * 推送适配层：模拟器不关心后端在进程内还是 HTTP 服务后面。
 *  - DirectDriver：直接调用 ColdChainService（demo.js 用，内存库）
 *  - HttpDriver：调用运行中的 API（push-demo.js 用，global fetch，Node20 内置）
 */

export class DirectDriver {
  /** @param {import('../src/service.js').ColdChainService} service */
  constructor(service) {
    this.service = service;
  }

  createShipment(p) { return this.service.createShipment(p); }
  registerVehicle(p) { return this.service.registerVehicle(p); }
  registerSensor(p) { return this.service.registerSensor(p); }
  startSegment(p) { return this.service.startSegment(p); }
  endSegment(p) { return this.service.endSegment(p); }
  recordEvent(p) { return this.service.recordEvent(p); }
  ingestReading(p) { return this.service.ingestReading(p); }
}

export class HttpDriver {
  constructor(baseUrl = 'http://127.0.0.1:3000') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async _post(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error ?? res.statusText}`);
    return data;
  }

  createShipment(p) { return this._post('/api/shipments', p); }
  registerVehicle(p) { return this._post('/api/vehicles', p); }
  registerSensor(p) { return this._post('/api/sensors', p); }
  startSegment(p) { return this._post('/api/segments', p); }
  endSegment(p) { return this._post('/api/segments/end', p); }
  recordEvent(p) { return this._post('/api/events', p); }

  async ingestReading(p) {
    // HTTP 批量推送返回精简结果；保留与 DirectDriver 相同的调用形态
    const res = await this._post('/api/readings', p);
    return { http: true, ...res };
  }

  async health() {
    const res = await fetch(this.baseUrl + '/healthz');
    return res.ok;
  }
}
