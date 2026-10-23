# Kimi Browser Extension → Safari 适配调研报告

> 调研日期：2026 年（基于 kimi.com 帮助中心与 Apple/MDN 官方文档）

## 1. Kimi Browser Extension（WebBridge）官方架构

来源：[How it works](https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-how-it-works) / [FAQ](https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-faq)

- **两种用法**：浏览器侧边栏聊天（需 Kimi 账号登录）+ 本地 Agent 远程控制。
- **链路**：本地 Agent（Claude Code、Cursor、Kimi Code 等）→ 本地桥接服务 → 浏览器扩展 → 页面操作。
- **本地服务**：默认 `ws://127.0.0.1:10086/ws`，配置文件 `~/.kimi-webbridge/config.json`（macOS/Linux）或 `%USERPROFILE%\.kimi-webbridge\config.json`（Windows），端口可改。
- **浏览器侧执行**：基于 **Chrome DevTools Protocol (CDP)**；已知命令包括 `snapshot`、`evaluate`、`screenshot`、`click`。
- **支持浏览器**：官方 FAQ 明确只有 **Chrome 和 Edge**，无 Safari 计划说明。
- **启示**：本地桥接服务本身与浏览器无关。扩展 ↔ 本地服务之间是明文 WebSocket 协议（未公开但可抓包逆向）。若协议可复用，Safari 扩展可以连接**同一个 Kimi 本地服务**，本地 Agent 完全无感知。

## 2. Safari Web Extension 开发基础

