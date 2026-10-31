// 引用目标解析回归（2026-10-30 修）。
//
// 真实故障：群里有人问「你为什么叫大肥鱼」，模型回「嗯，拍我也能醒，就是别拿这个逗我玩」——
// 引用条挂到了那条问题上，而它真正在接的是后面那句「对了你们拍一拍也能唤醒」。
// state/tool-calls.jsonl 里那次调用的 replyToMessageId=5566770002，正是七分钟前
// qq_get_recent_messages 见过的 seq56 的 id；它要引的 seq59 手上没有 id。
//
// 根因：唤醒快照给纯文字消息只渲染 `#59`，不给 messageId（省历史）。模型只有序号，
// 而工具描述写的是「消息 id（非零整数）」，于是它去旧 JSON 里翻了个 id 出来。
//
// 这里的契约：模型照着快照抄 `#59` 或 `59`，都必须解析到 seq59 的真实 messageId。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const KEY = 'group:100002';
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

const h = await bridgeHarness({ config: { socialV2: {
  wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
  wake: { preSleepWaitEnabled: false },
  proactive: { enabled: false },
  sticker: { enabled: false }
} } });
h.setMode('reserved2');

const st = h.getSocialV2State(KEY);
st.recentMessages = [
  { seq: 56, messageId: '5566770002', sender: '乙群友', text: '@大肥鱼 你为什么叫大肥鱼' },
  { seq: 59, messageId: '5566770001', sender: '甲群友', text: '对了你们拍一拍也能唤醒，和@可以二选一' },
  { seq: 61, messageId: '5566770003', sender: '丙群友', text: '[图片]', media: [{ kind: 'image', file: 'a.jpg', url: 'https://public.invalid/a.jpg' }] }
];

await test('抄 `#59` 能引到 seq59 的真实 messageId', async () => {
  const r = await h.resolveReplyTargetV2(st, 'group', '100002', '#59');
  assert.ok(r, '应该解析成功');
  assert.equal(r.messageId, '5566770001');
  assert.equal(r.info.text, '对了你们拍一拍也能唤醒，和@可以二选一');
});

await test('抄裸 `59` 同样能引到 seq59', async () => {
  const r = await h.resolveReplyTargetV2(st, 'group', '100002', '59');
  assert.ok(r, '应该解析成功');
  assert.equal(r.messageId, '5566770001');
});

await test('直接给真实 messageId 仍然照旧可用', async () => {
  const r = await h.resolveReplyTargetV2(st, 'group', '100002', '5566770001');
  // 5566770001 不是本地 seq，走 resolveReplyInfo；FakeBot 没有 getMessage ⇒ 返回 null。
  // 这是桩环境的限制，真实链路由 resolveReplyInfo 兜底。这里只钉住「不串到别的消息」。
  assert.ok(r === null || r.messageId !== '5566770002', '不能把别的消息 id 换成本会话其它消息');
});

await test('纯文字 `#59` 与 seq56 的 id 是两个不同目标', async () => {
  const a = h.resolveReplyTargetV2(st, 'group', '100002', '#59');
  const b = h.resolveReplyTargetV2(st, 'group', '100002', '56');
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.messageId, '5566770001');
  assert.equal(rb.messageId, '5566770002');
  assert.notEqual(ra.messageId, rb.messageId);
});

await test('看图工具也认 `#61`（同一个 model 会照抄序号）', async () => {
  const media = h.findMessageMedia(KEY, '#61');
  assert.equal(media.length, 1, '应命中 seq61 的那张图');
  assert.equal(media[0].file, 'a.jpg');
});

