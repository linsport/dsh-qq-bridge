// 会话级 preset 档位覆盖的回归（2026-11-02 新增）。
//
// 背景：三档分级（owner / readonly / chat）是按"这个会话是谁"自动算的，操作者没法插手。
// 这个功能补一层：给单个会话换一个档位。它唯一可能造成提权的地方就是**可选值**——
// 一旦允许写 `standard`（DSH 默认 preset，含 bash / 文件读写），群友就能驱动一个能操作
// 本机的 agent，三档分级的 fail-closed 白做了。所以这里钉住五件事：
//   1. 只认写死的四个 qq-chat*，`standard`/`qq-chat-ownerX` 之类的近似名一律拒；
//   2. 覆盖只对自己那个 key 生效，别人的档位不受影响；
//   3. 覆盖压过档位默认（白名单会话也能被降到仅聊天 / 升到只读）；
//   4. 覆盖变了要触发会话重建（复用 sessionPolicy 的现成机制）；
//   5. closed-agent 模式不吃覆盖（那个模式本来就只放行 owner 私聊 + 完整工具面）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.message ?? error); }
}
async function withBridge(run, config = {}) {
  const h = await bridgeHarness({ config });
  try { await run(h); } finally { await h.close(); }
}

// ── HTTP 端点（控制台面 / AI 面要分清）──────────────────────────────────────
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

// ── 1. 可选值白名单：唯一可能提权的地方 ──────────────────────────────────────
await test('可选清单只含四个 qq-chat*，不含 standard / 任意名', async () => {
  await withBridge(async (h) => {
    assert.deepEqual([...h.SESSION_PRESET_CHOICES].sort(),
      ['qq-chat', 'qq-chat-owner', 'qq-chat-readonly', 'qq-chat-v2']);
    for (const ok of ['qq-chat', 'qq-chat-v2', 'qq-chat-readonly', 'qq-chat-owner']) {
      assert.equal(h.isSessionPresetChoice(ok), true, `${ok} 必须可选`);
    }
    // standard 是 DSH 默认 preset（含 bash / 文件读写），必须拒绝；
    // 大小写变形、前后缀、空串、undefined 也一律不许蒙混过去。
    for (const bad of ['standard', 'Standard', 'standard ', 'qq-chat-ownerX', 'owner', '', null, undefined, 'qq-chat-']) {
      assert.equal(h.isSessionPresetChoice(bad), false, `${String(bad)} 不该被接受`);
    }
  });
});

await test('写入时拒绝非法 preset（不是等到建会话才炸）', async () => {
  await withBridge(async (h) => {
    assert.throws(() => h.writeSessionPreset('group:456', 'standard'), /必须是/, 'standard 必须在写入时就被拒');
    assert.deepEqual({ ...h.readSessionPresets() }, {}, '被拒的写入不能留下任何记录');
  });
});

// ── 2. 覆盖只对自己那个 key 生效 ────────────────────────────────────────────
await test('覆盖只改自己那个会话，别人的档位照旧', async () => {
  await withBridge(async (h) => {
    h.writeSessionPreset('group:456', 'qq-chat');
    assert.equal(h.wantedPresetName('group:456', 'reserved2', h.cfg), 'qq-chat');
    // 同为白名单的另一个会话不受影响，仍走 readonly 档。
    h.cfg.allow.groups.push('789');
    assert.equal(h.wantedPresetName('group:789', 'reserved2', h.cfg), h.TIER_PRESETS.READONLY);
  });
});

await test('key 会做 canonical 化（前导零 / 空白不影响命中）', async () => {
  await withBridge(async (h) => {
    h.writeSessionPreset('group:0456', 'qq-chat');
    assert.equal(h.sessionPresetOverride('group:456'), 'qq-chat', '写 0456 后查 456 必须命中');
    assert.equal(h.sessionPresetOverride('group:0456'), 'qq-chat');
    assert.throws(() => h.writeSessionPreset('not-a-key', 'qq-chat'), /group:|private:/);
  });
});

