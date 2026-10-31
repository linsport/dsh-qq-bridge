// 分场景人格：默认层（私聊一份、群聊一份）+ 会话级覆盖（某个群/某个人单独指定）。
// 关键行为：
//   ① 两个场景默认互不影响，谁也不跟随谁；
//   ② 会话级覆盖压过场景默认，且 null 也是覆盖（明确不扮演，不许回落）；
//   ③ 会话级覆盖分「写 null」和「删键」两种清除语义，不能混；
//   ④ 改 mode、改另一边默认，都不能顺手把已设的东西抹掉；
//   ⑤ 旧版 state 文件（只有 role/mode）读得动，且 role 一次性搬到两个默认里。
import { bridgeHarness } from './audit-bridge-harness.mjs';
import fs from 'node:fs';
import path from 'node:path';

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ ok: true, name });
  } catch (error) {
    results.push({ ok: false, name, error: error?.message ?? String(error) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function seedRoles(h, map) {
  const dir = path.join(h.temp, 'roles');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(map)) {
    fs.writeFileSync(path.join(dir, name + '.md'), body, 'utf8');
  }
}
function stateFile(h) {
  return path.join(h.temp, 'state', 'current-role.json');
}
function readState(h) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(h), 'utf8'));
  } catch {
    return {};
  }
}

await check('默认全空：两个场景都不扮演', async () => {
  const h = await bridgeHarness();
  const rs = h.readRoleState();
  assert(rs.groupRole === null, 'groupRole 应为 null，实际 ' + rs.groupRole);
  assert(rs.privateRole === null, 'privateRole 应为 null，实际 ' + rs.privateRole);
  assert(h.effectiveRoleName('group:1', rs) === null, '群聊应不扮演');
  assert(h.effectiveRoleName('private:1', rs) === null, '私聊应不扮演');
  await h.close();
});

await check('两个场景默认各管各的，只改群聊不动私聊', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 群聊默认: '群聊正文。', 私聊默认: '私聊正文。' });
  h.writeRoleState('active', { privateRole: '私聊默认' });
  h.writeRoleState('active', { groupRole: '群聊默认' });
  const rs = h.readRoleState();
  assert(rs.groupRole === '群聊默认', '群聊默认应为群聊默认');
  assert(rs.privateRole === '私聊默认', '私聊默认不该被改，实际 ' + rs.privateRole);
  assert(h.effectiveRoleName('group:1', rs) === '群聊默认', '群聊生效群聊默认');
  assert(h.effectiveRoleName('private:1', rs) === '私聊默认', '私聊生效私聊默认');
  await h.close();
});

await check('会话级覆盖压过场景默认', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 群聊默认: '群聊正文。', 这个群专用: '专用正文。' });
  h.writeRoleState('active', { groupRole: '群聊默认' });
  h.writeRoleState('active', { sessionRoles: { 'group:100001': '这个群专用' } });
  const rs = h.readRoleState();
  assert(h.effectiveRoleName('group:100001', rs) === '这个群专用', '该群应被覆盖');
  assert(h.effectiveRoleName('group:999', rs) === '群聊默认', '别的群仍用默认');
  await h.close();
});

await check('会话级 null 是覆盖：压住默认，不许回落', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 群聊默认: '群聊正文。' });
  h.writeRoleState('active', { groupRole: '群聊默认' });
  h.writeRoleState('active', { sessionRoles: { 'group:1': null } });
  const rs = h.readRoleState();
  assert(h.effectiveRoleName('group:1', rs) === null, '应为 null（不扮演），实际 ' + h.effectiveRoleName('group:1', rs));
  assert(h.effectiveRoleName('group:2', rs) === '群聊默认', '别的群不受影响');
  await h.close();
});

await check('删键才回落默认', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 群聊默认: '群聊正文。' });
  h.writeRoleState('active', { groupRole: '群聊默认' });
  h.writeRoleState('active', { sessionRoles: { 'group:1': null } });
  const cleared = h.writeRoleState('active', { sessionRoles: { 'group:1': h.CLEAR_SESSION_ROLE } });
  assert(!Object.prototype.hasOwnProperty.call(cleared.sessionRoles, 'group:1'), '会话覆盖键应被删掉');
  assert(h.effectiveRoleName('group:1', cleared) === '群聊默认', '删键后应回落默认');
  await h.close();
});

