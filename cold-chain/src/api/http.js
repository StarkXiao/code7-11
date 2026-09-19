// 极简 HTTP 工具（零依赖）
export function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 256 * 1024) {
        const err = new Error('请求体超过 256KB 上限');
        err.statusCode = 413;
        reject(err);
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// Bearer 网关令牌（设备/模拟器上报使用）
export function requireGatewayToken(req, res, token) {
  const header = req.headers['authorization'] || '';
  const got = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-gateway-token'];
  if (got !== token) {
    sendJson(res, 401, { error: 'unauthorized', message: '缺少或错误的网关令牌（Authorization: Bearer <token>）' });
    return false;
  }
  return true;
}

export function notFound(res) {
  sendJson(res, 404, { error: 'not_found', message: '接口不存在' });
}
