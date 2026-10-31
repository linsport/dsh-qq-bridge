// 【之前】那一段按时间舍去 —— 2026-10-31。
//
// 用户原话：「【之前】返回的上下文可以按照时间舍去，比如 30 分钟前的就别带了。」
//
// 现场：群 100001 冷场后被 @ 醒，[之前] 里塞着 58 / 57 / 52 分钟前的旧账，
// 她还照着它们判断「你」指谁；另一边活跃时最后 12 条跨度只有 1 分钟 —— 切不到东西，
// 正是想要的：热的时候全留，冷场才瘦身。
//
// 契约：
//   ① 默认 1800000（30 分钟），0 = 不限（老行为）；
//   ② 口径是「距现在」而不是「距最新一条」，全是陈年旧事的窗口留着没意义；
//   ③ 全被切光时保底留 2 条 —— 否则她连「上一句在说什么」都不知道；
//   ④ 切了要在【之前】标题后说一声，别让她以为那就是全部。
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

const KEY = 'group:456'; // harness 默认 allow.groups
const MIN = 60 * 1000;

function make(ageMs, text) {
  return {
    seq: 0,
    messageId: String(Math.floor(Math.random() * 1e9) + 1),
    sender: '群友',
    userId: '777',
    text,
    plain: text,
    time: Date.now() - ageMs,
    isSelf: false,
    isOwner: false,
  };
}

async function boot(recent, extra = {}) {
  const h = await bridgeHarness({ config: { socialV2: {
    wait: { minMs: 100, maxMs: 2000, minQuietAfterNewMs: 0 },
    proactive: { enabled: false },
    sticker: { enabled: false },
    ...extra,
  } } });
  h.setMode('reserved2');
  h.setSelfIdentity('大肥鱼', '300001');
  const st = h.getSocialV2State(KEY);
  // bootstrap 已经发过，才轮得到按 triggers 触发
  st.bootstrapSent = true;
  for (const m of recent) st.recentMessages.push(m);
  return { h, st };
}

await test('30 分钟前的旧账不进【之前】，并说清省略了几条', async () => {
  const { h, st } = await boot([
    make(58 * MIN, '五十八分钟前那句'),
    make(57 * MIN, '五十七分钟前那句'),
    make(52 * MIN, '五十二分钟前那句'),
    make(2 * MIN, '两分钟前那句'),
    make(1 * MIN, '一分钟前那句'),
  ]);
  const snap = h.buildWakeSnapshotV2(KEY);
  const recentTexts = snap.recent.map((m) => m.text);
  assert.ok(!recentTexts.includes('五十八分钟前那句'), '58 分钟前那句不该还在');
  assert.ok(!recentTexts.includes('五十二分钟前那句'), '52 分钟前那句不该还在');
  assert.ok(recentTexts.includes('一分钟前那句'), '一分钟前那句必须在');
  assert.equal(snap.recentDropped, 3, '应该报告切掉了 3 条');

  const rendered = h.renderWakeSnapshotV2(snap);
  assert.match(rendered, /【之前】（更早的 3 条超出时间范围，已省略）/);
  assert.ok(!rendered.includes('五十八分钟前那句'));
  void st;
});

await test('热聊时一分钟跨度全留，一条都不切', async () => {
  const { h } = await boot([
    make(6 * MIN, '六分钟前'),
    make(4 * MIN, '四分钟前'),
    make(2 * MIN, '两分钟前'),
    make(1 * MIN, '一分钟前'),
  ]);
  const snap = h.buildWakeSnapshotV2(KEY);
  assert.equal(snap.recent.length, 4);
  assert.equal(snap.recentDropped, 0);
  assert.match(h.renderWakeSnapshotV2(snap), /^【之前】$/m);
});

await test('全是陈年旧事时保底留 2 条，不至于两眼一抹黑', async () => {
  const { h } = await boot([
    make(240 * MIN, '四小时前 A'),
    make(230 * MIN, '四小时前 B'),
    make(220 * MIN, '四小时前 C'),
  ]);
  const snap = h.buildWakeSnapshotV2(KEY);
  assert.equal(snap.recent.length, 2, '保底两条');
  // VM 里返回的数组来自另一个 realm，原型不同，deepEqual 会报
  // "same structure but not reference-equal" —— 展开成数组再比内容。
  assert.deepEqual([...snap.recent].map((m) => m.text), ['四小时前 B', '四小时前 C']);
  assert.equal(snap.recentDropped, 1);
});

await test('时间上限配 0 就完全不切（老行为）', async () => {
  const { h } = await boot(
    [make(600 * MIN, '十小时前'), make(1 * MIN, '一分钟前')],
    { context: { wakeRecentMaxAgeMs: 0 } },
  );
  const snap = h.buildWakeSnapshotV2(KEY);
  assert.equal(snap.recent.length, 2);
  assert.equal(snap.recentDropped, 0, '0 = 不限，不该报省略');
});

await test('没写 time 的旧消息不因为缺时间被丢掉', async () => {
  const { h } = await boot([{ seq: 0, messageId: '9001', sender: '群友', text: '没有时间的消息', time: 0 }]);
  const snap = h.buildWakeSnapshotV2(KEY);
  assert.equal(snap.recent.length, 1);
  assert.equal(snap.recent[0].text, '没有时间的消息');
});

await test('老 config.json 的 wake 段缺新键时，深度合并仍给出默认的观望窗口', async () => {
  // 2026-10-31 实测事故：config.json 的 wake 段没写 postReplyWatchMs，
  // 而 loadConfig 是顶层 spread，整段 wake 被覆盖，于是观望窗口一次都没开过。
  const h = await bridgeHarness({ config: { socialV2: { wake: { defaultMode: 'diving', batchWindowMs: 3000, sleepMinMs: 30000 } } } });
  h.setMode('reserved2');
  assert.equal(h.postReplyWatchMs(), 180000, '缺键时应该回落到默认 180000');
  assert.equal(h.cfg.socialV2.wake.batchWindowMs, 3000, '显式写了的仍要用配置值');
  assert.equal(h.cfg.socialV2.wake.sleepMinMs, 30000);
});

await test('config 里显式写 0 的观望窗口不会被默认值顶回 180000', async () => {
  const h = await bridgeHarness({ config: { socialV2: { wake: { postReplyWatchMs: 0 } } } });
  h.setMode('reserved2');
  assert.equal(h.postReplyWatchMs(), 0);
});

console.log(failed === 0 ? `ALL PASS passed=${passed} failed=${failed}` : `FAILED passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
