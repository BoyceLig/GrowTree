#!/usr/bin/env bash
# 成长树 · 把双架构镜像推送到镜像仓库（阿里云 ACR / 任意 Docker Registry）
#
# 用法：
#   bash scripts/push-acr.sh crpi-xxxx.cn-hangzhou.personal.cr.aliyuncs.com/wdcasc/growtree
#   VERSION=20261011 bash scripts/push-acr.sh <仓库地址>     # 指定版本
#
# 版本号取值优先级：环境变量 VERSION > 项目根目录 VERSION 文件 > latest
#
# 会推送四个 tag：
#   <仓库>:<版本>          ← 双架构合并清单（用户直接 pull 这个，自动匹配 CPU）
#   <仓库>:latest          ← 同上，最新版别名（一键升级靠比对它来判断有没有新版）
#   <仓库>:<版本>-arm64 / -amd64  ← 单架构备用
#
# docker login 会交互式提示输入用户名和密码（阿里云账号 + Registry 固定密码），
# 密码不落盘、不进脚本。
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TARGET="${1:-}"
[ -n "${TARGET}" ] || { echo "用法：bash scripts/push-acr.sh <仓库完整地址>，如 crpi-xxx.cn-hangzhou.personal.cr.aliyuncs.com/wdcasc/growtree" >&2; exit 1; }
HOST="${TARGET%%/*}"
VER="${VERSION:-$(tr -d '[:space:]' < VERSION 2>/dev/null || true)}"
VER="${VER:-latest}"

command -v docker >/dev/null || { echo "✗ 没找到 docker" >&2; exit 1; }
docker image inspect "growtree:${VER}" >/dev/null 2>&1 || { echo "✗ 本地没有 growtree:${VER}，先构建（bash scripts/docker-build.sh --no-up）" >&2; exit 1; }

# ── 推之前先跑一道发版校验 ───────────────────────────────────────────
# 公开仓库是**匿名可拉**的，镜像层推上去就撤不回来了，所以宁可在这里拦下来。
# 具体校验什么由 scripts/pre-push-check.sh 决定：那个文件只存在于开发真源里
# （它会被点名商业模块在镜像里的落点，不适合公开），公开分发包里没有它。
# 这也是刻意的 —— 少了它就直接跳过，不会因为文件不在而误判成失败。
echo "== 1/6 发版校验"
if [ -f scripts/pre-push-check.sh ]; then
  bash scripts/pre-push-check.sh "${VER}" "${TARGET}" || exit 1
else
  echo "   （没有 scripts/pre-push-check.sh，跳过 —— 当前是剥离后的发布树）"
fi

# amd64 允许"本地没有"：交叉构建时用 `docker buildx build --platform linux/amd64 ... --push`
# 是直接推进仓库的，**不会**在本地留下 -amd64 镜像。这种情况下只要仓库里已经有
# :${VER}-amd64，就可以直接跳到第 4 步合并清单。
LOCAL_AMD64=1
if ! docker image inspect "growtree:${VER}-amd64" >/dev/null 2>&1; then
  LOCAL_AMD64=0
  echo "== 本地没有 growtree:${VER}-amd64，检查仓库里是否已推送 ..."
  if BUILDX_CONFIG="${BUILDX_CONFIG:-/tmp/bx}" docker buildx imagetools inspect "${TARGET}:${VER}-amd64" >/dev/null 2>&1; then
    echo "   ✓ 仓库里已有 ${TARGET}:${VER}-amd64，跳过本地构建产物"
  else
    echo "✗ 本地和仓库都没有 ${VER}-amd64，先交叉构建并推送：" >&2
    echo "  BUILDX_CONFIG=/tmp/bx docker buildx build --platform linux/amd64 \\" >&2
    echo "    --provenance=false --sbom=false \\" >&2
    echo "    --build-arg VERSION=${VER} --build-arg BUILD_DATE=\"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" \\" >&2
    echo "    -t ${TARGET}:${VER}-amd64 --push ." >&2
    exit 1
  fi
fi

# 取某个 tag 的清单摘要（用于后面校验 latest 有没有真的更新）
digest_of() {
  BUILDX_CONFIG="${BUILDX_CONFIG:-/tmp/bx}" docker buildx imagetools inspect "$1" 2>/dev/null \
    | awk '/^[[:space:]]*Digest:/{print $2; exit}'
}

echo "== 目标：${TARGET}  版本：${VER}"

echo "== 2/6 检查登录（若已在本机 docker login 过会自动跳过）"
docker login "${HOST}" </dev/null 2>/dev/null \
  || echo "（未在本机缓存凭证，直接尝试推送——若下面报 unauthorized，请先手动 docker login）"

echo "== 3/6 打 tag 并推送 arm64（Apple/ARM 机器用）"
docker tag "growtree:${VER}"          "${TARGET}:${VER}-arm64"
docker push "${TARGET}:${VER}-arm64"

echo "== 4/6 打 tag 并推送 amd64（x86 的 NAS/服务器用）"
if [ "${LOCAL_AMD64}" = "1" ]; then
  docker tag "growtree:${VER}-amd64"    "${TARGET}:${VER}-amd64"
  docker push "${TARGET}:${VER}-amd64"
else
  echo "   （已在第 0 步确认仓库里有 ${VER}-amd64，跳过）"
fi

echo "== 5/6 合并为双架构清单（用户 pull :${VER} / :latest 自动选对架构）"
BUILDX_CONFIG="${BUILDX_CONFIG:-/tmp/bx}" docker buildx imagetools create \
  -t "${TARGET}:${VER}" -t "${TARGET}:latest" \
  "${TARGET}:${VER}-arm64" "${TARGET}:${VER}-amd64"

echo "== 6/6 校验 latest 是否真的指向 ${VER}"
D_VER="$(digest_of "${TARGET}:${VER}")"
D_LATEST="$(digest_of "${TARGET}:latest")"
echo "   ${VER}  = ${D_VER}"
echo "   latest = ${D_LATEST}"
# ⚠️ 这一步不能省：曾经因为一条命令里写成 "$TARGET:latest"（zsh 把 :l 当成
#    「转小写」修饰符，把 tag 变成 growtreeatest:latest），latest 没更新，
#    结果所有用户点「立即升级」都无效——watchtower 拉回来的还是旧镜像。
if [ -z "${D_VER}" ] || [ "${D_VER}" != "${D_LATEST}" ]; then
  echo "✗ latest 与 ${VER} 指向的清单不一致！用户的一键升级会拉到旧镜像。" >&2
  echo "  重新执行：BUILDX_CONFIG=/tmp/bx docker buildx imagetools create -t \"\${TARGET}:latest\" \"\${TARGET}:${VER}-arm64\" \"\${TARGET}:${VER}-amd64\"" >&2
  exit 1
fi
echo "   ✓ latest 与 ${VER} 一致"
BUILDX_CONFIG="${BUILDX_CONFIG:-/tmp/bx}" docker buildx imagetools inspect "${TARGET}:${VER}" | head -20
echo "== 完成！别人安装只需：docker pull ${TARGET}:latest"
