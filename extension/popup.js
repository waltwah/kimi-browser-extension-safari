// 诊断 popup：展示 background 写入 storage.local 的 dbg_* 自检字段 + 连接地址设置
async function render() {
  const all = await chrome.storage.local.get(null);
  const rows = Object.keys(all)
    .filter((k) => k.startsWith('dbg_') || k === 'ws_client_id' || k === 'local_url')
    .sort()
    .map((k) => `<tr><td>${k}</td><td>${String(all[k]).replace(/</g, '&lt;')}</td></tr>`);
  document.getElementById('t').innerHTML =
    rows.join('') || '<tr><td colspan="2">（没有任何 dbg_ 字段 → background.js 从未被执行）</td></tr>';
  const urlInput = document.getElementById('url');
  if (all.local_url && !urlInput.value) urlInput.value = all.local_url;
}

document.getElementById('save').addEventListener('click', async () => {
  const v = document.getElementById('url').value.trim();
  if (v) await chrome.storage.local.set({ local_url: v });
  else await chrome.storage.local.remove('local_url');
  chrome.runtime.reload();
});
document.getElementById('reset').addEventListener('click', async () => {
  await chrome.storage.local.remove('local_url');
  chrome.runtime.reload();
});

render();
setInterval(render, 2000);
