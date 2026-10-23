# Kimi 浏览器扩展 v2.0.22 — 本地服务（daemon）WebSocket 协议逆向分析笔记

> 源码：`reverse/ext/background.js`（美化后 39,940 行，esbuild 打包 IIFE，下文以 `bg:行号` 引用）。
> 其它文件：`reverse/ext/content-scripts/record.js`、`content-scripts/selection.js`、`frame-read.js`、`manifest.json`。
> 本地服务即 "webbridge daemon"（`kimi-webbridge` 命令行启动），扩展称之为 daemon / 本地 Agent 通道。

---

## 1. WebSocket 客户端

### 1.1 地址常量与 URL 构造

bg:35864-35867：

```js
var RN = 10086,
    zN = `ws://127.0.0.1:${RN}/ws`,   // 默认 WS 地址
    BN = `http://127.0.0.1:${RN}`,    // HTTP base
    VN = `${BN}/status`;
```

连接 URL 由 `dR()` 在目标地址上追加 **query 参数 `client=<clientId>`** 构成（bg:39329-39336）：

```js
function dR(e, t) {            // e = ws url, t = clientId
  let n = new URL(e);
  return (n.searchParams.set(`client`, t), n.toString());
}
// 实际连接: new WebSocket(dR(url, clientId))   (bg:39434)
```

最终连接示例：`ws://127.0.0.1:10086/ws?client=3f6c…uuid`。

`clientId` 是扩展首次运行时生成的 `crypto.randomUUID()`，持久化在 `chrome.storage.local["ws_client_id"]`（`getClientId`，bg:39516-39521）。**没有 token、签名或任何其它鉴权参数。**

期望连接状态也持久化在 `chrome.storage.local`（bg:39315-39319）：

```js
lR = { SHOULD_CONNECT: `ws_should_connect`,   // 默认 true（!== false 即连）
       URL: `local_url`,                       // 自定义 daemon 地址（dev 模式），空 = 默认
       CLIENT_ID: `ws_client_id` };
```

### 1.2 连接建立与握手

`openSocket(url, clientId)`（bg:39430-39480）：

- `new WebSocket(dR(url, clientId))`；连接中状态超过 **10 秒**（`oR = 1e4`，bg:39312）未 open 则 `close()`。
- `open` 后立即发送握手消息（bg:39448-39453）：

```json
{ "type": "hello", "payload": { "extensionVersion": "2.0.22" } }
```

- 服务端回 `{ "type": "hello_ack" }`，扩展收到后不做任何处理（bg:39542-39543）。除此之外**没有鉴权握手**。

### 1.3 心跳与活性检测

- 双向 ping/pong（`handleMessage`，bg:39535-39541）：
  - daemon → 扩展 `{type:"ping"}` → 扩展回 `{type:"pong"}`；
  - daemon → 扩展 `{type:"pong"}` → 忽略；
  - 扩展 → daemon：在每次 reconcile 时，若已连接且链路判定存活，发送 `{type:"ping"}`（bg:39384-39387）。
- 活性判定：任何 open/message 都更新 `lastActivityAt`（`markActive`，bg:39481-39483）；若 **45 秒**（`cR = 45e3`，bg:39314）无任何流量，视为死链，主动 teardown 并重连（bg:39389-39393）。

### 1.4 重连机制

- **周期 reconcile**：`chrome.alarms` 名 `webbridge-reconcile`，每 **0.5 分钟** 触发一次（`aR = 0.5`，bg:39311-39313；注册 bg:39362-39364、39715-39717）。reconcile 读 storage 中的期望状态：shouldConnect=false → teardown；未连接 → openSocket（bg:39377-39396）。
- **快速重试**：`close` 事件后按 `sR = [1000, 3000]`（1s、3s 两次）做 fast retry（bg:39313、39500-39509）。
- **特殊关闭码 4409**：`close.code === 4409` 表示"该 daemon 已被另一个浏览器占用"，不 fast retry，只等周期 reconcile（bg:39470-39474）：