// 2026-10-30 第二轮故障：`#59` 兼容上线后仍然引错，因为模型根本不抄 `#59` ——
// 它抄的是快照里唯一看得见的数字。当时只有带图消息渲染 `图id=`，纯文字只有序号，
// 于是它把那张图的 id 反复填进 replyToMessageId（群 100002 连错 4 次）。
// 契约：快照里**每一条**消息都得带自己的 id，且带图的那条额外标明「带图」。
await test('快照里每条消息都带自己的 id（不能只有带图的带）', async () => {
  const key = 'group:891417183';
  const st2 = h.getSocialV2State(key);
  st2.unread = [];
  st2.recentMessages = [];
  h.appendSocialV2Message(key, '乙群友', '纯文字一条', '纯文字一条', false, false, '111', [], '789', []);
  h.appendSocialV2Message(key, '乙群友', '[图片]', '[图片]', false, false, '222',
    [{ kind: 'image', file: 'b.jpg', url: 'https://public.invalid/b.jpg' }], '789', []);
  h.appendSocialV2Message(key, '甲群友', '纯文字两条', '纯文字两条', false, false, '333', [], '789', []);
  const snapshot = h.buildWakeSnapshotV2(key);
  assert.ok(snapshot, '应该有快照');
  const rendered = h.renderWakeSnapshotV2(snapshot);
  for (const id of ['111', '222', '333']) {
    assert.ok(rendered.includes(`id=${id}`), `快照里应出现 id=${id}：\n${rendered}`);
  }
  // 带图那条要额外标出来，别让它和普通消息混成一样。
  assert.ok(/id=222 带图/.test(rendered), `带图消息应标「带图」：\n${rendered}`);
  // 旧的 `图id=` 写法不该再出现，否则模型会觉得是两个不同的东西。
  assert.ok(!rendered.includes('图id='), `不该再有 图id= 写法：\n${rendered}`);
});

// 2026-10-30 第三轮故障：引用修好了，但它把别人之间的对话当成问自己 ——
// seq131 乙群友问甲群友「你玩多久了」（没 @ 任何人的下一句），它抢答「我不玩枪」，
// 被回「没问你」。根因是快照里没有「这条在对谁说」的结构信息：`@` 段在
// segmentsToText 里早被压成 `@甲群友` 几个字，at 的 QQ 号没有任何字段留下来。
// 契约：群聊快照每条都要标出 @你 / @别人 / 没@人；私聊不标（本就都是对你说的）。
await test('群聊快照标出每条在对谁说，私聊不标', async () => {
  h.setSelfIdentity('大肥鱼', '999');
  const key = 'group:100002';
  const st3 = h.getSocialV2State(key);
  st3.unread = [];
  st3.recentMessages = [];
  // 没@人：就是 seq131 那种「你玩多久了」，谁都没 @。
  h.appendSocialV2Message(key, '乙群友', '你玩多久了', '你玩多久了', false, false, '501', [], '291', [], []);
  // @ 别人
  h.appendSocialV2Message(key, '乙群友', '@甲群友 不叫', '@甲群友 不叫', false, false, '502', [], '291', [],
    [{ qq: '10001', name: '甲群友' }]);
  // @ 自己
  h.appendSocialV2Message(key, '乙群友', '@大肥鱼 在吗', '@大肥鱼 在吗', false, false, '503', [], '291', [],
    [{ qq: '999', name: '大肥鱼' }]);
  // @ 自己 + 别人
  h.appendSocialV2Message(key, '乙群友', '@大肥鱼 @甲群友 你们俩', '@大肥鱼 @甲群友 你们俩', false, false, '504', [], '291', [],
    [{ qq: '999', name: '大肥鱼' }, { qq: '10001', name: '甲群友' }]);
  const rendered = h.renderWakeSnapshotV2(h.buildWakeSnapshotV2(key));
  assert.ok(rendered.includes('乙群友（没@人）·'), `没@人要标出来：\n${rendered}`);
  assert.ok(rendered.includes('乙群友（@甲群友）·'), `@别人要标名字：\n${rendered}`);
  assert.ok(rendered.includes('乙群友（@你）·'), `@自己要标「@你」：\n${rendered}`);
  assert.ok(rendered.includes('乙群友（@你 @甲群友）·'), `同时 @ 自己和别人要都标：\n${rendered}`);

  // 私聊不该出现这些标记：私聊每条本来就是对你说的，标了是噪音。
  const pk = 'private:10001';
  const pst = h.getSocialV2State(pk);
  pst.unread = [];
  pst.recentMessages = [];
  h.appendSocialV2Message(pk, '私聊', '在吗', '在吗', false, true, '601', [], '10001', [], []);
  const privateRendered = h.renderWakeSnapshotV2(h.buildWakeSnapshotV2(pk));
  assert.ok(!privateRendered.includes('没@人'), `私聊不该标没@人：\n${privateRendered}`);
  assert.ok(!privateRendered.includes('@你'), `私聊不该标 @你：\n${privateRendered}`);
});

