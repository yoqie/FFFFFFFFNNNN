#!/usr/bin/env node
/*
 * update-index.mjs — 统一聚合源索引：从各 build/<slug>/meta.json + apps/<slug>.json
 * 生成 fnpack.json 与 README.md。覆盖原生应用（1panel）
 * 与应用市场名单应用（apps.allowlist.txt）。
 * 用法： node scripts/update-index.mjs [--repo OWNER/NAME]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const REPO = opt('--repo', process.env.REPO || 'yoqie/FnDepot');

const readJson = async (p, d) => JSON.parse(await fs.readFile(p, 'utf8').catch(() => JSON.stringify(d)));
const writeJson = (p, o) => fs.writeFile(p, JSON.stringify(o, null, 2) + '\n');

// 详情文件里最新一条 release 的时间：detail.updated_at 缺失时（例如 1panel）用它兜底，
// 它只随内容变化，不会被"现在几点"污染。
const latestReleaseTime = (detail) => Object.values(detail.releases || {})
  .map((r) => r.updated_at).filter(Boolean).sort().pop() || '';

const sourceInfo = await readJson(path.join(ROOT, 'source.json'), {});
const fnpack = { schema_version: '2', source_info: sourceInfo, apps: {} };
// 上一次生成的索引：details_updated_at 拿不到新信息时沿用旧值，避免每次运行都刷新成
// "现在"，让定时任务白白提交一条只改时间戳的改动。
const prevFnpack = await readJson(path.join(ROOT, 'fnpack.json'), { apps: {} });

const allowlist = (await fs.readFile(path.join(ROOT, 'apps.allowlist.txt'), 'utf8').catch(() => ''))
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const nativeSlugs = ['1panel', 'dsh', 'Router2API'];
const allSlugs = [...new Set([...nativeSlugs, ...allowlist])];

const rows = [];
for (const slug of allSlugs) {
  const meta = await readJson(path.join(ROOT, 'build', slug, 'meta.json'), null);
  const detail = await readJson(path.join(ROOT, 'apps', slug + '.json'), null);
  if (!meta) continue;
  const isDocker = !!meta.is_docker;
  const desc = meta.desc || '—';
  rows.push(`| [${meta.displayName || slug}](build/${slug}/) | ${desc} | ${meta.upstream || meta.version || '—'} |`);
  if (detail && detail.app_name) {
    // 平台从发布包推导（所有 release 的 packages 键并集），避免 metric 未定义
    const platforms = [...new Set(
      Object.values(detail.releases || {}).flatMap((r) => Object.keys(r.packages || {}))
    )].sort();
    fnpack.apps[slug] = {
      details_url: `apps/${slug}.json`,
      details_updated_at: detail.updated_at || latestReleaseTime(detail) || prevFnpack.apps?.[slug]?.details_updated_at || new Date().toISOString(),
      display_name: detail.display_name || meta.displayName,
      desc: detail.desc || desc,
      platform: platforms.length ? platforms : (isDocker ? ['all'] : ['x86', 'arm']),
      categories: detail.categories || meta.categories || [],
      icon_url: `https://raw.githubusercontent.com/${REPO}/main/assets/${slug}/ICON.PNG`,
      readme_url: `https://raw.githubusercontent.com/${REPO}/main/assets/${slug}/README.md`,
      bug_report_url: `https://github.com/${REPO}/issues`,
      maintainer: detail.maintainer || meta.maintainer || '',
      maintainer_url: detail.maintainer_url || meta.maintainer_url || `https://github.com/${REPO}`,
      distributor: sourceInfo.author || 'FnDepot',
      distributor_url: `https://github.com/${REPO}`,
      run_as: detail.run_as || meta.run_as || (isDocker ? 'package' : 'root'),
      install_type: detail.install_type || meta.install_type || (isDocker ? 'docker' : 'root'),
      is_docker: isDocker,
      service_port: detail.service_port || meta.service_port || '',
    };
  }
}
await writeJson(path.join(ROOT, 'fnpack.json'), fnpack);
await fs.writeFile(path.join(ROOT, 'README.md'),
  `# FnDepot · 跟随源\n\n飞牛 fnOS 个人第三方应用源——由 GitHub Actions 跟随 [1Panel 官方](https://github.com/1Panel-dev/1Panel)、[DSH 上游](https://github.com/cliii-one/DSH_FNOS)、[Router2API 飞牛打包](https://github.com/cliii-one/Router2API)（最上游 [NNNNolan/Router2API](https://github.com/NNNNolan/Router2API)）、官方 Node.js 与 \`apps.allowlist.txt\` 名单中的应用市场应用自动打包更新。\n\n` +
  `- 源地址（添加到 FnDepot/AppCenter 第三方源）：\`https://github.com/${REPO}\` 或 \`https://raw.githubusercontent.com/${REPO}/main/fnpack.json\`\n` +
  `- 跟随：1Panel 面板 v2、DSH（DeepSeek Harness，amd64/arm64 双架构）、Router2API（.NET 10 模型路由宿主，amd64/arm64 双架构） + \`apps.allowlist.txt\` 名单中的应用市场应用\n` +
  `- 同步频率：每天一次（可手动触发），有新版本时自动打包 FPK 并发布 Release；同一应用只保留最新版 Release。\n\n## 应用列表\n\n| 应用 | 描述 | 上游版本 |\n|------|------|----------|\n${rows.join('\n')}\n`);
console.log('index updated, apps:', Object.keys(fnpack.apps).join(', '));