```js
e.code === 4409
  ? console.warn(`[ws] refused: this daemon is already driven by another browser. ...`)
  : this.scheduleFastRetry();
```

- 断开时回调 `onDisconnect → ri()`：清除所有 `daemon:` 标签页标记（恢复 favicon/移除指针特效，bg:39645、4374-4377）。

---

## 2. 消息封装格式

纯 JSON 文本帧，无二进制、无版本 envelope。全部消息类型（`handleMessage`/`send`，bg:39535-39579）：

### 2.1 扩展 → daemon

| 消息 | 结构 | 时机 |
|---|---|---|
| hello | `{type:"hello", payload:{extensionVersion}}` | WS open 后 |
| ping | `{type:"ping"}` | reconcile 保活 |
| pong | `{type:"pong"}` | 响应 daemon 的 ping |
| tool_result（成功） | `{type:"tool_result", responseToRequestId, payload:{data}}` | 工具执行完成 |
| tool_result（失败） | `{type:"tool_result", responseToRequestId, payload:{error: "<message>"}}` | 工具抛错 / 缺 name |

### 2.2 daemon → 扩展

| 消息 | 结构 | 扩展行为 |
|---|---|---|
| hello_ack | `{type:"hello_ack", ...}` | 忽略 |
| ping | `{type:"ping"}` | 回 pong |
| pong | `{type:"pong"}` | 忽略 |
| tool_call | `{type:"tool_call", requestId, payload:{name, args}}` | 执行工具 |
| 其它 | 任意 | `default:` 忽略（bg:39547-39549） |

### 2.3 请求匹配

`requestId` 由 **daemon 生成**（扩展源码中无生成逻辑，仅回显）。扩展用 `responseToRequestId` 原样带回（bg:39551-39575）：

```js
async handleToolCall(e) {
  let t = e.payload;
  if (!t?.name) {
    this.send({ type: `tool_result`, responseToRequestId: e.requestId,
                payload: { error: `missing tool name` } });
    return;
  }
  try {
    let n = await this.onToolCall(t.name, t.args || {});
    this.send({ type: `tool_result`, responseToRequestId: e.requestId,
                payload: { data: n } });
  } catch (t) {
    this.send({ type: `tool_result`, responseToRequestId: e.requestId,
                payload: { error: t?.message ?? String(t) } });
  }
}
```

错误只有一个 `error: string` 字段，没有错误码；`data` 为各工具自定义对象。未知名工具抛 ``Unknown tool: <name>. Available: <逗号列表>``（bg:4411-4416）。

---

## 3. 完整工具清单（25 个）

注册于 `ai()`（bg:4382-4410），派发于 `oi(name, args)`（bg:4411-4432）。**daemon 通道没有 zod/JSON schema**——参数校验全部在各工具 `execute()` 内手工完成（下表"参数"列即从校验代码还原）。sidepanel 云端模型侧另有一份 JSON Schema（`EM`，bg:34000-34469，含 description，供 LLM 使用），两者工具集基本相同（差异见 §6）。

通用规则（`oi`，bg:4417-4431）：

- `args._tabId != null` 且工具不是 `close_tab`/`list_tabs`/`close_session` 时：先 `E(tabId)` 确保 debugger attach，再 `ti(_session, tabId)` 刷新 `daemon:` 标记（60s）。
- `close_session` 额外 `ni(_session)` 立即清除该 session 的标记。
- `navigate`/`find_tab` 返回 `tabId` 后同样刷新标记。

### 公共辅助

