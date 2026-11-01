// 无依赖的代理隧道：HTTP CONNECT 与 SOCKS5。
//
// 只做一件事：给我一个「已经连到目标 IP:端口」的 socket。目标校验、TLS 校验、请求本身
// 都由调用方负责——这样安全边界不会散落在两个文件里。
//
// 为什么 CONNECT 打 IP 而不是域名：DNS 一旦交给代理解析，safe-fetch 的
// 「解析结果全是公网 IP 才放行」就形同虚设（代理那边解析成什么我们看不见）。
// 打已校验的 IP，那一步校验才真正生效。
//
// 依赖：node 内置模块。仓库只有 7 个依赖，不为 150 行代码引新的。
import net from 'node:net';
import tls from 'node:tls';

const CONNECT_TIMEOUT_MS = 8000;

function withTimeout(socket, ms, onTimeout) {
  const timer = setTimeout(onTimeout, ms);
  const clear = () => clearTimeout(timer);
  socket.once('close', clear);
  socket.once('error', clear);
  return clear;
}

/** 建立到代理服务器的 TCP 连接。 */
function dialProxy(proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const clear = withTimeout(socket, timeoutMs, () => {
      socket.destroy();
      reject(new Error('proxy-connect-timeout'));
    });
    socket.once('connect', () => { clear(); socket.setTimeout(0); resolve(socket); });
    socket.once('error', (error) => { clear(); reject(error); });
  });
}

/** 用一个字符串不完整读取器把代理握手响应读到 `\r\n\r\n`。 */
function readHandshakeResponse(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      clearTimeout(timer);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buffer.length > 16384) fail(new Error('proxy-handshake-too-large'));
        return;
      }
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      cleanup();
      resolve({ head, rest });
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error('proxy-handshake-closed'));
    const timer = setTimeout(() => fail(new Error('proxy-handshake-timeout')), timeoutMs);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function basicAuthHeader(auth) {
  if (!auth?.user) return null;
  const token = Buffer.from(`${auth.user}:${auth.pass ?? ''}`, 'utf8').toString('base64');
  return `Proxy-Authorization: Basic ${token}`;
}

/**
 * HTTP CONNECT 隧道。
 * @param {net.Socket} socket 已连上代理的 socket
 * @param {string} targetIp 已校验的目标 IP
 * @param {number} targetPort 目标端口
 * @param {{auth: object|null}} proxy
 * @param {number} timeoutMs
 * @returns {Promise<{socket: net.Socket, leftover: Buffer}>} leftover 是握手响应后多读到字节
 */
async function httpConnect(socket, targetIp, targetPort, proxy, timeoutMs) {
  const hostPart = net.isIP(targetIp) === 6 ? `[${targetIp}]` : targetIp;
  const lines = [
    `CONNECT ${hostPart}:${targetPort} HTTP/1.1`,
    `Host: ${hostPart}:${targetPort}`,
    'Proxy-Connection: keep-alive',
  ];
  const auth = basicAuthHeader(proxy.auth);
  if (auth) lines.push(auth);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const { head, rest } = await readHandshakeResponse(socket, timeoutMs);
  const statusLine = head.split('\r\n')[0] || '';
  const match = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
  if (!match) throw new Error('proxy-bad-response');
  const status = Number(match[1]);
  if (status !== 200) throw new Error(`proxy-connect-rejected:${status}`);
  return { socket, leftover: rest };
}

