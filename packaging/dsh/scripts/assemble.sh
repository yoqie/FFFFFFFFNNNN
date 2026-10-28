#!/bin/bash
# =============================================================
# assemble.sh —— 把上游 DSH 装进 fnOS 应用壳，产出 fnpack 可直接打包的目录
#
# 输入（环境变量）：
#   STAGE_DIR       必填。组装输出目录（脚本会清空重建）
#   DSH_VERSION     必填。写进 manifest 的应用版本号（= 上游版本）
#   TARGET_ARCH     可选。amd64（默认）/ arm64，决定产物命名与原生模块校验
#   NODE_ARCH       可选。x64（默认）/ arm64，npm 原生模块的目录名
#   DSH_PKG_SPEC    可选。默认 "npm" —— 从 registry 装 @deepseek-ai/dsh@$DSH_VERSION；
#                   也可传 "file:/abs/xxx.tgz"（源码构建出的 tgz）
#   DSH_BUNDLES_SPEC 可选。@deepseek-ai/dsh-official-bundles 的 file: tgz
#
# 产出：$STAGE_DIR/DSH/ —— 可直接 cd 进去 fnpack build
# =============================================================
set -euo pipefail

KIT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE_DIR="${STAGE_DIR:?请设置 STAGE_DIR 为组装输出目录}"
DSH_VERSION="${DSH_VERSION:?请设置 DSH_VERSION 为上游版本号}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"
NODE_ARCH="${NODE_ARCH:-x64}"
DSH_PKG_SPEC="${DSH_PKG_SPEC:-npm}"
DSH_BUNDLES_SPEC="${DSH_BUNDLES_SPEC:-}"

APP_PKG="${STAGE_DIR}/DSH"
# fnOS 的应用运行内容：fnpack 会把 app/ 打成 app.tgz，安装后解压到 TRIM_APPDEST
APP_CONTENT="${APP_PKG}/app"

echo "==> [1/5] 准备目录（${TARGET_ARCH} / node-${NODE_ARCH} / v${DSH_VERSION}）"
rm -rf "${STAGE_DIR}"
mkdir -p "${APP_PKG}" "${APP_CONTENT}"

echo "==> [2/5] 复制应用壳"
# manifest 的 version 决定应用中心显示的版本号，必须与 fpk 文件名一致。
# 注意是 "version" + 空格 + "="，用 ^version= 匹配不到（历史坑：版本号曾长期停在 0.1.0）
sed -i "s/^version[[:space:]]*=.*/version               = ${DSH_VERSION}/" "${KIT_ROOT}/appshell/manifest"
grep -q "^version[[:space:]]*= *${DSH_VERSION}$" "${KIT_ROOT}/appshell/manifest" || {
    echo "FATAL: 写入 manifest 版本号失败（期望 ${DSH_VERSION}）" >&2
    exit 1
}
cp "${KIT_ROOT}/appshell/manifest" "${APP_PKG}/"
cp -r "${KIT_ROOT}/appshell/cmd" "${APP_PKG}/"
cp -r "${KIT_ROOT}/appshell/config" "${APP_PKG}/"
cp -r "${KIT_ROOT}/appshell/wizard" "${APP_PKG}/"
cp -r "${KIT_ROOT}/appshell/ui" "${APP_PKG}/"
# ui/ 必须同时存在于两处：
#   ① 包根 ui/  → 安装器读取桌面入口配置（ui/config 的 port）
#   ② app/ui/   → fnpack 打包 app.tgz 时要求该路径存在，缺失会报
#                 "stat app/ui: no such file or directory"
cp -r "${KIT_ROOT}/appshell/ui" "${APP_CONTENT}/"
cp "${KIT_ROOT}/appshell/ICON.PNG" "${KIT_ROOT}/appshell/ICON_256.PNG" "${APP_PKG}/"

echo "==> [3/5] 安装 DSH 本体与运行时依赖"
# Node 运行时不自带：manifest 声明 install_dep_apps=nodejs_v24，
# 由飞牛应用中心提供 /var/apps/nodejs_v24/target/bin/node（包体积省 100+MB）。
mkdir -p "${APP_CONTENT}/bin"
cp "${KIT_ROOT}/runtime/runner.js" "${APP_CONTENT}/bin/runner.js"
chmod +x "${APP_CONTENT}/bin/runner.js"