- `E(tabId)`（bg:142-161）：`chrome.debugger.attach({tabId}, "1.3")`（先 detach 再 attach），随后 `Page.enable`。
- `D(tabId, method, params)`（bg:164-203）：`chrome.debugger.sendCommand` 封装；300s 超时（`oe = 3e5`）；若该 tab 有未处理的 JS 对话框，除 `Page.handleJavaScriptDialog`/`Page.enable` 外一律拒绝；命令执行中弹出对话框则中断报错。
- `le(_tabId)`（bg:219-225）：解析目标 tab——指定 `_tabId` → 上次使用的 tab（`ae`）→ 当前活动 tab。
- `@eN` ref 体系（bg:78-125）：snapshot 时为交互元素分配 `e1,e2,…`，映射 `backendDOMNodeId`；`T()` 校验 `/^@?e\d+$/`；导航/新 snapshot 后失效（`b(tabId)`）。
- `Gn(tabId, args, result)`（bg:2790-2806）：若 `args.snapshot === true`，等待 300ms 后在结果上附加 `page_snapshot`（AX 树）/ `page_snapshot_truncated`。
- `Un(tabId, x, y, effect)`（bg:2782-2789）：在页面注入指针视觉特效（蓝色箭头、点击波纹；`effect` ∈ `move`/`down`/`click`/`up`/`drag`），host id `kimi-webbridge-agent-visuals`，data 属性 `data-kimi-webbridge-visuals="v4"`（bg:2171-2781）。

### 工具明细表

