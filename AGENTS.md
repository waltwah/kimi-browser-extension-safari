# AGENTS.md — Kimi Browser Extension Safari 移植

## 项目目标

开发一个 **Safari Web Extension**，接入 Kimi WebBridge 的本地 daemon（`kimi-webbridge`，`127.0.0.1:10086`），让本地 AI Agent（Claude Code、Cursor、Kimi Code 等）能够像控制 Chrome 一样控制 Safari——导航、点击、填表、截图、读取页面内容，复用用户真实登录态。

官方只提供 Chrome/Edge 扩展；本项目通过逆向其扩展↔daemon 的 WebSocket 协议，在 Safari 上实现兼容端。**核心洞察：daemon 与浏览器无关，Safari 扩展只需复刻 WS 协议层 + 工具执行层，Agent 生态零改动可用。**

## 必读文档（先读再动手）

| 文档 | 内容 | 何时读 |
|---|---|---|
| [PROTOCOL.md](PROTOCOL.md) | **协议规范**：WS 握手/心跳/消息封装、25 个工具的参数与返回、Safari 移植影响分级 | 写任何协议/工具代码前 |
| [RESEARCH.md](RESEARCH.md) | Safari Web Extension 开发限制调研（无 sidePanel、无 CDP、打包分发方式） | 涉及 Safari API 选型时 |
| [reverse/notes/websocket-protocol-analysis.md](reverse/notes/websocket-protocol-analysis.md) | 扩展源码逐行分析（带行号证据） | 需要协议细节、行为边界时 |
| [reverse/skill/kimi-webbridge/SKILL.md](reverse/skill/kimi-webbridge/SKILL.md) | 官方 Agent 侧 API 文档（工具语义、会话约定、限制） | 实现具体工具时对照语义 |

## 仓库结构

```
├── AGENTS.md            ← 本文件
├── RESEARCH.md          ← Safari 扩展开发调研
├── PROTOCOL.md          ← 逆向出的协议规范（最重要）
├── reverse/             ← 逆向工程产物（只读参考，勿改动原始文件）
│   ├── ext/             ← 官方 Chrome 扩展 v2.0.22 解包 + prettier 美化后的源码
│   │   ├── background.js        （4 万行美化后，WS 客户端 + 25 工具实现）
│   │   ├── content-scripts/     （record.js / selection.js）
│   │   └── manifest.json        （权限与 CSP 参考）
│   ├── skill/           ← 官方 skill 包（Agent 侧 API 文档）
│   ├── notes/           ← 分析笔记
│   └── proxy/           ← WS 抓包代理（tap.js，见下文"动态验证"）
└── extension/           ← 【待创建】Safari/Chrome 跨浏览器扩展源码（MV3）
```

## 协议速查（实现时的最小知识集）

- 扩展连接 `ws://127.0.0.1:10086/ws?client=<uuid>`（uuid 首启生成并持久化），无鉴权；daemon 单客户端，冲突收 close code **4409**（不做快速重连）。
- open 后发 `{"type":"hello","payload":{"extensionVersion":"x.y.z"}}` ← daemon 回 `hello_ack`；双向 `ping`/`pong` 心跳；**45s 无流量判死链**；30s 周期 reconcile + 断开后 1s/3s 快重试。
- daemon→ext：`{"type":"tool_call","requestId":"<uuid>","payload":{"name","args"}}`；daemon 会向 args 注入 `_session`/`_tabId`/`_tabIds`/`_ownedTabIds`（下划线前缀字段是 daemon 的，勿删改、勿伪造）。
- ext→daemon：`{"type":"tool_result","responseToRequestId":<原样回显>,"payload":{"data":…}}` 或 `{"payload":{"error":"<message 字符串>"}}`（无错误码字段）。
- 未知 type 忽略；缺 name 回 `missing tool name`；未知工具回 `Unknown tool: …`。
- 扩展还会 `GET /status`（版本漂移检测）和 `POST /internal/upgrade`（触发 daemon 升级）。

## Safari 平台约束（写代码前必记）

