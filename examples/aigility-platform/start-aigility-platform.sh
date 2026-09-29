#!/usr/bin/env bash
# ============================================================
#  Aigility 智悦智能平台（aigility-platform）一键启动脚本
#  对应 Windows 版模板：start-aigility-platform.cmd.example
#
#  用法：
#    chmod +x start-aigility-platform.sh
#    ./start-aigility-platform.sh
#
#  说明：
#  - LLM 上游优先读仓库根 .env（本机已有 LITELLM_URL/LITELLM_KEY 等），
#    也可在下方 [FILL] 处直接填 BIGMODEL_API_KEY。
#    两者都没有时进入 stub 降级模式（链路仍可用，回复带降级标记）。
#  - PostgreSQL 复用 AppBase 的 docker 容器 appbase-pg（宿主 5433），
#    登录账号与其共库共享。
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ---------- 环境变量 ----------
# 先继承仓库根 .env（不覆盖已在环境中显式设置的变量）
if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env"
  set +a
fi

# LLM 上游：填了 BIGMODEL_API_KEY 则走智谱；否则用 .env 里的 LITELLM_*；
# 都没有 -> stub 降级。按需填写：
export BIGMODEL_API_KEY="${BIGMODEL_API_KEY:-}"
# export LLM_PROVIDER=litellm
# export LITELLM_URL="http://127.0.0.1:48724"
# export LITELLM_KEY="sk-1234"

# 可选覆盖（默认值如下）
export AIGILITY_WEB_PORT="${AIGILITY_WEB_PORT:-1236}"
export AIGILITY_GATEWAY_PORT="${AIGILITY_GATEWAY_PORT:-1237}"

# ---------- 前置检查 ----------
command -v node >/dev/null 2>&1 || { echo "[ERROR] 未找到 node，请先安装 Node 20+"; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "[ERROR] 未找到 pnpm，请先安装 pnpm 9+（npm i -g pnpm）"; exit 1; }

# ---------- PostgreSQL ----------
# 优先级：环境变量/仓库 .env 已设置的 APPBASE_PG_* > docker 容器 appbase-pg(5433) > 本机原生 PG(5432)
# 本机（Linux 开发机）实际跑的是原生 PostgreSQL 17，账号库在 5432 的 appbase 库，
# 与 examples/appbase/start-appbase.sh 同源（该脚本即以 5432 启动 AppBase）。
if [[ -n "${APPBASE_PG_PORT:-}" ]]; then
  echo "[INFO] 使用已有 PG 配置: ${APPBASE_PG_HOST:-127.0.0.1}:${APPBASE_PG_PORT}"
elif command -v docker >/dev/null 2>&1; then
  if ! docker start appbase-pg >/dev/null 2>&1; then
    echo "[INFO] appbase-pg 容器不存在，正在创建..."
    docker run -d --name appbase-pg --restart unless-stopped \
      -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=appbase \
      -p 5433:5432 postgres:15 >/dev/null
  fi
  export APPBASE_PG_PASSWORD="${APPBASE_PG_PASSWORD:-appbase}"
  export APPBASE_PG_PORT="${APPBASE_PG_PORT:-5433}"
else
  # 无 docker：假设本机原生 PG 已在运行（本机为 5432 的 postgresql-17，密码同 start-appbase.sh）
  echo "[INFO] 未安装 docker，使用本机原生 PG (127.0.0.1:5432)"
  export APPBASE_PG_HOST="${APPBASE_PG_HOST:-127.0.0.1}"
  export APPBASE_PG_PORT="${APPBASE_PG_PORT:-5432}"
  export APPBASE_PG_DATABASE="${APPBASE_PG_DATABASE:-appbase}"
  export APPBASE_PG_USER="${APPBASE_PG_USER:-postgres}"
  export APPBASE_PG_PASSWORD="${APPBASE_PG_PASSWORD:-hy010112}"
fi

# ---------- 依赖安装 ----------
cd "$REPO_ROOT"
if [[ ! -d "node_modules" ]]; then
  echo "[INFO] 安装 workspace 依赖..."
  pnpm install
fi

# ---------- 前端构建（首次） ----------
if [[ ! -f "examples/aigility-platform/app/dist/index.html" ]]; then
  echo "[INFO] 构建前端（首次运行）..."
  pnpm --filter @aigility-harness/aigility-platform build
fi

# ---------- 启动 ----------
echo "[INFO] 启动智悦智能平台 (web :${AIGILITY_WEB_PORT}, gateway :${AIGILITY_GATEWAY_PORT})..."
pnpm --filter @aigility-harness/aigility-platform start
