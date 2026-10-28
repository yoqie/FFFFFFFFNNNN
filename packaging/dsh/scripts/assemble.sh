#!/bin/bash
# =============================================================
# assemble.sh —— 把上游 DSH 装进 fnOS 应用壳，产出 fnpack 可直接打包的目录
#
# 输入（环境变量）：
#   STAGE_DIR    必填。输出目录（会被清空重建）
#   DSH_VERSION  必填。写入 manifest 的版本号（= 上游版本）
#   TARGET_ARCH  可选。amd64（默认）/ arm64
#   NODE_ARCH    可选。x64（默认）/ arm64，npm 原生模块目录名
#   DSH_SOURCE   可选。"npm"（默认，从 registry 装 @deepseek-ai/dsh@<版本>）
#                或 "file:/abs/path/pkg.tgz"（从源码构建出的 tgz 装）
#
# 产出：$STAGE_DIR/DSH/ —— 可直接 cd 进去 fnpack build
# =============================================================
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_DIR="${STAGE_DIR:?请设置 STAGE_DIR}"
DSH_VERSION="${DSH_VERSION:?请设置 DSH_VERSION}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"
NODE_ARCH="${NODE_ARCH:-x64}"
DSH_SOURCE="${DSH_SOURCE:-npm}"

APP="${STAGE_DIR}/DSH"          # fnpack 的包根
CONTENT="${APP}/app"            # 打成 app.tgz，安装后解压到 TRIM_APPDEST