# xdg-open 垫片：dsh「设置 → 打开配置文件」会调用 xdg-open，NAS 无桌面环境
# 必然失败。垫片把文件导出到共享目录（文件管理 / SMB 可见）后正常退出。
cp "${KIT_ROOT}/runtime/xdg-open" "${APP_CONTENT}/bin/xdg-open"
chmod +x "${APP_CONTENT}/bin/xdg-open"

# 生成 package.json。pnpm 必须随包：dsh 的插件安装器硬依赖 PATH 里的 pnpm
# 可执行文件、无兜底，而服务端 PATH 里没有 pnpm。
DSH_DEP_SPEC="${DSH_PKG_SPEC}"
if [ "${DSH_DEP_SPEC}" = "npm" ]; then
    DSH_DEP_SPEC="${DSH_VERSION}"
    echo "    来源: npm registry @deepseek-ai/dsh@${DSH_VERSION}"
else
    [ -f "${DSH_DEP_SPEC#file:}" ] || { echo "FATAL: DSH_PKG_SPEC 指向的文件不存在: ${DSH_DEP_SPEC}" >&2; exit 1; }
    echo "    来源: 本地 tgz ${DSH_DEP_SPEC}"
fi

node -e '
const fs = require("fs");
const [file, dshSpec, bundlesSpec] = process.argv.slice(1);
const pkg = {
  name: "dsh-fnos-app",
  version: "1.0.0",
  private: true,
  dependencies: { "@deepseek-ai/dsh": dshSpec, pnpm: "10.14.0" },
};
if (bundlesSpec) pkg.dependencies["@deepseek-ai/dsh-official-bundles"] = bundlesSpec;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "${APP_CONTENT}/package.json" "${DSH_DEP_SPEC}" "${DSH_BUNDLES_SPEC}"
cat "${APP_CONTENT}/package.json"

# 交叉架构时让 npm 选对可选依赖（预编译原生产物）；同架构无需传参
NPM_ARCH_ARGS=()
HOST_NODE_ARCH="$(node -p 'process.arch')"
if [ "${NODE_ARCH}" != "${HOST_NODE_ARCH}" ]; then
    echo "    WARN: 目标架构 node-${NODE_ARCH} 与本机 node-${HOST_NODE_ARCH} 不同，" >&2
    echo "          通过 --os/--cpu 选择预编译产物；含本地编译的包仍可能装成本机架构。" >&2
    NPM_ARCH_ARGS=(--os=linux "--cpu=${NODE_ARCH}")
fi

