/**
 * Kimi Bridge for Safari — background service worker (MV3)
 *
 * 实现 Kimi WebBridge daemon（127.0.0.1:10086）的扩展侧协议，
 * 行为对齐官方 Chrome 扩展 v2.0.22/2.0.23（见 ../PROTOCOL.md）。
 *
 * Safari 差异：
 *  - 无 chrome.debugger / CDP → 需要 CDP 的工具（cdp/network/save_as_pdf/mouse_click）
 *    在本文件中返回降级错误；DOM 工具改由 content-scripts/bridge.js 执行。
 *  - 无 tabGroups → navigate 的 group_title 被忽略，list_tabs 的 groupTitle 恒为 null。
 *  - MV3 background 非持久 → 用 chrome.alarms（30s）驱动 reconcile，与官方策略一致。
 *
 * API 风格：统一使用 chrome.* 的 Promise 形式（Chrome MV3 / Safari 15.4+ 均支持）。
 */

'use strict';

// --- 调试自检（骨架联调期）：记录启动/连接状态到 storage.local，popup 可读 ----
// 联调稳定后整段可删。
function dbgLog(key, value) {
  try { chrome.storage.local.set({ [`dbg_${key}`]: value }); } catch { /* noop */ }
  // 同步上报到本地 relay（联调期专用，联调稳定后删除 fetch 行）
  try { fetch(`http://127.0.0.1:12086/probe?k=${encodeURIComponent(key)}&v=${encodeURIComponent(String(value).slice(0, 200))}`).catch(() => {}); } catch { /* noop */ }
}
dbgLog('bg_evaluated', new Date().toISOString());
self.addEventListener?.('error', (e) => dbgLog('bg_error', String(e.error?.stack || e.message)));
self.addEventListener?.('unhandledrejection', (e) => dbgLog('bg_rejection', String(e.reason?.stack || e.reason)));

// ---------------------------------------------------------------------------
// 常量与存储键（键名与官方扩展保持一致，便于同机共存时互不干扰地各自存储）
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 10086;
const DEFAULT_WS_URL = `ws://127.0.0.1:${DEFAULT_PORT}/ws`;
// Origin 白名单回退链（见 PROTOCOL.md §3）：daemon 只认官方扩展 origin，
// 直连被 403 时自动回退到本地伪装中转（reverse/proxy/tap.js，默认 12086）。
// 用户显式设置 local_url 时优先且不再回退。
// Safari 的 origin（safari-web-extension://）必然不在白名单 → Safari 平台优先走 relay；
// 且实测 Safari SW 在 WS 被拒后会立即挂起（onerror/onclose 来不及派发），不能依赖失败后回退。
const FALLBACK_WS_URLS = (() => {
  const relay = 'ws://127.0.0.1:12086/ws';
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isSafari = /Safari/i.test(ua) && !/Chrom(e|ium)/i.test(ua);
  dbgLog('ua', ua.slice(0, 120));
  return isSafari ? [relay, DEFAULT_WS_URL] : [DEFAULT_WS_URL, relay];
})();
let fallbackIdx = 0;

const STORAGE_CLIENT_ID = 'ws_client_id';       // 首启生成的 UUID，持久化
const STORAGE_SHOULD_CONNECT = 'ws_should_connect'; // 默认 true
const STORAGE_LOCAL_URL = 'local_url';          // 可选自定义连接地址（dev）

const ALARM_RECONCILE = 'webbridge-reconcile';
const RECONCILE_PERIOD_MIN = 0.5;               // 30s 周期 reconcile
const OPEN_TIMEOUT_MS = 10_000;                 // 连接 10s 未 open 则放弃
const DEAD_LINK_MS = 45_000;                    // 45s 无流量判死链
const FAST_RETRY_MS = [1_000, 3_000];           // 断开后两次快速重试
const CLOSE_CODE_BUSY = 4409;                   // daemon 被另一浏览器占用

// ---------------------------------------------------------------------------
// WebSocket 连接管理
// ---------------------------------------------------------------------------

let ws = null;
let connecting = false;
let lastActivityAt = 0;
let fastRetryCount = 0;
let fastRetryTimer = null;
let lastToolTabId = null; // le() 回退链用的「上次工具 tab」

function touchActivity() {
  lastActivityAt = Date.now();
}

async function getClientId() {
  const got = await chrome.storage.local.get(STORAGE_CLIENT_ID);
  if (got[STORAGE_CLIENT_ID]) return got[STORAGE_CLIENT_ID];
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_CLIENT_ID]: id });
  return id;
}