await check('改某个场景默认不影响已有的会话覆盖', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 旧默认: '旧。', 新默认: '新。', 专用: '专用。' });
  h.writeRoleState('active', { groupRole: '旧默认', sessionRoles: { 'group:1': '专用' } });
  h.writeRoleState('active', { groupRole: '新默认' });
  const rs = h.readRoleState();
  assert(rs.groupRole === '新默认', '默认应更新');
  assert(rs.sessionRoles['group:1'] === '专用', '会话覆盖应保留，实际 ' + rs.sessionRoles['group:1']);
  await h.close();
});

await check('写 mode 不会丢两个默认与会话覆盖', async () => {
  const h = await bridgeHarness();
  h.writeRoleState('active', { groupRole: '群聊版', privateRole: '私聊版', sessionRoles: { 'group:9': '专用' } });
  h.writeRoleState('silent');
  const rs = h.readRoleState();
  assert(rs.mode === 'silent', 'mode 应为 silent');
  assert(rs.groupRole === '群聊版', 'groupRole 应保留，实际 ' + rs.groupRole);
  assert(rs.privateRole === '私聊版', 'privateRole 应保留，实际 ' + rs.privateRole);
  assert(rs.sessionRoles['group:9'] === '专用', '会话覆盖应保留');
  await h.close();
});

await check('人格正文按会话解析取到对应文件', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 群聊默认: '# 群\n\n群聊默认正文。\n', 专用: '# 专\n\n专用正文。\n', 私聊默认: '# 私\n\n私聊默认正文。\n' });
  h.writeRoleState('active', { groupRole: '群聊默认', privateRole: '私聊默认', sessionRoles: { 'group:1': '专用' } });
  const rs = h.readRoleState();
  const g1 = h.currentRoleHint(h.effectiveRoleName('group:1', rs));
  const g2 = h.currentRoleHint(h.effectiveRoleName('group:2', rs));
  const p1 = h.currentRoleHint(h.effectiveRoleName('private:1', rs));
  assert(g1.includes('专用正文'), '被覆盖的群应读专用，实际：' + JSON.stringify(g1));
  assert(g2.includes('群聊默认正文'), '别的群应读默认，实际：' + JSON.stringify(g2));
  assert(p1.includes('私聊默认正文'), '私聊应读私聊默认，实际：' + JSON.stringify(p1));
  await h.close();
});

await check('roleSourceForKey 能分清三层来源', async () => {
  const h = await bridgeHarness();
  h.writeRoleState('active', { groupRole: '群聊默认', privateRole: '私聊默认', sessionRoles: { 'group:1': '专用', 'group:2': null } });
  const rs = h.readRoleState();
  assert(h.roleSourceForKey('group:1', rs) === 'session', '被覆盖的群应为 session');
  assert(h.roleSourceForKey('group:2', rs) === 'none', '明确不扮演应为 none');
  assert(h.roleSourceForKey('group:3', rs) === 'scene', '未覆盖的群应为 scene');
  assert(h.roleSourceForKey('private:1', rs) === 'scene', '私聊应为 scene');
  await h.close();
});

await check('不传 roleName 时不扮演（没有全局回落）', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 群聊默认: '群聊正文。' });
  h.writeRoleState('active', { groupRole: '群聊默认' });
  const hint = h.currentRoleHint();
  assert(hint === '', '不传名字应读到空，实际：' + JSON.stringify(hint));
  await h.close();
});

await check('未知前缀不扮演（不猜）', async () => {
  const h = await bridgeHarness();
  h.writeRoleState('active', { groupRole: '群聊版', privateRole: '私聊版' });
  const rs = h.readRoleState();
  assert(h.effectiveRoleName('weird:1', rs) === null, '未知前缀应不扮演，实际 ' + h.effectiveRoleName('weird:1', rs));
  await h.close();
});

await check('state 文件按新结构落盘，旧的 role 字段不再写回', async () => {
  const h = await bridgeHarness();
  h.writeRoleState('active', { groupRole: '群聊版', privateRole: '私聊版', sessionRoles: { 'group:1': '专用' } });
  const raw = readState(h);
  assert(raw.mode === 'active', 'mode 落盘');
  assert(raw.groupRole === '群聊版', 'groupRole 落盘，实际 ' + raw.groupRole);
  assert(raw.privateRole === '私聊版', 'privateRole 落盘，实际 ' + raw.privateRole);
  assert(raw.sessionRoles['group:1'] === '专用', 'sessionRoles 落盘');
  assert(!('role' in raw), 'role 字段不该再被写回，实际：' + JSON.stringify(raw));
  await h.close();
});

