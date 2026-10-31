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

// ── 交接提醒：伪调用没发出去时，提醒要说清「想调什么 / 还没读几 / 水位推到哪」 ──
// 2026-10-31 16:06 那次，它写坏了 mark_read(throughSeq=48)，那个 48 根本没生效，
// 它不知道推到哪里才算完，只能 mark_read → 失败 → get_unread → mark_read 连试五圈。
// 桥接这边全都算得出来，所以把这些直接摆到提醒里。

const GROUP2 = 'group:456';

function seedGroup() {
  // 造三条未读（seq 5、6、7），其中 6 带图；模型只见过 5。
  const st = h.getSocialV2State(GROUP2);
  st.unread = [];
  st.modelSeenSeqs = new Set();
  st.lastReadThroughSeq = 4;
  st.lastUnreadSeq = 7;
  h.appendSocialV2Message(GROUP2, '甲群友', '第一条', '第一条', false, false, '1001', [], '900001');
  h.appendSocialV2Message(GROUP2, '乙群友', '[图片]', '[图片]', false, false, '-1002', [{ kind: 'image', file: 'a.jpg', url: 'https://example.com/a.jpg', summary: '[图片]' }], '900002');
  h.appendSocialV2Message(GROUP2, '丙群友', '第三条', '第三条', false, false, '1003', [], '900003');
  const after = h.getSocialV2State(GROUP2);
  after.modelSeenSeqs = new Set([after.unread[0].seq]);
  return after;
}

await test('伪调用是 mark_read、还有没读的：说清现在收尾会被拦，不给水位', () => {
  const st = seedGroup();
  const seqs = st.unread.map((m) => m.seq);
  assert.equal(seqs.length, 3, '三条未读');
  const handoff = h.describePseudoHandoffV2(st, INCIDENT);
  assert.match(handoff, /【上一轮没接上】/, '要明说上一轮没接上');
  assert.match(handoff, /qq_mark_read/, '要说出它想调的是哪个工具');
  assert.match(handoff, /还没读：2 条/, '只说没展示给它的那两条');
  // 未读没看完时给水位是反效果：它会照抄那个数去收尾，然后把没看的标成已读。
  assert.match(handoff, /会被拦下/, '要说明现在收尾会被拦');
  assert.doesNotMatch(handoff, /throughSeq 用/, '还有没读的就别给水位');
  assert.doesNotMatch(handoff, /98/, '它写坏的参数不该被采信');
});

await test('伪调用是 mark_read、已经全读完了：这时才给水位', () => {
  const st = seedGroup();
  st.modelSeenSeqs = new Set(st.unread.map((m) => m.seq));
  const handoff = h.describePseudoHandoffV2(st, INCIDENT);
  assert.match(handoff, /throughSeq 用 \d+/, '全读完了才给水位');
  assert.doesNotMatch(handoff, /还没读：/, '都看过了就别再报未读');
});

await test('交接里点名带图的消息（否则它不知道该看哪张）', () => {
  const st = seedGroup();
  const handoff = h.describePseudoHandoffV2(st, INCIDENT);
  assert.match(handoff, /带图的消息：/, '要说哪条带图');
  assert.match(handoff, /id=-1002/, '带上真实 messageId（引用/看图都要这个）');
});

await test('伪调用不是收尾工具时，照样给未读清单但不提收尾', () => {
  const st = seedGroup();
  const text = '<mcp__snowluma__qq_get_message_images><parameter name="messageId">-1002</parameter></mcp__snowluma__qq_get_message_images>';
  const handoff = h.describePseudoHandoffV2(st, text);
  assert.match(handoff, /qq_get_message_images/);
  assert.doesNotMatch(handoff, /qq_mark_read/, '没打算收尾就别教它收尾');
});

await test('没有伪调用时返回空串（走原来的普通提醒）', () => {
  assert.equal(h.describePseudoHandoffV2(h.getSocialV2State(GROUP2), '我想了想，还是不说话了'), '');
  assert.equal(h.describePseudoHandoffV2(null, ''), '');
});

await test('提醒正文：有伪调用就换成交接，没有还是老那句', () => {
  const st = seedGroup();
  const withPseudo = h.buildWakeReminderPromptV2(GROUP2, INCIDENT);
  assert.match(withPseudo, /【上一轮没接上】/, '要有交接段');
  assert.doesNotMatch(withPseudo, /【提醒】本轮还没收尾/, '不该再发那句空的催办');

  const plain = h.buildWakeReminderPromptV2(GROUP2, '我想了想，还是不说话了');
  assert.match(plain, /【提醒】本轮还没收尾/, '没伪调用时保持原样');
  assert.doesNotMatch(plain, /【上一轮没接上】/);
});

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
