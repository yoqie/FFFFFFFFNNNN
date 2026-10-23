#!/usr/bin/env node
/*
 * finalize-1panel.mjs — 1Panel 本体发版收尾：把双架构 FPK 信息写入
 * apps/1panel.json 的 releases.<version>.packages.{x86,arm}，拷贝图标/README 到
 * assets/1panel/，刷新 details_updated_at。
 *
 * 用法： node scripts/finalize-1panel.mjs --repo OWNER/NAME --tag <release-tag> --dist <fpk-dir>
 * 输入： dist/1panel-{x86,arm}.fpk-info.json（由 build-1panel.sh 生成）
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fetchUpstreamNote } from './upstream-note.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const REPO = opt('--repo', process.env.REPO || 'yoqie/FFFFFFFFNNNN');
const TAG = opt('--tag', '');
const DIST = opt('--dist', path.join(ROOT, 'dist'));
if (!TAG) { console.error('missing --tag'); process.exit(1); }

const readJson = async (p, d) => JSON.parse(await fs.readFile(p, 'utf8').catch(() => JSON.stringify(d)));
const writeJson = (p, o) => fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');
const exists = async (p) => !!(await fs.stat(p).catch(() => null));

const pend = await readJson(path.join(ROOT, 'pending.json'), []);
const entry = pend.find((e) => e.slug === '1panel');
if (!entry) { console.log('no 1panel pending, skip'); process.exit(0); }
const meta = await readJson(path.join(ROOT, 'build', '1panel', 'meta.json'), null);
if (!meta) { console.log('no meta, skip'); process.exit(1); }

const infos = {};
for (const plat of ['x86', 'arm']) {
  const info = await readJson(path.join(DIST, `1panel-${plat}.fpk-info.json`), null);
  if (!info) { console.log(`missing fpk-info for ${plat}, skip`); process.exit(1); }
  infos[plat] = info;
}

const assetDir = path.join(ROOT, 'assets', '1panel');
await fs.mkdir(assetDir, { recursive: true });
await fs.copyFile(path.join(ROOT, 'build', '1panel', 'fnos', 'ICON.PNG'), path.join(assetDir, 'ICON.PNG'));
const readmeText = `# 1Panel\n\n开源服务器运维管理面板，提供可视化的 Linux 服务器管理。\n\n- 上游版本：${meta.upstream}\n- 官网：https://1panel.cn\n- 仓库：https://github.com/1Panel-dev/1Panel\n- 安装类型：系统空间（root），端口 18090（固定）\n- 安装时通过向导设置安全入口、用户名与密码\n- 登录的账号信息见应用数据目录的 CREDENTIALS.txt\n`;
await fs.writeFile(path.join(assetDir, 'README.md'), readmeText);

const detailPath = path.join(ROOT, 'apps', '1panel.json');
const detail = await readJson(detailPath, null) || { app_name: '1panel', releases: {} };
detail.releases = detail.releases || {};
if (!detail.releases[entry.version]) {
  const pkgs = {};
  for (const plat of ['x86', 'arm']) {
    pkgs[plat] = {
      download_url: `https://github.com/${REPO}/releases/download/${TAG}/${infos[plat].file}`,
      sha256: infos[plat].sha256,
      size: infos[plat].size,
    };
  }
  // 更新信息同步 1Panel 官方该版本的 Release 正文；取不到时回退为默认说明。
  const upstreamNote = await fetchUpstreamNote('1Panel-dev/1Panel', meta.upstream, {
    tags: ['v{v}', '{v}'],
    maxLen: 6000,
  });
  detail.releases[entry.version] = {
    changelog: upstreamNote || `跟随 1Panel 官方 v1 LTS ${meta.upstream} 自动打包（原生双架构）。`,
    updated_at: new Date().toISOString(),
    packages: pkgs,
  };
}
const vers = Object.keys(detail.releases).sort().reverse();
for (const v of vers.slice(100)) delete detail.releases[v];
await writeJson(detailPath, detail);

const fnpack = await readJson(path.join(ROOT, 'fnpack.json'), null);
if (fnpack?.apps?.['1panel']) {
  fnpack.apps['1panel'].details_updated_at = new Date().toISOString();
  await writeJson(path.join(ROOT, 'fnpack.json'), fnpack);
}
await writeJson(path.join(ROOT, 'pending.json'), pend.filter((e) => e.slug !== '1panel'));
console.log(`1panel: finalized ${entry.version}`);