async function getWsUrl() {
  const got = await chrome.storage.local.get([STORAGE_LOCAL_URL, STORAGE_SHOULD_CONNECT]);
  const shouldConnect = got[STORAGE_SHOULD_CONNECT] !== false; // 默认 true
  if (typeof got[STORAGE_LOCAL_URL] === 'string' && got[STORAGE_LOCAL_URL]) {
    // 与官方一致：仅允许 ws/wss 且 127.0.0.1（拒绝 IPv6 [::1] 与其他 127.x）
    try {
      const u = new URL(got[STORAGE_LOCAL_URL]);
      if ((u.protocol === 'ws:' || u.protocol === 'wss:') && u.hostname === '127.0.0.1') {
        return { url: got[STORAGE_LOCAL_URL], custom: true, shouldConnect };
      }
    } catch { /* 忽略非法地址，走默认回退链 */ }
  }
  return { url: FALLBACK_WS_URLS[fallbackIdx % FALLBACK_WS_URLS.length], custom: false, shouldConnect };
}

function sendFrame(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    touchActivity();
    return true;
  }
  return false;
}

function teardownSocket() {
  if (fastRetryTimer) { clearTimeout(fastRetryTimer); fastRetryTimer = null; }
  const sock = ws;
  ws = null;
  connecting = false;
  if (sock) {
    try { sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null; sock.close(); } catch { /* noop */ }
  }
}

