import { createApp } from './api/app.js';
import { config } from './config.js';

const { server } = createApp();
server.listen(config.port, () => {
  console.log(`冷链温控追溯系统已启动`);
  console.log(`  API:      http://localhost:${config.port}/api/health`);
  console.log(`  仪表盘:   http://localhost:${config.port}/`);
  console.log(`  事件流:   http://localhost:${config.port}/api/stream (SSE)`);
  console.log(`  数据目录: ${config.dataDir || config.eventLog}`);
});