await check('旧版 state 文件（只有 role/mode）迁移到两个默认', async () => {
  const h = await bridgeHarness({ files: { 'state/current-role.json': { role: '大肥鱼', mode: 'silent' } } });
  const rs = h.readRoleState();
  assert(rs.mode === 'silent', 'mode 应读到');
  assert(rs.groupRole === '大肥鱼', '旧 role 应搬到群聊默认，实际 ' + rs.groupRole);
  assert(rs.privateRole === '大肥鱼', '旧 role 应搬到私聊默认，实际 ' + rs.privateRole);
  await h.close();
});

await check('旧文件迁移时显式 null 不被旧 role 复活', async () => {
  const h = await bridgeHarness({ files: { 'state/current-role.json': { role: '大肥鱼', mode: 'active', privateRole: null } } });
  const rs = h.readRoleState();
  assert(rs.groupRole === '大肥鱼', '没写过的群聊应继承旧 role');
  assert(rs.privateRole === null, '显式 null 应被尊重，实际 ' + rs.privateRole);
  await h.close();
});

await check('非法会话键写不进去', async () => {
  const h = await bridgeHarness();
  h.writeRoleState('active', { sessionRoles: { 'weird:1': '专用', 'group:': '专用', 'group:2': '合法' } });
  const rs = h.readRoleState();
  assert(!('weird:1' in rs.sessionRoles), '非 group/private 前缀应被丢弃');
  assert(!('group:' in rs.sessionRoles), '缺 id 的键应被丢弃');
  assert(rs.sessionRoles['group:2'] === '合法', '合法键应保留');
  await h.close();
});

// ── 内联门槛（role.inlineMaxChars）：从硬编码 1200 改成可配 ────────────────────
// 这条门槛决定「每轮唤醒带全文还是只带名字」，改一个数就是几万 token 的差别，
// 所以三件事都要钉住：默认值、改配置真的换分档、非法值被收敛。
await check('默认门槛 1200：小卡内联、大卡只发名字', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 小卡: '甲'.repeat(1180), 大卡: '乙'.repeat(1500) });
  // roleRawContent 会 stat state/current-role.json 做缓存键，那个文件不存在就直接返回空串。
  // 所以必须先写一次 state，否则读到的永远是一张空卡（这个坑本身也值得记住）。
  h.writeRoleState('active', {});
  const small = h.buildRoleLineV2('小卡');
  const big = h.buildRoleLineV2('大卡');
  assert(small.includes('甲'.repeat(100)), '小卡应全文内联，实际：' + small.slice(0, 60));
  assert(big.includes('qq_get_prompt'), '大卡应只发名字，实际：' + big.slice(0, 60));
  assert(!big.includes('乙'), '大卡正文不该被带进去');
  await h.close();
});

await check('把门槛调大，同一张卡就从「只发名字」变成「全文内联」', async () => {
  const h = await bridgeHarness();
  seedRoles(h, { 大卡: '乙'.repeat(1500) });
  h.writeRoleState('active', {});
  assert(h.buildRoleLineV2('大卡').includes('qq_get_prompt'), '默认 1200 下应先只发名字');
  h.setRoleInlineMaxChars(2000);
  const after = h.buildRoleLineV2('大卡');
  assert(after.includes('乙'.repeat(100)), '门槛调到 2000 后应全文内联，实际：' + after.slice(0, 60));
  assert(!after.includes('qq_get_prompt'), '内联后不该再提示去查');
  await h.close();
});

await check('非法门槛值被收敛到 200~20000', async () => {
  const h = await bridgeHarness();
  assert(h.applyRoleInlineLimit(0) === 200, '过小应收敛到 200');
  assert(h.applyRoleInlineLimit(99999) === 20000, '过大应收敛到 20000');
  assert(h.applyRoleInlineLimit(1500.4) === 1500, '取整');
  assert(h.applyRoleInlineLimit('abc') === 1200, '非数字回落默认 1200');
  assert(h.applyRoleInlineLimit(undefined) === 1200, '缺省回落默认 1200');
  // 注入上限是另一条独立的线，别被这次改动带歪
  assert(h.applyRoleInjectLimit(0) === 1000, '注入上限下界仍是 1000');
  assert(h.applyRoleInjectLimit(99999) === 20000, '注入上限上界仍是 20000');
  await h.close();
});

let pass = 0;
for (const r of results) {
  if (r.ok) { pass += 1; console.log(`PASS ${r.name}`); }
  else console.log(`FAIL ${r.name}\n     ${r.error}`);
}
console.log(`\n${pass}/${results.length} 通过`);
if (pass !== results.length) process.exitCode = 1;