say() { echo "  $*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

echo "==> [1/6] 准备目录（${TARGET_ARCH} / node-${NODE_ARCH} / v${DSH_VERSION}）"
rm -rf "${STAGE_DIR}"
mkdir -p "${APP}" "${CONTENT}"

echo "==> [2/6] 应用壳"
# manifest 的 version 决定应用中心显示的版本号，必须与 fpk 文件名一致。
# 注意是 "version" + 空格 + "="：用 ^version= 匹配不到（曾导致版本号长期不变）。
sed -i "s/^version[[:space:]]*=.*/version               = ${DSH_VERSION}/" "${KIT}/appshell/manifest"
grep -q "^version[[:space:]]*= *${DSH_VERSION}$" "${KIT}/appshell/manifest" \
    || die "写入 manifest 版本号失败（期望 ${DSH_VERSION}）"
cp "${KIT}/appshell/manifest" "${APP}/"
cp -r "${KIT}/appshell/cmd" "${KIT}/appshell/config" "${KIT}/appshell/wizard" "${APP}/"
cp -r "${KIT}/appshell/ui" "${APP}/"
cp "${KIT}/appshell/ICON.PNG" "${KIT}/appshell/ICON_256.PNG" "${APP}/"
# app/ui 必须存在：fnpack 打 app.tgz 时缺它会在校验阶段直接失败
cp -r "${KIT}/appshell/ui" "${CONTENT}/"
say "manifest / cmd / config / wizard / ui / 图标"

echo "==> [3/6] 入口跳转器与启动资源"
mkdir -p "${CONTENT}/gate"
cp "${KIT}/gate/gate.js" "${CONTENT}/gate/gate.js"
say "gate/gate.js（把浏览器 302 到带启动令牌的官方地址）"

echo "==> [4/6] 安装 DSH 与运行时依赖"
# Node 不自带：manifest 声明 install_dep_apps=nodejs_v24，由应用中心提供
# /var/apps/nodejs_v24/target/bin/node（省 100MB+）。
# pnpm 必须随包：dsh 的插件安装器直接 execa("pnpm")，服务端 PATH 里没有它。
DEP_SPEC="${DSH_SOURCE}"
if [ "${DEP_SPEC}" = "npm" ]; then
    DEP_SPEC="${DSH_VERSION}"
    say "来源: registry @deepseek-ai/dsh@${DSH_VERSION}"
else
    [ -f "${DEP_SPEC#file:}" ] || die "DSH_SOURCE 指向的文件不存在: ${DEP_SPEC}"
    say "来源: 本地 tgz ${DEP_SPEC}"
fi

node -e '
const fs = require("fs");
const [file, dep] = process.argv.slice(1);
fs.writeFileSync(file, JSON.stringify({
  name: "dsh-fnos-app",
  version: "1.0.0",
  private: true,
  dependencies: { "@deepseek-ai/dsh": dep, pnpm: "10.14.0" },
}, null, 2) + "\n");
' "${CONTENT}/package.json" "${DEP_SPEC}"

# 交叉架构时让 npm 选对预编译原生产物；同架构不需要传
NPM_ARCH_ARGS=()
HOST_ARCH="$(node -p 'process.arch')"
if [ "${NODE_ARCH}" != "${HOST_ARCH}" ]; then
    say "WARN: 目标 node-${NODE_ARCH} 与本机 node-${HOST_ARCH} 不同，按 --os/--cpu 选预编译产物"
    NPM_ARCH_ARGS=(--os=linux "--cpu=${NODE_ARCH}")
fi

say "npm install（$(npm --version)）"
set +e
(cd "${CONTENT}" && npm install --omit=dev --no-audit --no-fund --loglevel=error "${NPM_ARCH_ARGS[@]}")
INSTALL_EXIT=$?
if [ ${INSTALL_EXIT} -ne 0 ]; then
    # 上游偶发引用尚未发布到 npm 的包（新 experimental 包常滞后），npm 报 E404。
    # 只剔除日志里确认 404 的包后重试一次，其它失败原因不误删依赖。
    (cd "${CONTENT}" && npm install --omit=dev --no-audit --no-fund --loglevel=error "${NPM_ARCH_ARGS[@]}") \
        > /tmp/dsh-npm-install.log 2>&1 || true
    MISSING=$(grep -oE '404 Not Found - GET (\S+)' /tmp/dsh-npm-install.log 2>/dev/null \
        | sed 's/404 Not Found - GET //' \
        | node -e '
            const seen = new Set();
            require("node:readline").createInterface({ input: process.stdin })
              .on("line", (line) => {
                  try {
                      const name = decodeURIComponent(new URL(line.trim()).pathname).replace(/^\//, "");
                      if (name) seen.add(name);
                  } catch {}
              })
              .on("close", () => console.log([...seen].join(" ")));
        ')
    if [ -n "${MISSING}" ]; then
        say "WARN: npm 上不存在的依赖，剔除后重试: ${MISSING}"
        (cd "${CONTENT}" && node -e '
            const fs = require("fs");
            const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
            for (const field of ["dependencies", "optionalDependencies"]) {
                if (!pkg[field]) continue;
                for (const name of process.argv.slice(1)) delete pkg[field][name];
            }
            fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
        ' ${MISSING}) || true
        (cd "${CONTENT}" && npm install --omit=dev --no-audit --no-fund --loglevel=error "${NPM_ARCH_ARGS[@]}")
        INSTALL_EXIT=$?
    fi
fi
set -e
[ ${INSTALL_EXIT} -eq 0 ] || die "npm install 失败（exit ${INSTALL_EXIT}）"

# 顶层静态 import 校验：dsh 的 lib 里有顶层 import，npm 对 optionalDependencies
# 或 registry 上不存在的版本会静默跳过，install 仍 exit 0 —— 装到 NAS 上
# dsh web 一启动就 ERR_MODULE_NOT_FOUND（表现为"装得上、点开就崩"）。
say "校验 dsh 顶层静态 import"
cat > "${CONTENT}/.resolve-check.mjs" <<'CHECK'
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
if (!existsSync(libDir)) process.exit(0);

// 只认行首静态 import/export ... from：函数体内的动态 import() 通常有 try/catch
const PATTERNS = [
  /^import\s*(?:[^;("']{0,300}?)from\s*["']([^"']+)["']/gm,
  /^export\s*(?:[^;("']{0,300}?)from\s*["']([^"']+)["']/gm,
  /^import\s*["']([^"']+)["']/gm,
];
const specs = new Set();
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      const src = readFileSync(full, 'utf8');
      for (const re of PATTERNS) for (const m of src.matchAll(re)) if (!m[1].startsWith('.')) specs.add(m[1]);
    }
  }
};
walk(libDir);

const missing = [];
for (const spec of [...specs].sort()) {
  try { import.meta.resolve(spec); } catch { missing.push(spec); }
}
process.stdout.write(missing.join(' '));
CHECK
MISSING=$(node "${CONTENT}/.resolve-check.mjs" 2>/dev/null || true)
if [ -n "${MISSING}" ]; then
    say "WARN: 解析不到，尝试补装: ${MISSING}"
    for spec in ${MISSING}; do
        (cd "${CONTENT}" && npm install --no-save --no-package-lock --omit=dev \
            --no-audit --no-fund --loglevel=error "${spec}") || true
    done
    MISSING=$(node "${CONTENT}/.resolve-check.mjs" 2>/dev/null || true)
    [ -z "${MISSING}" ] || die "运行时依赖仍缺失：${MISSING}（缺了 dsh web 启动即 ERR_MODULE_NOT_FOUND）"
fi
rm -f "${CONTENT}/.resolve-check.mjs"
say "静态 import 校验通过"

echo "==> [5/6] 瘦身、软链与权限"
# 飞牛安装器解包后逐文件 chmod/chown，文件数越多装得越慢
BEFORE_FILES=$(find "${CONTENT}" -type f | wc -l); BEFORE_MB=$(du -sm "${CONTENT}" | cut -f1)
find "${CONTENT}/node_modules" -type d -not -path "*/@deepseek-ai/dsh/*" \
    \( -name test -o -name tests -o -name __tests__ -o -name .github -o -name docs -o -name example -o -name examples \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
find "${CONTENT}/node_modules" -type f -not -path "*/@deepseek-ai/dsh/*" \
    \( -name "*.md" -o -name "*.markdown" -o -name "*.map" -o -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" -o -name "*.tsbuildinfo" \) \
    -delete 2>/dev/null || true
say "文件数 ${BEFORE_FILES} → $(find "${CONTENT}" -type f | wc -l)；体积 ${BEFORE_MB}MB → $(du -sm "${CONTENT}" | cut -f1)MB"

# 软链必须清零：飞牛安装器的 ApplyPermission 遍历到无法解析的软链会直接报
# ErrCodeInstallDirAuthException(10234)「设置目录权限失败」。
#   - 断链：删除
#   - 有效软链：实体化成真实文件
# 例外：node_modules/.bin 下的软链不能实体化 —— 这些脚本内部用相对路径
# require 自己包里的文件，复制到 .bin/ 后相对路径失效（MODULE_NOT_FOUND）。
# 改为生成一层 node 转发脚本，目标文件留在原位。
BIN_DIR="${CONTENT}/node_modules/.bin"
if [ -d "${BIN_DIR}" ]; then
    while IFS= read -r link; do
        [ -z "${link}" ] && continue
        target=$(readlink -f "${link}" 2>/dev/null)
        if [ -n "${target}" ] && [ -e "${target}" ]; then
            rel=$(realpath --relative-to="${BIN_DIR}" "${target}")
            rm -f "${link}"
            printf '#!/usr/bin/env node\nrequire(%s)\n' "'./${rel}'" > "${link}"
            chmod 755 "${link}"
        else
            rm -f "${link}"
        fi
    done < <(find "${BIN_DIR}" -maxdepth 1 -type l 2>/dev/null)
    say ".bin 软链已转为 node 转发脚本"
fi

BROKEN=0; RESOLVED=0
while IFS= read -r link; do
    [ -z "${link}" ] && continue
    if [ -e "${link}" ]; then
        target=$(readlink -f "${link}"); rm -f "${link}"; cp -a "${target}" "${link}"
        RESOLVED=$((RESOLVED + 1))
    else
        rm -f "${link}"; BROKEN=$((BROKEN + 1))
    fi
done < <(find "${CONTENT}" -type l 2>/dev/null)
say "实体化软链 ${RESOLVED} 个，删除断链 ${BROKEN} 个"
REMAIN=$(find "${CONTENT}" -type l 2>/dev/null | wc -l)
[ "${REMAIN}" -eq 0 ] || { find "${CONTENT}" -type l >&2; die "仍残留 ${REMAIN} 个软链"; }

find "${CONTENT}" -type d -exec chmod 755 {} + 2>/dev/null || true
find "${CONTENT}" -type f -exec chmod 644 {} + 2>/dev/null || true
chmod -R 755 "${CONTENT}/bin" 2>/dev/null || true
[ -d "${BIN_DIR}" ] && find "${BIN_DIR}" -type f -exec chmod 755 {} + 2>/dev/null || true
chmod 755 "${APP}/cmd/"* 2>/dev/null || true

echo "==> [6/6] 校验"
[ -f "${CONTENT}/node_modules/@deepseek-ai/dsh/lib/bin.js" ] || die "dsh 入口缺失"
[ -f "${CONTENT}/gate/gate.js" ] || die "gate.js 缺失"
[ -x "${CONTENT}/node_modules/.bin/pnpm" ] || die "缺少可执行的 pnpm（插件安装会不可用）"
# 转发脚本必须真能跑：文件存在但 require 路径错，装完就 MODULE_NOT_FOUND
"${CONTENT}/node_modules/.bin/pnpm" --version >/dev/null 2>&1 \
    || { "${CONTENT}/node_modules/.bin/pnpm" --version || true; die "node_modules/.bin/pnpm 无法执行"; }
say "pnpm 可用: $("${CONTENT}/node_modules/.bin/pnpm" --version 2>/dev/null)"

OTHER=x64; [ "${NODE_ARCH}" = "x64" ] && OTHER=arm64
find "${CONTENT}" -name "*.node" -path "*linux-${NODE_ARCH}*" | grep -q . \
    || die "未找到 linux-${NODE_ARCH} 原生模块，${TARGET_ARCH} 上无法运行"
if find "${CONTENT}" -name "*.node" -path "*linux-${OTHER}*" | grep -v node-pty | grep -q .; then
    find "${CONTENT}" -name "*.node" -path "*linux-${OTHER}*" | grep -v node-pty >&2
    die "包内混入 linux-${OTHER} 原生模块（架构不匹配）"
fi
say "原生模块校验通过（linux-${NODE_ARCH}）"
say "组装完成 ${APP}（$(du -sm "${APP}" | cut -f1)MB）"
