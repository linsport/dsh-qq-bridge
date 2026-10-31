// 提问触发器的指向性 + 收尾后的观望窗口（2026-10-31）。
//
// 真实故障一：群 100001 里两个群友在跟另一个机器人互相追问，
// 「你连人都认不清是不是蠢完了」「你还没有回复我的话」「那你还问我哪句」
// 全被判成「在问她」，一晚上 question 叫醒 6 次，每次她自己都说「没叫到我，我就接着潜水」。
// 根因：isDirectedAtAi 只看句子本身（有「你」+问句词就算），不看这句在跟谁较劲。
//
// 真实故障二：她发完话十秒就 qq_set_wake_config 潜水，对方下一句不 @ 她就不再被叫醒，
// 体感是「聊到一半人没了」。根因：收尾 = 立刻潜水，中间没有任何「还在听」的缓冲。
//
// 这里的契约：① 提问要指向她才算；② 收尾后先观望一段时间，相关的话还能把她叫回来。
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

const SELF = '300001';
const OTHER = '400001';
const GROUP = 'group:456'; // harness 默认 allow.groups 是 456

const h = await bridgeHarness({ config: { socialV2: {
  proactive: { enabled: false },
  sticker: { enabled: false },
  wake: { postReplyWatchMs: 180000 }
} } });
h.setMode('reserved2');
h.setSelfIdentity('大肥鱼', SELF);

// 只留 question 一个触发条件，别让别的触发器把结论搅浑。
function triggerOnly(extra = {}) {
  const st = h.getSocialV2State(GROUP);
  st.wakeConfig = {
    ...st.wakeConfig,
    mode: 'diving',
    infinite: true,
    triggers: { atMention: false, nameMention: false, question: true, keywords: [], poke: false, probability: 0, anyMessage: false, speakerIds: [] }
  };
  Object.assign(st, { lastAiReplyAt: 0, lastIncomingAt: 0, watchUntil: 0, watchOpenedAt: 0, recentMessages: [] }, extra);
  return st;
}

function eventFor(text, extra = {}) {
  return {
    self_id: SELF,
    user_id: OTHER,
    message: [{ type: 'text', data: { text } }],
    ...extra
  };
}

await test('别人之间的追问不再把她叫醒（这是那晚 6 次空转的原句）', () => {
  const st = triggerOnly();
  for (const text of [
    '你连人都认不清是不是蠢完了，我刚才问你的话是什么你告诉我',
    '你还没有回复我的话',
    '那你还问我哪句？',
  ]) {
    assert.equal(h.evaluateWakeTriggerV2(GROUP, st, eventFor(text), 'group', text, text, false), null, text);
  }
});

await test('@ 了别人的问句不算问她', () => {
  const st = triggerOnly();
  const text = '@小鲸鱼 你能分清我俩吗';
  const event = {
    self_id: SELF,
    user_id: OTHER,
    message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: ' 你能分清我俩吗' } }]
  };
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, event, 'group', text, '你能分清我俩吗', false), null);
});

await test('@ 了她就在问她', () => {
  const st = triggerOnly();
  const event = {
    self_id: SELF,
    user_id: OTHER,
    message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 你能分清我俩吗' } }]
  };
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, event, 'group', '你能分清我俩吗', '你能分清我俩吗', false), 'question');
});

await test('引用了她的消息也在问她', () => {
  const st = triggerOnly();
  const text = '你这句话什么意思？';
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, eventFor(text), 'group', text, text, true), 'question');
});

await test('叫了她的名字 + 问句算问她', () => {
  const st = triggerOnly();
  const text = '大肥鱼，你能分清我俩吗？';
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, eventFor(text), 'group', text, text, false), 'question');
});

await test('她刚说完话、对方紧跟着追问，算问她', () => {
  const st = triggerOnly({ lastAiReplyAt: Date.now() - 10 * 1000 });
  const text = '你还没有回复我的话';
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, eventFor(text), 'group', text, text, false), 'question');
});

await test('她一小时前说过话，现在别人的追问不算她', () => {
  const st = triggerOnly({ lastAiReplyAt: Date.now() - 60 * 60 * 1000 });
  const text = '你还没有回复我的话';
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, eventFor(text), 'group', text, text, false), null);
});