| # | 工具名 | 类/行号 | 参数（源码校验） | 实现要点 / CDP & chrome.* API |
|---|---|---|---|---|
| 1 | `navigate` | `Ct` bg:753-848 | `url*`(string), `newTab?`, `group_title?`；读 `_session`/`_tabId` | 无可用 tab 或目标是 chrome:// → `chrome.tabs.create({url, active:false})` + 入 session tab group（`vt`）；同 URL → CDP `Page.reload{ignoreCache:true}`，否则 `Page.navigate{url}`；`waitForLoad` 监听 `chrome.tabs.onUpdated` + `Runtime.evaluate document.readyState`（30s 超时）。返回 `{success,url,tabId,frameId?}` |
| 2 | `find_tab` | `Dt` bg:865-907 | `url*`（域名后缀匹配，去 `www.`）, `active?`, `_tabIds?` | `active:true` → `chrome.windows.getLastFocused({populate})` 找前台匹配 tab（返回 `borrowed:true`）；否则遍历 `_tabIds`。返回 `{success,url,tabId,borrowed}` |
| 3 | `find` | `Pt` bg:994-1005 | `query*` | CDP `Accessibility.getFullAXTree`，按 name/value/description 模糊匹配，返回 `{url,title,query,totalMatches,matches:[{role,matchedField,path,name?,ref?,interactiveAncestorRef?}]}`（上限 20 条，bg:908-993） |
| 4 | `evaluate` | `zt` bg:1045-1085 | `code*`, `max_chars?`（或 `_maxResultChars`） | CDP `Runtime.evaluate{returnByValue,awaitPromise}`；有 max_chars 时包装成 IIFE 截断 JSON（`It` bg:1007-1021，`Lt` 截断对象含 `truncated/totalChars/note`）。返回 `{type, value}` |
| 5 | `network` | `Jt` bg:1145-1236 | `cmd*` ∈ `start/stop/list/detail`，`filter?`, `requestId?` | `Network.enable/disable`；`chrome.debugger.onEvent` 监听 `Network.requestWillBeSent/…ExtraInfo/responseReceived/loadingFinished`（`qt` bg:1118-1144）；detail 用 `Network.getRequestPostData`、`Network.getResponseBody` |
| 6 | `snapshot` | `Sn` bg:1715-1791 | `ref?`, `interactive?` | `Accessibility.getFullAXTree` → 剪枝成 AX 树（`Zt` bg:1265-1343，默认上限 60,000 字符），交互角色（`v`，bg:79-97）带 `@eN` ref；另枚举 `<input type=file>`（`en` bg:1366-1399，`DOM.getDocument/querySelectorAll/describeNode`，角色名 `file-input`）与可见 iframe（`_n` bg:1630-1650，handle `#f1..#f5`）。返回 `{url,title,tree,frames?,framesNote?,fileInputsOmitted?,truncated?,note?}` |
| 7 | `read_page` | `Nn` bg:2062-2170 | `max_chars?`（默认 60000）, `start?`, `frame?` | 主文档：CDP `Runtime.evaluate` 注入滚动取文本扫描器（`kn` bg:1882-2000，参数 `maxScreens:60, stepTimeoutMs:400, budgetMs:25000, feedEscapeLimit:3`）；子 frame：`chrome.scripting.executeScript` 注入 `/frame-read.js` 后调 `__kimiReadPage`（`bn` bg:1691-1705）；pdfjs viewer：MAIN world 调 `PDFViewerApplication.pdfDocument.getTextContent`（`Mn` bg:2009-2061）。返回 `{text,complete,screens,chars,totalChars,nextStart?,frame?,strategy?,note?}` |
| 8 | `click` | `Yn` bg:2889-2935 | `selector*`（CSS 或 `@eN`） | `Kn`（bg:2807-2829）：ref → `DOM.resolveNode`，CSS → `Runtime.evaluate document.querySelector`；`Runtime.callFunctionOn` 执行 `scrollIntoView + el.click()`（DOM 级点击，不派发鼠标事件）；先画指针特效 |
| 9 | `fill` | `Zn` bg:2995-3058 | `selector*`, `value*` | contenteditable → `execCommand('insertText')`；原生 input/textarea → 原型 value setter + 派发 `input`/`change`（`Xn` bg:2936-2993） |
| 10 | `mouse_click` | `Qn` bg:3059-3172 | `selector*` | `Runtime.callFunctionOn scrollIntoView` + `DOM.getBoxModel` 取中心点；`elementFromPoint` 遮挡检测；CDP `Input.dispatchMouseEvent` × 3（mouseMoved/mousePressed(buttons:1,clickCount:1)/mouseReleased）；页面侧 probe 验证 pointerdown/mousedown 是否送达（后台遮挡 tab 报错并建议 focus emulation） |
| 11 | `cdp` | `er` bg:3174-3201 | `method*`, `params?` | 任意 CDP 透传 `chrome.debugger.sendCommand`。**拒绝** `Target.activateTarget`（抢焦点）；`Page.bringToFront` 特判为 `tr()`（bg:3202-3227）：优先 `Emulation.setFocusEmulationEnabled{enabled:true}`（结果 `activation:"focus-emulation"`），其次 CDP `Page.bringToFront`，最后 `chrome.tabs.update{active:true}` |
| 12 | `key_type` | `ar` bg:3252-3266 | `text*` | CDP `Input.insertText{text}` |
| 13 | `send_keys` | `hr` bg:3351-3418 | `keys*`（如 `"Enter"`/`"Mod+A"`/`"Shift+Tab"`，空格分隔多组）, `repeat?` 1-100 | 修饰键表 `or`（alt/ctrl/cmd/meta/shift，`Mod` 按平台 = mac:Cmd / 其它:Ctrl，bg:3267-3285）、键表 `dr`（enter/esc/tab/arrows/F1-F12/单字符，bg:3286-3325）；CDP `Input.dispatchKeyEvent`（keyDown/keyUp + `modifiers` 位掩码 + `windowsVirtualKeyCode`） |
| 14 | `screenshot` | `gr` bg:3419-3497 | `format?` png/jpeg（jpeg 默认 quality 80）, `quality?`, `selector?` | 有 selector：`DOM.getBoxModel` border 四边形 → `clip{x,y,width,height,scale:1}`；CDP `Page.captureScreenshot{format,quality?,clip?}`；返回 `{format,dataLength,data(base64),mimeType}` |
| 15 | `scroll` | `_r` bg:3498-3549 | `direction?` up/down（默认 down）, `to?` top/bottom, `selector?`, `text?` | `Runtime.evaluate` 注入滚动脚本（找滚动根 `Cn` bg:1792-1811；文本查找滚动 `En` bg:1816-1861；方向滚动 `Dn` bg:1862-1873），返回 `{scrolled,scrollY,scrollHeight,atTop,atBottom,...}` |
| 16 | `save_as_pdf` | `yr` bg:3557-3595 | `paper_format?` letter/legal/a4/a3/tabloid, `landscape?`, `scale?` 0.1-2, `print_background?`（默认 true）, `file_name?` | CDP `Page.printToPDF{printBackground,landscape,scale,paperWidth,paperHeight,preferCSSPageSize:true}`；返回 `{data(base64),mimeType:"application/pdf",dataLength,pageTitle,requestedFileName}` |
| 17 | `upload` | `Cr` bg:3672-3768 | `selector?`, `files?`（绝对路径数组）, `attachments?`（→ `_payloads` base64） | 路径模式：CDP `DOM.setFileInputFiles{files, nodeId/backendNodeId}`（file:// 权限不足时给出引导错误 `br` bg:3596）；payload 模式：`Runtime.callFunctionOn` 用 `DataTransfer` 构造 `File` 注入并派发 input/change（`Sr` bg:3605-3671） |
| 18 | `close_tab` | `wr` bg:3769-3781 | （用 `_tabId`） | `chrome.tabs.remove`；幂等，已关闭返回 `{success:true,closed:false,reason}` |
| 19 | `list_tabs` | `Tr` bg:3782-3811 | （用 `_tabIds`） | 逐个 `chrome.tabs.get` + `chrome.tabGroups.get` 取组名；返回 `{success,tabs:[{tabId,url,title,active,groupTitle,borrowed}]}`；`borrowed` = 在 `_tabIds` 但不在 `_ownedTabIds`（bg:3812-3824） |
| 20 | `close_session` | `Or` bg:3825-3837 | （用 `_ownedTabIds` → `_tabIds` → `_tabId`） | 批量 `chrome.tabs.remove`，返回 `{success,closed}` |
| 21 | `wait` | `Mr` bg:3895-3975 | `text?`/`text_gone?`/`selector?`/`frame?`（至少一个）, `timeout_ms?`（默认 10000，钳制 500-60000，轮询 300ms） | 页面内注入轮询表达式（`jr` bg:3852-3894）；`frame` 条件用 `_n` iframe 扫描器（可等 `any`）；超时返回 `{ok:false,timedOut:true,waitedMs,note}` 而非抛错 |
| 22 | `dialog` | `Nr` bg:3976-4024 | `action*` ∈ `status/accept/dismiss`, `text?`（prompt 填值） | CDP `Page.handleJavaScriptDialog{accept,promptText?}`；对话框状态由全局监听 `Page.javascriptDialogOpening/Closed` 维护（`p()` bg:36-57） |
| 23 | `select_option` | `Fr` bg:4063-4088 | `selector*`, `values?[]`/`value?`（空 = 仅列出选项） | `Runtime.callFunctionOn` 执行原生 `<select>` 选择逻辑（`Pr` bg:4025-4062），按 value 或 label 匹配，派发 input/change |
| 24 | `hover` | `Ir` bg:4089-4121 | `selector*` | 取元素中心点（`qn` bg:2830-2872：scrollIntoView + `DOM.getBoxModel` + 视口检查）+ CDP `Input.dispatchMouseEvent{type:"mouseMoved"}` |
| 25 | `drag` | `zr` bg:4185-4244 | `from*`, `to*`（CSS 或 @ref） | JS 合成事件序列：源可拖（`draggable===true`）→ HTML5 `DragEvent`+`DataTransfer`（`Rr` bg:4157-4184，校验 dropAccepted），否则 pointer/mouse 事件序列（`Lr` bg:4122-4156，返回 `verified:false` 提示需 snapshot 确认） |

