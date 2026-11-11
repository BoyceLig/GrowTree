#!/usr/bin/env bash
# 上传前自检：确认暂存区里没有真实家庭数据、数据库、照片、密钥
#
# 用法：bash scripts/privacy-check.sh
# 退出码 0 = 干净，1 = 有可疑文件（已打印出来）
#
# 背景：这个项目的 .gitignore 曾经写过 `data`（不带斜杠），结果匹配不到
# data-backup-20260930-shopcat/，差点把真实的孩子数据打进更新包。
# 所以这里用宽松的模糊匹配兜底，宁可疑报也不放过。
#
# 注意：macOS 自带的是 bash 3.2，别用 mapfile / 关联数组这些 4.0 才有的东西。
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PATTERN='(^|/)(data|data-[^/]*)/|\.db(-shm|-wal)?$|/uploads/|(^|/)\.env'

hits="$(git diff --cached --name-only 2>/dev/null | grep -Ei "$PATTERN" || true)"

if [ -n "$hits" ]; then
  echo "✗ 暂存区里有疑似敏感文件，已中止：" >&2
  printf '%s\n' "$hits" | sed 's/^/    /' >&2
  cat >&2 <<'EOF'

  这些内容绝不能进仓库：
    · data/、data-backup-*/  真实家庭数据（积分、任务、成长记录）
    · *.db / *.db-wal        数据库本体
    · **/uploads/            小孩照片、成长日记图片视频
    · .env                   密码与密钥

  确认是误报 → git reset HEAD <文件>
EOF
  exit 1
fi

echo "✓ 隐私自检通过"
