#!/usr/bin/env node
// install-desktop-profile.mjs — 把 qq-bridge 的两个 bundle 与三个 MCP 装进
// 已有的 DSH profile（默认 desktop），**纯追加、不解析重写**已有配置。
//
// 为什么不用 scripts/setup-dsh.mjs：
//   它用 js-yaml 把 cordis.patch.yml 整个 load → 改 → dump。用户的 desktop patch
//   里带 `!!js process.platform === 'win32'` 这类自定义标签，js-yaml 直接抛
//   `unknown tag !<tag:yaml.org,2002:js>` 然后 fatal 退出。即便能解析，dump 回来
//   也会丢掉 32 行注释与自定义标签 —— 对一份 80KB 的用户配置，这个风险不值得冒。
//
// 本脚本只做三件加法：
//   ① ~/.dsh/plugins/<name> 与 <profile>/node_modules/<name> 两层 junction；
//   ② <profile>/package.json 里加 link: 依赖与 dsh.profile.bundles 条目；
//   ③ <profile>/cordis.patch.yml 末尾**文本追加**三个 MCP 条目（带起止标记便于重跑）。
//
// 用法：node scripts/install-desktop-profile.mjs [profile]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = process.argv[2] || 'desktop';

if (PROFILE === '.' || PROFILE === '..' || /[\\/\x00-\x1f<>:"|?*]/.test(PROFILE) || /[. ]$/.test(PROFILE)) {
  console.error(`[install] ERROR: invalid profile name: ${JSON.stringify(PROFILE)}`);
  process.exit(1);
}

const log = (msg) => console.log(`[install] ${msg}`);
const fail = (msg) => { console.error(`[install] ERROR: ${msg}`); process.exit(1); };

const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);
if (!fs.existsSync(PROFILE_DIR)) {
  fail(`profile 不存在：${PROFILE_DIR}（先确认 DSH 已经用这个 profile 启动过一次）`);
}