### 典型 wire 示例

```jsonc
// daemon → 扩展
{ "type": "tool_call", "requestId": "req-42",
  "payload": { "name": "navigate",
               "args": { "url": "https://example.com", "_session": "task-1" } } }

// 扩展 → daemon（成功）
{ "type": "tool_result", "responseToRequestId": "req-42",
  "payload": { "data": { "success": true, "url": "https://example.com", "tabId": 123 } } }

// 扩展 → daemon（失败）
{ "type": "tool_result", "responseToRequestId": "req-42",
  "payload": { "error": "navigate: page load timeout (30s)" } }
```

---

## 4. HTTP 端点（扩展 → 本地服务）

HTTP base 由 WS URL 推导（`HN`/`UN`/`WN`，bg:35868-35904）：ws→http、wss→https，取 origin。

| 方法+路径 | 代码位置 | 用途 | 请求/响应 |
|---|---|---|---|
| `GET {base}/status` | `UN` bg:35880-35893；调用 `xR` bg:39609-39617 | 版本漂移检测。连接/断开/`GET_STATUS` 时调用 | 响应 JSON 读取字段：`version`（semver）、`skill_mismatch`（bool）。`gR`（bg:39592-39600）：扩展 major 更高、或同 major 但 minor 更高 → drift kind `"daemon"`；`skill_mismatch` → `"skill"`，signature 形如 `"daemon+skill@2.0.22"` |
| `POST {base}/internal/upgrade` | `TR` bg:39650-39659（由 runtime 消息 `UPGRADE_DAEMON` 触发，bg:39753-39755） | 让 daemon 自升级 | 空 body；期望 `202` + `{started:true}` → 返回 `"started"`，否则 `"manual"` |
| `{base}/internal/trajectory` | 仅在 `WN` 构造（bg:35900） | **v2.0.22 中无任何调用点**（全文 grep 仅定义处），疑为旧版本/预留 | — |
| `{base}/internal/sidepanel-control` | 仅在 `WN` 构造（bg:35901） | 同上，未使用 | — |

