/**
 * Kimi Bridge for Safari — content script（DOM 工具执行层 + 自研可达性快照）
 *
 * 在页面隔离世界中运行，接收 background 的 {__kimiBridge:true, cmd, params} 消息。
 * 实现官方 Chrome 扩展中原本依赖 CDP 的 DOM 级工具，行为对齐官方语义
 * （见 ../PROTOCOL.md 与 ../reverse/skill/kimi-webbridge/SKILL.md）。
 *
 * Safari 无 Accessibility.getFullAXTree → snapshot/find 在此自研：
 *  - DOM 遍历推断 ARIA role / name，跳过不可见节点
 *  - 交互元素分配 @eN ref；ref_policy 对齐官方 "stable-node"：
 *    WeakMap 缓存节点→ref，同节点跨快照保持同一 ref（页面生命周期内）
 *  - 截断游标 <snapshotId>:<offset>，支持 cursor 续读
 *
 * 注意：所有交互均为 DOM 合成事件（isTrusted=false），与官方 click/fill 同级；
 * 严格校验 isTrusted 的站点（银行/验证码）本就无法支持，属官方已知限制。
 */

'use strict';

(() => {
  if (window.__kimiBridgeLoaded) return; // 防重复注入
  window.__kimiBridgeLoaded = true;

  // =========================================================================
  // @eN ref 体系（stable-node：WeakMap 保证同节点跨快照同 ref）
  // =========================================================================

  const nodeToRef = new WeakMap();   // Node -> number
  const refToNode = new Map();       // number -> Node（页面生命周期内持有）
  let nextRefId = 1;

  function refFor(node) {
    let id = nodeToRef.get(node);
    if (id === undefined) {
      id = nextRefId++;
      nodeToRef.set(node, id);
      refToNode.set(id, node);
    }
    return id;
  }

  function nodeFromRef(ref) {
    const m = /^@e(\d+)$/.exec(ref);
    if (!m) return null;
    const node = refToNode.get(Number(m[1]));
    return node && node.isConnected ? node : null;
  }

  // =========================================================================
  // 选择器解析：CSS 或 @eN ref
  // =========================================================================

  function resolveElement(selector) {
    if (typeof selector !== 'string' || !selector) throw new Error('selector is required');
    if (selector.startsWith('@e')) {
      const node = nodeFromRef(selector);
      if (!node) throw new Error(`stale or unknown ref: ${selector}（页面可能已变化，请重新 snapshot）`);
      return node;
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

  // =========================================================================
  // 可达性树（自研，替代 CDP Accessibility.getFullAXTree）
  // =========================================================================

  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'meta', 'link', 'head', 'title', 'svg', 'path', 'br', 'hr']);

  function isVisible(el) {
    if (!(el instanceof Element)) return true;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      if (['button', 'submit', 'reset'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'button'; // 文件选择按钮（upload 工具用）
      if (type === 'hidden') return null;
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return 'form';
    if (tag === 'ul' || tag === 'ol') return 'list';
    if (tag === 'li') return 'listitem';
    if (tag === 'table') return 'table';
    if (tag === 'tr') return 'row';
    if (tag === 'td' || tag === 'th') return 'cell';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'iframe') return 'iframe';
    if (tag === 'label') return 'label';
    if (el.isContentEditable) return 'textbox';
    return null; // 无语义容器
  }

  const INTERACTIVE_ROLES = new Set(['link', 'button', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'menuitem', 'tab', 'switch', 'option']);

  function isInteractive(el, role) {
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) >= 0) return true;
    return false;
  }

  function nameOf(el, role) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ').trim();
      if (text) return text;
    }
    if (role === 'img') return (el.getAttribute('alt') || '').trim();
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.innerText.trim();
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    const title = el.getAttribute('title');
    if (title) return title.trim();
    // 按钮/链接用自身可见文本
    const text = (el.innerText || el.value || '').replace(/\s+/g, ' ').trim();
    return text.slice(0, 80);
  }

  /**
   * 递归构建节点树。节点形态：
   * { role, name?, ref?, level?, children?, text? } —— text 为纯文本叶子
   */
  function buildTree(root, opts = {}) {
    const interactiveOnly = opts.interactive === true;

    function hasInteractive(n) {
      if (n.ref) return true;
      return (n.children || []).some(hasInteractive);
    }

    function walk(el) {
      if (!(el instanceof Element)) return [];
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return [];
      if (!isVisible(el)) return [];

      const role = roleOf(el);
      const interactive = role ? isInteractive(el, role) : false;

      // 收集子节点
      const children = [];
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent.replace(/\s+/g, ' ').trim();
          if (t) children.push({ role: 'text', text: t });
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          children.push(...walk(child));
        }
      }

      // 无语义且无交互的容器：直接提升子节点（拍平 div/span）
      if (!role && !interactive) return children;

      const node = { role: role || 'generic' };
      const name = role ? nameOf(el, role) : '';
      if (name) node.name = name;
      if (role === 'heading') node.level = Number(tag[1]);
      if (interactive) node.ref = `@e${refFor(el)}`;
      if (role === 'iframe') node.handle = `iframe:${el.src || 'inline'}`; // 跨 frame 遍历暂不支持

      if (interactiveOnly && !interactive) {
        const interactiveDescendants = children.filter(hasInteractive);
        if (!interactiveDescendants.length) return [];
        node.children = interactiveDescendants;
        return [node];
      }

      // 有 name 的语义元素若其子节点只是同文本的 text 叶子，去重
      const deduped = node.name
        ? children.filter((c) => !(c.role === 'text' && node.name.includes(c.text)))
        : children;
      if (deduped.length) node.children = deduped;
      return [node];
    }

    return walk(root);
  }

  // 树 → aria 文本（Playwright 风格，对齐官方 format:"aria" 输出习惯）
  function treeToText(nodes, indent = 0) {
    const lines = [];
    for (const n of nodes) {
      const pad = '  '.repeat(indent);
      if (n.role === 'text') {
        lines.push(`${pad}- text: ${n.text}`);
        continue;
      }
      let line = `${pad}- ${n.role}`;
      if (n.level) line += ` [level=${n.level}]`;
      if (n.name) line += ` "${n.name}"`;
      if (n.ref) line += ` [${n.ref}]`;
      if (n.handle) line += ` [${n.handle}]`;
      lines.push(line);
      if (n.children?.length) lines.push(treeToText(n.children, indent + 1));
    }
    return lines.filter(Boolean).join('\n');
  }

  // =========================================================================
  // 快照缓存（cursor 续读：<snapshotId>:<offset>）
  // =========================================================================

  const snapshotCache = new Map(); // snapshotId -> fullText
  const MAX_CHARS_DEFAULT = 60000;

  function cmdSnapshot(params) {
    // cursor 续读：不重扫 DOM，直接切上次缓存的文本
    if (params.cursor) {
      const m = /^([0-9a-f-]{36}):(\d+)$/.exec(params.cursor);
      const cached = m && snapshotCache.get(m[1]);
      if (!cached) throw new Error('invalid or expired cursor; take a new snapshot');
      return sliceAria(cached, Number(m[2]), params, m[1]);
    }

    let root = document.body;
    if (params.ref) root = resolveElement(params.ref); // 支持 @eN 或 CSS 限定子树

    const tree = buildTree(root, { interactive: params.interactive });

    if (params.format === 'aria') {
      const fullText = treeToText(tree);
      const snapshotId = crypto.randomUUID();
      snapshotCache.set(snapshotId, fullText);
      if (snapshotCache.size > 10) snapshotCache.delete(snapshotCache.keys().next().value); // 简单 LRU
      return sliceAria(fullText, 0, params, snapshotId);
    }

    // 默认：结构化树
    return { url: location.href, title: document.title, tree };
  }

  function sliceAria(fullText, offset, params, snapshotId) {
    const maxChars = Math.max(1, Math.min(MAX_CHARS_DEFAULT, params.max_chars ?? MAX_CHARS_DEFAULT));
    const slice = fullText.slice(offset, offset + maxChars);
    const result = { url: location.href, title: document.title, tree_text: slice, ref_policy: 'stable-node' };
    const remaining = fullText.length - (offset + maxChars);
    if (remaining > 0 && snapshotId) {
      result.truncated = true;
      result.next_cursor = `${snapshotId}:${offset + maxChars}`;
      result.note = 'More text remains. Call snapshot with format:"aria", cursor:next_cursor and optional max_chars to continue this same snapshot.';
    }
    return result;
  }

  // =========================================================================
  // find：快照节点模糊匹配（对齐官方返回结构）
  // =========================================================================

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(`${part}#${cur.id}`); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function cmdFind(params) {
    const query = (params.query || '').toLowerCase();
    if (!query) throw new Error('find: query is required');
    const tree = buildTree(document.body);
    const matches = [];

    function visit(nodes, ancestors) {
      for (const n of nodes) {
        const name = (n.name || '').toLowerCase();
        const role = (n.role || '').toLowerCase();
        const text = (n.text || '').toLowerCase();
        let matchedField = null;
        if (name && name.includes(query)) matchedField = 'name';
        else if (role && role.includes(query)) matchedField = 'role';
        else if (text && text.includes(query)) matchedField = 'text';
        if (matchedField && n.role !== 'text') {
          const interactiveAncestor = [...ancestors].reverse().find((a) => a.ref);
          const el = n.ref ? nodeFromRef(n.ref) : null;
          matches.push({
            role: n.role,
            matchedField,
            path: el ? cssPath(el) : undefined,
            name: n.name,
            ref: n.ref,
            interactiveAncestorRef: n.ref ? undefined : interactiveAncestor?.ref,
          });
        }
        visit(n.children || [], n.ref ? [...ancestors, n] : ancestors);
      }
    }

    visit(tree, []);
    return { query: params.query, totalMatches: matches.length, matches: matches.slice(0, 50) };
  }

  // =========================================================================
  // read_page：分页读取全文（骨架版：innerText + start/max_chars）
  // =========================================================================

  function cmdReadPage(params) {
    const maxChars = Math.max(1, Math.min(MAX_CHARS_DEFAULT, params.max_chars ?? MAX_CHARS_DEFAULT));
    const start = Math.max(0, params.start ?? 0);
    if (params.frame) throw new Error('read_page: frame is not supported on Safari yet');
    const full = document.body?.innerText || '';
    const text = full.slice(start, start + maxChars);
    const result = { url: location.href, title: document.title, text, start, chars: text.length };
    if (start + maxChars < full.length) {
      result.truncated = true;
      result.next_start = start + maxChars;
    }
    return result;
  }

  // =========================================================================
  // click / fill / scroll / wait / select_option / evaluate（DOM 工具）
  // =========================================================================

  function cmdClick(params) {
    const el = resolveElement(params.selector);
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.click();
    const { tag, text } = describe(el);
    return { success: true, tag, text };
  }

  function cmdFill(params) {
    const el = resolveElement(params.selector);
    const value = params.value;

    if (el.isContentEditable) {
      el.focus();
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
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { success: true, tag: describe(el).tag, mode: 'value' };
    }

    throw new Error('fill: target is neither input/textarea nor contenteditable');
  }

  function cmdScroll(params) {
    if (params.selector) {
      resolveElement(params.selector).scrollIntoView({ block: 'center', inline: 'center' });
      return { success: true };
    }
    if (params.text) {
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

  function cmdWait(params) {
    const timeoutMs = params.timeout_ms ?? 10_000;
    const started = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        let ok = true;
        try {
          if (params.selector) {
            ok = ok && (params.selector.startsWith('@e') ? !!nodeFromRef(params.selector) : !!document.querySelector(params.selector));
          }
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

  function cmdEvaluate(params) {
    // eslint-disable-next-line no-eval
    const value = (0, eval)(params.code);
    const done = (v) => {
      let out = v;
      let json;
      try { json = JSON.stringify(v); } catch { json = undefined; }
      if (json && params.max_chars && json.length > params.max_chars) {
        out = json.slice(0, params.max_chars);
      }
      return { type: typeof v, value: out };
    };
    return value instanceof Promise ? value.then(done) : done(value);
  }

  // =========================================================================
  // 消息分发
  // =========================================================================

  const handlers = {
    click: cmdClick,
    fill: cmdFill,
    scroll: cmdScroll,
    wait: cmdWait,
    select_option: cmdSelectOption,
    evaluate: cmdEvaluate,
    snapshot: cmdSnapshot,
    find: cmdFind,
    read_page: cmdReadPage,
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
