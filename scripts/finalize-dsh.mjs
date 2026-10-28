#!/usr/bin/env node
/*
 * finalize-dsh.mjs —— 把构建出来的 DSH fpk 登记进本源索引
 *
 * 背景：DSH 由本仓库自己构建（packaging/dsh/build.sh），产物就在手边，
 * 所以不需要像 1Panel 那样去"同步上游源的索引"——直接把 dist/ 里的
 * 两个 fpk 算好 sha256/大小写进 apps/dsh.json，再由 update-index.mjs
 * 汇总成 fnpack.json + README.md。
 *
 * 用法：
 *   node scripts/finalize-dsh.mjs --version 0.2.2-alpha.2 --dist dist
 *   node scripts/finalize-dsh.mjs --version 0.2.2-alpha.2 --dist dist \
 *        --repo yoqie/FFFFFFFFNNNN --changelog-file release-notes.md
 *
 * 产出：
 *   build/dsh/meta.json   —— update-index.mjs 读它生成 README 表格与索引元数据
 *   apps/dsh.json         —— 应用详情（含下载地址、sha256、大小）
 */

import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const VERSION = opt('--version', '').replace(/^v/, '');
const DIST = path.resolve(ROOT, opt('--dist', 'dist'));
const REPO = opt('--repo', process.env.REPO || 'yoqie/FFFFFFFFNNNN');
const TAG = opt('--tag', `dsh-${VERSION}`);
const CHANGELOG_FILE = opt('--changelog-file', '');

if (!VERSION) {
  console.error('用法: node scripts/finalize-dsh.mjs --version <上游版本> [--dist dist] [--repo OWNER/NAME]');
  process.exit(1);
}

// 架构 → fnOS 索引里的平台键（与 1panel 一致：x86 / arm）
const ARCHS = [
  { arch: 'amd64', platform: 'x86' },
  { arch: 'arm64', platform: 'arm' },
];

const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file)
    .on('data', (chunk) => hash.update(chunk))
    .on('end', () => resolve(hash.digest('hex')))
    .on('error', reject);
});

const readJson = async (p, d) => JSON.parse(await fs.readFile(p, 'utf8').catch(() => JSON.stringify(d)));
const writeJson = (p, o) => fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');

// ---------- 1. 收集产物 ----------
const packages = {};
const missing = [];
for (const { arch, platform } of ARCHS) {
  const name = `DSH_v${VERSION}_${arch}.fpk`;
  const file = path.join(DIST, name);
  let stat;
  try { stat = await fs.stat(file); } catch { missing.push(`${arch}（${name}）`); continue; }
  packages[platform] = {
    version: VERSION,
    download_url: `https://github.com/${REPO}/releases/download/${TAG}/${name}`,
    sha256: await sha256(file),
    size: stat.size,
  };
  console.log(`  ${platform.padEnd(4)} ← ${name}（${(stat.size / 1048576).toFixed(1)}MB, sha256 ${packages[platform].sha256.slice(0, 12)}…）`);
}
if (Object.keys(packages).length === 0) {
  console.error(`FATAL: ${DIST} 里没有 DSH_v${VERSION}_<arch>.fpk，无法登记索引`);
  process.exit(1);
}
if (missing.length > 0) {
  // 只构建了单架构时如实告警：索引里就只会挂上已构建的那个平台
  console.warn(`WARN: 缺少架构产物：${missing.join('、')}（索引只登记已构建的平台）`);
}

// ---------- 2. 更新内容 ----------
let changelog = '';
if (CHANGELOG_FILE) {
  changelog = (await fs.readFile(path.resolve(ROOT, CHANGELOG_FILE), 'utf8').catch(() => '')).trim();
}
if (!changelog) changelog = `DSH v${VERSION} 飞牛 fnOS 版（amd64/arm64 双架构原生安装包）。`;

// ---------- 3. build/dsh/meta.json ----------
const META = {
  slug: 'dsh',
  displayName: 'DSH',
  desc: 'DeepSeek Harness（DSH）飞牛NAS版：跟随上游 deepseek-harness 自动构建，amd64/arm64 双架构原生安装包，飞牛桌面一键打开。',
  version: VERSION,
  // 已打包的上游版本（= 发布版本；DSH 不做版本号改写）
  upstream: VERSION,
  categories: ['AI赋能', '编程开发'],
  maintainer: 'deepseek-ai',
  maintainer_url: 'https://github.com/deepseek-ai/deepseek-harness',
  service_port: '3080',
  run_as: 'root',
  install_type: 'root',
  is_docker: false,
};
await fs.mkdir(path.join(ROOT, 'build', 'dsh'), { recursive: true });
await writeJson(path.join(ROOT, 'build', 'dsh', 'meta.json'), META);

// ---------- 4. apps/dsh.json ----------
const detailPath = path.join(ROOT, 'apps', 'dsh.json');
const prev = await readJson(detailPath, {});
const now = new Date().toISOString();
const releases = { ...(prev.releases || {}) };
releases[VERSION] = {
  version: VERSION,
  // changelog 与 release_note 写同一份内容：不同版本的应用中心读取的键名不同
  changelog,
  release_note: `DSH v${VERSION} 飞牛 fnOS 自动构建（amd64/arm64）。`,
  updated_at: now,
  packages,
};
// 只保留最新一条：本源同一应用只发最新版 Release（旧 Release 由 prune-releases 清理）
const detail = {
  ...prev,
  app_name: 'dsh',
  releases: { [VERSION]: releases[VERSION] },
  display_name: META.displayName,
  desc: META.desc,
  platform: Object.keys(packages),
  categories: META.categories,
  icon_url: `https://raw.githubusercontent.com/${REPO}/main/assets/dsh/ICON.PNG`,
  readme_url: `https://raw.githubusercontent.com/${REPO}/main/assets/dsh/README.md`,
  bug_report_url: `https://github.com/${REPO}/issues`,
  maintainer: META.maintainer,
  maintainer_url: META.maintainer_url,
  distributor: 'yoqie',
  distributor_url: `https://github.com/${REPO}`,
  run_as: META.run_as,
  install_type: META.install_type,
  is_docker: META.is_docker,
  service_port: META.service_port,
  updated_at: now,
};
await writeJson(detailPath, detail);

console.log(`已登记 DSH ${VERSION}：${Object.keys(packages).join(' / ')} → apps/dsh.json + build/dsh/meta.json`);
