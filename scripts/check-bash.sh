#!/usr/bin/env bash
# 满伴成长树 · 脚本自检：本项目的 shell 脚本必须在 macOS 自带的 bash 3.2 上能跑
#
# 用法： bash scripts/check-bash.sh
#
# 为什么需要它：这些脚本大量输出中文，而 macOS 的 bash 3.2 在 UTF-8 locale 下
# 会把**任何非 ASCII 字节**都当成合法的变量名字符。于是
#     echo "版本 $VERSION　模式 ..."      # 全角空格紧跟变量
# 会被解析成一个叫 `VERSION　` 的变量，在 set -u 下直接以
# "unbound variable" 崩掉 —— 而且往往只在某条报错分支里才走到，平时发现不了。
# 正确写法是加花括号：${VERSION}　模式。
#
# 另外 bash 3.2 没有 mapfile / 关联数组 / ${var^^} 这些 4.x 才有的东西。
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 待检查的文件：scripts/ 下所有 .sh、miniprogram/scripts/ 下所有 .sh，
# 以及 .githooks/ 里的钩子（没有扩展名）。
# ⚠️ miniprogram/scripts/ 必须列进来：它是独立的构建脚本目录（小程序不在 npm
#    workspaces 里，所以没被上面的 scripts/ 覆盖）。2026-10-16 就在这里踩了一次
#    「$API 后面紧跟（开发登录已开）」的坑。
FILES=""
for p in scripts/*.sh miniprogram/scripts/*.sh .githooks/*; do
  [ -f "$p" ] && FILES="${FILES}${p}"$'\n'
done

fail=0

# ── 1. 变量后紧跟非 ASCII 字符（bash 3.2 的坑）────────────────────────────
echo "== 1/2 变量后紧跟非 ASCII 字符 =="
if command -v python3 >/dev/null 2>&1; then
  hits="$(printf '%s' "$FILES" | python3 -c '
import re, sys
pat = re.compile(r"(?<!\$)\$([A-Za-z_][A-Za-z0-9_]*)(?=[\u0080-\uffff])")
out = []
for p in sys.stdin.read().split():
    for i, line in enumerate(open(p, encoding="utf-8"), 1):
        s = line.lstrip()
        if s.startswith("#"):      # 注释里不会做变量展开，不算问题
            continue
        for m in pat.finditer(line):
            out.append("  %s:%d  %s    ← 应写成 ${%s}" % (p, i, m.group(0), m.group(1)))
print("\n".join(out))
')"
  if [ -n "$hits" ]; then
    printf '%s\n' "$hits"
    echo "  ✗ 上面这些位置必须加花括号（bash 3.2 会把后面的中文字符吃进变量名）"
    fail=1
  else
    echo "  ✓ 没有「变量后紧跟非 ASCII」的写法"
  fi
else
  echo "  （没有 python3，跳过；建议装上以便检查）"
fi

# ── 2. 语法 + bash 4+ 专有特性 ──────────────────────────────────────────
echo
echo "== 2/2 语法与 bash 版本兼容性 =="
syn=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if ! err="$(bash -n "$f" 2>&1)"; then
    echo "  ✗ $f 语法错误：$err"
    syn=1
  fi
done <<< "$FILES"
[ "$syn" = "0" ] && echo "  ✓ 全部脚本语法正确" || fail=1

# mapfile / readarray / 关联数组 / ${var^^} ${var,,} / &>> —— 都是 bash 4.x 才有的
FEAT='\b(mapfile|readarray)\b|declare[[:space:]]+-A|local[[:space:]]+-A|\$\{[A-Za-z_][A-Za-z0-9_]*(\^\^|,,)\}|&>>'
if printf '%s' "$FILES" | grep -lE "$FEAT" >/dev/null 2>&1; then
  echo "  ✗ 以下脚本用了 bash 4+ 专有写法（macOS 自带的是 3.2）："
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    grep -nE "$FEAT" "$f" 2>/dev/null | sed "s|^|      $f:|"
  done <<< "$FILES"
  fail=1
else
  echo "  ✓ 没有用到 bash 4+ 专有写法"
fi

echo
if [ "$fail" = "0" ]; then
  echo "✓ 自检通过（bash 3.2 可运行）"
else
  echo "✗ 自检未通过，请修掉上面列出的问题" >&2
fi
exit "$fail"
