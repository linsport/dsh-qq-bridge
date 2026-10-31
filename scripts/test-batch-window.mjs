// 合并窗口优先级回归（2026-10-31）。
//
// 真实起因：群里被唤醒要等 7 秒才开口（日志 `计划唤醒 group:…（atMention），7s 后发送`）。
// 控制台「唤醒硬限制」里那格「合并窗口」填了也没用 —— 它只是**默认值**，只下发给
// confirmedBy === 'default' 的会话（refreshDefaultWakeConfigV2 首行就 return false），
// 而那个群早被 mark_read 标过；会话自己 wakeConfig.batchWindowMs=7000 又会被 AI
// 下次 qq_set_wake_config 原样写回去。所以人想压短等待，需要一层 AI 改不动的覆盖。
//
// 这里的契约：
//   1. 覆盖值优先于「私聊专用默认值」和「会话自己的 wakeConfig」；
//   2. 覆盖值只活在会话状态里（落盘、重启后仍在），且 0 表示不覆盖；
//   3. 覆盖值不能把窗口压到 1 秒以下（那是没有任何合并意义的值）；
//   4. 端点只收 1000~3600000，传 0 / null 表示取消覆盖，越界一律 400。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n  ${error?.message ?? error}`);
  }
}

const ADMIN = { 'x-console-token': 'fixture-console-token' };

