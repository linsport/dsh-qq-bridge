// 拍一拍的唤醒边界（2026-10-31）。
//
// 真实故障：群 100001 里另一个机器人「小鲸鱼」每次回话前先发一条
// 「[拍一拍] 小鲸鱼 捏了捏 10001 的人」，那一串拍一拍把本桥接连续唤醒十几次，
// 每轮跑完整个回合、读完未读、判断「没点名问我」再收尾 —— 一次也没说话，却烧掉十几次 token。
//
// 根因：handlePokeNotice 里 targetIsSelf 算出来了、也写进消息里了，可唤醒判定只看
// triggers.poke，于是群里谁拍谁都算叫它。拍一拍是群里最廉价的动作，不设这道闸
// 就等于给每个群友（和每个别的机器人）一个免费唤醒器。
//
// 这里的契约：群聊只有「拍的是我」才唤醒；私聊照旧（一对一里对方拍的就是你）。
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
const GROUP = '456'; // harness 默认 allow.groups
const h = await bridgeHarness({ config: { socialV2: {
  wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
  proactive: { enabled: false },
  sticker: { enabled: false }
} } });
h.setMode('reserved2');
h.setSelfIdentity('大肥鱼', SELF);

// bootstrap 已经发过，才轮得到按 triggers 触发
function ready(key) {
  const st = h.getSocialV2State(key);
  st.bootstrapSent = true;
  st.wakeConfig = {
    ...st.wakeConfig,
    mode: 'diving',
    infinite: true,
    muted: false,
    triggers: {
      atMention: false, nameMention: false, question: false, keywords: [],
      poke: true, probability: 0, anyMessage: false, speakerIds: []
    }
  };
  return st;
}

function clearWake(st) {
  if (st.pendingWakeTimer) clearTimeout(st.pendingWakeTimer);
  st.pendingWakeTimer = null;
  st.pendingWakeReasons = [];
}

const groupKey = `group:${GROUP}`;

await test('群里别人之间互相拍：不唤醒', async () => {
  const st = ready(groupKey);
  clearWake(st);
  // 另一个机器人拍群主 —— 正是「小鲸鱼 捏了捏 10001 的人」那种。
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: '10001' });
  assert.equal(st.pendingWakeTimer, null, '别人互相拍不该排唤醒');
});

await test('群里拍我：唤醒', async () => {
  const st = ready(groupKey);
  clearWake(st);
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: SELF });
  assert.ok(st.pendingWakeTimer, '拍我应该排唤醒');
  clearWake(st);
});

await test('群里我自己拍别人：连事件都不该记（原有行为不能被这道闸改坏）', async () => {
  const st = ready(groupKey);
  clearWake(st);
  const before = st.recentMessages.length;
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: SELF, target_id: '999' });
  assert.equal(st.pendingWakeTimer, null);
  assert.equal(st.recentMessages.length, before, '自己拍的拍一拍不该进历史');
});

await test('私聊：对方拍我就唤醒（一对一没有「拍别人」这回事）', async () => {
  const key = 'private:123'; // harness 默认 allow.private
  const st = ready(key);
  clearWake(st);
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, user_id: '123' });
  assert.ok(st.pendingWakeTimer, '私聊里对方拍一拍该唤醒');
  clearWake(st);
});

await test('关掉 triggers.poke 之后，拍我也不唤醒', async () => {
  const st = ready(groupKey);
  st.wakeConfig = { ...st.wakeConfig, triggers: { ...st.wakeConfig.triggers, poke: false } };
  clearWake(st);
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: SELF });
  assert.equal(st.pendingWakeTimer, null, '开关关掉就该彻底不醒');
});

await test('不管拍的是谁，拍一拍事件本身照常进 recentMessages（记录不等于唤醒）', async () => {
  const st = ready(groupKey);
  clearWake(st);
  const before = st.recentMessages.length;
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: '10001' });
  assert.equal(st.recentMessages.length, before + 1, '别人的拍一拍仍要留痕，只是不叫醒');
  const last = st.recentMessages[st.recentMessages.length - 1];
  assert.equal(last.kind, 'poke');
  assert.equal(last.poke.targetIsSelf, false);
});