- **无 `chrome.debugger`/CDP**：`mouse_click`、`send_keys`、`network`、`save_as_pdf`、`cdp` 无法 1:1 实现 → 降级为 DOM 合成事件或直接返回 `error`。允许降级，但错误消息要清晰。
- **无 `chrome.sidePanel`**：侧边栏用 content script 注入 iframe/Shadow DOM 实现。
- **无 `tabGroups`**：`list_tabs` 的 `groupTitle` 返回 `null`；session→tabs 映射由 daemon 维护，扩展只需正确返回 `tabId`。
- **截图**：用 `tabs.captureVisibleTab`（Safari 支持且不需要 all_urls 权限）；元素级裁剪需 canvas 后处理或降级整屏。
- **background 非持久（MV3）**：WebSocket 保活用 `chrome.alarms`（30s）驱动 reconcile，与官方 Chrome 版同策略。
- **CSP 照抄官方**：`connect-src 'self' ws://*:* wss://*:* http://*:* https://*:*`。
- `snapshot`/`find` 是最大工作量：需在 content script 自研 accessibility tree 序列化 + `@eN` ref 体系（ref 策略 `stable-node`：同节点跨快照保持稳定）。
- 其他 Safari API 差异（`scripting.executeScript` 无 `injectImmediately`、`storage.sync` 不同步等）见 RESEARCH.md §3。

## 开发环境与工作流

- 本机：macOS 26.6.2，**Xcode 27.0 已装**（`/Applications/Xcode.app`），Node 26 + npm，Python 3.9。
- ⚠️ `xcode-select` 指向 CommandLineTools，`xcrun safari-web-extension-packager` 不可用；用完整路径 `/Applications/Xcode.app/Contents/Developer/usr/bin/safari-web-extension-packager`，或 `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`。
- ⚠️ npm 缓存目录权限损坏（`~/.npm` 属 root），所有 npm/npx 命令必须加：
  `npm_config_cache=/Users/waltwah/Documents/develop/kimi_browserExtension/.npm-cache`
- 打包命令（扩展源码在 `extension/` 时）：
  ```bash
  /Applications/Xcode.app/Contents/Developer/usr/bin/safari-web-extension-packager ./extension \
    --app-name "KimiBridgeSafari" --bundle-identifier com.example.kimibridge \
    --swift --macos-only --copy-resources --no-open --force
  ```
- Safari 调试：开发期 Xcode 工程选 "Sign to Run Locally" + Safari 设置 > Developer > "Allow unsigned extensions"（每次退出 Safari 重置）；也可 Safari > 设置 > Developer > "Add Temporary Extension…" 免 Xcode 快速验证（24h 失效）。

## 联调与测试

- **真实 daemon 联调**：本机 daemon 正在运行（`~/.kimi-webbridge/bin/kimi-webbridge status` 查看）。扩展连上后，用 curl 注入命令即可端到端测试：
  ```bash
  curl -s http://127.0.0.1:10086/status
  curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' \
    -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true},"session":"dev-test"}'
  ```
- **动态抓包验证**（协议行为不确定时）：`cd reverse/proxy && node tap.js`（12086→10086 双向记录 WS 帧到 `captures/*.jsonl`），把扩展连接地址临时指向 `ws://127.0.0.1:12086/ws`，测试完改回 `ws://127.0.0.1:10086/ws`。
- **勿动用户正在用的 Chrome 扩展连接状态**：测试结束后确认官方扩展已改回默认地址并显示 Connected；用 `close_session` 清理测试标签页。
- daemon CLI：`start/stop/restart/status/logs/upgrade/install-skill`。**不要自动运行 stop/restart/upgrade/uninstall**（会杀掉用户正在用的 daemon）。

## 代码约定

- 扩展用**无构建依赖的 MV3 原生 JS** 起步（与官方包结构对齐，便于用 packager 转换和跨浏览器调试）；后续如需框架再引入。
- 同时兼容 `chrome.*` 与 `browser.*` 命名空间：入口做一层薄封装，不要在业务代码里散落判断。
- 工具实现按 PROTOCOL.md §2.4 表格逐行对齐参数/返回结构；与官方行为不一致处必须注释说明原因（通常是 Safari 降级）。
- 逆向参考代码（`reverse/ext/`）版权归 Moonshot AI：**参考行为与协议，不要原样复制代码**。

## 当前进度

- [x] 官方文档调研（无开发文档，仅使用文档）
- [x] Safari 扩展开发资料调研 → RESEARCH.md
- [x] WS 协议逆向（静态 + 抓包双验证）→ PROTOCOL.md
- [x] `extension/`：MV3 骨架（manifest、background WS 客户端、hello/心跳/reconcile、4409 处理、工具派发）
- [x] 第一批工具（无 CDP 依赖）：navigate / find_tab / list_tabs / list_browser_tabs / attach_tab / close_tab / close_session / evaluate / click / fill / scroll / wait / select_option
- [x] screenshot（captureVisibleTab；selector 裁剪暂降级为整屏 + note）
- [x] 降级错误路径：cdp / network / save_as_pdf / mouse_click（返回明确 error）
- [x] **Safari 实机端到端联调通过**（2026-10-23）：Chrome 对照验证 + Safari 临时扩展验证，navigate/evaluate/click/wait/scroll/screenshot/list_tabs/find_tab/close_session 全链路 OK
- [x] **snapshot / find / read_page + @eN ref 体系**（2026-10-23 Safari 实机验收通过：aria 树/stable-node/截断游标续读/find 匹配/ref 定位 fill 全链路 OK）
- [x] **upload / hover / key_type / send_keys / dialog / drag**（2026-10-23 Safari 实机验收：Enter 提交表单跳页、dialog MAIN-world 预拦截 confirm、upload base64 注入文件全过）→ **25 工具全覆盖**
- [x] **relay 产品化 + launchd 常驻**（2026-10-23：`relay/relay.js` 零依赖 Origin 伪装中转，已装 `com.kimibridgesafari.relay` LaunchAgent，登录自启、崩溃自动拉起）
- [ ] Xcode 正式打包分发（当前用临时扩展足够开发）
- [ ] （可选）iframe 侧边栏 UI