function call(port, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: pathname, method, headers: { 'content-type': 'application/json', ...headers } },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          let json = null;
          try { json = JSON.parse(data); } catch {}
          resolve({ status: response.statusCode, body: data, json });
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('request hung')));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try { await run(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const h = await bridgeHarness({ config: { socialV2: {
  wake: { batchWindowMs: 5000, batchWindowMsPrivate: 0 },
  proactive: { enabled: false },
  sticker: { enabled: false }
} } });
h.setMode('reserved2');

const KEY = 'group:100001';

await test('没设覆盖时：群里看会话自己的 wakeConfig', async () => {
  const st = h.getSocialV2State(KEY);
  st.wakeConfig = { ...st.wakeConfig, batchWindowMs: 7000 };
  assert.equal(h.effectiveBatchWindowMsV2(KEY, st), 7000);
});

await test('没设覆盖时：私聊优先用 batchWindowMsPrivate', async () => {
  const st = h.getSocialV2State('private:10001');
  st.wakeConfig = { ...st.wakeConfig, batchWindowMs: 7000 };
  // 先把私聊专用值设上（默认 0 = 不覆盖）
  h.cfg.socialV2.wake.batchWindowMsPrivate = 2000;
  try {
    assert.equal(h.effectiveBatchWindowMsV2('private:10001', st), 2000);
  } finally {
    h.cfg.socialV2.wake.batchWindowMsPrivate = 0;
  }
});

await test('设了覆盖后：压过私聊专用值和会话自己的值', async () => {
  const st = h.getSocialV2State('private:10001');
  st.wakeConfig = { ...st.wakeConfig, batchWindowMs: 7000 };
  st.batchWindowOverrideMs = 1500;
  h.cfg.socialV2.wake.batchWindowMsPrivate = 2000;
  try {
    // 覆盖值最高：私聊专用值这次不该赢
    assert.equal(h.effectiveBatchWindowMsV2('private:10001', st), 1500);
  } finally {
    h.cfg.socialV2.wake.batchWindowMsPrivate = 0;
    st.batchWindowOverrideMs = 0;
  }
});

await test('覆盖值小于 1000 或非法时当作没设', async () => {
  const st = h.getSocialV2State(KEY);
  st.wakeConfig = { ...st.wakeConfig, batchWindowMs: 7000 };
  for (const bad of [0, 999, -1, null, undefined, 'abc', NaN]) {
    st.batchWindowOverrideMs = bad;
    assert.equal(h.effectiveBatchWindowMsV2(KEY, st), 7000, `覆盖值 ${String(bad)} 应该当作没设`);
  }
  // 下限兜底：wakeConfig 自己也脏的时候不能把定时器压成 0ms
  st.wakeConfig = { ...st.wakeConfig, batchWindowMs: 0 };
  assert.equal(h.effectiveBatchWindowMsV2(KEY, st), 8000, '会话值缺失时回落到 8000');
});

// ── 端点 ───────────────────────────────────────────────────────────────────────
await test('端点：设置 / 读回 / 取消覆盖', async () => {
  await withServer(h, async (port) => {
    const set = await call(port, '/api/socialV2/batch-window', {
      method: 'POST', headers: ADMIN, body: { key: KEY, ms: 1500 }
    });
    assert.equal(set.status, 200, set.body);
    assert.equal(set.json.batchWindowOverrideMs, 1500);

    const states = await call(port, '/api/socialV2/states', { headers: ADMIN });
    assert.equal(states.status, 200);
    const row = (states.json.conversations || []).find((c) => c.key === KEY);
    assert.ok(row, '会话应该出现在 states 里');
    assert.equal(row.batchWindowOverrideMs, 1500, 'states 要把它带出来，控制台才能显示「覆盖中」');

    // 取消：传 0
    const clear = await call(port, '/api/socialV2/batch-window', {
      method: 'POST', headers: ADMIN, body: { key: KEY, ms: 0 }
    });
    assert.equal(clear.status, 200, clear.body);
    assert.equal(clear.json.batchWindowOverrideMs, 0);
    assert.equal(h.getSocialV2State(KEY).batchWindowOverrideMs, 0);
  });
});

await test('端点：越界与脏参数一律 400，且不改动已有值', async () => {
  await withServer(h, async (port) => {
    await call(port, '/api/socialV2/batch-window', { method: 'POST', headers: ADMIN, body: { key: KEY, ms: 1500 } });
    for (const bad of [500, 3600001, -20, 'abc']) {
      const r = await call(port, '/api/socialV2/batch-window', {
        method: 'POST', headers: ADMIN, body: { key: KEY, ms: bad }
      });
      assert.equal(r.status, 400, `ms=${String(bad)} 应该被拒：${r.body}`);
    }
    assert.equal(h.getSocialV2State(KEY).batchWindowOverrideMs, 1500, '被拒的请求不能改动已有覆盖');

    const noKey = await call(port, '/api/socialV2/batch-window', { method: 'POST', headers: ADMIN, body: { ms: 1500 } });
    assert.equal(noKey.status, 400);
    const badKey = await call(port, '/api/socialV2/batch-window', { method: 'POST', headers: ADMIN, body: { key: 'nope', ms: 1500 } });
    assert.equal(badKey.status, 400);
  });
});

await test('端点：AI（agent token）改不动它', async () => {
  const st = h.getSocialV2State(KEY);
  await withServer(h, async (port) => {
    const r = await call(port, '/api/socialV2/batch-window', {
      method: 'POST', headers: { 'x-agent-token': st.agentToken }, body: { key: KEY, ms: 1200 }
    });
    // 管理面路径：带 agent token 撞 admin 路径必须被拒（不是静默忽略）
    assert.ok(r.status === 403 || r.status === 401, `AI 不该能设这个：${r.status} ${r.body}`);
  });
});

await test('落盘：覆盖值进文件，重启后还在', async () => {
  const st = h.getSocialV2State(KEY);
  st.batchWindowOverrideMs = 2500;
  h.saveSocialV2State();
  const file = path.join(h.temp, 'state', 'social-v2.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.conversations[KEY].batchWindowOverrideMs, 2500, '覆盖值必须落盘，否则重启就失效');

  // 模拟重启：清空内存再从文件读回
  h.socialV2.conversations.clear();
  h.loadSocialV2State();
  assert.equal(h.getSocialV2State(KEY).batchWindowOverrideMs, 2500);
});

await h.close();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
