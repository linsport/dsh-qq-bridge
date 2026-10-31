// DSH Web 端口自动发现。
//
// 背景：`dsh web` 每次启动可能换端口（默认 3080 被占用时会漂），而 config.json 里的
// dsh.baseUrl 是写死的。写死的端口一旦漂走，桥接就会连一个没人监听的地址，表现为
// 「消息进来了但 AI 永远不回」—— 且日志里只看到 ECONNREFUSED，很难一眼看出是端口问题。
//
// 策略分两步，先便宜后贵：
//   1. probeDsh(baseUrl)：对配置里的地址发一次 HTTP，确认是不是活的 DSH Web；
//   2. scanDshPorts()：只有第 1 步失败时才扫本机回环端口。
//
// 为什么不用 netstat / lsof 枚举监听端口：那要靠 execFile 起子进程，而本机历史环境里
// 沙箱会以 EPERM 拒绝子进程开管道（`spawnSync node.exe EPERM`），等于在需要它的时候
// 正好不可用。纯 node:net 连一连虽然慢一点（实测扫全端口约 3.7 秒），但不依赖任何外部命令。
//
// 只认回环地址：DSH Web 带鉴权、且桥接用本机 token 免密登录，扫到局域网别的机器没有意义。

import http from 'node:http';
import net from 'node:net';

/** 只有这些主机的扫描结果会被采纳（与 dsh-client 的 isLoopbackBase 判定一致）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** DSH Web 未带凭据时返回的正文指纹。命中它才算「这是 DSH」，而不是别的什么服务。 */
const DSH_401_FINGERPRINT = 'dsh web authentication required';

/** 单个端口 TCP 握手的超时。本机回环上要么立刻通要么立刻 RST，250ms 已经非常宽松。 */
const CONNECT_TIMEOUT_MS = 250;

/** 并发窗口。太大会把文件描述符和半开连接堆起来，太小则扫描时间线性膨胀。 */
const SCAN_BATCH = 500;

/**
 * 401 正文最多读这么多字符。
 * 指纹 "dsh web authentication required" 就十几个字符，8K 足够覆盖任何合理的鉴权页；
 * 设上限是为了别让某个返回巨量 HTML 的服务把内存吃掉。
 */
const BODY_LIMIT_CHARS = 8192;

export function parseBaseUrl(baseUrl) {
  try {
    const url = new URL(String(baseUrl ?? ''));
    return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80), protocol: url.protocol };
  } catch {
    return null;
  }
}

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? '').toLowerCase());
}

/**
 * 对一个 host:port 发 GET /，判断它是不是 DSH Web。
 *
 * 判据刻意严到只认「HTTP 401 + 正文含 DSH 鉴权提示」，宁可漏也不误命中。这是实测教训：
 * 本机同时跑着控制台、Ollama(11434)、返回 JWT 的网关(9210/9211)、普通网页(5099)、
 * 还有直接吐二进制流的服务(4310/4312) —— 它们对 `GET /` 全都回 200。只要把 200/3xx
 * 也算命中，扫描就会返回一堆假 DSH，比「没扫到」更糟：错误地切到一个陌生服务上，
 * 桥接会以另一套鉴权协议去打它，报出来的错跟端口无关，排查时会往完全错的方向走。
 *
 * 代价是「免鉴权部署的 DSH 扫不到」。真出现这种情况，用户填对 config.json 即可
 * （probeDsh 对非回环地址只要求 TCP 通，不会被这条严格判据挡住）。
 */
export function probePort(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      { host, port, path: '/', method: 'GET', timeout: timeoutMs, headers: { accept: 'text/plain,text/html' } },
      (res) => {
        if ((res.statusCode ?? 0) !== 401) {
          res.resume();
          done(false);
          return;
        }
        // 401 还要看正文，避免把「随便哪个要密码的服务」当成 DSH。
        // 上限用 slice 而不是「到 4096 就不再加」：后者在后半句才出现指纹时会漏判，
        // 而且单个 chunk 就能一次冲破上限，那个 if 本来就挡不住。
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < BODY_LIMIT_CHARS) body = (body + chunk).slice(0, BODY_LIMIT_CHARS);
        });
        res.on('end', () => done(body.toLowerCase().includes(DSH_401_FINGERPRINT)));
        res.on('error', () => done(false));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}

/**
 * 配置里的 baseUrl 还活着吗？
 *
 * 非回环地址不做指纹校验（可能是用户自建的反代，形态不确定），只要求 TCP 能连上；
 * 扫描那一步才需要严格指纹。这样 remote 部署也不会被误判成「端口漂了」。
 */
export async function probeDsh(baseUrl, timeoutMs = 1500) {
  const parsed = parseBaseUrl(baseUrl);
  if (!parsed) return false;
  if (isLoopbackHost(parsed.host)) return probePort(parsed.host, parsed.port, timeoutMs);
  return canConnect(parsed.host, parsed.port, timeoutMs);
}

/** 纯 TCP 握手，不发 HTTP。用于快速筛掉绝大多数死端口。 */
export function canConnect(host, port, timeoutMs = CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/**
 * 扫本机回环端口找 DSH Web，返回命中端口的 baseUrl 列表（按端口升序）。
 *
 * 两遍走：先 TCP 握手把活的端口挑出来，再只对活端口发 HTTP 验指纹。
 * 全端口逐个发 HTTP 会慢一个数量级，而握手的失败是立刻 RST，几乎不花时间。
 *
 * 第二遍必须**并行**。实测慢点全在这里：本机活端口里有几个是「TCP 通但不回 HTTP」的
 * （49664~49680 那一段 RPC 端口就是），串行逐个等超时的话，40 个活端口能拖到 9.4 秒；
 * 并行之后整轮扫描稳定在 3 秒上下。
 *
 * 端口上限必须是 65535：65536 会抛 ERR_SOCKET_BAD_PORT，整个扫描直接报废。
 */
export async function scanDshPorts({ host = '127.0.0.1', from = 1024, to = 65535, batch = SCAN_BATCH } = {}) {
  // 注意别写 Number(to) || 65535 —— to=0 会被 || 吃掉变成 65535，
  // 那样「只扫一个端口」的调用会静悄悄退化成全量扫描。这里显式区分「没传」和「传了 0」。
  const rawTo = Number(to);
  const maxPort = Number.isFinite(rawTo) && to !== null && to !== undefined
    ? Math.min(65535, Math.max(1, Math.trunc(rawTo)))
    : 65535;
  const rawFrom = Number(from);
  const minPort = Number.isFinite(rawFrom) && from !== null && from !== undefined
    ? Math.max(1, Math.trunc(rawFrom))
    : 1024;
  const live = [];
  for (let base = minPort; base <= maxPort; base += batch) {
    const ports = [];
    for (let port = base; port < base + batch && port <= maxPort; port += 1) ports.push(port);
    const results = await Promise.all(ports.map((port) => canConnect(host, port)));
    for (let i = 0; i < ports.length; i += 1) if (results[i]) live.push(ports[i]);
  }
  if (!live.length) return [];
  // 第二遍的等超时不需要 1.5 秒：本机回环上真 DSH 的 401 是毫秒级返回，扫不到就说明
  // 它不是 DSH。给 800ms 已经非常宽松，同时把那几个「连上就不说话」的端口拖住的成本砍半。
  const verdicts = await Promise.all(live.map((port) => probePort(host, port, 800)));
  return live.filter((_, i) => verdicts[i]).map((port) => `http://${host}:${port}`);
}
