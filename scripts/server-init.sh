#!/usr/bin/env bash
# 成长树 · 服务器初始化（Ubuntu / Debian，在服务器上以 root 执行）
#
# 用法：
#   bash server-init.sh              # 基础初始化：装 Docker、加 swap、建目录、装 fail2ban
#   bash server-init.sh --harden     # 安全加固：关掉密码登录（必须先确认密钥能登录）
#
# ⚠️ --harden 会关闭 SSH 密码登录。执行前脚本会检查 /root/.ssh/authorized_keys
#    是否已有公钥；没有公钥就拒绝执行 —— 否则你会把自己锁在服务器外面。
#
# 为什么必须加 swap：这台机器是 2核2G，而 docker build 要跑 npm ci + 编译
# better-sqlite3，内存不够时会被 OOM Killer 杀掉（表现为构建莫名其妙中断）。
# 加 2G swap 后构建能跑完，只是慢一点。
set -euo pipefail

APP_DIR="${GROWTREE_APP_DIR:-/data/growtree}"
BACKUP_DIR="$(dirname "$APP_DIR")/growtree-backups"
SWAP_SIZE="${GROWTREE_SWAP_SIZE:-2G}"

log()  { printf '· %s\n' "$*"; }
ok()   { printf '✓ %s\n' "$*"; }
warn() { printf '⚠  %s\n' "$*" >&2; }
die()  { printf '✗ %s\n' "$*" >&2; exit 1; }

DO_HARDEN=0
for arg in ${1+"$@"}; do
  case "$arg" in
    --harden) DO_HARDEN=1 ;;
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) die "未知参数：$arg" ;;
  esac
done

[ "$(id -u)" = "0" ] || die "请用 root 执行：sudo bash $0"

# ── 1. 基础软件 ─────────────────────────────────────────────────────
log "安装基础软件（curl git ca-certificates tzdata）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates tzdata fail2ban >/dev/null

log "设置时区为 Asia/Shanghai（「今日积分」等统计按本地自然日切分）"
timedatectl set-timezone Asia/Shanghai 2>/dev/null || ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime

# ── 2. Docker ───────────────────────────────────────────────────────
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "Docker 已安装：$(docker --version | cut -d, -f1)"
else
  log "安装 Docker（走阿里云镜像源，国内网络下比官方源快很多）"
  if ! curl -fsSL --max-time 60 https://get.docker.com | bash -s docker --mirror Aliyun; then
    warn "官方安装脚本失败，改用清华 apt 源重试"
    apt-get install -y -qq apt-transport-https gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://mirrors.tuna.tsinghua.edu.cn/docker-ce/linux/ubuntu/gpg \
      -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://mirrors.tuna.tsinghua.edu.cn/docker-ce/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker
  ok "Docker 安装完成：$(docker --version | cut -d, -f1)"
fi

# ── 3. swap ─────────────────────────────────────────────────────────
if swapon --show 2>/dev/null | grep -q .; then
  ok "已有 swap：$(swapon --show=SIZE --noheadings | tr -d ' ' | tr '\n' ' ')"
else
  log "创建 $SWAP_SIZE swap（2核2G 构建镜像不加 swap 会被 OOM 杀掉）"
  if ! fallocate -l "$SWAP_SIZE" /swapfile 2>/dev/null; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  fi
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -qw vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
  ok "swap 已启用：$(swapon --show=SIZE --noheadings | tr -d ' ')"
fi

# ── 4. 部署目录 ─────────────────────────────────────────────────────
log "创建部署目录"
mkdir -p "$APP_DIR/dist" "$BACKUP_DIR"
ok "$APP_DIR        ← 代码与 data/"
ok "$APP_DIR/dist   ← 放制品包 growtree-*-src.tar.gz"
ok "$BACKUP_DIR     ← 数据备份（保留最近 7 份）"

# ── 5. fail2ban ─────────────────────────────────────────────────────
if systemctl list-unit-files 2>/dev/null | grep -q '^fail2ban.service'; then
  systemctl enable --now fail2ban >/dev/null 2>&1 || true
  ok "fail2ban 已启用（自动封禁反复试探 SSH 的 IP）"
fi

# ── 6. 安全加固（可选，默认不动）────────────────────────────────────
if [ "$DO_HARDEN" = "0" ]; then
  echo
  echo "──────────────────────────────────────────────────────────────"
  echo "基础初始化完成。下一步（按顺序）："
  echo "  1) 把开发机的 SSH 公钥装好，确认不用密码就能登录"
  echo "  2) 再执行： bash server-init.sh --harden   （关掉密码登录）"
  echo "  3) 在腾讯云控制台把安全组只放行 80 / 443 / 你的 SSH 端口"
  echo "  4) 从开发机把制品包传到 $APP_DIR/dist/，然后： bash scripts/deploy.sh"
  echo "──────────────────────────────────────────────────────────────"
  exit 0
fi

log "开始安全加固"
AUTH_KEYS="/root/.ssh/authorized_keys"
if [ ! -s "$AUTH_KEYS" ]; then
  die "没找到 $AUTH_KEYS 或它是空的。
  此时关掉密码登录会把你锁在服务器外面。
  请先确认「不用密码就能 SSH 登录」，再来跑 --harden。"
fi
ok "已确认 $(wc -l < "$AUTH_KEYS") 条公钥，可以安全地关闭密码登录"

SSHD_CONF="/etc/ssh/sshd_config"
cp -n "$SSHD_CONF" "${SSHD_CONF}.bak-$(date +%Y%m%d)" 2>/dev/null || true

set_sshd() {
  local key="$1" val="$2"
  if grep -qE "^[#[:space:]]*${key}[[:space:]]" "$SSHD_CONF"; then
    sed -i -E "s|^[#[:space:]]*${key}[[:space:]].*|${key} ${val}|" "$SSHD_CONF"
  else
    echo "${key} ${val}" >> "$SSHD_CONF"
  fi
}

set_sshd PasswordAuthentication no
set_sshd PubkeyAuthentication yes
set_sshd ChallengeResponseAuthentication no
set_sshd KbdInteractiveAuthentication no
set_sshd X11Forwarding no

if sshd -t 2>/dev/null; then
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  ok "SSH 密码登录已关闭（公钥登录不受影响）"
else
  warn "sshd 配置校验失败，已回滚到备份"
  cp "${SSHD_CONF}.bak-"* "$SSHD_CONF" 2>/dev/null || true
  die "加固失败，配置已还原。请人工检查 $SSHD_CONF"
fi

echo
ok "加固完成。现在只有持有对应私钥的机器能登录服务器。"
echo "  · 建议先另开一个终端，确认还能登录，再关掉当前连接"
echo "  · 别忘了在腾讯云控制台安全组里只放行 80 / 443 / SSH 端口"
