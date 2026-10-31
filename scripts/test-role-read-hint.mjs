// 角色卡「首轮提醒去读」回归测试
//
// 为什么需要这条提醒：角色卡超过内联门槛（role.inlineMaxChars）时，每轮唤醒只发一行
// 【当前角色】X（完整角色卡请调用 qq_get_prompt 查看）。实测有群整整 24 次工具调用
// 里一次都没去调过 qq_get_prompt —— 人设等于从没进过上下文，模型只能拿 preset 的
// 通用助手底子说话，表现就是「在群里并不亲近主人」「问我是谁只会报 QQ 号」。
//
// 这条测试钉住的是：
//   ① 超门槛时 bootstrap 带上「先调用 qq_get_prompt」这句；
//   ② 没超门槛（全文已内联）时**不**带 —— 手上已经有了，再叫它读一次是重复；
//   ③ 只有 bootstrap 带，question / atMention / timeout 等后续唤醒都不带；
//   ④ 提醒只在有角色时出现，不扮演人格的会话不该冒出这句。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const HINT = '先调用 qq_get_prompt 读一遍你的完整角色卡';

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('ok - ' + name);
  } catch (error) {
    fail += 1;
    console.log('not ok - ' + name);
    console.log('  ' + (error?.stack ?? error));
  }
}

function seedRole(h, name, body) {
  const dir = path.join(h.temp, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.md'), body, 'utf8');
}

// ── 1. 超门槛 → bootstrap 提醒去读 ─────────────────────────────────────────
await test('角色卡超过内联门槛时，bootstrap 提醒先读完整角色卡', async () => {
  const h = await bridgeHarness();
  try {
    seedRole(h, '长卡', '长'.repeat(2000));
    h.writeRoleState('active', { groupRole: '长卡' });
    const prompt = h.buildWakePromptV2('group:1', 'bootstrap');
    assert.ok(prompt.includes('完整角色卡请调用 qq_get_prompt 查看'), '超门槛只该发那一行占位');
    assert.ok(prompt.includes(HINT), 'bootstrap 必须提醒它去读，实际没带');
    assert.ok(!prompt.includes('长长长'), '不该把全文内联进去（那是另一套方案）');
  } finally { await h.close(); }
});

// ── 2. 没超门槛 → 不提醒 ───────────────────────────────────────────────────
await test('角色卡已全文内联时不再提醒去读（手上已经有了）', async () => {
  const h = await bridgeHarness();
  try {
    seedRole(h, '短卡', '短'.repeat(500));
    h.writeRoleState('active', { groupRole: '短卡' });
    const prompt = h.buildWakePromptV2('group:1', 'bootstrap');
    assert.ok(prompt.includes('短短短'), '短卡应全文内联');
    assert.ok(!prompt.includes(HINT), '已内联就不该再叫它去读，否则是重复');
  } finally { await h.close(); }
});

// ── 3. 只有 bootstrap 带 ──────────────────────────────────────────────────
await test('提醒只在 bootstrap 出现，后续唤醒都不带', async () => {
  const h = await bridgeHarness();
  try {
    seedRole(h, '长卡', '长'.repeat(2000));
    h.writeRoleState('active', { groupRole: '长卡' });
    for (const reason of ['question', 'atMention', 'timeout', 'replyCheck', 'proactiveCheck', 'poke', 'admin', 'keyword:小鲸鱼', 'speaker:丁群友']) {
      assert.ok(!h.buildWakePromptV2('group:1', reason).includes(HINT), `${reason} 唤醒不该重复叫它去读`);
    }
  } finally { await h.close(); }
});

// ── 4. 不扮演时不冒出这句 ─────────────────────────────────────────────────
await test('会话没有角色时不出现这句提醒', async () => {
  const h = await bridgeHarness();
  try {
    h.writeRoleState('active', { groupRole: null, privateRole: null });
    const prompt = h.buildWakePromptV2('group:1', 'bootstrap');
    assert.ok(!prompt.includes(HINT), '没有角色卡还叫它去读，只会让它去读一个空东西');
  } finally { await h.close(); }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
