// 梗百科查询（src/meme-wiki.js）+ 出口解析（src/net-exit.js）回归。
//
// 全程离线：不连 cnmeme、不连代理。测的是**决策逻辑**——出口怎么选、内网怎么拦、
// 错误怎么脱敏、坏 IP 怎么换。真实联网由 scripts/probe-meme-wiki.mjs 单独跑（需手动）。
import assert from 'node:assert/strict';
import { isLoopbackHost, parseProxyUrl, matchesNoProxy, resolveExit, resolveExitCandidates, describeExit } from '../src/net-exit.js';
import { htmlToText, formatMeme, formatCandidates, MemeError } from '../src/meme-wiki.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`\n❌ ${name}`);
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
  } catch (error) {
    console.error(`\n❌ ${name}`);
    console.error(error?.stack ?? error);
    process.exitCode = 1;
  }
}

const TARGET = { protocol: 'https:', hostname: 'cnmeme.wiki', port: '' };

// ── 出口解析：回环判定 ──────────────────────────────────────────────────────
check('回环字面量只认 127.0.0.0/8、::1、localhost', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.1.2.3'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('LOCALHOST'), true);
  assert.equal(isLoopbackHost('10.0.0.1'), false);
  assert.equal(isLoopbackHost('192.168.1.1'), false);
  assert.equal(isLoopbackHost('proxy.example.com'), false);
  assert.equal(isLoopbackHost('127.300.0.1'), false, '超出 255 的段不是回环');
  assert.equal(isLoopbackHost(''), false);
});

// ── 出口解析：代理 URL ──────────────────────────────────────────────────────
check('代理 URL 解析：http / socks5 / 带认证', () => {
  const http = parseProxyUrl('http://127.0.0.1:7897');
  assert.deepEqual(http, { protocol: 'http', host: '127.0.0.1', port: 7897, auth: null, remoteResolve: false });

  const socks = parseProxyUrl('socks5://[::1]:1080');
  assert.equal(socks.protocol, 'socks5');
  assert.equal(socks.host, '::1');
  assert.equal(socks.port, 1080);

  const auth = parseProxyUrl('http://user:pa%40ss@localhost:8080');
  assert.deepEqual(auth.auth, { user: 'user', pass: 'pa@ss' });
  assert.equal(auth.host, '127.0.0.1', 'localhost 归一成 127.0.0.1');
});

check('非回环代理地址必须抛错（防止变成内网探测通道）', () => {
  for (const bad of ['http://10.0.0.1:8080', 'http://192.168.1.1:7890', 'socks5://proxy.example.com:1080', 'http://8.8.8.8:8080']) {
    assert.throws(() => parseProxyUrl(bad), (error) => error instanceof MemeError === false && error?.code === 'proxy-config', `${bad} 应被拒绝`);
  }
});

check('不支持的代理协议明确报错，不「大概能用就试试」', () => {
  assert.throws(() => parseProxyUrl('https://127.0.0.1:443'), /代理/);
  assert.throws(() => parseProxyUrl('ftp://127.0.0.1:21'), /代理/);
  assert.throws(() => parseProxyUrl('不是URL'), /代理/);
  // 端口越界时 WHATWG URL 会先抛「格式无效」，同样是 proxy-config，报错文案不必抠字眼。
  assert.throws(() => parseProxyUrl('http://127.0.0.1:99999'), (error) => error?.code === 'proxy-config');
});

// ── 出口解析：NO_PROXY ───────────────────────────────────────────────────────
check('NO_PROXY 三种写法：* / 裸域名（含子域）/ host:port', () => {
  assert.equal(matchesNoProxy('cnmeme.wiki', 443, '*'), true);
  assert.equal(matchesNoProxy('cnmeme.wiki', 443, 'example.com'), false);
  assert.equal(matchesNoProxy('cnmeme.wiki', 443, 'cnmeme.wiki'), true);
  assert.equal(matchesNoProxy('a.cnmeme.wiki', 443, 'cnmeme.wiki'), true, '裸域名匹配子域');
  assert.equal(matchesNoProxy('a.cnmeme.wiki', 443, '.cnmeme.wiki'), true);
  assert.equal(matchesNoProxy('a.cnmeme.wiki', 443, '*.cnmeme.wiki'), true);
  assert.equal(matchesNoProxy('cnmeme.wiki', 8080, 'cnmeme.wiki:443'), false, '端口不同不匹配');
  assert.equal(matchesNoProxy('cnmeme.wiki', 443, 'cnmeme.wiki:443'), true);
  assert.equal(matchesNoProxy('cnmeme.wiki', 443, 'foo.com, cnmeme.wiki ,bar.com'), true, '逗号分隔含空格');
});

