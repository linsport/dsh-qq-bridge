// 网络出口解析：决定「从哪儿出去」，但**绝不**决定「能不能去」。
//
// 设计边界（改这个文件前先读这一段）：
// - 目标地址是否允许访问，只由 safe-fetch.js 的 resolveSafeAddresses 判定；
//   本文件不参与、也无法放宽那条判定。开了代理不等于能连内网。
// - 本文件只回答一个问题：这次请求走直连，还是走某个本地代理。
// - 代理地址只接受回环字面量（127.0.0.0/8、::1、localhost）。理由：一旦放开任意地址，
//   这个配置项就变成「内网探测通道」——用户以为在配代理，实际在配一个可被诱导的跳板。
//   非回环地址**直接抛错**，不静默降级直连（静默降级会让「以为走了代理」的流量裸奔出去）。
// - 只有当配置是 "auto"（即「你自己看着办」）时才会做代理/直连互补降级；
//   用户显式写了 URL 就只走那条路，失败就失败——不能替他绕过他自己指定的出口。

export class NetExitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NetExitError';
    this.code = code;
  }
}

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.localdomain']);
const DEFAULT_PORTS = { 'http:': 80, 'https:': 443, 'socks5:': 1080, 'socks5h:': 1080 };

/** 判断主机名是否是回环字面量（只认 127.0.0.0/8、::1、localhost）。 */
export function isLoopbackHost(hostname) {
  const raw = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (!raw) return false;
  if (LOOPBACK_NAMES.has(raw)) return true;
  if (raw === '::1') return true;
  const m = raw.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return [m[1], m[2], m[3]].every((part) => Number(part) <= 255);
}

/** 回环主机名归一成可连接的地址（localhost 统一落到 127.0.0.1）。 */
function normalizeLoopback(hostname) {
  const raw = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').trim();
  if (LOOPBACK_NAMES.has(raw)) return '127.0.0.1';
  return raw;
}

/**
 * 解析代理 URL。只接受 http: / socks5: / socks5h:。
 * @returns {{protocol: 'http'|'socks5', host: string, port: number, auth: {user: string, pass: string}|null, remoteResolve: boolean}}
 */
export function parseProxyUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new NetExitError('proxy-config', '代理地址格式无效');
  }
  const protocol = url.protocol;
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(protocol)) {
    throw new NetExitError('proxy-config', '只支持 http:// 与 socks5:// 代理');
  }
  // https:// 代理（代理自身走 TLS）与 socks5h（远端解析）都少见，这里明确拒绝，
  // 而不是「大概能用就试试」——试错的结果是请求超时后行为不可预期。
  if (protocol === 'https:') {
    throw new NetExitError('proxy-config', '暂不支持 https:// 代理，请改用 http:// 或 socks5://');
  }
  if (!url.hostname) throw new NetExitError('proxy-config', '代理地址缺少主机名');
  if (!isLoopbackHost(url.hostname)) {
    throw new NetExitError('proxy-config', '代理只允许本机回环地址（127.0.0.1 / ::1 / localhost）');
  }
  const portText = url.port || String(DEFAULT_PORTS[protocol] ?? '');
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new NetExitError('proxy-config', '代理端口无效');
  }
  const auth = url.username
    ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password || '') }
    : null;
  return {
    protocol: protocol === 'socks5h:' ? 'socks5' : protocol.replace(':', ''),
    host: normalizeLoopback(url.hostname),
    port,
    auth,
    remoteResolve: protocol === 'socks5h:',
  };
}

/**
 * NO_PROXY 匹配。支持：`*`（全部）、`example.com`（含子域）、`.example.com`、
 * `*.example.com`、`example.com:8080`（限定端口）。
 * @param {string} hostname 目标主机名
 * @param {number|string} port 目标端口
 * @param {string} noProxy 逗号分隔的 NO_PROXY 值
 */
export function matchesNoProxy(hostname, port, noProxy) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '').trim();
  if (!host) return false;
  const entries = String(noProxy ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!entries.length) return false;
  const portText = String(port ?? '');
  for (const entry of entries) {
    if (entry === '*') return true;
    let target = entry;
    let entryPort = '';
    // 只有 `host:port` / `[::1]:port` 形式才拆端口；裸 IPv6 不拆。
    if (!entry.startsWith('[')) {
      const idx = entry.lastIndexOf(':');
      if (idx > 0 && /^\d+$/.test(entry.slice(idx + 1))) {
        entryPort = entry.slice(idx + 1);
        target = entry.slice(0, idx);
      }
    }
    if (entryPort && entryPort !== portText) continue;
    target = target.replace(/^\*?\./, '').replace(/\.$/, '');
    if (!target) continue;
    if (host === target) return true;
    if (host.endsWith(`.${target}`)) return true;
  }
  return false;
}

