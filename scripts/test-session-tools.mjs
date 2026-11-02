// 会话级 MCP 工具开关的回归（2026-11-02 新增）。
//
// 背景：`socialV2.tools` 的 31 个开关原本是**全局**的（一个 MCP 进程一份工具表），
// 想「这个群不许发表情、那个群可以」做不到。这个功能补的是**调用期**粒度。
//
// ⚠ 必须钉住这条硬限制，别让后来人以为它能「从 schema 里隐藏」：
//   MCP 工具在进程启动时注册（src/mcp-snowluma-safe.js 的 TOOL_CONFIG_FLAGS），
//   会话级覆盖只发生在桥接路由上 ⇒ 关掉的工具**仍然出现在 schema 里**，
//   只是调用会被 403「工具未启用」。这条不改代码就改不了，所以只能测出来、写进文档。
//
// 这里钉六件事：
//   1. 覆盖只对自己那个 key 生效，别的会话仍按全局开关；
//   2. 能升也能降（全局 false + 会话 true，以及反过来）；
//   3. key 会 canonical 化（前导零不影响命中）；
//   4. 未知 flag 在写入时就被拒（不是等调用时才 403）；
//   5. 删除覆盖后回落到全局开关；
//   6. state 文件里的脏数据（非布尔、非法 key）要被丢掉而不是照用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

// ── 1. 覆盖只对自己那个 key 生效 ────────────────────────────────────────────
await test('覆盖只改自己那个会话，别的会话仍按全局开关', async () => {
  await withBridge(async (h) => {
    const tools = h.cfg.socialV2.tools;
    h.writeSessionTool('group:456', 'getUnread', false, tools);
    assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), false);
    // 同在白名单里的另一个群不受影响。
    assert.equal(h.v2ToolEnabled('getUnread', 'group:789'), true);
    // 不带 key（比如桥接自己的内部调用）也按全局走。
    assert.equal(h.v2ToolEnabled('getUnread'), true);
  });
});

// ── 2. 能升也能降 ───────────────────────────────────────────────────────────
await test('全局关掉的工具，可以只在某个会话打开（反过来也行）', async () => {
  await withBridge(async (h) => {
    const tools = h.cfg.socialV2.tools;
    h.cfg.socialV2.tools.sendSticker = false;
    assert.equal(h.v2ToolEnabled('sendSticker', 'group:456'), false, '全局关着就该关着');
    h.writeSessionTool('group:456', 'sendSticker', true, tools);
    assert.equal(h.v2ToolEnabled('sendSticker', 'group:456'), true, '会话级打开要生效');
    assert.equal(h.v2ToolEnabled('sendSticker', 'group:789'), false, '不能顺带把别人也打开');
  });
});

// ── 3. key 归一化 ───────────────────────────────────────────────────────────
await test('key 会做 canonical 化（前导零 / 空白不影响命中）', async () => {
  await withBridge(async (h) => {
    const tools = h.cfg.socialV2.tools;
    h.writeSessionTool('group:0456', 'getUnread', false, tools);
    assert.equal(h.sessionToolOverride('group:456')?.getUnread, false, '写 0456 后查 456 必须命中');
    assert.equal(h.v2ToolEnabled('getUnread', 'group:0456'), false);
    assert.throws(() => h.writeSessionTool('not-a-key', 'getUnread', false, tools), /group:|private:/);
  });
});

// ── 4. 未知 flag 写入时就拒 ─────────────────────────────────────────────────
await test('未知的 flag 在写入时就被拒（不留一条永远不生效的记录）', async () => {
  await withBridge(async (h) => {
    const tools = h.cfg.socialV2.tools;
    assert.throws(() => h.writeSessionTool('group:456', 'noSuchTool', false, tools), /未知的工具开关/);
    assert.deepEqual({ ...h.readSessionTools() }, {}, '被拒的写入不能留下任何记录');
  });
});

// ── 5. 删除覆盖回落全局 ─────────────────────────────────────────────────────
await test('删除覆盖后回落到全局开关', async () => {
  await withBridge(async (h) => {
    const tools = h.cfg.socialV2.tools;
    h.writeSessionTool('group:456', 'getUnread', false, tools);
    assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), false);
    h.writeSessionTool('group:456', 'getUnread', h.CLEAR_SESSION_TOOL, tools);
    assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), true);
    assert.equal(h.sessionToolOverride('group:456'), undefined, '删干净之后必须是「没设过」而不是空对象');
  });
});

// ── 6. 坏文件不该把功能带崩 ─────────────────────────────────────────────────
await test('state 文件里的脏数据被丢掉（非布尔值 / 非法 key / 非对象）', async () => {
  const h = await bridgeHarness({
    files: {
      'state/session-tools.json': {
        version: 1,
        sessionTools: {
          'group:456': { getUnread: false, bad: 'yes', alsoBad: 1 },
          'not-a-key': { getUnread: false },
          'group:789': 'not-an-object',
          'group:790': { sendSticker: true }
        }
      }
    }
  });
  try {
    const bag = h.readSessionTools();
    assert.deepEqual({ ...bag['group:456'] }, { getUnread: false }, '非布尔值要被丢掉，合法的要留下');
    assert.equal(bag['not-a-key'], undefined, '非法 key 要丢掉');
    assert.equal(bag['group:789'], undefined, '非对象要丢掉');
    assert.deepEqual({ ...bag['group:790'] }, { sendSticker: true });
  } finally { await h.close(); }
});

