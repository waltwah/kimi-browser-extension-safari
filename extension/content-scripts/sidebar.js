/**
 * 侧边栏宿主（content script）：监听工具栏点击，在页面右侧注入/移除侧边栏。
 * 用 Shadow DOM 隔离样式；内嵌 extension 页面 sidebar.html（其内再 iframe kimi.com，
 * 复用用户在 Safari 的 kimi.com 登录态）。
 * 消息协议独立于 bridge.js（__kimiSidebar），避免两个 content script 抢响应。
 *
 * 宽度调节：左缘拖拽手柄，范围 [280px, window.innerWidth/3]，持久化到 storage.local。
 */
'use strict';

(() => {
  if (window.__kimiSidebarLoaded) return;
  window.__kimiSidebarLoaded = true;

  const HOST_ID = '__kimi_bridge_sidebar_host__';
  const MIN_WIDTH = 280;
  const clampWidth = (w) => Math.max(MIN_WIDTH, Math.min(Math.floor(window.innerWidth / 3), Math.round(w)));

  function isOpen() {
    return !!document.getElementById(HOST_ID);
  }

  async function open() {
    if (isOpen()) return;
    const saved = (await chrome.storage.local.get('sidebar_width')).sidebar_width;
    const width = clampWidth(typeof saved === 'number' ? saved : 400);

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('style', [
      'position:fixed', 'top:0', 'right:0', `width:${width}px`, 'height:100vh',
      'z-index:2147483647', 'box-shadow:-2px 0 12px rgba(0,0,0,.15)',
    ].join(';'));
    const shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      .wrap { position: relative; width: 100%; height: 100%; }
      iframe { width: 100%; height: 100%; border: 0; background: #fff; display: block; }
      .grip {
        position: absolute; left: 0; top: 0; width: 8px; height: 100%;
        cursor: col-resize; z-index: 2;
      }
      .grip:hover, .grip.active { background: rgba(0,122,255,.25); }
      .shield { /* 拖拽时盖住 iframe，防止指针事件被 iframe 吞掉 */
        position: absolute; inset: 0; z-index: 1; display: none;
      }
      .shield.on { display: block; }
    `;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('sidebar.html');
    const shield = document.createElement('div');
    shield.className = 'shield';
    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = '拖拽调整宽度';
    wrap.append(frame, shield, grip);
    shadow.append(style, wrap);
    document.documentElement.appendChild(host);

    // --- 拖拽调宽 ---
    grip.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      grip.classList.add('active');
      shield.classList.add('on');
      const startX = ev.clientX;
      const startW = host.offsetWidth;
      const onMove = (e) => { host.style.width = `${clampWidth(startW + (startX - e.clientX))}px`; };
      const onUp = () => {
        grip.classList.remove('active');
        shield.classList.remove('on');
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        chrome.storage.local.set({ sidebar_width: host.offsetWidth });
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    });

    // 窗口变窄时自动收缩到 1/3 以内
    window.addEventListener('resize', () => {
      if (!isOpen()) return;
      const clamped = clampWidth(host.offsetWidth);
      if (clamped !== host.offsetWidth) host.style.width = `${clamped}px`;
    });

    // sidebar.html 内关闭按钮的回信
    window.addEventListener('message', function onMsg(ev) {
      if (ev.data && ev.data.__kimiSidebarClose) {
        close();
        window.removeEventListener('message', onMsg);
      }
    });
  }

  function close() {
    document.getElementById(HOST_ID)?.remove();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.__kimiSidebar !== true) return undefined;
    if (message.cmd === 'toggle') {
      if (isOpen()) { close(); sendResponse({ open: false }); }
      else { void open(); sendResponse({ open: true }); } // open() 有 storage await，先回报意图
    }
    return undefined; // 同步响应，不占用异步通道
  });
})();
