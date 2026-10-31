// 单条消息里带换行 → 按换行拆成多条（方案 C，2026-10-31）。
//
// 真实故障：模型传 "messages": "行，那确实是我这边出问题了\n以后我就一条一句，不给你添乱"
// ——一个字符串带 \n。契约是「字符串=一条，数组=分多条」，于是它按一条发出去，
// QQ 又把气泡内的 \n 渲染成换行，客户端看到「一条气泡里两行」。她以为说了两句，
// 实际一直只说了一句，群里当场被指「真糊成一条了」。
//
// 为什么不无脑拆：模型有时拿换行排版（列清单、分段写长文），全拆会炸成好几个气泡。
// 所以只在「每段都像一句完整的话」时才拆，任何一个条件不满足就原样发。
import assert from 'node:assert/strict';
import http from 'node:http';
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

// 发送内容的读取口径：HTTP 路径（harness 默认）落到 calls.http 的 send_group_msg，
// WS 路径落到 calls.sent。两条都看，测试才不会被传输层写法绊住。
function sentTexts(h) {
  const fromHttp = h.calls.http
    .filter((c) => /send_(group|private)_msg$/.test(c.url))
    .map((c) => (c.body.message ?? []).filter((seg) => seg.type === 'text').map((seg) => seg.data.text).join(''));
  const fromWs = h.calls.sent.map((m) => m.text);
  return [...fromHttp, ...fromWs];
}
function clearSent(h) {
  h.calls.http.length = 0;
  h.calls.sent.length = 0;
}

const KEY = 'group:456'; // harness 默认 allow.groups

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

const h = await bridgeHarness({ config: { socialV2: {
  wait: { minMs: 100, maxMs: 2000 },
  proactive: { enabled: false },
  sticker: { enabled: false },
  send: { burstEnabled: true, burstMaxMessages: 6, maxMessageChars: 500, maxSendPerMinute: 0, maxSendPerHour: 0 },
} } });
h.setMode('reserved2');
h.setSelfIdentity('大肥鱼', '300001');

const server = h.startConsoleServer();
if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

const token = h.getSocialV2State(KEY).agentToken;
const send = async (body) => call(port, '/api/socialV2/send-message', {
  method: 'POST',
  headers: { 'x-agent-token': token, 'x-console-token': 'fixture-console-token' },
  body: { key: KEY, ...body },
});

try {
  await test('那次事故的原文：一个字符串带换行，拆成两条发出去', async () => {
    // 这就是 2026-10-31 07:49:56 的真实参数
    clearSent(h);
    const res = await send({ messages: '行，那确实是我这边出问题了\n以后我就一条一句，不给你添乱' });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.sent, 2, '应该拆成两条都发出去');
    assert.equal(res.json.splitFromNewline, 1, '要告诉模型它那句被拆了');
    const sent = sentTexts(h);
    assert.equal(sent[0], '行，那确实是我这边出问题了');
    assert.equal(sent[1], '以后我就一条一句，不给你添乱');
  });

  await test('本来就用数组分的，不碰它', async () => {
    clearSent(h);
    const res = await send({ messages: ['第一条', '第二条'] });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.sent, 2);
    assert.equal(res.json.splitFromNewline, undefined, '数组不该报拆过');
  });

  await test('列清单那种排版不乱拆（段里有标点开头就原样发）', async () => {
    clearSent(h);
    const res = await send({ messages: '要点如下\n，先看这个\n，再看那个' });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.sent, 1, '被硬折断的样子不该拆');
    assert.equal(res.json.splitFromNewline, undefined);
  });

  await test('拆完超过条数上限就整条原样发，不报错', async () => {
    clearSent(h);
    const many = Array.from({ length: 9 }, (_, i) => `第${i + 1}句都挺完整`).join('\n');
    const res = await send({ messages: many });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.sent, 1, '九段超过 burstMaxMessages=6，不拆');
    assert.equal(res.json.splitFromNewline, undefined);
  });

  await test('单行没有换行时行为完全不变', async () => {
    clearSent(h);
    const res = await send({ messages: '一句话' });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.sent, 1);
    assert.equal(sentTexts(h)[0], '一句话');
  });

  await test('连续多个空行只当一个分隔', async () => {
    clearSent(h);
    const res = await send({ messages: '前一句。\n\n\n后一句。' });
    assert.equal(res.status, 200, res.body);
    assert.equal(res.json.sent, 2, '空行不该产生空消息');
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log(failed === 0 ? `ALL PASS passed=${passed} failed=${failed}` : `FAILED passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
