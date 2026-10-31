// 配置快照回归：创建 / 列出 / 回滚 / 删除。
//
// 钉住的边界（每条都对应一个会真出事的情形）：
//   1. 快照只收配置 —— 流水（token-usage.jsonl / tool-calls.jsonl / *.log）不能进去，
//      否则快照目录会以每天几十 MB 的速度膨胀，而它存在的意义是「配置改坏了能退」；
//   2. 删除只认 ISO 时间戳目录名 —— id 来自 HTTP 请求体，直接拼路径就是路径穿越；
//   3. 回滚前必须自动备份当前状态 —— 否则「回滚错了」就再没有回头路；
//   4. 回滚的自动备份不能把自己要恢复的那份挤掉（protectId），
//      否则刚好超过 10 份时，用户点回滚反而会删掉回滚目标；
//   5. 滚动保留 10 份，且这个上限不能被删除操作绕过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const root = fileURLToPath(new URL('..', import.meta.url));

await test('快照只收配置，不收流水与日志', async () => {
  const h = await bridgeHarness();
  // 造一份状态文件 + 一份流水，确认前者进、后者不进
  fs.writeFileSync(path.join(h.temp, 'state', 'sessions.json'), '{"sessions":{}}');
  fs.writeFileSync(path.join(h.temp, 'state', 'token-usage.jsonl'), '{"k":"turn"}\n');
  fs.writeFileSync(path.join(h.temp, 'state', 'bridge.log'), 'log\n');
  const names = h.snapshotTargets().map((t) => t.rel);
  assert.ok(names.includes('config.json'), 'config.json 必须在快照里');
  assert.ok(names.includes('state/sessions.json'), 'state 下的 json 状态文件要在快照里');
  for (const bad of ['state/token-usage.jsonl', 'state/bridge.log', 'state/qq-activity.log']) {
    assert.ok(!names.includes(bad), `${bad} 是只增不减的流水，不该进快照`);
  }
  await h.close();
});

await test('创建后可列出，meta 记下备注与文件清单', async () => {
  const h = await bridgeHarness();
  const { id, files } = h.createSnapshot('改黑话阈值之前');
  assert.match(id, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/);
  assert.ok(files.length > 0, '至少要拷进去一个文件');
  const list = h.listSnapshots();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].note, '改黑话阈值之前');
  assert.ok(list[0].files.includes('config.json'));
  // 目录里确实有拷贝，不是只写了 meta
  assert.ok(fs.existsSync(path.join(h.temp, 'state', 'snapshots', id, 'config.json')));
  await h.close();
});

await test('列表按时间倒序：最新的排最前', async () => {
  const h = await bridgeHarness();
  const a = h.createSnapshot('早');
  // 目录名精确到毫秒，同一毫秒内连建两份会撞名，稍等一下
  await new Promise((r) => setTimeout(r, 5));
  const b = h.createSnapshot('晚');
  const list = h.listSnapshots();
  assert.equal(list[0].id, b.id);
  assert.equal(list[1].id, a.id);
  await h.close();
});

await test('删除单份：只删那一份，其余不动', async () => {
  const h = await bridgeHarness();
  const a = h.createSnapshot('甲');
  await new Promise((r) => setTimeout(r, 5));
  const b = h.createSnapshot('乙');
  assert.deepEqual({ ...h.deleteSnapshot(a.id) }, { id: a.id });
  const left = h.listSnapshots();
  assert.equal(left.length, 1);
  assert.equal(left[0].id, b.id);
  assert.ok(!fs.existsSync(path.join(h.temp, 'state', 'snapshots', a.id)), '目录要真的消失');
  await h.close();
});

await test('删除会挡住非法 id（路径穿越不能靠事后 sanitize）', async () => {
  const h = await bridgeHarness();
  h.createSnapshot('占位');
  for (const bad of ['../config.json', '..', '', 'abc', '2026-1-1', '2026-01-01T00-00-00-000Z/../x', null, undefined]) {
    assert.throws(() => h.deleteSnapshot(bad), /不合法/, `应当拒绝 ${JSON.stringify(bad)}`);
  }
  // 原快照没被误删
  assert.equal(h.listSnapshots().length, 1);
  await h.close();
});

await test('删除不存在的合法 id 要报「不存在」而不是当成成功', async () => {
  const h = await bridgeHarness();
  assert.throws(() => h.deleteSnapshot('2020-01-01T00-00-00-000Z'), /不存在/);
  await h.close();
});

await test('回滚会先备份当前状态，且恢复内容正确', async () => {
  const h = await bridgeHarness();
  const snap = h.createSnapshot('原始');
  const configPath = path.join(h.temp, 'config.json');
  const before = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, before.replace('"ownerQQ"', '"ownerQQ_DUMMY"'));
  const changed = fs.readFileSync(configPath, 'utf8');
  assert.notEqual(changed, before, '前置条件：配置确实被改过');

  const result = h.restoreSnapshot(snap.id);
  assert.ok(result.restored.includes('config.json'));
  assert.equal(fs.readFileSync(configPath, 'utf8'), before, '回滚后应当与快照内容逐字节一致');

  // 回滚前那份自动备份必须存在，否则「回滚错了」就没退路
  const list = h.listSnapshots();
  assert.equal(list.length, 2);
  const backup = list.find((s) => s.id !== snap.id);
  assert.ok(backup && backup.note.includes('回滚'), '应当留下一份标注了回滚的自动备份');
  await h.close();
});

await test('回滚时的自动备份不会把回滚目标挤掉（满 10 份时）', async () => {
  const h = await bridgeHarness();
  const ids = [];
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    ids.push(h.createSnapshot(`第 ${i} 份`).id);
  }
  assert.equal(h.listSnapshots().length, 10);
  const oldest = ids[0];
  // 此刻再回滚最老那份：自动备份会新增第 11 份，滚动清理必须放过 protectId
  h.restoreSnapshot(oldest);
  const list = h.listSnapshots();
  assert.ok(list.some((s) => s.id === oldest), '要回滚的那份不能被自己的自动备份挤掉');
  assert.equal(list.length, 10, '保留上限仍然是 10');
  await h.close();
});

await test('滚动清理：超过 10 份只留最新 10 份', async () => {
  const h = await bridgeHarness();
  const ids = [];
  for (let i = 0; i < 13; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    ids.push(h.createSnapshot(`第 ${i} 份`).id);
  }
  const left = h.listSnapshots().map((s) => s.id);
  assert.equal(left.length, 10);
  for (const gone of ids.slice(0, 3)) assert.ok(!left.includes(gone), `${gone} 应当被清掉`);
  for (const kept of ids.slice(3)) assert.ok(left.includes(kept), `${kept} 应当保留`);
  await h.close();
});

await test('端点都在，且删除走 POST body 里的 id', async () => {
  const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');
  assert.ok(bridge.includes("'/api/snapshots/delete'"), '删除端点必须存在');
  assert.ok(bridge.includes("url.pathname === '/api/snapshots/restore'"));
  assert.ok(bridge.includes('function deleteSnapshot('));
  const html = fs.readFileSync(path.join(root, 'public', 'console.html'), 'utf8');
  assert.ok(html.includes('data-snap-delete'), '列表里要有删除按钮');
  assert.ok(html.includes("api('/api/snapshots/delete', 'POST'"), '按钮要打到删除端点');
});

if (failures) {
  console.error(`\n${failures} 条失败`);
  process.exit(1);
}
console.log('\n全部通过');
