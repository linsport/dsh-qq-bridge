// 名字命中判定的边界回归（2026-10-31）。
//
// 真实故障：群 100001 里，昵称是小鲸鱼的那个机器人出错、被反复 @，本桥接（叫「大肥鱼」）
// 既没被 @、推荐唤醒词也清空了，却还是被唤醒并插了一句「我回了呀，主人你没看见？」——
// 主人那句「我发消息怎么也不回我？」说的是小鲸鱼不回他，她当成了在问自己。
//
// 根因之一：nameMention 用的是裸 includes(substring)，昵称叫「小鲸鱼」时，
// 句子里任何一个「鲸鱼」都算叫名字。之二：默认推荐关键词里挂着「鲸鱼」这种过宽的词。
//
// 这里的契约：名字前后紧贴汉字/字母/数字时不算点名；@ 前缀、独立出现、被标点包住时才算。
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

const h = await bridgeHarness({ config: { socialV2: { proactive: { enabled: false }, sticker: { enabled: false } } } });
h.setMode('reserved2');
h.setSelfIdentity('大肥鱼', '300001');

await test('hasNameMention：被汉字包住时不算叫名字', () => {
  assert.equal(h.hasNameMention('这个鲸鱼玩偶挺贵的', '鲸鱼'), false);
  assert.equal(h.hasNameMention('小鲸鱼出错了', '鲸鱼'), false);
  assert.equal(h.hasNameMention('我发消息怎么也不回我', '大肥鱼'), false);
});

await test('hasNameMention：独立出现、被标点包住时算', () => {
  assert.equal(h.hasNameMention('鲸鱼，你在吗', '鲸鱼'), true);
  assert.equal(h.hasNameMention('鲸鱼', '鲸鱼'), true);
  assert.equal(h.hasNameMention('大肥鱼：你醒了吗', '大肥鱼'), true);
  // 「叫大肥鱼的人真多」是在谈论这个名字，不是在叫它 —— 前后都贴着汉字，按未点名处理。
  assert.equal(h.hasNameMention('叫大肥鱼的人真多', '大肥鱼'), false);
  // 取舍：中文名前面紧贴汉字就算「不是叫名字」，「在吗鲸鱼」这种不点名的口语会漏。
  // 有 @ 或标点就照常命中；宁可漏一次也好过被「这个鲸鱼玩偶」这种句子叫醒。
  assert.equal(h.hasNameMention('在吗鲸鱼', '鲸鱼'), false);
});

await test('hasNameMention：@ 前缀一律算，哪怕后面紧贴汉字', () => {
  assert.equal(h.hasNameMention('@大肥鱼你去睡觉吧', '大肥鱼'), true);
  assert.equal(h.hasNameMention('@鲸鱼酱', '鲸鱼'), true);
});

await test('hasNameMention：英文名要卡词边界，别把 ABCDSeek 当成 DS', () => {
  assert.equal(h.hasNameMention('use deepseek please', 'deepseek'), true);
  assert.equal(h.hasNameMention('deepseekr1', 'deepseek'), false);
  assert.equal(h.hasNameMention('', 'deepseek'), false);
  assert.equal(h.hasNameMention('随便一句话', ''), false);
});

await test('evaluateWakeTriggerV2：没 @ 也没叫名字的闲聊不该触发 nameMention', () => {
  const key = 'group:100001';
  const st = h.getSocialV2State(key);
  st.wakeConfig = {
    ...st.wakeConfig,
    mode: 'diving',
    infinite: true,
    triggers: { atMention: false, nameMention: true, question: false, keywords: [], poke: false, probability: 0, anyMessage: false, speakerIds: [] }
  };
  const event = { self_id: '300001', user_id: '111', message: [{ type: 'text', data: { text: '这个鲸鱼玩偶挺贵的' } }] };
  assert.equal(h.evaluateWakeTriggerV2(key, st, event, 'group', '这个鲸鱼玩偶挺贵的', '这个鲸鱼玩偶挺贵的', false), null);
});

await test('evaluateWakeTriggerV2：句子里独立叫了名字就触发', () => {
  const key = 'group:100001';
  const st = h.getSocialV2State(key);
  st.wakeConfig = {
    ...st.wakeConfig,
    mode: 'diving',
    infinite: true,
    triggers: { atMention: false, nameMention: true, question: false, keywords: [], poke: false, probability: 0, anyMessage: false, speakerIds: [] }
  };
  const text = '大肥鱼，你在吗';
  const event = { self_id: '300001', user_id: '111', message: [{ type: 'text', data: { text } }] };
  assert.equal(h.evaluateWakeTriggerV2(key, st, event, 'group', text, text, false), 'nameMention');
});

console.log(`\n${failed === 0 ? 'ALL PASS' : 'FAILED'} passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
