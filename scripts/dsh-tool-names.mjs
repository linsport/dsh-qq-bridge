// DSH 工具名抽取：**唯一实现**，供
//   · `scripts/scan-dsh-tool-names.mjs`（人工/升级时对账，打印清单）
//   · `scripts/test-preset-local-tools.mjs`（登记期断言，防拼错假名）
// 共同使用。
//
// 为什么要抽成模块：这两处过去各有一份实现，而测试那份是**模糊**的
// （`\bname:\s*['"]x['"]` 全文件乱扫 + 只认少数包名前缀 + 只读包根目录的
// cordis.patch.yml）。结果 0.2.0 对账时把 10 个**真实存在**的工具名误判成
// 「假名」——`dsh-mcp-resources` 与 `dsh-experimental-tool-agent-team` 不匹配它
// 的包名白名单，`subagent_codex` 写在 `dsh-web-app/presets/*.patch.yml` 而不是
// 包根。误判方向是危险的：它会逼人把真名字从守卫名单里删掉。
//
// 抽取规则（都要求**就近锚定**，不把 `systemPrompt.section({ name: 'tool:read' })`
// 这类非工具名当工具）：
//   ① `.register(defineTool({ … name: "X" … }))` —— DSH 所有工具包的注册形状
//   ② `toolName: "X"` / `toolName: z.string().default("X")` —— 配置化工具名
//      （dsh-tool-subagent 的 subagent / subagent_fork 就是这样声明的）
//   ③ YAML patch 里的 `toolName: X` 行（任意层级 *.patch.yml，含 presets/ 子目录）
import fs from 'node:fs';
import path from 'node:path';
import { dshModulesDir } from './dsh-modules.mjs';
import { readAsarIndex, readAsarFile, closeAsar, findDshAsar } from './asar-read.mjs';

/** 名字形态：小写字母开头，允许下划线与连字符，长度合理。 */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_-]{1,40}$/;

/** DSH 自带包所在目录（`<node_modules>/@deepseek-ai`）。 */
export function dshPackagesDir() {
  return process.env.DSH_TOOL_PACKAGES || path.join(dshModulesDir(), '@deepseek-ai');
}

/**
 * 目录里到底有几个 DSH 包。
 *
 * 为什么需要它：`dshModulesDir()` 走的是 Node 模块解析，解析得到的是
 * **profile 自己的 node_modules** —— 桌面版把整套 `@deepseek-ai/*` 打在
 * `resources/app.asar` 里，profile 目录下只剩 cosmokit / schemastery 这类间接
 * 依赖。于是 `dshPackagesDir()` 会成功返回一个**存在的空目录**，扫描器输出
 * 「扫描包数：0」而不报错，对账就此静默失效（2026-11-01 实测）。
 */
function countDshPackages(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('dsh-')) n++;
    }
  } catch { return 0; }
  return n;
}

/** 用户安装的第三方插件目录（也会注册工具：plugin-guard / 超级注入器等）。 */
export function dshPluginDirs() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.dsh') : null);
  return [home ? path.join(home, 'plugins') : null].filter((p) => p && fs.existsSync(p));
}

function walkFiles(dir, out = [], depth = 0, maxDepth = 5) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < maxDepth) walkFiles(full, out, depth + 1, maxDepth); }
    else out.push(full);
  }
  return out;
}

