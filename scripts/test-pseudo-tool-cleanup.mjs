// 伪工具调用清理回归：模型偶尔把工具调用写成纯文本标记，出站前必须剥掉。
//
// 钉住的边界（每条都对应一个真实出现过的形态）：
//   1. 完整开闭标签整段丢弃，不能把 <key>/<token> 露到 QQ 上；
//   2. 没有闭合的开标签（模型中途被截断）要砍到结尾；
//   3. 只有标记、没有正文时判定为空 —— 调用方据此整轮不发；
//   4. 正常文本必须原样返回，不能被这条规则误伤；
//   5. 多个块、块与正文混排时，只去掉标记段、正文保留。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
function test(name, run) {
  try { run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const h = await bridgeHarness();
const strip = (text) => h.stripPseudoToolCalls(text);

// ── 1. 完整块整段丢弃 ─────────────────────────────────────────────────────────
test('完整开闭标签整段丢弃，令牌不残留', () => {
  const raw = '<mcp__snowluma__qq_send_message> <key>private:10001</key>\n'
    + '<token>608fd0eba1fa4cf508652c676f7bf5abc1380d05c8294813</token> <messages>["可怜。"]</messages>\n'
    + '</mcp__snowluma__qq_send_message>';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1, '应识别为一段');
  assert.ok(!text.includes('<mcp__'), '标记不能留');
  assert.ok(!text.includes('608fd0eb'), '令牌不能留');
  assert.ok(!text.includes('<key>'), '参数标签不能留');
});

// ── 2. 未闭合的开标签砍到结尾 ─────────────────────────────────────────────────
test('未闭合的开标签砍到结尾（模型中途截断）', () => {
  const raw = '先说一句正常的话\n<mcp__snowluma__qq_send_message><key>private:1</key>';
  const { text, removed } = strip(raw);
  assert.ok(removed >= 1, '未闭合也算清理过');
  assert.equal(text, '先说一句正常的话', '正文保留、标记全丢');
});

// ── 3. 只有标记时返回空串 ─────────────────────────────────────────────────────
test('只有标记、没有正文时返回空串（调用方据此整轮不发）', () => {
  const raw = '<mcp__snowluma__qq_send_message><key>private:1</key></mcp__snowluma__qq_send_message>';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1);
  assert.equal(text, '', '空串代表没什么可发的');
});

// ── 4. 正常文本不受影响 ───────────────────────────────────────────────────────
test('正常文本原样返回，removed 为 0', () => {
  const raw = '（尾巴晃了两下）主人，今天吃白米饭吗？\n第二行也留着。';
  const { text, removed } = strip(raw);
  assert.equal(removed, 0, '没命中就不能动');
  assert.equal(text, raw, '一个字都不能改');
});

// ── 5. 块与正文混排 ───────────────────────────────────────────────────────────
test('块与正文混排：只去标记段，正文保留', () => {
  const raw = '第一句\n<mcp__snowluma__qq_send_message><messages>["a"]</messages></mcp__snowluma__qq_send_message>\n第二句';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1);
  assert.ok(text.includes('第一句'), '前面的正文要留');
  assert.ok(text.includes('第二句'), '后面的正文也要留');
  assert.ok(!text.includes('<mcp__'), '标记不能留');
});

// ── 6. 多个块逐个计数 ─────────────────────────────────────────────────────────
test('多个块逐个计数', () => {
  const raw = 'x<mcp__a__b>1</mcp__a__b>y<mcp__c__d>2</mcp__c__d>z';
  const { text, removed } = strip(raw);
  assert.equal(removed, 2);
  assert.equal(text, 'xyz', '只留正文');
});

// ── 7. 大小写与其它 MCP 前缀 ───────────────────────────────────────────────────
test('任意 mcp__* 前缀都算，不只 snowluma', () => {
  const raw = '<MCP__WEB-SEARCH-SAFE__WEB_SEARCH>q</MCP__WEB-SEARCH-SAFE__WEB_SEARCH>';
  const { removed } = strip(raw);
  assert.equal(removed, 1, '大写也要识别（否则换个前缀就漏）');
});

// ── 8. 空输入安全 ─────────────────────────────────────────────────────────────
test('空输入/null 安全', () => {
  assert.deepEqual({ ...strip('') }, { text: '', removed: 0 });
  assert.deepEqual({ ...strip(null) }, { text: '', removed: 0 });
  assert.deepEqual({ ...strip(undefined) }, { text: '', removed: 0 });
});

// ── 9. 必须先清理再 mdToPlain（真实踩过的坑）──────────────────────────────────
// mdToPlain 的加粗规则 /__([^_]+)__/ 会把 `mcp__snowluma__qq_send_message` 吃成
// `mcpsnowlumaqq_send_message` —— 前缀里的双下划线就是 Markdown 的加粗分隔符。
// 一旦先过 mdToPlain，`<mcp__` 判据就永远不成立，清理形同不存在，
// 整段乱码只能靠「审计恰好命中令牌」兜住。这条测试专门钉住这个顺序要求。
test('mdToPlain 会吃掉双下划线，所以清理必须先做', () => {
  const raw = '<mcp__snowluma__qq_send_message> <key>group:1</key> '
    + '<token>b2ffbdcf308a97337b77a124f930c549</token> <messages>你好</messages> '
    + '</mcp__snowluma__qq_send_message>';
  const broken = h.mdToPlain(raw);
  assert.ok(!broken.includes('<mcp__'), 'mdToPlain 之后 <mcp__ 已不存在 —— 这就是当初清理失效的原因');
  assert.ok(broken.includes('mcpsnowlumaqq_send_message'), '确认被加粗规则吃掉的形态');

  const { text, removed } = strip(raw);
  assert.equal(removed, 1, '在 mdToPlain 之前清理才能识别');
  assert.equal(text, '', '整段都是标记，没有正文可留');
  assert.ok(!text.includes('b2ffbdcf'), '令牌不能残留');
});

