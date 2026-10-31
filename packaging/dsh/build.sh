#!/bin/bash
# =============================================================
# build.sh —— 一条命令把上游 DeepSeek Harness（DSH）打成飞牛 fnOS 的 fpk
#
#   ./build.sh                          # 打包「上游最高版本」，本机架构
#   ./build.sh --version 0.2.1-rc.4     # 指定版本
#   ./build.sh --tag next               # 跟随 npm dist-tag（latest/next/alpha）
#   ./build.sh --arch arm64             # 目标 arm64（见下方「架构」说明）
#   ./build.sh --from ~/deepseek-harness # 用本地已 pnpm build 的上游源码打包
#   ./build.sh --keep-stage             # 保留 stage/ 便于排查
#   ./build.sh --print-version          # 只打印解析到的版本号（CI 用）
#
# --version 与 --upstream-version 的区别（打包修复重发时用得上）：
#   --upstream-version  从 npm 装哪个版本的 @deepseek-ai/dsh（= 上游 Release 版本）
#   --version           写进 manifest、决定应用中心显示/比较的版本号
# 默认两者相同；CI 会在"同一上游版本需要重发"时让 --version 比上游多一段
# （0.2.2-alpha.2 → 0.2.2-alpha.2.1），否则用户永远收不到这次更新。
#
# 产物：dist/DSH_v<版本>_<arch>.fpk
#
# 架构：npm 只按「本机架构」装原生产物（koffi/node-pty 等）。给别的架构打包
# 时脚本会传 --os/--cpu 让 npm 选预编译产物，但含本地编译的包仍可能不对；
# 稳妥做法是在目标架构的机器（或对应架构的容器/CI runner）上执行本脚本。
# =============================================================
set -euo pipefail

KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPSTREAM_REPO="deepseek-ai/deepseek-harness"

VERSION=""
UPSTREAM_VERSION=""
TAG=""
ARCH=""
OUT_DIR="${KIT_ROOT}/dist"
STAGE_DIR="${KIT_ROOT}/stage"
FROM_DIR=""
KEEP_STAGE=0
PRINT_VERSION=0
VERSION_EXPLICIT=0
FNOS_NODE_RUNTIME="/var/apps/nodejs_v24/target/bin/node"

usage() {
    awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version|-v) VERSION="${2:?}"; VERSION_EXPLICIT=1; shift 2 ;;
        --upstream-version) UPSTREAM_VERSION="${2:?}"; shift 2 ;;
        --tag|-t)     TAG="${2:?}"; shift 2 ;;
        --arch|-a)    ARCH="${2:?}"; shift 2 ;;
        --out|-o)     OUT_DIR="${2:?}"; shift 2 ;;
        --stage)      STAGE_DIR="${2:?}"; shift 2 ;;
        --from)       FROM_DIR="${2:?}"; shift 2 ;;
        --keep-stage) KEEP_STAGE=1; shift ;;
        --print-version) PRINT_VERSION=1; shift ;;
        --help|-h)    usage 0 ;;
        *) echo "未知参数: $1" >&2; usage 1 ;;
    esac
done

# 诊断输出一律走 stderr，stdout 只留给 --print-version 的版本号
log() { echo -e "\033[36m[build]\033[0m $*" >&2; }
die() { echo -e "\033[31m[build] FATAL:\033[0m $*" >&2; exit 1; }

# ---------- 架构 ----------
if [ -z "${ARCH}" ]; then
    case "$(uname -m)" in
        x86_64|amd64)  ARCH=amd64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *) die "不支持的本机架构 $(uname -m)，请用 --arch amd64|arm64 指定" ;;
    esac
fi
case "${ARCH}" in
    amd64|x64|x86_64) ARCH=amd64; NODE_ARCH=x64 ;;
    arm64|aarch64)    ARCH=arm64; NODE_ARCH=arm64 ;;
    *) die "--arch 只支持 amd64 / arm64（收到 ${ARCH}）" ;;
esac

# ---------- 版本 ----------
# 优先级：--version > --tag（npm dist-tag）> 上游 GitHub 最高版本
# > npm dist-tag next > latest
api() { curl -sfL --retry 2 -H "Accept: application/vnd.github+json" "$@"; }

if [ -n "${VERSION}" ]; then
    log "版本: ${VERSION}（命令行指定）"
elif [ -n "${TAG}" ]; then
    VERSION="$(npm view @deepseek-ai/dsh "dist-tags.${TAG}" 2>/dev/null || true)"
    [ -n "${VERSION}" ] || die "npm 上找不到 dist-tag: ${TAG}"
    log "版本: ${VERSION}（npm dist-tag ${TAG}）"