### 联调期关键架构事实（实测，优先级高于通用文档）

1. **daemon Origin 白名单**：WS 握手只认官方扩展 origin，Safari/未打包扩展直连必 403 → 需要本地 Origin 伪装中转。**生产版**：`relay/relay.js`（零依赖，已 launchd 常驻，见 `relay/install.sh`，卸载 `--uninstall`）；**开发抓包版**：`cd reverse/proxy && node tap.js`（帧日志到 captures/，与常驻 relay 同占 12086，用前停服务或设 `KIMI_RELAY_PORT`）。
2. **Safari 扩展 SW 不支持 WebSocket**（静默失败）→ Safari 用 MV2 式非持久背景页变体，构建产物在 `dist/safari/`（由 extension/ 拷贝 + manifest 替换 `background.scripts`/`persistent:false`）。改动 extension/ 后重建：
   ```bash
   rm -rf dist/safari && mkdir -p dist/safari && cp -R extension/* dist/safari/ && python3 -c "
   import json; m = json.load(open('extension/manifest.json'))
   m['background'] = {'scripts': ['background.js'], 'persistent': False}
   json.dump(m, open('dist/safari/manifest.json','w'), ensure_ascii=False, indent=2)"
   ```
3. Safari 安装方式：设置 → Developer → Add Temporary Extension → 选 `dist/safari/`；改代码后 Temporary 列表里点 Reload。
4. 扩展内自动适配：Safari UA 优先连 relay 12086，Chrome 先直连 10086 失败再回退 relay（background.js `FALLBACK_WS_URLS`）。
5. 自检面板：工具栏 K 图标 → popup 显示 `dbg_*` 状态（bg_evaluated/ua/connect_attempt/ws_open…）；同时 dbgLog 会 fetch 上报到 relay `/probe`（联调稳定后移除该 fetch）。
6. ⚠️ 多客户端互斥：Chrome unpacked、Safari 临时扩展、官方扩展同时只能一个在线（4409）。测试前关掉其他的。

### extension/ 结构说明

- `manifest.json` — MV3；权限 tabs/activeTab/storage/alarms/scripting + `<all_urls>`；CSP 照抄官方
- `background.js` — 单文件：WS 连接管理（client UUID、hello、ping/pong、45s 死链、alarms 30s reconcile、1s/3s 快重试、4409 不快重试）+ 工具注册表 + 后台侧工具（tabs 系列、navigate、evaluate、screenshot）+ DOM 工具转发
- `content-scripts/bridge.js` — DOM 执行层 + 自研可达性快照：click / fill / scroll / wait / select_option / evaluate 兜底 / snapshot / find / read_page / hover / key_type / send_keys / drag / upload；`@eN` ref 用 WeakMap 实现 stable-node（同节点跨快照同 ref，页面生命周期内有效）
- `icon/` — 自绘占位图标（无版权问题，后续可换）
- evaluate 优先 `scripting.executeScript world:"MAIN"`，失败退回 content script 隔离世界 eval
- ⚠️ 首次 `xcodebuild` 需先 `sudo xcodebuild -license accept`（需用户手动执行）
- ⚠️ **packager 的已知 bug**：重新生成工程后，App target 的 Bundle ID 会被写成 `com.example.KimiBridgeSafari`（取 app 名）而非传入的 `com.example.kimibridge`，构建报 "Embedded binary's bundle identifier is not prefixed…"。重新生成后必须跑一次修复：
  ```bash
  sed -i '' 's/PRODUCT_BUNDLE_IDENTIFIER = com\.example\.KimiBridgeSafari;/PRODUCT_BUNDLE_IDENTIFIER = com.example.kimibridge;/g' \
    KimiBridgeSafari/KimiBridgeSafari.xcodeproj/project.pbxproj
  ```
