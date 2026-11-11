#!/usr/bin/env bash
# 成长树 · 启动 / 切换版本 / 回滚（只跑本地已有镜像，不编译）
#
# 用法：
#   bash scripts/docker-up.sh              # 用 latest 启动
#   bash scripts/docker-up.sh 20261009     # 切到指定版本（镜像必须已存在）
#   bash scripts/docker-up.sh 20261008     # 回滚：把上一个版本填进来即可
#
# 查看本机有哪些版本：docker images growtree
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERSION="${1:-latest}"

if ! docker image inspect "growtree:$VERSION" >/dev/null 2>&1; then
  echo "✗ 本地没有 growtree:$VERSION 这个镜像" >&2
  echo "  现有版本：" >&2
  docker images growtree --format '  {{.Tag}}' >&2
  exit 1
fi

echo "== 启动 growtree:$VERSION"
PIGGY_VERSION="$VERSION" docker compose up -d
docker ps --filter name=growtree --format '{{.Names}}  {{.Image}}  {{.Status}}'