其它 HTTP（**非本地 daemon**，列出以免混淆）：

- 遥测：`POST https://gator.volces.com/sdk/log`，header `X-MCS-AppKey: 2d4280f8…`（Volcengine DataFinder，`Oo` bg:7194-7209；事件名 `webbridge_*`）。
- 云端配对：`POST ${serverBase}/api/connections`（runtime 消息 `GENERATE_CONNECTION`，bg:39762-39769；serverBase 由 UI 传入，属 Kimi 云）。
- sidepanel 云端模型/登录：`https://agent-gw.kimi.com` 等（`Io` bg:7252-7259，oauth token 端点有 http→仅 localhost 的防线 `gy` bg:17892-17909）。

---

## 5. 会话模型（`_session` / `_tabId` / `daemon:` 标记）

### 5.1 daemon 通道

- `_session`：**由 daemon 在 tool_call 的 args 里下传**的字符串会话名（扩展不生成、不校验格式）。扩展将其用于：
  1. **标签分组**：`navigate` 新建 tab 时 `vt(tabId, _session, group_title)`（bg:688-701）把 tab 放入标题为 `agent:<session>` 的 tab group（`Ze` bg:555-557；`group_title` 可覆盖显示名），分组颜色按 session 轮换（bg:638-647、732-751）。
  2. **`daemon:` 标记键**（见 §5.3）。
- `_tabId`：daemon 用之前 `navigate`/`find_tab` 返回的 `tabId` 回填，指定操作目标。缺省时 `le()` 依次回退：上次工具用过的 tab（`ae`，`ue()` bg:226-228 在 navigate/find_tab 后更新）→ 当前窗口活动 tab（bg:219-225）。
- `list_tabs`/`close_session`/`find_tab` 还可读 `_tabIds`（会话涉及的全部 tab）与 `_ownedTabIds`（会话"拥有"的 tab，borrowed=用户已有被借用的 tab 不在其列）——这些字段在 sidepanel 通道由扩展注入（§5.2），daemon 通道则由 daemon 自行维护下传。

### 5.2 sidepanel 通道（对照）

sidepanel 每个会话是 `chat-<uuid>`（`Ae="chat-"`，`et()` bg:566-568），会话绑定关系持久化：

- `chrome.storage.local["sidepanel_task_group_bindings"]`：`groupId → {sessionName, title, updatedAt}`（`Me` bg:330，`Fe` bg:354-381）；
- `chrome.storage.session["sidepanel_tab_bindings"]`：`tabId → {sessionName, updatedAt}`（`Be` bg:437，`Ue` bg:460-483）；
- tab group 标题 `agent:<sessionName>` 本身就是跨重启的发现机制（`_t`/`tt` bg:569-600、668-687）。

