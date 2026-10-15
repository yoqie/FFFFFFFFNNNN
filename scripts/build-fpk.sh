#!/bin/bash
# build-fpk.sh — 把 build/<slug>/fnos 工程打成 fnOS Docker 型 .fpk
# 用法： ./scripts/build-fpk.sh <slug> <out-dir>
# 产物： <out-dir>/<appname>_<version>_all.fpk
set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <out-dir>}"
OUTDIR="${2:?Usage: $0 <slug> <out-dir>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FNOS="$ROOT/build/$SLUG/fnos"

[ -d "$FNOS" ] || { echo "missing fnos dir: $FNOS" >&2; exit 1; }
for f in manifest cmd/main cmd/service-setup config/privilege config/resource docker/docker-compose.yaml ICON.PNG ICON_256.PNG; do
  [ -e "$FNOS/$f" ] || { echo "missing required file: $FNOS/$f" >&2; exit 1; }
done

APPNAME=$(grep '^appname' "$FNOS/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
VERSION=$(grep '^version' "$FNOS/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
[ -n "$APPNAME" ] && [ -n "$VERSION" ] || { echo "cannot read appname/version from manifest" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PKG="$WORK/package"
mkdir -p "$PKG"
cp -a "$FNOS/." "$PKG/"

# app.tgz：Docker 型只含 compose + ui（镜像由 fnOS 在安装时拉取）
(cd "$PKG" && tar -czf app.tgz docker ui)
rm -rf "$PKG/docker"

# checksum = app.tgz 的 md5（fnOS manifest 规范）
CHECKSUM=$(md5sum "$PKG/app.tgz" | cut -d' ' -f1)
if grep -q '^checksum' "$PKG/manifest"; then
  sed -i "s/^checksum.*/checksum        = ${CHECKSUM}/" "$PKG/manifest"
else
  echo "checksum        = ${CHECKSUM}" >> "$PKG/manifest"
fi
grep -q '^platform' "$PKG/manifest" || echo "platform        = all" >> "$PKG/manifest"

mkdir -p "$OUTDIR"
# 同 build-1panel.sh：打包在 (cd "$PKG" && tar …) 子 shell 里执行，$OUTDIR 必须是绝对路径
OUTDIR="$(cd "$OUTDIR" && pwd)"
FPK="$OUTDIR/${APPNAME}_${VERSION}_all.fpk"
(cd "$PKG" && tar -czf "$FPK" .)

SHA=$(sha256sum "$FPK" | cut -d' ' -f1)
SIZE=$(stat -c%s "$FPK")
echo "built: $FPK (sha256=$SHA size=$SIZE)"
# 供 finalize.mjs 使用
echo "{\"file\": \"${FPK##*/}\", \"sha256\": \"$SHA\", \"size\": $SIZE}" > "$OUTDIR/${SLUG}.fpk-info.json"
