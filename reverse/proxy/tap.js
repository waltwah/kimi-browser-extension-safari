// WS tap proxy: listen 127.0.0.1:12086, forward to real kimi-webbridge daemon 127.0.0.1:10086.
// Logs every WebSocket frame (both directions) and every HTTP request to captures/YYYY-....jsonl
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const LISTEN_PORT = 12086;
const TARGET = 'http://127.0.0.1:10086';
const outDir = path.join(__dirname, 'captures');
fs.mkdirSync(outDir, { recursive: true });
const logFile = path.join(outDir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const log = (rec) => {
  rec.ts = new Date().toISOString();
  fs.appendFileSync(logFile, JSON.stringify(rec) + '\n');
  const preview = rec.data && rec.data.length > 4000 ? rec.data.slice(0, 4000) + `…<+${rec.data.length - 4000} chars>` : rec.data;
  console.log(`[${rec.dir || rec.kind}]`, preview || rec.url || '');
};
console.log('logging to', logFile);

const server = http.createServer((req, res) => {
  // plain HTTP reverse proxy (for /status etc. if pointed here)
  const body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const payload = Buffer.concat(body);
    log({ kind: 'http', dir: 'client->daemon', url: req.url, method: req.method, data: payload.toString('utf8') });
    const proxyReq = http.request(TARGET + req.url, { method: req.method, headers: req.headers }, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', (c) => chunks.push(c));
      proxyRes.on('end', () => {
        log({ kind: 'http', dir: 'daemon->client', url: req.url, status: proxyRes.statusCode, data: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(Buffer.concat(chunks));
      });
    });
    proxyReq.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
    proxyReq.end(payload);
  });
});

const wss = new WebSocketServer({ server });
wss.on('connection', (clientWs, req) => {
  log({ kind: 'ws', dir: 'connect', url: req.url, headers: { origin: req.headers.origin, 'user-agent': req.headers['user-agent'], protocols: req.headers['sec-websocket-protocol'] } });
  const targetWs = new WebSocket(TARGET + req.url, { headers: { origin: req.headers.origin } });
  const pending = [];
  targetWs.on('open', () => { pending.splice(0).forEach((m) => targetWs.send(m)); });
  targetWs.on('message', (data, isBinary) => {
    log({ kind: 'ws', dir: 'daemon->ext', data: data.toString('utf8'), binary: isBinary });
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data, { binary: isBinary });
  });
  targetWs.on('close', (code, reason) => { log({ kind: 'ws', dir: 'daemon-close', data: `${code} ${reason}` }); clientWs.close(code, reason); });
  targetWs.on('error', (e) => { log({ kind: 'ws', dir: 'daemon-error', data: String(e) }); clientWs.close(1011); });

  clientWs.on('message', (data, isBinary) => {
    log({ kind: 'ws', dir: 'ext->daemon', data: data.toString('utf8'), binary: isBinary });
    if (targetWs.readyState === WebSocket.OPEN) targetWs.send(data, { binary: isBinary });
    else pending.push(data);
  });
  clientWs.on('close', (code, reason) => { log({ kind: 'ws', dir: 'ext-close', data: `${code} ${reason}` }); targetWs.close(); });
  clientWs.on('error', () => targetWs.close());
});

server.listen(LISTEN_PORT, '127.0.0.1', () => console.log(`tap proxy on 127.0.0.1:${LISTEN_PORT} -> ${TARGET}`));
