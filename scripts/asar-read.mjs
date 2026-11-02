// app.asar 只读访问 —— 给「对账 DSH 真实工具名」用。
//
// 为什么要自己读 asar：DSH 桌面版把整套 `@deepseek-ai/*`（300+ 个包，含全部
// `dsh-tool-*`）打进 `resources/app.asar`，普通 fs 看不见。而 profile 的
// `node_modules/@deepseek-ai/` 里只有 cosmokit / schemastery 这类间接依赖，
// 于是 `scripts/dsh-modules.mjs` 用模块解析反查到的目录**一个 DSH 包都没有**，
// 对账脚本扫出 0 个候选、再把守卫名单里的真名字全判成假名。
//
// asar 文件格式（Electron 官方，长期稳定）：
//   偏移 0   4 字节  UInt32LE = 4      （pickle 里第一个 payload 的长度）
//   偏移 4   4 字节  UInt32LE = headerSize + 4
//   偏移 8   4 字节  UInt32LE = headerSize
//   偏移 12  4 字节  UInt32LE = headerSize
//   偏移 16  headerSize 字节  JSON 目录（尾部可能补 \0）
//   之后          文件数据区，每个文件用 header 里的 { offset, size } 定位
// 目录节点：{ files: { name: node } }；文件节点：{ size, offset, unpacked? }。
// `unpacked: true` 的条目不在 asar 里，实际内容在 `<asar>.unpacked/<相对路径>`。
import fs from 'node:fs';
import path from 'node:path';

const PRELUDE_BYTES = 16;

/** 把绝对路径归一成 asar 内部用的 `/a/b/c` 形式。 */
function normalize(relPath) {
  const p = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  return p;
}

/**
 * 读 asar 头，返回 `{ archive, files }`。
 *
 * @param asarPath - app.asar 路径
 * @returns `{ archive, files, header }`，其中 `files` 是
 *          `Map<'/相对路径', { size, offset, unpacked }>`。
 *          路径不存在或格式不对时抛错（调用方决定要不要吞）。
 */