await test('别人的拍一拍不进未读，也不占 seq 号', async () => {
  const st = ready(groupKey);
  clearWake(st);
  const unreadBefore = st.unread.length;
  const seqBefore = st.lastUnreadSeq;
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: '10001' });
  assert.equal(st.unread.length, unreadBefore, '不该挤进【本轮消息】');
  assert.equal(st.lastUnreadSeq, seqBefore, '不占号：给了号却不进 unread，水位会永远卡在它前面');
  const last = st.recentMessages[st.recentMessages.length - 1];
  assert.equal(last.seq, null, '没号的拍一拍 seq 应该是 null');
});

await test('别人的拍一拍之后，水位仍能正常推进（不是靠它推）', async () => {
  const st = ready(groupKey);
  clearWake(st);
  st.unread = [];
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: '10001' });
  // 紧接着来一条真消息，它才该拿到号并进未读。
  const seqBefore = st.lastUnreadSeq;
  h.appendSocialV2Message(groupKey, '乙群友', '在吗', '在吗', false, false, '777', [], '555', [], []);
  assert.equal(st.lastUnreadSeq, seqBefore + 1, '真消息照常占号');
  assert.equal(st.unread.length, 1);
  assert.ok(st.unread[0].seq > seqBefore, '水位能越过拍一拍，接着往下走');
});

await test('拍我的拍一拍照常进未读（那是真的有人叫我）', async () => {
  const st = ready(groupKey);
  clearWake(st);
  const unreadBefore = st.unread.length;
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: SELF });
  assert.equal(st.unread.length, unreadBefore + 1, '拍我该进未读让模型看见');
  const last = st.recentMessages[st.recentMessages.length - 1];
  assert.equal(typeof last.seq, 'number', '进未读的必须有号');
  clearWake(st);
});

await test('私聊的拍一拍照常进未读', async () => {
  const key = 'private:123';
  const st = ready(key);
  clearWake(st);
  const unreadBefore = st.unread.length;
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, user_id: '123' });
  assert.equal(st.unread.length, unreadBefore + 1);
  clearWake(st);
});

// ── 快照里的标记（2026-10-31 审查） ──────────────────────────────────────────
// 拍一拍没有 at 段，「对谁说」写在 poke.targetIsSelf 里。原来 addressMark 只看
// atTargets，于是「拍了拍 你」被标成（未点名）—— 正好撞上 persona 里刚加的
// 「（未点名）多半不是在问你」，等于自己拆自己的台。
await test('快照里拍我的拍一拍标（拍你），不是（未点名）', async () => {
  const st = ready(groupKey);
  clearWake(st);
  st.unread = [];
  st.recentMessages = [];
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: SELF });
  const snap = h.buildWakeSnapshotV2(groupKey);
  const text = h.renderWakeSnapshotV2(snap);
  assert.ok(text.includes('（拍你）'), '该标（拍你），实际:\n' + text);
  assert.ok(!text.includes('（未点名）'), '不该标（未点名），实际:\n' + text);
  clearWake(st);
});

await test('快照里拍别人的拍一拍标出拍的是谁', async () => {
  const st = ready(groupKey);
  clearWake(st);
  st.unread = [];
  st.recentMessages = [];
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, group_id: GROUP, user_id: '999', target_id: '10001' });
  const text = h.renderWakeSnapshotV2(h.buildWakeSnapshotV2(groupKey));
  assert.ok(text.includes('（拍了 10001）'), '该标出拍的是谁，实际:\n' + text);
  assert.ok(!text.includes('（拍你）'), '拍的不是我，不能标（拍你）');
  clearWake(st);
});

await test('私聊快照里拍一拍不加标记（每句本来就是对你说的）', async () => {
  const key = 'private:123';
  const st = ready(key);
  clearWake(st);
  st.unread = [];
  st.recentMessages = [];
  await h.handlePokeNotice({ sub_type: 'poke', self_id: SELF, user_id: '123' });
  const text = h.renderWakeSnapshotV2(h.buildWakeSnapshotV2(key));
  assert.ok(!text.includes('（拍你）'), '私聊不该标，实际:\n' + text);
  assert.ok(!text.includes('（未点名）'), '私聊不该标，实际:\n' + text);
  clearWake(st);
});

h.close?.();
console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
