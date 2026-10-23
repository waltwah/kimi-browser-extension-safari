# 会话快照（压缩用交接）

> 2026-10-23 · 恢复会话时先读本文件 + AGENTS.md

## 已完成

1. **调研**：官方无扩展开发文档（仅使用文档）→ RESEARCH.md（Safari 扩展 API 差异、Xcode 打包、分发）
2. **协议逆向**（静态 + 抓包双验证）→ PROTOCOL.md
   - 扩展源：Chrome 已装官方扩展 v2.0.22，ID `fldmhceldgbpfpkbgopacenieobmligc`，源码已解包美化到 `reverse/ext/`（本地保留，不入库）
   - daemon：`~/.kimi-webbridge/bin/kimi-webbridge`（Go，v2.0.23，正在运行，监听 127.0.0.1:10086）
   - 官方 skill 包：`https://cdn.kimi.com/webbridge/latest/skills/kimi-webbridge.tar.gz` → `reverse/skill/`（Agent 侧 HTTP API 权威文档）
3. **动态抓包**：`reverse/proxy/tap.js`（12086→10086 WS 帧记录），已验证 hello/hello_ack/ping/pong/tool_call/tool_result 全链路
4. **GitHub**：https://github.com/waltwah/kimi-browser-extension-safari （PUBLIC，main，已配 origin；本地 git 身份 waltwah / waltwah@users.noreply.github.com；.gitignore 已排除 reverse/ext、reverse/skill、captures、.npm-cache）

## 协议一句话版

扩展连 `ws://127.0.0.1:10086/ws?client=<uuid>`（无鉴权）→ 发 `hello{extensionVersion}` ← 收 `hello_ack`；双向 ping/pong，45s 无流量重连，4409=被占用；daemon 发 `tool_call{requestId,payload:{name,args+_session/_tabId/...}}`，扩展回 `tool_result{responseToRequestId,payload:{data|error}}`；25 个工具详见 PROTOCOL.md §2.4。

## 下一步（按 AGENTS.md 进度清单）

**写 `extension/` MV3 骨架**（无构建依赖原生 JS）：
1. manifest.json（权限参考 reverse/ext/manifest.json，去掉 debugger/sidePanel；CSP 照抄 connect-src）
2. background.js：`browser.*`/`chrome.*` 薄封装 + WS 客户端（hello/心跳/30s alarms reconcile/1s·3s 快重试/4409 处理）+ tool 注册派发（`Unknown tool` 语义对齐）
3. 第一批工具：navigate / find_tab / list_tabs / list_browser_tabs / attach_tab / close_tab / close_session / evaluate / click / fill / scroll / wait / select_option
4. 联调：curl POST /command 注入 → 观察 Safari 行为（测试完用 close_session 清理）

## 环境坑位

- `xcode-select` 指向 CLT → packager 用 `/Applications/Xcode.app/Contents/Developer/usr/bin/safari-web-extension-packager`
- npm 必须带 `npm_config_cache=$PWD/.npm-cache`
- 用户的 Chrome 官方扩展连接地址已改回默认 10086（抓包结束时确认过 Connected）；代理 tap.js 已停止
- 不自动运行 daemon 的 stop/restart/upgrade/uninstall