// 造一段「她刚回完某人的话」的最近记录：run() 里放 [对方一句, 她一句]。
// 认人判据已经放宽（见 evaluateWakeTriggerV2 的 watch 分支），这里不再用它做断言，
// 但 armWatchWindowV2 要看 lastAiReplyAt，留着这份记录让用例贴近真实状态。
function withPartner(st, partnerId = OTHER, partnerName = '丁群友') {
  st.recentMessages = [
    { seq: 1, messageId: '900', sender: partnerName, userId: partnerId, text: '你先说', plain: '你先说', isSelf: false, time: Date.now() - 20000 },
    { sender: '我', text: '我说了', plain: '我说了', isSelf: true, time: Date.now() - 15000 }
  ];
  st.lastAiReplyAt = Date.now() - 15000;
  return st;
}

await test('观望窗口：她刚回完的那个人接着说，能把她叫回来', () => {
  const st = triggerOnly();
  // 关掉 question，只剩观望窗口这一条路，避免两条规则互相掩护。
  st.wakeConfig.triggers.question = false;
  withPartner(st);
  const until = h.armWatchWindowV2(st, GROUP);
  assert.ok(until > Date.now(), '应该开出一个未来时刻');
  const text = '那我再问一句';
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, eventFor(text), 'group', text, text, false), 'watch');
});

await test('观望窗口：换个群友接同一个梗也叫得醒她（2026-10-31 晚漏接那条）', () => {
  const st = triggerOnly();
  st.wakeConfig.triggers.question = false;
  withPartner(st, '2914515726', '乙群友');
  const until = h.armWatchWindowV2(st, GROUP);
  assert.ok(until > Date.now());
  // 她刚才回的是「乙群友」，紧接着「甲群友」接同一个梗。
  // 旧判据只认最后回复的那一个人，于是把该接的话放过去了（实测漏接那条）。
  const text = '那前面那个又是谁';
  const ev = eventFor(text, { user_id: '1326818385', sender: { nickname: '甲群友' } });
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, ev, 'group', text, text, false), 'watch');
});

await test('观望窗口：她自己又说了一句 → 倒计时重置回满', () => {
  const st = triggerOnly();
  withPartner(st);
  const ms = h.postReplyWatchMs();
  const first = h.armWatchWindowV2(st, GROUP);
  assert.ok(first > Date.now());
  // 模拟「收尾后已经过了 100 秒，这会儿她又开口了」：把截止时刻往回拨。
  st.watchUntil = first - 100000;
  st.watchOpenedAt = Date.now();
  const rolled = Number(st.watchUntil);
  h.recordSentMessagesV2(GROUP, ['我再补一句']);
  const after = Number(h.getSocialV2State(GROUP).watchUntil);
  assert.ok(after > rolled, `倒计时应该被重置回来，rolled=${rolled} after=${after}`);
  assert.ok(after >= Date.now() + ms - 200, `应该重置回满 ${ms} 毫秒，实际只剩 ${after - Date.now()}`);
  assert.ok(after <= Date.now() + ms + 200, `不该比一整段还长（那是累加），实际 ${after - Date.now()}`);
});

await test('观望窗口：窗口还开着时再收尾不续命（她没开口就不该加时）', () => {
  const st = triggerOnly();
  withPartner(st);
  const first = h.armWatchWindowV2(st, GROUP);
  // 模拟「已经过了 100 秒，她一句话没说，这一轮又收尾了」。
  st.watchUntil = first - 100000;
  const rolled = Number(st.watchUntil);
  const second = h.armWatchWindowV2(st, GROUP);
  // 2026-10-31 22:55 实测：收尾 60 秒 → 她又收尾 → 又变回 60 秒，一路续到 22:57。
  // 收尾只负责开窗，续窗只能靠她自己发消息。
  assert.equal(second, rolled, `收尾不该把倒计时续回去，rolled=${rolled} second=${second}`);
});

await test('观望窗口：别人说话不重置倒计时（她没接，时间该继续走）', () => {
  const st = triggerOnly();
  withPartner(st);
  const first = h.armWatchWindowV2(st, GROUP);
  st.watchUntil = first - 100000;
  st.watchOpenedAt = Date.now();
  const rolled = Number(st.watchUntil);
  h.appendSocialV2Message(GROUP, '甲群友', '他们还在聊', '他们还在聊', false, false, null, [], '1326818385');
  assert.equal(Number(h.getSocialV2State(GROUP).watchUntil), rolled, '别人刷屏不该给她续观望');
});

