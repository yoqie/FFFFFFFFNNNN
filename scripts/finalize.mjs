#!/usr/bin/env node
/*
 * finalize.mjs — 发版收尾：把本次构建的 FPK 信息写入 apps/<slug>.json 的 releases，
 * 拷贝 ICON/README 到 assets/<slug>/，补全详情必填字段，刷新 details_updated_at。
 *
 * 用法： node scripts/finalize.mjs --repo OWNER/NAME --tag <release-tag> --dist <fpk-dir>
 * release-info 约定：dist/<slug>.fpk-info.json = { file, sha256, size }（由 build-fpk.sh 生成）
 * FPK 下载地址：https://github.com/<repo>/releases/download/<tag>/<file>
 * 图标/README 地址：https://raw.githubusercontent.com/<repo>/main/assets/<slug>/...
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const REPO = opt('--repo', process.env.REPO || 'OWNER/NAME');
const TAG = opt('--tag', '');
const DIST = opt('--dist', path.join(ROOT, 'dist'));
if (!TAG) { console.error('missing --tag'); process.exit(1); }

const readJson = async (p, d) => JSON.parse(await fs.readFile(p, 'utf8').catch(() => JSON.stringify(d)));
const writeJson = (p, o) => fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');
const exists = async (p) => !!(await fs.stat(p).catch(() => null));

const pending = await readJson(path.join(ROOT, 'pending.json'), []);
for (const { slug, version } of pending) {
  const info = await readJson(path.join(DIST, `${slug}.fpk-info.json`), null);
  if (!info) { console.log(`${slug}: no fpk-info, skip`); continue; }
  const meta = await readJson(path.join(ROOT, 'build', slug, 'meta.json'), null);
  if (!meta) { console.log(`${slug}: no meta, skip`); continue; }

  // 静态资源落盘（图标/README 缺失则详情里不写对应字段，客户端会跳过该应用但保留缓存）
  const assetDir = path.join(ROOT, 'assets', slug);
  let iconUrl = '', readmeUrl = '';
  const iconSrc = path.join(ROOT, 'build', slug, 'fnos', 'ICON.PNG');
  if (await exists(iconSrc)) {
    await fs.mkdir(assetDir, { recursive: true });
    await fs.copyFile(iconSrc, path.join(assetDir, 'ICON.PNG'));
    iconUrl = `https://raw.githubusercontent.com/${REPO}/main/assets/${slug}/ICON.PNG`;
  }
  const readmeSrc = path.join(ROOT, 'build', slug, 'README.md');
  if (await exists(readmeSrc)) {
    await fs.mkdir(assetDir, { recursive: true });
    await fs.copyFile(readmeSrc, path.join(assetDir, 'README.md'));
    readmeUrl = `https://raw.githubusercontent.com/${REPO}/main/assets/${slug}/README.md`;
  }

  const detailPath = path.join(ROOT, 'apps', `${slug}.json`);
  const detail = await readJson(detailPath, null) || { app_name: meta.appname, releases: {} };
  detail.app_name = meta.appname;
  detail.display_name = meta.displayName;
  detail.desc = meta.desc;
  detail.platform = ['all'];
  detail.categories = meta.categories;
  if (iconUrl) detail.icon_url = iconUrl;
  if (readmeUrl) detail.readme_url = readmeUrl;
  detail.bug_report_url = `https://github.com/${REPO}/issues`;
  detail.maintainer = '1Panel';
  delete detail.maintainer_url;
  detail.distributor = (await readJson(path.join(ROOT, 'source.json'), {})).author || 'yoqie';
  detail.distributor_url = `https://github.com/${REPO}`;
  detail.run_as = 'package';
  detail.install_type = '';
  detail.is_docker = true;
  detail.service_port = String(meta.defaultPort);
  detail.releases = detail.releases || {};
  // 已发布版本不可变：只新增，不覆盖
  if (!detail.releases[version]) {
    detail.releases[version] = {
      changelog: `跟随 1Panel 上游 ${slug} ${version} 自动打包。`,
      updated_at: new Date().toISOString(),
      packages: {
        all: {
          download_url: `https://github.com/${REPO}/releases/download/${TAG}/${info.file}`,
          sha256: info.sha256,
          size: info.size,
        },
      },
    };
  }
  // 最多保留 100 个版本（V2 上限）
  const vers = Object.keys(detail.releases).sort().reverse();
  for (const v of vers.slice(100)) delete detail.releases[v];
  await writeJson(detailPath, detail);

  const fnpack = await readJson(path.join(ROOT, 'fnpack.json'), null);
  if (fnpack?.apps?.[meta.appname]) {
    fnpack.apps[meta.appname].details_updated_at = new Date().toISOString();
    await writeJson(path.join(ROOT, 'fnpack.json'), fnpack);
  }
  console.log(`${slug}: finalized ${version}`);
}
await writeJson(path.join(ROOT, 'pending.json'), []);
console.log('finalize done.');