// ── 出口解析：优先级与 off ──────────────────────────────────────────────────
check('优先级：显式 > 环境变量 > 直连', () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:1111', ALL_PROXY: 'http://127.0.0.1:2222' };
  const explicit = resolveExit(TARGET, { proxy: 'http://127.0.0.1:3333', env });
  assert.equal(explicit.kind, 'proxy');
  assert.equal(explicit.port, 3333);
  assert.equal(explicit.reason, 'explicit');

  const fromEnv = resolveExit(TARGET, { proxy: 'auto', env });
  assert.equal(fromEnv.port, 1111, 'HTTPS_PROXY 优先于 ALL_PROXY');

  const onlyAll = resolveExit(TARGET, { proxy: 'auto', env: { ALL_PROXY: 'http://127.0.0.1:2222' } });
  assert.equal(onlyAll.port, 2222);

  const none = resolveExit(TARGET, { proxy: 'auto', env: {} });
  assert.equal(none.kind, 'direct');
  assert.equal(none.reason, 'env-empty');
});

check('off 是真空：连环境变量都不看', () => {
  const exit = resolveExit(TARGET, { proxy: 'off', env: { HTTPS_PROXY: 'http://127.0.0.1:7897' } });
  assert.equal(exit.kind, 'direct');
  assert.equal(exit.reason, 'off');
});

check('NO_PROXY 命中时不走代理', () => {
  const exit = resolveExit(TARGET, { proxy: 'auto', env: { HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'cnmeme.wiki' } });
  assert.equal(exit.kind, 'direct');
  assert.equal(exit.reason, 'no_proxy');
});

check('http 目标读 HTTP_PROXY，https 目标读 HTTPS_PROXY', () => {
  const env = { HTTP_PROXY: 'http://127.0.0.1:1111', HTTPS_PROXY: 'http://127.0.0.1:2222' };
  assert.equal(resolveExit({ protocol: 'http:', hostname: 'a.com', port: '' }, { proxy: 'auto', env }).port, 1111);
  assert.equal(resolveExit({ protocol: 'https:', hostname: 'a.com', port: '' }, { proxy: 'auto', env }).port, 2222);
});

// ── 互补降级 ────────────────────────────────────────────────────────────────
check('auto 模式给出主路径 + 互补路径', () => {
  const proxied = resolveExitCandidates(TARGET, { proxy: 'auto', env: { HTTPS_PROXY: 'http://127.0.0.1:7897' } });
  assert.equal(proxied.length, 2);
  assert.equal(proxied[0].kind, 'proxy');
  assert.equal(proxied[1].kind, 'direct', '代理失败要能退回直连');

  const direct = resolveExitCandidates(TARGET, { proxy: 'auto', env: {} });
  assert.equal(direct.length, 1, '没有代理串时不该凭空造出一条代理路径');

  const withAll = resolveExitCandidates(TARGET, { proxy: 'auto', env: { ALL_PROXY: 'socks5://127.0.0.1:1080' } });
  assert.equal(withAll.length, 2);
  assert.equal(withAll[0].protocol, 'socks5');
});

check('互补路径本身坏掉时不影响主路径（不因为「想多试一条」而整次请求抛错）', () => {
  const exits = resolveExitCandidates(TARGET, { proxy: 'auto', env: { HTTPS_PROXY: 'http://10.0.0.1:8080' } });
  assert.equal(exits.length, 1, '坏的代理串不能把请求带崩，也不能静默改用直连');
  assert.equal(exits[0].kind, 'direct');
});

check('非 auto 模式只有一条路径：用户指定的出口必须被尊重', () => {
  const explicit = resolveExitCandidates(TARGET, { proxy: 'http://127.0.0.1:7897', env: {} });
  assert.equal(explicit.length, 1);
  assert.equal(explicit[0].kind, 'proxy', '显式指定代理时不许偷偷退回直连');

  const off = resolveExitCandidates(TARGET, { proxy: 'off', env: { HTTPS_PROXY: 'http://127.0.0.1:7897' } });
  assert.equal(off.length, 1);
  assert.equal(off[0].kind, 'direct', '显式 off 时不许偷偷走代理');
});

check('describeExit 只给日志用，不含目标信息', () => {
  assert.equal(describeExit({ kind: 'direct', reason: 'off' }), 'direct(off)');
  assert.match(describeExit({ kind: 'proxy', protocol: 'http', host: '127.0.0.1', port: 7897, reason: 'env' }), /^http:\/\/127\.0\.0\.1:7897\(env\)$/);
});

