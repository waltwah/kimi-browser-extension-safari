#!/usr/bin/env node
/**
 * kimi-bridge-relay — Kimi WebBridge daemon 的 Origin 伪装中转（生产版，零依赖）
 *
 * 背景：daemon（127.0.0.1:10086）校验 WS Origin 白名单，只接受官方 Chrome/Edge
 * 扩展 ID；Safari 扩展（safari-web-extension:// origin）直连必被 403。
 * 本 relay 监听 127.0.0.1:12086，将 WS 帧原样转发给 daemon，并把 Origin 头
 * 伪装成官方扩展 ID。Safari 扩展内置回退逻辑会自动连接本端口。
 *
 * 仅监听 127.0.0.1，不暴露到局域网。仅支持本项目的流量形状（localhost、文本帧、
 * 可能含大体积截图帧），不是一个通用 WS 代理。
 *
 * 用法：node relay.js   （常驻用 launchd，见 install.sh）
 * 健康检查：curl http://127.0.0.1:12086/healthz
 */
'use strict';

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');

const LISTEN_PORT = Number(process.env.KIMI_RELAY_PORT || 12086);
const DAEMON_PORT = Number(process.env.KIMI_DAEMON_PORT || 10086);
const HOST = '127.0.0.1';
// 官方扩展 ID（见 PROTOCOL.md §3；daemon 白名单硬编码值）
const SPOOF_ORIGIN = 'chrome-extension://fldmhceldgbpfpkbgopacenieobmligc';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function log(...args) {
  console.log(`${new Date().toISOString()}`, ...args);
}

// ---------------------------------------------------------------------------
// RFC6455 帧解析/编码（仅做掩码转换，负载不透明转发）
// ---------------------------------------------------------------------------

/** 增量解析器：feed(chunk) → 帧数组 {fin, opcode, payload}（已去掩码） */
function makeParser() {
  let buf = Buffer.alloc(0);
  return {
    feed(chunk) {
      buf = Buffer.concat([buf, chunk]);
      const frames = [];
      for (;;) {
        if (buf.length < 2) break;
        const b0 = buf[0];
        const b1 = buf[1];
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < off + 2) break;
          len = buf.readUInt16BE(off); off += 2;
        } else if (len === 127) {
          if (buf.length < off + 8) break;
          const big = buf.readBigUInt64BE(off); off += 8;
          if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('frame too large');
          len = Number(big);
        }
        let maskKey = null;
        if (masked) {
          if (buf.length < off + 4) break;
          maskKey = buf.subarray(off, off + 4); off += 4;
        }
        if (buf.length < off + len) break;
        let payload = buf.subarray(off, off + len);
        if (maskKey) {
          const un = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) un[i] = payload[i] ^ maskKey[i & 3];
          payload = un;
        }
        frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
        buf = buf.subarray(off + len);
      }
      return frames;
    },
  };
}

/** 编码一帧；mask=true 用于客户端角色（发往 daemon） */
function encodeFrame({ fin, opcode, payload }, mask) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, mask ? 0x80 | len : len]);
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = mask ? 0x80 | 126 : 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = mask ? 0x80 | 127 : 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const maskKey = crypto.randomBytes(4);
  const maskedPayload = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) maskedPayload[i] = payload[i] ^ maskKey[i & 3];
  return Buffer.concat([header, maskKey, maskedPayload]);
}

// ---------------------------------------------------------------------------
// 中继一条 WS 连接：extension <-> daemon
// ---------------------------------------------------------------------------

function relayConnection(extSocket, reqUrl, extHead) {
  const daemonSocket = net.connect(DAEMON_PORT, HOST);
  const key = crypto.randomBytes(16).toString('base64');
  const extParser = makeParser();
  const daemonParser = makeParser();
  let daemonUpgraded = false;
  let daemonHandshakeBuf = Buffer.alloc(0);
  let closed = false;

  const teardown = () => {
    if (closed) return;
    closed = true;
    extSocket.destroy();
    daemonSocket.destroy();
  };

  daemonSocket.on('connect', () => {
    // 客户端角色握手：伪装 Origin 为官方扩展 ID
    daemonSocket.write(
      `GET ${reqUrl} HTTP/1.1\r\n` +
      `Host: ${HOST}:${DAEMON_PORT}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Origin: ${SPOOF_ORIGIN}\r\n\r\n`,
    );
  });

  daemonSocket.on('data', (chunk) => {
    if (closed) return;
    if (!daemonUpgraded) {
      daemonHandshakeBuf = Buffer.concat([daemonHandshakeBuf, chunk]);
      const idx = daemonHandshakeBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = daemonHandshakeBuf.subarray(0, idx).toString('latin1');
      const status = /^HTTP\/1\.1 (\d+)/.exec(head)?.[1];
      if (status !== '101') {
        log(`daemon rejected upgrade (HTTP ${status}) — Origin 白名单？`);
        extSocket.end();
        teardown();
        return;
      }
      daemonUpgraded = true;
      log('connection established:', reqUrl);
      chunk = daemonHandshakeBuf.subarray(idx + 4);
      if (!chunk.length) return;
    }
    // daemon → extension：服务器角色，不掩码
    let frames;
    try { frames = daemonParser.feed(chunk); } catch { teardown(); return; }
    for (const f of frames) {
      if (!extSocket.destroyed) extSocket.write(encodeFrame(f, false));
      if (f.opcode === 0x8) teardown();
    }
  });

  extSocket.on('data', (chunk) => {
    if (closed) return;
    let frames;
    try { frames = extParser.feed(chunk); } catch { teardown(); return; }
    for (const f of frames) {
      // extension → daemon：客户端角色，必须掩码
      if (daemonUpgraded && !daemonSocket.destroyed) daemonSocket.write(encodeFrame(f, true));
      if (f.opcode === 0x8) teardown();
    }
  });

  extSocket.on('error', teardown);
  extSocket.on('close', teardown);
  daemonSocket.on('error', (e) => { if (!closed) log('daemon socket error:', e.message); teardown(); });
  daemonSocket.on('close', teardown);

  // 升级完成时随请求一起到达的残留数据（极少见，防御处理）
  if (extHead?.length) extSocket.emit('data', extHead);
}

// ---------------------------------------------------------------------------
// HTTP 服务：/healthz 本地应答；/ws* 升级中继；其余 HTTP 透传 daemon
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, relay: 'kimi-bridge-relay', daemon: `${HOST}:${DAEMON_PORT}` }));
    return;
  }
  // 其余 HTTP（如 /status）透传
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const proxyReq = http.request(
      { host: HOST, port: DAEMON_PORT, path: req.url, method: req.method, headers: req.headers },
      (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); },
    );
    proxyReq.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    proxyReq.end(Buffer.concat(body));
  });
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  relayConnection(socket, req.url, head);
});

server.listen(LISTEN_PORT, HOST, () => {
  log(`kimi-bridge-relay listening on ${HOST}:${LISTEN_PORT} -> daemon ${HOST}:${DAEMON_PORT}`);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
