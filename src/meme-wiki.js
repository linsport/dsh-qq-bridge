// 梗百科（cnmeme.wiki）只读查询。
//
// 这个文件承担两件事：
// 1. 按 cnmeme 公开 API（/api/v1/public/memes）取数据并格式化成纯文本；
// 2. 在「多 IP + 可选代理」的真实网络环境里把请求打出去。
//
// 第 2 点是踩出来的：cnmeme.wiki 挂在 Cloudflare 后面，A 记录里常有一个 IPv4 是坏的
// （实测 172.67.158.85 正常、104.21.82.138 直连必 ECONNRESET），而 node 按域名连接时
// 落到哪个地址是随机的 —— 表现就是「这个站时好时坏」。所以这里自己解析、自己排顺序、
// 失败换下一个地址。
//
// 安全约束（顺序写死，不许调换）：
//   ① 校验目标（公网？）—— resolveSafeAddresses，fail-closed
//   ② 决定出口（代理？直连？）—— net-exit
//   ③ 发请求
// 代理只影响②，永远进不了①。
//
// 错误一律**错误码化**：工具返回值会进模型上下文，而群聊人格明确禁止暴露本机地址/
// 端口/路径。所以对外的错误只能说「网络出口暂时不可用」这类话，真实原因只进本地日志。
import http from 'node:http';
import https from 'node:https';
import { validateFetchUrl, isPrivateIp } from './safe-fetch.js';
import { resolveExitCandidates, describeExit } from './net-exit.js';
import { openTunnel, startTls } from './proxy-tunnel.js';

const API_BASE = 'https://cnmeme.wiki/api/v1/public/memes';
const DEFAULT_TIMEOUT_MS = 12000;
const ATTEMPT_TIMEOUT_MS = 7000;
const MAX_ATTEMPTS = 6;

/** 对外错误文案：只有这几句能进模型上下文。 */
const ERROR_TEXT = {
  'target-private': '目标地址不允许访问',
  'target-invalid': '链接无效',
  'dns-failed': '域名解析失败',
  'exit-unreachable': '网络出口暂时不可用',
  'exit-timeout': '网络有点慢，稍后再试',
  'target-reset': '目标站拒绝连接',
  'not-found': '没有找到这个词条',
  'bad-response': '返回内容异常',
  'too-large': '返回内容过大，已停止',
  'rate-limited': '请求太频繁，稍后再试',
  'upstream-error': '对方服务暂时不可用',
  'config': '功能配置有误',
};

export class MemeError extends Error {
  constructor(code, detail) {
    super(ERROR_TEXT[code] ?? '查询失败');
    this.name = 'MemeError';
    this.code = code;
    this.detail = detail ?? '';
  }
}

/** 把底层错误归一成错误码。detail 只用于日志，绝不返回给调用方。 */
function classify(error) {
  if (error instanceof MemeError) return error;
  const raw = String(error?.code ?? '') + ' ' + String(error?.message ?? '');
  if (/禁止访问内网|内网\/本机|解析到内网|localhost|\.local/i.test(raw)) return new MemeError('target-private', raw);
  if (/proxy-config|代理只允许|代理地址/.test(raw)) return new MemeError('config', raw);
  if (/ENOTFOUND|EAI_AGAIN|域名解析失败|EDNS/.test(raw)) return new MemeError('dns-failed', raw);
  if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|proxy-connect-timeout|exit-unreachable/i.test(raw)) {
    return new MemeError('exit-unreachable', raw);
  }
  if (/timeout|ETIMEDOUT|超时/i.test(raw)) return new MemeError('exit-timeout', raw);
  if (/ECONNRESET|EPIPE|socket hang up|proxy-closed|proxy-handshake/i.test(raw)) {
    return new MemeError('target-reset', raw);
  }
  if (/certificate|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(raw)) return new MemeError('target-reset', raw);
  return new MemeError('bad-response', raw);
}

function normalizeIp(address) {
  return String(address ?? '').replace(/^\[|\]$/g, '').trim();
}

/**
 * 用**一个**出口 + **一个**已校验 IP 发一次 GET，读完整个响应体。
 * @returns {Promise<{statusCode: number, headers: object, body: string}>}
 */