// ── ① 两层 junction ──────────────────────────────────────────────────────────
function ensureDirLink(linkPath, targetDir, label) {
  if (!fs.existsSync(targetDir)) fail(`${label} 源目录不存在：${targetDir}`);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let existing = null;
  try { existing = fs.lstatSync(linkPath); } catch (error) { if (error?.code !== 'ENOENT') fail(`inspect ${label}: ${error.message}`); }
  if (existing) {
    if (!existing.isSymbolicLink()) fail(`${label} 已存在且不是链接：${linkPath}（请手工移走后重跑）`);
    let same = false;
    try {
      const a = fs.realpathSync(linkPath).toLowerCase();
      const b = fs.realpathSync(targetDir).toLowerCase();
      same = a === b;
    } catch {}
    if (same) { log(`${label} 已指向本仓库，跳过`); return linkPath; }
    log(`${label} 指向别处，重建`);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(targetDir, linkPath, 'junction');
  log(`${label} 已创建：${linkPath}`);
  return linkPath;
}

// ── ② profile package.json ──────────────────────────────────────────────────
const BUNDLE_NAMES = ['qq-agent-presets', 'qq-mode-console'];

function linkBundles() {
  const links = {};
  for (const name of BUNDLE_NAMES) {
    const repoDir = path.join(REPO_ROOT, 'plugins', name);
    const installDir = ensureDirLink(path.join(DSH_HOME, 'plugins', name), repoDir, `bundle ${name} 安装位`);
    ensureDirLink(path.join(PROFILE_DIR, 'node_modules', name), installDir, `bundle ${name} 解析位`);
    links[name] = installDir;
  }
  return links;
}

/** 无注释、无自定义标签的最小 JSON 读改写。写前备份一次（不覆盖既有备份）。 */
function patchProfilePackage(links) {
  const pkgFile = path.join(PROFILE_DIR, 'package.json');
  const raw = fs.readFileSync(pkgFile, 'utf8');
  let pkg;
  try { pkg = JSON.parse(raw); } catch (error) { fail(`package.json 解析失败：${error.message}`); }

  pkg.dependencies = pkg.dependencies ?? {};
  pkg.dsh = pkg.dsh ?? {};
  pkg.dsh.profile = pkg.dsh.profile ?? {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  let changed = false;
  for (const [name, dir] of Object.entries(links)) {
    const linkVal = `link:${dir.replace(/\\/g, '/')}`;
    if (pkg.dependencies[name] !== linkVal) {
      pkg.dependencies[name] = linkVal;
      log(`package.json 依赖：${name} -> ${linkVal}`);
      changed = true;
    }
    if (!pkg.dsh.profile.bundles.includes(name)) {
      pkg.dsh.profile.bundles.push(name);
      log(`package.json bundle：+${name}`);
      changed = true;
    }
  }
  if (!changed) { log('package.json 已是最新'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(pkgFile, `${pkgFile}.bak-${stamp}`);
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`package.json 已更新（备份 .bak-${stamp}）`);
}

// ── ③ cordis.patch.yml 文本追加 MCP ─────────────────────────────────────────
const MCP_BEGIN = '# === qq-bridge MCP BEGIN（由 scripts/install-desktop-profile.mjs 维护，勿手改本块）===';
const MCP_END = '# === qq-bridge MCP END ===';

function yamlQ(s) { return `'${String(s).replace(/'/g, "''")}'`; }

function mcpBlock() {
  const node = process.execPath;
  const servers = [
    ['mcp-snowluma', 'snowluma', path.join(REPO_ROOT, 'src', 'mcp-snowluma-safe.js'), 725000],
    ['mcp-snowluma-host', 'snowluma-host', path.join(REPO_ROOT, 'src', 'mcp-host-server.js'), null],
    ['mcp-web-search-safe', 'web-search-safe', path.join(REPO_ROOT, 'src', 'mcp-web-search-safe.js'), null],
  ];
  let out = `${MCP_BEGIN}\n- insert:\n`;
  for (const [id, serverName, script, timeout] of servers) {
    out += `    - id: ${id}\n`;
    out += `      name: '@deepseek-ai/dsh-mcp-client'\n`;
    out += `      config:\n`;
    out += `        serverName: ${serverName}\n`;
    out += `        transport: stdio\n`;
    out += `        command: ${yamlQ(node)}\n`;
    out += `        args:\n          - ${yamlQ(script)}\n`;
    // qq_wait_for_messages 最长可等 10 分钟；DSH 默认 60s 会提前掐断。
    if (timeout) out += `        toolCallTimeoutMs: ${timeout}\n`;
  }
  return `${out}${MCP_END}\n`;
}

function patchCordisMcp() {
  const file = path.join(PROFILE_DIR, 'cordis.patch.yml');
  if (!fs.existsSync(file)) fail(`找不到 ${file}`);
  const original = fs.readFileSync(file, 'utf8');

  // 先摘掉上一次写的块（幂等重跑），再追加新的。
  let body = original;
  const beginAt = body.indexOf(MCP_BEGIN);
  if (beginAt >= 0) {
    const endAt = body.indexOf(MCP_END, beginAt);
    if (endAt < 0) fail('上一次写的 MCP 块只有开头没有结尾，已中止（请手工检查 cordis.patch.yml）');
    body = body.slice(0, beginAt) + body.slice(endAt + MCP_END.length).replace(/^\r?\n/, '');
    log('摘掉上一次的 MCP 块');
  }
  if (!body.endsWith('\n')) body += '\n';

  const next = `${body}${mcpBlock()}`;
  if (next === original) { log('cordis.patch.yml 已是最新'); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, `${file}.bak-${stamp}`);
  // 保持原有换行风格：原文件全 LF 就写 LF。
  const crlf = /\r\n/.test(original);
  const text = crlf ? next.replace(/\r?\n/g, '\r\n') : next;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  log(`cordis.patch.yml 已追加 MCP 块（备份 .bak-${stamp}）`);
}

patchProfilePackage(linkBundles());
patchCordisMcp();

log('完成。请完全退出并重启 DeepSeek Harness 桌面版，让 Electron 侧重新装载 profile。');
