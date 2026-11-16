#!/usr/bin/env bash
# 满伴成长树 · 服务器一键部署（自动备份 + 健康检查 + 失败自动回滚）
#
# 用法（在服务器的部署目录里执行）：
#   bash scripts/deploy.sh                 # 常规发版，自动用 dist/ 下最新的制品包
#   bash scripts/deploy.sh <制品包路径>      # 指定制品包
#   bash scripts/deploy.sh --no-backup     # 本次不备份数据（不推荐）
#   bash scripts/deploy.sh --rollback      # 手动回滚到上一个版本
#
# ── 为什么顺序是这样（每一步都在减少停机时间）──────────────────────
#   1. 把当前跑着的镜像存成 manalong:previous        回滚点
#   2. 解包新制品（覆盖源码，保留 data/ 与 .env）
#   3. docker compose build                          服务照常运行，只多占点内存
#   4. 停容器 → 备份 data/ → 起新容器                 停机只有备份那几秒
#   5. 健康检查：/api/health 的 version 必须等于新版本号
#      ⚠️ 只看「返回 200」不保险 —— 旧容器还没停干净时也能返回 200，
#         会出现「部署成功但版本没变」的假成功（这个项目踩过一次）
#   6. 不通过 → 自动切回 manalong:previous 并再检查一次，然后以失败退出
set -euo pipefail

# ── 自更新保护 ──────────────────────────────────────────────────────
# 本脚本会被新制品包覆盖，而 bash 是边读边执行的 —— 跑到一半文件被换掉
# 会解析出错。所以先把自己复制到临时文件再重跑（APP_DIR 要显式带过去，
# 因为重跑后 $0 指向 /tmp）。
if [ "${MANALONG_DEPLOY_REEXEC:-0}" != "1" ]; then
  _app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  _self="$(mktemp -t manalong-deploy)"
  cp "$0" "$_self"
  MANALONG_DEPLOY_REEXEC=1 \
  MANALONG_DEPLOY_SELF="$_self" \
  MANALONG_DEPLOY_APP_DIR="$_app_dir" \
    exec bash "$_self" "$@"
fi
[ -n "${MANALONG_DEPLOY_SELF:-}" ] && trap 'rm -f "$MANALONG_DEPLOY_SELF"' EXIT

APP_DIR="${MANALONG_DEPLOY_APP_DIR:?内部错误：缺少部署目录}"
cd "$APP_DIR"

# .env 与 docker compose 共用（ADMIN_PASSWORD / JWT_SECRET / MANALONG_PORT …）
if [ -f "$APP_DIR/.env" ]; then set -a; . "$APP_DIR/.env"; set +a; fi

CONTAINER="${MANALONG_CONTAINER:-manalong}"
DATA_DIR="$APP_DIR/data"
BACKUP_DIR="${MANALONG_BACKUP_DIR:-$(dirname "$APP_DIR")/manalong-backups}"
KEEP_BACKUPS="${MANALONG_KEEP_BACKUPS:-7}"
PORT="${MANALONG_PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

log()  { printf '· %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

# 可选：设置 ALERT_WEBHOOK（企业微信机器人地址）后，成功/失败都推一条到手机
notify() {
  [ -n "${ALERT_WEBHOOK:-}" ] || return 0
  curl -fsS --max-time 5 -X POST "$ALERT_WEBHOOK" \
    -H 'Content-Type: application/json' \
    -d "{\"msgtype\":\"text\",\"text\":{\"content\":\"$1\"}}" >/dev/null 2>&1 || true
}

# ── 参数 ────────────────────────────────────────────────────────────
MODE="deploy"
DO_BACKUP=1
PKG=""
for arg in ${1+"$@"}; do
  case "$arg" in
    --rollback) MODE="rollback" ;;
    --no-backup) DO_BACKUP=0 ;;
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    -*) die "未知参数：$arg" ;;
    *) PKG="$arg" ;;
  esac
done

command -v docker >/dev/null || die "没找到 docker"
docker compose version >/dev/null 2>&1 || die "没找到 docker compose（需要 v2）"