export function readAsarIndex(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prelude = Buffer.alloc(PRELUDE_BYTES);
    const got = fs.readSync(fd, prelude, 0, PRELUDE_BYTES, 0);
    if (got < PRELUDE_BYTES) throw new Error(`${asarPath} 太短，不是 asar 文件`);
    const headerSize = prelude.readUInt32LE(12);
    if (!headerSize || headerSize > 64 * 1024 * 1024) {
      throw new Error(`${asarPath} 头部长度异常（${headerSize}），不是 asar 文件`);
    }
    const headerBuf = Buffer.alloc(headerSize);
    if (fs.readSync(fd, headerBuf, 0, headerSize, PRELUDE_BYTES) < headerSize) {
      throw new Error(`${asarPath} 头部被截断`);
    }
    const header = JSON.parse(headerBuf.toString('utf8').replace(/\0+$/, ''));
    const dataStart = PRELUDE_BYTES + headerSize;

    const files = new Map();
    const walk = (node, prefix) => {
      if (!node || typeof node !== 'object') return;
      if (node.files && typeof node.files === 'object') {
        for (const name of Object.keys(node.files)) {
          walk(node.files[name], prefix ? `${prefix}/${name}` : name);
        }
        return;
      }
      if (typeof node.size === 'number' && typeof node.offset === 'string') {
        files.set(`/${prefix}`, {
          size: node.size,
          offset: Number(node.offset),
          unpacked: node.unpacked === true,
        });
      }
    };
    walk(header, '');
    return { fd, dataStart, files, header };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** 读完一个 asar 后必须调它释放句柄。 */
export function closeAsar(archive) {
  try { archive?.fd != null && fs.closeSync(archive.fd); } catch { /* 已关闭 */ }
}

/**
 * 读 asar 里一个文件的内容。`unpacked` 条目从 `<asar>.unpacked/` 读。
 * 读不到返回 `null`（调用方按「没读到」处理，不中断整轮扫描）。
 *
 * `archive` 接 {@link readAsarIndex} 的返回值本身（也兼容旧的 `.archive` 形态）。
 */
export function readAsarFile(asarPath, archive, entry, relPath) {
  if (!entry) return null;
  if (entry.unpacked) {
    try {
      return fs.readFileSync(path.join(`${asarPath}.unpacked`, normalize(relPath)), 'utf8');
    } catch { return null; }
  }
  const handle = archive?.fd != null ? archive : archive?.archive;
  if (handle?.fd == null) return null;
  const buf = Buffer.alloc(entry.size);
  try {
    fs.readSync(handle.fd, buf, 0, entry.size, handle.dataStart + entry.offset);
  } catch { return null; }
  return buf.toString('utf8');
}

/** 同上，但返回 Buffer（二进制文件用）。 */
export function readAsarBuffer(asarPath, archive, entry, relPath) {
  if (!entry) return null;
  if (entry.unpacked) {
    try { return fs.readFileSync(path.join(`${asarPath}.unpacked`, normalize(relPath))); } catch { return null; }
  }
  const handle = archive?.fd != null ? archive : archive?.archive;
  if (handle?.fd == null) return null;
  const buf = Buffer.alloc(entry.size);
  try {
    fs.readSync(handle.fd, buf, 0, entry.size, handle.dataStart + entry.offset);
  } catch { return null; }
  return buf;
}

/**
 * 判断一个 asar 是不是 DSH 的：目录里必须有 `dsh/node_modules/@deepseek-ai/`
 * 或 `node_modules/@deepseek-ai/`。
 *
 * 为什么必须验：`%ProgramFiles%` 下随便一个 Electron 应用（本机实测抓到过
 * `C:\Program Files\bilibili\resources\app.asar`）都有 `resources/app.asar`，
 * 只看文件名会把它们当成 DSH，然后扫出 0 个工具名、再把真名字全判成假名。
 */
export function looksLikeDshAsar(asarPath) {
  let archive;
  try { archive = readAsarIndex(asarPath); } catch { return false; }
  try {
    for (const rel of archive.files.keys()) {
      if (/^\/(dsh\/)?node_modules\/@deepseek-ai\/dsh-[^/]+\//.test(rel)) return true;
    }
    return false;
  } finally {
    closeAsar(archive);
  }
}

/**
 * 找 DSH 桌面版装在哪 —— 只用来定位 `resources/app.asar`。
 *
 * 候选顺序（先显式、后猜测；**每个候选都必须通过** {@link looksLikeDshAsar}）：
 *   ① 环境变量 `DSH_ASAR`（直接给 asar 文件路径）
 *   ② 环境变量 `DSH_INSTALL_ROOT`（给安装根目录，拼 `resources/app.asar`）
 *   ③ 当前进程是 Electron 主进程时用 `process.resourcesPath` / `execPath`
 *   ④ `%LOCALAPPDATA%\Programs\*\resources\app.asar`（默认 per-user 安装位）
 *   ⑤ `%ProgramFiles%` / `%ProgramFiles(x86)%` 下一层
 *   ⑥ **各固定盘根下两层**里名字像 DSH 的目录（`DeepSeek Harness` / `dshwork` /
 *      `programFiles` 这类）。不扫这一层的话，装到 D 盘之类的非默认位置就永远
 *      找不到 —— 本机实测正是这种情况，于是对账脚本一直报「一个都没抽到」。
 *
 * 显式给了却验不过时**抛错**（不静默换路径）；自动探测的候选验不过就跳过。
 * 全部落空返回 `null` —— 调用方据此给出「请设 DSH_ASAR」的可操作提示。
 */
export function findDshAsar() {
  const direct = process.env.DSH_ASAR;
  if (direct) {
    if (!fs.existsSync(direct)) throw new Error(`DSH_ASAR 指向的文件不存在：${direct}`);
    if (!looksLikeDshAsar(direct)) {
      throw new Error(`DSH_ASAR 指向的 asar 里没有 @deepseek-ai/dsh-* 包：${direct}\n  确认这是 DeepSeek Harness 的 resources/app.asar。`);
    }
    return direct;
  }

  for (const p of candidateAsarPaths()) {
    try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
    if (looksLikeDshAsar(p)) return p;
  }
  return null;
}

/** 安装位置候选（已去重）。抽成独立函数便于测试。 */
export function candidateAsarPaths() {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };

  const fromRoot = process.env.DSH_INSTALL_ROOT;
  if (fromRoot) push(path.join(fromRoot, 'resources', 'app.asar'));

  const runtimeResources = process.resourcesPath;
  if (runtimeResources && /(^|[\\/])resources$/.test(runtimeResources)) {
    push(path.join(runtimeResources, 'app.asar'));
  }
  // 在 DSH 自己的 shell 里跑时，execPath 是 Electron 可执行文件，旁边就有 resources/。
  try { push(path.join(path.dirname(process.execPath), 'resources', 'app.asar')); } catch { /* 忽略 */ }

  const bases = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
  ].filter(Boolean);
  for (const base of bases) {
    for (const name of safeReaddirNames(base)) {
      push(path.join(base, name, 'resources', 'app.asar'));
    }
  }

  // ⑥ 各盘安装位置。分两趟：
  //    先趟「名字像 DSH」的目录（比如装在一个带 harness / deepseek 字样的目录下，稳准快地命中），
  //    再趟全量一层 + 二层（装在一个叫 `apps` 或 `software` 的目录里时只能靠它兜底）。
  //    两趟都只 readdir 两层，且跳过 Windows 那几个必然又大又无关的目录。
  for (const drive of fixedDriveRoots()) {
    for (const name of safeReaddirNames(drive)) {
      if (SKIP_DIR_NAMES.has(name.toLowerCase())) continue;
      const dir = path.join(drive, name);
      if (INSTALL_DIR_HINT.test(name)) push(path.join(dir, 'resources', 'app.asar'));
      for (const sub of safeReaddirNames(dir)) {
        if (SKIP_DIR_NAMES.has(sub.toLowerCase())) continue;
        if (!INSTALL_DIR_HINT.test(sub)) continue;
        push(path.join(dir, sub, 'resources', 'app.asar'));
      }
    }
  }
  for (const drive of fixedDriveRoots()) {
    for (const name of safeReaddirNames(drive)) {
      if (SKIP_DIR_NAMES.has(name.toLowerCase())) continue;
      const dir = path.join(drive, name);
      push(path.join(dir, 'resources', 'app.asar'));
      for (const sub of safeReaddirNames(dir)) {
        push(path.join(dir, sub, 'resources', 'app.asar'));
      }
    }
  }
  return out;
}

/** 安装目录名里常见的字眼 —— 先趟这一趟，快且几乎不会误命中。 */
const INSTALL_DIR_HINT = /deepseek|harness|\bdsh\b/i;

/** 这些目录不必进（要么系统占位、要么必然无关，进去只是白读一堆文件名）。 */
const SKIP_DIR_NAMES = new Set([
  '$recycle.bin', 'system volume information', 'windows', 'windows.old',
  'node_modules', 'appdata', 'recovery', 'perflogs', 'config.msi', '$windows.~bt',
]);

function safeReaddirNames(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Windows 上的固定盘根；其它平台直接返回 `/`。 */
function fixedDriveRoots() {
  if (process.platform !== 'win32') return ['/'];
  const roots = [];
  for (let c = 'C'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c += 1) {
    const drive = `${String.fromCharCode(c)}:\\`;
    try { if (fs.statSync(drive).isDirectory()) roots.push(drive); } catch { /* 没有这个盘 */ }
  }
  return roots;
}