// 2026-10-30 第四轮故障：id 都对了，但它一路沿用上一次引的那条 ——
// 15:30:55 该引 seq140 却传 seq139，15:35:00 该引 seq147 却传 seq143。
// 根因不是「拿错编号」，是「引用过一条就一直用它」，只要话题没断就不换。
// 契约：默认只准引本轮新到的那几条；要引更早的必须显式 quoteEarlier。
await test('引用池：直接传 #59 这种写法也要被认出来（不能因为一个井号就放行）', async () => {
  const key = 'group:100002';
  const stB = h.getSocialV2State(key);
  stB.unread = [];
  stB.recentMessages = [];
  h.appendSocialV2Message(key, '乙群友', '本轮的一句', '本轮的一句', false, false, '801', [], '291', []);
  stB.lastUnreadSeq = 300;
  const snapB = h.buildWakeSnapshotV2(key);
  const inPool = snapB.messages[0].seq;
  // 池外的一条：带井号和不带井号，结论必须一样（原来带井号会被 Number() 吃成 NaN 直接放行）
  const bare = h.replyPoolRejectV2(stB, key, '139', {});
  const hashed = h.replyPoolRejectV2(stB, key, '#139', {});
  assert.ok(typeof bare === 'string' && bare.length > 0, '不带井号的池外引用应被拒');
  assert.equal(hashed, bare, '带井号和不带井号必须判出同一个结论');
  // 池内的那条，两种写法都放行
  assert.equal(h.replyPoolRejectV2(stB, key, String(inPool), {}), null);
  assert.equal(h.replyPoolRejectV2(stB, key, `#${inPool}`, {}), null, '池内消息带井号也该放行');
});