function attemptWithExit(url, address, exit, maxBytes, budgetMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let socket;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fn === reject) {
        try { req?.destroy(); } catch {}
        try { socket?.destroy(); } catch {}
      }
      fn(arg);
    };
    const timer = setTimeout(() => {
      const error = new Error('request-timeout');
      error.code = 'ETIMEDOUT';
      finish(reject, error);
    }, budgetMs);

    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const hostname = normalizeIp(url.hostname);
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;

    const start = async () => {
      const options = {
        port,
        path: url.pathname + url.search,
        method: 'GET',
        headers: {
          host: url.host,
          accept: 'application/json',
          'accept-language': 'zh-CN,zh;q=0.9',
          'user-agent': 'qq-bridge/0.2.2 (+https://github.com/linsport/dsh-qq-bridge)',
        },
      };

      if (exit.kind === 'proxy') {
        socket = await openTunnel(exit, address, port, { timeoutMs: budgetMs });
        if (isHttps) {
          socket = await startTls(socket, hostname, { timeoutMs: budgetMs });
        }
        options.createConnection = () => socket;
        // 走隧道时不再让 node 解析/连接：连接已由隧道给出。
        delete options.port;
      } else {
        options.host = address;
        options.servername = isHttps && !address.includes(':') ? hostname : undefined;
        options.rejectUnauthorized = isHttps;
      }

      req = mod.request(options, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            const error = new Error('response-too-large');
            error.code = 'ETOOLARGE';
            finish(reject, error);
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          finish(resolve, {
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (error) => finish(reject, error));
      });
      req.on('error', (error) => finish(reject, error));
      req.end();
    };

    start().catch((error) => finish(reject, error));
  });
}

/**
 * 依次尝试「出口 × 地址」，任一次成功即返回。
 *
 * 顺序：先在主出口下把地址挨个试完，再换互补出口。
 * 为什么不是「每个地址都把两种出口试一遍」：代理和直连切换的成本远高于换 IP，
 * 先把同一出口的地址榨干更划算。
 */
