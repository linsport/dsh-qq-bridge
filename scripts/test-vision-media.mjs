// 视觉/图片链路自检脚本：
// 1. 校验视觉相关配置自洽（模型标识能在 DSH 目录里查到、思考强度是合法值）
// 2. 校验 safe-fetch 的 SSRF 防护（本机地址应被拒绝）
// 3. 若桥接运行中，校验 /api/images/message 端点可用（用二代 agent token）
// 运行：node scripts/test-vision-media.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeFetchBuffer } from '../src/safe-fetch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readJson(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

const config = readJson(path.join(ROOT, 'config.json'));
let passed = 0;
let failed = 0;

function check(name, cond, extra = '') {
  if (cond) {
    passed += 1;
    console.log(`✅ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    failed += 1;
    console.error(`❌ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// 1. 配置
//
// 这里原来写死了一份「多模态模型白名单」（deepseek-flash / deepseek-v4-flash-vision-exp），
// 并要求 reasoningEffort === 'max'。两条都会误报：
//   · DSH 的 session/modelCatalog 只公布 id / name / description / efforts，**不公布
//     inputModalities**（确认过 asar 里的 result schema）。「这个模型认不认图」是
//     DSH 内部 llm.resolveModelInfo 才知道的事，没有对应 RPC，桥接侧断言不了 ——
//     写死名单的结果就是 DSH 一换默认模型、或用户换个 provider，脚本就红。
//   · 思考强度的合法值随 provider 变（trae 全系只有 low/high/xhigh，没有 max），
//     'max' 只是本地白名单里的一档，不是通用要求。
//
// 现在换成断言「配置本身自洽」：留空 = 跟随 DSH（合法），填了就得是能对上的名字。
// 图片链路到底通不通，交给第 3 项的端点检查去验 —— 那才是真的打了一次图。
const { REASONING_EFFORT_OPTIONS } = await (async () => {
  // 从 src/bridge.js 里抽常量，避免这里再抄一份跟着漂移。
  const code = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');
  const m = /const REASONING_EFFORT_OPTIONS = \[([^\]]*)\]/.exec(code);
  return {
    REASONING_EFFORT_OPTIONS: m
      ? m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
      : ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
  };
})();

const cfgProvider = String(config.dsh?.provider ?? '').trim();
const cfgModel = String(config.dsh?.model ?? '').trim();
check('config.socialV2.tools.getImages 默认开启', config.socialV2?.tools?.getImages !== false);

const cfgEffort = String(config.dsh?.reasoningEffort ?? '').trim();
check(
  'config.dsh.reasoningEffort 留空或为合法档位',
  !cfgEffort || REASONING_EFFORT_OPTIONS.includes(cfgEffort),
  cfgEffort ? `当前 ${cfgEffort}（合法值：${REASONING_EFFORT_OPTIONS.join(' / ')}）` : '未设置，跟随默认',
);

// 2. safe-fetch SSRF
try {
  await safeFetchBuffer('http://127.0.0.1/');
  check('safe-fetch 拒绝本机地址', false, '未抛出异常');
} catch (error) {
  check('safe-fetch 拒绝本机地址', /内网|本机|禁止/.test(String(error?.message ?? error)), error?.message);
}

// 3. 桥接端点（可选）
const consoleTokenFile = path.join(ROOT, 'state', 'console-token');
const socialV2File = path.join(ROOT, 'state', 'social-v2.json');
if (fs.existsSync(consoleTokenFile) && fs.existsSync(socialV2File)) {
  try {
    const consoleToken = fs.readFileSync(consoleTokenFile, 'utf8').trim();
    const social = JSON.parse(fs.readFileSync(socialV2File, 'utf8'));
    const conv = social?.conversations ? Object.entries(social.conversations)[0] : null;
    if (conv) {
      const [key, st] = conv;
      const agentToken = st?.agentToken;
      const messageId = st?.recentMessages?.find((m) => m && !m.isSelf)?.messageId || st?.recentMessages?.[0]?.messageId;
      if (agentToken && messageId) {
        const url = `http://127.0.0.1:${config.consolePort || 3100}/api/images/message?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`;
        const res = await fetch(url, { headers: { 'x-agent-token': agentToken, 'x-console-token': consoleToken }, signal: AbortSignal.timeout(10000) });
        const body = await res.json().catch(() => ({}));
        check('桥接 /api/images/message 端点可访问', res.ok === true && body.ok === true, `HTTP ${res.status}`);

        // 模型标识自洽：留空=跟随 DSH 当前模型（合法），填了就必须能在 DSH 公布的目录里查到。
        // 名字写错一个字符的表现是整轮报错，不查一下很难自己发现。
        if (cfgProvider && cfgModel) {
          const modelRes = await fetch(`http://127.0.0.1:${config.consolePort || 3100}/api/dsh/model`, {
            headers: { 'x-console-token': consoleToken },
            signal: AbortSignal.timeout(10000),
          });
          const modelBody = await modelRes.json().catch(() => ({}));
          const groups = Array.isArray(modelBody?.catalog) ? modelBody.catalog : [];
          if (!groups.length) {
            console.log('⚠️ 跳过模型标识检查：DSH 没有公布模型目录');
          } else {
            const found = groups.some((g) => g?.id === cfgProvider && (g.models ?? []).some((m) => m?.id === cfgModel));
            check('config.dsh 的 provider/model 能在 DSH 目录里查到', found, `${cfgProvider} / ${cfgModel}`);
          }
        }
      } else {
        console.log('⚠️ 跳过桥接端点检查：没有可用 agentToken/messageId');
      }
    }
  } catch (error) {
    console.log(`⚠️ 桥接端点检查跳过：${error?.message ?? error}`);
  }
} else {
  console.log('⚠️ 跳过桥接端点检查：缺少 state/console-token 或 state/social-v2.json');
}

console.log(`\n结果：${passed} 通过，${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