# ── 备份与回滚辅助 ──────────────────────────────────────────────────
prune_backups() {
  local total
  # 用 find 而不是 ls：ls 在「无匹配」时退出码非 0，配上 set -o pipefail
  # 会让 n="$(ls | wc -l)" 这条赋值直接非零，被 set -e 杀掉整个部署
  total="$(find "$BACKUP_DIR" -maxdepth 1 -name 'manalong-data-*.tar.gz' 2>/dev/null | wc -l | tr -d ' ')"
  [ "${total:-0}" -le "$KEEP_BACKUPS" ] && return 0
  # 文件名里带 %Y%m%d-%H%M%S，字典序即时间序。
  # sort -r 降序后 tail -n +N：前 N 份是最新的被留下，剩下的才是要删的旧备份。
  # （写成升序 + tail 会反过来把最新的删掉，这个坑实测踩过）
  find "$BACKUP_DIR" -maxdepth 1 -name 'manalong-data-*.tar.gz' 2>/dev/null | sort -r \
    | tail -n +$((KEEP_BACKUPS + 1)) | while read -r f; do
      rm -f "$f"
      log "清理旧备份 $(basename "$f")"
    done
}

backup_data() {
  if [ ! -d "$DATA_DIR" ]; then warn "没有 ${DATA_DIR}，跳过数据备份"; return 0; fi
  mkdir -p "$BACKUP_DIR"
  local out
  out="$BACKUP_DIR/manalong-data-$(date +%Y%m%d-%H%M%S).tar.gz"
  log "备份数据 → $out"
  # 容器已停，WAL 已落盘，此时打包是安全的（这正是先停容器再备份的原因）
  tar czf "$out" -C "$APP_DIR" data
  ok "备份完成（$(du -h "$out" | awk '{print $1}')，保留最近 $KEEP_BACKUPS 份）"
  prune_backups
}

# 容器自身的健康状态（compose 里定义了 healthcheck）
container_ready() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$CONTAINER" 2>/dev/null | grep -q '^\(healthy\|running\)$'
}

