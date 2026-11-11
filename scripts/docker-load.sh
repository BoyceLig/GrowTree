#!/usr/bin/env bash
# 成长树 · 导入镜像包并启动（免编译部署 / 跨机器迁移）
#
# 用法：
#   bash scripts/docker-load.sh ../growtree-image-20261009.tar.gz
#   bash scripts/docker-load.sh /vol1/1000/download/growtree-image-20261009.tar
#
# 会自动识别镜像包里的版本 tag，并把该版本设为运行版本后启动容器。
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FILE="${1:-}"
[ -n "$FILE" ] || { echo "用法：bash scripts/docker-load.sh <镜像包路径>" >&2; exit 1; }
[ -f "$FILE" ] || { echo "✗ 找不到镜像包：$FILE" >&2; exit 1; }

command -v docker >/dev/null || { echo "✗ 没找到 docker" >&2; exit 1; }

echo "== 导入镜像：$FILE"
case "$FILE" in
  *.tar.gz|*.tgz) OUT="$(gunzip -c "$FILE" | docker load)" ;;
  *)              OUT="$(docker load -i "$FILE")" ;;
esac
echo "$OUT"

# docker load 输出形如：Loaded image: growtree:20261009
TAG="$(printf '%s\n' "$OUT" | sed -n 's/.*Loaded image: growtree:\([^ ]*\).*/\1/p' | tail -n1)"
if [ -z "$TAG" ]; then
  echo "⚠ 没能从输出里识别出版本 tag，按 latest 启动" >&2
  TAG="latest"
fi
docker tag "growtree:$TAG" "growtree:latest" 2>/dev/null || true

echo "== 启动容器（版本 ${TAG}）"
PIGGY_VERSION="$TAG" docker compose up -d
docker ps --filter name=growtree --format '{{.Names}}  {{.Image}}  {{.Status}}'