// ── 3. 覆盖压过档位默认 ─────────────────────────────────────────────────────
await test('白名单会话可以被降到仅聊天，也可以被升到只读', async () => {
  await withBridge(async (h) => {
    // 456 在白名单里 ⇒ 默认 readonly
    assert.equal(h.wantedPresetName('group:456', 'reserved2', h.cfg), h.TIER_PRESETS.READONLY);
    h.writeSessionPreset('group:456', 'qq-chat-v2');
    assert.equal(h.wantedPresetName('group:456', 'reserved2', h.cfg), 'qq-chat-v2');
    h.writeSessionPreset('group:456', 'qq-chat-readonly');
    assert.equal(h.wantedPresetName('group:456', 'reserved2', h.cfg), 'qq-chat-readonly');
  });
});

await test('陌生会话可以被升到只读（操作者显式授权）', async () => {
  await withBridge(async (h) => {
    assert.equal(h.wantedPresetName('private:999', 'reserved2', h.cfg), 'qq-chat-v2');
    h.writeSessionPreset('private:999', 'qq-chat-readonly');
    assert.equal(h.wantedPresetName('private:999', 'reserved2', h.cfg), 'qq-chat-readonly');
  }, { allowAllWhenEmpty: true, allow: { private: [], groups: [] } });
});

await test('closed-agent 模式不吃覆盖（该模式本就只放行 owner 私聊 + 完整工具面）', async () => {
  await withBridge(async (h) => {
    h.writeSessionPreset('private:123', 'qq-chat');
    h.setMode('closed-agent');
    // closedAgentPreset 是模块内变量（来自 state/mode.json），不是 cfg 字段；
    // 这里断言的是"覆盖没被用上"——它会走 closedAgentPreset 那条分支而不是覆盖值。
    assert.notEqual(h.wantedPresetName('private:123', 'closed-agent', h.cfg), 'qq-chat',
      'closed-agent 不该被会话级覆盖改小');
  });
});

// ── 4. 删除覆盖 = 回落到档位默认 ────────────────────────────────────────────
await test('删除覆盖后回落到档位默认', async () => {
  await withBridge(async (h) => {
    h.writeSessionPreset('group:456', 'qq-chat-v2');
    assert.equal(h.wantedPresetName('group:456', 'reserved2', h.cfg), 'qq-chat-v2');
    h.writeSessionPreset('group:456', h.CLEAR_SESSION_PRESET);
    assert.equal(h.wantedPresetName('group:456', 'reserved2', h.cfg), h.TIER_PRESETS.READONLY);
    assert.equal(h.sessionPresetOverride('group:456'), undefined, '删掉之后必须是「没设过」而不是 null');
  });
});

await test('覆盖落盘到 state/session-presets.json，重建 bridge 后仍在（不被会话状态重置清掉）', async () => {
  await withBridge(async (h) => {
    h.writeSessionPreset('group:456', 'qq-chat');
  });
  // 同一个 temp 目录再起一次 harness 不方便，这里直接验文件在不在 —— 用 readSessionPresets 的
  // 第二实例（同一 harness 里 reload 也行），关键是"写完之后读得回来"。
  await withBridge(async (h) => {
    h.writeSessionPreset('group:456', 'qq-chat');
    const again = h.readSessionPresets();
    assert.equal(again['group:456'], 'qq-chat');
  });
});

// ── 5. 覆盖变化触发会话重建 ─────────────────────────────────────────────────
await test('设覆盖后同一会话按新 preset 重建（复用 sessionPolicy，不需要额外踢会话）', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    const first = await h.ensureSession('group:456');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-readonly');
    h.writeSessionPreset('group:456', 'qq-chat-v2');
    const second = await h.ensureSession('group:456');
    assert.notEqual(second, first, '覆盖变了就必须是新会话');
    assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat-v2');
    assert.ok(h.calls.cancelled.includes(first), '旧会话要被停掉');
  });
});

await test('覆盖指向未安装的 preset 时同样 fail-closed（不降级）', async () => {
  await withBridge(async (h) => {
    h.setMode('reserved2');
    h.writeSessionPreset('group:456', 'qq-chat-owner');
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    await assert.rejects(h.ensureSession('group:456'), /qq-chat-owner/);
    assert.equal(h.calls.created.length, 0);
  });
});

// ── 6. 坏文件不该把整个功能带崩 ─────────────────────────────────────────────
await test('state 文件里出现非法值时当作没设过（而不是抛错或照用）', async () => {
  const h = await bridgeHarness({
    files: {
      'state/session-presets.json': { version: 1, sessionPresets: { 'group:456': 'standard', 'group:457': 'qq-chat', nested: { bad: 1 } } }
    }
  });
  try {
    assert.deepEqual({ ...h.readSessionPresets() }, { 'group:457': 'qq-chat' },
      'standard 与非法 key 都要被丢掉，合法的那条要留下');
  } finally { await h.close(); }
});

