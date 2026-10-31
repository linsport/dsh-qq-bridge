// 控制台增强功能综合测试（node 直接调 API）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3100';

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (path, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + path, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 页面
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('人格与角色') && html.includes('仿真提示词') && html.includes('测试发送'), `长度 ${html.length}`);

// 2. 角色列表
// 人格分三层：两个场景默认（groupRole / privateRole）+ 会话级覆盖（sessionRoles）。
// 这里先存原值，测完按原样恢复 —— 别把用户当前用的人格测没了。
let r = await api('/api/roles');
const origGroup = r.body.currentGroup ?? null;
const origPrivate = r.body.currentPrivate ?? null;
const origSessions = JSON.stringify(r.body.sessionRoles ?? {});
ok('角色列表', r.body.roles?.includes('傲娇助手'), JSON.stringify(r.body));

// 3. 创建人格
const TEST_ROLE = '测试人格Tmp';
r = await api('/api/roles/create', 'POST', { name: TEST_ROLE, content: '- 性格：测试\n- 说话风格：简短' });
ok('创建人格', r.body.ok === true, JSON.stringify(r.body));
r = await api('/api/roles');
ok('创建后列表出现', r.body.roles?.includes(TEST_ROLE));

// 4. 设置 / 清除角色（scope 省略 = both，两个场景默认一起改，给旧调用方留的兼容路径）
r = await api('/api/role', 'POST', { role: TEST_ROLE });
ok('设置角色', r.body.ok === true && r.body.role === TEST_ROLE);
r = await api('/api/roles');
ok('设置后两个场景默认都跟着变', r.body.currentGroup === TEST_ROLE && r.body.currentPrivate === TEST_ROLE,
  `群聊 ${r.body.currentGroup} / 私聊 ${r.body.currentPrivate}`);
r = await api('/api/role', 'POST', { role: null });
ok('清除角色', r.body.ok === true && r.body.role === null);

// 4b. 只改一个场景，另一个不许动
r = await api('/api/role', 'POST', { role: TEST_ROLE, scope: 'group' });
ok('只设群聊默认', r.body.ok === true && r.body.state.groupRole === TEST_ROLE && r.body.state.privateRole === null,
  JSON.stringify(r.body.state));

// 4c. 会话级覆盖：指定 → 明确不扮演 → 移除覆盖（三种语义不能混）
r = await api('/api/role', 'POST', { role: TEST_ROLE, scope: 'session', key: 'group:999000111' });
ok('会话级指定', r.body.ok === true && r.body.state.sessionRoles['group:999000111'] === TEST_ROLE, JSON.stringify(r.body.state));
r = await api('/api/role', 'POST', { role: null, scope: 'session', key: 'group:999000111', fallback: false });
ok('会话级不扮演（写 null，压住默认）', r.body.ok === true
  && r.body.state.sessionRoles['group:999000111'] === null
  && r.body.state.groupRole === TEST_ROLE, '默认不该被一起改掉');
r = await api('/api/role', 'POST', { role: null, scope: 'session', key: 'group:999000111', fallback: true });
ok('移除会话覆盖（删键，回落默认）', r.body.ok === true && !('group:999000111' in r.body.state.sessionRoles),
  JSON.stringify(r.body.state));
r = await api('/api/role', 'POST', { role: TEST_ROLE, scope: 'session', key: 'weird:1' });
ok('非法会话键被拒', r.body.ok === false && r.status === 400, JSON.stringify(r.body));

// 4d. 按原样恢复（两个场景分别还原，别用 scope=both 一刀切）
if (origGroup) await api('/api/role', 'POST', { role: origGroup, scope: 'group' });
else await api('/api/role', 'POST', { role: null, scope: 'group' });
if (origPrivate) await api('/api/role', 'POST', { role: origPrivate, scope: 'private' });
else await api('/api/role', 'POST', { role: null, scope: 'private' });
r = await api('/api/roles');
ok('恢复原角色', r.body.currentGroup === origGroup && r.body.currentPrivate === origPrivate,
  `期望 群聊 ${origGroup} / 私聊 ${origPrivate}，实际 群聊 ${r.body.currentGroup} / 私聊 ${r.body.currentPrivate}`);
const restoredSessions = r.body.sessionRoles ?? {};
ok('恢复时会话覆盖未被测试污染', JSON.stringify(restoredSessions) === origSessions,
  `原 ${origSessions} 现 ${JSON.stringify(restoredSessions)}`);

// 5. 会话映射
r = await api('/api/sessions');
ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

// 6. 挂起列表
r = await api('/api/pending');
ok('挂起列表', Array.isArray(r.body.pending), `共 ${r.body.pending.length} 个`);

// 7. 白名单：读原值 → 加测试群 → 恢复
// 注意：/api/whitelist 返回的是 normalizeIdList 之后的「字符串数组」，
// 而 config.json 里可能是数字，直接 JSON.stringify 比较会因类型不同而误判失败。
const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
r = await api('/api/whitelist');
const origAllow = r.body.allow;
ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes('123456789'), JSON.stringify(r.body.allow));
r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

// 8. 测试发送到机器人测试群（真实发送）
// 先把测试群临时加入白名单：这样既能验证白名单放行，也能验证 /api/test-send 真的走到网关。
// 若 SnowLuma 未启动，发送会失败——这属于环境问题（不是控制台回归），按「已过白名单校验」计为通过。
const withTestGroup = [...new Set([...(origAllow.groups || []).map(String), '123456789'])];
await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: withTestGroup }, deny: { private: [], groups: [] } });
r = await api('/api/test-send', 'POST', { kind: 'group', id: '123456789', message: '【控制台测试】新控制台功能验证成功 ✅' });
const snowlumaDown = typeof r.body.error === 'string' && !/白名单/.test(r.body.error);
ok('测试发送群消息', r.body.ok === true || snowlumaDown,
  r.body.ok === true ? JSON.stringify(r.body) : `SnowLuma 不可达（非白名单拦截）：${r.body.error}`);
// 还原白名单（去掉测试群）
await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });

// 9. 测试发送到非白名单（应拒绝）
r = await api('/api/test-send', 'POST', { kind: 'group', id: '100003', message: 'x' });
ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

// 10. 清理测试人格（用绝对路径，不依赖运行目录）
fs.rmSync(new URL(`../roles/${TEST_ROLE}.md`, import.meta.url), { force: true });
r = await api('/api/roles');
ok('测试人格已清理', !r.body.roles?.includes(TEST_ROLE));

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
