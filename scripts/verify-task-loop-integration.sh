#!/usr/bin/env bash
# 集成验证：feishu-task-loop 管理能力 + 规划中先行工作流 + LLM 模型修正
# 用法：bash scripts/verify-task-loop-integration.sh
set -uo pipefail
cd "$(dirname "$0")/.."
PASS=0; FAIL=0
check() { # check <说明> <命令...>
  local desc="$1"; shift
  echo "── $desc"
  if "$@" >/tmp/verify-out.log 2>&1; then
    echo "   ✅ PASS"; PASS=$((PASS+1))
  else
    echo "   ❌ FAIL（输出尾部：）"; tail -15 /tmp/verify-out.log | sed 's/^/   /'; FAIL=$((FAIL+1))
  fi
}

# 1. LLM：litellm 网关默认模型可用性（sensenova-deepseek-v4-flash）
check "LLM 网关 sensenova-deepseek-v4-flash 可用" bash -c \
  'curl -s -m 30 http://127.0.0.1:48724/v1/chat/completions -H "Authorization: Bearer sk-1234" -H "Content-Type: application/json" -d "{\"model\":\"sensenova-deepseek-v4-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":5}" | grep -q chat.completion'

# 2. 单测：layer-persona / layer-orchestration / layer-action
check "layer-persona 单测" bash -c 'pnpm --filter @aigility-harness/layer-persona test 2>&1 | grep -E "Tests +[0-9]+ passed" | grep -vq failed'
check "layer-orchestration 单测" bash -c 'pnpm --filter @aigility-harness/layer-orchestration test 2>&1 | grep -E "Tests +[0-9]+ passed" | grep -vq failed'

# 3. 构建：orchestration dist / 平台前端 / 平台后端类型
check "layer-orchestration 构建" pnpm --filter @aigility-harness/layer-orchestration build
check "aigility-platform 前端构建" pnpm --filter @aigility-harness/aigility-platform build
check "feishu-task-loop typecheck" bash -c 'cd examples/feishu-task-loop && npx tsc --noEmit'

# 4. 平台产物包含管理页
check "前端产物包含 task-loop 资产" bash -c 'grep -rq "task-loop" examples/aigility-platform/app/dist/assets/ 2>/dev/null'

echo
echo "结果：PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
