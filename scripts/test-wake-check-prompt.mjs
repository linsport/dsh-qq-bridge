// 「醒来先过三关」可以从控制台改（2026-10-31）。
//
// 原来这段是硬编码在 wakeCheckLineV2 里的字符串，想改一个字都得改代码再重启。
// 现在它来自 socialV2.context.wakeCheckPrompt，留空 = 整段不注入。
//
// 这里的契约是四条：
//   1. 没配过 → 用内置默认（老配置不该因此少一层提醒）；
//   2. 配了 → 原样用（** 那两处 markdown 加粗也原样保留，别替我剥掉）；
//   3. 配成空串 → 真的一条都不发（这是操作者主动关掉这段的写法）；
//   4. 超过 2000 字 → 保存时截断，别让一次误粘贴把每轮的包撑爆。
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

const h = await bridgeHarness({ config: { socialV2: { proactive: { enabled: false } } } });
const KEY = 'group:456';

const BUILTIN_HEAD = '【醒来先过三关】';
const BUILTIN_TIME = '超 120 分钟默认不接';
const BUILTIN_TARGET = '（未点名）（@别人）是他们在聊';

await test('没配过时给的是内置默认，不是空', () => {
  const line = h.wakeCheckLineV2();
  assert.ok(line.includes(BUILTIN_HEAD), `应含标题，实得：${line.slice(0, 40)}`);
  assert.ok(line.includes(BUILTIN_TIME), '应含时间那一关');
  assert.ok(line.includes(BUILTIN_TARGET), '应含对象那一关');
  assert.ok(line.endsWith('\n\n'), '末尾要留空行，否则和快照粘成一行');
});

await test('配了就用配的原文，markdown 加粗不被剥掉', () => {
  h.cfg.socialV2.context.wakeCheckPrompt = '【自定义三关】先看**这条新不新**，再看是不是叫我。';
  const line = h.wakeCheckLineV2();
  assert.equal(line, '【自定义三关】先看**这条新不新**，再看是不是叫我。\n\n');
});

await test('配成空串 = 整段不注入（操作者主动关掉的写法）', () => {
  h.cfg.socialV2.context.wakeCheckPrompt = '';
  assert.equal(h.wakeCheckLineV2(), '');
});

await test('只填空格也当没配（别让一串空格变成一条空提醒）', () => {
  h.cfg.socialV2.context.wakeCheckPrompt = '   \n\t  ';
  assert.equal(h.wakeCheckLineV2(), '');
});

await test('清空之后唤醒包整体少一段，不是多一行空行', () => {
  h.cfg.socialV2.context.wakeCheckPrompt = '';
  const prompt = h.buildWakePromptV2(KEY, 'atMention');
  assert.ok(!prompt.includes(BUILTIN_HEAD), '不该再出现三关标题');
  assert.ok(!/\n{4,}/.test(prompt), '不该留下连续四个换行');
});

await test('配置回到内置原文时，唤醒包里原样出现（含 ** 加粗）', () => {
  delete h.cfg.socialV2.context.wakeCheckPrompt; // 模拟老配置：键根本不存在
  const prompt = h.buildWakePromptV2(KEY, 'atMention');
  assert.ok(prompt.includes('看**最新那条和叫你的那条**一起判'), '内置文案里的加粗要原样保留');
});

// 走真实的保存路径：超长文本必须在写盘前截断，否则每轮的包会被一篇长文撑爆。
await test('保存超长正文时按 2000 字截断，且能读回', async () => {
  const long = '关'.repeat(3000);
  await withServer(h, async (port) => {
    const saved = await call(port, '/api/socialV2/config', {
      method: 'POST', headers: ADMIN, body: { context: { wakeCheckPrompt: long } },
    });
    assert.equal(saved.status, 200, `保存应成功，实得 ${saved.status} ${saved.body.slice(0, 120)}`);
    const read = await call(port, '/api/socialV2/config', { headers: ADMIN });
    assert.equal(read.status, 200);
    const got = read.json?.config?.context?.wakeCheckPrompt;
    assert.equal(typeof got, 'string', '读回应当是字符串');
    assert.ok(got.length <= 2000, `应截断到 2000 字以内，实得 ${got.length}`);
    assert.ok(got.length > 0, '不该被截成空串');
  });
});

await test('保存空串时真的存成空串，不会被默认值顶回来', async () => {
  await withServer(h, async (port) => {
    const saved = await call(port, '/api/socialV2/config', {
      method: 'POST', headers: ADMIN, body: { context: { wakeCheckPrompt: '' } },
    });
    assert.equal(saved.status, 200, `保存应成功，实得 ${saved.status} ${saved.body.slice(0, 120)}`);
    const read = await call(port, '/api/socialV2/config', { headers: ADMIN });
    assert.equal(read.json?.config?.context?.wakeCheckPrompt, '', '留空要能留空');
  });
});

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