// ── 10–15. 只在 mcp__ 前缀上做判据会漏掉的真实变体 ────────────────────────────
// 这些都是模型真写出来过的形态。漏掉任何一个，整段（常带 <token>）就原样进群。
test('省掉 mcp__ 前缀的裸工具名也要拦', () => {
  const raw = '<qq_send_message> <key>private:1</key> <token>abc123</token> <messages>["hi"]</messages> </qq_send_message>';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1);
  assert.equal(text, '', '整段都是标记');
});

test('代码围栏包着的伪工具调用：标记连同空围栏一起清掉', () => {
  const raw = '```xml\n<qq_send_message><key>private:1</key><token>abc</token></qq_send_message>\n```';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1);
  assert.equal(text, '', '空的 ```xml 围栏不该留成正文');
});

test('围栏里夹着正文时，正文要留、空围栏要清', () => {
  const raw = '先说话\n```xml\n<qq_send_message><key>p</key></qq_send_message>\n```\n后面还有';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1);
  assert.ok(text.includes('先说话') && text.includes('后面还有'), '两侧正文都要留');
  assert.ok(!text.includes('```'), '空围栏要清掉');
});

test('中文尖括号写的标记也认', () => {
  const raw = '〈qq_send_message〉<key>private:1</key><token>abc</token>〈/qq_send_message〉';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1);
  assert.equal(text, '', '归一中文尖括号后按同一条规则处理');
});

test('自闭合的工具外壳要整行丢弃，且不能吃掉后面的正文', () => {
  const raw = '前一句\n<tool_call name="qq_send_message" key="private:1" token="abc" />\n后一句';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1);
  assert.ok(text.includes('前一句') && text.includes('后一句'), '自闭合不是未闭合标签，不能砍到结尾');
  assert.ok(!text.includes('qq_send_message'), '标记不能留');
});

test('函数式写法的发送调用也拦', () => {
  const raw = 'qq_send_message(key="private:1", token="abc", messages=["hi"])';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1);
  assert.equal(text, '');
});

// ── 16. 2026-10-31 群里真漏出去的三个形态 ────────────────────────────────────
// 那几轮她写的是 `<mcp_snowluma_qq_set_wake_config">`（单下划线 + `>` 前多个引号），
// 外面还套一层 `<call>…</call>`。旧规则三处都不认：门禁没有 `<call`、名字正则只认
// `mcp__`（双下划线）、属性段要求「空白 + 属性」所以 `">` 匹配不上。整段原样留着，
// 于是这一轮被判成「有正文可发」，白跑一次收尾还触发补发提醒，循环烧 token。
test('单下划线 mcp_ 前缀也要拦', () => {
  const raw = '<mcp_snowluma_qq_set_wake_config> <config>{"mode":"diving"}</config> '
    + '<key>group:1</key> </mcp_snowluma_qq_set_wake_config>';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1, '单下划线是模型真写过的形态');
  assert.equal(text, '');
});

test('只有 <call> 外壳、内层没写工具名时也要拦', () => {
  const raw = '我想想。<call>{"mode":"diving"}</call>';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1, '门禁必须认得 <call，否则整段原样进正文');
  assert.equal(text, '我想想。', '前面的正文要留');
});

test('孤立的 </call> 尾巴要清掉，正文保留', () => {
  const raw = '收尾了。 </call>';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1, '光一个闭合标签也得算清理过');
  assert.equal(text, '收尾了。', '不能因为删了标签就把这一句判成空');
});

test('标签写坏（> 前多个引号）也要拦', () => {
  const raw = 'x<mcp__snowluma__qq_set_wake_config">{"a":1}</mcp__snowluma__qq_set_wake_config>';
  const { text, removed } = strip(raw);
  assert.equal(removed, 1, '属性段放宽到 [^>]* 才吃得住畸形写法');
  assert.equal(text, 'x');
});

test('配对块 + 尾巴的闭合标签一起清，最后只剩正文', () => {
  const raw = '<mcp__a__b><config>{}</config></mcp__a__b> </call>';
  const { text, removed } = strip(raw);
  assert.equal(removed, 2, '主体一段、尾巴一段');
  assert.equal(text, '', '清干净之后不能留任何标记残渣');
});

// ── 17. 误伤边界：正常内容一个都不能动 ────────────────────────────────────────
test('正常聊天里的尖括号与下划线不被误伤', () => {
  const cases = [
    '本鱼今天吃了两碗白米饭。对比 __加粗__ 也不该被吃。',
    '数学上 a<b 且 b>c，这是正常内容。',
    '```js\nconsole.log(1)\n```',
    '（尾巴晃了两下）主人，<3 这个符号是啥意思？',
  ];
  for (const raw of cases) {
    const { text, removed } = strip(raw);
    assert.equal(removed, 0, `不该拦：${raw}`);
    assert.equal(text, raw, `一个字都不能改：${raw}`);
  }
});

await h.close();
console.log(failures === 0 ? '\n🎉 伪工具调用清理测试通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);