else
    # 取「版本号最高」而不是「发布得最晚」：上游会在老线上补丁（0.2.1-rc.5 晚于 0.2.2-alpha.2 发布），
    # 按列表顺序取会把版本号退回去。比较方式与飞牛一致：只比数字段。
    VERSION="$(api "https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=100" \
        | node -e '
            let s = "";
            process.stdin.on("data", (c) => { s += c; })
              .on("end", () => {
                  let rels = [];
                  try { rels = JSON.parse(s); } catch { /* 限流或断网 */ }
                  if (!Array.isArray(rels)) return console.log("");
                  const nums = (v) => String(v).split(/[^0-9]+/).filter(Boolean).map(Number);
                  const cmp = (a, b) => {
                      const A = nums(a), B = nums(b), n = Math.max(A.length, B.length);
                      for (let i = 0; i < n; i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d; }
                      return 0;
                  };
                  const vs = rels.filter((r) => r && !r.draft && String(r.tag_name || "").startsWith("dsh-v"))
                                 .map((r) => String(r.tag_name).replace(/^dsh-v/, ""));
                  console.log(vs.reduce((a, b) => (cmp(b, a) > 0 ? b : a), ""));
              });
        ' 2>/dev/null || true)"
    if [ -z "${VERSION}" ]; then
        VERSION="$(npm view @deepseek-ai/dsh dist-tags.next 2>/dev/null || true)"
        [ -n "${VERSION}" ] || VERSION="$(npm view @deepseek-ai/dsh version 2>/dev/null || true)"
    fi
    [ -n "${VERSION}" ] || die "无法确定上游版本，请用 --version 指定"
    log "版本: ${VERSION}（跟随上游最高版本）"
fi
VERSION="${VERSION#v}"
UPSTREAM_VERSION="${UPSTREAM_VERSION#v}"
[ -n "${UPSTREAM_VERSION}" ] || UPSTREAM_VERSION="${VERSION}"

# 只输出解析到的版本号就退出：供 CI 先算版本再分发到矩阵任务
if [ "${PRINT_VERSION}" -eq 1 ]; then
    echo "${VERSION}"
    exit 0
fi

# ---------- 来源 ----------
# 默认从 npm registry 装：@deepseek-ai/dsh 就是上游 apps/cli 的发布产物，
# 版本与上游 dsh-v* Release 一一对应，免去在本机构建整个 monorepo。
# --from 指向已 `pnpm install && pnpm run build` 过的上游 checkout 时，
# 改为从源码 pack 出 tgz —— 用于跟进尚未发布到 npm 的提交。
DSH_SOURCE="npm"
if [ -n "${FROM_DIR}" ]; then
    [ -d "${FROM_DIR}/packages" ] || die "--from 指向的不是 deepseek-harness 仓库: ${FROM_DIR}"
    command -v pnpm >/dev/null 2>&1 || die "源码模式需要 pnpm"
    [ -f "${FROM_DIR}/node_modules/.modules.yaml" ] \
        || die "源码模式需要先在该 checkout 里执行 pnpm install && pnpm run build"
    TGZ_DIR="${KIT_ROOT}/.tgz"
    rm -rf "${TGZ_DIR}"; mkdir -p "${TGZ_DIR}"
    log "从源码 pack tgz: ${FROM_DIR}"
    ( cd "${FROM_DIR}" && pnpm --filter @deepseek-ai/dsh pack --pack-destination "${TGZ_DIR}" >/dev/null )
    TGZ="$(ls "${TGZ_DIR}" | grep -E '^deepseek-ai-dsh-[0-9]' | head -1 || true)"
    [ -n "${TGZ}" ] || die "pnpm pack 未产出 dsh tgz"
    DSH_SOURCE="file:${TGZ_DIR}/${TGZ}"
    # 源码模式的版本以 tgz 内 package.json 为准（可能高于最新 Release）
    PKG_VERSION="$(tar -xzOf "${TGZ_DIR}/${TGZ}" package/package.json \
        | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
    if [ "${UPSTREAM_VERSION}" != "${PKG_VERSION}" ]; then
        log "上游版本以源码为准: ${UPSTREAM_VERSION} → ${PKG_VERSION}"
        UPSTREAM_VERSION="${PKG_VERSION}"
        # 发布版本没被显式指定时跟着源码走；显式指定（重发加后缀）时保持不变
        if [ "${VERSION_EXPLICIT}" -eq 0 ]; then VERSION="${PKG_VERSION}"; fi
    fi
    log "源码 tgz: ${DSH_SOURCE}"
fi