工具执行前由 `HM()` 包装器注入（bg:34738-34758）：`_session`、`_tabId`、（list_tabs/close_session/find_tab 时）`_tabIds`/`_ownedTabIds`、`evaluate`/`read_page` 的 `_maxResultChars`、upload 的 `_payloads`。注意 HM 会**剥离所有 `_` 前缀入参**再重新注入（bg:34739-34741），sidepanel 模型无法伪造这些字段。

### 5.3 `daemon:` 前缀（标签页"被遥控"可视标记）

bg:4349-4377：

```js
var Xr = `daemon:`, Zr = 6e4, Qr = new Map();
function $r(e) { return Xr + (e ?? `default`); }   // key = "daemon:<session>"
```

- 每当 daemon 工具调用涉及某 tab（`oi` bg:4419-4429），`ti(_session, tabId)` 将该 tab 的 favicon 换成蓝色箭头 SVG（`Br` bg:4245）、并在页面挂载遥控指针特效层（`Vr()` bg:4246-4272 + `Bn()`），同时启动 **60 秒** 倒计时（`Zr = 6e4`）。
- 倒计时内无新工具调用 → `Yr(key)` 恢复原 favicon、移除特效层（`Hr()` bg:4273-4302）。即"标记"是租约式的：daemon 活跃操作期间 tab 持续显示被控状态。
- `close_session` → `ni(_session)` 立即清除该 session 全部标记（bg:4370-4373）；WS 断开 → `ri()` 清除所有 `daemon:*` 标记（bg:4374-4377，挂接于 `onDisconnect` bg:39645）。
- tab 导航完成（onUpdated complete）会重放标记（`Gr()` bg:4305-4319）。
- 所以 `daemon:` 只是该可视标记功能的 **storage/map key 前缀**，与协议报文无关，但 Safari 重实现时若要做"被控标签"UI，这套租约语义可照搬。

另：`chrome.storage.session["wb-browser-session"]`（`KN` bg:35951，`XN` bg:35958-35976）是**浏览器实例级** UUID，仅用于 sidepanel 聊天记录（`browser_session` 记录，bg:36292），与 daemon 协议无关。

---

## 6. sidepanel 聊天通道 vs 本地 Agent 通道

**两条完全独立的通道**，仅共享底层工具类：

| | 本地 Agent（daemon）通道 | sidepanel 通道 |
|---|---|---|
| 传输 | WebSocket `ws://127.0.0.1:10086/ws?client=<uuid>` | `chrome.runtime` Port（名 `sidepanel-mirror`，bg:39667-39669、37713+）+ `chrome.runtime.sendMessage` |
| 对端 | 本地 daemon（Kimi Work 等） | 扩展自身 sidepanel.html |
| 工具入口 | `oi()`（bg:4411），25 个工具（含 `cdp` 透传），**无权限询问** | `DM` map + `HM()` 包装（bg:34518-34800），**无 `cdp`**，多了 `agent`（子代理，`UM` bg:34801+）、`skill`/`save_skill`/`delete_skill`/`run_saved_skill`、`await_user_action`（`qM` bg:34915+）；每个工具有 `permissionAction` 权限门（`RM` bg:34579-34585，可按域名授权） |
| 会话 | daemon 下传 `_session` | `chat-<uuid>`，扩展自管理绑定 |
| LLM | 在 daemon 侧 | 在扩展侧，走 Kimi 云（agent-gw.kimi.com） |

sidepanel 专用消息（均不走 WS）：

