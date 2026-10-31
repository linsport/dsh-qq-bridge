// 端口自动发现（src/dsh-port-discover.js）的契约。
//
// 这段代码只在启动时跑一次，出错的表现是「消息进来了但 AI 永远不回」——
// 日志里只有 ECONNREFUSED，很难一眼看出是端口问题。所以它的边界必须钉死。
//
// 2026-10-31 审查发现的两处实现瑕疵，这里各钉一条：
//   ① scanDshPorts({ to: 0 }) 原来会被 `Number(to) || 65535` 吃掉变成全量扫描；
//   ② probePort 的 401 正文原来「到 4096 字节就不再加」，指纹若在后半句就漏判。
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { parseBaseUrl, isLoopbackHost, probePort, probeDsh, canConnect, scanDshPorts } from '../src/dsh-port-discover.js';

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

/** 起一个只回固定响应的临时 HTTP 服务，返回 { port, close }。 */
function startFakeServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ── 纯函数 ───────────────────────────────────────────────────────────────────
await test('parseBaseUrl 认得 http / https / 带端口 / 不带端口', async () => {
  assert.deepEqual(parseBaseUrl('http://127.0.0.1:3080'), { host: '127.0.0.1', port: 3080, protocol: 'http:' });
  assert.deepEqual(parseBaseUrl('https://example.com'), { host: 'example.com', port: 443, protocol: 'https:' });
  assert.deepEqual(parseBaseUrl('http://localhost'), { host: 'localhost', port: 80, protocol: 'http:' });
  assert.equal(parseBaseUrl('不是地址'), null);
  assert.equal(parseBaseUrl(undefined), null);
});

await test('isLoopbackHost 只认回环地址', async () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.equal(isLoopbackHost(h), true, `${h} 应该算回环`);
  }
  for (const h of ['192.168.1.5', '10.0.0.1', 'example.com', '', null]) {
    assert.equal(isLoopbackHost(h), false, `${h} 不该算回环`);
  }
});

// ── probePort 的指纹判据 ─────────────────────────────────────────────────────
await test('probePort：401 + DSH 鉴权指纹才算命中', async () => {
  const srv = await startFakeServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('DSH Web authentication required');
  });
  try {
    assert.equal(await probePort('127.0.0.1', srv.port, 1500), true);
  } finally {
    await srv.close();
  }
});

await test('probePort：200 的普通网页不算（本机实测有 6 个这类假 DSH）', async () => {
  const srv = await startFakeServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>hello</html>');
  });
  try {
    assert.equal(await probePort('127.0.0.1', srv.port, 1500), false);
  } finally {
    await srv.close();
  }
});

await test('probePort：401 但正文不像 DSH 也不算', async () => {
  const srv = await startFakeServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('Please configure JWT.');
  });
  try {
    assert.equal(await probePort('127.0.0.1', srv.port, 1500), false);
  } finally {
    await srv.close();
  }
});

await test('probePort：指纹出现在 4KB 之后也要认（原来会漏判）', async () => {
  // 必须**分块**下发才测得出来：一次性 write 整块时 Node 只触发一次 data 事件，
  // 旧实现 `if (body.length < 4096) body += chunk` 会把整块都吞进去，用例就成了假绿
  // （2026-10-31 回退验证时实测确认过）。这里每块之间隔一点，逼它分成多个 data 事件。
  const filler = 'x'.repeat(6000);
  const srv = await startFakeServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    let i = 0;
    const pump = () => {
      if (i >= 6) {
        res.write('\nDSH Web authentication required');
        res.end();
        return;
      }
      res.write(filler.slice(i * 1000, (i + 1) * 1000));
      i += 1;
      setTimeout(pump, 5);
    };
    pump();
  });
  try {
    assert.equal(await probePort('127.0.0.1', srv.port, 3000), true,
      '指纹在 4096 字节之后时仍应命中 —— 上限是截断依据，不是丢弃依据');
  } finally {
    await srv.close();
  }
});

await test('probePort：死端口直接 false，不抛', async () => {
  // 先占一个端口再关掉，拿到一个几乎肯定没人听的端口号
  const tmp = await startFakeServer((req, res) => res.end(''));
  const deadPort = tmp.port;
  await tmp.close();
  assert.equal(await probePort('127.0.0.1', deadPort, 800), false);
});

// ── canConnect / probeDsh ────────────────────────────────────────────────────
await test('canConnect 对活端口 true、死端口 false', async () => {
  const srv = await startFakeServer((req, res) => res.end(''));
  try {
    assert.equal(await canConnect('127.0.0.1', srv.port), true);
  } finally {
    await srv.close();
  }
  assert.equal(await canConnect('127.0.0.1', srv.port), false);
});

await test('probeDsh：回环地址走指纹校验，非回环只要求 TCP 通', async () => {
  const srv = await startFakeServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('DSH Web authentication required');
  });
  try {
    assert.equal(await probeDsh(`http://127.0.0.1:${srv.port}`), true);
  } finally {
    await srv.close();
  }
  // 地址解析不出来时一律 false，不能抛
  assert.equal(await probeDsh('乱写的东西'), false);
});

// ── scanDshPorts 的参数边界 ──────────────────────────────────────────────────
await test('scanDshPorts：from/to 显式给了就按给的来，to=0 不再退化成全量扫描', async () => {
  const started = Date.now();
  // 参数要选得能拉开差距：from=3100 / to=0 时，新实现 maxPort 被压到 1、循环一次都不进；
  // 旧的 `Number(to) || 65535` 会当成 65535，去扫 3100~65535 共 6 万多个端口
  // （既慢，还可能把本机真实的 DSH 端口扫出来）。
  //
  // 别改成 from=65535 / to=0 —— 那样旧实现算出的 minPort 也是 65535，循环只剩一个端口，
  // bug 被掩盖，用例变成假绿（2026-10-31 回退验证踩过）。
  const none = await scanDshPorts({ from: 3100, to: 0 });
  assert.deepEqual([...none], [], 'to=0 应该一个端口都不扫');
  assert.ok(Date.now() - started < 2000, 'to=0 不该退化成全量扫描');
});

await test('scanDshPorts：单端口区间能扫到真正的 DSH', async () => {
  const srv = await startFakeServer((req, res) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('DSH Web authentication required');
  });
  try {
    const found = await scanDshPorts({ from: srv.port, to: srv.port });
    assert.equal(found.length, 1);
    assert.equal(found[0], `http://127.0.0.1:${srv.port}`);
  } finally {
    await srv.close();
  }
});

await test('scanDshPorts：区间内没有 DSH 时返回空数组，不抛', async () => {
  const tmp = await startFakeServer((req, res) => res.end(''));
  const deadPort = tmp.port;
  await tmp.close();
  const found = await scanDshPorts({ from: deadPort, to: deadPort });
  assert.deepEqual([...found], []);
});

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