// ── 7. HTTP 端点：控制台能改，AI 不能改 ─────────────────────────────────────
await test('端点：设置 / 读回 / 移除覆盖', async () => {
  const h = await bridgeHarness({});
  try {
    await withServer(h, async (port) => {
      const set = await call(port, '/api/session-tool', {
        method: 'POST', headers: ADMIN, body: { key: 'group:456', flag: 'getUnread', enabled: false }
      });
      assert.equal(set.status, 200, `设置应该成功：${set.status} ${set.body}`);
      assert.equal(set.json.flag, 'getUnread');
      assert.equal(set.json.enabled, false);
      assert.equal(set.json.sessionTools['group:456'].getUnread, false);
      assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), false);

      const clear = await call(port, '/api/session-tool', {
        method: 'POST', headers: ADMIN, body: { key: 'group:456', flag: 'getUnread', enabled: null }
      });
      assert.equal(clear.status, 200);
      assert.equal(clear.json.enabled, null);
      assert.equal(clear.json.sessionTools['group:456'], undefined, '删掉之后覆盖表里不该还有这个 key');
      assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), true);
    });
  } finally { await h.close(); }
});

await test('端点：AI（agent token）改不动它', async () => {
  const h = await bridgeHarness({});
  try {
    const st = h.getSocialV2State('group:456');
    await withServer(h, async (port) => {
      const r = await call(port, '/api/session-tool', {
        method: 'POST', headers: { 'x-agent-token': st.agentToken }, body: { key: 'group:456', flag: 'getUnread', enabled: false }
      });
      // 管理面路径：带 agent token 撞 admin 路径必须明确被拒 —— 否则群友诱导模型调一次，
      // 就能给自己那个会话关掉/打开任意工具。虽然这不能提权（开关只能动 MCP 工具），
      // 但它能让"操作者的配置"被群友改，仍然是越权。
      assert.ok(r.status === 403 || r.status === 401, `AI 不该能改工具开关：${r.status} ${r.body}`);
      assert.equal(h.sessionToolOverride('group:456'), undefined, '被拒的请求不能留下任何覆盖');
    });
  } finally { await h.close(); }
});

await test('端点：未知 flag / 缺 key / 缺 flag / 非布尔一律 400', async () => {
  const h = await bridgeHarness({});
  try {
    h.writeSessionTool('group:456', 'getUnread', false, h.cfg.socialV2.tools);
    await withServer(h, async (port) => {
      const badFlag = await call(port, '/api/session-tool', {
        method: 'POST', headers: ADMIN, body: { key: 'group:456', flag: 'noSuchTool', enabled: false }
      });
      assert.equal(badFlag.status, 400);
      assert.match(badFlag.json.error, /未知的工具开关/);

      const noKey = await call(port, '/api/session-tool', {
        method: 'POST', headers: ADMIN, body: { flag: 'getUnread', enabled: false }
      });
      assert.equal(noKey.status, 400);
      assert.match(noKey.json.error, /key/);

      const noFlag = await call(port, '/api/session-tool', {
        method: 'POST', headers: ADMIN, body: { key: 'group:456', enabled: false }
      });
      assert.equal(noFlag.status, 400);

      const badValue = await call(port, '/api/session-tool', {
        method: 'POST', headers: ADMIN, body: { key: 'group:456', flag: 'getUnread', enabled: 'false' }
      });
      assert.equal(badValue.status, 400, '字符串 "false" 不能被当成 false');

      // 四次失败都不得动到原来那条。
      assert.equal(h.sessionToolOverride('group:456')?.getUnread, false);
    });
  } finally { await h.close(); }
});

// ── 10. 缓存：写入方立刻可见，外部改文件也读得到 ────────────────────────────
// readSessionTools 被 v2ToolEnabled 调，闸门点几十个，所以带 mtime 缓存。
// 缓存最容易出的两种错：写完读不到新值、别人改了文件却一直读旧的。
await test('缓存：写入后即使文件 mtime 没变，也要读到新值', async () => {
  const h = await bridgeHarness({
    files: { 'state/session-tools.json': { version: 1, sessionTools: { 'group:456': { getUnread: false } } } }
  });
  try {
    const tools = h.cfg.socialV2.tools;
    const file = path.join(h.temp, 'state', 'session-tools.json');
    // 把 mtime 钉在一个确定的时刻，好让「写入前后 mtime 完全相同」可复现。
    const pinned = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, pinned, pinned);
    // 先读一次，让缓存装上这个 mtime
    assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), false);
    h.writeSessionTool('group:456', 'getUnread', h.CLEAR_SESSION_TOOL, tools);
    // 再把 mtime 拨回完全相同的值，模拟「文件系统时间戳精度不足 / 时钟回拨」：
    // 这时 mtime 比对一定命中旧缓存，只有写入方主动失效才读得到删除后的结果。
    fs.utimesSync(file, pinned, pinned);
    assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), true, '写入必须主动作废缓存，不能只靠 mtime 比对');
  } finally { await h.close(); }
});

await test('缓存：外部直接改 state 文件（模拟手改/另一进程）能读到新值', async () => {
  const h = await bridgeHarness({
    files: { 'state/session-tools.json': { version: 1, sessionTools: { 'group:456': { getUnread: false } } } }
  });
  try {
    assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), false, '首次读到的应是文件里的值');
    const file = path.join(h.temp, 'state', 'session-tools.json');
    fs.writeFileSync(file, JSON.stringify({ version: 1, sessionTools: { 'group:456': { getUnread: true } } }));
    // mtime 精度有限，显式把时间戳推后，模拟「过一会儿被人改了」
    const later = new Date(Date.now() + 2000);
    fs.utimesSync(file, later, later);
    assert.equal(h.v2ToolEnabled('getUnread', 'group:456'), true, 'mtime 变了就必须重读，不能一直用缓存');
  } finally { await h.close(); }
});

console.log(failures === 0 ? `\nALL PASS  tests=${tests} failures=0` : `\n${failures} FAILED / ${tests}`);
process.exit(failures === 0 ? 0 : 1);