async function requestJson(urlString, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 512 * 1024;
  const log = typeof options.log === 'function' ? options.log : () => {};

  // ① 目标校验（永远先做）
  let validated;
  try {
    validated = await validateFetchUrl(urlString);
  } catch (error) {
    throw classify(error);
  }
  const { url, addresses } = validated;
  const usable = (addresses || []).map(normalizeIp).filter((ip) => ip && !isPrivateIp(ip));
  if (!usable.length) throw new MemeError('target-private', 'no public address');

  // ② 出口选择
  let exits;
  try {
    exits = resolveExitCandidates({ protocol: url.protocol, hostname: url.hostname, port: url.port }, {
      proxy: options.proxy,
      env: options.env,
    });
  } catch (error) {
    throw classify(error);
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let attempts = 0;
  for (const exit of exits) {
    for (const address of usable) {
      if (attempts >= MAX_ATTEMPTS) break;
      const remaining = deadline - Date.now();
      if (remaining <= 300) break;
      attempts += 1;
      const budget = Math.min(ATTEMPT_TIMEOUT_MS, remaining);
      try {
        const result = await attemptWithExit(url, address, exit, maxBytes, budget);
        log(`meme-wiki ok exit=${describeExit(exit)} addr=${address} status=${result.statusCode} bytes=${result.body.length}`);
        return result;
      } catch (error) {
        lastError = error;
        log(`meme-wiki fail exit=${describeExit(exit)} addr=${address} err=${error?.code ?? ''} ${error?.message ?? ''}`);
      }
    }
  }
  throw classify(lastError ?? new MemeError('bad-response', 'no attempt'));
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

function parseJsonBody(result) {
  const status = Number(result.statusCode) || 0;
  if (status === 404) throw new MemeError('not-found', 'http 404');
  if (status === 429) throw new MemeError('rate-limited', 'http 429');
  if (status === 422) throw new MemeError('bad-response', 'http 422');
  if (status >= 500) throw new MemeError('upstream-error', `http ${status}`);
  if (status < 200 || status >= 300) throw new MemeError('bad-response', `http ${status}`);
  try {
    return JSON.parse(result.body);
  } catch {
    throw new MemeError('bad-response', 'json parse failed');
  }
}

/**
 * 搜索词条。
 * @returns {Promise<{items: object[], hasMore: boolean}>}
 */
export async function searchMemes(keyword, options = {}) {
  const q = String(keyword ?? '').trim();
  if (!q) throw new MemeError('target-invalid', 'empty query');
  if (Array.from(q).length > 80) throw new MemeError('target-invalid', 'query too long');
  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 30);
  const url = `${API_BASE}${buildQuery({ q, limit })}`;
  const result = await requestJson(url, options);
  const data = parseJsonBody(result);
  const items = Array.isArray(data?.items) ? data.items : [];
  return { items, hasMore: data?.has_more === true };
}

/** 取单个词条详情（含 content_html）。 */
export async function getMeme(slug, options = {}) {
  const key = String(slug ?? '').trim();
  if (!key) throw new MemeError('target-invalid', 'empty slug');
  const url = `${API_BASE}/${encodeURIComponent(key)}`;
  const result = await requestJson(url, options);
  const data = parseJsonBody(result);
  const item = data?.item;
  if (!item || typeof item !== 'object') throw new MemeError('not-found', 'missing item');
  return item;
}

/** 服务端已做标签白名单，这里只把标签剥掉换成纯文本。 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function formatDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function truncate(text, maxChars) {
  const chars = Array.from(String(text ?? ''));
  if (chars.length <= maxChars) return { text: chars.join(''), truncated: false };
  return { text: chars.slice(0, maxChars).join(''), truncated: true };
}

/**
 * 把详情格式化成给模型读的纯文本。
 *
 * 刻意不输出 JSON：JSON 的括号、引号、字段名在 token 上很贵，而这些内容最终是要读给
 * 群友听的一段话，不是要程序解析的数据。
 */
export function formatMeme(item, options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 2000;
  const lines = [];
  const title = String(item?.title ?? item?.slug ?? '').trim() || '（无标题）';
  lines.push(`【梗百科 · ${title}】`);
  const tags = Array.isArray(item?.tags) ? item.tags.filter(Boolean) : [];
  if (tags.length) lines.push(`标签：${tags.join(' / ')}`);
  const updated = formatDate(item?.updated_at);
  if (updated) lines.push(`更新：${updated}`);
  const video = item?.source_video;
  if (video && (video.bvid || video.title)) {
    const pieces = [];
    if (video.bvid) pieces.push(video.bvid);
    if (video.title) pieces.push(`《${video.title}》`);
    if (video.creator_name) pieces.push(`— ${video.creator_name}`);
    const published = formatDate(video.published_at);
    if (published) pieces.push(published);
    lines.push(`出处：${pieces.join(' ')}`);
  }
  const summary = String(item?.summary ?? '').trim();
  if (summary) lines.push(`简介：${summary}`);
  const body = htmlToText(item?.content_html);
  if (body) {
    lines.push('');
    const clipped = truncate(body, maxChars);
    lines.push(clipped.text);
    if (clipped.truncated) lines.push(`（正文已截断到 ${maxChars} 字，需要更多就查更具体的词）`);
  }
  return lines.join('\n');
}

/** 搜索结果的候选列表（不含正文）。 */
export function formatCandidates(items, options = {}) {
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 80;
  if (!Array.isArray(items) || !items.length) return '（没搜到相关词条）';
  const lines = [`搜到 ${items.length} 条：`];
  for (const item of items) {
    const title = String(item?.title ?? item?.slug ?? '').trim() || '（无标题）';
    const summary = String(item?.summary ?? '').replace(/\s+/g, ' ').trim();
    const clipped = summary ? `：${truncate(summary, maxChars).text}` : '';
    lines.push(`· ${title}${clipped}`);
  }
  lines.push('要某个词条的完整内容，用 mode="detail" 加上它的名字。');
  return lines.join('\n');
}

/**
 * 一站式查询：先搜，命中精确 slug 就直接取详情。
 * @param {string} keyword
 * @param {{mode?: 'auto'|'search'|'detail', slug?: string} & object} options
 */
export async function lookupMeme(keyword, options = {}) {
  const mode = options.mode === 'search' || options.mode === 'detail' ? options.mode : 'auto';
  const key = String(keyword ?? '').trim();
  const slug = String(options.slug ?? '').trim();

  if (mode === 'detail') {
    const item = await getMeme(slug || key, options);
    return { mode: 'detail', text: formatMeme(item, options), item };
  }
  // auto 模式要多拉一些：词条按 updated_at 倒序，热门词的精确条目常常排在十几位之后
  // （实测搜「哈基米」时前 10 条全是相关梗，「哈基米」本体不在里面）。
  const { items, hasMore } = await searchMemes(key, { ...options, limit: options.limit ?? 30 });
  if (mode === 'search') {
    return { mode: 'search', text: formatCandidates(items, options), items, hasMore };
  }
  const target = slug || key;
  const exact = items.find((item) => String(item?.slug ?? '').trim() === target)
    ?? (items.length === 1 ? items[0] : null);
  if (exact?.slug) {
    const item = await getMeme(exact.slug, options);
    return { mode: 'detail', text: formatMeme(item, options), item };
  }
  return { mode: 'search', text: formatCandidates(items, options), items, hasMore };
}
