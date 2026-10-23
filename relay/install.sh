#!/bin/bash
# 安装 kimi-bridge-relay 为 launchd 常驻服务（登录即启，崩溃自动拉起）
# 用法：bash relay/install.sh   /   卸载：bash relay/install.sh --uninstall
set -euo pipefail

LABEL="com.kimibridgesafari.relay"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
RELAY_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载 $LABEL"
  exit 0
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "错误：找不到 node。请先安装 Node.js（或修改本脚本指定 node 绝对路径）" >&2
  exit 1
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${RELAY_DIR}/relay.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/kimi-bridge-relay.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/kimi-bridge-relay.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
sleep 1
if curl -sf http://127.0.0.1:12086/healthz > /dev/null; then
  echo "✅ relay 已常驻启动（$LABEL），健康检查通过"
  echo "   日志：~/Library/Logs/kimi-bridge-relay.log"
else
  echo "⚠️ 已加载 launchd 服务，但健康检查未通过，请查看日志" >&2
  exit 1
fi
