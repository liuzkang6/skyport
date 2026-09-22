#!/bin/sh
# 双远端推送：GitHub（origin，重试 5 次）优先，本地 Gitea（local，重试 3 次）始终镜像。
# 用法：scripts/push-all.sh [git push 的额外参数，如 --tags]
# 任一远端失败只是警告不中断另一个；两者都失败才返回非零。
set -u
EXTRA="${1:-}"

push_with_retry() {
  remote="$1"; tries="$2"; ok=0
  i=1
  while [ "$i" -le "$tries" ]; do
    if out=$(git push "$remote" main $EXTRA 2>&1); then
      echo "✓ $remote 推送成功"
      ok=1; break
    else
      echo "… $remote 第 $i 次失败: $(echo "$out" | tail -1 | cut -c1-70)"
    fi
    i=$((i + 1)); sleep 5
  done
  [ "$ok" -eq 1 ] || echo "✗ $remote 最终失败（不阻断另一远端）"
  return $((1 - ok))
}

fail=0
push_with_retry origin 5 || fail=1
push_with_retry local 3 || fail=1
exit "$fail"
