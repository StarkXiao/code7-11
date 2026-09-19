import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { EventStore, hashEvent } from '../src/store/event-store.js';

function tmpStore() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-chain-'));
  return new EventStore(join(dir, 'events.jsonl'));
}

test('事件逐条哈希链接，重放得到相同状态', async () => {
  const s1 = tmpStore();
  await s1.append('batch_registered', { id: 'b1', code: 'B1', sensorIds: [] });
  await s1.append('sensor_registered', { id: 's1' });
  await s1.append('reading_ingested', { id: 'r1', batchId: 'b1', sensorId: 's1', tempC: 4, ts: 1 });

  const verify = await s1.verify();
  assert.equal(verify.ok, true);
  assert.equal(verify.total, 3);

  const s2 = new EventStore(s1.file);
  s2.load();
  assert.equal(s2.state.batches['b1'].code, 'B1');
  assert.equal(s2.state.readings.length, 1);
  assert.equal(s2.lastHash, s1.lastHash);
});

test('篡改任一事件内容：哈希校验在断点处失败', async () => {
  const s = tmpStore();
  await s.append('reading_ingested', { id: 'r1', batchId: 'b', sensorId: 'x', tempC: 4, ts: 1 });
  await s.append('reading_ingested', { id: 'r2', batchId: 'b', sensorId: 'x', tempC: 5, ts: 2 });
  await s.append('reading_ingested', { id: 'r3', batchId: 'b', sensorId: 'x', tempC: 6, ts: 3 });

  const lines = readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  lines[1].payload.tempC = 22; // 把 5°C 改成 22°C
  writeFileSync(s.file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const result = await s.verify();
  assert.equal(result.ok, false);
  assert.equal(result.atSeq, 2);
  assert.match(result.reason, /哈希不一致/);
});

test('删除中间事件：断链检出', async () => {
  const s = tmpStore();
  for (let i = 0; i < 4; i++) {
    await s.append('reading_ingested', { id: `r${i}`, batchId: 'b', sensorId: 'x', tempC: i, ts: i });
  }
  const lines = readFileSync(s.file, 'utf8').split('\n').filter(Boolean);
  writeFileSync(s.file, lines.filter((_, i) => i !== 1).join('\n') + '\n');
  const result = await s.verify();
  assert.equal(result.ok, false);
  assert.equal(result.atSeq, 3); // 删除原 seq=2 后，原 seq=3 成为第 2 条且其 prevHash 断链
});

test('canonical 序列化对键顺序不敏感：同一事实哈希一致', () => {
  const e1 = { seq: 1, ts: 1, type: 't', payload: { a: 1, b: 2 } };
  const e2 = { seq: 1, ts: 1, type: 't', payload: { b: 2, a: 1 } };
  assert.equal(hashEvent('0'.repeat(64), e1), hashEvent('0'.repeat(64), e2));
});
