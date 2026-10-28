#!/bin/bash
# =============================================================
# push-index.sh —— 推送由脚本生成的索引（apps/*.json、fnpack.json、README.md 等）
#
# 为什么需要它：
#   follow-upstream / router2api-build / router2api-sync 会并发修改同一批
#   生成文件。原先的写法是「提交 → git pull --rebase --autostash || true → git push」，
#   一旦变基冲突，HEAD 就停在 detached 状态，`|| true` 把错误吞掉后 git push 直接
#   报 “fatal: You are not currently on a branch”（exit 128），整条流水线失败，
#   索引也没更新（表现为应用中心里的 sha256/大小与实际资产对不上）。
#
# 做法：
#   这些文件都是脚本生成的，手工解冲突没有意义。改为「以最新远端为基准，重跑
#   生成脚本，再提交推送」，被并发提交抢先就重试。生成脚本幂等，重跑安全。
#
# 用法：
#   scripts/push-index.sh --message "chore: ..." --regen 'node scripts/sync-router2api.mjs; ...'
#
#   环境变量：GITHUB_REF_NAME（默认 main）、REPO、以及 --regen 里用到的变量
# =============================================================
set -euo pipefail

MESSAGE=""
REGEN=""
BRANCH="${GITHUB_REF_NAME:-main}"

while [ $# -gt 0 ]; do
    case "$1" in
        --message) MESSAGE="$2"; shift 2 ;;
        --regen)   REGEN="$2";   shift 2 ;;
        --branch)  BRANCH="$2";  shift 2 ;;
        *) echo "未知参数: $1" >&2; exit 2 ;;
    esac
done
[ -n "${MESSAGE}" ] || { echo "缺少 --message" >&2; exit 2; }

git config user.name  "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

for attempt in 1 2 3; do
    echo "==> 第 ${attempt} 次尝试：以 origin/${BRANCH} 为基准重新生成索引"
    git fetch origin "${BRANCH}"
    # 丢弃本作业先前生成的中间结果，避免把旧基准上的索引推上去
    git reset --hard "origin/${BRANCH}"

    if [ -n "${REGEN}" ]; then
        bash -eo pipefail -c "${REGEN}"
    fi

    git add -A
    if git diff --cached --quiet; then
        echo "索引无变化，无需推送"
        exit 0
    fi
    git commit -m "${MESSAGE}"

    if git push origin "HEAD:${BRANCH}"; then
        echo "已推送：${MESSAGE}"
        exit 0
    fi
    echo "推送被并发提交抢先，重试" >&2
    sleep 5
done

echo "::error::索引推送失败：连续 3 次被并发提交抢先，索引未更新" >&2
exit 1