# ---------- 环境检查 ----------
command -v node >/dev/null 2>&1 || die "需要 Node.js（>=24）"
command -v npm  >/dev/null 2>&1 || die "需要 npm"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR}" -ge 24 ] || log "WARN: 本机 Node $(node -v)，上游要求 >=24.9.0（只影响装包解析，运行用 nodejs_v24）"
if [ -x "${FNOS_NODE_RUNTIME}" ]; then
    log "飞牛 Node 运行时: ${FNOS_NODE_RUNTIME} ($("${FNOS_NODE_RUNTIME}" -v 2>/dev/null))"
else
    log "WARN: 未找到 ${FNOS_NODE_RUNTIME}；本包依赖应用中心已安装 nodejs_v24"
fi

# ---------- 组装 ----------
log "组装应用目录（${ARCH}）：发布版本 ${VERSION}，上游版本 ${UPSTREAM_VERSION}..."
STAGE_DIR="${STAGE_DIR}" \
DSH_VERSION="${VERSION}" \
DSH_UPSTREAM_VERSION="${UPSTREAM_VERSION}" \
TARGET_ARCH="${ARCH}" \
NODE_ARCH="${NODE_ARCH}" \
DSH_SOURCE="${DSH_SOURCE}" \
    bash "${KIT_ROOT}/scripts/assemble.sh"

# ---------- 打包 ----------
mkdir -p "${OUT_DIR}"
TOOLS_DIR="${KIT_ROOT}/.tools"

# fnpack 各版本对 manifest version 的校验宽严不同：
#   1.2.1 接受上游原样版本（0.2.2-alpha.2、0.2.1-rc.4 都能打）
#   1.2.4 只接受 x.y.z[-r]（r 为整数），会把带字母段的预发布版本判为非法
# 上游版本号原样保留才能和上游 Release 对照，所以优先 1.2.1：
# 先试本机 fnpack，不行就下载官方 1.2.1 二进制到 .tools/ 再试。
# 注意 fnpack 失败时退出码仍是 0，只能靠输出文本 + 产物文件双重判断。
pack_with() {
    local bin="$1" out
    out="$( cd "${STAGE_DIR}/DSH" && rm -f ./*.fpk && "${bin}" build 2>&1 )" || true
    echo "${out}"
    echo "${out}" | grep -qiE 'packing failed|invalid version' && return 1
    ls "${STAGE_DIR}/DSH"/*.fpk >/dev/null 2>&1 || return 1
    return 0
}

FALLBACK_BIN="${TOOLS_DIR}/fnpack-1.2.1"
fetch_fnpack_121() {
    [ -x "${FALLBACK_BIN}" ] && return 0
    local url="https://static2.fnnas.com/fnpack/fnpack-1.2.1-linux-${ARCH}"
    log "下载 fnpack 1.2.1（${ARCH}）：${url}"
    mkdir -p "${TOOLS_DIR}"
    curl -sfL --retry 3 -o "${FALLBACK_BIN}" "${url}" && chmod +x "${FALLBACK_BIN}"
}

log "fnpack 打包（版本号 ${VERSION}）..."
PACKED=0
if command -v fnpack >/dev/null 2>&1; then
    if pack_with fnpack; then PACKED=1; else
        log "本机 fnpack 不接受版本号 ${VERSION}，改用 fnpack 1.2.1"
    fi
fi
if [ "${PACKED}" -eq 0 ]; then
    fetch_fnpack_121 || die "下载 fnpack 1.2.1 失败"
    pack_with "${FALLBACK_BIN}" || die "fnpack build 失败（见上方输出）"
fi
FPK="$(ls "${STAGE_DIR}/DSH"/*.fpk 2>/dev/null | head -1 || true)"
[ -n "${FPK}" ] || die "fnpack 未产出 fpk"
OUT_FPK="${OUT_DIR}/DSH_v${VERSION}_${ARCH}.fpk"
mv -f "${FPK}" "${OUT_FPK}"

# ---------- 汇总 ----------
SHA="$(sha256sum "${OUT_FPK}" | cut -d' ' -f1)"
SIZE="$(stat -c%s "${OUT_FPK}")"
[ "${KEEP_STAGE}" -eq 1 ] || rm -rf "${STAGE_DIR}"
cat <<EOF

[build] 完成
  产物: ${OUT_FPK}
  版本: ${VERSION}
  架构: ${ARCH}
  大小: $(numfmt --to=iec "${SIZE}" 2>/dev/null || echo "${SIZE} 字节")
  sha256: ${SHA}

安装: 飞牛应用中心 → 手动安装 → 上传该 fpk（已安装则覆盖升级）
依赖: 应用中心需已安装 nodejs_v24 运行时
访问: 飞牛桌面点 DSH 图标，或 http://<NAS地址>:3080
EOF
