// 共享装配：给测试与 CLI 使用（可注入独立数据文件，互不污染）
import { EventStore } from './store/event-store.js';
import { Monitor } from './ingest/monitor.js';
import { IngestGateway } from './ingest/gateway.js';
import { Commands } from './commands/index.js';

export function buildServices(eventLogFile) {
  const store = new EventStore(eventLogFile);
  store.load();
  const monitor = new Monitor(store, { gapMs: store.state.gapMs });
  monitor.rebuild();
  const gateway = new IngestGateway(store, monitor);
  gateway.rebuild();
  const commands = new Commands(store, monitor);
  return { store, monitor, gateway, commands };
}
