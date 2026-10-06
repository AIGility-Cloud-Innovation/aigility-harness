#!/usr/bin/env bash
# publish-packages.sh — @aigility-harness/* 包发布到 Gitea 私有 npm registry
#
# 用法：
#   ./scripts/publish-packages.sh              # 构建 + 发布全部有变更的包
#   ./scripts/publish-packages.sh --force      # 忽略变更检测，强制发布全部
#   ./scripts/publish-packages.sh --dry-run    # 只显示将做什么，不实际发布
#   VERSION_SCHEME=date ./scripts/publish-packages.sh   # 日期版本 0.2026.10.6
#
# 前置：
#   ~/.npmrc 配置 Gitea registry 凭证（见 scripts/npmrc.example）；
#   Gitea 组织 AIGility-Cloud-Innovation 开启 npm registry（已验证 API 200）。
#
# 设计：
#   - 版本方案：日期版本 0.YYYY.MM.DD（同日多发追加 -N）；单调递增、人可读、
#     与 git 历史对齐（发布即当日 main 的内容）。
#   - 变更检测：包内容（src/）相对上次发布 tag（pkg/<name>/<version>）有差异才发布；
#     --force 跳过。
#   - 发布后打 tag pkg/<name>/<version>（下次变更检测的基准）。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0; FORCE=0; VERSION_SCHEME="date"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --force)   FORCE=1 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

# ── 版本号 ──────────────────────────────────────────────────────
TODAY="$(date +%Y%m%d)"
BASE_VERSION="0.${TODAY}.0"
next_version() {  # 同日多发：0.20261006.1、.2…
  local pkg="$1"
  local existing
  existing=$(npm view "$pkg" versions --registry "$REGISTRY" --json 2>/dev/null | jq -r 'map(select(startswith("'"$BASE_VERSION"'"))) | length' 2>/dev/null || echo 0)
  if [ "${existing:-0}" = "0" ] || [ "$existing" = "null" ]; then echo "$BASE_VERSION"; else echo "0.${TODAY}.$((existing))"; fi
}

# ── Registry ────────────────────────────────────────────────────
REGISTRY="https://git.aigility.cloud/api/packages/AIGility-Cloud-Innovation/npm/"
if ! grep -q "git.aigility.cloud" ~/.npmrc 2>/dev/null; then
  echo "❌ ~/.npmrc 未配置 Gitea registry 凭证——参见 scripts/npmrc.example"; exit 1
fi

# ── 包清单（private 不发；prototype-mode 为内核原型，刻意不发）────
PACKAGES=(
  core dsh-interop layer-infrastructure layer-cognitive layer-action
  layer-orchestration layer-persona rbac role-kit workflow-studio py-bridge
)

echo "═══ @aigility-harness 包发布 → Gitea 私有 registry ═══"
echo "registry: $REGISTRY   mode: $([ $DRY_RUN = 1 ] && echo dry-run || echo publish)$([ $FORCE = 1 ] && echo ' / force')"

PUBLISHED=0; SKIPPED=0; FAILED=0
for pkg in "${PACKAGES[@]}"; do
  DIR="packages/$pkg"
  NAME=$(jq -r .name "$DIR/package.json")
  CUR=$(jq -r .version "$DIR/package.json")

  # 构建产物必须存在（先 build）
  (cd "$DIR" && pnpm run -s build 2>&1 | tail -3 || true)
  [ -f "$DIR/dist/index.js" ] || { echo "❌ $NAME: dist/index.js 未生成，跳过"; FAILED=$((FAILED+1)); continue; }

  # 变更检测：相对上次发布 tag
  NEW_VER=$(next_version "$NAME")
  LAST_TAG="pkg/$pkg/"
  LAST=$(git tag -l "$LAST_TAG*" --sort=-v:refname | head -1)
  if [ $FORCE = 0 ] && [ -n "$LAST" ]; then
    if git diff --quiet "$LAST" HEAD -- "$DIR/src" 2>/dev/null; then
      echo "⏭  $NAME@$CUR 无变更（基准 $LAST），跳过"; SKIPPED=$((SKIPPED+1)); continue
    fi
  fi

  # 临时版本号写入 → pack → publish → 还原（不改仓库里的 package.json）
  jq --arg v "$NEW_VER" '.version = $v' "$DIR/package.json" > "$DIR/package.json.tmp" \
    && mv "$DIR/package.json.tmp" "$DIR/package.json"
  if [ $DRY_RUN = 1 ]; then
    echo "▸ [dry-run] $NAME@$NEW_VER（源码相对 $([ -n "$LAST" ] || echo 无基准) 有变更）"
  else
    if (cd "$DIR" && npm publish --registry "$REGISTRY" --access restricted) > /tmp/npm-publish.log 2>&1; then
      git tag "pkg/$pkg/v$NEW_VER" 2>/dev/null || true
      echo "✅ $NAME@$NEW_VER 已发布"
      PUBLISHED=$((PUBLISHED+1))
    else
      echo "❌ $NAME@$NEW_VER 发布失败"
      FAILED=$((FAILED+1))
    fi
  fi
  git checkout -- "$DIR/package.json" 2>/dev/null || git checkout HEAD -- "$DIR/package.json" 2>/dev/null || true
done

echo "═══ 完成: 发布 $PUBLISHED / 跳过 $SKIPPED / 失败 $FAILED ═══"
[ $DRY_RUN = 1 ] && echo "（dry-run 模式，未实际发布）"
[ $FAILED = 0 ]
