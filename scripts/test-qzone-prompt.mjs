// QQ 空间「写空间规则」注入回归。
//
// 钉住的边界（每一条都对应一个具体会出事的形态）：
//   1. 没启用的会话里，这段文字一个字都不该出现 —— 否则模型会去调一个必然 403 的工具；
//   2. 只给 owner 私聊：群聊/白名单会话拿到这段，等于教它去撞墙；
//   3. 启用但规则留空时整段消失，不该剩一个「【QQ 空间】」的空壳标题；
//   4. 开关打开后，每一轮唤醒都带上它（不是只在 bootstrap 出现一次）；
//   5. config 落盘走同一条归一化：开关必须是真布尔、条数有上下界、字数有硬上限。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const root = fileURLToPath(new URL('..', import.meta.url));
const OWNER_KEY = 'private:123';
const GROUP_KEY = 'group:456';

// 每条都造一份新 harness：qzone 配置是进程级的，改完不能漏到下一条。
async function withQzone(qzone, run) {
  const h = await bridgeHarness({ config: { socialV2: { qzone } } });
  await run(h);
}

await test('未启用时任何会话都看不到这段', async () => {
  await withQzone({ enabled: false, prompt: '值得发的：做成了一件事' }, async (h) => {
    assert.equal(h.buildQzonePromptV2(OWNER_KEY), '');
    assert.ok(!h.buildWakePromptV2(OWNER_KEY, 'reply').includes('【QQ 空间】'));
  });
});

await test('启用后 owner 私聊能看到，群聊看不到', async () => {
  await withQzone({ enabled: true, prompt: '值得发的：做成了一件事' }, async (h) => {
    const owner = h.buildQzonePromptV2(OWNER_KEY);
    assert.ok(owner.startsWith('【QQ 空间】'), 'owner 私聊要带上这段');
    assert.ok(owner.includes('值得发的：做成了一件事'), '要原样带上操作者写的规则');
    assert.equal(h.buildQzonePromptV2(GROUP_KEY), '', '群友不该看到 —— 它们调用必然 403');
    assert.equal(h.buildQzonePromptV2('private:999'), '', '非 owner 的私聊同样不给');
  });
});

await test('启用但规则为空时整段消失（不留空壳标题）', async () => {
  for (const prompt of ['', '   ', undefined]) {
    await withQzone({ enabled: true, prompt }, async (h) => {
      assert.equal(h.buildQzonePromptV2(OWNER_KEY), '', `prompt=${JSON.stringify(prompt)} 时不该出现空壳`);
    });
  }
});

await test('每轮唤醒都带上，不只在 bootstrap', async () => {
  await withQzone({ enabled: true, prompt: '语气像随手记一笔' }, async (h) => {
    for (const reason of ['bootstrap', 'reply', 'timeout', 'replyCheck', 'proactiveCheck', 'poke', 'admin']) {
      assert.ok(h.buildWakePromptV2(OWNER_KEY, reason).includes('语气像随手记一笔'), `${reason} 这一轮漏了写空间规则`);
    }
  });
});

await test('字数上限与布尔归一化（走 /api/config 同一条路）', async () => {
  const h = await bridgeHarness({ config: { socialV2: {} } });
  const save = h.normalizeQzoneConfig;
  assert.equal(typeof save, 'function', '需要 harness 暴露归一化入口');
  const base = { enabled: true, maxPerDay: 3, prompt: '原有规则' };
  // 超长 prompt 被 slice 到上限
  const long = '字'.repeat(2000);
  const out = save(base, { prompt: long, maxPerDay: 999, enabled: 'yes' });
  assert.equal(out.prompt.length, h.QZONE_PROMPT_MAX_CHARS, '超过上限要截断，否则每轮成本失控');
  assert.equal(out.maxPerDay, 20, 'maxPerDay 要收敛到 1~20');
  assert.equal(out.enabled, false, "字符串 'yes' 不算 true —— 只有真布尔才能开启");
  // 非法数字回落到当前值，不能写成 NaN
  const out2 = save(base, { maxPerDay: 'abc' });
  assert.equal(out2.maxPerDay, 3, '非法数字要回落到当前值');
  // 只传 maxPerDay 不该把 prompt 和开关清掉
  assert.equal(out2.prompt, '原有规则', '没提到的字段保持原值');
  assert.equal(out2.enabled, true, '没提到的开关保持原值');
  // 关闸也认真布尔：数字 1 不算
  assert.equal(save(base, { enabled: 1 }).enabled, false, '数字 1 不该被当成开启');
  // 下界
  assert.equal(save(base, { maxPerDay: 0 }).maxPerDay, 1, 'maxPerDay 下界是 1');
});

await test('config.json 里没有 qzone 段时，默认是关闭且规则为空', async () => {
  const h = await bridgeHarness({ config: { socialV2: {} } });
  assert.equal(h.cfg.socialV2.qzone.enabled, false);
  assert.equal(h.cfg.socialV2.qzone.prompt, '');
  assert.equal(h.cfg.socialV2.qzone.maxPerDay, 2);
  await h.close?.();
});

await test('工具描述与端点语义一致（未启用时提示怎么开）', async () => {
  const source = fs.readFileSync(path.join(root, 'src/mcp-snowluma-safe.js'), 'utf8');
  assert.ok(source.includes('qq_post_moment'), '空间说说工具必须挂在 MCP 表里');
  const bridge = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');
  assert.ok(
    bridge.includes('QQ 空间功能未启用（config 的 socialV2.qzone.enabled 设为 true 才可用）'),
    '未启用时的 403 文案要指明开关在哪，否则用户只能猜'
  );
});

if (failures) {
  console.error(`\n${failures} 条失败`);
  process.exit(1);
}
console.log('\n全部通过');
