/**
 * Kimi Bridge for Safari — content script（DOM 工具执行层）
 *
 * 在页面隔离世界中运行，接收 background 的 {__kimiBridge:true, cmd, params} 消息。
 * 实现官方 Chrome 扩展中原本依赖 CDP 的 DOM 级工具（click/fill/scroll/wait/select_option），
 * 行为对齐官方语义（见 ../PROTOCOL.md 与 ../reverse/skill/kimi-webbridge/SKILL.md）。
 *
 * 注意：所有交互均为 DOM 合成事件（isTrusted=false），与官方 click/fill 同级；
 * 严格校验 isTrusted 的站点（银行/验证码）本就无法支持，属官方已知限制。
 */

'use strict';

(() => {
  if (window.__kimiBridgeLoaded) return; // 防重复注入
  window.__kimiBridgeLoaded = true;

  // -------------------------------------------------------------------------
  // 选择器解析：暂支持 CSS；@eN ref 依赖 snapshot 体系（后续批次实现）
  // -------------------------------------------------------------------------
  function resolveElement(selector) {
    if (typeof selector !== 'string' || !selector) throw new Error('selector is required');
    if (selector.startsWith('@e')) {
      throw new Error('snapshot @e refs are not supported yet (snapshot tool pending); use a CSS selector');
    }
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element matches selector: ${selector}`);
    return el;
  }

  function describe(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
    const text = (el.innerText || el.value || el.textContent || '').trim().slice(0, 100);
    return { tag, text };
  }

  // -------------------------------------------------------------------------
  // click：scrollIntoView + el.click()（与官方 click 同为 DOM 级合成）
  // -------------------------------------------------------------------------
  function cmdClick(params) {
    const el = resolveElement(params.selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    const { tag, text } = describe(el);
    return { success: true, tag, text };
  }

  // -------------------------------------------------------------------------
  // fill：clear-and-insert。原生 input/textarea 走 value setter + input/change；
  // contenteditable（ProseMirror/Lexical/Slate 等）走 execCommand insertText。
  // -------------------------------------------------------------------------
  function cmdFill(params) {
    const el = resolveElement(params.selector);
    const value = params.value;

    if (el.isContentEditable) {
      el.focus();
      // 清空再插入（clear-and-insert 语义）
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, value);
      return { success: true, tag: describe(el).tag, mode: 'contenteditable' };
    }

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.focus();
      // 走原型 setter，确保 React 等受控组件能感知
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, tag: describe(el).tag, mode: 'value' };
    }

    throw new Error('fill: target is neither input/textarea nor contenteditable');
  }

  // -------------------------------------------------------------------------
  // scroll：direction(up/down/left/right) / to(top/bottom) / selector / text
  // -------------------------------------------------------------------------
  function cmdScroll(params) {
    if (params.selector) {
      resolveElement(params.selector).scrollIntoView({ block: 'center', inline: 'center' });
      return { success: true };
    }
    if (params.text) {
      // 简单文本查找滚动（官方实现更复杂，此处为骨架版）
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.includes(params.text)) {
          node.parentElement?.scrollIntoView({ block: 'center' });
          return { success: true };
        }
      }
      throw new Error(`scroll: text not found: ${params.text}`);
    }
    if (params.to === 'top') { window.scrollTo({ top: 0, behavior: 'instant' }); return { success: true }; }
    if (params.to === 'bottom') { window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }); return { success: true }; }
    const dir = params.direction || 'down';
    const step = { down: [0, 1], up: [0, -1], right: [1, 0], left: [-1, 0] }[dir];
    if (!step) throw new Error(`scroll: invalid direction: ${dir}`);
    window.scrollBy({ left: step[0] * window.innerWidth * 0.8, top: step[1] * window.innerHeight * 0.8, behavior: 'instant' });
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // wait：300ms 轮询 selector / text / text_gone；超时返回 {ok:false,timedOut:true}
  // （不抛错，与官方一致）
  // -------------------------------------------------------------------------
  function cmdWait(params) {
    const timeoutMs = params.timeout_ms ?? 10_000;
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        let ok = true;
        try {
          if (params.selector) ok = ok && !!document.querySelector(params.selector);
          if (params.text) ok = ok && document.body.innerText.includes(params.text);
          if (params.text_gone) ok = ok && !document.body.innerText.includes(params.text_gone);
        } catch { ok = false; }
        if (ok) return resolve({ ok: true });
        if (Date.now() - started >= timeoutMs) return resolve({ ok: false, timedOut: true });
        setTimeout(check, 300);
      };
      check();
    });
  }

  // -------------------------------------------------------------------------
  // select_option：原生 select 设置 + change 事件
  // -------------------------------------------------------------------------
  function cmdSelectOption(params) {
    const el = resolveElement(params.selector);
    if (!(el instanceof HTMLSelectElement)) throw new Error('select_option: target is not a <select>');
    const wanted = Array.isArray(params.values) ? params.values : (params.value != null ? [params.value] : []);
    if (!wanted.length) throw new Error('select_option: value or values is required');
    let matched = 0;
    for (const opt of el.options) {
      const hit = wanted.includes(opt.value) || wanted.includes(opt.text);
      opt.selected = el.multiple ? hit : hit && matched === 0;
      if (hit) matched++;
    }
    if (!matched) throw new Error(`select_option: no option matches ${JSON.stringify(wanted)}`);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // evaluate 的隔离世界降级（background 的 MAIN world 失败时兜底）
  // -------------------------------------------------------------------------
  function cmdEvaluate(params) {
    // eslint-disable-next-line no-eval
    const value = (0, eval)(params.code);
    const done = (v) => {
      let out = v;
      let json;
      try { json = JSON.stringify(v); } catch { json = undefined; }
      if (json && params.max_chars && json.length > params.max_chars) {
        out = json.slice(0, params.max_chars); // 超长截断（骨架版）
      }
      return { type: typeof v, value: out };
    };
    return value instanceof Promise ? value.then(done) : done(value);
  }

  // -------------------------------------------------------------------------
  // 消息分发
  // -------------------------------------------------------------------------
  const handlers = {
    click: cmdClick,
    fill: cmdFill,
    scroll: cmdScroll,
    wait: cmdWait,
    select_option: cmdSelectOption,
    evaluate: cmdEvaluate,
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.__kimiBridge !== true) return undefined;
    const handler = handlers[message.cmd];
    Promise.resolve()
      .then(() => {
        if (!handler) throw new Error(`unknown bridge command: ${message.cmd}`);
        return handler(message.params || {});
      })
      .then(sendResponse)
      .catch((err) => sendResponse({ __error: String((err && err.message) || err) }));
    return true; // 异步 sendResponse
  });
})();