await test('观望窗口：窗口没开的会话，她说话也不会凭空开出一段观望', () => {
  const st = triggerOnly();
  st.watchUntil = 0;
  h.recordSentMessagesV2(GROUP, ['随口一句']);
  assert.equal(Number(h.getSocialV2State(GROUP).watchUntil), 0, '没在观望就不该被开出来');
});

await test('观望窗口：连续续命也有总时长上限，不会守着不放', () => {
  const st = triggerOnly();
  withPartner(st);
  const ms = h.postReplyWatchMs();
  const start = Date.now();
  let until = h.armWatchWindowV2(st, GROUP);
  assert.ok(until > start);
  // 一直收尾，每次都想往后延 —— 总时长必须收敛在 30 分钟以内。
  for (let i = 0; i < 40; i += 1) {
    until = h.armWatchWindowV2(st, GROUP);
  }
  const total = until - Number(st.watchOpenedAt);
  assert.ok(total <= 30 * 60 * 1000 + ms, `总时长该封顶在 30 分钟，实际 ${Math.round(total / 1000)} 秒`);
});

await test('观望窗口：窗口过期之后再收尾，重新从当前时刻起算', () => {
  const st = triggerOnly();
  withPartner(st);
  h.armWatchWindowV2(st, GROUP);
  // 窗口已经过去了（模拟群里安静了一阵）。
  st.watchUntil = Date.now() - 1000;
  const now = Date.now();
  const again = h.armWatchWindowV2(st, GROUP);
  assert.ok(again >= now + h.postReplyWatchMs() - 5, '过期后应当重新起算，而不是停在旧值');
  assert.ok(Number(st.watchOpenedAt) >= now - 5, 'watchOpenedAt 也要跟着重置');
});

await test('观望窗口：私聊不开（私聊每条消息本来就会叫醒她）', () => {
  const pst = h.getSocialV2State('private:123');
  pst.recentMessages = [];
  pst.lastAiReplyAt = Date.now() - 5000;
  assert.equal(h.armWatchWindowV2(pst, 'private:123'), 0);
  assert.equal(pst.watchUntil, 0, '私聊不该写 watchUntil');
});

await test('观望窗口：过期之后就不再算', () => {
  const st = triggerOnly();
  st.wakeConfig.triggers.question = false;
  withPartner(st);
  st.watchUntil = Date.now() - 1;
  const text = '那我再问一句';
  assert.equal(h.evaluateWakeTriggerV2(GROUP, st, eventFor(text), 'group', text, text, false), null);
});

await test('观望窗口：隔了很久才收尾就不开窗（那段对话早凉了）', () => {
  const st = triggerOnly({ lastAiReplyAt: Date.now() - 30 * 60 * 1000 });
  assert.equal(h.armWatchWindowV2(st), 0);
});

await test('观望窗口：配置成 0 就完全关闭', () => {
  const st = triggerOnly({ lastAiReplyAt: Date.now() - 5000 });
  const before = h.cfg.socialV2.wake.postReplyWatchMs;
  h.cfg.socialV2.wake.postReplyWatchMs = 0;
  try {
    assert.equal(h.postReplyWatchMs(), 0);
    assert.equal(h.armWatchWindowV2(st), 0);
  } finally {
    h.cfg.socialV2.wake.postReplyWatchMs = before;
  }
});

await test('观望窗口：上限压到 30 分钟，别把会话占成常驻', () => {
  const before = h.cfg.socialV2.wake.postReplyWatchMs;
  h.cfg.socialV2.wake.postReplyWatchMs = 24 * 60 * 60 * 1000;
  try {
    assert.equal(h.postReplyWatchMs(), 30 * 60 * 1000);
  } finally {
    h.cfg.socialV2.wake.postReplyWatchMs = before;
  }
});

