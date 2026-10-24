# kimi-browser-extension-safari

把 [Kimi Browser Extension](https://www.kimi.com/en/products/kimi-webbridge)（原 Kimi WebBridge）的本地 Agent 远程控制能力移植到 **Safari**。

官方扩展只支持 Chrome / Edge。本项目通过逆向「扩展 ↔ 本地 daemon」的 WebSocket 协议，实现一个接入同一 daemon 的 Safari Web Extension——本地 AI Agent（Claude Code、Cursor、Kimi Code 等）无需任何改动即可控制 Safari。

> 状态：✅ 已完成。25 个工具全部实现并在 Safari 26 实机验收；含常驻 Origin 中转 relay 与 Xcode 打包流程。

## 文档

| 文档 | 内容 |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | 逆向出的协议规范：WS 握手/心跳/消息封装、25 个工具清单、Safari 移植影响 |
| [RESEARCH.md](RESEARCH.md) | Safari Web Extension 开发调研（API 差异、打包分发） |
| [AGENTS.md](AGENTS.md) | 给 AI 协作者的项目指引（结构、约定、联调方法） |
| [reverse/notes/](reverse/notes/) | 官方扩展源码的分析笔记 |
| [relay/](relay/) | 常驻 Origin 伪装中转（daemon 有 WS Origin 白名单，Safari 必须经 relay 接入） |

## 快速验证（本机已装官方 Chrome 扩展 + daemon 时）

```bash
curl -s http://127.0.0.1:10086/status
curl -s -X POST http://127.0.0.1:10086/command -H 'Content-Type: application/json' \
  -d '{"action":"navigate","args":{"url":"https://example.com","newTab":true},"session":"demo"}'
```

## 声明

- 本项目与 Moonshot AI 无官方关联，仅作个人学习与研究。
- 官方扩展/daemon 版权归 Moonshot AI 所有；逆向产物（解包源码、抓包数据）**不包含在本仓库中**，仅保留自行撰写的分析笔记与协议文档。
