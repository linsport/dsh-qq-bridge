// DSH 工具名清单扫描器：从**已安装的 DSH**（目录或 app.asar）里抽取真实注册的
// 工具名，与 QQ 守卫的 restrict 名单对账。
//
// 为什么要有这个脚本（而不是把清单抄死在注释里）
// ----------------------------------------------
// `tools.restrict({ deny: [name] })` 对**不存在的工具名会抛错**，而守卫是逐个
// try/catch 的 ⇒ 拼错/过期的名字 = 静默 no-op，安全边界无声地少一层。
// 反过来，DSH 每个版本都会新增工具，守卫漏掉新名字 = 该隐藏的能力留在
// 仿真会话的 schema 里。两类漂移都只能靠「拿安装包重新对账」发现。
//
// 数据来源（2026-11-01 修）
// ------------------------
// 之前只扫 `dshModulesDir()/@deepseek-ai`，而桌面版把整套 `@deepseek-ai/*`
// 打包在 `resources/app.asar` 里，profile 的 node_modules 下一个 DSH 包都没有
// ⇒ 扫描器输出「扫描包数：0」，再把所有真名字判成假名（或干脆全绿）。
// 现在 `collectDshToolNames()` 会自动回退到 app.asar，抽不到就抛错而不是返回空集。
// 桌面版装在非默认盘时用 `DSH_ASAR=<安装目录>/resources/app.asar` 显式指定。
//
// 抽取逻辑在 scripts/dsh-tool-names.mjs（唯一实现，测试与扫描器共用）；
// 本文件只是 CLI：打印、分类、给退出码。
//
// 本脚本是**只读**的：不改任何文件。
//
// 用法：
//   node scripts/scan-dsh-tool-names.mjs            # 对账并打印全部候选
//   node scripts/scan-dsh-tool-names.mjs --missing  # 只打印值得补进守卫的名字
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  collectDshToolNames, DANGER_TOOL_RE, SAFE_MODEL_TOOLS, TOOL_NAME_RE,
} from './dsh-tool-names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const onlyFlag = process.argv.includes('--missing');
const guarded = new Set();
let optional = new Set();
let allowed = new Set();

let names;
let packages;
let source;
try {
  ({ names, packages, source } = collectDshToolNames());
} catch (error) {
  console.error(`✗ ${error.message}`);
  process.exitCode = 1;
  process.exit();
}

const guardPath = path.join(ROOT, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
const guard = await import(pathToFileURL(guardPath).href);
for (const n of guard.RESTRICTED_TOOL_NAMES) guarded.add(n);
// 0.2.1 起 Codex / Claude Code 改为按需安装的可选插件：这组名字默认扫不到，
// 不能算「拼错假名」（装上组合包后它们就回来了）。
optional = new Set(guard.OPTIONAL_BUNDLE_TOOL_NAMES ?? []);
// 设计上**就该**不挡的名字（工具包存在但归各档自己开关，见守卫里的注释）。
allowed = new Set(guard.DESIGN_ALLOWED_TOOL_NAMES ?? []);

const sorted = [...names.keys()].sort();

console.log(`DSH 工具名来源：${source === 'asar' ? 'app.asar' : source === 'dir' ? '安装目录' : '(未知)'}`);
console.log(`扫描包数：${packages.length}；抽到工具名候选：${sorted.length}\n`);

/** ① 守卫名单里的名字必须真实存在，否则 restrict 抛错被吞、限制静默失效。 */
const devPrefixed = [...guarded].filter((n) => n.startsWith('dev_'));
const fabricated = [...guarded]
  .filter((n) => TOOL_NAME_RE.test(n)
    && !n.startsWith('dev_')
    && !optional.has(n)
    && !allowed.has(n)
    && !names.has(n));
console.log('=== ① 守卫名单里、但安装包里找不到的名字（restrict 会抛错并静默失效） ===');
console.log(fabricated.length ? fabricated.map((n) => `  ${n}`).join('\n') : '  (无)');
if (optional.size) {
  console.log(`  （不计入：${[...optional].join(', ')} —— 按需安装的可选组合包，装上才存在）`);
}
if (devPrefixed.length) {
  console.log(`  （不计入：${devPrefixed.length} 个 dev_* —— 运行时由注入器注册，安装包里本来就没有）`);
}

/** ② 安装包里有、守卫没覆盖的危险语义名字（可能是新版本新增的能力）。 */
const missing = sorted.filter((n) => DANGER_TOOL_RE.test(n) && !guarded.has(n) && !SAFE_MODEL_TOOLS.has(n) && !allowed.has(n));
console.log('\n=== ② 安装包里有、守卫名单里没有的「危险语义」名字（可能漏隐藏） ===');
console.log(missing.length ? missing.map((n) => `  ${n}  ← ${[...names.get(n)].join(', ')}`).join('\n') : '  (无)');

/** ③ 安装包里有、但**故意不挡**的名字 —— 打印出来，免得下次有人当成漏网。 */
const byDesign = sorted.filter((n) => !guarded.has(n) && (SAFE_MODEL_TOOLS.has(n) || allowed.has(n)));
if (byDesign.length) {
  console.log('\n=== ③ 安装包里有、按设计不挡的名字（各档自己管） ===');
  for (const n of byDesign) {
    const why = SAFE_MODEL_TOOLS.has(n) ? '模型侧无害工具（SAFE_MODEL_TOOLS）' : '守卫显式声明设计不挡（DESIGN_ALLOWED_TOOL_NAMES）';
    console.log(`  ${n}  ← ${[...names.get(n)].join(', ')}   [${why}]`);
  }
}

if (!onlyFlag) {
  console.log('\n=== ④ 全部候选名字（含来源包） ===');
  for (const n of sorted) {
    const mark = guarded.has(n) ? '[在名单]' : SAFE_MODEL_TOOLS.has(n) || allowed.has(n) ? '[按设计不挡]' : '[      ]';
    console.log(`  ${mark} ${n}  ← ${[...names.get(n)].join(', ')}`);
  }
}

console.log(`\n守卫名单 ${guarded.size} 个名字；其中悬空（假名）${fabricated.length} 个；候选里未覆盖的危险名 ${missing.length} 个。`);
process.exitCode = (fabricated.length === 0 && missing.length === 0) ? 0 : 1;
