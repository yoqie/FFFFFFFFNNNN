#!/bin/bash
# build-1panel.sh — 下载官方 1Panel 二进制包，打成双架构 fnOS 原生 .fpk
# 用法： ./scripts/build-1panel.sh <out-dir>
# 输入： build/1panel/meta.json（upstream 字段决定下载版本）
# 产物： <out-dir>/1panel_<version>_x86.fpk + <out-dir>/1panel_<version>_arm.fpk
set -euo pipefail

OUTDIR="${1:?Usage: $0 <out-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FNOS="$ROOT/build/1panel/fnos"
SHARED="$ROOT/shared/cmd"

[ -d "$FNOS" ] || { echo "missing fnos dir: $FNOS" >&2; exit 1; }
[ -f "$SHARED/common" ] && [ -f "$SHARED/main" ] || { echo "missing shared framework" >&2; exit 1; }

UPSTREAM=$(node -e "console.log(require('$ROOT/build/1panel/meta.json').upstream)")
VERSION=$(node -e "console.log(require('$ROOT/build/1panel/meta.json').version)")
[ -n "$UPSTREAM" ] && [ -n "$VERSION" ] || { echo "cannot read version from meta.json" >&2; exit 1; }

mkdir -p "$OUTDIR"
# 必须在打包前把输出目录转成绝对路径：打包时是在 (cd "$local_pkg" && tar …) 子 shell 里
# 执行，相对的 $OUTDIR 会解析到临时包目录下，导致 tar 报 "Cannot open: No such file"。
OUTDIR="$(cd "$OUTDIR" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 静态校验：工程必填文件
for f in manifest cmd/service-setup bin/1panel-server config/privilege config/resource 1Panel.sc ICON.PNG ICON_256.PNG; do
  [ -e "$FNOS/$f" ] || { echo "missing required file: $FNOS/$f" >&2; exit 1; }
done

build_one() {
  local arch="$1" deb_arch="$2" plat="$3"
  echo "==> 1panel $UPSTREAM for $arch"
  local dl="$WORK/dl-$arch"
  mkdir -p "$dl" && cd "$dl"
  # v2 包路径：.../v2/stable/vX/.../1panel-vX-linux-<arch>.tar.gz（解压后目录名 1panel-<version>-linux-<arch>）
  UPSTREAM="$UPSTREAM" DEB_ARCH="$deb_arch" node -e "
    (async()=>{
      const fs=require('fs');
      const u='https://resource.1panel.pro/v2/stable/v'+process.env.UPSTREAM+'/release/1panel-v'+process.env.UPSTREAM+'-linux-'+process.env.DEB_ARCH+'.tar.gz';
      const r=await fetch(u,{headers:{'User-Agent':'Mozilla/5.0'}});
      if(!r.ok) throw new Error('download '+r.status+' '+u);
      const ws=fs.createWriteStream('1panel.tar.gz');
      for await (const c of r.body) ws.write(c);
      ws.end(); await new Promise(res=>ws.on('finish',res));
    })().catch(e=>{console.error(e.message);process.exit(1)});
  "
  # 上游二进制包必须够大（v2.2 约 62MB），太小说明下载坏了
  local size
  size=$(stat -c%s 1panel.tar.gz)
  [ "$size" -ge 10485760 ] || { echo "tarball too small ($size bytes), abort" >&2; exit 1; }
  tar -xzf 1panel.tar.gz
  local src
  src=$(find . -maxdepth 1 -type d -name "1panel-*" | head -1)
  [ -n "$src" ] || { echo "1panel source dir not found in tarball" >&2; exit 1; }
  # v2：1panel-core（主） + 1panel-agent（代理） 双二进制，并带 GeoIP 与语言资源
  [ -f "$src/1panel-core" ] || { echo "1panel-core not found in $src" >&2; exit 1; }
  [ -f "$src/1panel-agent" ] || { echo "1panel-agent not found in $src" >&2; exit 1; }

  # app.tgz：双二进制 + 地理库 + 语言资源 + 启动器 + ui
  local root="$WORK/app_root-$arch"
  rm -rf "$root" && mkdir -p "$root/bin" "$root/ui"
  cp "$src/1panel-core" "$root/1panel-core" && chmod +x "$root/1panel-core"
  cp "$src/1panel-agent" "$root/1panel-agent" && chmod +x "$root/1panel-agent"
  [ -f "$src/GeoIP.mmdb" ] && cp "$src/GeoIP.mmdb" "$root/GeoIP.mmdb"
  [ -d "$src/lang" ] && cp -a "$src/lang" "$root/lang"
  cp "$FNOS/bin/1panel-server" "$root/bin/1panel-server" && chmod +x "$root/bin/1panel-server"
  cp -a "$FNOS/ui/." "$root/ui/" 2>/dev/null || true
  (cd "$root" && tar -czf "$WORK/app-$arch.tgz" .)
  [ "$(stat -c%s "$WORK/app-$arch.tgz")" -ge 10485760 ] || { echo "app.tgz too small, abort" >&2; exit 1; }
  cd "$ROOT"
}

