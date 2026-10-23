# Kimi WebBridge 协议规范（逆向整理）

> 来源：Kimi Browser Extension v2.0.22/2.0.23 扩展源码静态分析（`reverse/notes/websocket-protocol-analysis.md`）、daemon v2.0.23 二进制字符串与实测、官方 skill 包（`reverse/skill/kimi-webbridge/SKILL.md`）。
> 用途：在 Safari 上实现一个兼容扩展，接入**同一个本地 daemon**，使所有本地 Agent（Claude Code、Cursor、Kimi Code…）零改动可用。

## 0. 总体架构

```
本地 Agent (Claude Code / Cursor / …)
    │  HTTP POST /command  {"action","args","session"}
    ▼
kimi-webbridge daemon（Go，127.0.0.1:10086，~/.kimi-webbridge/）
    │  WebSocket /ws?client=<uuid>   ← 本协议的核心
    ▼
浏览器扩展（Chrome 官方 / 我们的 Safari 移植）
    │  chrome.debugger (CDP) / DOM 注入
    ▼
网页（携带用户真实登录态）
```

关键结论：**daemon 与浏览器无关**。Safari 扩展只需实现下述 WS 协议 + 25 个工具的浏览器侧执行，即可复用现有 daemon 与全部 Agent 生态。

## 1. Agent ↔ daemon：HTTP API

- **端点**：`POST http://127.0.0.1:10086/command`
- **请求**：`{"action": "<工具名>", "args": {...}, "session": "<任务名>"}`
- **响应信封**：成功 `{"ok":true,"data":…}`；失败 `{"ok":false,"error":{"code","message"}}`
  - 典型错误码：`extension_not_connected`、`bad_request`
- **其他 HTTP 端点**：
  - `GET /status` → `{running, port, version, uptime_seconds, extension_connected, extension_id, extension_version, skills[], tab_id_arg, update_available?/version_mismatch?/skill_mismatch?}`
  - `POST /internal/upgrade`（扩展触发 daemon 自升级；202 + `{started:true}`）
  - `POST /internal/trajectory`（需 chatId；v2.0.22 扩展侧未调用，预留）
  - `POST /internal/sidepanel-control`（预留）
- daemon 负责把 HTTP `/command` 翻译成 WS `tool_call`，并把 `session` 映射为 args 内的 `_session`，同时维护/下传 `_tabId`、`_tabIds`、`_ownedTabIds`（会话的当前 tab、全部 tab、自有 tab）。
- 截图/PDF：daemon 落盘后返回 `{path, sizeBytes, mimeType}`（扩展经 WS 返回 base64，daemon 写盘）。

## 2. 扩展 ↔ daemon：WebSocket 协议

### 2.1 连接

- URL：`ws://127.0.0.1:10086/ws?client=<uuid>`；client UUID 由扩展首启生成并持久化（Chrome 存 `storage.local["ws_client_id"]`）。
- **无 token/签名/Origin 校验**；安全依赖 loopback 绑定 + daemon 单客户端（被占用时新连接收 **close code 4409**）。
- 连接 10s 未 open 则放弃重试。

### 2.2 握手与心跳（纯 JSON 文本帧）

| 方向 | 消息 | 说明 |
|---|---|---|
| ext→daemon | `{"type":"hello","payload":{"extensionVersion":"2.0.22"}}` | open 后立即发送 |
| daemon→ext | `{"type":"hello_ack"}` | 扩展忽略内容 |
| 双向 | `{"type":"ping"}` / `{"type":"pong"}` | 心跳；任何流量刷新活跃时间 |
| — | 45s 无流量 → 判死链重连；每 30s 周期 reconcile；断开后 1s/3s 快速重试（4409 除外） | |

### 2.3 工具调用

```jsonc
// daemon → 扩展
{ "type": "tool_call",
  "requestId": "req-42",                       // daemon 生成
  "payload": { "name": "navigate",
               "args": { "url": "https://example.com", "_session": "task-1", "_tabId": 123 } } }

// 扩展 → daemon（成功）
{ "type": "tool_result", "responseToRequestId": "req-42",
  "payload": { "data": { "success": true, "url": "https://example.com", "tabId": 123 } } }

// 扩展 → daemon（失败：只有 message 字符串，无错误码）
{ "type": "tool_result", "responseToRequestId": "req-42",
  "payload": { "error": "navigate: page load timeout (30s)" } }
```

- 缺 `name` → 回 `{payload:{error:"missing tool name"}}`；未知工具 → `Unknown tool: <name>. Available: <列表>`。
- 未知 `type` 一律忽略。

### 2.4 工具清单（25 个）

下表中「CDP 依赖」标注了 Safari 移植时需要重写的部分（详见 §4）。

