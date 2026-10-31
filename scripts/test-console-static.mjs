// 控制台静态校验：在无法跑 Playwright 的环境里，替代性地检查 HTML/JS 结构契约。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 独立发语音工具在仓库上一级（不在本仓库里）：位置解析与"不在时怎么跳过"走共享口径。
import { hasVoiceTool, skipVoiceTool, voiceToolPath } from './voice-tool-locator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 元素 ID');
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
ok(dups.length === 0, 'ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
for (const id of ['voiceList', 'voiceRefreshBtn', 'voiceSendBtn', 'voiceSendTarget', 'voiceSendDryRun', 'voiceMsg']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `语音面板元素 ${id}`, `${n} 处`);
}

console.log('## 视图 / 页面契约');
const views = [...new Set([...html.matchAll(/data-view="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
const pages = [...new Set([...html.matchAll(/data-page="([a-z0-9-]+)"/g)].map((m) => m[1]))].sort();
ok(JSON.stringify(views) === JSON.stringify(pages), 'data-view 与 data-page 一一对应', `${views.length} 个：${views.join(', ')}`);

console.log('## 工具开关');
const tools = [...html.matchAll(/data-v2-tool="([A-Za-z]+)"/g)].map((m) => m[1]);
ok(tools.includes('sendVoice'), 'sendVoice 开关存在', `共 ${tools.length} 个开关`);
ok(new Set(tools).size === tools.length, '工具开关无重复');

console.log('## 语音面板接线');
ok(/id="voiceRefreshBtn"/.test(html) && /getElementById\('voiceRefreshBtn'\)\.addEventListener/.test(html), '刷新按钮已绑定事件');
ok(/getElementById\('voiceSendBtn'\)\.addEventListener/.test(html), '试发按钮已绑定事件');
ok(/api\('\/api\/voice\/list/.test(html), '面板调用 /api/voice/list（操作者通道，无需 key）');
ok(/api\('\/api\/voice\/send'/.test(html), '面板调用 /api/voice/send');
ok(/typeof loadVoiceLibrary === 'function'|async function loadVoiceLibrary/.test(html), 'loadVoiceLibrary 已定义');

console.log('## JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log('## 语音图形界面的音量控件');
if (!hasVoiceTool()) {
  // 这一整段查的是独立工具自己的页面（voice.html），仓库里没有它。
  skipVoiceTool('voice.html 的音量控件断言（volRange/volLabel/volReset/normBox/loudnessSel/previewBtn、滑块范围、事件绑定、前端 JS 可解析）');
} else {
  const voice = fs.readFileSync(voiceToolPath('public', 'voice.html'), 'utf8');
  const ids = [...voice.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const dups = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  ok(dups.length === 0, 'voice.html ID 唯一', dups.length ? `重复：${dups.join(', ')}` : `共 ${ids.length} 个`);
  for (const id of ['volRange', 'volLabel', 'volReset', 'normBox', 'loudnessSel', 'previewBtn']) {
    ok(ids.includes(id), `音量控件 ${id}`);
  }
  ok(/id="volRange"[^>]*min="10"[^>]*max="400"/.test(voice), '滑块范围 10%~400%');
  ok(/volRange'\)\.addEventListener\('input'/.test(voice), '滑块 input 事件已绑定');
  ok(/previewBtn'\)\.addEventListener/.test(voice), '试听按钮已绑定');
  ok(/api\/preview/.test(voice), '试听调 /api/preview（听处理后的效果）');
  ok(/body\.normalize = true/.test(voice) && /body\.volume = volValue\(\)/.test(voice), '发送时带上音量设置');
  const scripts = [...voice.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  try { new Function(scripts[0]); ok(true, 'voice.html 前端 JS 可解析'); }
  catch (e) { ok(false, 'voice.html 前端 JS 可解析', e.message); }
}

console.log('## 唤醒窗口（每轮她手上能看见多少）');
// 这三格以前只存在于 config.json，控制台没有入口 —— 而 wakeRecentLimit=4 正是
// 「把别人之间的对话当成在问自己」的直接成因（群 100001：16 条对话只看见末尾 4 条）。
// 现在必须能从控制台调，且三格都要真的进 saveV2Config 的 body，否则改了等于没改。
for (const id of ['v2WakeMessageLimit', 'v2WakeRecentLimit', 'v2WakeMaxChars', 'v2WakeRecentMaxAgeMin']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `唤醒窗口控件 ${id}`, `${n} 处`);
}
ok(/v2WakeMessageLimit'\)\.value = ctx\.wakeMessageLimit/.test(html), '未读条数从配置回填');
ok(/v2WakeRecentLimit'\)\.value = ctx\.wakeRecentLimit/.test(html), '旧消息条数从配置回填');
ok(/wakeMessageLimit: Math\.round/.test(html) && /wakeRecentLimit: Math\.round/.test(html) && /wakeMaxChars: Math\.round/.test(html),
  '四格里的三格进 saveV2Config 的 context body');

// 旧消息时间上限：冷场几小时后被 @ 醒时，[之前] 里全是几小时前的旧账，
// 她照着它们判断「你」指谁，反而容易被带偏（2026-10-31 群 100001）。
// 这格填的是分钟，必须换算成毫秒进 body，且 0 要能保留成 0（=不限），不能被 || 吃掉。
ok(/v2WakeRecentMaxAgeMin'\)\.value = Math\.round\(\(ctx\.wakeRecentMaxAgeMs \?\? 1800000\) \/ 60000\)/.test(html),
  '旧消息时间上限从配置回填（毫秒转分钟）');
ok(/wakeRecentMaxAgeMs: Math\.max\(0, Math\.round\(Number\(document\.getElementById\('v2WakeRecentMaxAgeMin'\)\.value\) \|\| 0\)\) \* 60000/.test(html),
  '旧消息时间上限按分钟填、按毫秒存，0 表示不限');

console.log('## 醒来先过三关（可编辑）');
// 这段原来是硬编码在 wakeCheckLineV2 里的字符串，改一个字都要改代码重启。
// 现在它来自 socialV2.context.wakeCheckPrompt，留空 = 不注入（和后端 wakeCheckLineV2 的语义一致）。
// 三件事必须成立：控件唯一、"填回内置默认"按钮真的写回内置文案、存值时原样提交（留空就是留空）。
{
  const n = (html.match(new RegExp('id="v2WakeCheckPrompt"', 'g')) ?? []).length;
  ok(n === 1, '三关正文控件 v2WakeCheckPrompt', `${n} 处`);
}
ok(/v2WakeCheckPrompt'\)\.value = ctx\.wakeCheckPrompt \?\? WAKE_CHECK_DEFAULT_PROMPT/.test(html),
  '三关正文从配置回填，老配置缺键时显示内置默认');
ok(/const WAKE_CHECK_DEFAULT_PROMPT = /.test(html) && /v2WakeCheckReset'\)\.addEventListener\('click'/.test(html),
  '有内置默认常量与「填回内置默认」按钮');
ok(/wakeCheckPrompt: document\.getElementById\('v2WakeCheckPrompt'\)\.value/.test(html),
  '三关正文进 saveV2Config 的 context body（留空即留空，不回填默认）');

console.log('## 收尾后观望');
// 收尾＝立刻潜水的旧行为有两个后果：聊到一半人没了、对方下一句不 @ 就不再被叫醒。
// 观望窗口是「不收尾的另一种写法」—— 会话已经交还，只是名单里多留一个人。
// 这格必须能从控制台调，且秒要换算成毫秒进 wake body，否则填了等于没填。
{
  const n = (html.match(new RegExp('id="v2PostReplyWatchMs"', 'g')) ?? []).length;
  ok(n === 1, '收尾后观望控件 v2PostReplyWatchMs', `${n} 处`);
}
ok(/v2PostReplyWatchMs'\)\.value = Math\.round\(\(w\.postReplyWatchMs \?\? 180000\) \/ 1000\)/.test(html),
  '收尾后观望从配置回填（毫秒转秒）');
ok(/postReplyWatchMs: Math\.max\(0, Math\.round\(Number\(document\.getElementById\('v2PostReplyWatchMs'\)\.value\) \|\| 0\)\) \* 1000/.test(html),
  '收尾后观望进 saveV2Config 的 wake body（秒转毫秒）');

console.log('## 按会话覆盖合并窗口');
// 那格「合并窗口」只是默认值，只对 confirmedBy=default 的会话生效；实测里几乎每个
// 会话都被 AI 自己设过，所以人想压短等待必须有一层覆盖。这里钉住它确实接上了。
for (const id of ['v2BatchOvKey', 'v2BatchOvMs', 'v2BatchOvSave', 'v2BatchOvClear', 'v2BatchOvStatus']) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length;
  ok(n === 1, `覆盖控件 ${id}`, `${n} 处`);
}
ok(/getElementById\('v2BatchOvSave'\)\.addEventListener/.test(html), '「设为此值」已绑定事件');
ok(/getElementById\('v2BatchOvClear'\)\.addEventListener/.test(html), '「取消覆盖」已绑定事件');
ok(/api\('\/api\/socialV2\/batch-window'/.test(html), '覆盖走 /api/socialV2/batch-window（不是 wake-config）');
// 下拉选项由实时状态那个轮询顺带刷新：模型新建出来的会话也得能选到。
ok(/v2BatchOvKey[\s\S]{0,400}list\.map/.test(html), '覆盖下拉随实时状态一起刷新');

console.log('## 轮询按页分流');
// 原来那个 3 秒定时器不分页面，无条件拉 5 个端点；refreshSlang 每次都把整张黑话表
// innerHTML 重画一遍 —— 人不在那一页时既白打接口，回来时的滚动位置还会被顶回去。
// 现在只有全局可见的两个照旧轮询，其余三个各归各页。
ok(/setInterval\(\(\) => \{\s*refresh\(\);\s*refreshPending\(\);/.test(html),
  '顶栏与导航角标的两个刷新仍无条件轮询');
ok(/currentConsolePage === 'slang'\) refreshSlang\(\)/.test(html), '黑话表只在自己那页轮询');
ok(/currentConsolePage === 'social-v1'\) refreshSocialStatus\(\)/.test(html), '一代仿真状态只在自己那页轮询');
ok(/page === 'slang'[\s\S]{0,40}refreshSlang\(\)/.test(html), '切到黑话页先补拉一次（否则首屏要等 3 秒）');
ok(/page === 'social-v1'[\s\S]{0,60}refreshSocialStatus\(\)/.test(html), '切到一代仿真页先补拉一次');

console.log('## fixture mock 覆盖');
const fixture = fs.readFileSync(path.join(ROOT, 'scripts', 'console-ui-fixture.mjs'), 'utf8');
ok(fixture.includes("case '/api/socialV2/voices'"), 'fixture mock 了 /api/socialV2/voices');
ok(fixture.includes("case '/api/voice/send'"), 'fixture mock 了 /api/voice/send');
ok(fixture.includes("case '/api/socialV2/batch-window'"), 'fixture mock 了 /api/socialV2/batch-window');

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);
