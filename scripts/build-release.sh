#!/usr/bin/env bash
# 满伴成长树 · 打一个可部署到服务器的制品包（在开发机上执行）
#
# 用法：
#   bash scripts/build-release.sh          # 完整部署包（保留扩展模块）
#   bash scripts/build-release.sh --oss    # 自建版更新包（剥离扩展模块代码）
#
# 产出：dist/manalong-<版本>[-oss]-src.tar.gz
#
# ── 为什么用制品包，而不是让服务器 git pull？────────────────────────
#   1. Docker 构建需要 web/dist，而它是构建产物、不入库（.gitignore 排除了）
#      → 服务器上 git pull 之后 web/dist 不存在，docker build 直接失败
#   2. 开发机是 arm64、服务器是 amd64。在开发机 buildx 交叉构建要走 QEMU
#      模拟跑 npm ci，很慢；在服务器本地构建是原生速度
#   ⇒ 所以：开发机只负责「把前端编译好 + 打源码包」，镜像在服务器上构建
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(pwd)"

MODE="full"
for arg in ${1+"$@"}; do
  case "$arg" in
    --oss) MODE="oss" ;;
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "未知参数：${arg}（支持 --oss）" >&2; exit 1 ;;
  esac
done

VERSION="$(tr -d '[:space:]' < VERSION 2>/dev/null || true)"
[ -n "$VERSION" ] || { echo "✗ 读不到 VERSION 文件" >&2; exit 1; }

echo "== 构建版本：${VERSION}　模式：$([ "$MODE" = oss ] && echo '自建版（已剥离扩展模块）' || echo '完整版')"

# 先自检脚本：中文输出 + bash 3.2 的组合很容易出「变量名被中文吃掉」这类问题，
# 而它常常只在报错分支里才暴露出来（发版时才炸就晚了）
bash scripts/check-bash.sh || exit 1
echo

echo "== 1/3 构建前端"
cd "$ROOT/web"
rm -rf dist
npm run build

echo "== 2/3 构建后端（编译检查，同时让制品包自带 server/dist 便于核对）"
cd "$ROOT"
npm run build --workspace server

[ -f "$ROOT/web/dist/index.html" ] || { echo "✗ 前端产物缺失：web/dist/index.html" >&2; exit 1; }
[ -f "$ROOT/server/dist/index.js" ] || { echo "✗ 后端产物缺失：server/dist/index.js" >&2; exit 1; }

echo "== 3/3 打包"
mkdir -p "$ROOT/dist"
if [ "$MODE" = "oss" ]; then
  OUT="$ROOT/dist/manalong-${VERSION}-oss-src.tar.gz"
  EXT_EXCLUDES=(--exclude='server/src/ext' --exclude='server/dist/ext')
else
  OUT="$ROOT/dist/manalong-${VERSION}-src.tar.gz"
  # ⚠️ 这个数组在非 oss 模式下是空的，而 macOS 自带的 bash 3.2 在 `set -u` 下
  #    展开**空数组** `"${EXT_EXCLUDES[@]}"` 会直接报 "unbound variable" 退出
  #    （bash 4+ 才修掉这个行为，不是拼写问题，在 Linux 上跑完全正常）。
  #    所以下面 tar 那一行必须写成 "${EXT_EXCLUDES[@]+"${EXT_EXCLUDES[@]}"}"，
  #    别为了"看起来简洁"改回原样，否则整个打包步骤静默不出包。
  EXT_EXCLUDES=()
fi
rm -f "$OUT"

# ── 打包哪些顶层条目 ────────────────────────────────────────────────────
# ⚠️ 千万不要用 --exclude 去排「构建产物目录」。
#    macOS 自带的是 bsdtar，它的 --exclude 模式**不锚定在路径开头**：
#    写 --exclude='./dist' 会把 ./dist、./web/dist、./server/dist 三个一起排掉
#    （实测三个同时消失，换成 './dist/*' 结果完全一样）。
#    后果很实在：制品包里没有 web/dist（如今镜像虽会在容器内重新编译前端，
#    但产物缺失=本地构建失败的信号，自检会拦下），早期 Dockerfile 是
#    `COPY web/dist/ ./web/dist/` 时更是在服务器上 docker build 直接失败。
#    整个制品包等于废的，而且要到服务器上才炸。
#    ⇒ 所以改成：显式列出要打包的顶层条目，跳过不该进包的。
#
#    同理，凡是要按名字排除的目录，都别与源码里的目录重名；
#    下面一律用**裸名**写法（bsdtar 会按「任意路径段」匹配，实测有效）。
TOP_SKIP=" dist release data .git .githooks .github .workbuddy .trae .vscode .idea node_modules .env deploy-cloud .gitee-remote .gitee-cloud-remote "
TOPS=()
while IFS= read -r entry; do
  case "$TOP_SKIP" in *" $entry "*) continue ;; esac
  case "$entry" in data-*) continue ;; esac        # data-backup-* 等备份目录
  TOPS+=("./$entry")