// ── 错误脱敏 ────────────────────────────────────────────────────────────────
check('对外错误文案不含本机地址/端口（这些字会进模型上下文）', () => {
  const codes = ['target-private', 'exit-unreachable', 'exit-timeout', 'target-reset', 'not-found', 'bad-response', 'rate-limited', 'upstream-error', 'dns-failed', 'config', 'target-invalid', 'too-large'];
  for (const code of codes) {
    const error = new MemeError(code, 'connect ECONNREFUSED 127.0.0.1:7897');
    assert.ok(error.message.length > 0, `${code} 必须有可读文案`);
    for (const leak of ['127.0.0.1', '7897', 'localhost', 'ECONNREFUSED', '::1']) {
      assert.ok(!error.message.includes(leak), `${code} 的文案不能含 ${leak}`);
    }
  }
});

// ── 格式化 ──────────────────────────────────────────────────────────────────
check('htmlToText 剥标签并保留段落', () => {
  const text = htmlToText('<h2>来源</h2><p>出自《<strong>赛马娘</strong>》</p><ul><li>指代可爱动物</li><li>误用</li></ul>');
  assert.ok(text.includes('来源'));
  assert.ok(text.includes('《赛马娘》'), '强调标签要剥掉、文字留下');
  assert.ok(text.includes('· 指代可爱动物'), '列表项转成圆点');
  assert.ok(!text.includes('<'), '不残留标签');
});

check('htmlToText 还原常见实体', () => {
  const text = htmlToText('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;&nbsp;f');
  assert.equal(text, `a & b <c> "d" 'e' f`);
});

check('formatMeme 输出结构包含出处与截断提示', () => {
  const item = {
    slug: '哈基米',
    title: '哈基米',
    tags: ['声音梗', '空耳'],
    updated_at: '2026-05-23T09:25:07.659239Z',
    source_video: { bvid: 'BV1LX4y1j78y', title: '哈基米是什么梗【梗指南】', creator_name: '梗指南', published_at: '2023-08-09T12:43:24Z' },
    summary: '赛马娘第二季的蜂蜜饮料歌',
    content_html: `<p>${'很长'.repeat(200)}</p>`,
  };
  const text = formatMeme(item, { maxChars: 50 });
  assert.ok(text.startsWith('【梗百科 · 哈基米】'));
  assert.ok(text.includes('标签：声音梗 / 空耳'));
  assert.ok(text.includes('出处：BV1LX4y1j78y 《哈基米是什么梗【梗指南】》 — 梗指南 2023-08-09'));
  assert.ok(text.includes('正文已截断到 50 字'), '超长必须标注截断');
});

check('formatCandidates 空结果给明确说法，不是空字符串', () => {
  assert.match(formatCandidates([]), /没搜到/);
  const text = formatCandidates([{ slug: 'a', title: '甲词条', summary: '一句话' }]);
  assert.ok(text.includes('· 甲词条：一句话'));
});

check('短语超长搜索词被拒（避免把整段聊天当查询发出去）', async () => {
  const { searchMemes } = await import('../src/meme-wiki.js');
  await assert.rejects(() => searchMemes('长'.repeat(200)), (error) => error.code === 'target-invalid');
  await assert.rejects(() => searchMemes('   '), (error) => error.code === 'target-invalid');
});

await checkAsync('内网目标在发请求前就被拦下（无论出口是什么）', async () => {
  const { searchMemes } = await import('../src/meme-wiki.js');
  // 直接调内部路径：用 file/内网 URL 走不到（API 地址写死），所以这里验证的是
  // 同一条判定链上的 validateFetchUrl —— 若哪天有人把校验挪到出口之后，这条会先红。
  const { validateFetchUrl } = await import('../src/safe-fetch.js');
  await assert.rejects(() => validateFetchUrl('http://127.0.0.1/'), /内网|本机/);
  await assert.rejects(() => validateFetchUrl('http://localhost/'), /内网|本机/);
  await assert.rejects(() => validateFetchUrl('http://192.168.1.1/'), /内网|本机/);
  // 有形无实：把代理开着也不能让内网通过
  const exit = resolveExit({ protocol: 'http:', hostname: '127.0.0.1', port: '' }, { proxy: 'http://127.0.0.1:7897', env: {} });
  assert.equal(exit.kind, 'proxy', '出口解析本身不负责拦目标');
  await assert.rejects(() => validateFetchUrl('http://127.0.0.1/'), /内网|本机/, '目标校验与出口无关');
  // 上面这条正是设计意图：出口说「走代理」，目标校验照样拒绝。两道闸互相独立。
  void searchMemes;
});

console.log(`\n✅ meme-wiki/net-exit: ${passed} 项通过`);