// ── 2026-10-31 真事故：config.json 里老 wake 段把新键吃掉 ───────────────────────
//
// cfg.socialV2 是 `{ ...默认段, ...(file.socialV2 ?? {}) }`，顶层 spread 整段替换。
// config.json 里只要写了 wake 段（本机就有，且没有 postReplyWatchMs），默认段就被整个顶掉，
// 于是 Number(undefined) 得 NaN、postReplyWatchMs() 返回 0，收尾后一次都没开过观望窗口
// （15:02/15:04/15:05 三次收尾，日志里一条「收尾后观望」都没有）。
// 这里钉死「老配置照样拿到默认值」，而不是只测 armWatchWindowV2 本身。
await test('老 config.json 的 wake 段缺新键时，深度合并仍给出默认的观望窗口', async () => {
  const legacy = await bridgeHarness({
    config: {
      socialV2: {
        // 模拟本机那份：有 wake，但没有 postReplyWatchMs
        wake: { defaultMode: 'diving', batchWindowMs: 3000, sleepMinMs: 30000 },
      },
    },
  });
  try {
    legacy.setMode('reserved2');
    legacy.setSelfIdentity('大肥鱼', SELF);
    assert.equal(legacy.cfg.socialV2.wake.postReplyWatchMs, 180000,
      '缺键必须回落到默认 180000，否则观望窗口永远不生效');
    // 老配置里显式写了的值也不能被默认值盖掉
    assert.equal(legacy.cfg.socialV2.wake.batchWindowMs, 3000);
    assert.equal(legacy.cfg.socialV2.wake.sleepMinMs, 30000);
    // 而且真的能开窗
    const st = { lastAiReplyAt: Date.now() - 5000, watchUntil: 0 };
    assert.ok(legacy.armWatchWindowV2(st) > Date.now());
  } finally {
    legacy.close();
  }
});

await test('write 段里显式写 0 的观望窗口不会被默认值顶回 180000', async () => {
  const zeroed = await bridgeHarness({
    config: { socialV2: { wake: { postReplyWatchMs: 0 } } },
  });
  try {
    zeroed.setMode('reserved2');
    assert.equal(zeroed.cfg.socialV2.wake.postReplyWatchMs, 0, '显式 0 是「关掉」，不能当缺键处理');
    assert.equal(zeroed.postReplyWatchMs(), 0);
  } finally {
    zeroed.close();
  }
});

// ── 同一个坑的第二处：context 段（2026-10-31 审查） ────────────────────────────
// cfg.socialV2 是 `{ ...默认段, ...(file.socialV2 ?? {}) }`，顶层 spread 整段替换。
// wake 段早就补了深度合并，context 段漏了 —— 老配置只写几个键时，后来新增的
// wakeRecentMaxAgeMs / wakeMessageLimit / inlineWakeMessages 全都变 undefined。
await test('老 config.json 的 context 段缺新键时，深度合并仍给出默认值', async () => {
  const legacyCtx = await bridgeHarness({
    config: {
      socialV2: {
        // 模拟老配置：只有最早的几个键
        context: { recentLimit: 60, unreadLimit: 20, contextWindow: 10 },
      },
    },
  });
  try {
    legacyCtx.setMode('reserved2');
    const ctx = legacyCtx.cfg.socialV2.context;
    // 老配置显式写了的值要保住
    assert.equal(ctx.recentLimit, 60, '老配置的 recentLimit 不能被默认值盖掉');
    assert.equal(ctx.unreadLimit, 20);
    assert.equal(ctx.contextWindow, 10);
    // 后来新增的键必须拿到默认值，而不是 undefined
    assert.equal(ctx.wakeRecentLimit, 12, '缺键要回落到默认 12');
    assert.equal(ctx.wakeMessageLimit, 12);
    assert.equal(ctx.wakeMaxChars, 6000);
    assert.equal(ctx.wakeRecentMaxAgeMs, 1800000);
    assert.equal(ctx.inlineWakeMessages, true);
    assert.equal(typeof ctx.wakeCheckPrompt, 'string', '醒来先过三关的默认正文不该丢');
  } finally {
    legacyCtx.close();
  }
});

await test('context 段里显式写 0 的时间上限不会被默认值顶回 30 分钟', async () => {
  const zeroedCtx = await bridgeHarness({
    config: { socialV2: { context: { wakeRecentMaxAgeMs: 0 } } },
  });
  try {
    zeroedCtx.setMode('reserved2');
    assert.equal(zeroedCtx.cfg.socialV2.context.wakeRecentMaxAgeMs, 0, '显式 0 是「不限」，不能当缺键处理');
  } finally {
    zeroedCtx.close();
  }
});

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