| 工具 | 参数 | 返回（`data`） | Chrome 实现 | CDP 依赖程度 |
|---|---|---|---|---|
| `navigate` | `url*`, `newTab?`, `group_title?` | `{success,url,tabId,frameId?}` | tabs.create + Page.navigate/reload，30s 加载等待 | 中（可用 tabs.update + onUpdated 替代） |
| `find_tab` | `url*`（域名后缀匹配）, `active?` | `{success,url,tabId,borrowed}` | windows/tabs 查询 | 无 |
| `find` | `query*` | `{query,totalMatches,matches:[…ref…]}` | Accessibility.getFullAXTree 模糊匹配 | **高**（需自研 DOM 可达性树） |
| `snapshot` | `ref?`, `interactive?`, `format:"aria"`?, `max_chars?`, `cursor?` | `{url,title,tree}` / `{url,title,tree_text,truncated?,next_cursor?}` | Accessibility.getFullAXTree 剪枝 + `@eN` ref 体系 + iframe/file-input 枚举 | **高**（需自研） |
| `read_page` | `max_chars?`(默认60000), `start?`, `frame?` | 页面文本 | Runtime.evaluate 滚动取文本；PDF 走 PDFViewerApplication | 低（纯 JS 注入） |
| `evaluate` | `code*`, `max_chars?` | `{type,value}` | Runtime.evaluate{returnByValue,awaitPromise} | 低（scripting.executeScript 可替代） |
| `click` | `selector*`（CSS 或 @eN） | `{success,tag,text}` | scrollIntoView + `el.click()`（DOM 级合成，isTrusted=false） | 低（content script 直接可做） |
| `fill` | `selector*`, `value*` | `{success,tag,mode}` | input/textarea 用原生 value setter+事件；contenteditable 用 execCommand | 低 |
| `mouse_click` | `selector*` | — | getBoxModel 中心点 + Input.dispatchMouseEvent（可信输入） | **高**（Safari 无等价物，只能降级为 click） |
| `key_type` | `text*` | — | Input.insertText | 中（可用 fill/事件替代） |
| `send_keys` | `keys*`（"Enter"/"Mod+A"）, `repeat?` | — | Input.dispatchKeyEvent + modifiers 位掩码 | 中（可合成 KeyboardEvent，isTrusted=false） |
| `hover` | `selector*` | — | Input.dispatchMouseEvent mouseMoved | 中（合成事件降级） |
| `drag` | `from*`, `to*` | — | HTML5 DragEvent 或合成 pointer/mouse 序列 | 低 |
| `cdp` | `method*`, `params?` | 原始 CDP 响应 | chrome.debugger 透传（拒 Target.activateTarget） | **无法实现**（Safari 无 CDP，返回不支持错误） |
| `network` | `cmd*`(start/stop/list/detail), `filter?`, `requestId?` | 请求列表/详情 | Network.enable + 事件监听 + getResponseBody | **高**（Safari 无 Network 域；可用 performance/资源计时部分降级） |
| `screenshot` | `format?`, `quality?`, `selector?` | `{format,data(base64),mimeType}` | Page.captureScreenshot（元素级用 clip） | 中（`tabs.captureVisibleTab` 替代；**不支持元素级裁剪**，可用 Canvas 后处理） |
| `save_as_pdf` | `paper_format?`, `landscape?`, `scale?`, `print_background?`, `file_name?` | `{data(base64),mimeType,pageTitle}` | Page.printToPDF | **高**（Safari 无等价 API） |
| `upload` | `selector?`, `files?`(绝对路径)/`_payloads`(base64) | `{success,fileCount}` | DOM.setFileInputFiles / DataTransfer 注入 | 中（DataTransfer 方式可纯 JS 实现） |
| `scroll` | `direction?`/`to?`/`selector?`/`text?` | — | Runtime.evaluate 滚动脚本 | 低 |
| `wait` | `text?`/`text_gone?`/`selector?`/`frame?`, `timeout_ms?` | `{ok}` 或 `{ok:false,timedOut:true}` | 页面内 300ms 轮询 | 低 |
| `dialog` | `action*`(status/accept/dismiss), `text?` | — | Page.handleJavaScriptDialog | 中（可用注入覆盖 window.alert/confirm 预拦截） |
| `select_option` | `selector*`, `values?[]`/`value?` | — | callFunctionOn 原生 select 逻辑 | 低 |
| `list_tabs` | — | `{success,tabs:[{tabId,url,title,active,groupTitle,borrowed}]}` | tabs.get + tabGroups.get | 低（Safari 无 tabGroups → groupTitle 恒 null） |
| `list_browser_tabs` | — | `{success,tabs:[{tabId,windowId,url,title,active}]}` | tabs.query | 低 |
| `attach_tab` | `tabId` | `{success,tabId,url,title,borrowed}` | tabs.get 校验 | 低 |
| `close_tab` | — | `{success,closed}` | tabs.remove | 低 |
| `close_session` | — | `{success,closed:<int>}` | 批量 tabs.remove | 低 |

通用规则：args 带 `_tabId` 且工具非 close_tab/list_tabs/close_session → 扩展 attach 该 tab 并刷新 `daemon:<session>` 标记（60s 租约）；navigate/find_tab 返回 tabId 后同样刷新。

### 2.5 会话与视觉标记（可选实现）