async function connect() {
  if (connecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  connecting = true; // 先占锁再 await，防止并发 connect
  const { url, custom, shouldConnect } = await getWsUrl();
  dbgLog('connect_attempt', `${url} shouldConnect=${shouldConnect} @ ${new Date().toISOString()}`);
  if (!shouldConnect) { connecting = false; return; }
  let opened = false;
  const clientId = await getClientId();
  const sock = new WebSocket(`${url}?client=${encodeURIComponent(clientId)}`);
  ws = sock;

  const openTimer = setTimeout(() => {
    if (sock.readyState !== WebSocket.OPEN) {
      try { sock.close(); } catch { /* noop */ }
    }
  }, OPEN_TIMEOUT_MS);

  sock.onopen = () => {
    opened = true;
    clearTimeout(openTimer);
    connecting = false;
    fastRetryCount = 0;
    touchActivity();
    dbgLog('ws_open', `${url} @ ${new Date().toISOString()}`);
    // 握手：open 后立即发 hello（daemon 回 hello_ack，内容忽略）
    sendFrame({ type: 'hello', payload: { extensionVersion: chrome.runtime.getManifest().version } });
  };

  sock.onmessage = (ev) => {
    touchActivity();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleDaemonMessage(msg);
  };

  sock.onclose = (ev) => {
    clearTimeout(openTimer);
    dbgLog('ws_close', `${ev.code} ${ev.reason || ''} @ ${new Date().toISOString()}`);
    const wasBusy = ev.code === CLOSE_CODE_BUSY;
    teardownSocket();
    // 未 open 就失败（如 daemon Origin 白名单 403）且非用户自定义地址 → 沿回退链换下一个地址立即重试
    if (!opened && !custom && !wasBusy) {
      fallbackIdx++;
      fastRetryTimer = setTimeout(() => { void reconcile(); }, 500);
      return;
    }
    // 4409 = daemon 已被另一浏览器占用：不做快速重试，只等周期 reconcile
    if (!wasBusy && fastRetryCount < FAST_RETRY_MS.length) {
      const delay = FAST_RETRY_MS[fastRetryCount++];
      fastRetryTimer = setTimeout(() => { void reconcile(); }, delay);
    }
  };

  sock.onerror = () => {
    // onclose 会随后触发，统一在那里处理重连
    dbgLog('ws_error', new Date().toISOString());
  };
}

/**
 * 周期 reconcile：该连就连、死链重连、活着就 ping。
 * 由 chrome.alarms 驱动（MV3 非持久 background 的保活手段）。
 */
async function reconcile() {
  const alive = ws && ws.readyState === WebSocket.OPEN;
  if (!alive) {
    await connect();
    return;
  }
  if (Date.now() - lastActivityAt > DEAD_LINK_MS) {
    teardownSocket();
    await connect();
    return;
  }
  sendFrame({ type: 'ping' });
}

// ---------------------------------------------------------------------------
// daemon 消息处理（纯 JSON 帧；未知 type 一律忽略）
// ---------------------------------------------------------------------------

async function handleDaemonMessage(msg) {
  switch (msg?.type) {
    case 'hello_ack':
    case 'pong':
      return;
    case 'ping':
      sendFrame({ type: 'pong' });
      return;
    case 'tool_call':
      await handleToolCall(msg);
      return;
    default:
      return; // 未知 type 忽略
  }
}

async function handleToolCall(msg) {
  const requestId = msg.requestId;
  const name = msg.payload?.name;
  const args = msg.payload?.args ?? {};
  try {
    if (!name) throw new Error('missing tool name');
    const data = await dispatchTool(name, args);
    sendFrame({ type: 'tool_result', responseToRequestId: requestId, payload: { data } });
  } catch (err) {
    // 失败回 {error: <message 字符串>}（无错误码字段，与官方一致）
    sendFrame({
      type: 'tool_result',
      responseToRequestId: requestId,
      payload: { error: String((err && err.message) || err) },
    });
  }
}

// ---------------------------------------------------------------------------
// 工具注册表与派发
// ---------------------------------------------------------------------------

const tools = new Map();
function registerTool(name, execute) { tools.set(name, execute); }

async function dispatchTool(name, args) {
  const fn = tools.get(name);
  if (!fn) {
    throw new Error(`Unknown tool: ${name}. Available: ${[...tools.keys()].join(', ')}`);
  }
  if (args._tabId != null && name !== 'close_tab' && name !== 'list_tabs' && name !== 'close_session') {
    lastToolTabId = args._tabId;
  }
  const result = await fn(args);
  if ((name === 'navigate' || name === 'find_tab') && typeof result?.tabId === 'number') {
    lastToolTabId = result.tabId;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 公共：tab 解析与加载等待
// ---------------------------------------------------------------------------

/** le() 回退链：args._tabId → 上次工具 tab → 最后聚焦窗口的活动 tab */
async function resolveTabId(args) {
  if (typeof args?._tabId === 'number') return args._tabId;
  if (typeof lastToolTabId === 'number') {
    try { await chrome.tabs.get(lastToolTabId); return lastToolTabId; } catch { lastToolTabId = null; }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error('no active tab');
  return active.id;
}

/** 等待 tab 加载完成：轮询 tabs.get（Safari 的 tabs.onUpdated 时序不可靠），30s 超时 */
async function waitForTabLoad(tabId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch { /* tab 可能已关闭 */ return; }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('navigate: page load timeout (30s)');
}

/** find_tab 的域名后缀匹配：kimi.com 也能匹配 www.kimi.com，忽略 path；query 可不带 scheme */
function hostMatches(tabUrl, queryUrl) {
  try {
    const a = new URL(tabUrl).hostname.replace(/^www\./, '');
    const b = new URL(/^https?:\/\//.test(queryUrl) ? queryUrl : `https://${queryUrl}`).hostname.replace(/^www\./, '');
    return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 公共：向页面 content script 发 DOM 命令（未注入时先注入再重试一次）
// ---------------------------------------------------------------------------

async function sendToPage(tabId, cmd, params) {
  const message = { __kimiBridge: true, cmd, params };
  let reply;
  try {
    reply = await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // content script 可能尚未注入（页面早于扩展加载）→ 注入后重试一次
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/bridge.js'] });
    reply = await chrome.tabs.sendMessage(tabId, message);
  }
  dbgLog('page_reply', `${cmd} -> ${JSON.stringify(reply)?.slice(0, 150) ?? String(reply)}`);
  if (reply && reply.__error) throw new Error(reply.__error);
  return reply;
}

// ---------------------------------------------------------------------------
// 工具实现（第一批：无 CDP 依赖；参数/返回结构对齐 PROTOCOL.md §2.4）
// ---------------------------------------------------------------------------

registerTool('navigate', async (args) => {
  if (!args.url) throw new Error('navigate: url is required');
  // Safari 无 tabGroups：group_title / agent:<session> 分组标题忽略（见 PROTOCOL.md §4）
  let tabId;
  if (args.newTab) {
    const tab = await chrome.tabs.create({ url: args.url, active: true });
    tabId = tab.id;
    await waitForTabLoad(tabId);
    const done = await chrome.tabs.get(tabId);
    return { success: true, url: done.url, tabId };
  }
  tabId = await resolveTabId(args);
  await chrome.tabs.update(tabId, { url: args.url });
  await waitForTabLoad(tabId);
  const done = await chrome.tabs.get(tabId);
  return { success: true, url: done.url, tabId };
});

registerTool('find_tab', async (args) => {
  if (!args.url) throw new Error('find_tab: url is required');
  if (args.active === true) {
    // 借用用户正在看的 tab
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active) throw new Error('find_tab: no active tab');
    return { success: true, url: active.url, tabId: active.id, borrowed: true };
  }
  // 默认只在 session 自己的 tabs 里找（_tabIds 由 daemon 下传）
  const candidates = Array.isArray(args._tabIds) ? args._tabIds : [];
  for (const id of candidates) {
    try {
      const tab = await chrome.tabs.get(id);
      if (tab.url && hostMatches(tab.url, args.url)) {
        return { success: true, url: tab.url, tabId: id, borrowed: false };
      }
    } catch { /* tab 已关闭 */ }
  }
  throw new Error(`find_tab: no tab matching ${args.url} in this session`);
});

registerTool('attach_tab', async (args) => {
  const tabId = Number(args.tabId);
  if (!Number.isInteger(tabId) || tabId < 1 || tabId > 2147483647) {
    throw new Error('tabId must be an integer between 1 and 2147483647');
  }
  const tab = await chrome.tabs.get(tabId);
  return { success: true, tabId, url: tab.url, title: tab.title, borrowed: true };
});

registerTool('list_tabs', async (args) => {
  const ids = Array.isArray(args._tabIds) ? args._tabIds : [];
  const owned = new Set(Array.isArray(args._ownedTabIds) ? args._ownedTabIds : ids);
  const tabs = [];
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      tabs.push({
        tabId: id,
        url: tab.url,
        title: tab.title,
        active: tab.active,
        groupTitle: null, // Safari 无 tabGroups
        borrowed: !owned.has(id),
      });
    } catch { /* tab 已关闭，跳过 */ }
  }
  return { success: true, tabs };
});

registerTool('list_browser_tabs', async () => {
  const all = await chrome.tabs.query({});
  return {
    success: true,
    tabs: all.map((t) => ({ tabId: t.id, windowId: t.windowId, url: t.url, title: t.title, active: t.active })),
  };
});

registerTool('close_tab', async (args) => {
  const tabId = await resolveTabId(args);
  try {
    await chrome.tabs.remove(tabId);
    if (lastToolTabId === tabId) lastToolTabId = null;
    return { success: true, closed: true };
  } catch {
    return { success: true, closed: false }; // 幂等
  }
});

registerTool('close_session', async (args) => {
  // 官方回退链：_ownedTabIds → _tabIds → _tabId；借用的 tab 不关
  let ids = Array.isArray(args._ownedTabIds) && args._ownedTabIds.length
    ? args._ownedTabIds
    : (Array.isArray(args._tabIds) ? args._tabIds : (args._tabId != null ? [args._tabId] : []));
  let closed = 0;
  for (const id of ids) {
    try { await chrome.tabs.remove(id); closed++; } catch { /* 已关闭 */ }
  }
  if (ids.includes(lastToolTabId)) lastToolTabId = null;
  return { success: true, closed };
});

registerTool('evaluate', async (args) => {
  if (typeof args.code !== 'string') throw new Error('evaluate: code is required');
  const tabId = await resolveTabId(args);
  // 官方用语义：在页面主 realm 执行（共享页面 JS 环境）。
  // Safari 降级路径：优先 MAIN world（支持时），失败则退回隔离世界的 content script eval。
  try {
    const execResult = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (code) => (0, eval)(code), // eslint-disable-line no-eval
      args: [args.code],
    });
    dbgLog('evaluate_main', JSON.stringify(execResult)?.slice(0, 150));
    const value = execResult?.[0]?.result;
    return { type: typeof value, value };
  } catch (err) {
    // MAIN world 不可用（老版 Safari）或页面 CSP 阻断 eval → 退回 content script
    dbgLog('evaluate_fallback', String(err?.message || err).slice(0, 150));
    try {
      return await sendToPage(tabId, 'evaluate', { code: args.code, max_chars: args.max_chars });
    } catch {
      throw err; // 报原始 MAIN world 错误，更接近官方行为
    }
  }
});

registerTool('screenshot', async (args) => {
  const tabId = await resolveTabId(args);
  const tab = await chrome.tabs.get(tabId);
  const format = args.format === 'jpeg' ? 'jpeg' : 'png';
  const options = { format };
  if (format === 'jpeg' && typeof args.quality === 'number') {
    options.quality = Math.max(0, Math.min(100, args.quality));
  }
  // Safari：tabs.captureVisibleTab 支持（不需要 all_urls）。
  // 降级说明：selector 元素级裁剪依赖 CDP boxModel + clip，Safari 不可用；
  // 这里先整屏截取并附 note，后续可用 content script 上报 rect + canvas 裁剪。
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, options);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const result = {
    format,
    data: base64,
    dataLength: base64.length,
    mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
  };
  if (args.selector) result.note = 'selector clip unsupported on Safari yet; full viewport captured';
  return result;
});

// --- DOM 工具：转发给 content script（bridge.js） ---------------------------

registerTool('click', async (args) => {
  if (!args.selector) throw new Error('click: selector is required');
  const tabId = await resolveTabId(args);
  return await sendToPage(tabId, 'click', { selector: args.selector });
});

registerTool('fill', async (args) => {
  if (!args.selector) throw new Error('fill: selector is required');
  if (typeof args.value !== 'string') throw new Error('fill: value is required');
  const tabId = await resolveTabId(args);
  return await sendToPage(tabId, 'fill', { selector: args.selector, value: args.value });
});

registerTool('scroll', async (args) => {
  const tabId = await resolveTabId(args);
  return await sendToPage(tabId, 'scroll', {
    direction: args.direction, to: args.to, selector: args.selector, text: args.text,
  });
});

registerTool('wait', async (args) => {
  const tabId = await resolveTabId(args);
  if (args.frame) throw new Error('wait: frame is not supported on Safari yet');
  if (!args.text && !args.text_gone && !args.selector) {
    throw new Error('wait: one of text/text_gone/selector is required');
  }
  const timeoutMs = Math.max(500, Math.min(60_000, args.timeout_ms ?? 10_000));
  return await sendToPage(tabId, 'wait', {
    text: args.text, text_gone: args.text_gone, selector: args.selector, timeout_ms: timeoutMs,
  });
});

registerTool('select_option', async (args) => {
  if (!args.selector) throw new Error('select_option: selector is required');
  const tabId = await resolveTabId(args);
  return await sendToPage(tabId, 'select_option', { selector: args.selector, values: args.values, value: args.value });
});

registerTool('snapshot', async (args) => {
  const tabId = await resolveTabId(args);
  return await sendToPage(tabId, 'snapshot', {
    ref: args.ref, format: args.format, max_chars: args.max_chars,
    cursor: args.cursor, interactive: args.interactive,
  });
});

registerTool('find', async (args) => {
  if (!args.query) throw new Error('find: query is required');
  const tabId = await resolveTabId(args);
  return await sendToPage(tabId, 'find', { query: args.query });
});

registerTool('read_page', async (args) => {
  const tabId = await resolveTabId(args);
  return await sendToPage(tabId, 'read_page', {
    max_chars: args.max_chars, start: args.start, frame: args.frame,
  });
});

// --- 明确降级：CDP 依赖工具（Safari 无 chrome.debugger） --------------------
// 错误消息写明原因，daemon 会包装成 ok:false 返回给 Agent。

const UNSUPPORTED_CDP = 'not supported on Safari (requires chrome.debugger/CDP)';
registerTool('cdp', async () => { throw new Error(`cdp: ${UNSUPPORTED_CDP}`); });
registerTool('network', async () => { throw new Error(`network: ${UNSUPPORTED_CDP}`); });
registerTool('save_as_pdf', async () => { throw new Error(`save_as_pdf: ${UNSUPPORTED_CDP}`); });
registerTool('mouse_click', async () => { throw new Error(`mouse_click: ${UNSUPPORTED_CDP}; use click (synthetic DOM click) instead`); });

// 尚未实现的工具（后续批次）：upload / hover / key_type / send_keys / dialog / drag
// —— 由 dispatchTool 统一回 Unknown tool。

// ---------------------------------------------------------------------------
// 生命周期：alarms 驱动 reconcile（MV3 非持久 background 保活）
// ---------------------------------------------------------------------------

chrome.alarms.create(ALARM_RECONCILE, { periodInMinutes: RECONCILE_PERIOD_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_RECONCILE) void reconcile();
});
chrome.runtime.onStartup.addListener(() => void reconcile());
chrome.runtime.onInstalled.addListener(() => void reconcile());

// service worker 启动（含被 alarm 唤醒）时立即 reconcile 一次
void reconcile();