/** SOCKS5 握手（RFC 1928，无认证 / 用户名密码两种）。 */
async function socks5Connect(socket, targetIp, targetPort, proxy, timeoutMs) {
  const wantsAuth = Boolean(proxy.auth?.user);
  // 阶段 1：问候
  const greeting = wantsAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
  socket.write(greeting);
  let reply = await readBytes(socket, 2, timeoutMs);
  if (reply[0] !== 0x05) throw new Error('socks5-bad-version');
  if (reply[1] === 0xff) throw new Error('socks5-no-acceptable-auth');
  if (reply[1] === 0x02) {
    if (!wantsAuth) throw new Error('socks5-auth-required');
    const user = Buffer.from(proxy.auth.user, 'utf8');
    const pass = Buffer.from(proxy.auth.pass ?? '', 'utf8');
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    reply = await readBytes(socket, 2, timeoutMs);
    if (reply[1] !== 0x00) throw new Error('socks5-auth-failed');
  }
  // 阶段 2：CONNECT 到目标 IP
  const family = net.isIP(targetIp);
  const addressPart = family === 6
    ? Buffer.concat([Buffer.from([0x04]), ipv6ToBuffer(targetIp)])
    : Buffer.concat([Buffer.from([0x01]), Buffer.from(targetIp.split('.').map(Number))]);
  const portPart = Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addressPart, portPart]));
  const head = await readBytes(socket, 4, timeoutMs);
  if (head[0] !== 0x05) throw new Error('socks5-bad-version');
  if (head[1] !== 0x00) throw new Error(`socks5-connect-failed:${head[1]}`);
  // 消费掉 BND.ADDR + BND.PORT
  const addrType = head[3];
  const addrLen = addrType === 0x01 ? 4 : addrType === 0x04 ? 16 : addrType === 0x03 ? (await readBytes(socket, 1, timeoutMs))[0] : 0;
  if (addrLen) await readBytes(socket, addrLen, timeoutMs);
  await readBytes(socket, 2, timeoutMs);
  return { socket, leftover: Buffer.alloc(0) };
}

function ipv6ToBuffer(ip) {
  // 只处理常见写法；::1 与完整 8 组都已覆盖，其余交给调用方拒绝。
  const clean = ip.replace(/^\[|\]$/g, '');
  const expanded = clean === '::1' ? '0:0:0:0:0:0:0:1' : clean;
  const groups = expanded.split(':');
  const buffer = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) buffer.writeUInt16BE(parseInt(groups[i] || '0', 16) || 0, i * 2);
  return buffer;
}

function readBytes(socket, count, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      clearTimeout(timer);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= count) {
        cleanup();
        resolve(buffer.subarray(0, count));
      }
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error('proxy-closed'));
    const timer = setTimeout(() => fail(new Error('proxy-read-timeout')), timeoutMs);
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/**
 * 打开一条「到目标 IP:端口」的隧道 socket（尚未 TLS）。
 *
 * @param {{protocol: 'http'|'socks5', host: string, port: number, auth: object|null}} proxy
 * @param {string} targetIp 已校验的目标 IP（由 safe-fetch 的 resolveSafeAddresses 产出）
 * @param {number} targetPort
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<net.Socket>}
 */
export async function openTunnel(proxy, targetIp, targetPort, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : CONNECT_TIMEOUT_MS;
  const socket = await dialProxy(proxy, timeoutMs);
  try {
    if (proxy.protocol === 'socks5') {
      const { socket: s } = await socks5Connect(socket, targetIp, targetPort, proxy, timeoutMs);
      return s;
    }
    const { socket: s, leftover } = await httpConnect(socket, targetIp, targetPort, proxy, timeoutMs);
    // CONNECT 响应后若已经带了字节（极端情况下服务器先发数据），退回 socket 自身。
    if (leftover.length) s.unshift(leftover);
    return s;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * 打开到目标的 TLS 连接（走隧道）。SNI 与证书校验都用**域名**，不是 IP。
 * @param {net.Socket} socket 已连到目标的隧道 socket
 * @param {string} servername 目标域名
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<tls.TLSSocket>}
 */
export function startTls(socket, servername, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : CONNECT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername, rejectUnauthorized: true }, () => {
      clearTimeout(timer);
      resolve(secure);
    });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error('tls-timeout'));
    }, timeoutMs);
    secure.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