done < <(ls -A "$ROOT")

tar czf "$OUT" \
  --exclude='node_modules' --exclude='.DS_Store' \
  --exclude='*.log' --exclude='*.apk' --exclude='*.fpk' \
  --exclude='web/dist/assets/*.map' \
  --exclude='miniprogram' --exclude='admin' \
  --exclude='scripts/push-private.sh' --exclude='scripts/publish-oss.sh' \
  --exclude='scripts/install-hooks.sh' --exclude='scripts/push-gitee.sh' \
  --exclude='scripts/push-gitee-mac-gui.sh' \
  --exclude='scripts/pre-push-check.sh' --exclude='scripts/cloud-image.sh' \
  "${EXT_EXCLUDES[@]+"${EXT_EXCLUDES[@]}"}" \
  -C "$ROOT" "${TOPS[@]}"

TARLIST="$(mktemp -t manalong-tarlist)"
tar tzf "$OUT" > "$TARLIST"

echo
SIZE="$(du -h "$OUT" | awk '{print $1}')"
echo "✓ 制品包：$OUT  （${SIZE}）"
echo

# 交付前自检 1：构建产物必须在包里。
# 前后端虽然已改为 Dockerfile 容器内编译（源码在包里就能构建镜像），
# 但产物缺失意味着本地构建半途失败 —— 在这里拦下，别把半成品包传出去。
MISSING=""
for need in './web/dist/index.html' './server/dist/index.js'; do
  grep -qxF "$need" "$TARLIST" || MISSING="$MISSING $need"
done
if [ -n "$MISSING" ]; then
  echo "✗ 制品包里缺少构建产物：$MISSING" >&2
  echo "  说明本地构建未完成，请先排查 npm run build 为何失败" >&2
  rm -f "$OUT" "$TARLIST"; exit 1
fi
echo "✓ 前后端构建产物都在包里"

# 交付前自检 2：绝不能把真实数据打进去
BAD="$(grep -Ec '(^|/)(data|data-[^/]*)/|\.db(-shm|-wal)?$|/uploads/|(^|/)\.env$' "$TARLIST" || true)"
if [ "$BAD" != "0" ]; then
  echo "✗ 制品包里出现 $BAD 个疑似隐私文件，已删除该包，请检查排除规则" >&2
  grep -E '(^|/)(data|data-[^/]*)/|\.db(-shm|-wal)?$|/uploads/|(^|/)\.env$' "$TARLIST" | head -20 >&2
  rm -f "$OUT" "$TARLIST"
  exit 1
fi

if [ "$MODE" = "oss" ]; then
  EXT_IN="$(grep -cE '^\./server/(src|dist)/ext/' "$TARLIST" || true)"
  if [ "$EXT_IN" != "0" ]; then
    echo "✗ 自建版包里仍含扩展模块代码（$EXT_IN 个文件）" >&2
    rm -f "$OUT" "$TARLIST"; exit 1
  fi
  echo "✓ 已确认剥离扩展模块代码"

  # 前置条件：server 的构建必须先清空 dist 再编译。
  #
  # 为什么必须守住它：源文件一旦挪位置（例如 db/tenant.ts → ext/tenant.ts），
  # 旧的编译产物会原地留在 server/dist 里。镜像构建时 `COPY server/ ./server/`
  # 会把整个 server/ 带进构建上下文，残留文件于是有机会跟着进镜像。
  # 只要构建前清了 dist，这类残留就不可能存在 —— 所以这里断言的是「会清」，
  # 而不是事后扫描残留（事后扫描没有意义：构建刚把它清掉了）。
  if ! grep -q "rmSync('dist'" server/package.json 2>/dev/null; then
    echo "✗ server 的 build 脚本没有先清空 dist，可能残留过期产物（见本段注释）" >&2
    rm -f "$OUT" "$TARLIST"; exit 1
  fi
  echo "✓ server 构建会先清空 dist（不会残留过期产物）"
fi

rm -f "$TARLIST"

echo "  传到服务器后在那边执行： bash scripts/deploy.sh"