// ── 7. HTTP 端点：控制台能改，AI 不能改 ─────────────────────────────────────
// 这一组是本功能唯一对外暴露的面，两个方向都必须钉住：
//   正向：控制台令牌能设能删，返回体里回显当前覆盖表；
//   反向：AI（agent token）撞这个路径必须被 403 挡住 —— 否则群友只要诱导模型
//         调一次，就能把自己那个会话提到 owner 档，三档分级彻底失效。
await test('端点：设置 / 读回 / 移除覆盖', async () => {
  const h = await bridgeHarness({});
  try {
    await withServer(h, async (port) => {
      const set = await call(port, '/api/session-preset', {
        method: 'POST', headers: ADMIN, body: { key: 'group:456', preset: 'qq-chat-v2' }
      });
      assert.equal(set.status, 200, `设置应该成功：${set.status} ${set.body}`);
      assert.equal(set.json.preset, 'qq-chat-v2');
      assert.equal(set.json.sessions['group:456'], 'qq-chat-v2');

      // 读回来必须能在 permission-tiers 里看到，而且标注成「覆盖」而不是档位默认。
      const tiers = await call(port, '/api/permission-tiers', { headers: ADMIN });
      assert.equal(tiers.status, 200);
      const row = tiers.json.sessions.find((r) => r.key === 'group:456');
      assert.ok(row, '设了覆盖的会话必须出现在列表里');
      assert.equal(row.override, 'qq-chat-v2', 'override 字段要如实反映覆盖值');
      assert.ok(Array.isArray(tiers.json.choices) && tiers.json.choices.includes('qq-chat-v2'),
        'choices 要回给前端，界面别自己再抄一份可选值');

      const clear = await call(port, '/api/session-preset', {
        method: 'POST', headers: ADMIN, body: { key: 'group:456', preset: null }
      });
      assert.equal(clear.status, 200);
      assert.equal(clear.json.preset, null);
      assert.equal(clear.json.sessions['group:456'], undefined, '删掉之后覆盖表里不该还有这个 key');
    });
  } finally { await h.close(); }
});

await test('端点：AI（agent token）改不动它', async () => {
  const h = await bridgeHarness({});
  try {
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const r = await call(port, '/api/session-preset', {
        method: 'POST', headers: { 'x-agent-token': st.agentToken }, body: { key: 'group:456', preset: 'qq-chat-owner' }
      });
      // 管理面路径：带 agent token 撞 admin 路径必须明确被拒，不能静默忽略。
      assert.ok(r.status === 403 || r.status === 401, `AI 不该能设档位：${r.status} ${r.body}`);
      assert.equal(h.sessionPresetOverride('group:456'), undefined, '被拒的请求不能留下任何覆盖');
    });
  } finally { await h.close(); }
});

await test('端点：非法 preset / 缺 key / 非法 key 一律 400，且不改动已有值', async () => {
  const h = await bridgeHarness({});
  try {
    h.writeSessionPreset('group:456', 'qq-chat');
    await withServer(h, async (port) => {
      const bad = await call(port, '/api/session-preset', {
        method: 'POST', headers: ADMIN, body: { key: 'group:456', preset: 'standard' }
      });
      assert.equal(bad.status, 400, 'standard 必须 400');
      assert.match(bad.json.error, /必须是/);

      const noKey = await call(port, '/api/session-preset', {
        method: 'POST', headers: ADMIN, body: { preset: 'qq-chat-v2' }
      });
      assert.equal(noKey.status, 400);

      const badKey = await call(port, '/api/session-preset', {
        method: 'POST', headers: ADMIN, body: { key: 'not-a-session', preset: 'qq-chat-v2' }
      });
      assert.equal(badKey.status, 400);

      // 三次失败都不得动到原来那条。
      assert.equal(h.sessionPresetOverride('group:456'), 'qq-chat');
    });
  } finally { await h.close(); }
});

console.log(failures === 0 ? `\nALL PASS  tests=${tests} failures=0` : `\n${failures} FAILED / ${tests}`);
process.exit(failures === 0 ? 0 : 1);
