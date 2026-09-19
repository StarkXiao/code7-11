#!/usr/bin/env node
/**
 * 启动 HTTP API 服务。
 *   node src/cli/serve.js [--port 3000] [--store data/coldchain.jsonl]
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createServer } from '../api.js';
import { DEFAULT_STORE_PATH } from '../config.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const port = Number(arg('port', process.env.PORT ?? 3000));
const storeArg = arg('store', null);
const storePath = storeArg
  ? pathToFileURL(path.resolve(storeArg))
  : DEFAULT_STORE_PATH;

const { server } = await createServer(storePath);
server.listen(port, () => {
  console.log(`冷链温控追溯系统已启动`);
  console.log(`  API:    http://127.0.0.1:${port}`);
  console.log(`  SSE:    http://127.0.0.1:${port}/api/stream`);
  console.log(`  存储:   ${storePath === ':memory:' ? '(内存)' : storePath.pathname ?? storePath}`);
  console.log(`提示：另开终端执行 npm run push-demo 可推送一个完整运输批次的模拟数据`);
});
