#!/usr/bin/env node
/**
 * migrate-dsh.mjs —— FnDepot 应用迁移（一次性）
 *
 * 1. 下线旧的 DeepSeek Harness（FnDepot 自建构建链路）：
 *    - apps/deepseek-harness.json
 *    - build/deepseek-harness/（整目录）
 *    - assets/deepseek-harness/（整目录）
 *    - scripts/build-deepseek-harness.sh / package-deepseek-harness.sh /
 *      finalize-deepseek-harness.mjs / deepseek-harness-patch.py / deepseek-harness.env
 *    - scripts/sync.mjs（同步器只服务于 1Panel 允许列表，DSH 不再走此链路）
 *    - .github/workflows/build-deepseek-harness.yml
 *    - FnDepot 仓库内 tag 前缀为 deepseek-harness- 的全部 Release（删除旧的 fpk 分发，
 *      安装地址全部切换到 cliii-one/DSH_FNOS 的官方 Release）
 *
 * 2. 接入新的 DSH（cliii-one/DSH_FNOS 双架构构建）：
 *    - 写入 build/dsh/meta.json
 *    - 运行 sync-dsh.mjs 生成 apps/dsh.json
 *    - 写入 assets/dsh/README.md
 *    - update-index.mjs 的硬编码 nativeSlugs 从 deepseek-harness 切换为 dsh
 *    - 重建 fnpack.json 与 README.md
 *
 * 用法：node scripts/migrate-dsh.mjs（需要写权限，工作流或本地使用 token）
 */

import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.REPO || 'yoqie/FnDepot';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';

const gh = async (url, method = 'GET') => {
  const headers = { 'User-Agent': 'FnDepot-migrate', Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`${API}${url}`, { method, headers });
  if (!r.ok) throw new Error(`GitHub API ${method} ${url} -> HTTP ${r.status}`);
  return r.status === 204 ? null : r.json();
};

const rm = async (p) => { await fs.rm(path.join(ROOT, p), { recursive: true, force: true }); console.log(`已删除: ${p}`); };

// ---------- 0. 抢救旧图标资产（删除旧目录前先复制到新 slug）----------
await fs.mkdir(path.join(ROOT, 'assets', 'dsh'), { recursive: true });
for (const f of ['ICON.PNG', 'ICON_256.PNG']) {
  await fs.copyFile(path.join(ROOT, 'assets', 'deepseek-harness', f), path.join(ROOT, 'assets', 'dsh', f));
}
console.log('图标已复制到 assets/dsh/');

// ---------- 1. 移除旧应用 ----------
for (const p of [
  'apps/deepseek-harness.json',
  'build/deepseek-harness',
  'assets/deepseek-harness',
  'scripts/build-deepseek-harness.sh',
  'scripts/package-deepseek-harness.sh',
  'scripts/finalize-deepseek-harness.mjs',
  'scripts/deepseek-harness-patch.py',
  'scripts/deepseek-harness.env',
  'scripts/sync.mjs',
  '.github/workflows/build-deepseek-harness.yml',
]) await rm(p);

// ---------- 2. sync.mjs 移除后，同步工作流改为只跑 dsh ----------
const followPath = path.join(ROOT, '.github', 'workflows', 'follow-upstream.yml');
let follow = await fs.readFile(followPath, 'utf8');
follow = follow.split('\n').filter((l) => !l.trim().startsWith('node scripts/sync.mjs')).join('\n');
if (follow.includes('node scripts/sync.mjs')) throw new Error('follow-upstream.yml 中仍残留 sync.mjs 调用');
await fs.writeFile(followPath, follow);
console.log('已从 follow-upstream.yml 移除 sync.mjs 调用');

// ---------- 3. 索引器原生应用清单：deepseek-harness → dsh ----------
const indexPath = path.join(ROOT, 'scripts', 'update-index.mjs');
let index = await fs.readFile(indexPath, 'utf8');
if (!index.includes("'deepseek-harness'")) throw new Error('update-index.mjs 中未找到预期的 nativeSlugs 定义');
index = index.replace("'deepseek-harness'", "'dsh'");
await fs.writeFile(indexPath, index);
console.log('update-index.mjs: nativeSlugs 已切换为 dsh');

// ---------- 4. 新应用元数据（update-index.mjs 读取 build/<slug>/meta.json）----------
const meta = {
  slug: 'dsh',
  displayName: 'DSH',
  desc: 'DeepSeek Harness（DSH）飞牛NAS版：自动跟进上游最新版本构建，amd64/arm64 双架构原生安装包，飞牛桌面一键打开。',
  upstream: 'cliii-one/DSH_FNOS',
  version: '0.2.0-rc.2',
  categories: ['AI赋能', '编程开发'],
  maintainer: 'cliii-one',
  maintainer_url: 'https://github.com/cliii-one/DSH_FNOS',
  service_port: '3080',
  run_as: 'root',
  install_type: 'root',
  is_docker: false,
};
await fs.mkdir(path.join(ROOT, 'build', 'dsh'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'build', 'dsh', 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log('已写入 build/dsh/meta.json');

// ---------- 5. 应用素材说明（图标已在步骤 0 复制）----------
await fs.writeFile(
  path.join(ROOT, 'assets', 'dsh', 'README.md'),
  `# DSH（DeepSeek Harness 飞牛版）\n\n- 上游与打包: https://github.com/cliii-one/DSH_FNOS\n- 构建方式: GitHub Actions（amd64 + arm64 原生双架构），上游发布 Release\n- 分发: 本源把最新版 fpk 镜像到本仓库 Release（tag: \`dsh-<版本>\`），索引里的下载地址指向本源，不再依赖上游仓库\n- 服务端口: 3080（与官方 deepseek-harness 应用相同，两者不能同时安装）\n- 依赖: 飞牛应用中心 nodejs_v24 运行时（缺失时自动安装）\n- 数据目录: /vol2/@appshare/dsh\n\n安装后桌面出现 DSH 卡片，点击或访问 http://NAS地址:3080 使用。\n`,
);
console.log('已写入 assets/dsh/（图标沿用原资产）');

// ---------- 6. 同步生成 apps/dsh.json ----------
console.log(execSync('node scripts/sync-dsh.mjs', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));

// ---------- 6.1 把最新版 fpk 镜像到本源 Release，并把下载地址改回本源 ----------
console.log(execSync('node scripts/mirror-dsh.mjs', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));

// ---------- 7. 重建 fnpack.json 与 README.md ----------
console.log(execSync('node scripts/update-index.mjs', { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));

// ---------- 8. 删除旧应用的 GitHub Release（fpk 分发不再由本仓库承担）----------
const releases = await gh(`/repos/${REPO}/releases?per_page=100`);
let removed = 0;
for (const rel of releases) {
  if (rel.draft || !(rel.tag_name || '').startsWith('deepseek-harness-')) continue;
  await gh(`/repos/${REPO}/releases/${rel.id}`, 'DELETE');
  console.log(`已删除 Release: ${rel.tag_name}`);
  removed += 1;
}
console.log(`Release 清理完成：共删除 ${removed} 个`);
console.log('迁移完成');
