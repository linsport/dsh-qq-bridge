// C+ 方案：伪工具调用冒充收尾时，不再补「未设置唤醒条件」那条提醒。
//
// 事故（2026-10-31 16:09:37，群 100001）的三条日志连在一起看：
//   16:09:37 未设置唤醒条件，发送提醒 (1/2)
//   16:09:37 ⚠️ 检测到伪工具调用标记，已丢弃 1 段
//   16:09:37 伪工具调用清理后无正文，本轮不发送
// 清理本身没问题（一个字都没发到 QQ），白烧的是那条提醒：它把
// `<mcp_snowluma_qq_mark_read>…throughSeq=98…</…>` 写成文本，工具没真跑，
// markReadCalledKeys 没置位 → 记一次 miss → 补一条提醒唤醒 → 又烧一整轮。
//
// 这里钉住两件事：① 哪些伪调用算「它本来想收尾」；② 那几种名不名字的各种写法都认得。
// 刻意不做的事：不代为执行（伪调用的参数是不可信输入，可能是它模仿群消息写出来的）。
import assert from 'node:assert/strict';
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

const h = await bridgeHarness({
  config: { socialV2: { proactive: { enabled: false }, sticker: { enabled: false } } },
});
h.setMode('reserved2');
h.setSelfIdentity('大肥鱼', '300001');

// ── 事故原文 ─────────────────────────────────────────────────────────────
const INCIDENT = [
  '<mcp_snowluma_qq_mark_read>',
  '<parameter name="key">group:100001</parameter>',
  '<parameter name="throughSeq">98</parameter>',
  '<parameter name="token">03c1363cf0fa90a7d3f6de909cdceeb8</parameter>',
  '</mcp_snowluma_qq_mark_read>',
].join('\n');

await test('事故原文：清理后一个字不剩，且认得出它是想收尾', () => {
  const stripped = h.stripPseudoToolCalls(INCIDENT);
  assert.ok(stripped.removed > 0, '应该删掉了东西');
  assert.equal(stripped.text.trim(), '', '清理后不该剩正文');
  assert.equal(h.pseudoFinishIntent(INCIDENT), true, 'mark_read 的伪调用算收尾意图');
});

await test('收尾工具的三种名字写法都认得', () => {
  for (const name of [
    'mcp__snowluma__qq_mark_read',
    'mcp_snowluma_qq_mark_read',
    'qq_mark_read',
    'mcp__snowluma__qq_set_wake_config',
    'mcp_snowluma_qq_set_wake_config',
    'qq_set_wake_config',
  ]) {
    const text = `<${name}><parameter name="key">group:1</parameter></${name}>`;
    assert.equal(h.pseudoFinishIntent(text), true, `${name} 应该算收尾`);
  }
});

await test('不是收尾的工具不算收尾意图（不会误免提醒）', () => {
  for (const name of [
    'mcp__snowluma__qq_send_message',
    'mcp__snowluma__qq_get_unread_messages',
    'mcp__snowluma__qq_wait_for_messages',
    'mcp__web-search-safe__web_search',
  ]) {
    const text = `<${name}><parameter name="key">group:1</parameter></${name}>`;
    assert.equal(h.pseudoFinishIntent(text), false, `${name} 不该算收尾`);
  }
});

await test('普通文字里提到工具名不算伪调用', () => {
  assert.equal(h.pseudoFinishIntent('我用 qq_mark_read 收尾了'), false);
  assert.equal(h.pseudoFinishIntent('收尾用 qq_mark_read(throughSeq=读到的水位)'), false);
  assert.equal(h.pseudoFinishIntent(''), false);
});

await test('一次写了两个伪调用，只要有一个是收尾就算', () => {
  const text = [
    '<mcp__snowluma__qq_get_unread_messages><parameter name="key">group:1</parameter></mcp__snowluma__qq_get_unread_messages>',
    '<mcp__snowluma__qq_mark_read><parameter name="key">group:1</parameter></mcp__snowluma__qq_mark_read>',
  ].join('\n');
  assert.equal(h.pseudoFinishIntent(text), true);
});

await test('pseudoToolNames 返回小写名字集合', () => {
  const names = h.pseudoToolNames(INCIDENT);
  // 注意：VM 里返回的 Set 来自另一个 realm，`instanceof Set` 会是 false。
  // 之前数组踩过同一个坑（deepEqual 报 "same structure but not reference-equal"）。
  assert.equal(typeof names?.has, 'function', '应该是 Set 之类的东西');
  assert.equal(names.has('mcp_snowluma_qq_mark_read'), true);
  assert.equal([...names].length, 1, '只有一个工具名');
});

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