function envValue(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * 按目标协议挑环境变量里的代理串。
 * 顺序：协议专属（HTTPS_PROXY / HTTP_PROXY）→ 通用（ALL_PROXY），大小写都读。
 */
function pickEnvProxy(env, protocol) {
  const specific = protocol === 'https:' ? ['HTTPS_PROXY', 'https_proxy'] : ['HTTP_PROXY', 'http_proxy'];
  return envValue(env, specific) || envValue(env, ['ALL_PROXY', 'all_proxy']);
}

/**
 * 解析本次请求的出口。
 *
 * @param {{protocol: string, hostname: string, port?: number|string}} target
 * @param {{proxy?: string, env?: object}} [options]
 *   proxy 取值：
 *     - "auto"（默认）：读 HTTPS_PROXY/ALL_PROXY，遵守 NO_PROXY，失败可互补降级
 *     - "off"：强制直连，连环境变量都不看
 *     - "http://127.0.0.1:7897" / "socks5://127.0.0.1:1080"：只走这一条
 * @returns {{kind: 'direct', reason: string} | {kind: 'proxy', protocol: string, host: string, port: number, auth: object|null, reason: string}}
 */
export function resolveExit(target, options = {}) {
  const settingRaw = options.proxy;
  const setting = typeof settingRaw === 'string' && settingRaw.trim() ? settingRaw.trim() : 'auto';
  const env = options.env ?? process.env;

  if (setting.toLowerCase() === 'off') {
    return { kind: 'direct', reason: 'off' };
  }
  if (setting.toLowerCase() !== 'auto') {
    return { kind: 'proxy', ...parseProxyUrl(setting), reason: 'explicit' };
  }

  const host = target?.hostname ?? '';
  const protocol = target?.protocol ?? 'https:';
  const port = target?.port || (protocol === 'https:' ? 443 : 80);
  const noProxy = envValue(env, ['NO_PROXY', 'no_proxy']);
  if (noProxy && matchesNoProxy(host, port, noProxy)) {
    return { kind: 'direct', reason: 'no_proxy' };
  }
  const raw = pickEnvProxy(env, protocol);
  if (!raw) return { kind: 'direct', reason: 'env-empty' };
  // 环境变量里的代理串**不是为这个功能设的**（可能是公司代理、别的工具写的）。
  // 它指向非回环地址时，本功能只支持回环，于是：忽略它、走直连。
  // 为什么这里不像显式配置那样抛错：抛错会让梗查询在公司网络下整功能不可用，
  // 而这个串本来就不是用户针对我们配的；忽略它也不会让流量去不该去的地方
  // （目标校验照旧，与出口无关）。显式写进 config 的串才必须抛错——那是明确意图，
  // 静默改直连等于欺骗。
  try {
    return { kind: 'proxy', ...parseProxyUrl(raw), reason: 'env' };
  } catch (error) {
    return { kind: 'direct', reason: `env-unusable:${error?.code ?? 'invalid'}` };
  }
}

function exitKey(exit) {
  return exit.kind === 'proxy' ? `proxy:${exit.protocol}:${exit.host}:${exit.port}` : 'direct';
}

/**
 * 返回本次请求要依次尝试的出口列表。
 *
 * 只有 "auto" 模式才会给出两条（主路径 + 互补路径），其余模式只有一条：
 * 用户显式指定的出口必须被尊重，不能在他没同意时把流量切到另一条路上。
 */
export function resolveExitCandidates(target, options = {}) {
  const settingRaw = options.proxy;
  const setting = typeof settingRaw === 'string' && settingRaw.trim() ? settingRaw.trim().toLowerCase() : 'auto';
  const primary = resolveExit(target, options);
  if (setting !== 'auto') return [primary];
  // 互补路径本身可能不可用（例如直连时环境里根本没有代理串，或串是坏的）。
  // 这种情况只保留主路径 —— 不能因为「想多试一条」而让整次请求抛错。
  let complement = null;
  if (primary.kind === 'proxy') {
    complement = { kind: 'direct', reason: 'complement' };
  } else {
    const raw = envValue(options.env ?? process.env, ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']);
    if (raw) {
      try {
        complement = { kind: 'proxy', ...parseProxyUrl(raw), reason: 'complement' };
      } catch {
        complement = null;
      }
    }
  }
  if (!complement || exitKey(complement) === exitKey(primary)) return [primary];
  return [primary, complement];
}

/** 供日志使用的出口描述（**只写本地日志，绝不进工具返回值**）。 */
export function describeExit(exit) {
  if (!exit || exit.kind === 'direct') return `direct(${exit?.reason ?? 'unknown'})`;
  return `${exit.protocol}://${exit.host}:${exit.port}(${exit.reason ?? 'unknown'})`;
}