await test('引用池：抄 messageId 也会被反查成 seq 再判，不能靠换个编号绕过', async () => {
  const key = 'group:100002';
  const stC = h.getSocialV2State(key);
  stC.unread = [];
  stC.recentMessages = [];
  h.appendSocialV2Message(key, '乙群友', '本轮新到', '本轮新到', false, false, '-5566770004', [], '291', []);
  stC.lastUnreadSeq = 400;
  const snapC = h.buildWakeSnapshotV2(key);
  const curSeq = snapC.messages[0].seq;
  // 再造一条「本轮的池外旧账」，用 messageId 引用它 —— 原来十位数 id 一律放行。
  h.appendSocialV2Message(key, '归尘', '上一轮的旧账', '上一轮的旧账', false, false, '-494123656', [], '292', []);
  const oldSeq = stC.unread[stC.unread.length - 1].seq;
  stC.unread = stC.unread.filter((m) => m.seq === curSeq);
  // 池子重开，只含 curSeq
  const pool = h.resetReplyPoolV2(stC, [curSeq]);
  assert.equal(pool.size, 1);
  assert.equal(h.replyPoolRejectV2(stC, key, String(curSeq), {}), null, '池内 seq 放行');
  const viaId = h.replyPoolRejectV2(stC, key, '-494123656', {});
  assert.ok(typeof viaId === 'string' && viaId.length > 0,
    '同一个 messageId 换成十位数写法也不能绕过引用池（快照现在每条都带 id=…，抄 id 比抄 #seq 更顺手）');
  assert.ok(viaId.includes(`#${oldSeq}`), `报错要点名被拒的那条 seq：\n${viaId}`);
});
await test('引用池：只放行本轮新到的消息，旧账要显式 quoteEarlier', async () => {
  const key = 'group:100002';
  const st4 = h.getSocialV2State(key);
  st4.unread = [];
  st4.recentMessages = [];
  h.appendSocialV2Message(key, '乙群友', '你觉得乙群友这个名字好听吗', '你觉得乙群友这个名字好听吗', false, false, '701', [], '291', []);
  h.appendSocialV2Message(key, '乙群友', '任安最后怎么样了你知道吗@大肥鱼', '任安最后怎么样了你知道吗@大肥鱼', false, false, '702', [], '291', []);
  // 真实会话里 seq 已经到 140 多；lastUnreadSeq 决定「多小才算本地序号」，
  // 这里对齐真实量级，否则 139 会被当成十位数的 messageId 放过去。
  st4.lastUnreadSeq = 200;
  const snap4 = h.buildWakeSnapshotV2(key);   // 开一轮：池子里只该有本轮这两条
  assert.ok(snap4 && snap4.messages.length === 2, '本轮应有两條未读');
  // seq 由 appendSocialV2Message 按 lastUnreadSeq+1 分配，不认 messageId，取实际值。
  const [s1, s2] = snap4.messages.map((m) => m.seq);
  const newest = Math.max(s1, s2);

  // 引本轮最新那条：放行
  assert.equal(h.replyPoolRejectV2(st4, key, String(newest), {}), null);
  // 引【之前】那条（上一轮引过的 seq139 那种情形）：拦下，并在正文里列出可引的
  const rejected = h.replyPoolRejectV2(st4, key, '139', {});
  assert.ok(typeof rejected === 'string' && rejected.length > 0, '引用池外的旧消息应被拒');
  assert.ok(rejected.includes('#139'), `报错要点名被拒的那条：\n${rejected}`);
  assert.ok(rejected.includes(`#${s1}`) && rejected.includes(`#${s2}`), `报错要列出本轮可引的序号：\n${rejected}`);
  assert.ok(rejected.includes('quoteEarlier'), `报错要告诉它怎么放行：\n${rejected}`);
  // 显式放行
  assert.equal(h.replyPoolRejectV2(st4, key, '139', { quoteEarlier: true }), null);
  // 私聊不拦：会话就一个人，没有「沿用在群里引的那条」这种失败模式
  assert.equal(h.replyPoolRejectV2({ replyPoolSeq: new Set([1]) }, 'private:1', '139', {}), null);
  // 真实 messageId（十位数，超出本地 seq 范围）无从判新旧，放行交给 resolveReplyTargetV2 去查
  assert.equal(h.replyPoolRejectV2(st4, key, '5566770001', {}), null);
  // 主动翻未读：模型自己查出来的消息也要进池，否则它刚读完想回就被自己挡住
  h.extendReplyPoolV2(st4, 705);
  assert.equal(h.replyPoolRejectV2(st4, key, '705', {}), null);
});

await test('等待中的会话还没开轮时不该拦引用', async () => {
  const empty = { replyPoolSeq: new Set() };
  assert.equal(h.replyPoolRejectV2(empty, 'group:100002', '139', {}), null);
});

await test('空值与纯井号不该命中任何东西', async () => {
  assert.equal(await h.resolveReplyTargetV2(st, 'group', '100002', '#'), null);
  assert.equal(await h.resolveReplyTargetV2(st, 'group', '100002', ''), null);
  // 不用 deepEqual：数组来自 VM 里的另一个 Array 原型，deepEqual 会因引用不同而失败。
  assert.equal(h.findMessageMedia(KEY, '#').length, 0);
});

await h.close();
console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