build_one x86 amd64 x86
build_one arm arm64 arm

for pair in "x86:x86" "arm:arm"; do
  arch="${pair%%:*}"; plat="${pair##*:}"
  local_pkg="$WORK/package-$arch"
  rm -rf "$local_pkg" && mkdir -p "$local_pkg/cmd"
  cp -a "$FNOS/." "$local_pkg/"
  rm -rf "$local_pkg/bin" # app.tgz 已含启动器，包内不留散文件
  cp "$WORK/app-$arch.tgz" "$local_pkg/app.tgz"
  # 共享 lifecycle 框架：完整 cmd/（main+common+installer+8 个 init/callback 钩子）
  # fnOS 通过 cmd/install_init、cmd/install_callback 等调用生命周期，缺一即报
  # "install_init is not exist"。先整体拷 shared/cmd/ 覆盖散文件，再把应用自带的
  # cmd/service-setup（seed_1pctl 等）一并保留合并进同目录。
  cp -a "$SHARED/." "$local_pkg/cmd/"
  [ -f "$local_pkg/cmd/service-setup" ] || cp -a "$FNOS/cmd/service-setup" "$local_pkg/cmd/"
  chmod +x "$local_pkg/cmd/main" "$local_pkg/cmd/installer" "$local_pkg"/cmd/*_init "$local_pkg"/cmd/*_callback 2>/dev/null || true
  # 面板版本号必须写死成上游版本（v2.3.2）：1panel-core 启动时 grep 这一行，用来显示
  # 右下角版本号并判断是否需要升级。靠运行时 TRIM_APPVER 只是兜底，这里以本次实际
  # 下载的 upstream 为权威，避免出现 "unknown" 或 "2.3.2-1"（后者比较时仍小于 2.3.2，
  # 会一直提示可升级）。
  sed -i "s#^ORIGINAL_VERSION=.*#ORIGINAL_VERSION=v${UPSTREAM}#" "$local_pkg/cmd/service-setup"
  grep -qx "ORIGINAL_VERSION=v${UPSTREAM}" "$local_pkg/cmd/service-setup" || {
    echo "failed to stamp ORIGINAL_VERSION=v${UPSTREAM} into service-setup" >&2; exit 1; }
  # manifest：版本/平台/checksum
  sed -i "s/^version.*/version         = ${VERSION}/" "$local_pkg/manifest"
  if grep -q '^platform' "$local_pkg/manifest"; then
    sed -i "s/^platform.*/platform        = ${plat}/" "$local_pkg/manifest"
  else
    echo "platform        = ${plat}" >> "$local_pkg/manifest"
  fi
  sum=$(md5sum "$local_pkg/app.tgz" | cut -d' ' -f1)
  if grep -q '^checksum' "$local_pkg/manifest"; then
    sed -i "s/^checksum.*/checksum        = ${sum}/" "$local_pkg/manifest"
  else
    echo "checksum        = ${sum}" >> "$local_pkg/manifest"
  fi
  fpk="$OUTDIR/1panel_${VERSION}_${plat}.fpk"
  (cd "$local_pkg" && tar -czf "$fpk" .)
  sha=$(sha256sum "$fpk" | cut -d' ' -f1)
  size=$(stat -c%s "$fpk")
  echo "built: $fpk (sha256=$sha size=$size)"
  echo "{\"file\": \"${fpk##*/}\", \"sha256\": \"$sha\", \"size\": $size, \"platform\": \"$plat\"}" \
    > "$OUTDIR/1panel-$plat.fpk-info.json"
done
