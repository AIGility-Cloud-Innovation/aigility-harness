#!/usr/bin/env bash
# feishu-dsh 启动脚本（单实例锁内置在应用层: /tmp/aigility-feishu-dsh.lock）
# 用法:
#   ./start-feishu-dsh.sh          # 前台运行（Ctrl+C 退出）
#   ./start-feishu-dsh.sh daemon   # 后台运行, 日志追加到 data/feishu-dsh.log
#   ./start-feishu-dsh.sh stop     # 按锁文件记录的 worker PID 停止（cli 层随子进程退出）
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data
LOCK=/tmp/aigility-feishu-dsh.lock
if [[ "${1:-}" == "stop" ]]; then
  if [[ -f "$LOCK" ]]; then
    pid=$(cat "$LOCK")
    kill "$pid" 2>/dev/null || true
    sleep 2
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$LOCK"
    echo "feishu-dsh 已停止 (worker pid=$pid)"
  else
    echo "无锁文件, 没有运行中的实例"
  fi
  exit 0
fi
if [[ "${1:-}" == "daemon" ]]; then
  setsid nohup ./node_modules/.bin/tsx src/index.ts >> data/feishu-dsh.log 2>&1 < /dev/null &
  echo "feishu-dsh 已后台启动 (pid=$!, 日志: examples/feishu-dsh/data/feishu-dsh.log)"
else
  exec ./node_modules/.bin/tsx src/index.ts
fi