echo "==> npm install（扁平布局，无软链；$(npm --version)）"
set +e
(cd "${APP_CONTENT}" && npm install --omit=dev --no-audit --no-fund --loglevel=error "${NPM_ARCH_ARGS[@]}")
INSTALL_EXIT=$?
# 上游偶发引用尚未发布到 npm 的包（新 experimental 包常滞后），npm 报 E404。
# 安全策略：只剔除日志里确认 404 的包后重试一次，其它失败原因不误删依赖。
if [ ${INSTALL_EXIT} -ne 0 ]; then
    (cd "${APP_CONTENT}" && npm install --omit=dev --no-audit --no-fund --loglevel=error "${NPM_ARCH_ARGS[@]}") > /tmp/dsh-npm-install.log 2>&1 || true
    MISSING=$(grep -oE '404 Not Found - GET (\S+)' /tmp/dsh-npm-install.log 2>/dev/null \
        | sed 's/404 Not Found - GET //' \
        | node -e '
            const seen = new Set();
            require("readline").createInterface({ input: process.stdin })
              .on("line", (line) => {
                  try {
                      const name = decodeURIComponent(new URL(line.trim()).pathname).replace(/^\//, "");
                      if (name) seen.add(name);
                  } catch { /* 非 URL 行忽略 */ }
              })
              .on("close", () => console.log([...seen].join(" ")));
        ')
    if [ -n "${MISSING}" ]; then
        echo "WARN: npm 上不存在的依赖，剔除后重试: ${MISSING}" >&2
        (cd "${APP_CONTENT}" && node -e '
            const fs = require("fs");
            const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
            for (const field of ["dependencies", "optionalDependencies"]) {
                if (!pkg[field]) continue;
                for (const name of process.argv.slice(1)) delete pkg[field][name];
            }
            fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
        ' ${MISSING}) || true
        (cd "${APP_CONTENT}" && npm install --omit=dev --no-audit --no-fund --loglevel=error "${NPM_ARCH_ARGS[@]}")
        INSTALL_EXIT=$?
    fi
fi
set -e
[ ${INSTALL_EXIT} -eq 0 ] || { echo "FATAL: npm install 失败 (exit ${INSTALL_EXIT})" >&2; exit ${INSTALL_EXIT}; }

# ---- 顶层静态 import 校验（防「装得上、点开就崩」）----
# dsh 的 lib 里有顶层静态 import；npm 对 optionalDependencies 或 registry 上
# 不存在的版本会静默跳过，install 仍 exit 0，装到 NAS 上 dsh web 一启动就
# ERR_MODULE_NOT_FOUND。这里按 Node 的真实解析逐条验证，缺了先补装，补不上就失败。
echo "==> 校验 dsh 顶层静态 import 的依赖"
cat > "${APP_CONTENT}/.dsh-resolve-check.mjs" <<'CHECK'
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const libDir = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib');
if (!existsSync(libDir)) process.exit(0);

// 只认行首的静态 import/export ... from；动态 import() 一般有 try/catch 兜底
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
      for (const re of PATTERNS) {
        for (const m of src.matchAll(re)) {
          if (!m[1].startsWith('.')) specs.add(m[1]);
        }
      }
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
MISSING=$(node "${APP_CONTENT}/.dsh-resolve-check.mjs" 2>/dev/null || true)
if [ -n "${MISSING}" ]; then
    echo "WARN: 静态 import 解析不到，尝试补装: ${MISSING}" >&2
    for spec in ${MISSING}; do
        (cd "${APP_CONTENT}" && npm install --no-save --no-package-lock --omit=dev \
            --no-audit --no-fund --loglevel=error "${spec}") || true
    done
    MISSING=$(node "${APP_CONTENT}/.dsh-resolve-check.mjs" 2>/dev/null || true)
    if [ -n "${MISSING}" ]; then
        echo "FATAL: dsh 运行时依赖仍缺失：${MISSING}" >&2
        echo "       这些包被顶层静态 import，缺了 dsh web 启动即 ERR_MODULE_NOT_FOUND。" >&2
        echo "       若上游只在 monorepo 内链接该包，请用 --bundles-tgz 传入 pack 产物。" >&2
        exit 1
    fi
fi
rm -f "${APP_CONTENT}/.dsh-resolve-check.mjs"
echo "    静态 import 校验通过"

echo "==> [4/5] 瘦身与权限整理"
# 飞牛安装器解包后逐文件 chmod/chown，文件数越多安装越慢
BEFORE_FILES=$(find "${APP_CONTENT}" -type f | wc -l)
BEFORE_MB=$(du -sm "${APP_CONTENT}" | cut -f1)
find "${APP_CONTENT}/node_modules" -type d -not -path "*/@deepseek-ai/dsh/*" \
    \( -name test -o -name tests -o -name __tests__ -o -name .github -o -name docs -o -name example -o -name examples \) \
    -prune -exec rm -rf {} + 2>/dev/null || true
find "${APP_CONTENT}/node_modules" -type f -not -path "*/@deepseek-ai/dsh/*" \
    \( -name "*.md" -o -name "*.markdown" -o -name "*.map" -o -name "*.d.ts" -o -name "*.d.mts" -o -name "*.d.cts" -o -name "*.tsbuildinfo" \) \
    -delete 2>/dev/null || true
AFTER_FILES=$(find "${APP_CONTENT}" -type f | wc -l)
AFTER_MB=$(du -sm "${APP_CONTENT}" | cut -f1)
echo "    文件数 ${BEFORE_FILES} → ${AFTER_FILES}；体积 ${BEFORE_MB}MB → ${AFTER_MB}MB"

# 软链处理（关键）：飞牛安装器 ApplyPermission 遍历到无法解析的软链会直接报
# ErrCodeInstallDirAuthException(10234)「设置目录权限失败」。
# 断链删除；有效软链实体化为真实文件。
# 例外：node_modules/.bin 下的软链不能实体化 —— 这些脚本内部用相对路径
# require 自己包内的文件，复制到 .bin/ 后相对路径失效（MODULE_NOT_FOUND）。
# 改为生成一层 node 转发脚本，目标文件留在原位。
echo "==> 处理 node_modules/.bin（生成转发脚本，不复制、不留软链）"
if [ -d "${APP_CONTENT}/node_modules/.bin" ]; then
    BIN_DIR="${APP_CONTENT}/node_modules/.bin"
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
fi

echo "==> 清理符号链接（断链删除 / 有效实体化）"
BROKEN=0; RESOLVED=0
while IFS= read -r link; do
    [ -z "${link}" ] && continue
    if [ -e "${link}" ]; then
        target=$(readlink -f "${link}")
        rm -f "${link}"
        cp -a "${target}" "${link}"
        RESOLVED=$((RESOLVED + 1))
    else
        rm -f "${link}"
        BROKEN=$((BROKEN + 1))
    fi
done < <(find "${APP_CONTENT}" -type l 2>/dev/null)
echo "    实体化有效软链: ${RESOLVED} 个；删除断链: ${BROKEN} 个"
REMAIN=$(find "${APP_CONTENT}" -type l 2>/dev/null | wc -l)
if [ "${REMAIN}" -gt 0 ]; then
    echo "FATAL: 仍残留 ${REMAIN} 个软链，安装器会报权限失败" >&2
    find "${APP_CONTENT}" -type l >&2
    exit 1
fi

find "${APP_CONTENT}" -type d -exec chmod 755 {} + 2>/dev/null || true
find "${APP_CONTENT}" -type f -exec chmod 644 {} + 2>/dev/null || true
chmod -R 755 "${APP_CONTENT}/bin" 2>/dev/null || true
# .bin 下的转发脚本必须可执行（上面 644 会清掉），否则 spawn("pnpm") 报 EACCES
find "${APP_CONTENT}/node_modules/.bin" -type f -exec chmod 755 {} + 2>/dev/null || true

echo "==> [5/5] 校验组装结果"
[ -d "${APP_CONTENT}/node_modules/@deepseek-ai/dsh" ] || { echo "FATAL: @deepseek-ai/dsh 未装入" >&2; exit 1; }
[ -f "${APP_CONTENT}/node_modules/@deepseek-ai/dsh/lib/bin.js" ] || { echo "FATAL: dsh/lib/bin.js 缺失" >&2; exit 1; }
[ -f "${APP_CONTENT}/bin/runner.js" ] || { echo "FATAL: runner.js 缺失" >&2; exit 1; }
if [ ! -e "${APP_CONTENT}/node_modules/.bin/pnpm" ] && [ ! -f "${APP_CONTENT}/node_modules/pnpm/bin/pnpm.cjs" ]; then
    echo "FATAL: 产物缺少 pnpm（插件安装将不可用）" >&2; exit 1
fi
# 文件存在不够：转发脚本必须真能跑，否则装完即 MODULE_NOT_FOUND
"${APP_CONTENT}/node_modules/.bin/pnpm" --version >/dev/null 2>&1 || {
    echo "FATAL: node_modules/.bin/pnpm 无法执行（插件安装将不可用）" >&2
    "${APP_CONTENT}/node_modules/.bin/pnpm" --version >&2 || true
    exit 1
}
echo "    pnpm 冒烟测试通过: $("${APP_CONTENT}/node_modules/.bin/pnpm" --version 2>/dev/null)"
OTHER_ARCH=x64; [ "${NODE_ARCH}" = "x64" ] && OTHER_ARCH=arm64
find "${APP_CONTENT}" -name "*.node" -path "*linux-${NODE_ARCH}*" | grep -q . || {
    echo "FATAL: 未找到 linux-${NODE_ARCH} 原生模块，${TARGET_ARCH} NAS 上无法运行" >&2; exit 1; }
if find "${APP_CONTENT}" -name "*.node" -path "*linux-${OTHER_ARCH}*" | grep -v "node-pty" | grep -q .; then
    echo "FATAL: 包内混入 linux-${OTHER_ARCH} 原生模块（架构不匹配）" >&2
    find "${APP_CONTENT}" -name "*.node" -path "*linux-${OTHER_ARCH}*" | grep -v node-pty >&2
    exit 1
fi
echo "    原生模块校验通过（linux-${NODE_ARCH}）"
echo "==> 组装完成: ${APP_PKG}（体积 $(du -sm "${APP_PKG}" | cut -f1)MB）"