/** 从一个 JS/TS 源文件里抽取工具名。 */
function extractFromSource(text, source, add) {
  for (const m of text.matchAll(/\.register\(\s*defineTool\(\{[\s\S]{0,400}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
  for (const m of text.matchAll(/\btoolName:\s*["']([^"']+)["']/g)) add(m[1], source);
  for (const m of text.matchAll(/\btoolName:\s*[^;\n]*?\.default\(\s*["']([^"']+)["']/g)) add(m[1], source);
  // 独立的一次性工具文件（defineTool 不挂在 .register( 上时的兜底）
  for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,200}?\bname:\s*["']([^"']+)["']/g)) {
    add(m[1], source);
  }
}

/** 从 YAML patch 里抽取配置化的工具名。 */
function extractFromPatch(text, source, add) {
  for (const m of text.matchAll(/^\s*(?:-\s*)?toolName:\s*([^\s#]+)\s*$/gm)) {
    add(m[1].replace(/^['"]|['"]$/g, ''), source);
  }
}

/**
 * 从 app.asar 里抽工具名（桌面版 DSH 的唯一真实来源）。
 *
 * 只扫 `@deepseek-ai/*` 下的 `.js/.mjs/.cjs/.ts/.d.ts` 与 `*.patch.ya?ml`，
 * 包名取 `dsh/node_modules/@deepseek-ai/<包名>/` 那一段，其余（`renderer/`、
 * `lib/` 等应用自身代码）不扫 —— 那些不是工具包，扫进来只会制造噪声。
 *
 * @returns `{ names: Map<name, Set<source>>, packages: string[] }`；
 *          asar 读不了时返回 `null`（调用方据此决定是否降级/报错）。
 */
function collectFromAsar(asarPath) {
  let archive;
  try { archive = readAsarIndex(asarPath); } catch { return null; }
  const names = new Map();
  const packages = new Set();
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };
  try {
    for (const [rel, entry] of archive.files) {
      const m = /^\/dsh\/node_modules\/@deepseek-ai\/([^/]+)\//.exec(rel);
      if (!m) continue;
      const pkg = m[1];
      const isSource = /\.(js|mjs|cjs|ts)$/.test(rel) || rel.endsWith('.d.ts');
      const isPatch = /\.patch\.ya?ml$/.test(rel);
      if (!isSource && !isPatch) continue;
      packages.add(pkg);
      const text = readAsarFile(asarPath, archive, entry, rel);
      if (!text) continue;
      if (isPatch) extractFromPatch(text, pkg, add);
      else extractFromSource(text, pkg, add);
    }
  } finally {
    closeAsar(archive);
  }
  return { names, packages: [...packages].sort() };
}

/**
 * 抽取已安装 DSH（及其插件）里出现的全部工具名。
 *
 * DSH 包来源按「先真后兜底」：
 *   ① `options.packagesDir` / `DSH_TOOL_PACKAGES`（显式指定，最高优先级）
 *   ② `dshModulesDir()/@deepseek-ai` 里**确实有 dsh-* 包**时用目录
 *   ③ 否则读 `app.asar`（桌面版；路径由 `findDshAsar()` 找）
 *   ④ 都没有 ⇒ 抛错并给出可操作指引
 * 之所以不再默默返回空集：空集会被上层当成「所有名字都是假名」，方向性的错。
 *
 * @param options.packagesDir - `@deepseek-ai` 目录；缺省按 {@link dshPackagesDir} 解析。
 * @param options.pluginDirs - 第三方插件目录列表；缺省按 {@link dshPluginDirs} 解析。
 * @param options.asarPath - 显式指定 app.asar；缺省由 `findDshAsar()` 探测。
 * @param options.allowEmpty - 允许在「一个 DSH 包都没扫到」时返回空集而不抛错
 *        （给只能离线跑的场景留口子；默认 false）。
 * @returns `{ names: Map<name, Set<source>>, packages: string[], source: 'dir'|'asar'|'empty' }`。
 *          `packages` 是实际扫过的包/插件名，便于诊断「一个都没扫到」。
 */
export function collectDshToolNames({ packagesDir, pluginDirs, asarPath, allowEmpty = false } = {}) {
  const names = new Map();
  const packages = [];
  const add = (name, source) => {
    if (!TOOL_NAME_RE.test(name)) return;
    if (!names.has(name)) names.set(name, new Set());
    names.get(name).add(source);
  };

  let source = 'empty';
  const explicitDir = packagesDir ?? process.env.DSH_TOOL_PACKAGES ?? null;
  if (explicitDir) {
    // 显式指定的目录：存在就扫，不存在就说清楚，不偷偷换来源。
    if (!fs.existsSync(explicitDir)) {
      throw new Error(
        `指定的 DSH 工具包目录不存在：${explicitDir}\n`
        + '  检查 DSH_TOOL_PACKAGES / DSH_INSTALL_MODULES 是否指错。'
      );
    }
    source = 'dir';
  } else {
    let dir = null;
    try { dir = dshPackagesDir(); } catch { dir = null; }
    if (dir && countDshPackages(dir) > 0) {
      packagesDir = dir;
      source = 'dir';
    } else {
      // 桌面版：走 asar。
      const found = asarPath ?? findDshAsar();
      if (found) {
        const fromAsar = collectFromAsar(found);
        if (fromAsar && fromAsar.names.size > 0) {
          source = 'asar';
          packages.push(...fromAsar.packages);
          for (const [name, srcs] of fromAsar.names) {
            for (const s of srcs) add(name, s);
          }
        }
      }
    }
  }

  if (source === 'dir') {
    const pkgRoot = packagesDir;
    if (fs.existsSync(pkgRoot)) {
      let entries = [];
      try { entries = fs.readdirSync(pkgRoot, { withFileTypes: true }); } catch { entries = []; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (!/^dsh-/.test(e.name)) continue;
        const pkgDir = path.join(pkgRoot, e.name);
        packages.push(e.name);
        for (const f of walkFiles(pkgDir)) {
          let text = '';
          try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
          if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) extractFromSource(text, e.name, add);
          else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, e.name, add);
        }
      }
    }
  }

  for (const dir of pluginDirs ?? dshPluginDirs()) {
    // 用户的插件目录里全是插件包（含 .bak-* 备份，也一起扫：备份里的旧名字
    // 仍然说明这个名字曾经真实存在）。
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pkgDir = path.join(dir, e.name);
      packages.push(e.name);
      for (const f of walkFiles(pkgDir)) {
        let text = '';
        try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
        if (/\.(js|mjs|cjs)$/.test(f) || f.endsWith('.d.ts')) extractFromSource(text, e.name, add);
        else if (/\.patch\.ya?ml$/.test(f)) extractFromPatch(text, e.name, add);
      }
    }
  }

  if (names.size === 0) {
    if (!allowEmpty) {
      throw new Error(
        '一个 DSH 工具名都没抽到 —— 对账无法进行。\n'
        + '  桌面版请设 DSH_ASAR=<安装目录>/resources/app.asar（本机装在非默认盘时必须显式给）；\n'
        + '  命令行版请设 DSH_INSTALL_MODULES=<DSH 安装目录>/node_modules，\n'
        + '  或 DSH_TOOL_PACKAGES=<...>/node_modules/@deepseek-ai。'
      );
    }
    source = 'empty';
  }
  return { names, packages, source };
}

/** 便利包装：只要名字集合。 */
export function dshToolNameSet(options) {
  return new Set(collectDshToolNames(options).names.keys());
}

/**
 * 「危险语义」判定：与本地执行 / 文件 / 进程 / 派生 agent / 宿主运行期相关的名字。
 * 守卫**必须**覆盖它们。纯模型侧无害工具由 {@link SAFE_MODEL_TOOLS} 显式排除。
 *
 * 这是**发现用**的启发式（宁可多报，人工再判），不是安全边界本身；
 * 边界是守卫的 restrict 名单 + 执行期白名单。
 */
export const DANGER_TOOL_RE = /(pwsh|bash|shell|exec|spawn|process|terminal|pty|read|write|edit|file|fs_|glob|grep|patch|str_replace|subagent|agent_|teammate|workflow|ralph|job|skill|present|goal|plan|todo|memory|snapshot|rollback|incident|plugin|cordis|dsh_|dev_|import|install|reload|inject|stage|config|workspace|session|export|office|slash|command|schedule|voice|speech|team|mcp_resource)/;

/** 明确无害、允许出现在仿真会话 schema 里的模型侧工具。 */
export const SAFE_MODEL_TOOLS = new Set(['ask_user_question', 'todo_write']);
