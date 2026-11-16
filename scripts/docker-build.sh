#!/usr/bin/env bash
# 满伴成长树 · 镜像版一键构建
#
# 用法（在 NAS 的项目目录下执行）：
#   bash scripts/docker-build.sh              # 构建镜像 + 启动容器（默认行为）
#   bash scripts/docker-build.sh --save       # 构建后额外导出镜像包（可拷到别的机器免编译运行）
#   bash scripts/docker-build.sh --no-up      # 只构建镜像，不启动容器
#   MANALONG_VERSION=20261009 bash scripts/docker-build.sh
#
# 版本号取值优先级：命令行环境变量 MANALONG_VERSION > 项目根目录 VERSION 文件 > latest
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(pwd)"

DO_SAVE=0
DO_UP=1
# ${1+"$@"} 而非 "$@"：老版本 bash（3.2）在 set -u 且无入参时会报 unbound variable
for arg in ${1+"$@"}; do
  case "$arg" in
    --save)  DO_SAVE=1 ;;
    --no-up) DO_UP=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "未知参数：${arg} （支持 --save / --no-up）" >&2; exit 1 ;;
  esac
done

VERSION="${MANALONG_VERSION:-$(tr -d '[:space:]' < VERSION 2>/dev/null || true)}"
VERSION="${VERSION:-latest}"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

command -v docker >/dev/null || { echo "✗ 没找到 docker，请先安装 Docker" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "✗ 没找到 docker compose（需要 v2）" >&2; exit 1; }

# 前端在 Dockerfile 构建阶段容器内编译（COPY web/ 源码 + npm run build），
# 不再要求本地预构建 web/dist —— 任何构建路径都会拿到当前源码的最新前端。
echo "== 构建版本：${VERSION} （构建时间 ${BUILD_DATE}）"

# 1) 构建镜像：同一份镜像打两个 tag —— 版本 tag 用于回滚，latest 供 compose 默认使用
# --provenance=false --sbom=false：docker 29 起 docker build 默认附带 BuildKit 证明清单
# （含 application/vnd.oci.empty.v1+json），阿里云 ACR 不认识这类 manifest，
# 推送时会报「unknown manifest class」而整次 push 失败 —— 这里直接关掉。
docker build \
  --provenance=false \
  --sbom=false \
  --build-arg "VERSION=$VERSION" \
  --build-arg "BUILD_DATE=$BUILD_DATE" \
  -t "manalong:$VERSION" \
  -t "manalong:latest" \
  .
echo "== 镜像就绪：manalong:$VERSION / manalong:latest"
docker images manalong --format '{{.Repository}}:{{.Tag}}  {{.Size}}'

# 2) 可选导出：导出的镜像包拷到任意一台装了 Docker 的机器 docker load 即可运行，无需再编译
if [ "$DO_SAVE" = "1" ]; then
  OUT="../manalong-image-$VERSION.tar.gz"
  echo "== 导出镜像包 → ${OUT} （约几百 MB，耐心等）"
  docker save "manalong:$VERSION" | gzip -1 > "$OUT"
  ls -lh "$OUT"
fi

# 3) 启动：镜像已在本地，compose 直接拿来用，不会再编译
if [ "$DO_UP" = "1" ]; then
  echo "== 启动容器"
  MANALONG_VERSION="$VERSION" docker compose up -d
  PORT="${MANALONG_PORT:-3000}"
  echo -n "== 等待服务就绪 "
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
      echo "OK"
      echo "== 访问地址：http://<NAS的IP>:${PORT}"
      exit 0
    fi
    echo -n "."; sleep 2
  done
  echo
  echo "⚠ 30 次探活仍未就绪，看日志：docker compose logs --tail 100" >&2
  exit 1
fi