wait_healthy() {
  local expect="${1:-}" tries="${2:-45}" i body ver
  for i in $(seq 1 "$tries"); do
    # --noproxy '*'：本机回环探测必须绕开可能存在的 http_proxy，
    # 否则 curl 会把 127.0.0.1 交给代理，健康检查永远失败
    body="$(curl -fsS --noproxy '*' --max-time 3 "$HEALTH_URL" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      if [ -z "$expect" ]; then ok "服务已就绪"; return 0; fi
      ver="$(printf '%s' "$body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
      if [ "$ver" = "$expect" ]; then ok "服务已就绪，版本 $ver"; return 0; fi
    elif [ -z "$expect" ]; then
      # 老版本还没有 /api/health（这个端点是 20261016 才加的），
      # 回滚到旧版本时它会 404。此时退回看容器健康状态，否则回滚永远判不过。
      if container_ready; then
        ok "服务已就绪（旧版本无 /api/health，按容器健康状态判定）"
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

do_rollback() {
  warn "开始回滚到上一个版本"
  if ! docker image inspect manalong:previous >/dev/null 2>&1; then
    die "找不到回滚镜像 manalong:previous，无法自动回滚。请手动排查：docker compose logs --tail 100"
  fi
  docker compose stop "$CONTAINER" >/dev/null 2>&1 || true
  MANALONG_VERSION=previous docker compose up -d --no-build || die "回滚启动失败"
  if wait_healthy ""; then
    ok "已回滚，服务恢复正常（当前跑的是上一个版本）"
    notify "⚠ 满伴成长树部署失败，已自动回滚，服务正常。失败版本见 dist/ 下制品包。"
    return 0
  fi
  notify "🚨 满伴成长树部署失败且自动回滚后仍不健康，需立刻人工介入！"
  die "回滚后服务仍不健康，请立刻人工介入：docker compose logs --tail 200"
}

# ── 手动回滚 ────────────────────────────────────────────────────────
if [ "$MODE" = "rollback" ]; then
  do_rollback
  exit $?
fi

# ── 1. 记录回滚点 ───────────────────────────────────────────────────
OLD_VERSION="$(docker exec "$CONTAINER" printenv MANALONG_VERSION 2>/dev/null || echo '')"
CUR_IMG="$(docker inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"
if [ -n "$CUR_IMG" ]; then
  docker tag "$CUR_IMG" manalong:previous
  ok "回滚点已记录：manalong:previous（当前版本 ${OLD_VERSION:-未知}）"
else
  warn "没找到正在运行的 $CONTAINER 容器，本次无法自动回滚（首次部署属正常）"
fi

# ── 2. 找制品包 ─────────────────────────────────────────────────────
if [ -z "$PKG" ]; then
  PKG="$(ls -1t "$APP_DIR"/dist/manalong-*-src.tar.gz 2>/dev/null | head -1 || true)"
fi
if [ -z "$PKG" ] || [ ! -f "$PKG" ]; then
  die "找不到制品包。
  请先在开发机执行：bash scripts/build-release.sh
  再把 dist/manalong-*-src.tar.gz 传到服务器的 $APP_DIR/dist/"
fi
log "制品包：$PKG"

# ── 3. 解包 ─────────────────────────────────────────────────────────
log "解包（data/ 与 .env 不受影响）"
tar xzf "$PKG" -C "$APP_DIR"
NEW_VERSION="$(tr -d '[:space:]' < "$APP_DIR/VERSION" 2>/dev/null || true)"
[ -n "$NEW_VERSION" ] || die "解包后读不到 VERSION 文件，制品包可能不完整"
ok "目标版本：$NEW_VERSION"

if [ "$OLD_VERSION" = "$NEW_VERSION" ] && [ "${MANALONG_FORCE:-0}" != "1" ]; then
  warn "线上已经是 ${NEW_VERSION}，继续只会重建同版本镜像（想强制重建请加 MANALONG_FORCE=1）"
fi

# ── 4. 构建镜像（不动线上）───────────────────────────────────────────
MEM_MB="$(awk '/^MemTotal:/{printf "%d", $2/1024; exit}' /proc/meminfo 2>/dev/null || true)"
[ -n "${MEM_MB:-}" ] || MEM_MB=0
if [ "$MEM_MB" -gt 0 ] && [ "$MEM_MB" -lt 2500 ]; then
  warn "内存只有 ${MEM_MB}MB，构建镜像可能内存不足。"
  warn "若构建失败，先跑一次：bash scripts/server-init.sh（会加 2G swap）"
fi

log "构建镜像（服务仍在运行，这一步不碰线上）"
if ! MANALONG_VERSION="$NEW_VERSION" bash "$APP_DIR/scripts/docker-build.sh" --no-up; then
  die "镜像构建失败。服务未受影响，仍在跑 ${OLD_VERSION:-上一个版本}。看上面的报错。"
fi

# ── 5. 停机 → 备份 → 起新容器 ────────────────────────────────────────
if [ "$DO_BACKUP" = "1" ]; then
  log "停容器（为了能安全备份数据库）"
  docker compose stop "$CONTAINER" >/dev/null 2>&1 || true
  backup_data
else
  warn "已跳过数据备份（--no-backup）"
  docker compose stop "$CONTAINER" >/dev/null 2>&1 || true
fi

log "启动新版本 $NEW_VERSION"
MANALONG_VERSION="$NEW_VERSION" docker compose up -d --no-build

# ── 6. 健康检查 ─────────────────────────────────────────────────────
if wait_healthy "$NEW_VERSION" 45; then
  mkdir -p "$BACKUP_DIR"
  printf '%s  部署成功  %s -> %s\n' "$(date '+%F %T')" "${OLD_VERSION:-无}" "$NEW_VERSION" >> "$BACKUP_DIR/deploy.log"
  echo
  ok "部署完成：${OLD_VERSION:-无} → $NEW_VERSION"
  echo "  查看日志：docker compose logs -f --tail 100"
  echo "  数据备份：$BACKUP_DIR"
  [ "$DO_BACKUP" = "1" ] && echo "  手动回滚：bash scripts/deploy.sh --rollback"
  notify "✅ 满伴成长树部署成功：${OLD_VERSION:-无} → $NEW_VERSION"
  exit 0
fi

warn "新版本健康检查未通过（90 秒内没等到版本号 ${NEW_VERSION}）"
docker compose logs --tail 60 "$CONTAINER" >&2 || true
mkdir -p "$BACKUP_DIR"
printf '%s  部署失败  %s -> %s（已尝试回滚）\n' "$(date '+%F %T')" "${OLD_VERSION:-无}" "$NEW_VERSION" >> "$BACKUP_DIR/deploy.log"
do_rollback
exit 1