- Port `sidepanel-mirror` 的 `kind`：`subscribe / send / dispatch / runWorkflow / stop / retry / undoTurn / stageOriginal / discardOriginal / queueRemove / compact / generateAgentSkill / permission`（`FF` bg:37713-37832）。
- runtime sendMessage 类型：`GET_STATUS`、`CONNECT`、`RECONCILE_NOW`、`UPGRADE_DAEMON`、`DISCONNECT`、`TEST_CONNECTION`、`GENERATE_CONNECTION`、`SWEEP_ORPHAN_CONVERSATIONS`、`HISTORY_LIST/OPEN/DELETE/RENAME/TITLE`、`STORAGE_QUOTA_REPORT`、`TELEMETRY_EVENT`（`GL`，bg:39145）等（bg:39718-39829）。其中 `HISTORY_*` 有来源校验（发送者 url 必须是扩展自身，bg:39778-39781）。
- 扩展 → sidepanel 广播 `{type:"DAEMON_STATUS", connected, serverUrl, drift}`（`SR` bg:39618-39628），sidepanel 用它显示"已连接/版本不匹配"。
- content scripts（`record.js`/`selection.js`）→ background：`RECORD_STEP / RECORD_RRWEB / RECORD_QUERY / SIGNIFICANT_CHANGE / START|STOP|CANCEL|PAUSE|RESUME_RECORDING / RETRY_DISTILL / REDISTILL_REVIEW`（bg:26838-26930、39720-39732）——这是"录制工作流"功能（内嵌 rrweb），与 daemon 协议无关。

---

## 7. 鉴权与安全机制

1. **WS 无鉴权**：无 token、无签名、无 Origin 校验代码。唯一标识是 query `client=<uuid>`（bg:39329-39336）。安全模型依赖：① daemon 默认只监听 `127.0.0.1`；② daemon 侧单客户端策略——已被占用时以 **close code 4409** 拒绝新连接（bg:39470-39474）。
2. **自定义连接地址（dev 模式）**：设置页可填任意 `ws://`/`wss://` 地址（可省略前缀），校验规则见 i18n 文案（bg:4577-4586）：只允许 ws/wss、不支持 IPv6 `[::1]`、本机只接受 `127.0.0.1`（其它 127.x 拒绝）。保存前弹出信任确认（bg:4590-4594："该服务将获得控制你浏览器的权限…仅在你完全信任该服务端时继续"，ws:// 额外提示未加密）。`TEST_CONNECTION` 仅验证能 open（bg:39397-39426）。
3. **CSP**（manifest.json:23）：`connect-src 'self' ws://*:* wss://*:* http://*:* https://*:* …`——扩展页允许连任意 ws/wss。
4. **权限**：`debugger`（CDP 全部能力来源）、`tabs/tabGroups/windows/webNavigation/scripting/sidePanel/alarms/storage/unlimitedStorage`、`<all_urls>`（manifest.json:40, 27）。
5. **消息来源校验**：`HISTORY_*` 校验 `sender.url` 前缀为扩展自身（bg:39778-39781）；其余 runtime 消息默认信任（Chrome 扩展内消息通道本身隔离网页）。
6. **云端 OAuth**（sidepanel 登录，非 daemon）：token 端点仅允许 https，或 http+localhost/127.0.0.1/::1（`gy` bg:17892-17909）。
7. **CDP 自我保护**：`cdp` 工具拒绝 `Target.activateTarget`（防抢用户焦点，bg:3182-3185）；`Page.bringToFront` 改写为优先 focus emulation（bg:3189、3202-3227）。

---

## 附：Safari 重实现要点提示

- MV2/MV3 差异：心跳需自行保持（Safari web extension 的 background page 常存，alarm 可用 `browser.alarms`）。
- `chrome.debugger` 在 Safari 不存在 → 所有 CDP 工具（evaluate/snapshot/screenshot/Input.*/Network.*）需要用 `browser.tabs.executeScript`/`scripting` + 注入脚本重写，或接受能力降级（无 `mouse_click` 的真实输入、`Page.captureScreenshot`、`cdp` 透传）。
- tab group、favicon 替换（`chrome.favicon` 实为页面注入换 icon）在 Safari 需替代方案。
- 协议层（§1/§2）与工具参数/返回结构（§3）与浏览器无关，可原样兼容；daemon 侧只需看到同样的 `hello`/`tool_result` 报文与 25 个工具名。
