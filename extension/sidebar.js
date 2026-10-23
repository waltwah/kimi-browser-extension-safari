/**
 * sidebar.html 的页面脚本（extension page 环境，非 content script）。
 * 顶栏连接状态（读 background 写的 dbg_* 键）+ 连接地址设置。
 */
'use strict';

const dot = document.getElementById('dot');
const title = document.getElementById('title');
const dbgTable = document.getElementById('dbg');

async function refreshStatus() {
  const data = await chrome.storage.local.get(null);
  const entries = Object.entries(data)
    .filter(([k]) => k.startsWith('dbg_') || k === 'ws_client_id' || k === 'local_url')
    .sort(([a], [b]) => a.localeCompare(b));
  dbgTable.innerHTML = entries.length
    ? entries.map(([k, v]) => `<tr><td>${k}</td><td>${String(v)}</td></tr>`).join('')
    : '<tr><td colspan="2">background 尚未运行</td></tr>';

  const openAt = data.dbg_ws_open;
  const closed = !openAt || (data.dbg_ws_close && data.dbg_ws_close > openAt);
  dot.classList.toggle('on', !closed);
  title.textContent = closed ? 'Kimi Bridge — 未连接' : 'Kimi Bridge — 已连接 daemon';
}

document.getElementById('openTab').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.kimi.com/' });
});

document.getElementById('closeBtn').addEventListener('click', () => {
  // 通知所在页面的 sidebar host 移除自己
  parent.postMessage({ __kimiSidebarClose: true }, '*');
});

document.getElementById('saveUrl').addEventListener('click', async () => {
  const v = document.getElementById('wsUrl').value.trim();
  if (v) {
    try {
      const u = new URL(v);
      if (!['ws:', 'wss:'].includes(u.protocol) || u.hostname !== '127.0.0.1') {
        alert('只允许 ws(s)://127.0.0.1:端口/路径');
        return;
      }
    } catch { alert('地址格式不正确'); return; }
    await chrome.storage.local.set({ local_url: v });
  } else {
    await chrome.storage.local.remove('local_url');
  }
  chrome.runtime.reload();
});

chrome.storage.local.get('local_url').then((d) => {
  document.getElementById('wsUrl').value = d.local_url || '';
});

refreshStatus();
setInterval(refreshStatus, 2000);
