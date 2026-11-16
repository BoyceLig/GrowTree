#!/usr/bin/env bash
# 满伴成长树 · 把 watchtower 升级执行器搬运到自己的镜像仓库
#
# 为什么要搬：一键升级依赖 watchtower 容器，而它在 Docker Hub 上，
# 国内（尤其 NAS 环境）拉不动。搬到同一个阿里云仓库后，用户 `docker compose up -d`
# 就能直接拉下来，不需要额外配置加速器。
#
# 用法：
#   bash scripts/push-watchtower.sh <仓库前缀，如 crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com/wdcasc>
#   WATCHTOWER_VERSION=1.23.0 bash scripts/push-watchtower.sh <仓库前缀>
#
# 关键坑：本机镜像库里同 tag 只会保留"当前平台"那一份，
# 连续两次 `docker pull --platform` 会命中缓存、第二次其实没换架构。
# 因此这里改成按 **manifest 摘要** 精确拉取，两个架构各拉一次，互不干扰。
set -euo pipefail

PREFIX="${1:-}"
[ -n "${PREFIX}" ] || { echo "用法：bash scripts/push-watchtower.sh <仓库前缀>，如 crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com/wdcasc" >&2; exit 1; }
PREFIX="${PREFIX%/}"
TARGET="${PREFIX}/watchtower"
WVER="${WATCHTOWER_VERSION:-1.23.0}"
# 源镜像：优先走国内加速源；能直连 Docker Hub 的机器可覆盖 SOURCE
SOURCE="${WATCHTOWER_SOURCE:-docker.1ms.run/nickfedor/watchtower}"

command -v docker >/dev/null || { echo "✗ 没找到 docker" >&2; exit 1; }

echo "== 源：${SOURCE}:latest   →  目标：${TARGET}:${WVER}"

echo "== 1/5 读源清单，取出 amd64 / arm64 的摘要"
INSPECT="$(BUILDX_CONFIG="${BUILDX_CONFIG:-/tmp/bx}" docker buildx imagetools inspect --raw "${SOURCE}:latest")"
AMD="$(printf '%s' "$INSPECT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for m in d.get("manifests",[]):
    p=m.get("platform",{})
    if p.get("architecture")=="amd64" and p.get("os")=="linux":
        print(m["digest"]); break
')"
ARM="$(printf '%s' "$INSPECT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for m in d.get("manifests",[]):
    p=m.get("platform",{})
    if p.get("architecture")=="arm64" and p.get("os")=="linux":
        print(m["digest"]); break
')"
[ -n "${AMD}" ] || { echo "✗ 源里没找到 linux/amd64" >&2; exit 1; }
[ -n "${ARM}" ] || { echo "✗ 源里没找到 linux/arm64" >&2; exit 1; }
echo "   amd64 = ${AMD}"
echo "   arm64 = ${ARM}"

echo "== 2/5 按摘要精确拉取两个架构"
docker pull "${SOURCE}@${AMD}" >/dev/null
docker pull "${SOURCE}@${ARM}" >/dev/null

echo "== 3/5 打 tag"
docker tag "${SOURCE}@${AMD}" "${TARGET}:${WVER}-amd64"
docker tag "${SOURCE}@${ARM}" "${TARGET}:${WVER}-arm64"

echo "== 4/5 推送"
docker push "${TARGET}:${WVER}-amd64" >/dev/null
docker push "${TARGET}:${WVER}-arm64" >/dev/null

echo "== 5/5 合并为双架构清单"
BUILDX_CONFIG="${BUILDX_CONFIG:-/tmp/bx}" docker buildx imagetools create \
  -t "${TARGET}:${WVER}" -t "${TARGET}:latest" \
  "${TARGET}:${WVER}-amd64" "${TARGET}:${WVER}-arm64"

echo "== 校验 =="
BUILDX_CONFIG="${BUILDX_CONFIG:-/tmp/bx}" docker buildx imagetools inspect "${TARGET}:${WVER}" | grep -E "^Name|^MediaType|Platform"
echo "== 完成！compose 里写：${TARGET}:${WVER}"