- 一个 session = 一个 tab group，标题 `agent:<session>`（`group_title` 覆盖显示名）。
- 被遥控的 tab：favicon 替换为蓝色箭头 SVG + 指针特效层，60s 租约，工具调用续期，断开/close_session 恢复。
- Safari 没有 tabGroups API → 跳过 tab group，仅维持 session→tabs 映射即可（daemon 侧状态由 daemon 自己维护，扩展只需正确返回 tabId）。

## 3. 安全模型

1. WS 无 token/签名，但 **daemon 校验 WS 握手的 Origin 头白名单**（v2.0.23 实测）：
   - 只接受官方扩展 ID 的 origin（二进制硬编码：`fldmhceldgbpfpkbgopacenieobmligc` = Chrome 官方，另有两个 ID 疑为 Edge/其他渠道）
   - 无 Origin、随机 `chrome-extension://*`、其他 scheme → **HTTP 403 拒绝升级**（浏览器侧表现为 WS error + close 1006）
   - **对 Safari 移植的影响**：Safari 扩展 origin 为 `safari-web-extension://<uuid>`，必被 403。**解决方案：本地 Origin 伪装中转**——扩展连 `ws://127.0.0.1:12086/ws`（自研 relay），relay 以官方 Origin 转发到 daemon。已实现并验证：`reverse/proxy/tap.js`（fake safari origin → 收到 hello_ack）。
2. 其余防护：loopback 绑定 + daemon 单客户端（4409）。
3. 扩展侧对自定义连接地址有 ws/wss + 127.0.0.1 白名单校验与信任确认对话框。
4. manifest CSP 需允许 `connect-src ws://*:* wss://*:* http://*:* https://*:*`（Safari 移植时照抄）。
5. `cdp` 工具拒绝 `Target.activateTarget`；`Page.bringToFront` 优先用 focus emulation。

## 4. Safari 移植影响总结

| 层 | 结论 |
|---|---|
| WS 协议层 | 与浏览器无关，**原样实现即可**（hello/ping/pong/tool_call/tool_result） |
| 无 CDP 工具（navigate/find_tab/evaluate/click/fill/scroll/wait/select_option/list_*/attach/close_*） | 用 `tabs.*` + `scripting.executeScript` + content script 重写，占工具数一半以上 |
| `snapshot`/`find` | 最大工作量：需在 content script 内自研 accessibility tree 序列化 + `@eN` ref 体系（保持 ref 稳定性语义） |
| `screenshot` | `tabs.captureVisibleTab`（Safari 支持且不需 all_urls）；元素级裁剪用 drawWindow 不可用 → 可用 canvas 截取或降级整屏 |
| `mouse_click`/`send_keys`/`key_type`/`hover` | Safari 无 Input 域 → 合成 DOM 事件降级（isTrusted=false，SKILL.md 已声明此限制可接受） |
| `network`/`save_as_pdf`/`cdp` | 无 Safari 等价物 → 返回 `error`（daemon 会包装为 ok:false），或 network 用 PerformanceResourceTiming 部分降级 |
| 侧边栏 | Safari 无 sidePanel → content script 注入 iframe（CSP 需 `frame-src 'self'` 或用 Shadow DOM UI） |
| 心跳保活 | Safari MV3 background 为非持久 → 用 `alarms`（30s）保活 reconcile，与 Chrome 版一致 |

## 5. 实测记录

静态分析已全部经**真实流量抓包验证**（`reverse/proxy/captures/capture-2026-10-23T07-08-39-430Z.jsonl`，扩展 v2.0.23 ↔ daemon v2.0.23 经 12086 端口代理）：

- **握手**（逐字帧）：
  ```
  → GET /ws?client=9240fb64-aeb4-4821-9735-b9bdde18b6b3
  ext→daemon  {"type":"hello","payload":{"extensionVersion":"2.0.23"}}
  daemon→ext  {"type":"hello_ack","payload":{"daemonVersion":"v2.0.23"}}   // 注意有 payload
  双向周期性 {"type":"ping"} / {"type":"pong"}；扩展另定期 GET /status
  ```
- **tool_call**（requestId 为 UUID；daemon 自动向 args 注入 `_session`/`_tabId`/`_tabIds`/`_ownedTabIds`）：
  ```jsonc
  {"type":"tool_call","requestId":"bc596643-…","payload":{"name":"snapshot",
    "args":{"_ownedTabIds":[647777570],"_session":"proto-verify","_tabId":647777570,
            "_tabIds":[647777570],"format":"aria","max_chars":800}}}
  ```
- **tool_result**：`responseToRequestId` 原样回显；snapshot aria 响应含 `ref_policy:"stable-node"`、`truncated:true`、`next_cursor:"<uuid>:800"`（游标 = 快照 id + 字符偏移）。
- **screenshot**：扩展回 `{"format","dataLength","data":<base64>}`，daemon 落盘后给 Agent 返回 `{path,sizeBytes,mimeType}`（落盘目录 `/var/folders/…/T/kimi-webbridge-screenshots/`）。
- 无扩展时：`GET /status` → `{"extension_connected":false,…}`；`POST /command` → `{"ok":false,"error":{"code":"extension_not_connected",…}}`。