来源：[Apple - Safari web extensions](https://developer.apple.com/documentation/safariservices/safari-web-extensions)

- 使用标准 WebExtensions API（JS/HTML/CSS），Safari **同时支持 `chrome.*` 和 `browser.*` 命名空间**，回调与 Promise 两种异步风格均可。
- 版本要求：macOS Safari 14+；**Manifest V2 + V3 均支持（Safari 15.4+）**；iOS 15+。
- 三种开发方式：
  1. **临时安装**（无需 Xcode）：Safari > 设置 > Developer > "Add Temporary Extension…"，选扩展文件夹即可。24 小时或退出 Safari 后失效 —— 适合前期快速验证。
  2. **Xcode 模板新建** Safari Web Extension 项目。
  3. **转换现有 Chrome 扩展**：`xcrun safari-web-extension-packager /path/to/extension`（旧名 `safari-web-extension-converter`），自动生成包含容器 App 的 Xcode 工程，并报告 Safari 不支持的 manifest key。
- 调试/分发要点：
  - 开发期无证书：Safari 设置 > Developer > 勾选 **"Allow unsigned extensions"**（每次退出 Safari 后重置）。
  - 正式发布：扩展必须打包在 macOS/iOS App 内，需 **Apple Developer Program（$99/年）**，经 App Store 分发（macOS 也可 Developer ID 公证后店外分发）；App Store Connect 还提供免 Mac 的网页版打包工具。

## 3. 关键 API 差异与 Kimi 功能可行性对照

来源：[Apple - Assessing browser compatibility](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility)、[MDN compat data](https://github.com/mdn/browser-compat-data)、[Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)

| Kimi 功能 | Chrome 实现 | Safari 可行性 | Safari 替代方案 |
|---|---|---|---|
| 侧边栏聊天 | `chrome.sidePanel` | ❌ 完全不支持（MDN compat: `version_added: false`） | content script 注入 iframe 侧边栏，或 toolbar popup |
| 页面操作执行 | **CDP（`chrome.debugger`）** | ❌ Safari 无此 API（Chrome 独占） | 常驻 content script + `scripting.executeScript` |
| 元素点击/表单填写 | CDP Input 域 | ✅ 可行 | content script 内 `dispatchEvent` 模拟交互 |
| 内容提取/snapshot | CDP DOM 域 | ✅ 可行 | content script 遍历 DOM 序列化 |
| 页面截图 | CDP Page 域 | ✅ 可行 | `tabs.captureVisibleTab`（Safari 支持，且不需要 all_urls 权限） |
| 网页导航 | CDP / tabs | ✅ 可行 | `tabs.update` / `tabs.create` |
| 登录状态保持 | 浏览器会话 | ✅ 天然支持 | 同上（扩展运行在用户已登录的浏览器内） |

其他需要注意的 Safari 限制：
- `webRequestBlocking` 不支持（macOS 可用非阻塞 `webRequest`，iOS 完全无 `webRequest`）。
- `identity` 不支持 → OAuth 需开新 tab 走授权流。
- `storage.sync` 只存不同步；`storage.local` 默认 5MB（Safari 16+ 可申请 unlimited）。
- `scripting.executeScript` 不支持 `injectImmediately`；`insertCSS/removeCSS` 不支持 `frameIds/allFrames`。
- `externally_connectable`（网页↔扩展消息）Safari 15.4+ 支持，但不支持 `ids`。

## 4. 本地 Agent ↔ Safari 扩展的通信方案

两条路：

- **方案 A：扩展直连本地服务（推荐优先验证）**
  Safari 扩展的 background（service worker / 非持久背景页）直接 `new WebSocket("ws://127.0.0.1:10086/ws")` 连接 Kimi 本地桥接服务。需要抓包逆向现有 Chrome 扩展的 WebSocket 协议（消息格式、鉴权、心跳、命令/响应结构），在 Safari 侧实现同名命令。优点：与 Kimi 生态（Kimi Work、Claude Code 等所有本地 Agent）零改动兼容。
  风险：协议未公开，可能随时变更；MV3 非持久 background 需处理 WebSocket 保活（Safari MV3 background 为非持久，需 alarms/事件唤醒保活或改用常驻 content script 持有连接）。

- **方案 B：经容器 App 的 Native Messaging**
  Safari 官方支持 `browser.runtime.sendNativeMessage` / `connectNative`，经容器 App（Swift）中转，App 再与本地服务通信（[官方样例 WWDC20-10665](https://developer.apple.com/documentation/safariservices/messaging-a-web-extension-s-native-app)）。优点：连接稳定、不受 background 生命周期影响；缺点：必须 Xcode 打包，无法走"临时扩展"快速迭代。

## 5. 本机环境现状

- macOS 26.6.2（Build 25G83）。
- ✅ **已安装 Xcode 27.0**（`/Applications/Xcode.app`，Build 27A266a），`safari-web-extension-packager` 可用。
- ⚠️ 一个小问题：`xcode-select` 当前指向 `/Library/Developer/CommandLineTools`，导致直接运行 `xcrun safari-web-extension-packager` / `xcodebuild` 会报 "requires Xcode"。两种解决方式（任选）：
  - 切换开发者目录：`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`（推荐，一劳永逸）
  - 或每次用完整路径调用：`/Applications/Xcode.app/Contents/Developer/usr/bin/safari-web-extension-packager ...`
- 打包转换命令（本项目可直接用）：

  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  xcrun safari-web-extension-packager ./extension \
    --app-name "KimiBridgeSafari" \
    --bundle-identifier com.example.kimibridge \
    --swift --macos-only --copy-resources --no-open --force
  ```

## 6. 建议的技术路线

1. **MVP**：标准 MV3 Web Extension（可先 Chrome 调试、Safari 临时安装验证），先实现 content script 动作层（click / fill / extract / snapshot）+ `tabs.captureVisibleTab` 截图 + iframe 注入式侧边栏。
2. **桥接**：抓包 Kimi Chrome 扩展 ↔ `ws://127.0.0.1:10086/ws` 的协议，在 Safari 扩展中复刻（方案 A）；若协议复杂或有鉴权障碍，退而自建桥接服务（方案 B/自研 Agent 协议，如 MCP server）。
3. **打包分发**：`xcode-select` 切换到 Xcode 后，用 `safari-web-extension-packager` 生成工程 → 签名（开发期可用 "Sign to Run Locally" + Safari 允许未签名扩展）→ 正式发布走 App Store / Developer ID 公证。

## 参考链接汇总

- Kimi 官方：[How it works](https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-how-it-works) · [FAQ](https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-faq) · [Introduction](https://www.kimi.com/en/help/kimi-webbridge/kimi-webbridge-introduction)
- Apple：[Safari web extensions 总览](https://developer.apple.com/documentation/safariservices/safari-web-extensions) · [Packaging（packager 工具）](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari) · [Running（临时安装/免签名调试）](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension) · [兼容性评估](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility) · [Native Messaging 样例](https://developer.apple.com/documentation/safariservices/messaging-a-web-extension-s-native-app) · [WWDC20: Meet Safari Web Extensions](https://developer.apple.com/videos/play/wwdc2020/10665/)
- MDN：[Browser support for JavaScript APIs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs) · [browser-compat-data](https://github.com/mdn/browser-compat-data)
- Chrome：[debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger) · [sidePanel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
